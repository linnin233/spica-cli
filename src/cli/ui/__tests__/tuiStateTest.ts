/* eslint-disable no-control-regex, no-useless-escape -- test file with ANSI escape codes */
/**
 * TUI 状态测试脚本 - 简化版
 */

import { getScreenManager } from '../screenManager';
import { isFullWidth } from '../stringWidth';

const screen = getScreenManager();
screen.state.inputBuffer = [''];
screen.state.cursorCol = 0;

// 立即输出欢迎信息，确保在 stdin 事件之前
process.stdout.write('=== TUI State Test Start ===\n');

function calculateWidth(str: string): number {
  let w = 0;
  for (const c of str) {
    if (isFullWidth(c)) w += 2;
    else if (c !== '\n') w += 1;
  }
  return w;
}

function outputFinalResult(): void {
  const content = screen.state.inputBuffer[0];
  const charCount = [...content].length;
  const width = calculateWidth(content);

  process.stdout.write('\n=== FINAL RESULT ===\n');
  process.stdout.write(`Input: "${content}"\n`);
  process.stdout.write(`CharCount: ${charCount}\n`);
  process.stdout.write(`DisplayWidth: ${width}\n`);
  process.stdout.write('=== END ===\n');
}

function parseInput(str: string): { normalChars: string; ansiSequences: string[] } {
  const normalChars: string[] = [];
  const ansiSequences: string[] = [];

  let i = 0;
  while (i < str.length) {
    const code = str.charCodeAt(i);

    if (str[i] === '\x1b' || code === 27) {
      let seqEnd = i + 1;
      while (seqEnd < str.length && str[seqEnd].match(/[A-Za-z0-9[;?]/)) {
        seqEnd++;
      }
      if (seqEnd < str.length && str[seqEnd].match(/[A-Za-z]/)) {
        seqEnd++;
      }
      ansiSequences.push(str.slice(i, seqEnd));
      i = seqEnd;
    } else if (str[i] === '\r' || str[i] === '\n') {
      i++;
    } else if (code >= 32 && code < 127) {
      normalChars.push(str[i]);
      i++;
    } else if (code >= 128) {
      normalChars.push(str[i]);
      i++;
    } else {
      // 控制字符：BS (8), DEL (127), 等
      ansiSequences.push(str[i]);
      i++;
    }
  }

  return { normalChars: normalChars.join(''), ansiSequences };
}

function handleAnsiSequence(seq: string): void {
  if (seq === '\x1b[D' || seq.includes('[D')) {
    if (screen.state.cursorCol > 0) screen.state.cursorCol--;
    return;
  }
  if (seq === '\x1b[C' || seq.includes('[C')) {
    if (screen.state.cursorCol < screen.state.inputBuffer[0].length) screen.state.cursorCol++;
    return;
  }
  // Backspace: BS (0x08) 或 DEL (0x7f)
  if (seq === '\x7f' || seq === '\b' || seq.charCodeAt(0) === 127 || seq.charCodeAt(0) === 8) {
    if (screen.state.cursorCol > 0) {
      screen.state.inputBuffer[0] =
        screen.state.inputBuffer[0].slice(0, screen.state.cursorCol - 1) +
        screen.state.inputBuffer[0].slice(screen.state.cursorCol);
      screen.state.cursorCol--;
    }
    return;
  }
}

let pendingInput = '';

process.stdin.on('data', (data: Buffer) => {
  const str = data.toString('utf8');
  pendingInput += str;

  if (pendingInput.includes('\x03')) {
    process.stdout.write('\n=== Exiting ===\n');
    process.exit(0);
    return;
  }

  // 处理粘贴序列（Bracketed Paste Mode）
  // PTY 发送的格式可能是 ^[[200~ 或 \x1b[200~
  if (
    pendingInput.includes('\x1b[200~') ||
    pendingInput.includes('[200~') ||
    pendingInput.includes('[200~')
  ) {
    // 等待粘贴结束序列
    if (
      pendingInput.includes('\x1b[201~') ||
      pendingInput.includes('[201~') ||
      pendingInput.includes('[201~')
    ) {
      // 提取粘贴内容
      let content = pendingInput;
      // 移除粘贴序列标记
      content = content.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '');
      content = content.replace(/\[200~/g, '').replace(/\[201~/g, '');
      content = content.replace(/\[200~/g, '').replace(/\[201~/g, '');
      // 去掉控制字符
      content = content.replace(/\x03/g, '').replace(/\r/g, '').replace(/\n/g, '');

      if (content) {
        screen.state.inputBuffer[0] += content;
        screen.state.cursorCol += [...content].length;
        outputFinalResult();
        screen.state.inputBuffer = [''];
        screen.state.cursorCol = 0;
      }
      pendingInput = '';
      return;
    }
    // 等待粘贴结束序列
    return;
  }

  if (pendingInput.includes('\r') || pendingInput.includes('\n')) {
    const parts = pendingInput.split(/\r|\n/);
    const beforeEnter = parts[0] || '';

    const parsed = parseInput(beforeEnter);
    screen.state.inputBuffer[0] += parsed.normalChars;
    screen.state.cursorCol += [...parsed.normalChars].length;
    for (const seq of parsed.ansiSequences) handleAnsiSequence(seq);

    outputFinalResult();
    screen.state.inputBuffer = [''];
    screen.state.cursorCol = 0;
    pendingInput = parts.slice(1).join('\n');
    return;
  }

  const parsed = parseInput(pendingInput);
  screen.state.inputBuffer[0] += parsed.normalChars;
  screen.state.cursorCol += [...parsed.normalChars].length;
  for (const seq of parsed.ansiSequences) handleAnsiSequence(seq);

  pendingInput = '';
});

process.stdin.resume();
