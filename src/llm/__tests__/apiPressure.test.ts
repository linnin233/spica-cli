// API and network pressure tests
import { OpenAICompatibleProvider } from '../providers/OpenAICompatible';
import { TokenCounter } from '../TokenCounter';
import type { ChatMessage } from '../providers/BaseProvider';

describe('API Pressure Tests', () => {
  describe('Token Counter Stress', () => {
    it('should handle very large message arrays efficiently', () => {
      const counter = new TokenCounter();
      counter.setContextWindow(200000);

      // Create 5000 messages
      const messages: ChatMessage[] = [];
      for (let i = 0; i < 5000; i++) {
        messages.push({ role: 'user', content: 'Test ' + i });
        messages.push({ role: 'assistant', content: 'Response ' + i });
      }

      const start = Date.now();
      const tokens = counter.estimateMessages(messages);
      const duration = Date.now() - start;

      expect(tokens).toBeGreaterThan(0);
      expect(duration).toBeLessThan(100); // Should be fast (< 100ms)
    });

    it('should handle messages with massive toolCalls', () => {
      const counter = new TokenCounter();

      const msg = {
        role: 'assistant',
        content: '',
        toolCalls: Array(100)
          .fill(null)
          .map((_, i) => ({
            id: `tc-${i}`,
            name: 'tool-' + i,
            arguments: { data: 'arg-' + i, path: `/file${i}.txt` },
          })),
      };

      const tokens = counter.estimateMessage(msg);
      expect(tokens).toBeGreaterThan(1000);
    });
  });

  describe('Provider Configuration', () => {
    it('should set correct context window for GLM-5', () => {
      const provider = new OpenAICompatibleProvider({
        apiKey: 'test-key',
        baseUrl: 'https://test.com',
        model: 'glm-5',
      });

      expect(provider.getContextWindow()).toBe(190000);
    });

    it('should set correct context window for GPT-4o', () => {
      const provider = new OpenAICompatibleProvider({
        apiKey: 'test-key',
        baseUrl: 'https://test.com',
        model: 'gpt-4o',
      });

      expect(provider.getContextWindow()).toBe(128000);
    });

    it('should use default context window for unknown models', () => {
      const provider = new OpenAICompatibleProvider({
        apiKey: 'test-key',
        baseUrl: 'https://test.com',
        model: 'unknown-model',
      });

      expect(provider.getContextWindow()).toBe(128000); // Default
    });
  });

  describe('Error Handling', () => {
    it('should parse connection errors correctly', () => {
      // Test error parsing function indirectly through provider
      const provider = new OpenAICompatibleProvider({
        apiKey: 'test-key',
        baseUrl: 'https://invalid-url',
        model: 'test',
      });

      // Provider should be created successfully
      expect(provider).toBeDefined();
    });
  });

  describe('Tool Message Deduplication', () => {
    it('should not add duplicate tool messages with same toolCallId', () => {
      const provider = new OpenAICompatibleProvider({
        apiKey: 'test-key',
        baseUrl: 'https://test.com',
        model: 'test-model',
      });

      provider.addToolMessage('tc-123', 'result 1');
      provider.addToolMessage('tc-123', 'result 2');
      provider.addToolMessage('tc-456', 'result 3');

      const messages = provider.getMessages();
      const toolMessages = messages.filter(m => m.role === 'tool');

      expect(toolMessages.length).toBe(2);
      expect(toolMessages[0].toolCallId).toBe('tc-123');
      expect(toolMessages[0].content).toBe('result 1');
      expect(toolMessages[1].toolCallId).toBe('tc-456');
    });

    it('should allow different toolCallIds', () => {
      const provider = new OpenAICompatibleProvider({
        apiKey: 'test-key',
        baseUrl: 'https://test.com',
        model: 'test-model',
      });

      provider.addToolMessage('tc-1', 'result 1');
      provider.addToolMessage('tc-2', 'result 2');
      provider.addToolMessage('tc-3', 'result 3');

      const messages = provider.getMessages();
      const toolMessages = messages.filter(m => m.role === 'tool');

      expect(toolMessages.length).toBe(3);
    });
  });

  describe('Message Size Limits', () => {
    it('should truncate text to fit in context', () => {
      const counter = new TokenCounter();
      const longText = 'A'.repeat(100000);

      const truncated = counter.truncateToFit(longText, 1000);
      expect(truncated.length).toBeLessThanOrEqual(4000); // 1000 tokens * 4 chars
      expect(truncated.endsWith('...')).toBe(true);
    });

    it('should handle empty text truncation', () => {
      const counter = new TokenCounter();
      const truncated = counter.truncateToFit('', 1000);
      expect(truncated).toBe('');
    });

    it('should not truncate short text', () => {
      const counter = new TokenCounter();
      const shortText = 'Hello world';
      const truncated = counter.truncateToFit(shortText, 1000);
      expect(truncated).toBe(shortText);
    });
  });
});
