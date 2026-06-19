// Layered compression integration tests
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpicaAgent } from '../agent';
import { TokenCounter } from '../llm/TokenCounter';
import {
  snipMessages,
  microcompactMessages,
  autoCompactContext,
  buildSummaryPrompt,
  collapseContext,
} from '../core/compression';
import type { ChatMessage } from '../llm/providers/BaseProvider';

// ── Helpers ──

function makeAgent() {
  const agent = new SpicaAgent('test', '/tmp/spica-test-compression');
  const mockLLM = {
    _msgs: [] as ChatMessage[],
    getMessages: vi.fn(function (this: any) { return this._msgs; }),
    setMessages: vi.fn(function (this: any, msgs: ChatMessage[]) { this._msgs = msgs; }),
    getProvider: vi.fn(() => ({
      getContextWindow: () => 1000,
      getCachePrefixEnd: () => -1,
      setCachePrefixEnd: vi.fn(),
      validateCachePrefix: () => ({ valid: true, errors: [] }),
    })),
    getTokenCounter: vi.fn(() => {
      const counter = new TokenCounter();
      counter.setContextWindow(1000);
      return counter;
    }),
    generateForCompression: vi.fn().mockResolvedValue({ content: 'Mock summary with file.ts and fix for error' }),
  };
  Object.defineProperty(agent, 'llm', { value: mockLLM, writable: true });
  agent.stateMachine.forceTransition('idle');
  return { agent, mockLLM };
}

// ═══════════════════════════════════════════════════════════════════════════
// Layer 1: Snip
// ═══════════════════════════════════════════════════════════════════════════

describe('Layer 1: Snip (zero-cost)', () => {
  it('should remove empty tool results', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Read the config' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'read', arguments: { path: '/config' } }],
      },
      { role: 'tool', toolCallId: 'tc1', content: '' }, // Empty → remove
      { role: 'assistant', content: 'Config loaded' },
    ];

    const { messages, removed } = snipMessages(msgs);
    expect(removed).toBe(1);
    expect(messages).toHaveLength(3);
    expect(messages.find(m => m.role === 'tool')).toBeUndefined();
  });

  it('should keep tool results with errors even if short', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Run command' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'bash', arguments: { command: 'ls' } }],
      },
      { role: 'tool', toolCallId: 'tc1', content: 'Error: permission denied' }, // Short but error → keep
      { role: 'assistant', content: 'Command failed' },
    ];

    const { messages, removed } = snipMessages(msgs);
    expect(removed).toBe(0);
    expect(messages).toHaveLength(4);
  });

  it('should strip orphaned toolCalls when all results removed', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Read files' },
      {
        role: 'assistant',
        content: 'Let me read those',
        toolCalls: [
          { id: 'tc1', name: 'read', arguments: { path: '/a' } },
          { id: 'tc2', name: 'read', arguments: { path: '/b' } },
        ],
      },
      { role: 'tool', toolCallId: 'tc1', content: '' }, // Empty
      { role: 'tool', toolCallId: 'tc2', content: '' }, // Empty
      { role: 'assistant', content: 'Done reading' },
    ];

    const { messages, removed } = snipMessages(msgs);
    expect(removed).toBe(2); // Both tool results removed
    // Assistant should have toolCalls stripped (all orphans)
    const assistantMsg = messages.find(
      m => m.role === 'assistant' && m.content === 'Let me read those'
    );
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.toolCalls).toBeUndefined();
  });

  it('should keep toolCalls that have at least one surviving result', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Read files' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'tc1', name: 'read', arguments: { path: '/a' } },
          { id: 'tc2', name: 'read', arguments: { path: '/b' } },
        ],
      },
      { role: 'tool', toolCallId: 'tc1', content: 'file content here with enough chars to survive' }, // >20 chars → keep
      { role: 'tool', toolCallId: 'tc2', content: '' }, // Empty → remove
    ];

    const { messages, removed } = snipMessages(msgs);
    expect(removed).toBe(1);
    // tc1 survives, tc2 removed from toolCalls
    const assistantMsg = messages.find(m => m.role === 'assistant');
    expect(assistantMsg!.toolCalls).toHaveLength(1);
    expect(assistantMsg!.toolCalls![0].id).toBe('tc1');
  });

  it('should suppress duplicate consecutive user messages', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Help me refactor' },
      { role: 'assistant', content: 'Sure, what file?' },
      { role: 'user', content: 'Help me refactor' }, // Duplicate → remove
      { role: 'user', content: 'Help me refactor' }, // Duplicate → remove
      { role: 'assistant', content: 'Starting on src/agent.ts' },
    ];

    const { messages, removed } = snipMessages(msgs);
    expect(removed).toBe(2);
    expect(messages).toHaveLength(3);
    expect(messages.filter(m => m.role === 'user')).toHaveLength(1);
  });

  it('should handle messages with no empty results (no-op)', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];

    const { messages, removed } = snipMessages(msgs);
    expect(removed).toBe(0);
    expect(messages).toHaveLength(2);
  });

  it('should not remove duplicate user messages with different content', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Read the file' },
      { role: 'user', content: 'Now edit the file' }, // Different → keep
    ];

    const { messages, removed } = snipMessages(msgs);
    expect(removed).toBe(0);
    expect(messages).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Layer 2: Microcompact
