/**
 * TUI 完整功能测试脚本
 * 测试 ScreenManager 的全角字符处理和光标定位
 *
 * 关键：不调用 ScreenManager.start() 和 clear()，避免滚动区域设置干扰 PTY 输出捕获
 */
import { getScreenManager } from '../screenManager';
import { isFullWidth } from '../stringWidth';

const screen = getScreenManager();

// 不调用 start()，避免清屏和滚动区域设置干扰 PTY 输出捕获
process.stdout.write('=== TUI FullWidth Test ===\n');
process.stdout.write('Press Ctrl+C to exit\n\n');

// 手动初始化状态（不调用 start()）
screen.state.inputBuffer = [''];
screen.state.cursorCol = 0;

// 计算显示宽度
function calculateWidth(str: string): number {
  let w = 0;
  for (const c of str) {
    if (isFullWidth(c)) {
      w += 2;
    } else if (c !== '\n') {
      w += 1;
    }
  }
  return w;
}

// 输出测试结果到 stdout（PTY 能捕获）
function outputTestResult(content: string): void {
  const charCount = [...content].length;
  const width = calculateWidth(content);

  process.stdout.write(`\n--- Test Result ---\n`);
  process.stdout.write(`Input: "${content}"\n`);
  process.stdout.write(`CharCount: ${charCount}\n`);
  process.stdout.write(`DisplayWidth: ${width}\n`);
  process.stdout.write(`--- End ---\n\n`);
}

// 模拟 PTY raw mode
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

process.stdin.on('data', (data: Buffer) => {
  const str = data.toString('utf8');

  // Ctrl+C 退出
  if (str === '\x03' || str.includes('\x03')) {
    process.stdout.write('\nExiting...\n');
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.exit(0);
    return;
  }

  // 检测 Enter（PTY 发送 \r 或 \r\n）
  if (
    str === '\r' ||
    str === '\n' ||
    (str.includes('\r') && str.length === 1) ||
    (str.includes('\n') && str.length === 1)
  ) {
    const content = screen.state.inputBuffer[0];
    if (content) {
      outputTestResult(content);
    }
    // 手动清空状态，不调用 screen.clear()
    screen.state.inputBuffer = [''];
    screen.state.cursorCol = 0;
    process.stdout.write('> ');
    return;
  }

  // 处理普通输入（使用 ScreenManager 的 handleInput）
  screen.handleInput(str);

  // 显示当前输入状态（简单的回显）
  process.stdout.write(`\x1b[2K\x1b[1G> ${screen.state.inputBuffer[0]}`);
});

process.stdout.write('> ');
process.stdin.resume();
