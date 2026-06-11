import { isFullWidth } from './stringWidth';
import { COLORS } from './colors';
import { getScrollbackBuffer, ScrollbackBuffer } from './scrollbackBuffer';
import { renderMarkdownTables } from './tableRenderer';

const ESC = '\x1b';

function writeStdout(text: string): void {
  process.stdout.write(text);
}

export interface ScreenState {
  inputBuffer: string[];
  cursorCol: number;
  terminalHeight: number;
  terminalWidth: number;
  inputLines: number;
  statusRow: number;
  scrollBottom: number;
  statusText: string;
  completer: ((line: string) => string[]) | null;
  shownCompletionList: boolean;
  lastCompletionLine: string;
  cursorInScrollArea: boolean;
  isStreaming: boolean;
  onVerboseToggle?: () => void;
  // 缓冲的输入，用于流式输出结束后刷新
  pendingInputRefresh: boolean;
  // 历史缓冲区（用于resize后重绘）
  scrollbackBuffer: ScrollbackBuffer;
}

export class ScreenManager {
  state: ScreenState;
  // 输出缓冲（用于行缓冲输出）
  private outputBuffer: string = '';
  // Thinking动画状态
  private thinkingAnimationFrame: number = 0;
  private thinkingAnimationTimer: NodeJS.Timeout | null = null;
  private thinkingAnimationStopped: boolean = false;
  private thinkingAnimationFrames: string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  constructor() {
    const height = process.stdout.rows || 24;
    const width = process.stdout.columns || 80;

    this.state = {
      inputBuffer: [''],
      cursorCol: 0,
      terminalHeight: height,
      terminalWidth: width,
      inputLines: 1,
      statusRow: height - 2,
      scrollBottom: height - 3,
      statusText: '',
      completer: null,
      shownCompletionList: false,
      lastCompletionLine: '',
      cursorInScrollArea: false,
      isStreaming: false,
      onVerboseToggle: undefined,
      pendingInputRefresh: false,
      scrollbackBuffer: getScrollbackBuffer(3000),
    };

    // 监听终端 resize
    process.stdout.on('resize', () => {
      this.handleResize();
    });
  }

  private handleResize(): void {
    const newHeight = process.stdout.rows || 24;
    const newWidth = process.stdout.columns || 80;

    this.state.terminalHeight = newHeight;
    this.state.terminalWidth = newWidth;
    this.state.inputLines = this.calcInputLines();
    this.state.statusRow = this.state.terminalHeight - this.state.inputLines - 1;
    this.state.scrollBottom = this.state.statusRow - 1;

    // Clear and set new scroll region
    writeStdout(`${ESC}[2J${ESC}[H`);
    writeStdout(`${ESC}[1;${this.state.scrollBottom}r`);

    // Redraw: show all available history, capped to avoid flicker on huge buffers
    const allLines = this.state.scrollbackBuffer.getLines();
    const visibleLines = this.state.scrollBottom;
    // Never show fewer than visible area; prefer up to 3× visible to give context
    const showCount = Math.min(allLines.length, Math.max(visibleLines, visibleLines * 3));
    const historyLines = allLines.slice(-showCount);

    for (const line of historyLines) {
      writeStdout(line + '\n');
    }

    this.drawStatus();
    this.refreshInput();
    this.restoreCursor();
  }

  private getCharDisplayWidth(char: string): number {
    if (char === '\n') return 0;
    if (char === '\t') return 8;
    const codePoint = char.codePointAt(0);
    if (!codePoint) return 1;

    // Control characters (C0: 0-31, DEL: 127, C1: 128-159) have zero width
    if (codePoint < 32 || codePoint === 127 || (codePoint >= 128 && codePoint <= 159)) return 0;

    // Emoji 和其他复杂 grapheme cluster 宽度为 2
    if (char.length > 1 || codePoint > 0xFFFF) return 2;

    if (isFullWidth(char)) return 2;
    return 1;
  }

