/**
 * ScrollbackBuffer - 终端历史缓冲区
 *
 * 用于保存终端输出历史，在resize后可以重新渲染
 * 限制最大行数，防止内存溢出
 */

export class ScrollbackBuffer {
  private buffer: string[] = [];
  private maxLines: number;
  // 上一次 append 的文本是否以 \n 结尾
  // true  → 下一个 chunk 开启新行（独立 appendScroll 调用）
  // false → 下一个 chunk 追加到当前行（流式输出续写）
  private lastEndedWithNewline: boolean = true;

  constructor(maxLines: number = 500) {
    this.maxLines = maxLines;
  }

  /**
   * 添加文本到缓冲区
   *
   * 关键设计：
   * - 独立调用（appendScroll）通常以 \n 结尾 → lastEndedWithNewline=true
   * - 流式 chunk（appendStreamChunk）通常不以 \n 结尾 → 追加到上一行
   * - resize 重放时每行一个 \n，所以 buffer 必须按逻辑行存储
   */
  append(text: string): void {
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (i === 0 && !this.lastEndedWithNewline && this.buffer.length > 0) {
        // 续写到上一行末尾（流式 chunk 续写）
        this.buffer[this.buffer.length - 1] += lines[i];
      } else {
        this.buffer.push(lines[i]);
      }
      while (this.buffer.length > this.maxLines) {
        this.buffer.shift();
      }
    }

    this.lastEndedWithNewline = text.endsWith('\n');
  }

  /**
   * 获取所有行
   */
  getLines(): string[] {
    return [...this.buffer];
  }

  /**
   * 获取最后N行
   */
  getLastNLines(n: number): string[] {
    if (n <= 0) return [];
    return this.buffer.slice(-n);
  }

  /**
   * 获取总行数
   */
  getLineCount(): number {
    return this.buffer.length;
  }

  /**
   * 清空缓冲区
   */
  clear(): void {
    this.buffer = [];
  }

  /**
   * 设置最大行数
   */
  setMaxLines(max: number): void {
    this.maxLines = max;
    // 如果当前超过新限制，删除多余的行
    while (this.buffer.length > this.maxLines) {
      this.buffer.shift();
    }
  }
}

// 单例模式，方便在screenManager中使用
let scrollbackInstance: ScrollbackBuffer | null = null;

export function getScrollbackBuffer(maxLines: number = 500): ScrollbackBuffer {
  if (!scrollbackInstance) {
    scrollbackInstance = new ScrollbackBuffer(maxLines);
  }
  return scrollbackInstance;
}
