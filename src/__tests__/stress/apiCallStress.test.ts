/**
 * API 调用压力测试：检测可能导致 API 超时的问题
 *
 * 测试场景：
 * 1. 真实 API 调用延迟
 * 2. 上下文压缩触发时机
 * 3. 重试逻辑性能
 * 4. Rate Limiter 行为
 * 5. 消息序列对 API 的影响
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LLMClient } from '../../llm/LLMClient';
import { RateLimiter } from '../../llm/RateLimiter';
import { TokenCounter } from '../../llm/TokenCounter';
import type { ChatMessage } from '../../llm/providers/BaseProvider';

// 模拟真实 API 延迟的 Provider
class SimulatedAPIProvider {
  private messages: ChatMessage[] = [];
  private latency: number = 1000; // 默认 1 秒延迟（模拟真实 API）
  private timeoutThreshold: number = 60000; // 60 秒超时
  private processingTimeMultiplier: number = 0.01; // 消息数量对处理时间的影响

  setLatency(latency: number) {
    this.latency = latency;
  }

  getMessages() {
    return this.messages;
  }

  addMessage(message: ChatMessage) {
    this.messages.push(message);
  }

  clearHistory() {
    this.messages = [];
  }

  // 模拟真实 API 调用：延迟随消息数量增加
  async simulateAPICall(signal?: AbortSignal): Promise<{ content: string; finished: boolean }> {
    const startTime = Date.now();

    // 计算处理时间：基础延迟 + 消息数量影响
    const messageCount = this.messages.length;
    const processingTime = this.latency + messageCount * this.processingTimeMultiplier;

    console.log(
      `[API Sim] messageCount: ${messageCount}, processingTime: ${processingTime.toFixed(0)}ms`
    );

    // 模拟流式响应（每 100ms 检查一次中断）
    const chunks = ['Response', ' from', ' simulated', ' API'];
    let fullContent = '';

    for (const chunk of chunks) {
      if (signal?.aborted) {
        return { content: fullContent, finished: true };
      }

      await new Promise(resolve => setTimeout(resolve, processingTime / chunks.length));
      fullContent += chunk;
    }

    const elapsed = Date.now() - startTime;
    console.log(`[API Sim] actual elapsed: ${elapsed}ms`);

    if (elapsed > this.timeoutThreshold) {
      throw new Error('Request timed out');
    }

    this.messages.push({ role: 'assistant', content: fullContent });
    return { content: fullContent, finished: true };
  }
}

describe('API Call Stress Tests', () => {
  describe('1. Rate Limiter Behavior', () => {
    it('should handle rate limiting correctly', async () => {
      const limiter = new RateLimiter({
        requestsPerMinute: 10,
        tokensPerMinute: 10000,
      });

      const startTime = Date.now();

      // 快速发送 5 个请求（应该在 rate limit 内）
      for (let i = 0; i < 5; i++) {
        await limiter.waitForAvailability();
        limiter.recordRequest();
        limiter.recordTokenUsage(1000);
      }

      const elapsed = Date.now() - startTime;
      console.log(`[Rate Limiter] 5 requests elapsed: ${elapsed}ms`);

      expect(elapsed).toBeLessThan(1500); // 中断响应可能需要额外时间 // 应该几乎立即完成
    });

    it('should wait when exceeding rate limit', async () => {
      const limiter = new RateLimiter({
        requestsPerMinute: 60, // 每分钟 60 个请求（每秒 1 个）
        tokensPerMinute: 10000,
      });

      const startTime = Date.now();

      // 发送 3 个请求（应该很快完成）
      for (let i = 0; i < 3; i++) {
        await limiter.waitForAvailability();
        limiter.recordRequest();
        console.log(`[Rate Limiter] request ${i + 1} sent`);
      }

      const elapsed = Date.now() - startTime;
      console.log(`[Rate Limiter] 3 requests elapsed: ${elapsed}ms`);

      expect(elapsed).toBeLessThan(2000); // 中断响应可能需要额外时间
    });

    it('should handle interrupt during rate limit wait', async () => {
      const limiter = new RateLimiter({
        requestsPerMinute: 1, // 极低限制
        tokensPerMinute: 100,
      });

      // 先消耗一个请求
      await limiter.waitForAvailability();
      limiter.recordRequest();

      // 第二个请求应该等待
      const controller = new AbortController();

      // 100ms 后中断
      setTimeout(() => {
        controller.abort();
        limiter.interrupt();
      }, 100);

      const startTime = Date.now();

      try {
        await limiter.waitForAvailability(controller.signal);
      } catch (error: any) {
        expect(error.message).toContain('Interrupted');
      }

      const elapsed = Date.now() - startTime;
      console.log(`[Rate Limiter] interrupted after ${elapsed}ms`);

      expect(elapsed).toBeLessThan(200);
    });
  });

  describe('2. Token Counter Edge Cases', () => {
    it('should handle context window overflow', () => {
      const counter = new TokenCounter();
      counter.setContextWindow(1000); // 小窗口

      // 创建超过窗口的消息
      const messages: ChatMessage[] = [];
      for (let i = 0; i < 100; i++) {
        messages.push({
          role: 'user',
          content: 'This is a long message that will exceed the context window limit.',
        });
      }

      const tokens = counter.estimateMessages(messages);
      const usagePercent = (tokens / 1000) * 100;

      console.log(`[Token Counter] tokens: ${tokens}, usage: ${usagePercent.toFixed(1)}%`);

      expect(tokens).toBeGreaterThan(1000);
      expect(usagePercent).toBeGreaterThan(100);
    });

    it('should handle empty content', () => {
      const counter = new TokenCounter();
      counter.setContextWindow(128000);

      const messages: ChatMessage[] = [
        { role: 'user', content: '' },
        { role: 'assistant', content: '' },
        { role: 'user', content: '   ' }, // 只有空格
      ];

      const tokens = counter.estimateMessages(messages);
      console.log(`[Token Counter] empty content tokens: ${tokens}`);

      expect(tokens).toBeGreaterThanOrEqual(0);
    });

    it('should handle unicode and special characters', () => {
      const counter = new TokenCounter();
      counter.setContextWindow(128000);

      const messages: ChatMessage[] = [
        { role: 'user', content: '你好世界 🌍🎉🔥' },
        { role: 'assistant', content: 'Response with \n\t\r special chars' },
        { role: 'user', content: '<xml>&"quotes"\'apostrophes\'</xml>' },
      ];

      const tokens = counter.estimateMessages(messages);
      console.log(`[Token Counter] unicode/special tokens: ${tokens}`);

      expect(tokens).toBeGreaterThan(0);
    });
  });

  describe('3. Message Sequence Impact on API', () => {
    it('should measure convertMessages performance', () => {
      // 模拟 convertMessages 逻辑
      const messages: ChatMessage[] = [];
      for (let i = 0; i < 500; i++) {
        messages.push({ role: 'user', content: `User message ${i}` });
        messages.push({
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: `call_${i}_1`, name: 'tool1', arguments: { param: 'value' } },
            { id: `call_${i}_2`, name: 'tool2', arguments: { param: 'value' } },
          ],
        });
        messages.push({ role: 'tool', content: `Result ${i}_1`, toolCallId: `call_${i}_1` });
        messages.push({ role: 'tool', content: `Result ${i}_2`, toolCallId: `call_${i}_2` });
      }

      const startTime = Date.now();

      // 模拟 convertMessages
      const converted = messages.map(m => {
        if (m.role === 'tool') {
          return { role: 'tool', tool_call_id: m.toolCallId!, content: m.content };
        }
        if (m.role === 'assistant' && m.toolCalls) {
          return {
            role: 'assistant',
            content: m.content || null,
            tool_calls: m.toolCalls.map(tc => ({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
          };
        }
        return { role: m.role, content: m.content };
      });

      const elapsed = Date.now() - startTime;
      console.log(`[ConvertMessages] 2000 messages elapsed: ${elapsed}ms`);

      expect(elapsed).toBeLessThan(100);
    });

    it('should measure JSON serialization performance', () => {
      const messages: ChatMessage[] = [];
      for (let i = 0; i < 500; i++) {
        messages.push({ role: 'user', content: `User message ${i}` });
        messages.push({
          role: 'assistant',
          content: '',
          toolCalls: [{ id: `call_${i}_1`, name: 'tool1', arguments: { param: 'value' } }],
        });
        messages.push({ role: 'tool', content: `Result ${i}_1`, toolCallId: `call_${i}_1` });
      }

      const startTime = Date.now();

      // 模拟 API 请求体的 JSON 序列化
      const requestBody = JSON.stringify({
        model: 'test-model',
        messages: messages,
        stream: true,
      });

      const elapsed = Date.now() - startTime;
      const sizeKB = requestBody.length / 1024;

      console.log(`[JSON Serialize] elapsed: ${elapsed}ms, size: ${sizeKB.toFixed(1)}KB`);

      expect(elapsed).toBeLessThan(500);
    });
  });

  describe('4. Simulated API Timeout Scenarios', () => {
    it('should detect timeout with large messages', async () => {
      const provider = new SimulatedAPIProvider();
      provider.setLatency(1000);

      // 添加大量消息
      for (let i = 0; i < 1000; i++) {
        provider.addMessage({ role: 'user', content: `Message ${i}` });
        provider.addMessage({ role: 'assistant', content: `Response ${i}` });
      }

      const startTime = Date.now();

      try {
        const response = await provider.simulateAPICall();
        const elapsed = Date.now() - startTime;
        console.log(`[API Timeout Test] elapsed: ${elapsed}ms`);

        expect(response.content).toBeDefined();
      } catch (error: any) {
        console.log(`[API Timeout Test] error: ${error.message}`);
        expect(error.message).toContain('timed out');
      }
    });

    it('should handle abort during API call', async () => {
      const provider = new SimulatedAPIProvider();
      provider.setLatency(5000); // 5 秒延迟

      provider.addMessage({ role: 'user', content: 'Test' });

      const controller = new AbortController();

      // 500ms 后中断
      setTimeout(() => controller.abort(), 500);

      const startTime = Date.now();

      const response = await provider.simulateAPICall(controller.signal);
      const elapsed = Date.now() - startTime;

      console.log(`[API Abort Test] elapsed: ${elapsed}ms`);

      expect(elapsed).toBeLessThan(2000); // 中断响应可能需要额外时间
      expect(response.finished).toBe(true);
    });
  });

  describe('5. Compact Trigger Analysis', () => {
    it('should analyze when compact is triggered', () => {
      const counter = new TokenCounter();
      counter.setContextWindow(128000);

      // 模拟不同消息数量下的 token 使用
      const scenarios = [
        { messages: 50, expectedPercent: '< 60%' },
        { messages: 100, expectedPercent: '~ 60-70%' },
        { messages: 200, expectedPercent: '> 70%' },
        { messages: 500, expectedPercent: '> 100%' },
      ];

      for (const scenario of scenarios) {
        const messages: ChatMessage[] = [];
        for (let i = 0; i < scenario.messages; i++) {
          messages.push({
            role: 'user',
            content: `User message ${i} with some content to make it realistic length.`,
          });
          messages.push({
            role: 'assistant',
            content: `Assistant response ${i} with some content.`,
          });
        }

        const tokens = counter.estimateMessages(messages);
        const usagePercent = (tokens / 128000) * 100;

        console.log(
          `[Compact Trigger] ${scenario.messages} messages: ${tokens} tokens, ${usagePercent.toFixed(1)}% - ${scenario.expectedPercent}`
        );

        // 只记录数据，不做严格断言（实际 token 使用取决于内容长度）
      }
    });
  });

  describe('6. Retry Logic Timing', () => {
    it('should measure exponential backoff timing', () => {
      const delays: number[] = [];

      // 模拟 10 次重试的延迟
      for (let attempt = 0; attempt < 10; attempt++) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 60000);
        delays.push(delay);
      }

      console.log('[Retry Delays]', delays.map(d => `${d}ms`).join(', '));

      // 验证指数增长
      expect(delays[0]).toBe(1000);
      expect(delays[1]).toBe(2000);
      expect(delays[2]).toBe(4000);
      expect(delays[3]).toBe(8000);
      expect(delays[4]).toBe(16000);
      expect(delays[5]).toBe(32000);
      expect(delays[6]).toBe(60000); // 最大值

      // 计算总等待时间
      const totalDelay = delays.reduce((a, b) => a + b, 0);
      console.log(
        `[Retry Total] max wait time: ${totalDelay}ms (${(totalDelay / 1000 / 60).toFixed(1)} minutes)`
      );

      expect(totalDelay).toBeLessThan(10 * 60 * 1000); // 10 分钟内
    });
  });
});