  private getStringDisplayWidth(str: string): number {
    let width = 0;
    const graphemes = str.match(/\P{M}\p{M}*/gu) || [];
    for (const char of graphemes) {
      width += this.getCharDisplayWidth(char);
    }
    return width;
  }

  private calcInputLines(): number {
    const content = this.state.inputBuffer[0];
    const width = this.state.terminalWidth;

    const logicalLines = content.split('\n');
    let totalLines = 0;

    for (let i = 0; i < logicalLines.length; i++) {
      const line = logicalLines[i];
      const prefixWidth = i === 0 ? 2 : 0;
      const lineWidth = prefixWidth + this.getStringDisplayWidth(line);
      totalLines += Math.max(1, Math.ceil(lineWidth / width));
    }

    return totalLines;
  }

  private updateLayout(): void {
    const newLines = this.calcInputLines();
    if (newLines !== this.state.inputLines) {
      const oldStatusRow = this.state.statusRow;
      const oldScrollBottom = this.state.scrollBottom;
      this.state.inputLines = newLines;
      this.state.statusRow = this.state.terminalHeight - newLines - 1;
      this.state.scrollBottom = this.state.statusRow - 1;

      if (oldStatusRow > this.state.statusRow) {
        for (let row = this.state.statusRow + 1; row <= oldStatusRow; row++) {
          writeStdout(`${ESC}[${row};1H${ESC}[2K`);
        }
      } else if (oldStatusRow < this.state.statusRow) {
        for (let row = oldScrollBottom + 1; row <= this.state.scrollBottom; row++) {
          writeStdout(`${ESC}[${row};1H${ESC}[2K`);
        }
      }

      writeStdout(`${ESC}[1;${this.state.scrollBottom}r`);
      this.drawStatus();
    }
  }

  setStreaming(streaming: boolean): void {
    this.state.isStreaming = streaming;
    if (!streaming) {
      // 流式结束，刷新剩余的流式缓冲
      this.flushStreamBuffer();

      // 流式输出结束后，如果有待刷新的输入，刷新输入框
      if (this.state.pendingInputRefresh) {
        this.state.pendingInputRefresh = false;
        this.state.cursorInScrollArea = false;
        this.refreshInput();
        this.restoreCursor();
      } else {
        this.state.cursorInScrollArea = false;
      }
    }
  }

  start(): void {
    writeStdout(`${ESC}[1;${this.state.scrollBottom}r`);
    writeStdout(`${ESC}[2J${ESC}[1;1H`);
    this.drawStatus();
    this.refreshInput();
    this.restoreCursor();
  }

  end(): void {
    writeStdout(`${ESC}[r${ESC}[2J${ESC}[1;1H`);
  }

  // 直接输出（用于工具调用、thinking等非流式内容）
  appendScroll(text: string): void {
    // 保存原始文本到历史缓冲区
    this.state.scrollbackBuffer.append(text);

    // 渲染 markdown 表格为 ANSI 对齐列
    const displayText = renderMarkdownTables(text);

    // 直接输出
    if (!this.state.cursorInScrollArea) {
      writeStdout(`${ESC}[?25l`);
      writeStdout(`${ESC}[${this.state.scrollBottom};1H`);
      this.state.cursorInScrollArea = true;
    }
    writeStdout(displayText);

    // 如果有换行符，刷新输入框
    if (text.includes('\n')) {
      this.refreshInputDuringStreaming();
    }
  }

  // 行缓冲输出（用于AI流式输出）
  private streamBuffer: string = '';
  // 表格行缓冲 — 延迟输出表格行直到表格完整，以便 ANSI 对齐渲染
  private tableLineBuffer: string[] = [];

  appendStreamChunk(text: string): void {
    // 保存原始文本到历史缓冲区
    this.state.scrollbackBuffer.append(text);

    // 添加到流式缓冲
    this.streamBuffer += text;

    // 检查是否有完整行
    if (this.streamBuffer.includes('\n')) {
      const lines = this.streamBuffer.split('\n');
      // 处理所有完整行
      for (let i = 0; i < lines.length - 1; i++) {
        this.processStreamLine(lines[i]);
      }
      // 保留最后一行在缓冲中
      this.streamBuffer = lines[lines.length - 1] || '';
    }
  }

