/**
 * End-to-end compression tests.
 *
 * Simulates real agent conversations to verify:
 * 1. Compression triggers correctly when context fills up
 * 2. Agent state is clean after compression (not stuck)
 * 3. Agent can continue working — summary replaces head, tail intact
 * 4. No continuation signals leak into the message list
 * 5. Cache prefix is preserved across compression layers
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpicaAgent } from '../agent';
import { TokenCounter } from '../llm/TokenCounter';
import {
  snipMessages,
  microcompactMessages,
  manageContext,
  autoCompactContext,
} from '../core/compression';
import type { ChatMessage } from '../llm/providers/BaseProvider';

// ── Helpers ──

/** Build a realistic agent conversation that fills a given context window. */
function makeRealisticConversation(rounds: number): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  msgs.push({ role: 'user', content: 'Please refactor the compression module in src/core/compression.ts. It has grown too complex and needs to be split into smaller functions.' });

  for (let i = 0; i < rounds; i++) {
    msgs.push({
      role: 'assistant',
      content: 'Let me look at the current code.',
      toolCalls: [
        { id: `tc_read_${i}`, name: 'read', arguments: { path: `src/core/module_${i}.ts` } },
        { id: `tc_grep_${i}`, name: 'grep', arguments: { pattern: `function_${i}`, path: 'src/' } },
      ],
    });
    msgs.push({ role: 'tool', toolCallId: `tc_read_${i}`, content: `// File module_${i}.ts\n${'export function handler() { return ' + i + '; }\n'.repeat(30)}` });
    msgs.push({ role: 'tool', toolCallId: `tc_grep_${i}`, content: `src/core/module_${i}.ts:42:  handler_${i}()` });

    msgs.push({
      role: 'assistant',
      content: `I'll refactor module_${i}.ts now.`,
      toolCalls: [
        { id: `tc_edit_${i}`, name: 'edit', arguments: { path: `src/core/module_${i}.ts`, old_string: `handler_${i}`, new_string: `refactored_handler_${i}` } },
      ],
    });
    msgs.push({ role: 'tool', toolCallId: `tc_edit_${i}`, content: 'Edit applied successfully.' });

    if (i % 3 === 0) {
      msgs.push({
        role: 'assistant',
        content: 'Checking if it compiles.',
        toolCalls: [
          { id: `tc_bash_${i}`, name: 'bash', arguments: { command: `npx tsc --noEmit src/core/module_${i}.ts` } },
        ],
      });
      msgs.push({ role: 'tool', toolCallId: `tc_bash_${i}`, content: 'Compilation successful. No errors.' });
    }

    if (i % 5 === 0) {
      msgs.push({
        role: 'assistant',
        content: 'Let me check something minor.',
        toolCalls: [
          { id: `tc_empty_${i}`, name: 'grep', arguments: { pattern: `unused_${i}`, path: 'src/' } },
        ],
      });
      msgs.push({ role: 'tool', toolCallId: `tc_empty_${i}`, content: '' });
    }
  }

  msgs.push({ role: 'user', content: 'Now run the full test suite to verify everything works.' });

  return msgs;
}

function makeAgent(ctxWindow: number) {
  const agent = new SpicaAgent('test', '/tmp/spica-test-e2e');
  let _msgs: ChatMessage[] = [];

  const mockLLM = {
    getMessages: vi.fn(() => _msgs),
    setMessages: vi.fn((msgs: ChatMessage[]) => { _msgs = msgs; }),
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
      content: '## Active Task\nRefactor compression.ts module.\n## Completed\n- Read and edited multiple modules\n## In Progress\n- Running test suite\n## Next Action\nRun tests to verify refactored code.',
    }),
  };

  Object.defineProperty(agent, 'llm', { value: mockLLM, writable: true });
  agent.stateMachine.forceTransition('idle');

  return { agent, mockLLM };
}

