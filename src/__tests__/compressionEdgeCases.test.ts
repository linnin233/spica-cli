/**
 * Compression edge case tests.
 *
 * Covers boundary conditions, the exact context-corruption bug scenario,
 * multi-compaction resilience, and recency preservation in all layers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpicaAgent } from '../agent';
import { TokenCounter } from '../llm/TokenCounter';
import {
  snipMessages,
  microcompactMessages,
  autoCompactContext,
  collapseContext,
  buildSummaryPrompt,
  buildFallbackSummary,
  validateSummaryQuality,
  manageContext,
} from '../core/compression';
import type { ChatMessage } from '../llm/providers/BaseProvider';

// ── Helpers ──

function makeAgent(ctxWindow: number = 1000) {
  const agent = new SpicaAgent('test', '/tmp/spica-test-edge');

  const mockLLM = {
    _msgs: [] as ChatMessage[],
    getMessages: vi.fn(function (this: any) { return this._msgs; }),
    setMessages: vi.fn(function (this: any, msgs: ChatMessage[]) { this._msgs = msgs; }),
    getProvider: vi.fn(() => ({
      getContextWindow: () => ctxWindow,
      getCachePrefixEnd: () => -1,
      setCachePrefixEnd: vi.fn(),
      validateCachePrefix: () => ({ valid: true, errors: [] }),
    })),
    getTokenCounter: vi.fn(() => {
      const counter = new TokenCounter();
      counter.setContextWindow(ctxWindow);
      return counter;
    }),
    generateForCompression: vi.fn().mockResolvedValue({
      content: '## Active Task\nRefactoring src/core/compression.ts.\n## Completed\n- Edited multiple files\n## Next Action\nContinue editing compression module.',
    }),
  };

  Object.defineProperty(agent, 'llm', { value: mockLLM, writable: true });
  agent.stateMachine.forceTransition('idle');

  return { agent, mockLLM };
}

/** Build tool-call pair: assistant tool_calls + tool result */
function toolPair(
  toolCallId: string,
  toolName: string,
  args: Record<string, string>,
  resultContent: string
): ChatMessage[] {
  return [
    {
      role: 'assistant' as const,
      content: '',
      toolCalls: [{ id: toolCallId, name: toolName, arguments: args }],
    },
    { role: 'tool' as const, toolCallId, content: resultContent },
  ];
}

