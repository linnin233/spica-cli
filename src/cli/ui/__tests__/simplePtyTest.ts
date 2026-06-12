/**
 * 简化的 TUI 测试脚本 - 不使用完整的 ScreenManager
 * 直接验证 PTY 输入输出
 */
import * as readline from 'readline';

// 创建简单的 readline 接口
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log('=== Simple TUI Test ===');
console.log('输入内容后按 Enter');
console.log('按 Ctrl+C 退出');
console.log('');

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

rl.on('line', (input: string) => {
  const charCount = [...input].length;
  const width = calculateWidth(input);

  console.log(`输入: "${input}"`);
  console.log(`字符数: ${charCount}`);
  console.log(`显示宽度: ${width}`);
  console.log('');
});

rl.on('close', () => {
  console.log('退出');
  process.exit(0);
});
