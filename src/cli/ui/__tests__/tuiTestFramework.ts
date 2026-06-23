/**
 * TUI 测试框架
 *
 * 使用 node-pty 创建真正的伪终端(PTY)来测试 TUI 应用
 * 这允许模拟真实的用户输入和捕获 ANSI 输出序列
 *
 * 核心原理：
 * 1. PTY 提供真实的终端环境（支持 raw mode、ANSI 序列）
 * 2. 可以发送真实的键盘输入（包括特殊键如箭头键）
 * 3. 可以捕获完整的 ANSI 输出序列进行分析
 * 4. 可以验证光标位置、屏幕内容等
 */

import * as pty from 'node-pty';
import { spawn } from 'child_process';

export interface TUITestResult {
  success: boolean;
  output: string;
  cursorPositions: Array<{ row: number; col: number }>;
  error?: string;
}

export interface TUITestOptions {
  /** 测试脚本路径 */
  scriptPath: string;
  /** 输入序列（模拟用户按键） */
  inputs: string[];
  /** 每个输入后的等待时间（毫秒） */
  inputDelay?: number;
  /** 总测试超时时间（毫秒） */
  timeout?: number;
  /** 期望的光标位置 */
  expectedCursorPositions?: Array<{ row: number; col: number }>;
  /** 期望在输出中看到的内容 */
  expectedOutputPatterns?: string[];
}

/**
 * 解析 ANSI 序列中的光标位置
 * 格式: ESC[row;colH 或 ESC[row;colf
 */
export function parseCursorPosition(output: string): Array<{ row: number; col: number }> {
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
 * 解析 ANSI 序列中的屏幕内容
 * 提取实际显示的文本（去除控制序列）
 */
export function parseScreenContent(output: string): string {
  // 移除所有 ANSI 控制序列
  return output
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '') // CSI 序列
    .replace(/\x1b\][^\x07]*\x07/g, '') // OSC 序列
    .replace(/\x1b[()][AB012]/g, '') // 字符集选择
    .replace(/\x1b[78]/g, '') // 保存/恢复光标
    .replace(/\x07/g, '') // BEL
    .replace(/\x1b\[\?[\d;]*[hl]/g, '') // 私有模式设置
    .trim();
}

/**
 * 提取输入框内容（根据 TUI 格式）
 * 格式通常是: "> 内容" 在最后一行
 */
export function extractInputContent(output: string): string {
  const lines = output.split('\n');
  // 查找以 "> " 开头的行
  for (const line of lines) {
    const cleanLine = parseScreenContent(line);
    if (cleanLine.startsWith('> ')) {
      return cleanLine.slice(2);
    }
  }
  return '';
}

/**
 * 模拟键盘输入序列
 * 将按键转换为 PTY 可以接受的格式
 */
export const KeySequences = {
  // 特殊键
  Enter: '\r',
  Backspace: '\x7f',
  Tab: '\t',
  Escape: '\x1b',
  CtrlC: '\x03',

  // 箭头键
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',

  // 功能键
  F1: '\x1bOP',
  F2: '\x1bOQ',

  // Home/End
  Home: '\x1b[H',
  End: '\x1b[F',

  // Delete
  Delete: '\x1b[3~',

  // 粘贴序列（Bracketed Paste Mode）
  PasteStart: '\x1b[200~',
  PasteEnd: '\x1b[201~',

  // 创建粘贴内容
  paste: (content: string) => `\x1b[200~${content}\x1b[201~`,
};

/**
 * 运行 TUI 测试
 */
