// 固定底部输入框 + 状态显示
// 使用 ANSI scroll region 实现

const ESC = '\x1b';

// 终端尺寸
function getTerminalHeight(): number {
  return process.stdout.rows || 24;
}

function getTerminalWidth(): number {
  return process.stdout.columns || 80;
}

// 输入框高度（底部保留行数）
const INPUT_BOX_HEIGHT = 3; // 状态行 + 分隔线 + 输入行

// 启用 scroll region（顶部可滚动，底部固定）
export function enableScrollRegion(): void {
  const height = getTerminalHeight();
  const scrollTop = height - INPUT_BOX_HEIGHT;

  // 设置滚动区域：行 1 到 scrollTop
  process.stdout.write(`${ESC}[1;${scrollTop}r`);

  // 移动光标到滚动区顶部
  process.stdout.write(`${ESC}[1;1H`);
}

// 禁用 scroll region（恢复整个屏幕可滚动）
export function disableScrollRegion(): void {
  process.stdout.write(`${ESC}[r`);
}

// 清屏
export function clearScreen(): void {
  process.stdout.write(`${ESC}[2J${ESC}[H`);
}

// 移动到输入框区域（底部）
export function moveToInputBox(): void {
  const height = getTerminalHeight();
  process.stdout.write(`${ESC}[${height - INPUT_BOX_HEIGHT + 1};1H`);
}

// 清除输入框区域
export function clearInputBox(): void {
  const height = getTerminalHeight();

  // 清除状态行
  process.stdout.write(`${ESC}[${height - INPUT_BOX_HEIGHT + 1};1H${ESC}[2K`);
  // 清除分隔线
  process.stdout.write(`${ESC}[${height - INPUT_BOX_HEIGHT + 2};1H${ESC}[2K`);
  // 清除输入行
  process.stdout.write(`${ESC}[${height};1H${ESC}[2K`);
}

// 显示分隔线
export function showSeparator(): void {
  const height = getTerminalHeight();
  const width = getTerminalWidth();

  process.stdout.write(`${ESC}[${height - INPUT_BOX_HEIGHT + 2};1H`);

  // 分隔线
  const separator = '─'.repeat(Math.min(width - 2, 60));
  process.stdout.write(`${ESC}[38;2;0;206;209m${separator}${ESC}[0m`);
}

// 显示状态行
export function showStatus(status: {
  model?: string;
  processing?: boolean;
  queue?: number;
  mode?: 'bypass' | 'strict';
  message?: string;
}): void {
  const height = getTerminalHeight();
  const width = getTerminalWidth();

  process.stdout.write(`${ESC}[${height - INPUT_BOX_HEIGHT + 1};1H${ESC}[2K`);

  // 状态信息
  const parts: string[] = [];

  if (status.model) {
    parts.push(`${ESC}[38;2;105;105;105m${status.model}${ESC}[0m`);
  }

  if (status.processing) {
    parts.push(`${ESC}[38;2;255;165;0mProcessing${ESC}[0m`);
  }

  if (status.queue && status.queue > 0) {
    parts.push(`${ESC}[38;2;100;149;237mQueue: ${status.queue}${ESC}[0m`);
  }

  if (status.mode) {
    const modeColor =
      status.mode === 'bypass' ? `${ESC}[38;2;255;100;100m` : `${ESC}[38;2;100;255;100m`;
    parts.push(`${modeColor}${status.mode}${ESC}[0m`);
  }

  if (status.message) {
    parts.push(`${ESC}[38;2;200;200;200m${status.message}${ESC}[0m`);
  }

  const statusLine = parts.join(' │ ');
  process.stdout.write(statusLine.slice(0, width - 2));
}

// 显示输入提示符
export function showPrompt(prompt: string = '> '): void {
  const height = getTerminalHeight();

  // 移动到输入行
  process.stdout.write(`${ESC}[${height};1H${ESC}[2K`);

  // 显示提示符
  process.stdout.write(`${ESC}[38;2;0;250;154m${prompt}${ESC}[0m`);
}

// 显示用户输入内容
export function showInputContent(content: string): void {
  const height = getTerminalHeight();
  const width = getTerminalWidth();

  // 清除输入行并重写
  process.stdout.write(`${ESC}[${height};1H${ESC}[2K`);
  process.stdout.write(`${ESC}[38;2;0;250;154m> ${ESC}[0m`);

  // 显示输入内容（限制宽度）
  const maxContent = width - 4;
  if (content.length > maxContent) {
    process.stdout.write(content.slice(-maxContent));
  } else {
    process.stdout.write(content);
  }
}

// 输出到滚动区域（AI 输出）
export function writeToScrollArea(content: string): void {
  // 保存光标位置
  process.stdout.write(`${ESC}[s`);

  // 输出内容
  process.stdout.write(content);

  // 恢复光标位置（回到输入框）
  process.stdout.write(`${ESC}[u`);
}

// 输出一行到滚动区域
export function writeLineToScrollArea(content: string): void {
  writeToScrollArea(content + '\n');
}

// 初始化固定输入框系统
export function initFixedInputBox(initialStatus?: {
  model?: string;
  mode?: 'bypass' | 'strict';
}): void {
  // 清屏
  clearScreen();

  // 启用滚动区域
  enableScrollRegion();

  // 显示分隔线
  showSeparator();

  // 显示初始状态
  showStatus(initialStatus || {});

  // 显示提示符
  showPrompt();
}

interface Status {
  model?: string;
  mode?: 'bypass' | 'strict';
  processing?: boolean;
  queue?: number;
  message?: string;
}

// 处理终端 resize
export function handleResize(status?: Status): void {
  initFixedInputBox(status);
}

// 监听 resize 事件
export function watchResize(getStatus: () => Status): void {
  process.stdout.on('resize', () => {
    handleResize(getStatus());
  });
}

// 清理（退出时调用）
export function cleanup(): void {
  disableScrollRegion();
  clearScreen();
}