/** Generate N tool pairs quickly (avoids template literal in spread) */
function makeToolPairs(count: number, prefix: string): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (let i = 0; i < count; i++) {
    result.push(...toolPair(
      prefix + "_" + i,
      'edit',
      { path: "/f" + i },
      "edited " + i + " with enough content to survive snip"
    ));
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// buildSummaryPrompt — Recency Markers
// ═══════════════════════════════════════════════════════════════════════════

describe('buildSummaryPrompt — recency edge cases', () => {
  it('should handle messages with no user messages (graceful)', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'assistant', content: 'Hello' },
      ...toolPair('t1', 'read', { path: '/f' }, 'content'),
    ];

    const prompt = buildSummaryPrompt(msgs);
    expect(prompt).toBeDefined();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('should correctly tag only the LAST user message when mixed with system messages', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant' },
      { role: 'user', content: 'First request: refactor module A' },
      { role: 'assistant', content: 'Done refactoring module A' },
      { role: 'system', content: '[PROGRESS] Task completed' },
      { role: 'user', content: 'Second request: add feature B' },
      { role: 'assistant', content: 'Done adding feature B' },
      { role: 'system', content: '[PROGRESS] Task completed' },
      { role: 'user', content: 'CURRENT: remove color scheme' },
      ...toolPair('t1', 'edit', { path: '/index.html' }, 'edited'),
    ];

    const prompt = buildSummaryPrompt(msgs);
    const historyStart = prompt.indexOf('History messages:');
    const historySection = prompt.slice(historyStart);

    expect(historySection).toContain('[OLD');
    expect(historySection).toContain('First request: refactor module A');
    expect(historySection).toContain('Second request: add feature B');
    expect(historySection).toContain('[LATEST — CURRENT INSTRUCTION');
    expect(historySection).toContain('CURRENT: remove color scheme');

    const latestCount = (historySection.match(/\[LATEST/g) || []).length;
    expect(latestCount).toBe(1);
  });

  it('should tag very long user messages correctly', () => {
    const longContent = 'Very long request: ' + 'X'.repeat(5000);
    const msgs: ChatMessage[] = [
      { role: 'user', content: longContent },
      { role: 'assistant', content: 'Processing long request' },
    ];

    const prompt = buildSummaryPrompt(msgs);
    const historyStart = prompt.indexOf('History messages:');
    const historySection = prompt.slice(historyStart);

    expect(historySection).toContain('[LATEST — CURRENT INSTRUCTION');
    expect(historySection).toContain('Very long request:');
  });

  it('should handle 10+ interleaved user messages correctly', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Task 1: Setup project' },
      { role: 'assistant', content: 'Setting up...' },
      ...toolPair('t1a', 'bash', { command: 'npm init' }, 'done'),
      { role: 'user', content: 'Task 2: Add TypeScript config' },
      ...toolPair('t2a', 'write', { path: '/tsconfig.json' }, 'written'),
      { role: 'user', content: 'Task 3: Refactor to use proper types' },
      { role: 'assistant', content: 'Refactoring...' },
      ...toolPair('t3a', 'edit', { path: '/src/index.ts' }, 'edited'),
      ...toolPair('t3b', 'edit', { path: '/src/utils.ts' }, 'edited'),
      { role: 'user', content: 'Task 4: Add tests' },
      ...toolPair('t4a', 'write', { path: '/tests/test.ts' }, 'written'),
      { role: 'user', content: 'CURRENT: Remove unused dependencies' },
      ...toolPair('t5a', 'bash', { command: 'npm ls' }, 'listed'),
      ...toolPair('t5b', 'edit', { path: '/package.json' }, 'edited'),
    ];

    const prompt = buildSummaryPrompt(msgs);
    const historyStart = prompt.indexOf('History messages:');
    const historySection = prompt.slice(historyStart);

    for (let i = 1; i <= 4; i++) {
      expect(historySection).toContain("Task " + i + ":");
    }

    const oldCount = (historySection.match(/\[OLD/g) || []).length;
    expect(oldCount).toBeGreaterThanOrEqual(4);

    const latestCount = (historySection.match(/\[LATEST/g) || []).length;
    expect(latestCount).toBe(1);
    expect(historySection).toContain('CURRENT: Remove unused dependencies');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// autoCompactContext — Last User Message Preservation
// ═══════════════════════════════════════════════════════════════════════════

describe('autoCompactContext — last user message edge cases', () => {
  let agent: SpicaAgent;
  let mockLLM: any;

  beforeEach(() => {
    const result = makeAgent(2000);
    agent = result.agent;
    mockLLM = result.mockLLM;
  });

  it('should preserve last user when it is the ONLY user message', async () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'ONLY USER MESSAGE' },
      ...makeToolPairs(20, 't'),
    ];

    mockLLM._msgs = msgs;
    mockLLM.generateForCompression = vi.fn().mockResolvedValue({
      content: '## Active Task\nWorking on files.\n## Next Action\nContinue.',
    });

    const origEstimate = mockLLM.getTokenCounter().estimateMessages;
    mockLLM.getTokenCounter().estimateMessages = vi.fn().mockReturnValue(5000);
    await autoCompactContext(agent, 300, undefined);
    mockLLM.getTokenCounter().estimateMessages = origEstimate;

    const finalMsgs = mockLLM._msgs as ChatMessage[];
    expect(finalMsgs.some(m => m.content === 'ONLY USER MESSAGE')).toBe(true);
  });

  it('should not crash when there are NO user messages', async () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'System' },
      ...toolPair('t1', 'read', { path: '/f' }, 'content'),
      { role: 'assistant', content: 'No user messages here' },
    ];

    mockLLM._msgs = msgs;
    mockLLM.generateForCompression = vi.fn().mockResolvedValue({
      content: '## Active Task\nProcessing files and awaiting user input.\n## Next Action\nContinue working on src/module.ts.',
    });

    const origEstimate = mockLLM.getTokenCounter().estimateMessages;
    mockLLM.getTokenCounter().estimateMessages = vi.fn().mockReturnValue(5000);
    await expect(autoCompactContext(agent, 300, undefined)).resolves.not.toThrow();
    mockLLM.getTokenCounter().estimateMessages = origEstimate;
  });

  it('should preserve last user message through two consecutive compressions', async () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Old task: refactor module A' },
      { role: 'assistant', content: 'Done' },
      { role: 'user', content: 'CURRENT TASK: remove color scheme' },
      ...makeToolPairs(30, 'first'),
    ];

    mockLLM._msgs = msgs;
    mockLLM.generateForCompression = vi.fn().mockResolvedValue({
      content: '## Active Task\nRemove color scheme from config.\n## Completed\n- Refactored module A\n## Next Action\nContinue editing files.',
    });

    const origEstimate = mockLLM.getTokenCounter().estimateMessages;
    mockLLM.getTokenCounter().estimateMessages = vi.fn().mockReturnValue(5000);

    await autoCompactContext(agent, 300, undefined);

    const afterFirst = mockLLM._msgs as ChatMessage[];
    expect(afterFirst.some(m => m.content === 'CURRENT TASK: remove color scheme')).toBe(true);

    // Add more messages, then compress again
    const moreMsgs = makeToolPairs(20, 'second');
    mockLLM._msgs = [...afterFirst, ...moreMsgs];

    mockLLM.getTokenCounter().estimateMessages = vi.fn().mockReturnValue(5000);
    await autoCompactContext(agent, 300, undefined);

    const afterSecond = mockLLM._msgs as ChatMessage[];
    const hasTask = afterSecond.some(
      m => m.content?.includes('remove color scheme') || m.content?.includes('Remove color scheme')
    );
    expect(hasTask).toBe(true);

    mockLLM.getTokenCounter().estimateMessages = origEstimate;
  });

  it('should handle the EXACT bug scenario: old revert must not override current instruction', async () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: '回退所有改动，给我还原回重构之前' },
      { role: 'assistant', content: 'Done reverting all changes.' },
      ...toolPair('t_revert', 'bash', { command: 'git checkout .' }, 'Reverted'),
      { role: 'user', content: '开始做前端改进' },
      { role: 'assistant', content: 'Starting frontend improvements.' },
      ...toolPair('t_ui', 'edit', { path: '/static/index.html' }, 'UI improved'),
      { role: 'user', content: '没问题了，为我去掉配置窗里的配色方案系统呗' },
      ...makeToolPairs(15, 'theme'),
    ];

    mockLLM._msgs = msgs;
    mockLLM.generateForCompression = vi.fn().mockResolvedValue({
      content: '## Active Task\nRemove color scheme system from config panel in static/index.html.\n## Completed\n- Reverted changes earlier (superseded)\n- Frontend improvements done in static/index.js\n## Next Action\nContinue editing static/index.html to remove color scheme references.',
    });

    const origEstimate = mockLLM.getTokenCounter().estimateMessages;
    mockLLM.getTokenCounter().estimateMessages = vi.fn().mockReturnValue(5000);
    await autoCompactContext(agent, 300, undefined);
    mockLLM.getTokenCounter().estimateMessages = origEstimate;

    const finalMsgs = mockLLM._msgs as ChatMessage[];

    // Current instruction MUST be preserved verbatim
    const hasCurrent = finalMsgs.some(
      m => m.content === '没问题了，为我去掉配置窗里的配色方案系统呗'
    );
    expect(hasCurrent).toBe(true);

    // Old revert instruction should NOT appear verbatim
    const hasRevert = finalMsgs.some(
      m => m.content === '回退所有改动，给我还原回重构之前'
    );
    expect(hasRevert).toBe(false);

    // Summary should reference current task
    const summary = finalMsgs.find(m => m.content?.includes('[COMPACTED HISTORY'));
    expect(summary).toBeDefined();
    expect(summary!.content).toMatch(/color scheme|配色方案/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// collapseContext — Edge Cases
// ═══════════════════════════════════════════════════════════════════════════

describe('collapseContext — edge cases', () => {
  let agent: SpicaAgent;
  let mockLLM: any;

  beforeEach(() => {
    const result = makeAgent(2000);
    agent = result.agent;
    mockLLM = result.mockLLM;
  });

  it('should return false when not enough messages to split', async () => {
    mockLLM._msgs = [
      { role: 'user', content: 'Short convo' },
      { role: 'assistant', content: 'Short reply' },
    ];

    const result = await collapseContext(agent, 300, undefined);
    expect(result).toBe(false);
  });

  it('should not duplicate last user if already in tail', async () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Old message' },
      { role: 'assistant', content: 'Old reply' },
      { role: 'user', content: 'Middle message' },
      ...toolPair('tm1', 'read', { path: '/m1' }, 'mid content'),
      ...toolPair('tm2', 'edit', { path: '/m2' }, 'mid edit'),
      ...toolPair('te1', 'read', { path: '/e1' }, 'end content 1'),
      ...toolPair('te2', 'read', { path: '/e2' }, 'end content 2'),
      ...toolPair('te3', 'read', { path: '/e3' }, 'end content 3'),
      { role: 'user', content: 'CURRENT_INSTRUCTION_IN_TAIL' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't_last', name: 'edit', arguments: { path: '/last' } }] },
      { role: 'tool', toolCallId: 't_last', content: 'last edit done' },
    ];

    mockLLM._msgs = msgs;
    mockLLM.generateForCompression = vi.fn().mockResolvedValue({
      content: '## Active Task\nWorking on edits in src/module.ts.\n## Next Action\nContinue editing files.',
    });

    await collapseContext(agent, 300, undefined);

    const finalMsgs = mockLLM._msgs as ChatMessage[];
    const count = finalMsgs.filter(
      m => m.content === 'CURRENT_INSTRUCTION_IN_TAIL'
    ).length;
    expect(count).toBe(1);
  });

  it('should preserve the LAST user message (not first) when they differ', async () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'FIRST: Do a complete rewrite of everything' },
      { role: 'assistant', content: 'Starting rewrite...' },
      ...makeToolPairs(3, 'rewrite'),
      { role: 'user', content: 'LAST: Actually, just fix the typo in README' },
      ...makeToolPairs(4, 'fix'),
    ];

    mockLLM._msgs = msgs;
    mockLLM.generateForCompression = vi.fn().mockResolvedValue({
      content: '## Active Task\nFix typo in README.\n## Completed\n- Rewrite work was superseded.\n## Next Action\nEdit README.',
    });

    await collapseContext(agent, 300, undefined);

    const finalMsgs = mockLLM._msgs as ChatMessage[];

    const hasCurrent = finalMsgs.some(
      m => m.content === 'LAST: Actually, just fix the typo in README'
    );
    expect(hasCurrent).toBe(true);

    const hasOld = finalMsgs.some(
      m => m.content === 'FIRST: Do a complete rewrite of everything'
    );
    expect(hasOld).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Summary Quality Validation