  // 表格行检测：以 | 开头且包含 |
  private isTableDataLine(line: string): boolean {
    const trimmed = line.trim();
    return /^\|.+\|/.test(trimmed);
  }

  // 分隔行检测：|---|---|
  private isTableSepLine(line: string): boolean {
    const trimmed = line.trim();
    return /^\|[\s:]*-{3,}[\s:]*\|/.test(trimmed) ||
           /^\|[\s:]*-{3,}[\s:]*[\|:]/.test(trimmed);
  }

  private processStreamLine(line: string): void {
    if (this.tableLineBuffer.length > 0) {
      // 正在缓冲表格
      if (this.isTableDataLine(line) || this.isTableSepLine(line)) {
        this.tableLineBuffer.push(line);
        return;
      }
      // 表格结束 — 渲染并输出
      this.flushTableBuffer();
    }

    // 检测表格开始：当前行是表格数据行，下一行可能是分隔行
    if (this.isTableDataLine(line)) {
      // 可能是表头，先缓冲
      this.tableLineBuffer.push(line);
      return;
    }

    // 普通行 — 直接输出
    this.writeStreamLine(line);
  }

  private flushTableBuffer(): void {
    if (this.tableLineBuffer.length === 0) return;

    const text = this.tableLineBuffer.join('\n');
    const rendered = renderMarkdownTables(text);

    for (const renderedLine of rendered.split('\n')) {
      this.writeStreamLine(renderedLine);
    }

    this.tableLineBuffer = [];
  }

  private writeStreamLine(line: string): void {
    if (!this.state.cursorInScrollArea) {
      writeStdout(`${ESC}[?25l`);
      writeStdout(`${ESC}[${this.state.scrollBottom};1H`);
      this.state.cursorInScrollArea = true;
    }
    writeStdout(line + '\n');
    this.refreshInputDuringStreaming();
  }

  // 刷新流式缓冲（流式结束时调用）
  flushStreamBuffer(): void {
    // 先刷新待处理的表格缓冲
    this.flushTableBuffer();

    if (this.streamBuffer) {
      if (!this.state.cursorInScrollArea) {
        writeStdout(`${ESC}[?25l`);
        writeStdout(`${ESC}[${this.state.scrollBottom};1H`);
        this.state.cursorInScrollArea = true;
      }
      writeStdout(this.streamBuffer + '\n');
      this.streamBuffer = '';
      this.refreshInputDuringStreaming();
    }
  }

  // 强制刷新（用于工具调用结束等）
  flushOutput(): void {
    this.refreshInputDuringStreaming();
  }

  // 流式输出期间刷新输入框（AI输出调用，刷新后返回scroll区域）
  private refreshInputDuringStreaming(): void {
    // 切换到输入框区域刷新
    this.state.cursorInScrollArea = false;
    this.refreshInput();
    this.restoreCursor();

    // 返回scroll区域继续输出
    this.state.cursorInScrollArea = true;
    writeStdout(`${ESC}[?25l`);
    writeStdout(`${ESC}[${this.state.scrollBottom};1H`);

    // 清除pending标记
    this.state.pendingInputRefresh = false;
  }

  // 用户输入时刷新输入框（光标留在输入框）
  private refreshInputForUserTyping(): void {
    this.state.cursorInScrollArea = false;
    this.refreshInput();
    this.restoreCursor();
    // 光标留在输入框，不返回scroll区域
    this.state.pendingInputRefresh = false;
  }