export async function runTUITest(options: TUITestOptions): Promise<TUITestResult> {
  const {
    scriptPath,
    inputs,
    inputDelay = 100,
    timeout = 5000,
    expectedCursorPositions,
    expectedOutputPatterns,
  } = options;

  return new Promise(resolve => {
    let output = '';
    let timeoutId: NodeJS.Timeout;

    // 创建 PTY 进程
    const ptyProcess = pty.spawn('npx', ['tsx', scriptPath], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env as { [key: string]: string },
    });

    // 捕获输出
    ptyProcess.onData((data: string) => {
      output += data;
    });

    // 设置超时
    timeoutId = setTimeout(() => {
      ptyProcess.kill();
      resolve({
        success: false,
        output,
        cursorPositions: parseCursorPosition(output),
        error: `Timeout after ${timeout}ms`,
      });
    }, timeout);

    // 进程结束
    ptyProcess.onExit(({ exitCode }) => {
      clearTimeout(timeoutId);

      const cursorPositions = parseCursorPosition(output);
      const screenContent = parseScreenContent(output);

      // 检查期望的光标位置
      let cursorMatch = true;
      if (expectedCursorPositions && expectedCursorPositions.length > 0) {
        // 检查最后一个光标位置是否匹配期望
        const lastPos = cursorPositions[cursorPositions.length - 1];
        const expectedPos = expectedCursorPositions[expectedCursorPositions.length - 1];
        if (lastPos && expectedPos) {
          cursorMatch = lastPos.row === expectedPos.row && lastPos.col === expectedPos.col;
        }
      }

      // 检查期望的输出模式
      let outputMatch = true;
      if (expectedOutputPatterns && expectedOutputPatterns.length > 0) {
        for (const pattern of expectedOutputPatterns) {
          if (!output.includes(pattern)) {
            outputMatch = false;
            break;
          }
        }
      }

      resolve({
        success: exitCode === 0 && cursorMatch && outputMatch,
        output,
        cursorPositions,
        error:
          exitCode !== 0
            ? `Exit code: ${exitCode}`
            : !cursorMatch
              ? 'Cursor position mismatch'
              : !outputMatch
                ? 'Output pattern not found'
                : undefined,
      });
    });

    // 发送输入序列
    let inputIndex = 0;
    const sendNextInput = () => {
      if (inputIndex < inputs.length) {
        ptyProcess.write(inputs[inputIndex]);
        inputIndex++;
        setTimeout(sendNextInput, inputDelay);
      } else {
        // 所有输入发送完毕，发送退出命令
        setTimeout(() => {
          ptyProcess.write(KeySequences.CtrlC);
          setTimeout(() => {
            ptyProcess.write(KeySequences.CtrlC); // 双击 CtrlC 确保退出
          }, 100);
        }, 500);
      }
    };

    // 等待进程启动后开始发送输入
    setTimeout(sendNextInput, 200);
  });
}

/**
 * 快速测试单个输入场景
 */
export async function quickTUITest(
  scriptPath: string,
  inputs: string[],
  expectedContent?: string
): Promise<{ passed: boolean; output: string; inputContent: string }> {
  const result = await runTUITest({
    scriptPath,
    inputs,
    timeout: 3000,
  });

  const inputContent = extractInputContent(result.output);

  return {
    passed: expectedContent ? inputContent.includes(expectedContent) : result.success,
    output: result.output,
    inputContent,
  };
}

/**
 * 创建简单的 TUI 测试脚本（用于测试）
 * 这个脚本会读取输入并显示光标位置
 */
export function createSimpleTUIScript(): string {
  return `
import { getScreenManager } from './src/cli/ui/screenManager';

const screen = getScreenManager();
screen.start();

// 显示测试提示
screen.appendScroll('=== TUI Test ===\\n');
screen.appendScroll('输入内容后按 Enter\\n');
screen.appendScroll('按 Ctrl+C 退出\\n\\n');

screen.restoreCursor();

// 设置输入处理
let lastContent = '';
process.stdin.on('data', (data: Buffer) => {
  const str = data.toString('utf8');

  if (str === '\\x03') {
    screen.end();
    process.exit(0);
    return;
  }

  const shouldSend = screen.handleInput(str);
  if (shouldSend) {
    lastContent = screen.getContent();
    screen.appendScroll('Content: ' + lastContent + '\\n');
    screen.appendScroll('Width: ' + calculateWidth(lastContent) + ' chars\\n\\n');
    screen.clear();
  }
});

function calculateWidth(str: string): number {
  let w = 0;
  for (const c of str) {
    const code = c.codePointAt(0) || 0;
    if (code >= 0x4E00 && code <= 0x9FFF || code >= 0xFF01 && code <= 0xFF5E) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}
`;
}