// ═══════════════════════════════════════════════════════════════════════════

describe('Layer 2: Microcompact (zero-cost)', () => {
  it('should truncate long tool results after cache prefix', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Read the file' },
      { role: 'tool', toolCallId: 'tc1', content: 'A'.repeat(30000) }, // > 20K
      { role: 'assistant', content: 'File is very long' },
    ];

    const { messages: resultMsgs, truncated } = microcompactMessages(msgs, 0);
    expect(truncated).toBe(1);
    // Tool result should be truncated in RESULT (not original)
    const toolMsg = resultMsgs.find(m => m.role === 'tool')!;
    expect(toolMsg.content).toContain('[truncated]');
    expect(toolMsg.content!.length).toBe(20000 + '...[truncated]'.length);
    // Original should NOT be mutated
    const origToolMsg = msgs.find(m => m.role === 'tool')!;
    expect(origToolMsg.content!.length).toBe(30000);
  });

  it('should skip messages within cache prefix', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Read the file' },
      { role: 'tool', toolCallId: 'tc1', content: 'A'.repeat(30000) }, // Index 2
      { role: 'assistant', content: 'Done' },
    ];

    // cachePrefixEnd = 2 means indices 0,1,2 are cached → tool result at index 2 is preserved
    const { messages: resultMsgs, truncated } = microcompactMessages(msgs, 2);
    expect(truncated).toBe(0);
    const toolMsg = resultMsgs.find(m => m.role === 'tool')!;
    expect(toolMsg.content).not.toContain('[truncated]');
    expect(toolMsg.content!.length).toBe(30000);
  });

  it('should not truncate tool results under the limit', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Read the file' },
      { role: 'tool', toolCallId: 'tc1', content: 'short result' },
    ];

    const { truncated } = microcompactMessages(msgs, -1);
    expect(truncated).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Layer 4: AutoCompact
// ═══════════════════════════════════════════════════════════════════════════