  // Thinking动画相关方法
  startThinkingAnimation(): void {
    // 如果已经在运行，先清除再重新启动（防止重复）
    if (this.thinkingAnimationTimer) {
      this.clearThinkingAnimation();
    }

    // 显示初始帧
    this.thinkingAnimationStopped = false;
    this.showThinkingFrame();

    // 定时更新动画帧
    this.thinkingAnimationTimer = setInterval(() => {
      this.thinkingAnimationFrame = (this.thinkingAnimationFrame + 1) % this.thinkingAnimationFrames.length;
      this.showThinkingFrame();
    }, 100);
  }

  private showThinkingFrame(): void {
    if (this.thinkingAnimationStopped) return;
    const frame = this.thinkingAnimationFrames[this.thinkingAnimationFrame];
    // 在scroll区域最后一行显示动画
    writeStdout(`${ESC}[?25l`);
    writeStdout(`${ESC}[${this.state.scrollBottom};1H`);
    writeStdout(`${ESC}[2K`); // 清除当前行
    writeStdout(COLORS.muted(frame + ' thinking'));
    this.state.cursorInScrollArea = true;
  }

  clearThinkingAnimation(): void {
    this.thinkingAnimationStopped = true;
    if (this.thinkingAnimationTimer) {
      clearInterval(this.thinkingAnimationTimer);
      this.thinkingAnimationTimer = null;
    }
    // 清除thinking显示行
    if (this.state.cursorInScrollArea) {
      writeStdout(`${ESC}[?25l`);
      writeStdout(`${ESC}[${this.state.scrollBottom};1H`);
      writeStdout(`${ESC}[2K`);
    }
  }

  refreshStatus(): void {
    this.drawStatus();
  }

  private drawStatus(): void {
    writeStdout(`${ESC}[?25l`);
    writeStdout(`${ESC}[${this.state.statusRow};1H${ESC}[2K`);
    if (this.state.statusText) {
      writeStdout(this.state.statusText);
    }
  }

  private formatInputContent(content: string): string {
    if (content.startsWith('/')) {
      const spaceIdx = content.indexOf(' ');
      const cmdEnd = spaceIdx > 0 ? spaceIdx : content.length;
      const cmd = content.slice(0, cmdEnd);
      const rest = content.slice(cmdEnd);
      return `\x1b[35m${cmd}\x1b[0m${rest}`;
    }
    return content;
  }

  refreshInput(): void {
    this.updateLayout();
    writeStdout(`${ESC}[?25l`);

    const inputStartRow = this.state.statusRow + 1;
    const inputEndRow = this.state.terminalHeight;
    
    // 清空输入区域
    for (let row = inputStartRow; row <= inputEndRow; row++) {
      writeStdout(`${ESC}[${row};1H${ESC}[2K`);
    }

    const content = this.state.inputBuffer[0];
    const logicalLines = content.split('\n');
    const width = this.state.terminalWidth;

    let currentRow = inputStartRow;
    for (let i = 0; i < logicalLines.length; i++) {
      const lineContent = logicalLines[i];
      const displayContent = i === 0 ? '> ' + this.formatInputContent(lineContent) : lineContent;

      const prefixWidth = i === 0 ? 2 : 0;
      const lineWidth = prefixWidth + this.getStringDisplayWidth(lineContent);
      const physicalLines = Math.max(1, Math.ceil(lineWidth / width));

      // 确保不越界
      if (currentRow > inputEndRow) break;

      writeStdout(`${ESC}[${currentRow};1H`);
      writeStdout(displayContent);

      currentRow += physicalLines;
    }
  }

