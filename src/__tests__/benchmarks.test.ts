/**
 * Performance benchmarks for core spica operations.
 *
 * These tests measure baseline performance to prevent regressions.
 * Run with: npx vitest run src/__tests__/benchmarks.test.ts
 */

import { describe, it, expect } from 'vitest';
import { cleanMessages } from '../utils/messageCleaner';
import { buildSummaryPrompt } from '../core/compression';
import { TokenCounter } from '../llm/TokenCounter';
import type { ChatMessage } from '../llm/providers/BaseProvider';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeMessages(count: number): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < count; i++) {
    if (i % 4 === 0) {
      msgs.push({ role: 'user', content: `User message number ${i} with some content here.` });
    } else if (i % 4 === 1) {
      msgs.push({
        role: 'assistant',
        content: `Assistant response ${i}`,
        toolCalls: [{ id: `tc_${i}`, name: 'read', arguments: { path: `/some/file_${i}.ts` } }],
      });
    } else if (i % 4 === 2) {
      msgs.push({ role: 'tool', toolCallId: `tc_${i - 1}`, content: `File content for file_${i - 1}.ts` });
    } else {
      msgs.push({ role: 'assistant', content: `Assistant text response number ${i}. Some additional text for realism.` });
    }
  }
  return msgs;
}

function timeIt(fn: () => void, iterations: number = 1): number {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  return performance.now() - start;
}

// ── Benchmarks ───────────────────────────────────────────────────────────

describe('Performance Benchmarks', () => {
  describe('messageCleaner', () => {
    it('should clean 1K messages in under 10ms', () => {
      const msgs = makeMessages(1000);
      const elapsed = timeIt(() => cleanMessages(msgs));
      expect(elapsed).toBeLessThan(10);
    });

    it('should clean 10K messages in under 100ms', () => {
      const msgs = makeMessages(10000);
      const elapsed = timeIt(() => cleanMessages(msgs));
      expect(elapsed).toBeLessThan(100);
    }, 15000);
  });

  describe('compression', () => {
    it('should build summary prompt from 500 messages in under 20ms', () => {
      const msgs = makeMessages(500);
      const elapsed = timeIt(() => buildSummaryPrompt(msgs));
      expect(elapsed).toBeLessThan(20);
    });
  });

  describe('tokenCounter', () => {
    // Note: tiktoken is inherently slow for bulk estimation (~1ms per message).
    // These thresholds are set to detect regressions, not to prescribe targets.
    it('should estimate 1K messages in under 2 seconds', () => {
      const counter = new TokenCounter('gpt-4');
      counter.setContextWindow(128000);
      counter.estimateMessage({ role: 'user', content: 'warmup' });
      const msgs = makeMessages(1000);
      const elapsed = timeIt(() => counter.estimateMessages(msgs));
      expect(elapsed).toBeLessThan(2000);
    }, 15000);

    it('should estimate single message quickly after warmup', () => {
      const counter = new TokenCounter('gpt-4');
      counter.estimateMessage({ role: 'user', content: 'warmup' });
      const msg: ChatMessage = { role: 'user', content: 'Hello, this is a test message with some content.' };
      const elapsed = timeIt(() => counter.estimateMessage(msg), 10);
      expect(elapsed).toBeLessThan(10);
    });
  });
});