describe('Layer 4: AutoCompact (full head summary)', () => {
  let agent: SpicaAgent;
  let mockLLM: any;

  beforeEach(() => {
    const result = makeAgent();
    agent = result.agent;
    mockLLM = result.mockLLM;
  });

  it('should replace head with summary, keep tail', async () => {
    mockLLM._msgs = [
      { role: 'user', content: 'X'.repeat(400) },
      { role: 'assistant', content: 'Y'.repeat(400) },
      { role: 'user', content: 'X'.repeat(400) },
      { role: 'assistant', content: 'Y'.repeat(400) },
      { role: 'user', content: 'X'.repeat(400) },
      { role: 'assistant', content: 'Y'.repeat(400) },
      { role: 'user', content: 'X'.repeat(400) },
      { role: 'assistant', content: 'Y'.repeat(400) },
      { role: 'user', content: 'X'.repeat(400) },
      { role: 'assistant', content: 'Y'.repeat(400) },
      { role: 'user', content: 'TAIL_USER_MSG' },
      { role: 'assistant', content: 'TAIL_ASSISTANT_MSG' },
    ];

    await autoCompactContext(agent, 300, undefined);

    const finalMessages = mockLLM._msgs as ChatMessage[];
    // Should have summary + tail messages
    expect(finalMessages.length).toBeLessThan(12);

    // Summary is user message
    expect(finalMessages[0].role).toBe('user');
    expect(finalMessages[0].content).toContain('[COMPACTED HISTORY');

    // Tail preserved
    expect(finalMessages[finalMessages.length - 2].content).toBe('TAIL_USER_MSG');
    expect(finalMessages[finalMessages.length - 1].content).toBe('TAIL_ASSISTANT_MSG');
  });

  it('should preserve system messages', async () => {
    mockLLM._msgs = [
      { role: 'system', content: 'You are spica assistant' },
      { role: 'user', content: 'X'.repeat(400) },
      { role: 'assistant', content: 'Y'.repeat(400) },
      { role: 'user', content: 'X'.repeat(400) },
      { role: 'assistant', content: 'Y'.repeat(400) },
      { role: 'user', content: 'X'.repeat(400) },
      { role: 'assistant', content: 'Y'.repeat(400) },
      { role: 'user', content: 'X'.repeat(400) },
      { role: 'assistant', content: 'Y'.repeat(400) },
    ];

    await autoCompactContext(agent, 300, undefined);

    const finalMessages = mockLLM._msgs as ChatMessage[];
    expect(finalMessages[0].role).toBe('system');
    expect(finalMessages[0].content).toContain('spica');
  });

  it('should use fallback on LLM error', async () => {
    mockLLM.generateForCompression = vi.fn().mockRejectedValue(new Error('API error'));

    mockLLM._msgs = [];
    for (let i = 0; i < 15; i++) {
      mockLLM._msgs.push({ role: 'user', content: 'X'.repeat(400) });
      mockLLM._msgs.push({ role: 'assistant', content: 'Y'.repeat(400) });
    }

    await autoCompactContext(agent, 300, undefined);

    const finalMessages = mockLLM._msgs as ChatMessage[];
    const fallback = finalMessages.find(
      (m: ChatMessage) => m.role === 'user' && m.content?.includes('rule-based summary')
    );
    expect(fallback).toBeDefined();
  });

  it('should not re-enter while compacting', async () => {
    mockLLM._msgs = [];
    for (let i = 0; i < 20; i++) {
      mockLLM._msgs.push({ role: 'user', content: 'X'.repeat(500) });
      mockLLM._msgs.push({ role: 'assistant', content: 'Y'.repeat(500) });
    }

    mockLLM.generateForCompression = vi.fn().mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve({ content: 'Slow summary with file.ts fix' }), 100))
    );

    const compact1 = agent.compact();
    // Second compact while first is in-flight: should be a no-op
    // isCompacting() returns true → manageContext returns immediately
    await agent.compact();
    await compact1;

    // Agent must be clean after both complete
    expect(agent.isCompacting()).toBe(false);
    expect(agent.stateMachine.current).toBe('idle');
    // The first compact did call setMessages (via the waterfall)
    expect(mockLLM.setMessages).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Recency preservation tests (fix for context corruption bug)
// ═══════════════════════════════════════════════════════════════════════════

describe('buildSummaryPrompt — recency markers', () => {
  it('should tag the LAST user message as [LATEST]', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Revert all changes' },
      { role: 'assistant', content: 'Done reverting' },
      { role: 'user', content: 'Add feature X' },
      { role: 'assistant', content: 'Added feature X' },
      { role: 'user', content: 'Remove color scheme system' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'edit', arguments: { path: '/file' } }] },
      { role: 'tool', toolCallId: 't1', content: 'File edited' },
    ];

    const prompt = buildSummaryPrompt(msgs);

    // Extract the "History messages:" section only — the template itself
    // also mentions [LATEST] and [OLD] in its instructions.
    const historyStart = prompt.indexOf('History messages:');
    const historySection = prompt.slice(historyStart);

    // The LAST user message should be tagged as LATEST in the history section
    expect(historySection).toContain('[LATEST — CURRENT INSTRUCTION');
    expect(historySection).toContain('Remove color scheme system');

    // Earlier user messages should be tagged as OLD in the history section
    expect(historySection).toContain('[OLD — historical context');
    expect(historySection).toContain('Revert all changes');
    expect(historySection).toContain('Add feature X');

    // LATEST should only appear once in the *history section*
    const latestCount = (historySection.match(/\[LATEST/g) || []).length;
    expect(latestCount).toBe(1);
  });

  it('should handle single user message (no OLD messages)', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Only instruction' },
      { role: 'assistant', content: 'Working on it' },
    ];

    const prompt = buildSummaryPrompt(msgs);

    // Extract the history section — template instructions reference [OLD]
    const historyStart = prompt.indexOf('History messages:');
    const historySection = prompt.slice(historyStart);

    // Single user message = the latest, but also the only one
    expect(historySection).toContain('[LATEST — CURRENT INSTRUCTION');
    // No user message should be tagged [OLD] in the history section
    expect(historySection).not.toContain('[OLD — historical context');
  });
});