  restoreCursor(): void {
    const rawContent = this.state.inputBuffer[0];
    const cursorCharPos = this.state.cursorCol;
    const width = this.state.terminalWidth;

    // 使用 grapheme cluster 正确处理复杂 Unicode 字符
    const graphemes = rawContent.match(/\P{M}\p{M}*/gu) || [];
    const contentBeforeCursor = graphemes.slice(0, cursorCharPos);

    // 计算光标所在的逻辑行和行内位置
    let logicalLineIndex = 0;
    let charsInCurrentLine = 0;

    for (const char of contentBeforeCursor) {
      if (char === '\n') {
        logicalLineIndex++;
        charsInCurrentLine = 0;
      } else {
        charsInCurrentLine++;
      }
    }

    const logicalLines = rawContent.split('\n');
    const currentLogicalLine = logicalLines[logicalLineIndex] || '';

    // 计算光标在当前逻辑行中的显示宽度
    const graphemesInLine = currentLogicalLine.match(/\P{M}\p{M}*/gu) || [];
    const graphemesBeforeCursorInLine = graphemesInLine.slice(0, charsInCurrentLine);
    let displayWidthInLine = 0;
    for (const char of graphemesBeforeCursorInLine) {
      displayWidthInLine += this.getCharDisplayWidth(char);
    }

    const prefixWidth = logicalLineIndex === 0 ? 2 : 0;
    const cursorDisplayWidth = prefixWidth + displayWidthInLine;

    // 计算之前逻辑行占用的物理行数
    let physicalLinesBefore = 0;
    for (let i = 0; i < logicalLineIndex; i++) {
      const line = logicalLines[i];
      const pWidth = i === 0 ? 2 : 0;
      const lineWidth = pWidth + this.getStringDisplayWidth(line);
      physicalLinesBefore += Math.max(1, Math.ceil(lineWidth / width));
    }

    // 计算当前逻辑行中光标之前占用的物理行数
    // 边界情况：当 cursorDisplayWidth 正好是 width 的倍数时，光标在行末
    let physicalLinesInCurrentBeforeCursor: number;
    let cursorCol: number;
    
    if (cursorDisplayWidth > 0 && cursorDisplayWidth % width === 0) {
      // 光标正好在行边界，应该在当前行的末尾
      physicalLinesInCurrentBeforeCursor = Math.floor(cursorDisplayWidth / width) - 1;
      cursorCol = width;
    } else {
      physicalLinesInCurrentBeforeCursor = Math.floor(cursorDisplayWidth / width);
      cursorCol = (cursorDisplayWidth % width) + 1;
    }

    const inputStartRow = this.state.statusRow + 1;
    const cursorRow = inputStartRow + physicalLinesBefore + physicalLinesInCurrentBeforeCursor;

    // 确保光标不越界
    const maxRow = this.state.terminalHeight;
    const clampedCursorRow = Math.min(cursorRow, maxRow);
    const clampedCursorCol = Math.max(1, Math.min(cursorCol, width));

    writeStdout(`${ESC}[${clampedCursorRow};${clampedCursorCol}H`);
    writeStdout(`${ESC}[?25h`);
    this.state.cursorInScrollArea = false;
  }

  refreshInputAndKeepCursor(): void {
    this.refreshInput();
    this.restoreCursor();
  }

  getDisplayCol(line: string, col: number): number {
    const chars = [...line].slice(0, col);
    return this.getStringDisplayWidth(chars.join(''));
  }

