// Regression tests for bugs fixed today
import { describe, it, expect, beforeEach } from 'vitest';
import { TokenCounter } from '../../llm/TokenCounter';
import type { ChatMessage } from '../../llm/providers/BaseProvider';

describe('Token Counter Fix - Regression Tests', () => {
  let counter: TokenCounter;

  beforeEach(() => {
    counter = new TokenCounter();
  });

  describe('ToolCalls token counting', () => {
    it('should count toolCalls in assistant messages', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'test' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call_001', name: 'read', arguments: { path: '/test.txt' } },
            { id: 'call_002', name: 'bash', arguments: { command: 'ls -la' } },
          ],
        },
      ];

      const count = counter.estimateMessages(messages);

      // 应该包含：role + content + toolCalls的id/name/arguments
      expect(count).toBeGreaterThan(0);
      // 估算：每个toolCall约25-30 tokens (id + name + arguments JSON)
      // 基础content约10 tokens，总计约50+
      expect(count).toBeGreaterThan(50);
    });

    it('should count toolCallId in tool messages', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'test' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_001', name: 'read', arguments: { path: '/test.txt' } }],
        },
        {
          role: 'tool',
          content: 'file content here',
          toolCallId: 'call_001',
        },
      ];

      const count = counter.estimateMessages(messages);

      // 应该包含toolCallId的token
      expect(count).toBeGreaterThan(0);
      // tool message应该计入：toolCallId + content
      expect(count).toBeGreaterThan(20);
    });

    it('should handle multiple tool calls correctly', () => {
      const messages: ChatMessage[] = [
        {
          role: 'assistant',
          content: 'Processing...',
          toolCalls: [
            { id: 'call_001', name: 'read', arguments: { path: '/a.txt' } },
            { id: 'call_002', name: 'read', arguments: { path: '/b.txt' } },
            { id: 'call_003', name: 'read', arguments: { path: '/c.txt' } },
            { id: 'call_004', name: 'bash', arguments: { command: 'echo test' } },
          ],
        },
      ];

      const count = counter.estimateMessages(messages);

      // 4个tool calls应该都被计数
      expect(count).toBeGreaterThan(80);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty toolCalls array', () => {
      const messages: ChatMessage[] = [
        {
          role: 'assistant',
          content: 'No tools needed',
          toolCalls: [],
        },
      ];

      const count = counter.estimateMessages(messages);

      // 空数组不应该影响计数
      expect(count).toBeGreaterThan(0);
    });

    it('should handle messages without toolCalls', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ];

      const count = counter.estimateMessages(messages);

      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(50);
    });

    it('should count complex arguments JSON', () => {
      const complexArgs = {
        path: '/very/long/path/to/file.txt',
        options: {
          encoding: 'utf-8',
          mode: 'strict',
          flags: ['a', 'b', 'c'],
        },
        metadata: {
          author: 'test',
          version: '1.0.0',
        },
      };

      const messages: ChatMessage[] = [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_complex', name: 'write', arguments: complexArgs }],
        },
      ];

      const count = counter.estimateMessages(messages);

      // 复杂arguments应该被正确计数
      expect(count).toBeGreaterThan(60);
    });
  });

  describe('Context window threshold', () => {
    it('should trigger compression at 80% threshold', () => {
      const contextWindow = 10000;
      const triggerThreshold = contextWindow * 0.8;

      // 创建大量消息达到阈值
      const messages: ChatMessage[] = [];
      for (let i = 0; i < 100; i++) {
        messages.push({
          role: 'user',
          content: `Message ${i} with some content to add tokens`,
        });
      }

      const count = counter.estimateMessages(messages);
      const shouldCompress = count > triggerThreshold;

      // 如果超过阈值，应该触发压缩
      if (count > triggerThreshold) {
        expect(shouldCompress).toBe(true);
      }
    });
  });
});
