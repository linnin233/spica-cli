// 输入队列 - 管理用户输入，支持非阻塞输入和撤回

export interface QueuedInput {
  id: number;
  content: string;
  timestamp: Date;
  processed: boolean;
}

export interface QueueEvent {
  type: 'dropped' | 'merged' | 'cleared';
  count: number;
  items?: QueuedInput[];
}

export class InputQueue {
  private queue: QueuedInput[] = [];
  private nextId: number = 1;
  private maxSize: number = 50;
  private eventListeners: ((event: QueueEvent) => void)[] = [];

  // 添加事件监听器
  onEvent(listener: (event: QueueEvent) => void): void {
    this.eventListeners.push(listener);
  }

  // 移除事件监听器
  removeEventListener(listener: (event: QueueEvent) => void): void {
    const index = this.eventListeners.indexOf(listener);
    if (index !== -1) {
      this.eventListeners.splice(index, 1);
    }
  }

  // 发送事件
  private emitEvent(event: QueueEvent): void {
    this.eventListeners.forEach(listener => listener(event));
  }

  // 添加输入到队列
  add(content: string): QueuedInput {
    const input: QueuedInput = {
      id: this.nextId++,
      content: content.trim(),
      timestamp: new Date(),
      processed: false,
    };

    this.queue.push(input);

    // 限制队列大小，发送丢弃警告
    if (this.queue.length > this.maxSize) {
      const dropped = this.queue.shift();
      if (dropped) {
        this.emitEvent({ type: 'dropped', count: 1, items: [dropped] });
      }
    }

    return input;
  }

  // 获取所有未处理的输入
  getPending(): QueuedInput[] {
    return this.queue.filter(i => !i.processed);
  }

  // 合并所有未处理的输入为一个指令（使用分隔符）
  mergePending(): string {
    const pending = this.getPending();
    if (pending.length === 0) return '';

    // 标记为已处理
    pending.forEach(i => (i.processed = true));

    // 发送合并事件
    this.emitEvent({ type: 'merged', count: pending.length, items: pending });

    // 合并内容：使用分隔符区分不同任务
    if (pending.length === 1) {
      return pending[0].content;
    }

    // 多个输入时，使用分隔符
    return pending.map(i => i.content).join('\n\n---\n\n');
  }

  // 查看待处理内容但不标记为已处理（用于 agent 注入队列时 peek）
  // agent 在 LLM 成功处理后调用 mergePending() 消费
  peekPendingContent(): string | null {
    const pending = this.getPending();
    if (pending.length === 0) return null;

    if (pending.length === 1) {
      return pending[0].content;
    }
    return pending.map(i => i.content).join('\n\n---\n\n');
  }

  // 撤回最后一个未处理的输入
  undoLast(): QueuedInput | null {
    const pending = this.getPending();
    if (pending.length === 0) return null;

    const last = pending[pending.length - 1];
    const index = this.queue.indexOf(last);
    if (index !== -1) {
      this.queue.splice(index, 1);
    }
    return last;
  }

  // 撤回指定 ID 的输入
  undoById(id: number): QueuedInput | null {
    const input = this.queue.find(i => i.id === id && !i.processed);
    if (input) {
      const index = this.queue.indexOf(input);
      if (index !== -1) {
        this.queue.splice(index, 1);
      }
      return input;
    }
    return null;
  }

  // 清空所有未处理的输入
  clearPending(): number {
    const count = this.getPending().length;
    this.queue = this.queue.filter(i => i.processed);
    return count;
  }

  // 清理已处理的输入（防止内存泄漏）
  clearProcessed(): number {
    const count = this.queue.filter(i => i.processed).length;
    this.queue = this.queue.filter(i => !i.processed);

    if (count > 0) {
      this.emitEvent({ type: 'cleared', count });
    }

    return count;
  }

  // 自动清理：当 processed 数量超过阈值时自动清理
  autoCleanup(threshold: number = 20): number {
    const processedCount = this.queue.filter(i => i.processed).length;
    if (processedCount > threshold) {
      return this.clearProcessed();
    }
    return 0;
  }

  // 获取队列状态
  getStatus(): {
    total: number;
    pending: number;
    processed: number;
    pendingPreview: string[];
    droppedWarning: boolean;
  } {
    const pending = this.getPending();
    const processed = this.queue.filter(i => i.processed).length;
    return {
      total: this.queue.length,
      pending: pending.length,
      processed: processed,
      pendingPreview: pending
        .slice(-5)
        .map(i => (i.content.length > 30 ? i.content.slice(0, 30) + '...' : i.content)),
      droppedWarning: this.queue.length >= this.maxSize - 5, // 接近上限时警告
    };
  }

  // 是否有未处理的输入
  hasPending(): boolean {
    return this.getPending().length > 0;
  }

  // 获取队列长度
  length(): number {
    return this.queue.length;
  }

  // 获取丢弃的输入数量（用于显示警告）
  getDroppedCount(): number {
    // 通过 nextId 和当前队列长度计算
    return Math.max(0, this.nextId - 1 - this.queue.length);
  }
}

// 全局输入队列实例
let globalQueue: InputQueue | null = null;

export function getInputQueue(): InputQueue {
  if (!globalQueue) {
    globalQueue = new InputQueue();
  }
  return globalQueue;
}

export function clearInputQueue(): void {
  globalQueue = null;
}