// ═══════════════════════════════════════════════════════════════════════════

describe('validateSummaryQuality', () => {
  it('should reject empty summary', () => {
    expect(validateSummaryQuality('')).toBe(false);
  });

  it('should reject very short summary', () => {
    expect(validateSummaryQuality('Short.')).toBe(false);
  });

  it('should reject boilerplate responses', () => {
    expect(validateSummaryQuality("I don't have enough information to summarize")).toBe(false);
    expect(validateSummaryQuality('Could you please provide more context?')).toBe(false);
    expect(validateSummaryQuality('I cannot provide a summary at this time')).toBe(false);
  });

  it('should reject summaries without content signals', () => {
    expect(validateSummaryQuality('The user asked about something and I helped.')).toBe(false);
  });

  it('should accept valid summaries with file paths', () => {
    expect(validateSummaryQuality(
      '## Active Task\nRefactored src/core/compression.ts. Fixed build error.'
    )).toBe(true);
  });

  it('should accept valid summaries with function references', () => {
    expect(validateSummaryQuality(
      '## Active Task\nModified the buildSummaryPrompt function to add recency markers.'
    )).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// buildFallbackSummary
// ═══════════════════════════════════════════════════════════════════════════

describe('buildFallbackSummary', () => {
  it('should produce a summary with disclaimer', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Fix the bug in login flow' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'read', arguments: { path: '/login.ts' } }] },
      { role: 'tool', toolCallId: 't1', content: 'login source code' },
    ];

    const fallback = buildFallbackSummary(msgs);
    expect(fallback.role).toBe('user');
    expect(fallback.content).toContain('[COMPACTED HISTORY');
    expect(fallback.content).toContain('NOT a new user instruction');
    expect(fallback.content).toContain('Fix the bug in login flow');
  });

  it('should handle empty messages gracefully', () => {
    const fallback = buildFallbackSummary([]);
    expect(fallback.role).toBe('user');
    expect(fallback.content).toBeDefined();
    expect(fallback.content!.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Snip: Cache Prefix Protection
// ═══════════════════════════════════════════════════════════════════════════

describe('Snip — cache prefix protection edge cases', () => {
  it('should not remove empty tool results within cache prefix', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Read file' },
      { role: 'tool', toolCallId: 'tc1', content: '' },
      { role: 'assistant', content: 'File is empty' },
      { role: 'tool', toolCallId: 'tc2', content: '' },
    ];

    const { messages, removed } = snipMessages(msgs, 2);
    expect(removed).toBe(1);
    expect(messages.some(m => m.role === 'tool' && m.toolCallId === 'tc1')).toBe(true);
    expect(messages.some(m => m.role === 'tool' && m.toolCallId === 'tc2')).toBe(false);
  });

  it('should not strip toolCalls from cached assistant messages', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'System' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc_cached', name: 'read', arguments: { path: '/f' } }],
      },
      { role: 'tool', toolCallId: 'tc_cached', content: '' },
    ];

    const { messages, removed } = snipMessages(msgs, 2);
    expect(removed).toBe(0);
    const asst = messages.find(m => m.role === 'assistant');
    expect(asst).toBeDefined();
    expect(asst!.toolCalls).toBeDefined();
    expect(asst!.toolCalls).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Microcompact: boundary conditions
// ═══════════════════════════════════════════════════════════════════════════

describe('Microcompact — boundary conditions', () => {
  it('should truncate at limit + 1', () => {
    const exactContent = 'A'.repeat(20001);
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Read' },
      { role: 'tool', toolCallId: 't1', content: exactContent },
    ];

    const { messages: resultMsgs, truncated } = microcompactMessages(msgs, -1);
    expect(truncated).toBe(1);
    expect(resultMsgs[1].content).toContain('[truncated]');
    // Original should NOT be mutated
    expect(msgs[1].content!.length).toBe(20001);
  });

  it('should NOT truncate at exact limit', () => {
    const exactContent = 'A'.repeat(20000);
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Read' },
      { role: 'tool', toolCallId: 't1', content: exactContent },
    ];

    const { truncated } = microcompactMessages(msgs, -1);
    expect(truncated).toBe(0);
  });

  it('should skip non-tool messages even if long', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'A'.repeat(30000) },
      { role: 'assistant', content: 'A'.repeat(30000) },
    ];

    const { messages: resultMsgs, truncated } = microcompactMessages(msgs, -1);
    expect(truncated).toBe(0);
    expect(resultMsgs[0].content!.length).toBe(30000);
    expect(resultMsgs[1].content!.length).toBe(30000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Full Waterfall Integration
// ═══════════════════════════════════════════════════════════════════════════

describe('Full waterfall — integration edge cases', () => {
  it('should not lose current instruction through full chain', async () => {
    const { agent, mockLLM } = makeAgent(2000);

    const msgs: ChatMessage[] = [
      { role: 'system', content: 'You are spica assistant.' },
      { role: 'user', content: '最早的需求：重构整个项目架构' },
      { role: 'assistant', content: '好的，开始重构。' },
      ...makeToolPairs(5, 'old'),
      // Empty tool results for Layer 1 (Snip)
      {
        role: 'assistant' as const, content: '',
        toolCalls: [{ id: 'empty1', name: 'grep', arguments: { pattern: 'unused' } }],
      },
      { role: 'tool' as const, toolCallId: 'empty1', content: '' },
      {
        role: 'assistant' as const, content: '',
        toolCalls: [{ id: 'empty2', name: 'grep', arguments: { pattern: 'dead' } }],
      },
      { role: 'tool' as const, toolCallId: 'empty2', content: '' },
      // Very long tool result for Layer 2 (Microcompact)
      {
        role: 'assistant' as const, content: '',
        toolCalls: [{ id: 'long1', name: 'read', arguments: { path: '/huge.ts' } }],
      },
      { role: 'tool' as const, toolCallId: 'long1', content: 'X'.repeat(25000) },
      // Old direction change
      { role: 'user', content: '先停一下，把所有改动都还原回去' },
      { role: 'assistant', content: '好的，正在还原所有改动。' },
      ...makeToolPairs(3, 'revert'),
      // Middle work
      { role: 'user', content: '好的，现在开始做前端 UI 改进' },
      ...makeToolPairs(4, 'ui'),
      // CURRENT TASK
      { role: 'user', content: '没问题了，为我去掉配置窗里的配色方案系统呗' },
      ...makeToolPairs(10, 'current'),
    ];

    mockLLM._msgs = msgs;
    mockLLM.generateForCompression = vi.fn().mockResolvedValue({
      content: '## Active Task\nRemoving color scheme system from config.\n## Completed\n- Architecture refactoring\n- Reverted changes (superseded)\n- Frontend UI improvements\n## Next Action\nContinue editing theme files.',
    });

    const origEstimate = mockLLM.getTokenCounter().estimateMessages;
    mockLLM.getTokenCounter().estimateMessages = vi.fn()
      .mockReturnValueOnce(1900)
      .mockReturnValueOnce(1850)
      .mockReturnValueOnce(1750)
      .mockReturnValue(500);

    await manageContext(agent, Math.floor(2000 * 0.4));

    const finalMsgs = mockLLM._msgs as ChatMessage[];

    // Current instruction preserved
    expect(finalMsgs.some(
      m => m.content === '没问题了，为我去掉配置窗里的配色方案系统呗'
    )).toBe(true);

    // Old revert NOT preserved
    expect(finalMsgs.some(
      m => m.content === '先停一下，把所有改动都还原回去'
    )).toBe(false);

    // Oldest NOT preserved
    expect(finalMsgs.some(
      m => m.content === '最早的需求：重构整个项目架构'
    )).toBe(false);

    mockLLM.getTokenCounter().estimateMessages = origEstimate;
  });

  it('should return to idle state even if waterfall fails mid-way', async () => {
    const { agent, mockLLM } = makeAgent(2000);

    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 50; i++) {
      msgs.push({ role: 'user' as const, content: "Message " + i });
      msgs.push({ role: 'assistant' as const, content: "Reply " + i });
    }

    mockLLM._msgs = msgs;
    mockLLM.generateForCompression = vi.fn().mockRejectedValue(new Error('API down'));

    const origEstimate = mockLLM.getTokenCounter().estimateMessages;
    mockLLM.getTokenCounter().estimateMessages = vi.fn().mockReturnValue(5000);
    await manageContext(agent, Math.floor(2000 * 0.4));
    mockLLM.getTokenCounter().estimateMessages = origEstimate;

    expect(agent.stateMachine.current).toBe('idle');
    expect(agent.isCompacting()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tool-call Chain Integrity
// ═══════════════════════════════════════════════════════════════════════════

describe('Tool-call chain integrity — tail should not start with orphan tool result', () => {
  it('should extend tail backward when tailStart cuts a tool-call chain', async () => {
    const { agent, mockLLM } = makeAgent(2000);

    // Build a conversation where the default tailStart would land on a
    // tool result whose parent assistant is one message before.
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Refactor the compression module' },
      { role: 'assistant', content: 'Let me work on this.' },
      // 20 tool pairs to push context over threshold
      ...[...Array(20)].flatMap((_, i) => [
        {
          role: 'assistant' as const,
          content: '',
          toolCalls: [{ id: 't' + i, name: 'edit', arguments: { path: '/f' + i } }],
        },
        { role: 'tool' as const, toolCallId: 't' + i, content: 'edited file ' + i },
      ]),
      // A tool-call chain near the end. With tailSize=8 (for 2000 ctx):
      // The tail would include messages from here onward. If tailStart
      // lands on the tool RESULT, we need it to extend back to the assistant.
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [
          { id: 'tc_chain', name: 'read', arguments: { path: '/critical.ts' } },
        ],
      },
      { role: 'tool' as const, toolCallId: 'tc_chain', content: 'CRITICAL FILE CONTENT HERE' },
      // More messages to ensure we have enough non-system for the waterfall
      ...makeToolPairs(4, 'post_chain'),
    ];

    mockLLM._msgs = msgs;
    mockLLM.generateForCompression = vi.fn().mockResolvedValue({
      content: '## Active Task\nRefactoring compression module.\n## Completed\n- Edited multiple files\n## Next Action\nContinue editing src/core/compression.ts.',
    });

    const origEstimate = mockLLM.getTokenCounter().estimateMessages;
    mockLLM.getTokenCounter().estimateMessages = vi.fn().mockReturnValue(5000);
    await autoCompactContext(agent, 300, undefined);
    mockLLM.getTokenCounter().estimateMessages = origEstimate;

    const finalMsgs = mockLLM._msgs as ChatMessage[];

    // The first non-system non-summary message should NOT be an orphan tool result
    const summaryIdx = finalMsgs.findIndex(m => m.content?.includes('[COMPACTED HISTORY'));
    const tailMessages = finalMsgs.slice(summaryIdx + 1);

    if (tailMessages.length > 0) {
      const firstTail = tailMessages[0];
      // If it's a tool result, it must have a preceding assistant in the tail
      if (firstTail.role === 'tool') {
        // This should not happen — ensureToolChainBoundary should have prevented it
        expect(tailMessages.some(
          m => m.role === 'assistant' && m.toolCalls?.some(
            tc => tc.id === (firstTail as any).toolCallId
          )
        )).toBe(true);
      }
    }
  });

  it('should not adjust tailStart when it already lands on a clean boundary', async () => {
    const { agent, mockLLM } = makeAgent(2000);

    // Build a conversation where tailStart naturally lands on an assistant
    // message (clean boundary — no orphan tool results in tail).
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Refactor module' },
      ...[...Array(30)].flatMap((_, i) => [
        {
          role: 'assistant' as const,
          content: '',
          toolCalls: [{ id: 't' + i, name: 'edit', arguments: { path: '/f' + i } }],
        },
        { role: 'tool' as const, toolCallId: 't' + i, content: 'edited file ' + i },
      ]),
    ];

    // With tailSize=8, last 8 messages should be 4 complete tool-call chains.
    // The tail should start with an assistant (clean boundary).

    mockLLM._msgs = msgs;
    mockLLM.generateForCompression = vi.fn().mockResolvedValue({
      content: '## Active Task\nEditing files.\n## Next Action\nContinue editing src/core/module.ts.',
    });

    const origEstimate = mockLLM.getTokenCounter().estimateMessages;
    mockLLM.getTokenCounter().estimateMessages = vi.fn().mockReturnValue(5000);
    await autoCompactContext(agent, 300, undefined);
    mockLLM.getTokenCounter().estimateMessages = origEstimate;

    const finalMsgs = mockLLM._msgs as ChatMessage[];

    // Verify the tail doesn't start with an orphan tool
    const summaryIdx = finalMsgs.findIndex(m => m.content?.includes('[COMPACTED HISTORY'));
    const tailMessages = finalMsgs.slice(summaryIdx + 1);

    if (tailMessages.length > 0 && tailMessages[0].role === 'tool') {
      // If it IS a tool, it should have its parent in the tail
      const toolId = (tailMessages[0] as any).toolCallId;
      expect(tailMessages.some(
        m => m.role === 'assistant' && m.toolCalls?.some(tc => tc.id === toolId)
      )).toBe(true);
    }
    // If it's NOT a tool, the boundary is clean — that's the expected case.
  });

  it('should preserve ALL sibling tool results when tailStart splits a multi-tool-call chain', async () => {
    const { agent, mockLLM } = makeAgent(2000);

    // Simulate an assistant that called 3 tools at once.
    // If tailStart lands on the 2nd tool result, ensuring the chain boundary
    // must include ALL 3 tool results + the assistant.
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Fix multiple files at once' },
      ...[...Array(15)].flatMap((_, i) => [
        {
          role: 'assistant' as const,
          content: '',
          toolCalls: [{ id: 'pad' + i, name: 'read', arguments: { path: '/pad' + i } }],
        },
        { role: 'tool' as const, toolCallId: 'pad' + i, content: 'padding ' + i },
      ]),
      // A multi-tool-call assistant
      {
        role: 'assistant' as const,
        content: 'Fixing three files at once.',
        toolCalls: [
          { id: 'multi_1', name: 'edit', arguments: { path: '/file_a.ts' } },
          { id: 'multi_2', name: 'edit', arguments: { path: '/file_b.ts' } },
          { id: 'multi_3', name: 'edit', arguments: { path: '/file_c.ts' } },
        ],
      },
      { role: 'tool' as const, toolCallId: 'multi_1', content: 'edited file_a.ts' },
      { role: 'tool' as const, toolCallId: 'multi_2', content: 'edited file_b.ts' },
      { role: 'tool' as const, toolCallId: 'multi_3', content: 'edited file_c.ts' },
      ...[...Array(3)].flatMap((_, i) => [
        {
          role: 'assistant' as const,
          content: '',
          toolCalls: [{ id: 'post' + i, name: 'read', arguments: { path: '/post' + i } }],
        },
        { role: 'tool' as const, toolCallId: 'post' + i, content: 'post ' + i },
      ]),
    ];

    mockLLM._msgs = msgs;
    mockLLM.generateForCompression = vi.fn().mockResolvedValue({
      content: '## Active Task\nEditing multiple files including file_a.ts, file_b.ts, file_c.ts.\n## Next Action\nContinue editing src/files.ts.',
    });

    const origEstimate = mockLLM.getTokenCounter().estimateMessages;
    mockLLM.getTokenCounter().estimateMessages = vi.fn().mockReturnValue(5000);
    await autoCompactContext(agent, 300, undefined);
    mockLLM.getTokenCounter().estimateMessages = origEstimate;

    const finalMsgs = mockLLM._msgs as ChatMessage[];

    // Verify the multi-tool-call assistant and ALL its tool results
    // are either ALL in the tail or ALL in the head (never split).
    const multiAsstIdx = finalMsgs.findIndex(
      m => m.role === 'assistant' && m.toolCalls && m.toolCalls.length === 3
    );

    if (multiAsstIdx >= 0) {
      // Assistant is in the tail — ALL 3 tool results must also be in the tail
      for (const tcId of ['multi_1', 'multi_2', 'multi_3']) {
        const toolMsg = finalMsgs.slice(multiAsstIdx).find(
          m => m.role === 'tool' && (m as any).toolCallId === tcId
        );
        expect(toolMsg).toBeDefined();
      }
    }
    // If assistant is NOT in the tail (in the head/summarized), that's also fine —
    // the entire chain was summarized together.
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Continuation Signal After Compression
// ═══════════════════════════════════════════════════════════════════════════

describe('Continuation signal after compression', () => {
  it('should inject [CONTEXT COMPRESSED] after manageContext compresses', async () => {
    const { agent, mockLLM } = makeAgent(2000);

    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 30; i++) {
      msgs.push({ role: 'user' as const, content: 'Message ' + i });
      msgs.push({ role: 'assistant' as const, content: 'Reply ' + i });
    }

    mockLLM._msgs = msgs;
    mockLLM.generateForCompression = vi.fn().mockResolvedValue({
      content: '## Active Task\nProcessing messages.\n## Completed\n- Multiple replies\n## Next Action\nContinue working on src/module.ts.',
    });

    const origEstimate = mockLLM.getTokenCounter().estimateMessages;
    mockLLM.getTokenCounter().estimateMessages = vi.fn().mockReturnValue(5000);
    await manageContext(agent, Math.floor(2000 * 0.4));
    mockLLM.getTokenCounter().estimateMessages = origEstimate;

    const finalMsgs = mockLLM._msgs as ChatMessage[];

    // Continuation signal must be present (role: 'user' to avoid leaking into _fullHistory)
    const signal = finalMsgs.find(
      m => m.role === 'user' && m.content?.includes('[CONTEXT COMPRESSED]')
    );
    expect(signal).toBeDefined();
    expect(signal!.content).toContain('Continue from where you left off');
  });

  it('should emit compress_auto_continue event after compression', async () => {
    const { agent, mockLLM } = makeAgent(2000);

    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 30; i++) {
      msgs.push({ role: 'user' as const, content: 'Message ' + i });
      msgs.push({ role: 'assistant' as const, content: 'Reply ' + i });
    }

    mockLLM._msgs = msgs;
    mockLLM.generateForCompression = vi.fn().mockResolvedValue({
      content: '## Active Task\nWorking.\n## Next Action\nContinue on src/file.ts.',
    });

    const events: any[] = [];
    agent.on('compress_auto_continue', (e) => events.push(e));

    const origEstimate = mockLLM.getTokenCounter().estimateMessages;
    mockLLM.getTokenCounter().estimateMessages = vi.fn().mockReturnValue(5000);
    await manageContext(agent, Math.floor(2000 * 0.4));
    mockLLM.getTokenCounter().estimateMessages = origEstimate;

    expect(events.length).toBe(1);
    expect(events[0].content).toBe('Context compressed');
  });

  it('should NOT inject duplicate continuation signals', async () => {
    const { agent, mockLLM } = makeAgent(2000);

    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 30; i++) {
      msgs.push({ role: 'user' as const, content: 'Message ' + i });
      msgs.push({ role: 'assistant' as const, content: 'Reply ' + i });
    }

    mockLLM._msgs = msgs;
    mockLLM.generateForCompression = vi.fn().mockResolvedValue({
      content: '## Active Task\nWorking.\n## Next Action\nContinue on src/file.ts.',
    });

    const origEstimate = mockLLM.getTokenCounter().estimateMessages;
    mockLLM.getTokenCounter().estimateMessages = vi.fn().mockReturnValue(5000);

    // First compression
    await manageContext(agent, Math.floor(2000 * 0.4));

    const afterFirst = mockLLM._msgs as ChatMessage[];
    const signalCount1 = afterFirst.filter(
      m => m.content?.includes('[CONTEXT COMPRESSED]')
    ).length;
    expect(signalCount1).toBe(1);

    mockLLM.getTokenCounter().estimateMessages = origEstimate;
  });

  it('should inject exactly ONE continuation signal (no duplicates)', async () => {
    const { agent, mockLLM } = makeAgent(2000);

    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 30; i++) {
      msgs.push({ role: 'user' as const, content: 'Message ' + i });
      msgs.push({ role: 'assistant' as const, content: 'Reply ' + i });
    }

    mockLLM._msgs = msgs;
    mockLLM.generateForCompression = vi.fn().mockResolvedValue({
      content: '## Active Task\nWorking on messages.\n## Next Action\nContinue with src/module.ts.',
    });

    const origEstimate = mockLLM.getTokenCounter().estimateMessages;
    mockLLM.getTokenCounter().estimateMessages = vi.fn().mockReturnValue(5000);
    await manageContext(agent, Math.floor(2000 * 0.4));
    mockLLM.getTokenCounter().estimateMessages = origEstimate;

    const finalMsgs = mockLLM._msgs as ChatMessage[];
    const signals = finalMsgs.filter(
      m => m.content?.includes('[CONTEXT COMPRESSED]')
    );
    // Exactly one signal — no duplicates even if multiple layers fire
    expect(signals.length).toBe(1);
  });
});