  handleInput(data: string): boolean {
    // 流式输出时，刷新输入框但光标留在输入框
    if (this.state.isStreaming) {
      // Ctrl+O 切换 verbose 模式
      if (data === '\x0f') {
        if (this.state.onVerboseToggle) {
          this.state.onVerboseToggle();
        }
        return false;
      }

      // Enter 键 - 流式输出时允许提交（index.ts 的 queue 会排队处理）
      if (data === '\r' || data === '\n') return true;

      // 删除键
      if (data === '\x7f' || data === '\b') {
        if (this.state.cursorCol > 0) {
          const line = this.state.inputBuffer[0];
          const graphemes = line.match(/\P{M}\p{M}*/gu) || [];
          this.state.inputBuffer[0] =
            graphemes.slice(0, this.state.cursorCol - 1).join('') +
            graphemes.slice(this.state.cursorCol).join('');
          this.state.cursorCol--;
          // 用户输入刷新，光标留在输入框
          this.refreshInputForUserTyping();
        }
        return false;
      }

      // Tab 键
      if (data === '\t') {
        return false;
      }

      // 粘贴
      if (data.includes(`${ESC}[200~`)) {
        const content = this.cleanPastedContent(data);
        const graphemes = content.match(/\P{M}\p{M}*/gu) || [];
        const line = this.state.inputBuffer[0];
        const lineGraphemes = line.match(/\P{M}\p{M}*/gu) || [];
        this.state.inputBuffer[0] =
          lineGraphemes.slice(0, this.state.cursorCol).join('') +
          content +
          lineGraphemes.slice(this.state.cursorCol).join('');
        this.state.cursorCol += graphemes.length;
        // 用户输入刷新，光标留在输入框
        this.refreshInputForUserTyping();
        return false;
      }

      // 方向键等 ANSI 序列
      if (data.startsWith(ESC)) {
        return false;
      }

      // 普通字符输入
      const line = this.state.inputBuffer[0];
      const graphemes = line.match(/\P{M}\p{M}*/gu) || [];
      const dataGraphemes = data.match(/\P{M}\p{M}*/gu) || [];
      this.state.inputBuffer[0] =
        graphemes.slice(0, this.state.cursorCol).join('') +
        data +
        graphemes.slice(this.state.cursorCol).join('');
      this.state.cursorCol += dataGraphemes.length;
      // 用户输入刷新，光标留在输入框
      this.refreshInputForUserTyping();
      return false;
    }

    // 非流式输出时，正常处理输入
    // 确保光标在输入框区域
    if (this.state.cursorInScrollArea) {
      writeStdout(`${ESC}[?25l`);
      const inputStartRow = this.state.statusRow + 1;
      writeStdout(`${ESC}[${inputStartRow};1H`);
      this.state.cursorInScrollArea = false;
    }

    if (data === '\r' || data === '\n') return true;
    if (data === '\x0f') {
      if (this.state.onVerboseToggle) {
        this.state.onVerboseToggle();
      }
      return false;
    }
    if (data === '\x7f' || data === '\b') {
      if (this.state.cursorCol > 0) {
        const line = this.state.inputBuffer[0];
        const graphemes = line.match(/\P{M}\p{M}*/gu) || [];
        this.state.inputBuffer[0] = 
          graphemes.slice(0, this.state.cursorCol - 1).join('') + 
          graphemes.slice(this.state.cursorCol).join('');
        this.state.cursorCol--;
        this.refreshInput();
        this.restoreCursor();
      }
      return false;
    }
    if (data === '\t') {
      this.handleTab();
      return false;
    }
    if (data.includes(`${ESC}[200~`)) {
      this.handlePaste(data);
      return false;
    }
    if (data.startsWith(ESC)) {
      this.handleAnsi(data);
      return false;
    }
    const line = this.state.inputBuffer[0];
    const graphemes = line.match(/\P{M}\p{M}*/gu) || [];
    const dataGraphemes = data.match(/\P{M}\p{M}*/gu) || [];
    this.state.inputBuffer[0] = 
      graphemes.slice(0, this.state.cursorCol).join('') + 
      data + 
      graphemes.slice(this.state.cursorCol).join('');
    this.state.cursorCol += dataGraphemes.length;
    this.updateLayout();
    this.refreshInput();
    this.restoreCursor();
    return false;
  }

  handleAnsi(seq: string): void {
    // 确保光标在输入框区域
    if (this.state.cursorInScrollArea) {
      writeStdout(`${ESC}[?25l`);
      const inputStartRow = this.state.statusRow + 1;
      writeStdout(`${ESC}[${inputStartRow};1H`);
      this.state.cursorInScrollArea = false;
    }

    const line = this.state.inputBuffer[0];
    const graphemes = line.match(/\P{M}\p{M}*/gu) || [];
    
    if (seq === `${ESC}[C`) {
      if (this.state.cursorCol < graphemes.length) this.state.cursorCol++;
    } else if (seq === `${ESC}[D`) {
      if (this.state.cursorCol > 0) this.state.cursorCol--;
    } else if (seq === `${ESC}[3~`) {
      if (this.state.cursorCol < graphemes.length) {
        this.state.inputBuffer[0] = 
          graphemes.slice(0, this.state.cursorCol).join('') + 
          graphemes.slice(this.state.cursorCol + 1).join('');
      }
    }
    this.refreshInput();
    this.restoreCursor();
  }