describe('autoCompactContext — last user message preserved in tail', () => {
  let agent: SpicaAgent;
  let mockLLM: any;

  beforeEach(() => {
    const result = makeAgent();
    agent = result.agent;
    mockLLM = result.mockLLM;
  });

  it('should preserve last user message in tail even when far back', async () => {
    // Build a conversation where the last user message is far from the tail.
    // User instruction is at position 3, followed by many tool interactions.
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Old revert instruction' },
      { role: 'assistant', content: 'Done reverting' },
      { role: 'user', content: 'Add feature X' },
      { role: 'assistant', content: 'Added feature X' },
      // Current instruction — 4 messages before the end
      { role: 'user', content: 'CURRENT: Remove color scheme system' },
      // Many tool interactions after the user instruction
      { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'edit', arguments: { path: '/a' } }] },
      { role: 'tool', toolCallId: 't1', content: 'edited a' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't2', name: 'edit', arguments: { path: '/b' } }] },
      { role: 'tool', toolCallId: 't2', content: 'edited b' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't3', name: 'read', arguments: { path: '/c' } }] },
      { role: 'tool', toolCallId: 't3', content: 'content of c here with enough chars' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't4', name: 'grep', arguments: { pattern: 'theme' } }] },
      { role: 'tool', toolCallId: 't4', content: 'found theme reference in theme here' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't5', name: 'read', arguments: { path: '/d' } }] },
      { role: 'tool', toolCallId: 't5', content: 'reading file d with enough content to keep' },
    ];

    // Need to make token estimation return > target so it compresses
    // Each message is "large enough" with the content strings above
    mockLLM._msgs = msgs;
    mockLLM.generateForCompression = vi.fn().mockResolvedValue({
      content: 'Summary: user wanted to revert old changes, add feature X, and currently working on removing color scheme',
    });

    // Provide enough tokens used to trigger compression
    const origEstimate = mockLLM.getTokenCounter().estimateMessages;
    mockLLM.getTokenCounter().estimateMessages = vi.fn().mockReturnValue(1000);

    await autoCompactContext(agent, 300, undefined);

    const finalMessages = mockLLM._msgs as ChatMessage[];

    // The current user instruction MUST be present verbatim
    const userMessages = finalMessages.filter(m => m.role === 'user');
    const hasCurrentInstruction = userMessages.some(
      m => m.content?.includes('CURRENT: Remove color scheme system')
    );
    expect(hasCurrentInstruction).toBe(true);

    // Restore original
    mockLLM.getTokenCounter().estimateMessages = origEstimate;
  });

  it('should not duplicate last user if already in default tail', async () => {
    // User message is within the last 6 messages (default tail for mock context window = 1000)
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Old instruction' },
      { role: 'assistant', content: 'Done' },
      { role: 'user', content: 'Another old instruction' },
      { role: 'assistant', content: 'Done again' },
      { role: 'user', content: 'LATEST_INSTRUCTION' },
      { role: 'assistant', content: 'Final response' },
    ];

    mockLLM._msgs = msgs;
    mockLLM.generateForCompression = vi.fn().mockResolvedValue({
      content: 'Summary with file.ts and fix applied',
    });

    // Target 300 with 1000 tokens used → compresses
    const origEstimate = mockLLM.getTokenCounter().estimateMessages;
    mockLLM.getTokenCounter().estimateMessages = vi.fn().mockReturnValue(1000);

    await autoCompactContext(agent, 300, undefined);

    const finalMessages = mockLLM._msgs as ChatMessage[];
    const userMessages = finalMessages.filter(m => m.role === 'user');

    // LATEST_INSTRUCTION should appear exactly once
    const latestCount = userMessages.filter(
      m => m.content?.includes('LATEST_INSTRUCTION')
    ).length;
    expect(latestCount).toBe(1);

    mockLLM.getTokenCounter().estimateMessages = origEstimate;
  });
});
