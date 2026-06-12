/**
 * TUI 自动化测试 - 使用 node-pty 模拟真实终端
 *
 * 测试目标：
 * 1. 全角字符输入和光标定位
 * 2. 箄头键移动光标
 * 3. 粘贴操作
 * 4. 输入框操作保护
 *
 * Note: node-pty may not work correctly on Windows CI
 */

import * as pty from 'node-pty';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const isWindows = process.platform === 'win32';
const shouldSkipPty = isWindows && process.env.CI === 'true';

// 键盘输入序列
const Keys = {
  Enter: '\r',
  Backspace: '\b', // 使用 BS (0x08) 而不是 DEL (0x7f)，因为 PTY 会转换 DEL
  BackspaceDel: '\x7f', // DEL (127) - 某些终端使用这个
  Tab: '\t',
  Escape: '\x1b',
  CtrlC: '\x03',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  Delete: '\x1b[3~',
  // 粘贴序列
  paste: (content: string) => `\x1b[200~${content}\x1b[201~`,
};

interface PTYTestResult {
  output: string;
  exitCode: number;
}

/**
 * 使用 PTY 运行 TUI 测试
 */
async function runPTYTest(
  scriptPath: string,
  inputs: string[],
  options: {
    cols?: number;
    rows?: number;
    timeout?: number;
    inputDelay?: number;
  } = {}
): Promise<PTYTestResult> {
  const { cols = 80, rows = 24, timeout = 15000, inputDelay = 150 } = options;

  return new Promise((resolve, reject) => {
    let output = '';
    const timeoutId = setTimeout(() => {
      // 超时时也要返回已捕获的输出
      resolve({ output, exitCode: -1 });
    }, timeout);

    // 创建 PTY 进程
    const ptyProcess = pty.spawn('npx', ['tsx', scriptPath], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: '0' } as Record<string, string>, // 禁用颜色减少干扰
    });

    // 捕获输出
    ptyProcess.onData((data: string) => {
      output += data;
    });

    // 进程退出
    ptyProcess.onExit(({ exitCode }) => {
      clearTimeout(timeoutId);
      resolve({ output, exitCode });
    });

    // 发送输入
    let inputIndex = 0;
    const sendNext = () => {
      if (inputIndex < inputs.length) {
        ptyProcess.write(inputs[inputIndex]);
        inputIndex++;
        setTimeout(sendNext, inputDelay);
      } else {
        // 发送退出信号
        setTimeout(() => {
          ptyProcess.write(Keys.CtrlC);
        }, 500);
      }
    };

    // 等待脚本准备好（检测启动标记）后开始发送输入
    const startTime = Date.now();
    const maxWait = 5000;
    const checkReady = () => {
      if (output.includes('=== TUI State Test Start ===')) {
        setTimeout(sendNext, 200); // 确认后再等待200ms
      } else if (Date.now() - startTime < maxWait) {
        setTimeout(checkReady, 100);
      } else {
        // 超时也继续发送
        sendNext();
      }
    };
    setTimeout(checkReady, 100);
  });
}

/**
 * 解析 ANSI 输出中的光标位置
 */