  handleTab(): void {
    // 确保光标在输入框区域
    if (this.state.cursorInScrollArea) {
      writeStdout(`${ESC}[?25l`);
      const inputStartRow = this.state.statusRow + 1;
      writeStdout(`${ESC}[${inputStartRow};1H`);
      this.state.cursorInScrollArea = false;
    }

    const line = this.state.inputBuffer[0];
    if (!line.startsWith('/') || !this.state.completer) return;
    const hits = this.state.completer(line);
    if (hits.length === 1) {
      this.state.inputBuffer[0] = hits[0];
      this.state.cursorCol = (hits[0].match(/\P{M}\p{M}*/gu) || []).length;
      this.updateLayout();
      this.refreshInput();
      this.restoreCursor();
    } else if (hits.length > 1) {
      this.appendScroll('\n' + hits.join('  ') + '\n');
      this.restoreCursor();
    }
  }

  handlePaste(data: string): void {
    // 确保光标在输入框区域
    if (this.state.cursorInScrollArea) {
      writeStdout(`${ESC}[?25l`);
      const inputStartRow = this.state.statusRow + 1;
      writeStdout(`${ESC}[${inputStartRow};1H`);
      this.state.cursorInScrollArea = false;
    }

    // eslint-disable-next-line no-control-regex -- ANSI escape codes for bracketed paste
    const content = this.cleanPastedContent(data);
    const graphemes = content.match(/\P{M}\p{M}*/gu) || [];
    const line = this.state.inputBuffer[0];
    const lineGraphemes = line.match(/\P{M}\p{M}*/gu) || [];
    this.state.inputBuffer[0] =
      lineGraphemes.slice(0, this.state.cursorCol).join('') +
      content +
      lineGraphemes.slice(this.state.cursorCol).join('');
    this.state.cursorCol += graphemes.length;
    this.updateLayout();
    this.refreshInput();
    this.restoreCursor();
  }

  // Strip bracketed paste markers AND any embedded ANSI escape sequences
  // from pasted content. ANSI codes (CSI/OSC) can end up in clipboard when
  // copying from terminals or IDEs; if not stripped they introduce invisible
  // characters that throw off cursor positioning.
  private cleanPastedContent(data: string): string {
    // eslint-disable-next-line no-control-regex
    return data
      .replace(/\x1b\[200~/g, '')   // bracketed paste start
      .replace(/\x1b\[201~/g, '')   // bracketed paste end
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')  // CSI: colors, cursor moves (incl. ?25l/h), etc.
      .replace(/\x1b\][^\x07]*\x07/g, '')     // OSC: title, link, etc.
      .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, ''); // Other escape sequences
  }

  getContent(): string {
    return this.state.inputBuffer[0];
  }

  clear(): void {
    this.state.inputBuffer[0] = '';
    this.state.cursorCol = 0;
    this.state.inputLines = 1;
    this.state.statusRow = this.state.terminalHeight - 2;
    this.state.scrollBottom = this.state.terminalHeight - 3;
    this.state.pendingInputRefresh = false;
    writeStdout(`${ESC}[1;${this.state.scrollBottom}r`);
    this.drawStatus();
    this.refreshInput();
    this.restoreCursor();
  }

  setCompleter(fn: (line: string) => string[]): void {
    this.state.completer = fn;
  }

  setVerboseToggleCallback(fn: () => void): void {
    this.state.onVerboseToggle = fn;
  }

  setStatus(text: string): void {
    this.state.statusText = text;
    this.drawStatus();
    this.restoreCursor();
  }

  writeRaw(text: string): void {
    process.stdout.write(text);
  }
}

let instance: ScreenManager | null = null;
export function getScreenManager(): ScreenManager {
  if (!instance) instance = new ScreenManager();
  return instance;
}