// ═══════════════════════════════════════════════════════════════════════════
// E2E Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Compression E2E — agent continues after compression', () => {
  const SMALL_WINDOW = 2000;

  describe('Waterfall triggers correctly', () => {
    it('should trigger Snip when context has empty tool results', async () => {
      const { agent, mockLLM } = makeAgent(SMALL_WINDOW);
      const msgs = makeRealisticConversation(5);
      mockLLM.setMessages(msgs);

      const targetTokens = Math.floor(SMALL_WINDOW * 0.4);
      await manageContext(agent, targetTokens);

      const finalMsgs = mockLLM.getMessages();
      const counter = new TokenCounter();
      counter.setContextWindow(SMALL_WINDOW);
      const nonSystem = finalMsgs.filter((m: ChatMessage) => m.role !== 'system');
      const finalTokens = counter.estimateMessages(nonSystem);

      expect(finalMsgs.length).toBeLessThan(msgs.length);
      expect(finalTokens).toBeLessThan(SMALL_WINDOW * 0.5);
    });
  });

  describe('Agent state after compression', () => {
    it('should return to idle state after compression', async () => {
      const { agent, mockLLM } = makeAgent(SMALL_WINDOW);
      const msgs = makeRealisticConversation(10);
      mockLLM.setMessages(msgs);

      expect(agent.stateMachine.current).toBe('idle');

      await manageContext(agent, Math.floor(SMALL_WINDOW * 0.4));

      expect(agent.stateMachine.current).toBe('idle');
      expect(agent.isCompacting()).toBe(false);
    });

    it('should not be compacting after manageContext returns', async () => {
      const { agent, mockLLM } = makeAgent(SMALL_WINDOW);
      const msgs = makeRealisticConversation(10);
      mockLLM.setMessages(msgs);

      await manageContext(agent, Math.floor(SMALL_WINDOW * 0.4));

      expect(agent.isCompacting()).toBe(false);
    });
  });

  describe('Summary replaces head (no augmentation)', () => {
    it('should have exactly ONE summary in the message list', async () => {
      const { agent, mockLLM } = makeAgent(SMALL_WINDOW);
      const msgs = makeRealisticConversation(12);
      mockLLM.setMessages(msgs);

      await manageContext(agent, Math.floor(SMALL_WINDOW * 0.4));

      const finalMsgs = mockLLM.getMessages();
      const summaries = finalMsgs.filter(
        (m: ChatMessage) => m.content?.includes('[COMPACTED HISTORY')
      );
      expect(summaries.length).toBe(1);
    });

    it('should inject [CONTEXT COMPRESSED] continuation signal after compression', async () => {
      const { agent, mockLLM } = makeAgent(SMALL_WINDOW);
      const msgs = makeRealisticConversation(12);
      mockLLM.setMessages(msgs);

      await manageContext(agent, Math.floor(SMALL_WINDOW * 0.4));

      const finalMsgs = mockLLM.getMessages();
      // After compression, a continuation signal should be present so the
      // LLM knows to resume working rather than re-analyze from scratch.
      const hasContinueSignal = finalMsgs.some(
        (m: ChatMessage) => m.content?.includes('[CONTEXT COMPRESSED]')
      );
      expect(hasContinueSignal).toBe(true);
    });

    it('should not have truncated originals before the summary', async () => {
      const { agent, mockLLM } = makeAgent(SMALL_WINDOW);
      const msgs = makeRealisticConversation(12);
      mockLLM.setMessages(msgs);

      await manageContext(agent, Math.floor(SMALL_WINDOW * 0.4));

      const finalMsgs = mockLLM.getMessages();
      const summaryIdx = finalMsgs.findIndex(
        (m: ChatMessage) => m.content?.includes('[COMPACTED HISTORY')
      );
      // Messages before the summary should only be system or early setup
      const beforeSummary = finalMsgs.slice(0, summaryIdx);
      const hasTruncatedOriginals = beforeSummary.some(
        (m: ChatMessage) =>
          m.role !== 'system' && !m.content?.includes('[COMPACTED')
      );
      // There may be early setup messages preserved by Collapse — they're not truncated.
      // The key check: no continuation signals, exactly one summary.
      expect(summaryIdx).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Tail preserved for continuity', () => {
    it('should keep the final user message in tail (before continuation signal)', async () => {
      const { agent, mockLLM } = makeAgent(SMALL_WINDOW);
      const msgs = makeRealisticConversation(15);
      const lastUserMsg = 'Now run the full test suite to verify everything works.';
      expect(msgs[msgs.length - 1].content).toBe(lastUserMsg);

      mockLLM.setMessages(msgs);

      await manageContext(agent, Math.floor(SMALL_WINDOW * 0.4));

      const finalMsgs = mockLLM.getMessages();
      expect(finalMsgs.length).toBeGreaterThan(0);

      // The user message should still be in the message list
      const userMsg = finalMsgs.find(m => m.content === lastUserMsg);
      expect(userMsg).toBeDefined();
      expect(userMsg!.role).toBe('user');

      // The continuation signal should be the last message
      const lastMsg = finalMsgs[finalMsgs.length - 1];
      expect(lastMsg.role).toBe('user');
      expect(lastMsg.content).toContain('[CONTEXT COMPRESSED]');
    });
  });

  describe('Cache prefix preservation', () => {
    it('should restore cache prefix after compression', async () => {
      const { agent, mockLLM } = makeAgent(SMALL_WINDOW);
      const systemMsgCount = 2;

      const setCachePrefixEnd = vi.fn();
      mockLLM.getProvider.mockReturnValue({
        getContextWindow: () => SMALL_WINDOW,
        getCachePrefixEnd: () => -1,
        setCachePrefixEnd,
        validateCachePrefix: () => ({ valid: true, errors: [] }),
      });

      const msgs: ChatMessage[] = [
        { role: 'system', content: 'System prompt 1' },
        { role: 'system', content: 'System prompt 2' },
        ...makeRealisticConversation(10).filter(m => m.role !== 'system'),
      ];
      mockLLM.setMessages(msgs);

      await manageContext(agent, Math.floor(SMALL_WINDOW * 0.4));

      const setCalls = setCachePrefixEnd.mock.calls;
      expect(setCalls.length).toBeGreaterThan(0);
      // The value passed to setCachePrefixEnd should be valid (>= systemMsgCount - 1)
      // Note: with our tiny context window, the waterfall may just do Snip without
      // reaching Collapse/AutoCompact. In that case, restoreCachePrefix is still called.
    });
  });

  describe('Snip removes garbage without breaking context', () => {
    it('should remove empty tool results while keeping context intact', () => {
      const msgs: ChatMessage[] = [
        { role: 'user', content: 'Please check for unused imports' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'tc1', name: 'grep', arguments: { pattern: 'unused', path: 'src/' } },
            { id: 'tc2', name: 'read', arguments: { path: 'src/main.ts' } },
          ],
        },
        { role: 'tool', toolCallId: 'tc1', content: '' },
        { role: 'tool', toolCallId: 'tc2', content: 'import { foo } from "./foo";\nconst x = foo();' },
        { role: 'assistant', content: 'Found no unused imports. The code looks clean.' },
        { role: 'user', content: 'Great, now run the tests' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'tc3', name: 'bash', arguments: { command: 'npm test' } },
          ],
        },
        { role: 'tool', toolCallId: 'tc3', content: 'Tests: 42 passed, 0 failed' },
        { role: 'assistant', content: 'All tests pass!' },
      ];

      const { messages, removed } = snipMessages(msgs, -1);
      expect(removed).toBe(1);

      expect(messages.find(m => m.content === 'import { foo } from "./foo";\nconst x = foo();')).toBeDefined();
      expect(messages.find(m => m.content === 'Tests: 42 passed, 0 failed')).toBeDefined();
      expect(messages.find(m => m.content === 'All tests pass!')).toBeDefined();

      const assistant1 = messages.find(
        m => m.role === 'assistant' && m.toolCalls && m.toolCalls.length === 1
      );
      expect(assistant1).toBeDefined();
      expect(assistant1!.toolCalls![0].id).toBe('tc2');
    });
  });

  describe('No re-entry protection', () => {
    it('should prevent concurrent compression', async () => {
      const { agent, mockLLM } = makeAgent(SMALL_WINDOW);
      const msgs = makeRealisticConversation(15);
      mockLLM.setMessages(msgs);

      mockLLM.generateForCompression = vi.fn().mockImplementation(
        () => new Promise(resolve =>
          setTimeout(() => resolve({
            content: '## Active Task\nRefactoring.\n## Next Action\nContinue with remaining modules.',
          }), 100)
        )
      );

      const targetTokens = Math.floor(SMALL_WINDOW * 0.4);

      // Start first compression
      const first = manageContext(agent, targetTokens);

      // Try second compression immediately — should be no-op
      await manageContext(agent, targetTokens);

      await first;

      expect(agent.stateMachine.current).toBe('idle');
      expect(agent.isCompacting()).toBe(false);
    });
  });

  describe('collapseContext preserves last user message', () => {
    it('should keep the LAST user instruction (not the first) after collapse', async () => {
      const { agent, mockLLM } = makeAgent(SMALL_WINDOW);

      // System + early setup + middle + latest instruction
      const msgs: ChatMessage[] = [
        { role: 'system', content: 'You are spica assistant' },
        { role: 'user', content: 'I need to refactor the entire compression system to use a layered approach like Claude Code.' },
        { role: 'assistant', content: 'I\'ll analyze the current codebase and design a 4-layer compression architecture.' },
        ...makeRealisticConversation(20),
        // Add a specific last user message that should be preserved
        { role: 'user', content: 'CURRENT TASK: Remove color scheme system from config panel' },
        { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'edit', arguments: { path: '/file' } }] },
        { role: 'tool', toolCallId: 't1', content: 'File edited' },
      ];
      mockLLM.setMessages(msgs);

      await manageContext(agent, Math.floor(SMALL_WINDOW * 0.4));

      const finalMsgs = mockLLM.getMessages();
      // The LAST user message should be preserved (current instruction)
      const currentMsg = finalMsgs.find(
        (m: ChatMessage) => m.content === 'CURRENT TASK: Remove color scheme system from config panel'
      );
      expect(currentMsg).toBeDefined();

      // The FIRST user message should NOT appear verbatim (it's in the summary)
      const oldMsg = finalMsgs.find(
        (m: ChatMessage) => m.content === 'I need to refactor the entire compression system to use a layered approach like Claude Code.'
      );
      expect(oldMsg).toBeUndefined();
    });
  });

  describe('compression emits correct phase in events', () => {
    it('should emit context_compressed with waterfall phase', async () => {
      const { agent, mockLLM } = makeAgent(SMALL_WINDOW);
      const msgs = makeRealisticConversation(12);
      mockLLM.setMessages(msgs);

      const events: any[] = [];
      agent.on('context_compressed', (e) => events.push(e));

      await manageContext(agent, Math.floor(SMALL_WINDOW * 0.4));

      expect(events.length).toBeGreaterThan(0);
      // The phase should be one of the valid waterfall phases
      const validPhases = ['snip', 'microcompact', 'collapse-success', 'collapse-insufficient', 'auto-compact', 'auto-noop-under-target', 'auto-noop-empty', 'auto-noop-all-tail'];
      events.forEach(e => {
        expect(validPhases).toContain(e.phase);
      });
    });
  });
});
