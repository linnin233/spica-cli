/**
 * 测试ESC ESC中断的实际行为
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TUIInputHandler } from '../cli/ui/tuiInput';

describe('ESC ESC 中断行为测试', () => {
  let handler: TUIInputHandler;

  beforeEach(() => {
    handler = new TUIInputHandler();
    vi.useFakeTimers();
  });

  it('应该在500ms内双击ESC触发中断', () => {
    // 第一次ESC
    const result1 = handler.handleStdin('\x1b', false);
    expect(result1.isInterrupt).toBe(false);

    // 立即第二次ESC（在500ms内）
    const result2 = handler.handleStdin('\x1b', false);
    expect(result2.isInterrupt).toBe(true);
  });

  it('超过500ms的ESC不应触发中断', () => {
    // 第一次ESC
    const result1 = handler.handleStdin('\x1b', false);
    expect(result1.isInterrupt).toBe(false);

    // 等待超过500ms
    vi.advanceTimersByTime(600);

    // 第二次ESC
    const result2 = handler.handleStdin('\x1b', false);
    expect(result2.isInterrupt).toBe(false);
  });

  it('Ctrl+C应该立即触发中断', () => {
    const result = handler.handleStdin('\x03', false);
    expect(result.isInterrupt).toBe(true);
  });

  it('permission dialog活跃时不应触发中断', () => {
    // 即使双击ESC
    const result1 = handler.handleStdin('\x1b', true);
    expect(result1.isInterrupt).toBe(false);

    const result2 = handler.handleStdin('\x1b', true);
    expect(result2.isInterrupt).toBe(false);
  });
});
