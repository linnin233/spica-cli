import { isFullWidth } from './stringWidth';
import { COLORS } from './colors';
import { getScrollbackBuffer, ScrollbackBuffer } from './scrollbackBuffer';
import { renderMarkdownTables } from './tableRenderer';
import { ansiStrip, ansiClean } from './ansiFilter';
import { MatrixRainController } from './matrixRain';
import type { MatrixRainConfig } from './matrixRain';

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
  // Category grouping for tab completion: map<categoryLabel, command[]>
  completionGroups: Record<string, string[]> | null;
  shownCompletionList: boolean;
  lastCompletionLine: string;
  cursorInScrollArea: boolean;
  isStreaming: boolean;
  onVerboseToggle?: () => void;
  /** Render function for idea overlay — called when entering idea workspace */
  ideaOverlayRenderFn?: () => string[];
  /** Called when workspace changes — for status bar refresh */
  onWorkspaceChange?: () => void;
  // Matrix rain (hacker mode)
  matrixRain: MatrixRainController | null;
  hackerMode: boolean;
  /** In hacker mode: first row of the output zone (rain fills rows 1..rainTop-1) */
  rainTop: number;
  /** Subagent overlay: 0 when hidden, 6 when visible */
  overlayRows: number;
  /** Current workspace: main (coding) or idea (idea capture) */
  workspace: 'main' | 'idea';
  /** Input buffer preserved when switching to idea workspace */
  ideaInputBuffer: string[];
  ideaCursorCol: number;
  lastMainInputBuffer: string[];
  lastMainCursorCol: number;
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
      completionGroups: null,
      shownCompletionList: false,
      lastCompletionLine: '',
      cursorInScrollArea: false,
      isStreaming: false,
      onVerboseToggle: undefined,
      matrixRain: null,
      hackerMode: false,
      rainTop: 1,
      overlayRows: 0,
      workspace: 'main',
      ideaInputBuffer: [''],
      ideaCursorCol: 0,
      lastMainInputBuffer: [''],
      lastMainCursorCol: 0,
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
    this.state.scrollBottom = this.state.statusRow - 1 - this.state.overlayRows;

    // Hacker mode: full-screen rain, no scroll regions
    if (this.state.hackerMode) {
      this.state.scrollBottom = this.state.statusRow - 1;
      this.state.rainTop = 1;
      if (this.state.matrixRain) {
        this.state.matrixRain.resize(newWidth, this.state.scrollBottom, 1);
      }
      writeStdout(`${ESC}[2J${ESC}[H`);
      writeStdout(`${ESC}[r`); // reset scroll region
    } else {
      writeStdout(`${ESC}[2J${ESC}[H`);
      writeStdout(`${ESC}[1;${this.state.scrollBottom}r`);
    }

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
    if (char.length > 1 || codePoint > 0xffff) return 2;

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

  /** Prompt text width in characters (not display width). */
  private getPromptWidth(): number {
    return this.state.workspace === 'idea' ? 'idea> '.length : '> '.length;
  }

  private calcInputLines(): number {
    const content = this.state.inputBuffer[0];
    const width = this.state.terminalWidth;

    const logicalLines = content.split('\n');
    let totalLines = 0;

    for (let i = 0; i < logicalLines.length; i++) {
      const line = logicalLines[i];
      const promptWidth = this.getPromptWidth();
      const prefixWidth = i === 0 ? promptWidth : 0;
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
      this.state.scrollBottom = this.state.statusRow - 1 - this.state.overlayRows;

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
    // Hacker mode: route all text output to rain
    if (this.state.hackerMode && this.state.matrixRain) {
      this.state.scrollbackBuffer.append(ansiClean(text));
      this.state.matrixRain.feed(text, 'tool');
      return;
    }

    // 保存清洗后文本到历史缓冲区（strip ANSI for resize replay）
    this.state.scrollbackBuffer.append(ansiClean(text));

    // Prepend any pending partial from previous call
    const full = this.appendScrollPartial + text;
    const lines = full.split('\n');

    // Process all complete lines through the table state machine
    for (let i = 0; i < lines.length - 1; i++) {
      this.processLine(lines[i]);
    }

    // Save trailing partial for next call (empty string if text ends with \n)
    this.appendScrollPartial = lines[lines.length - 1] || '';

    // Note: tableState persists across appendScroll calls — tables may span calls.
    // Flush only via flushTableScrollBuffer/flushOutput when processing ends.

    // 如果有换行符，刷新输入框
    if (full !== text || text.includes('\n')) {
      this.refreshInputDuringStreaming();
    }
  }

  /** Flush pending table buffer + partial line (call when streaming/processing ends) */
  flushTableScrollBuffer(): void {
    // Flush any trailing partial line first
    if (this.appendScrollPartial) {
      this.processLine(this.appendScrollPartial);
      // Force the partial to be output as a complete line
      this.appendScrollPartial = '';
    }
    this.flushTableBuffer();
    this.tableState = 'idle';
  }

  // 行缓冲输出（用于AI流式输出）
  private streamBuffer: string = '';
  // Partial line buffer for appendScroll — accumulates across calls so
  // multi-fragment lines (built from several appendScroll calls) stay intact.
  private appendScrollPartial: string = '';
  // 统一表格状态机 — 流式和非流式路径共用
  // States: idle → pending (saw |...| header) → table (separator confirmed)
  private tableState: 'idle' | 'pending' | 'table' = 'idle';
  private tableBuffer: string[] = [];
  private readonly TABLE_MAX_ROWS = 200;

  appendStreamChunk(text: string): void {
    // 保存清洗后文本到历史缓冲区（strip ANSI for resize replay）
    this.state.scrollbackBuffer.append(ansiClean(text));

    // 添加到流式缓冲
    this.streamBuffer += text;

    // 检查是否有完整行
    if (this.streamBuffer.includes('\n')) {
      const lines = this.streamBuffer.split('\n');
      // 处理所有完整行
      for (let i = 0; i < lines.length - 1; i++) {
        this.processLine(lines[i]);
      }
      // 保留最后一行在缓冲中
      this.streamBuffer = lines[lines.length - 1] || '';
    }
  }

  // ── Unified table state machine ──────────────────────────────
  // States: idle → pending (saw |...| header) → table (separator confirmed)
  // Two-phase confirmation prevents false-positive buffering of single |text| lines.

  private processLine(line: string): void {
    const stripped = ansiStrip(line).trim();
    const isDataLine = /^\|.+\|/.test(stripped);
    const isSepLine = /^\|[\s:]*-{3,}[\s:]*\|/.test(stripped);

    if (this.tableState === 'table') {
      if (isDataLine) {
        if (this.tableBuffer.length < this.TABLE_MAX_ROWS) {
          this.tableBuffer.push(line);
        }
        return;
      }
      // Table ended — render and flush
      this.flushTableBuffer();
      this.tableState = 'idle';
      this.writeOutputLine(line);
      return;
    }

    if (this.tableState === 'pending') {
      if (isSepLine) {
        // Confirmed: header + separator = table
        this.tableBuffer.push(line);
        this.tableState = 'table';
        return;
      }
      // False alarm — flush buffered header as plain text
      const buffered = this.tableBuffer[0];
      this.tableBuffer = [];
      this.tableState = 'idle';
      this.writeOutputLine(buffered);
      this.writeOutputLine(line);
      return;
    }

    // idle
    if (isDataLine) {
      // Potential table header — buffer and wait for separator confirmation
      this.tableBuffer = [line];
      this.tableState = 'pending';
      return;
    }

    // Plain line
    this.writeOutputLine(line);
  }

  /** Flush buffered table through renderMarkdownTables */
  private flushTableBuffer(): void {
    if (this.tableBuffer.length < 3) {
      // Not enough lines for a table — flush as plain text
      for (const l of this.tableBuffer) {
        this.writeOutputLine(l);
      }
      this.tableBuffer = [];
      return;
    }

    const text = this.tableBuffer.join('\n');
    const rendered = renderMarkdownTables(text);

    for (const l of rendered.split('\n')) {
      this.writeOutputLine(l);
    }
    this.tableBuffer = [];
  }

  private writeOutputLine(line: string): void {
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
    this.tableState = 'idle';

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
    // Flush any trailing partial line
    if (this.appendScrollPartial) {
      this.processLine(this.appendScrollPartial);
      this.appendScrollPartial = '';
    }
    this.flushTableBuffer();
    this.tableState = 'idle';
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
      this.thinkingAnimationFrame =
        (this.thinkingAnimationFrame + 1) % this.thinkingAnimationFrames.length;
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
    // 重置光标状态——下次 writeOutputLine/appendScroll 会重新定位到行首
    // 防止 thinking 帧残留混入后续输出（如 "⠏ thinking**content**"）
    this.state.cursorInScrollArea = false;
  }

  // ── Overlay ──────────────────────────────────────────────────

  /** Reserve/free rows for overlay between scrollback and status bar (idea workspace) */
  setOverlay(visible: boolean, rows: number = 6): void {
    const newRows = visible ? rows : 0;
    if (this.state.overlayRows === newRows) return;

    this.state.overlayRows = newRows;
    this.state.scrollBottom = this.state.statusRow - 1 - newRows;

    // Clear overlay area if hiding
    if (!visible) {
      for (let row = this.state.scrollBottom + 1; row <= this.state.statusRow - 1; row++) {
        writeStdout(`${ESC}[${row};1H${ESC}[2K`);
      }
    }

    // Reset scroll region
    writeStdout(`${ESC}[1;${this.state.scrollBottom}r`);

    // Reposition cursor to scroll bottom
    this.state.cursorInScrollArea = true;
    writeStdout(`${ESC}[?25l`);
    writeStdout(`${ESC}[${this.state.scrollBottom};1H`);
  }

  /** Write lines directly to overlay region — no scrollback buffer, no table state machine */
  writeOverlay(lines: string[]): void {
    if (this.state.overlayRows === 0) return;
    const startRow = this.state.scrollBottom + 1;
    writeStdout(`${ESC}[?25l`);
    for (let i = 0; i < this.state.overlayRows && i < lines.length; i++) {
      writeStdout(`${ESC}[${startRow + i};1H${ESC}[2K${lines[i]}`);
    }
  }

  /** Enter idea workspace — show idea overlay, switch input buffer. */
  enterIdeaWorkspace(): void {
    if (this.state.workspace === 'idea') return;

    // Save main input buffer before switching
    this.state.lastMainInputBuffer = [...this.state.inputBuffer];
    this.state.lastMainCursorCol = this.state.cursorCol;

    // Restore idea input buffer
    this.state.inputBuffer = this.state.ideaInputBuffer.length > 0
      ? [...this.state.ideaInputBuffer] : [''];
    this.state.cursorCol = this.state.ideaCursorCol;

    this.state.workspace = 'idea';

    // Reserve overlay space (max 7 rows: 1 top + 1 title + 4 ideas + 1 help + 1 bottom,
    // but 4 rows for empty state). Use fixed 7 to avoid re-layout on every idea change.
    this.setOverlay(true, 7);

    // Write idea overlay content
    if (this.state.ideaOverlayRenderFn) {
      this.writeOverlay(this.state.ideaOverlayRenderFn());
    }

    if (this.state.onWorkspaceChange) this.state.onWorkspaceChange();
    this.drawStatus();
    this.refreshInput();
    this.restoreCursor();
  }

  /** Exit idea workspace — hide overlay, restore main input buffer. */
  exitIdeaWorkspace(): void {
    if (this.state.workspace !== 'idea') return;

    // Save idea input buffer before switching
    this.state.ideaInputBuffer = [...this.state.inputBuffer];
    this.state.ideaCursorCol = this.state.cursorCol;

    // Restore main input buffer
    this.state.inputBuffer = this.state.lastMainInputBuffer.length > 0
      ? [...this.state.lastMainInputBuffer] : [''];
    this.state.cursorCol = Math.min(this.state.lastMainCursorCol,
      (this.state.inputBuffer[0] || '').length);

    this.state.workspace = 'main';

    // Remove overlay, restore scroll region
    this.setOverlay(false);

    if (this.state.onWorkspaceChange) this.state.onWorkspaceChange();
    this.drawStatus();
    this.refreshInput();
    this.restoreCursor();
  }

  /** Toggle between main and idea workspaces */
  toggleWorkspace(): void {
    if (this.state.workspace === 'idea') {
      this.exitIdeaWorkspace();
    } else {
      this.enterIdeaWorkspace();
    }
  }

  isInIdeaWorkspace(): boolean {
    return this.state.workspace === 'idea';
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
      const promptText = this.state.workspace === 'idea' ? 'idea> ' : '> ';
      const displayContent = i === 0 ? promptText + this.formatInputContent(lineContent) : lineContent;

      const promptWidth = this.getPromptWidth();
      const prefixWidth = i === 0 ? promptWidth : 0;
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

    const promptW = this.getPromptWidth();
    const prefixWidth = logicalLineIndex === 0 ? promptW : 0;
    const cursorDisplayWidth = prefixWidth + displayWidthInLine;

    // 计算之前逻辑行占用的物理行数
    let physicalLinesBefore = 0;
    for (let i = 0; i < logicalLineIndex; i++) {
      const line = logicalLines[i];
      const pWidth = i === 0 ? promptW : 0;
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
    // Workspace toggle: Ctrl+Tab / Ctrl+Shift+Tab / Shift+Tab
    const isToggleSeq = (
      data === '\x1b[1;5I' ||
      data === '\x1b[27;5;9~' ||
      data === '\x1b[27;6;9~' ||
      data === '\x1b[Z'
    );
    if (isToggleSeq) {
      this.toggleWorkspace();
      return false;
    }

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

      // Tab: allow single-hit auto-complete during streaming (no scrollback write).
      // Multi-hit completion would write to scrollback which races with stream output.
      if (data === '\t') {
        const line = this.state.inputBuffer[0];
        if (!line.startsWith('/') || !this.state.completer) return false;
        const hits = this.state.completer(line);
        if (hits.length === 1) {
          this.state.inputBuffer[0] = hits[0];
          this.state.cursorCol = (hits[0].match(/\P{M}\p{M}*/gu) || []).length;
          this.updateLayout();
          this.refreshInputForUserTyping();
        }
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
        // Multi-line paste may expand input box — recalculate layout.
        // Use updateLayout() to re-measure input lines before rendering.
        if (content.includes('\n')) {
          this.updateLayout();
        }
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
      const groups = this.state.completionGroups;
      this.appendScroll(this.formatTabCompletions(hits, groups));
      this.restoreCursor();
    }
  }

  // Format tab completions into aligned columns (row-major).
  // When `groups` is provided, items are rendered group-by-group with
  // a dimmed header line per category. When filtering (hits are a subset),
  // groups are skipped — just plain columns.
  // Terminal-width-aware: adapts column count so each cell has room.
  private formatTabCompletions(
    hits: string[],
    groups: Record<string, string[]> | null,
  ): string {
    // Only use groups when showing the full (unfiltered) set.
    // During filtering (/bra…) the hits are a subset — no headers needed.
    if (groups) {
      const allCmds = Object.values(groups).flat();
      const isFullSet = hits.length === allCmds.length &&
        hits.every(h => allCmds.includes(h));
      if (isFullSet) {
        return this.formatGroupedCompletions(groups);
      }
    }
    return this.formatColumnCompletions(hits);
  }

  /** Plain column layout (used when filtering or no groups). */
  private formatColumnCompletions(hits: string[]): string {
    const termWidth = this.state.terminalWidth || 80;
    const maxLen = Math.min(Math.max(...hits.map(h => h.length)), 32) + 2;
    const cols = Math.max(1, Math.floor(termWidth / maxLen));

    let out = '\n';
    for (let i = 0; i < hits.length; i++) {
      if (i > 0 && i % cols === 0) out += '\n';
      out += hits[i].padEnd(maxLen);
    }
    out += '\n';
    return out;
  }

  /** Grouped layout: header per category, then commands in columns. */
  private formatGroupedCompletions(groups: Record<string, string[]>): string {
    const termWidth = this.state.terminalWidth || 80;
    const allCmds = Object.values(groups).flat();
    const maxLen = Math.min(Math.max(...allCmds.map(c => c.length)), 32) + 2;
    const cols = Math.max(1, Math.floor(termWidth / maxLen));

    let out = '\n';
    for (const [label, cmds] of Object.entries(groups)) {
      if (cmds.length === 0) continue;
      out += `\x1b[2m[${label}]\x1b[0m\n`; // dimmed category header
      for (let i = 0; i < cmds.length; i++) {
        if (i > 0 && i % cols === 0) out += '\n';
        out += cmds[i].padEnd(maxLen);
      }
      out += '\n';
    }
    return out;
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

  // Strip ANSI escape sequences from pasted content — delegates to ansiFilter.
  private cleanPastedContent(data: string): string {
    return ansiStrip(data);
  }

  getContent(): string {
    return this.state.inputBuffer[0];
  }

  clear(): void {
    this.state.inputBuffer[0] = '';
    this.state.cursorCol = 0;
    // Recalculate layout accounting for active overlay rows
    this.state.inputLines = this.calcInputLines();
    this.state.statusRow = this.state.terminalHeight - this.state.inputLines - 1;
    this.state.scrollBottom = this.state.statusRow - 1 - this.state.overlayRows;
    this.state.pendingInputRefresh = false;
    writeStdout(`${ESC}[1;${this.state.scrollBottom}r`);
    this.drawStatus();
    this.refreshInput();
    this.restoreCursor();
  }

  setCompleter(fn: (line: string) => string[]): void {
    this.state.completer = fn;
  }

  setCompletionGroups(groups: Record<string, string[]> | null): void {
    this.state.completionGroups = groups;
  }

  setVerboseToggleCallback(fn: () => void): void {
    this.state.onVerboseToggle = fn;
  }

  /** Set render function for idea overlay — called on every enterIdeaWorkspace */
  setIdeaOverlayRenderFn(fn: () => string[]): void {
    this.state.ideaOverlayRenderFn = fn;
  }

  /** Set the input buffer content (used by idea workspace to fill text). */
  setInput(text: string): void {
    this.state.inputBuffer = [text];
    this.state.cursorCol = text.length;
  }

  /** Clear the input buffer. */
  clearInput(): void {
    this.state.inputBuffer = [''];
    this.state.cursorCol = 0;
  }

  setStatus(text: string): void {
    this.state.statusText = text;
    this.drawStatus();
    this.restoreCursor();
  }

  writeRaw(text: string): void {
    process.stdout.write(text);
  }

  // ── Hacker Mode ───────────────────────────────────────────────────────

  /** Start the rain — called before processing begins */
  startRain(): void {
    if (this.state.matrixRain) return; // already running
    this.state.hackerMode = true;

    this.state.scrollBottom = this.state.statusRow - 1;
    this.state.matrixRain = new MatrixRainController({
      height: this.state.scrollBottom,
      width: this.state.terminalWidth,
      terminalRow: 1,
    });
    this.state.matrixRain.start();

    writeStdout(`${ESC}[2J${ESC}[H`);
    writeStdout(`${ESC}[r`);
    this.drawStatus();
    this.refreshInput();
    this.restoreCursor();
  }

  /** Stop the rain and restore normal display — called after processing */
  stopRain(): void {
    if (!this.state.matrixRain) return;
    this.state.matrixRain.clear();
    this.state.matrixRain = null;
    this.state.hackerMode = false;

    // Restore normal scroll area
    this.state.scrollBottom = this.state.statusRow - 1;
    this.state.cursorInScrollArea = false;
    this.state.isStreaming = false;

    writeStdout(`${ESC}[2J${ESC}[H`);
    writeStdout(`${ESC}[1;${this.state.scrollBottom}r`);
    this.drawStatus();
    this.refreshInput();
    this.restoreCursor();
  }

  /** Feed any text into the rain */
  feedRain(text: string, type: import('./matrixRain').RainType = 'thinking'): void {
    if (this.state.matrixRain) {
      this.state.matrixRain.feed(text, type);
    }
  }
}

let instance: ScreenManager | null = null;
export function getScreenManager(): ScreenManager {
  if (!instance) instance = new ScreenManager();
  return instance;
}