function extractCursorPositions(output: string): Array<{ row: number; col: number }> {
  const positions: Array<{ row: number; col: number }> = [];
  const regex = /\x1b\[(\d+);(\d+)[Hf]/g;
  let match;
  while ((match = regex.exec(output)) !== null) {
    positions.push({
      row: parseInt(match[1]),
      col: parseInt(match[2]),
    });
  }
  return positions;
}

/**
 * 清理 ANSI 序列获取纯文本
 */
function cleanANSI(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\x07/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

/**
 * 提取输入框内容（以 "> " 开头的行）
 */
function extractInputContent(output: string): string[] {
  const lines = cleanANSI(output).split('\n');
  return lines.filter(line => line.startsWith('> ')).map(line => line.slice(2).trim());
}

describe.skipIf(shouldSkipPty)('TUI Automated Tests with PTY', () => {
  const scriptPath = 'src/cli/ui/__tests__/tuiStateTest.ts';

  describe('Basic Input Tests', () => {
    it('should accept and display ASCII input', async () => {
      const result = await runPTYTest(scriptPath, ['hello', Keys.Enter]);

      expect(result.output).toContain('hello');
      expect(result.output).toContain('CharCount: 5');
    });

    it('should accept and display Chinese input', async () => {
      const result = await runPTYTest(scriptPath, ['你好', Keys.Enter]);

      expect(result.output).toContain('你好');
      expect(result.output).toContain('CharCount: 2');
      expect(result.output).toContain('DisplayWidth: 4');
    });

    it('should handle fullwidth punctuation', async () => {
      const result = await runPTYTest(scriptPath, ['！？，。', Keys.Enter]);

      expect(result.output).toContain('！？，。');
      expect(result.output).toContain('CharCount: 4');
      expect(result.output).toContain('DisplayWidth: 8');
    });

    it('should handle mixed Chinese and ASCII', async () => {
      const result = await runPTYTest(scriptPath, ['Hello世界', Keys.Enter]);

      expect(result.output).toContain('Hello世界');
      expect(result.output).toContain('CharCount: 7');
      expect(result.output).toContain('DisplayWidth: 9'); // 5 ASCII + 4 CJK
    });
  });

  describe('Cursor Movement Tests', () => {
    it('should handle backspace correctly', async () => {
      const result = await runPTYTest(scriptPath, ['abc', Keys.Backspace, Keys.Enter]);

      expect(result.output).toContain('ab');
      expect(result.output).toContain('CharCount: 2');
    });

    it('should handle backspace with Chinese characters', async () => {
      const result = await runPTYTest(scriptPath, ['你好', Keys.Backspace, Keys.Enter]);

      expect(result.output).toContain('你');
      expect(result.output).toContain('CharCount: 1');
    });

    it('should handle arrow key movement', async () => {
      // 输入内容，然后左移一次，删除一个字符
      // test + left => tes|t => backspace 删除 s => tet
      const result = await runPTYTest(scriptPath, [
        'test',
        Keys.ArrowLeft, // 光标从4移到3，在 'tes|t'
        Keys.Backspace, // 删除位置2的 's'
        Keys.Enter,
      ]);

      expect(result.output).toContain('tet'); // 删除了 's'
    });

    it('should handle arrow keys with Chinese', async () => {
      // 输入中文，左移一次，删除
      // 你好世界 + left => 你好世|界 => backspace 删除 '世' => 你好界
      const result = await runPTYTest(scriptPath, [
        '你好世界',
        Keys.ArrowLeft,
        Keys.Backspace,
        Keys.Enter,
      ]);

      expect(result.output).toContain('你好界'); // 删除了 '世'
    });
  });

  describe('Paste Tests', () => {
    it('should handle paste content', async () => {
      const pasteContent = '粘贴测试';
      const result = await runPTYTest(scriptPath, [Keys.paste(pasteContent), Keys.Enter]);

      expect(result.output).toContain('粘贴测试');
    });

    it('should handle mixed paste content', async () => {
      const pasteContent = 'Hello世界！';
      const result = await runPTYTest(scriptPath, [Keys.paste(pasteContent), Keys.Enter]);

      expect(result.output).toContain('Hello世界！');
      expect(result.output).toContain('CharCount: 8');
      expect(result.output).toContain('DisplayWidth: 11'); // 5 + 4 + 2
    });
  });

  describe('Cursor Position Tests', () => {
    it('should correctly calculate cursor position after input', async () => {
      const result = await runPTYTest(scriptPath, ['你好', Keys.Enter]);

      // 测试脚本输出光标状态信息，而不是 ANSI 光标定位序列
      expect(result.output).toContain('你好');
      expect(result.output).toContain('CharCount: 2');
      expect(result.output).toContain('DisplayWidth: 4'); // 中文每个字符宽度为 2
    });

    it('should calculate display width correctly for complex content', async () => {
      const result = await runPTYTest(scriptPath, ['测试Test！？', Keys.Enter]);

      expect(result.output).toContain('测试Test！？');
      // 2 + 2 + 4 + 2 + 2 = 12
      expect(result.output).toContain('DisplayWidth: 12');
    });
  });

  describe('Input Protection Tests', () => {
    it('should handle rapid input without corruption', async () => {
      // 快速输入多个字符
      const inputs = 'abcdefghijklmnopqrstuvwxyz'.split('');
      inputs.push(Keys.Enter);

      const result = await runPTYTest(scriptPath, inputs, { inputDelay: 10 });

      expect(result.output).toContain('abcdefghijklmnopqrstuvwxyz');
    });

    it('should handle rapid Chinese input', async () => {
      // 快速输入中文
      const inputs = ['你', '好', '世', '界', Keys.Enter];
      const result = await runPTYTest(scriptPath, inputs, { inputDelay: 30 });

      expect(result.output).toContain('你好世界');
    });
  });
});
