// 稳定的输入处理 - 解决粘贴、Unicode、Ctrl+C 问题
// 使用 Bracketed Paste Mode 确保粘贴内容作为整体到达

const ESC = '\x1b';

// Bracketed Paste Mode 控制
const ENABLE_BRACKETED_PASTE = `${ESC}[?2004h`;
const DISABLE_BRACKETED_PASTE = `${ESC}[?2004l`;

// Paste 序列标记
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

// 计算 Unicode 字符显示宽度
function getCharWidth(char: string): number {
  // 换行符不计入宽度
  if (char === '\n' || char === '\r') {
    return 0;
  }
  // CJK 字符宽度为 2
  if (/[\u{3000}-\u{9fff}\u{ff00}-\u{ffef}\u{4e00}-\u{9fff}]/u.test(char)) {
    return 2;
  }
  // 其他字符宽度为 1
  return 1;
}

// 计算字符串显示宽度
export function getStringWidth(str: string): number {
  let width = 0;
  for (const char of str) {
    width += getCharWidth(char);
  }
  return width;
}

// 输入状态
interface InputState {
  buffer: string;
  cursorPos: number;
  isPasteMode: boolean;
  pasteBuffer: string;
  interrupted: boolean;
}

// 创建稳定的输入处理器
export function createInputHandler(onSubmit: (text: string) => void, onInterrupt: () => void) {
  const state: InputState = {
    buffer: '',
    cursorPos: 0,
    isPasteMode: false,
    pasteBuffer: '',
    interrupted: false,
  };

  // 启用 bracketed paste mode
  process.stdout.write(ENABLE_BRACKETED_PASTE);

  // 设置 raw mode
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  // 处理输入
  const handleData = (data: Buffer) => {
    const str = data.toString('utf8');

    // 检测 Ctrl+C (ETX = 0x03)
    if (str === '\x03' || str.charCodeAt(0) === 3) {
      if (!state.interrupted) {
        state.interrupted = true;
        onInterrupt();
        // 清空缓冲区
        state.buffer = '';
        state.cursorPos = 0;
        render();
      }
      return;
    }

    // 重置 interrupt 状态（用户继续输入）
    state.interrupted = false;

    // 检测粘贴开始
    if (str.includes(PASTE_START)) {
      state.isPasteMode = true;
      state.pasteBuffer = '';
      // 提取粘贴开始后的内容
      const afterStart = str.split(PASTE_START).pop() || '';
      if (afterStart.includes(PASTE_END)) {
        // 粘贴内容在同一数据块中
        const pasteContent = afterStart.split(PASTE_END)[0];
        handlePaste(pasteContent);
        state.isPasteMode = false;
        // 处理粘贴结束后的内容
        const afterEnd = afterStart.split(PASTE_END).pop() || '';
        if (afterEnd) {
          handleData(Buffer.from(afterEnd));
        }
      } else {
        state.pasteBuffer = afterStart;
      }
      return;
    }

    // 检测粘贴结束
    if (str.includes(PASTE_END)) {
      if (state.isPasteMode) {
        const beforeEnd = str.split(PASTE_END)[0];
        state.pasteBuffer += beforeEnd;
        handlePaste(state.pasteBuffer);
        state.isPasteMode = false;
        state.pasteBuffer = '';
        // 处理粘贴结束后的内容
        const afterEnd = str.split(PASTE_END).pop() || '';
        if (afterEnd) {
          handleData(Buffer.from(afterEnd));
        }
      }
      return;
    }

    // 正在粘贴中，累积内容
    if (state.isPasteMode) {
      state.pasteBuffer += str;
      return;
    }

    // 处理普通按键
    handleKeyPress(str);
  };

  // 处理粘贴内容
  const handlePaste = (text: string) => {
    // 规范化换行符
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // Insert into buffer instead of immediate submit — lets user review/edit
    // before pressing Enter. Multi-line content is preserved with \n chars.
    const before = [...state.buffer].slice(0, state.cursorPos).join('');
    const after = [...state.buffer].slice(state.cursorPos).join('');
    state.buffer = before + normalized + after;
    state.cursorPos += [...normalized].length;
    render();
  };

  // 处理单个按键
  const handleKeyPress = (str: string) => {
    // Enter - 提交
    if (str === '\n' || str === '\r') {
      onSubmit(state.buffer);
      state.buffer = '';
      state.cursorPos = 0;
      return;
    }

    // Backspace (BS = 0x08 或 DEL = 0x7f)
    if (str === '\x08' || str === '\x7f' || str.charCodeAt(0) === 127) {
      if (state.cursorPos > 0) {
        // 找到光标前的字符
        const chars = [...state.buffer];
        chars.splice(state.cursorPos - 1, 1);
        state.buffer = chars.join('');
        state.cursorPos--;
      }
      render();
      return;
    }

    // 左箭头
    if (str === `${ESC}[D`) {
      if (state.cursorPos > 0) {
        state.cursorPos--;
        render();
      }
      return;
    }

    // 右箭头
    if (str === `${ESC}[C`) {
      if (state.cursorPos < state.buffer.length) {
        state.cursorPos++;
        render();
      }
      return;
    }

    // Tab
    if (str === '\t') {
      // Tab 补全由外部处理
      return;
    }

    // 普通字符 - 插入
    if (str.length > 0 && !str.startsWith(ESC)) {
      const graphemes = [...str]; // grapheme clusters for correct cursor advance
      const chars = [...state.buffer];
      chars.splice(state.cursorPos, 0, ...graphemes);
      state.buffer = chars.join('');
      state.cursorPos += graphemes.length;
      render();
    }
  };

  // 渲染输入行
  const render = () => {
    const width = getStringWidth(state.buffer.slice(0, state.cursorPos));
    process.stdout.write(`${ESC}[2K${ESC}[1G`);
    process.stdout.write(`> ${state.buffer}`);
    // 移动光标到正确位置
    process.stdout.write(`${ESC}[2;${width + 3}H`);
  };

  // 监听数据
  process.stdin.on('data', handleData);

  // 清理函数
  const cleanup = () => {
    process.stdout.write(DISABLE_BRACKETED_PASTE);
    process.stdin.removeListener('data', handleData);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
  };

  return {
    cleanup,
    getBuffer: () => state.buffer,
    clearBuffer: () => {
      state.buffer = '';
      state.cursorPos = 0;
      render();
    },
    render,
  };
}

// 替代 readline 的简单版本
export function createStableREPL(onSubmit: (text: string) => Promise<void>) {
  let isProcessing = false;
  const interruptResolve: ((approved: boolean) => void) | null = null;

  const handler = createInputHandler(
    async (text: string) => {
      if (isProcessing) {
        // 正在处理，显示提示
        process.stdout.write(`\n${ESC}[2K${ESC}[1G`);
        process.stdout.write(`> Processing... (input queued)\n`);
        handler.render();
        return;
      }

      const trimmed = text.trim();
      if (!trimmed) {
        handler.render();
        return;
      }

      isProcessing = true;
      try {
        await onSubmit(trimmed);
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.log(`Error: ${errorMsg}`);
      }
      isProcessing = false;
      handler.render();
    },
    () => {
      // Ctrl+C 处理
      if (interruptResolve) {
        // 已经在等待 interrupt 确认，不做任何事
        return;
      }
      console.log('\n[INTERRUPTED]');
      handler.clearBuffer();
    }
  );

  return {
    ...handler,
    interrupt: () => {
      isProcessing = false;
      handler.clearBuffer();
    },
  };
}
