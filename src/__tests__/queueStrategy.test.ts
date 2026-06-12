/**
 * Queue 策略测试 - 检测当前实现的问题
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InputQueue, getInputQueue, clearInputQueue } from '../cli/ui/queue';
import { autoDrainQueue } from '../cli/queueDrain';

describe('Queue Strategy Tests', () => {
  let queue: InputQueue;

  beforeEach(() => {
    clearInputQueue();
    queue = getInputQueue();
  });

  describe('1. 合并策略问题', () => {
    it('should merge multiple inputs with separator', () => {
      queue.add('fix bug A');
      queue.add('add feature B');
      queue.add('refactor C');

      const merged = queue.mergePending();

      console.log('[Merge] result:', merged);

      // 改进：使用分隔符区分不同任务
      expect(merged).toBe('fix bug A\n\n---\n\nadd feature B\n\n---\n\nrefactor C');

      // LLM 可以更清晰地理解这是三个独立任务
    });

    it('should handle conflicting inputs with separator', () => {
      queue.add('use TypeScript');
      queue.add('use JavaScript'); // 冲突的指令

      const merged = queue.mergePending();

      console.log('[Merge] conflicting:', merged);

      // 改进：分隔符让 LLM 更容易识别冲突
      expect(merged).toBe('use TypeScript\n\n---\n\nuse JavaScript');
    });

    it('should handle long inputs', () => {
      // 添加长输入
      for (let i = 0; i < 10; i++) {
        queue.add(`Long input ${i}: ${'A'.repeat(100)}`);
      }

      const merged = queue.mergePending();
      const mergedLength = merged.length;

      console.log('[Merge] long inputs length:', mergedLength);

      // 问题：合并后的输入可能很长
      expect(mergedLength).toBeGreaterThan(1000);
    });
  });

  describe('2. 队列大小限制', () => {
    it('should silently drop old inputs when exceeding maxSize', () => {
      // 添加超过 maxSize (50) 的输入
      for (let i = 0; i < 60; i++) {
        queue.add(`Input ${i}`);
      }

      const status = queue.getStatus();

      console.log('[Queue] total:', status.total, 'pending:', status.pending);

      // 问题：最早的 10 个输入被静默丢弃
      expect(status.total).toBe(50);
      expect(status.pending).toBe(50);

      // 用户不知道输入被丢弃了
    });
  });

  describe('3. processed 标记不清理', () => {
    it('should keep processed inputs in memory', () => {
      queue.add('Input 1');
      queue.add('Input 2');

      queue.mergePending(); // 标记为 processed

      const status = queue.getStatus();

      console.log('[Queue] after merge - total:', status.total, 'processed:', status.processed);

      // 问题：processed 的输入仍然在队列中
      expect(status.total).toBe(2);
      expect(status.processed).toBe(2);
      expect(status.pending).toBe(0);

      // 内存不释放
    });

    it('should accumulate processed inputs over time', () => {
      // 模拟多次使用
      for (let round = 0; round < 10; round++) {
        for (let i = 0; i < 5; i++) {
          queue.add(`Round ${round} Input ${i}`);
        }
        queue.mergePending();
      }

      const status = queue.getStatus();

      console.log('[Queue] accumulated - total:', status.total, 'processed:', status.processed);

      // 问题：队列会越来越大
      expect(status.total).toBe(50); // maxSize 限制
      expect(status.processed).toBe(50);
    });
  });

  describe('4. autoDrainQueue 递归风险', () => {
    it('should handle recursive drain correctly', async () => {
      const handlerCalls: string[] = [];

      const handler = async (merged: string) => {
        handlerCalls.push(merged);

        // 模拟 handler 执行期间添加新输入
        if (handlerCalls.length < 3) {
          queue.add(`New input during handler ${handlerCalls.length}`);
        }
      };

      queue.add('Initial input');

      await autoDrainQueue(queue, handler);

      console.log('[Drain] handler calls:', handlerCalls);

      // 递归处理了所有输入
      expect(handlerCalls.length).toBeGreaterThan(1);
    });

    it('should not infinite loop', async () => {
      const handlerCalls: number[] = [];
      const maxCalls = 5; // 限制最大调用次数

      const handler = async (_merged: string) => {
        handlerCalls.push(handlerCalls.length);

        // 模拟每次都添加新输入（潜在无限循环）
        if (handlerCalls.length < maxCalls) {
          queue.add(`Always add new ${handlerCalls.length}`);
        }
      };

      queue.add('Start');

      // 设置超时保护
      const timeoutPromise = new Promise<void>(resolve => {
        setTimeout(() => {
          console.log('[Drain] timeout protection triggered');
          resolve();
        }, 2000);
      });

      const drainPromise = autoDrainQueue(queue, handler);

      await Promise.race([drainPromise, timeoutPromise]);

      console.log('[Drain] potential infinite loop:', handlerCalls.length);

      // 应该在某个点停止
      expect(handlerCalls.length).toBeLessThan(10);
    });
  });

  describe('5. 输入顺序问题', () => {
    it('should preserve input order with separator', () => {
      queue.add('First');
      queue.add('Second');
      queue.add('Third');

      const merged = queue.mergePending();

      console.log('[Queue] order:', merged);

      expect(merged).toBe('First\n\n---\n\nSecond\n\n---\n\nThird');
    });

    it('should handle undo correctly', () => {
      queue.add('Input 1');
      queue.add('Input 2');
      queue.add('Input 3');

      const undone = queue.undoLast();

      console.log('[Queue] undone:', undone?.content);

      expect(undone?.content).toBe('Input 3');

      const merged = queue.mergePending();
      expect(merged).toBe('Input 1\n\n---\n\nInput 2');
    });
  });

  describe('6. 建议改进测试', () => {
    it('should suggest separator between tasks', () => {
      // 建议：使用明确的分隔符
      queue.add('Task 1: fix bug');
      queue.add('---'); // 用户可以添加分隔符
      queue.add('Task 2: add feature');

      const merged = queue.mergePending();

      console.log('[Suggest] with separator:', merged);

      // 更清晰的语义
    });

    it('should suggest clearing processed inputs', () => {
      queue.add('Input 1');
      queue.mergePending();

      // 建议：清理 processed 输入
      const cleared = queue.clearPending();

      console.log('[Suggest] cleared:', cleared);

      // 但 clearPending 只清理 pending，不清理 processed
      expect(queue.getStatus().processed).toBe(1);
    });
  });
});
