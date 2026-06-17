// LLM error handling tests
// These tests require API provider configuration - skip if CI environment
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpicaAgent } from '../agent';
import { TokenCounter } from '../llm/TokenCounter';
import type { ChatMessage } from '../llm/providers/BaseProvider';

const shouldSkip = process.env.CI === 'true' || process.env.SKIP_API_TESTS === 'true';

// Partial mock of tools module
vi.mock('../tools/index', async importOriginal => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    executeTool: vi.fn().mockResolvedValue({ success: true, output: 'mock output' }),
    getAllToolDefinitions: vi.fn().mockReturnValue([]),
  };
});

describe.skipIf(shouldSkip)('LLM Error Handling', () => {
  let agent: SpicaAgent;
  let mockLLM: any;
  let testMessages: ChatMessage[];

  beforeEach(() => {
    vi.useFakeTimers(); // 使用假计时器加速重试延迟
    agent = new SpicaAgent('test', '/tmp/spica-test-error');

    testMessages = [];

    mockLLM = {
      getMessages: vi.fn(() => testMessages),
      setMessages: vi.fn((msgs: ChatMessage[]) => {
        testMessages = msgs;
      }),
      addMessage: vi.fn((msg: ChatMessage) => {
        testMessages.push(msg);
      }),
      getProvider: vi.fn(() => ({
        getContextWindow: () => 10000,
      })),
      getTokenCounter: vi.fn(() => {
        const counter = new TokenCounter();
        counter.setContextWindow(10000);
        return counter;
      }),
      generate: vi.fn().mockResolvedValue({ content: 'Mock response', finished: true }),
      continueWithAllToolResults: vi
        .fn()
        .mockResolvedValue({ content: 'Mock continuation', finished: true }),
    };

    Object.defineProperty(agent, 'llm', { value: mockLLM, writable: true });

    // State machine: skip init since we inject mock LLM directly
    agent.stateMachine.forceTransition('idle');
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('Initial generate failure', () => {
    it('should handle LLM generate failure gracefully', async () => {
      // 每次 generate 都失败（模拟持续的网络问题）
      mockLLM.generate = vi.fn().mockRejectedValue(new Error('OpenAI API error: Connection error'));

      // 启动 runLoop 并推进计时器以加速重试
      const resultPromise = agent.runLoop('test prompt');

      // 推进所有重试延迟（10次重试，每次最多60秒）
      for (let i = 0; i < 11; i++) {
        await vi.advanceTimersByTimeAsync(60000);
      }

      const result = await resultPromise;

      expect(result).toContain('LLM request failed');
      expect(result).toContain('Connection error');
    });

    it('should emit error_suggestion event on generate failure', async () => {
      mockLLM.generate = vi.fn().mockRejectedValue(new Error('API timeout'));

      const errorListener = vi.fn();
      agent.on('error_suggestion', errorListener);

      const resultPromise = agent.runLoop('test prompt');

      // 推进所有重试延迟
      for (let i = 0; i < 11; i++) {
        await vi.advanceTimersByTimeAsync(60000);
      }

      await resultPromise;

      expect(errorListener).toHaveBeenCalled();
      expect(errorListener.mock.calls[0][0].error).toContain('API timeout');
    });
  });

  describe('Continue after tool results failure', () => {
    it('should handle continueWithAllToolResults failure gracefully', async () => {
      // First call succeeds with tool calls
      mockLLM.generate = vi.fn().mockResolvedValue({
        toolCalls: [{ id: 'tc1', name: 'read', arguments: { path: '/test.txt' } }],
        finished: false,
      });

      // Continue 每次都失败
      mockLLM.continueWithAllToolResults = vi
        .fn()
        .mockRejectedValue(new Error('Network interrupted'));

      const resultPromise = agent.runLoop('read a file');

      // 推进所有重试延迟
      for (let i = 0; i < 11; i++) {
        await vi.advanceTimersByTimeAsync(60000);
      }

      const result = await resultPromise;

      expect(result).toContain('Operations completed');
      expect(result).toContain('LLM continuation failed');
      expect(result).toContain('Network interrupted');
    });

    it('should emit error_suggestion on continue failure', async () => {
      mockLLM.generate = vi.fn().mockResolvedValue({
        toolCalls: [{ id: 'tc1', name: 'bash', arguments: { command: 'ls' } }],
        finished: false,
      });

      mockLLM.continueWithAllToolResults = vi
        .fn()
        .mockRejectedValue(new Error('Stream interrupted'));

      const errorListener = vi.fn();
      agent.on('error_suggestion', errorListener);

      const resultPromise = agent.runLoop('run a command');

      // 推进所有重试延迟
      for (let i = 0; i < 11; i++) {
        await vi.advanceTimersByTimeAsync(60000);
      }

      await resultPromise;

      expect(errorListener).toHaveBeenCalled();
    });
  });

  describe('Network resilience', () => {
    it('should not crash on transient network errors', async () => {
      // 每次 generate 都失败（模拟持续的网络问题）
      mockLLM.generate = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

      const resultPromise = agent.runLoop('test');

      // 推进所有重试延迟
      for (let i = 0; i < 11; i++) {
        await vi.advanceTimersByTimeAsync(60000);
      }

      const result = await resultPromise;

      expect(result).toContain('LLM request failed');
      // Agent handles gracefully, doesn't crash
    });
  });
});
