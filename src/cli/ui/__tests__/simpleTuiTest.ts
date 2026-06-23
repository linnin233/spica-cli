/**
 * 简单的 TUI 测试脚本
 * 用于验证 ScreenManager 的基本功能
 */
import { getScreenManager } from '../screenManager';

const screen = getScreenManager();
screen.start();

// 显示测试信息
screen.appendScroll('\x1b[36m=== TUI Test Script ===\x1b[0m\n');
screen.appendScroll('输入内容测试光标定位\n');
screen.appendScroll('按 Ctrl+C 退出\n\n');

screen.restoreCursor();

// 计算显示宽度
function calculateWidth(str: string): number {
  let w = 0;
  for (const c of str) {
    const code = c.codePointAt(0) || 0;
    // 全角字符宽度为2
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xff01 && code <= 0xff5e) ||
      (code >= 0x3000 && code <= 0x303f)
    ) {
      w += 2;
    } else if (c !== '\n') {
      w += 1;
    }
  }
  return w;
}

// 处理输入
process.stdin.on('data', (data: Buffer) => {
  const str = data.toString('utf8');

  // Ctrl+C 退出
  if (str === '\x03' || str.includes('\x03')) {
    screen.end();
    process.exit(0);
    return;
  }

  // 检测 Enter（可能是 \r 或 \n 或 \r\n）
  if (str.includes('\r') || str.includes('\n')) {
    // 先处理可能的输入字符（在 \r\n 之前的内容）
    const beforeEnter = str.split(/\r|\n/)[0];
    if (beforeEnter) {
      screen.handleInput(beforeEnter);
    }

    const content = screen.getContent();
    if (content) {
      const width = calculateWidth(content);
      const charCount = [...content].length;

      screen.appendScroll(`\x1b[32m输入:\x1b[0m "${content}"\n`);
      screen.appendScroll(`\x1b[32m字符数:\x1b[0m ${charCount}\n`);
      screen.appendScroll(`\x1b[32m显示宽度:\x1b[0m ${width}\n\n`);
    }

    screen.clear();
    screen.restoreCursor();
    return;
  }

  // 普通输入
  const shouldSend = screen.handleInput(str);
  if (shouldSend) {
    const content = screen.getContent();
    const width = calculateWidth(content);
    const charCount = [...content].length;

    screen.appendScroll(`\x1b[32m输入:\x1b[0m "${content}"\n`);
    screen.appendScroll(`\x1b[32m字符数:\x1b[0m ${charCount}\n`);
    screen.appendScroll(`\x1b[32m显示宽度:\x1b[0m ${width}\n\n`);

    screen.clear();
    screen.restoreCursor();
  }
});

// 保持进程运行
process.stdin.resume();
