/**
 * 测试中断竞态问题
 *
 * 问题：ESC ESC 中断时，在 runLoop 还没完全退出之前就设置 isProcessing = false，
 * 导致用户可以立即输入新内容并触发新的 handleInput，
 * 而旧的 runLoop 还在运行（interrupt 只设置标志，runLoop 需要时间退出）。
 *
 * 关键点：interrupt() 只是设置 interruptFlag = true，runLoop 需要检查标志才能退出。
 * 如果 runLoop 正在等待 LLM 响应（可能需要几秒），它还没检查 interruptFlag。
 * 此时如果 isProcessing = false，用户输入新内容会立即开始新的 runLoop。
 *
 * 修复：中断处理不修改 isProcessing，让 handleInput 自己在 runLoop 结束后处理。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// 模拟 Agent（更真实地模拟 LLM 响应延迟）
class MockAgent extends EventEmitter {
  private interruptFlag = false;
  private running = false;
  private llmCallInProgress = false;

  interrupt() {
    this.interruptFlag = true;
    // 如果正在等待 LLM，需要时间才能检测到中断
  }

  async runLoop(input: string): Promise<string> {
    this.running = true;
    this.interruptFlag = false;
    this.emit('waiting_for_llm');

    // 模拟等待 LLM 响应（这个过程中 interruptFlag 可能还没被检查）
    this.llmCallInProgress = true;

    // 模拟 LLM 调用需要时间（比如 5 秒）
    // 在这个过程中，如果用户中断，interruptFlag 会设置，但 runLoop 还没检查
    await new Promise(r => setTimeout(r, 100)); // 简化测试用 100ms

    // 检查中断标志
    if (this.interruptFlag) {
      this.emit('stream', { chunk: '[INTERRUPTED]' });
      this.llmCallInProgress = false;
      this.running = false;
      return 'interrupted';
    }

    this.llmCallInProgress = false;
    this.emit('stream', { chunk: '[DONE]' });
    this.running = false;
    return 'done';
  }

  isRunning() {
    return this.running;
  }

  isLLMCallInProgress() {
    return this.llmCallInProgress;
  }
}

describe('中断竞态测试', () => {
  it('修复后：中断时不设置 isProcessing=false，防止竞态', async () => {
    const agent = new MockAgent();
    let isProcessing = false;
    let concurrentRunLoops = 0;
    let maxConcurrentRunLoops = 0;

    // 监控同时运行的 runLoop 数量
    agent.on('waiting_for_llm', () => {
      concurrentRunLoops++;
      maxConcurrentRunLoops = Math.max(maxConcurrentRunLoops, concurrentRunLoops);
    });

    const onRunLoopEnd = () => {
      concurrentRunLoops--;
    };

    // 模拟 handleInput
    const handleInput = async (input: string) => {
      if (isProcessing) {
        console.log('[QUEUE] Input should be queued:', input);
        return 'queued';
      }

      isProcessing = true;
      console.log('[START] handleInput:', input);

      try {
        const result = await agent.runLoop(input);
        onRunLoopEnd();
        console.log('[END] runLoop:', input, 'result:', result);
        return result;
      } catch (e) {
        onRunLoopEnd();
        console.log('[ERR] runLoop:', input);
        return 'error';
      } finally {
        isProcessing = false;
      }
    };

    // 中断处理（修复后的版本）
    const handleInterruptFixed = () => {
      agent.interrupt();
      // 关键修复：不设置 isProcessing = false！
      console.log('[INTERRUPT] Agent interrupted, isProcessing =', isProcessing);
    };

    console.log('\n=== 测试：修复后版本 ===');

    // 1. 开始处理 task 1
    const promise1 = handleInput('task 1');
    console.log('isProcessing after start:', isProcessing);

    // 2. 在 runLoop 等待 LLM 响应期间（还没检查 interruptFlag），用户中断
    await new Promise(r => setTimeout(r, 10)); // runLoop 正在"调用 LLM"
    console.log('LLM call in progress:', agent.isLLMCallInProgress());

    // 3. 用户按下 ESC ESC
    handleInterruptFixed();
    console.log('isProcessing after interrupt:', isProcessing);

    // 4. 用户立即输入新内容（在 runLoop 还没退出之前）
    // 因为 isProcessing 还是 true，这个输入应该被队列化
    const result2 = await handleInput('task 2');
    console.log('task 2 result:', result2);

    // 5. 等待 task 1 完成
    const result1 = await promise1;
    console.log('task 1 result:', result1);

    console.log('\n=== 结果 ===');
    console.log('最大并发 runLoop 数:', maxConcurrentRunLoops);
    console.log('task 1 结果:', result1);
    console.log('task 2 结果:', result2);

    // 验证：task 2 应该被队列化（因为 isProcessing 还是 true）
    expect(result2).toBe('queued');
    expect(maxConcurrentRunLoops).toBe(1); // 只有一个 runLoop 同时运行
  });

  it('修复前：中断时设置 isProcessing=false，导致竞态', async () => {
    const agent = new MockAgent();
    let isProcessing = false;
    let concurrentRunLoops = 0;
    let maxConcurrentRunLoops = 0;

    // 监控同时运行的 runLoop 数量
    agent.on('waiting_for_llm', () => {
      concurrentRunLoops++;
      maxConcurrentRunLoops = Math.max(maxConcurrentRunLoops, concurrentRunLoops);
    });

    const onRunLoopEnd = () => {
      concurrentRunLoops--;
    };

    // 模拟 handleInput
    const handleInput = async (input: string) => {
      if (isProcessing) {
        console.log('[QUEUE] Input queued:', input);
        return 'queued';
      }

      isProcessing = true;
      console.log('[START] handleInput:', input);

      try {
        const result = await agent.runLoop(input);
        onRunLoopEnd();
        console.log('[END] runLoop:', input, 'result:', result);
        return result;
      } catch (e) {
        onRunLoopEnd();
        return 'error';
      } finally {
        isProcessing = false;
      }
    };

    // 中断处理（修复前的版本 - 有问题）
    const handleInterruptOld = () => {
      agent.interrupt();
      isProcessing = false; // 问题：立即设置为 false！
      console.log('[INTERRUPT] Agent interrupted, isProcessing =', isProcessing);
    };

    console.log('\n=== 测试：修复前版本（有问题） ===');

    // 1. 开始处理 task 1
    const promise1 = handleInput('task 1');
    console.log('isProcessing after start:', isProcessing);

    // 2. 在 runLoop 等待 LLM 响应期间，用户中断
    await new Promise(r => setTimeout(r, 10));
    console.log('LLM call in progress:', agent.isLLMCallInProgress());

    // 3. 用户按下 ESC ESC（修复前的版本）
    handleInterruptOld();
    console.log('isProcessing after interrupt:', isProcessing);

    // 4. 用户立即输入新内容
    // 因为 isProcessing = false（被中断处理设置），这个输入会立即开始处理！
    // 而此时 task 1 的 runLoop 还在运行（只是设置了 interruptFlag，还没退出）
    const promise2 = handleInput('task 2');
    console.log('task 2 started, isProcessing:', isProcessing);

    // 5. 等待所有完成
    const result1 = await promise1;
    const result2 = await promise2;

    console.log('\n=== 结果 ===');
    console.log('最大并发 runLoop 数:', maxConcurrentRunLoops);
    console.log('task 1 结果:', result1);
    console.log('task 2 结果:', result2);

    // 验证：修复前会有两个 runLoop 同时运行！
    expect(maxConcurrentRunLoops).toBe(2); // 两个 runLoop 同时运行！
    // result1 可能是 done 或 interrupted（取决于 mock 的时序）
    // 关键是验证有两个 runLoop 同时运行
    expect(['interrupted', 'done']).toContain(result1);
    expect(result2).toBe('done');
  });
});
