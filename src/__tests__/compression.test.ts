// Layered compression integration tests
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpicaAgent } from '../agent';
import { TokenCounter } from '../llm/TokenCounter';
import {
  snipMessages,
  microcompactMessages,
  autoCompactContext,
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

    const truncated = microcompactMessages(msgs, 0); // cache prefix = 0 (system only)
    expect(truncated).toBe(1);
    // Tool result should be truncated
    const toolMsg = msgs.find(m => m.role === 'tool')!;
    expect(toolMsg.content).toContain('[truncated]');
    expect(toolMsg.content!.length).toBe(20000 + '...[truncated]'.length);
  });

  it('should skip messages within cache prefix', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Read the file' },
      { role: 'tool', toolCallId: 'tc1', content: 'A'.repeat(30000) }, // Index 2
      { role: 'assistant', content: 'Done' },
    ];

    // cachePrefixEnd = 2 means indices 0,1,2 are cached → tool result at index 2 is preserved
    const truncated = microcompactMessages(msgs, 2);
    expect(truncated).toBe(0);
    const toolMsg = msgs.find(m => m.role === 'tool')!;
    expect(toolMsg.content).not.toContain('[truncated]');
    expect(toolMsg.content!.length).toBe(30000);
  });

  it('should not truncate tool results under the limit', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Read the file' },
      { role: 'tool', toolCallId: 'tc1', content: 'short result' },
    ];

    const truncated = microcompactMessages(msgs, -1);
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
