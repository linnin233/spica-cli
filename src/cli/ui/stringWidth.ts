// 多语言优化 - 中英文混合显示对齐
// 中文字符宽度为2，英文为1，用于终端对齐

// 判断是否是CJK字符（中日韩）
export function isCJK(char: string): boolean {
  const codePoint = char.codePointAt(0);
  if (!codePoint) return false;

  // CJK Unified Ideographs: U+4E00 - U+9FFF
  // CJK Unified Ideographs Extension A: U+3400 - U+4DBF
  // CJK Unified Ideographs Extension B: U+20000 - U+2A6DF
  // CJK Compatibility Ideographs: U+F900 - U+FAFF
  // CJK Symbols and Punctuation: U+3000 - U+303F
  // Hiragana: U+3040 - U+309F
  // Katakana: U+30A0 - U+30FF
  // Hangul Syllables: U+AC00 - U+D7AF

  return (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x20000 && codePoint <= 0x2a6df) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x3000 && codePoint <= 0x303f) ||
    (codePoint >= 0x3040 && codePoint <= 0x309f) ||
    (codePoint >= 0x30a0 && codePoint <= 0x30ff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af)
  );
}

// 判断是否是全角字符（导出供其他模块使用）
export function isFullWidth(char: string): boolean {
  const codePoint = char.codePointAt(0);
  if (!codePoint) return false;

  // Fullwidth ASCII variants: U+FF01 - U+FF5E
  // Fullwidth symbol variants: various ranges
  return (codePoint >= 0xff01 && codePoint <= 0xff5e) || isCJK(char);
}

// 获取字符串显示宽度（终端列数）
export function getStringWidth(str: string): number {
  let width = 0;
  for (const char of str) {
    // 控制字符和零宽字符不计
    const codePoint = char.codePointAt(0);
    if (!codePoint) continue;

    // 忽略控制字符 (0-31) 和零宽字符
    if (codePoint < 32 || (codePoint >= 0x200b && codePoint <= 0x200f)) {
      continue;
    }

    width += isFullWidth(char) ? 2 : 1;
  }
  return width;
}

// 用空格填充到目标宽度（右填充）
export function padRight(str: string, targetWidth: number): string {
  const currentWidth = getStringWidth(str);
  const padding = Math.max(0, targetWidth - currentWidth);
  return str + ' '.repeat(padding);
}

// 用空格填充到目标宽度（左填充）
export function padLeft(str: string, targetWidth: number): string {
  const currentWidth = getStringWidth(str);
  const padding = Math.max(0, targetWidth - currentWidth);
  return ' '.repeat(padding) + str;
}

// 用空格填充到目标宽度（居中）
export function padCenter(str: string, targetWidth: number): string {
  const currentWidth = getStringWidth(str);
  const totalPadding = Math.max(0, targetWidth - currentWidth);
  const leftPadding = Math.floor(totalPadding / 2);
  const rightPadding = totalPadding - leftPadding;
  return ' '.repeat(leftPadding) + str + ' '.repeat(rightPadding);
}

// 截断字符串到指定宽度（保留显示宽度）
export function truncateToWidth(str: string, maxWidth: number): string {
  let result = '';
  let width = 0;

  for (const char of str) {
    const charWidth = isFullWidth(char) ? 2 : 1;
    if (width + charWidth > maxWidth) {
      break;
    }
    result += char;
    width += charWidth;
  }

  return result;
}

// 对齐多行文本（左对齐）
export function alignLines(lines: string[], width: number): string[] {
  return lines.map(line => padRight(line, width));
}

// 创建表格行（自动对齐）
export function formatTableRow(columns: string[], widths: number[]): string {
  return columns.map((col, i) => padRight(truncateToWidth(col, widths[i]), widths[i])).join(' | ');
}

// 获取字符串中每个字符的宽度数组
export function getCharWidths(str: string): number[] {
  return Array.from(str).map(char => (isFullWidth(char) ? 2 : 1));
}

// 在指定宽度位置分割字符串
export function splitAtWidth(str: string, width: number): [string, string] {
  let left = '';
  let leftWidth = 0;

  for (const char of str) {
    const charWidth = isFullWidth(char) ? 2 : 1;
    if (leftWidth + charWidth > width) {
      return [left, str.slice(left.length)];
    }
    left += char;
    leftWidth += charWidth;
  }

  return [str, ''];
}

// 测试函数
export function testStringWidth(): void {
  const testCases = [
    ['hello', 5],
    ['你好', 4],
    ['hello你好', 9],
    ['测试Test混合', 10],
    ['  space', 7],
  ];

  console.log('String Width Tests:');
  testCases.forEach(([str, expected]) => {
    const actual = getStringWidth(str as string);
    const pass = actual === expected;
    console.log(`  "${str}" => ${actual} (expected: ${expected}) ${pass ? '[OK]' : '[ERR]'}`);
  });
}
