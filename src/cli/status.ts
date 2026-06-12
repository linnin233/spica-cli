// 状态显示

import { COLORS } from './ui/colors';
import { getInputQueue } from './ui/queue';
import { getRuntimeState } from '../core/RuntimeState';

export function displayStatusLine(): void {
  const state = getRuntimeState();
  const queue = getInputQueue();
  const queueStatus = queue.getStatus();

  const parts: string[] = [];

  if (state.model) {
    parts.push(state.model);
  }

  if (state.isProcessing()) {
    parts.push(COLORS.warning('processing'));
  }

  if (queueStatus.pending > 0) {
    parts.push(COLORS.primary(`queue: ${queueStatus.pending}`));
  }

  const statusLine = parts.join(' | ');
  console.log(COLORS.muted(statusLine));
}

// 全局状态栏更新函数（用于 TUI 模式）
let _updateStatusBarFn: (() => void) | null = null;

export function setUpdateStatusBarFn(fn: (() => void) | null): void {
  _updateStatusBarFn = fn;
}

export function updateStatusBar(): void {
  if (_updateStatusBarFn) {
    _updateStatusBarFn();
  }
}
