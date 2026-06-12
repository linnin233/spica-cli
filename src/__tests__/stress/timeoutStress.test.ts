/**
 * 压力测试：检测可能导致超时的问题
 *
 * 测试场景：
 * 1. 长对话（大量消息）
 * 2. 大量工具调用
 * 3. 上下文接近限制
 * 4. 消息序列异常
 * 5. compact 操作性能
 * 6. 重试逻辑
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SpicaAgent } from '../../agent';
import { LLMClient } from '../../llm/LLMClient';
import { OpenAICompatibleProvider } from '../../llm/providers/OpenAICompatible';
import { cleanMessages } from '../../utils/messageCleaner';
import { TokenCounter } from '../../llm/TokenCounter';
import type { ChatMessage } from '../../llm/providers/BaseProvider';

// Mock LLM Provider for stress testing
class MockStressProvider extends OpenAICompatibleProvider {
  private delay: number;
  private failRate: number;
  private callCount: number = 0;

  constructor(config: any, delay: number = 100, failRate: number = 0) {
    super(config);
    this.delay = delay;
    this.failRate = failRate;
  }

  getCallCount() {
    return this.callCount;
  }

  resetCallCount() {
    this.callCount = 0;
  }

  setDelay(delay: number) {
    this.delay = delay;
  }

  setFailRate(rate: number) {
    this.failRate = rate;
  }

  override async generate(prompt: string, tools?: any, signal?: AbortSignal): Promise<any> {
    this.callCount++;

    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, this.delay));

    if (signal?.aborted) {
      return { finished: true };
    }

    // Simulate random failures
    if (Math.random() < this.failRate) {
      throw new Error('Network timeout');
    }

    // Add to message history
    this.messages.push({ role: 'user', content: prompt });
    this.messages.push({ role: 'assistant', content: 'Mock response' });

    return { content: 'Mock response', finished: true };
  }

  override async generateFromHistory(tools?: any, signal?: AbortSignal): Promise<any> {
    this.callCount++;

    await new Promise(resolve => setTimeout(resolve, this.delay));

    if (signal?.aborted) {
      return { finished: true };
    }

    if (Math.random() < this.failRate) {
      throw new Error('Network timeout');
    }

    this.messages.push({ role: 'assistant', content: 'Mock response from history' });
    return { content: 'Mock response from history', finished: true };
  }

  override async generateDirect(prompt: string, signal?: AbortSignal): Promise<any> {
    this.callCount++;

    await new Promise(resolve => setTimeout(resolve, this.delay));

    if (signal?.aborted) {
      return { finished: true };
    }

    return { content: 'Mock direct response', finished: true };
  }
}

describe('Stress Tests - Timeout Detection', () => {
  let provider: MockStressProvider;
  let llmClient: LLMClient;

  beforeEach(() => {
    provider = new MockStressProvider({
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'http://test',
      name: 'test-provider',
    });

    llmClient = new LLMClient({
      provider: 'test',
      apiKey: 'test-key',
      model: 'test-model',
    });

    // Replace internal provider with mock
    (llmClient as any).provider = provider;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('1. Long Conversation (大量消息)', () => {
    it('should handle 100 messages without timeout', async () => {
      const startTime = Date.now();

      // 添加 100 条消息
      for (let i = 0; i < 100; i++) {
        provider.addMessage({ role: 'user', content: `User message ${i}` });
        provider.addMessage({ role: 'assistant', content: `Assistant response ${i}` });
      }

      const messages = provider.getMessages();
      expect(messages.length).toBe(200);

      // 测试 generateFromHistory 性能
      provider.setDelay(10);
      const response = await llmClient.generateFromHistory();

      const elapsed = Date.now() - startTime;
      console.log(`[100 messages] elapsed: ${elapsed}ms, calls: ${provider.getCallCount()}`);

      expect(response.content).toBeDefined();
      expect(elapsed).toBeLessThan(5000); // 5秒内完成
    });

    it('should handle 500 messages without timeout', async () => {
      const startTime = Date.now();

      // 添加 500 条消息
      for (let i = 0; i < 500; i++) {
        provider.addMessage({ role: 'user', content: `User message ${i}` });
        provider.addMessage({ role: 'assistant', content: `Assistant response ${i}` });
      }

      const messages = provider.getMessages();
      expect(messages.length).toBe(1000);

      provider.setDelay(10);
      const response = await llmClient.generateFromHistory();

      const elapsed = Date.now() - startTime;
      console.log(`[500 messages] elapsed: ${elapsed}ms, calls: ${provider.getCallCount()}`);

      expect(response.content).toBeDefined();
      expect(elapsed).toBeLessThan(10000); // 10秒内完成
    });

    it('should handle 1000 messages without timeout', async () => {
      const startTime = Date.now();

      // 添加 1000 条消息
      for (let i = 0; i < 1000; i++) {
        provider.addMessage({ role: 'user', content: `User message ${i}` });
        provider.addMessage({ role: 'assistant', content: `Assistant response ${i}` });
      }

      const messages = provider.getMessages();
      expect(messages.length).toBe(2000);

      provider.setDelay(10);
      const response = await llmClient.generateFromHistory();

      const elapsed = Date.now() - startTime;
      console.log(`[1000 messages] elapsed: ${elapsed}ms, calls: ${provider.getCallCount()}`);

      expect(response.content).toBeDefined();
      expect(elapsed).toBeLessThan(15000); // 15秒内完成
    });
  });

  describe('2. Large Tool Calls (大量工具调用)', () => {
    it('should handle 50 tool calls in single response', async () => {
      const startTime = Date.now();

      // 创建包含 50 个 tool calls 的 assistant 消息
      const toolCalls = Array.from({ length: 50 }, (_, i) => ({
        id: `call_${i}`,
        name: 'test_tool',
        arguments: { param: `value_${i}` },
      }));

      provider.addMessage({
        role: 'assistant',
        content: '',
        toolCalls: toolCalls,
      });

      // 添加对应的 tool 结果
      for (let i = 0; i < 50; i++) {
        provider.addMessage({
          role: 'tool',
          content: `Tool result ${i}`,
          toolCallId: `call_${i}`,
        });
      }

      const messages = provider.getMessages();
      expect(messages.length).toBe(51);

      provider.setDelay(10);
      const response = await llmClient.generateFromHistory();

      const elapsed = Date.now() - startTime;
      console.log(`[50 tool calls] elapsed: ${elapsed}ms`);

      expect(elapsed).toBeLessThan(5000);
    });

    it('should handle 100 tool calls in single response', async () => {
      const startTime = Date.now();

      const toolCalls = Array.from({ length: 100 }, (_, i) => ({
        id: `call_${i}`,
        name: 'test_tool',
        arguments: { param: `value_${i}` },
      }));

      provider.addMessage({
        role: 'assistant',
        content: '',
        toolCalls: toolCalls,
      });

      for (let i = 0; i < 100; i++) {
        provider.addMessage({
          role: 'tool',
          content: `Tool result ${i}`,
          toolCallId: `call_${i}`,
        });
      }

      const messages = provider.getMessages();
      expect(messages.length).toBe(101);

      provider.setDelay(10);
      const response = await llmClient.generateFromHistory();

      const elapsed = Date.now() - startTime;
      console.log(`[100 tool calls] elapsed: ${elapsed}ms`);

      expect(elapsed).toBeLessThan(10000);
    });
  });

  describe('3. Message Sequence Anomalies (消息序列异常)', () => {
    it('should handle orphaned tool messages', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        // 孤立的 tool message（没有对应的 assistant toolCalls）
        { role: 'tool', content: 'Orphaned result', toolCallId: 'orphan_1' },
        { role: 'user', content: 'Next question' },
      ];

      const cleaned = cleanMessages(messages);

      // 孤立的 tool message 应该被移除
      expect(cleaned.filter(m => m.role === 'tool')).toHaveLength(0);
      expect(cleaned.length).toBe(3);
    });

    it('should handle missing tool messages', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hello' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call_1', name: 'tool1', arguments: {} },
            { id: 'call_2', name: 'tool2', arguments: {} },
          ],
        },
        // 只有 call_1 的结果，缺少 call_2
        { role: 'tool', content: 'Result 1', toolCallId: 'call_1' },
        { role: 'user', content: 'Next question' },
      ];

      const cleaned = cleanMessages(messages);

      // assistant 的 toolCalls 应该被移除
      const lastAssistant = cleaned.filter(m => m.role === 'assistant').pop();
      expect(lastAssistant?.toolCalls).toBeUndefined();
    });

    it('should handle complex nested scenarios', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Q1' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'tool1', arguments: {} }],
        },
        { role: 'tool', content: 'R1', toolCallId: 'call_1' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'Q2' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'call_2', name: 'tool2', arguments: {} },
            { id: 'call_3', name: 'tool3', arguments: {} },
          ],
        },
        // 只有 call_2 的结果
        { role: 'tool', content: 'R2', toolCallId: 'call_2' },
        // 孤立的 tool message
        { role: 'tool', content: 'Orphan', toolCallId: 'orphan' },
        { role: 'user', content: 'Q3' },
      ];

      const cleaned = cleanMessages(messages);

      // 检查清理后的消息序列
      expect(cleaned.length).toBeLessThan(messages.length);

      // 不应该有孤立的 tool message
      const toolMessages = cleaned.filter(m => m.role === 'tool');
      expect(toolMessages.length).toBeLessThanOrEqual(1);
    });

    it('should handle 1000 messages with anomalies efficiently', () => {
      const startTime = Date.now();

      const messages: ChatMessage[] = [];

      // 创建 1000 条消息，包含各种异常
      for (let i = 0; i < 200; i++) {
        messages.push({ role: 'user', content: `User ${i}` });
        messages.push({
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: `call_${i}_1`, name: 'tool', arguments: {} },
            { id: `call_${i}_2`, name: 'tool', arguments: {} },
          ],
        });
        // 只添加一个 tool result，制造缺失
        messages.push({ role: 'tool', content: `Result ${i}`, toolCallId: `call_${i}_1` });
        // 添加孤立的 tool message
        messages.push({ role: 'tool', content: 'Orphan', toolCallId: `orphan_${i}` });
      }

      const cleaned = cleanMessages(messages);

      const elapsed = Date.now() - startTime;
      console.log(
        `[1000 messages with anomalies] elapsed: ${elapsed}ms, cleaned: ${cleaned.length}`
      );

      expect(elapsed).toBeLessThan(1000); // 1秒内完成
    });
  });

  describe('4. Token Counter Performance (Token 计数性能)', () => {
    it('should count tokens for 1000 messages efficiently', () => {
      const tokenCounter = new TokenCounter();
      tokenCounter.setContextWindow(128000);

      const messages: ChatMessage[] = [];
      for (let i = 0; i < 1000; i++) {
        messages.push({
          role: 'user',
          content: `This is a test message with some content. Message number ${i}.`,
        });
        messages.push({
          role: 'assistant',
          content: `This is a response with some content. Response number ${i}.`,
        });
      }

      const startTime = Date.now();
      const tokens = tokenCounter.estimateMessages(messages);
      const elapsed = Date.now() - startTime;

      console.log(`[Token count 1000 messages] elapsed: ${elapsed}ms, tokens: ${tokens}`);

      expect(elapsed).toBeLessThan(500); // 500ms 内完成
      expect(tokens).toBeGreaterThan(0);
    });

    it('should count tokens for messages with large tool calls', () => {
      const tokenCounter = new TokenCounter();
      tokenCounter.setContextWindow(128000);

      const messages: ChatMessage[] = [];
      for (let i = 0; i < 100; i++) {
        messages.push({
          role: 'assistant',
          content: '',
          toolCalls: Array.from({ length: 10 }, (_, j) => ({
            id: `call_${i}_${j}`,
            name: 'test_tool',
            arguments: {
              param1: 'value1',
              param2: 'value2',
              param3: 'value3',
              param4: 'value4',
              param5: 'value5',
            },
          })),
        });
        for (let j = 0; j < 10; j++) {
          messages.push({
            role: 'tool',
            content: `Tool result ${i}_${j} with some content`,
            toolCallId: `call_${i}_${j}`,
          });
        }
      }

      const startTime = Date.now();
      const tokens = tokenCounter.estimateMessages(messages);
      const elapsed = Date.now() - startTime;

      console.log(`[Token count 1000 tool calls] elapsed: ${elapsed}ms, tokens: ${tokens}`);

      expect(elapsed).toBeLessThan(500);
    });
  });

  describe('5. Edge Cases (边界情况)', () => {
    it('should handle empty messages', () => {
      const messages: ChatMessage[] = [];
      const cleaned = cleanMessages(messages);
      expect(cleaned.length).toBe(0);
    });

    it('should handle only user messages', () => {
      const messages: ChatMessage[] = Array.from({ length: 100 }, (_, i) => ({
        role: 'user' as const,
        content: `User ${i}`,
      }));

      const cleaned = cleanMessages(messages);
      expect(cleaned.length).toBe(100);
    });

    it('should handle only tool messages', () => {
      const messages: ChatMessage[] = Array.from({ length: 100 }, (_, i) => ({
        role: 'tool' as const,
        content: `Tool ${i}`,
        toolCallId: `call_${i}`,
      }));

      const cleaned = cleanMessages(messages);
      // 所有孤立的 tool messages 应该被移除
      expect(cleaned.length).toBe(0);
    });

    it('should handle very long single message', () => {
      const tokenCounter = new TokenCounter();
      tokenCounter.setContextWindow(128000);

      // 创建一个超长消息（100KB）
      const longContent = 'A'.repeat(100000);
      const messages: ChatMessage[] = [{ role: 'user', content: longContent }];

      const startTime = Date.now();
      const tokens = tokenCounter.estimateMessages(messages);
      const elapsed = Date.now() - startTime;

      console.log(`[100KB message] elapsed: ${elapsed}ms, tokens: ${tokens}`);

      expect(elapsed).toBeLessThan(100);
    });

    it('should handle special characters in messages', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hello\n\t\r\n世界🌍🎉' },
        { role: 'assistant', content: 'Response with <xml> & "quotes" and \'apostrophes\'' },
      ];

      const cleaned = cleanMessages(messages);
      expect(cleaned.length).toBe(2);
    });
  });

  describe('6. Memory Leak Detection (内存泄漏检测)', () => {
    it('should not leak memory on repeated operations', async () => {
      const initialMemory = process.memoryUsage().heapUsed;

      // 执行 100 次操作
      for (let i = 0; i < 100; i++) {
        provider.addMessage({ role: 'user', content: `Test ${i}` });
        provider.addMessage({ role: 'assistant', content: `Response ${i}` });

        // 每 10 次清理一次
        if (i % 10 === 0) {
          provider.clearHistory();
        }
      }

      // 强制 GC（如果可用）
      if (global.gc) {
        global.gc();
      }

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;

      console.log(
        `[Memory] initial: ${(initialMemory / 1024 / 1024).toFixed(2)}MB, final: ${(finalMemory / 1024 / 1024).toFixed(2)}MB, increase: ${(memoryIncrease / 1024 / 1024).toFixed(2)}MB`
      );

      // 内存增长不应该超过 50MB
      expect(memoryIncrease).toBeLessThan(50 * 1024 * 1024);
    });
  });
});
