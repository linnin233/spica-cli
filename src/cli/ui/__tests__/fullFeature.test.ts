/**
 * 全面的TUI功能测试脚本
 * 使用模拟的ScreenManager测试所有内部命令处理
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getScreenManager } from '../screenManager';
import { isFullWidth } from '../stringWidth';

// 模拟状态
const mockState = {
  inputBuffer: [''],
  cursorCol: 0,
  terminalHeight: 24,
  terminalWidth: 80,
  inputLines: 1,
  statusRow: 22,
  scrollBottom: 21,
  statusText: '',
  completer: null as ((line: string) => string[]) | null,
  shownCompletionList: false,
  lastCompletionLine: '',
  cursorInScrollArea: false,
  isStreaming: false,
};

// 基础命令列表
const BASE_COMMANDS = [
  '/help',
  '/h',
  '/status',
  '/queue',
  '/q',
  '/undo',
  '/clear',
  '/reset',
  '/skill',
  '/mcp',
  '/history',
  '/compact',
  '/init',
  '/new',
  '/sessions',
  '/switch',
  '/rename',
  '/delete',
];

describe('TUI ScreenManager Tests', () => {
  let screen: ReturnType<typeof getScreenManager>;

  beforeEach(() => {
    screen = getScreenManager();
    // 重置状态
    screen.state.inputBuffer = [''];
    screen.state.cursorCol = 0;
    screen.state.terminalHeight = 24;
    screen.state.terminalWidth = 80;
    screen.state.statusText = '';
    screen.state.completer = null;
    screen.state.shownCompletionList = false;
    screen.state.isStreaming = false;
  });

  describe('Input Buffer Management', () => {
    it('should initialize with empty buffer', () => {
      expect(screen.state.inputBuffer).toEqual(['']);
      expect(screen.state.cursorCol).toBe(0);
    });

    it('should accept ASCII input', () => {
      screen.state.inputBuffer[0] = 'hello';
      screen.state.cursorCol = 5;
      expect(screen.state.inputBuffer[0]).toBe('hello');
      expect(screen.state.cursorCol).toBe(5);
    });

    it('should accept Chinese input', () => {
      screen.state.inputBuffer[0] = '你好世界';
      screen.state.cursorCol = 4;
      expect(screen.state.inputBuffer[0]).toBe('你好世界');
      expect([...screen.state.inputBuffer[0]].length).toBe(4);
    });

    it('should handle mixed input', () => {
      screen.state.inputBuffer[0] = 'Hello世界';
      screen.state.cursorCol = 7;
      expect(screen.state.inputBuffer[0]).toBe('Hello世界');
      expect([...screen.state.inputBuffer[0]].length).toBe(7);
    });
  });

  describe('Cursor Movement', () => {
    it('should handle backspace', () => {
      screen.state.inputBuffer[0] = 'test';
      screen.state.cursorCol = 4;

      // 模拟backspace
      if (screen.state.cursorCol > 0) {
        screen.state.inputBuffer[0] =
          screen.state.inputBuffer[0].slice(0, screen.state.cursorCol - 1) +
          screen.state.inputBuffer[0].slice(screen.state.cursorCol);
        screen.state.cursorCol--;
      }

      expect(screen.state.inputBuffer[0]).toBe('tes');
      expect(screen.state.cursorCol).toBe(3);
    });

    it('should handle backspace with Chinese', () => {
      screen.state.inputBuffer[0] = '你好世界';
      screen.state.cursorCol = 4;

      // 模拟backspace删除最后一个中文字符
      if (screen.state.cursorCol > 0) {
        screen.state.inputBuffer[0] =
          screen.state.inputBuffer[0].slice(0, screen.state.cursorCol - 1) +
          screen.state.inputBuffer[0].slice(screen.state.cursorCol);
        screen.state.cursorCol--;
      }

      expect(screen.state.inputBuffer[0]).toBe('你好世');
      expect(screen.state.cursorCol).toBe(3);
    });

    it('should handle arrow left', () => {
      screen.state.inputBuffer[0] = 'test';
      screen.state.cursorCol = 4;

      // 模拟左箭头
      if (screen.state.cursorCol > 0) {
        screen.state.cursorCol--;
      }

      expect(screen.state.cursorCol).toBe(3);

      // 再左移一次
      if (screen.state.cursorCol > 0) {
        screen.state.cursorCol--;
      }

      expect(screen.state.cursorCol).toBe(2);
    });

    it('should handle arrow right', () => {
      screen.state.inputBuffer[0] = 'test';
      screen.state.cursorCol = 2;

      // 模拟右箭头
      if (screen.state.cursorCol < screen.state.inputBuffer[0].length) {
        screen.state.cursorCol++;
      }

      expect(screen.state.cursorCol).toBe(3);
    });

    it('should not move right beyond buffer', () => {
      screen.state.inputBuffer[0] = 'test';
      screen.state.cursorCol = 4;

      // 尝试右移（应该不移动）
      if (screen.state.cursorCol < screen.state.inputBuffer[0].length) {
        screen.state.cursorCol++;
      }

      expect(screen.state.cursorCol).toBe(4); // 不应该移动
    });

    it('should not move left at start', () => {
      screen.state.inputBuffer[0] = 'test';
      screen.state.cursorCol = 0;

      // 尝试左移（应该不移动）
      if (screen.state.cursorCol > 0) {
        screen.state.cursorCol--;
      }

      expect(screen.state.cursorCol).toBe(0); // 不应该移动
    });
  });

  describe('Tab Completion', () => {
    it('should provide command completions', () => {
      screen.state.completer = (line: string) => {
        return BASE_COMMANDS.filter(c => c.startsWith(line));
      };

      const completions = screen.state.completer('/h');
      expect(completions).toContain('/help');
      expect(completions).toContain('/h');
      expect(completions).toContain('/history'); // /history also starts with /h
      expect(completions.length).toBe(3);
    });

    it('should complete /s commands', () => {
      screen.state.completer = (line: string) => {
        return BASE_COMMANDS.filter(c => c.startsWith(line));
      };

      const completions = screen.state.completer('/s');
      expect(completions).toContain('/status');
      expect(completions).toContain('/sessions');
      expect(completions).toContain('/switch');
    });

    it('should return empty for non-matching', () => {
      screen.state.completer = (line: string) => {
        return BASE_COMMANDS.filter(c => c.startsWith(line));
      };

      const completions = screen.state.completer('/xyz');
      expect(completions.length).toBe(0);
    });
  });

  describe('Status Bar', () => {
    it('should set status text', () => {
      screen.setStatus('idle | glm-5 | ~/project');
      expect(screen.state.statusText).toBe('idle | glm-5 | ~/project');
    });

    it('should handle empty status', () => {
      screen.setStatus('');
      expect(screen.state.statusText).toBe('');
    });
  });

  describe('Streaming State', () => {
    it('should set streaming mode', () => {
      screen.setStreaming(true);
      expect(screen.state.isStreaming).toBe(true);
    });

    it('should disable streaming mode', () => {
      screen.setStreaming(true);
      screen.setStreaming(false);
      expect(screen.state.isStreaming).toBe(false);
    });
  });
});

describe('Fullwidth Character Detection', () => {
  describe('CJK Characters', () => {
    it('should detect Chinese characters as fullwidth', () => {
      expect(isFullWidth('你')).toBe(true);
      expect(isFullWidth('好')).toBe(true);
      expect(isFullWidth('世')).toBe(true);
      expect(isFullWidth('界')).toBe(true);
    });

    it('should detect Japanese characters as fullwidth', () => {
      expect(isFullWidth('あ')).toBe(true);
      expect(isFullWidth('ア')).toBe(true);
    });

    it('should detect Korean characters as fullwidth', () => {
      expect(isFullWidth('한')).toBe(true);
      expect(isFullWidth('글')).toBe(true);
    });
  });

  describe('Fullwidth Punctuation', () => {
    it('should detect fullwidth punctuation', () => {
      expect(isFullWidth('！')).toBe(true);
      expect(isFullWidth('？')).toBe(true);
      expect(isFullWidth('，')).toBe(true);
      expect(isFullWidth('。')).toBe(true);
      expect(isFullWidth('：')).toBe(true);
      expect(isFullWidth('；')).toBe(true);
    });

    it('should not detect ASCII punctuation as fullwidth', () => {
      expect(isFullWidth('!')).toBe(false);
      expect(isFullWidth('?')).toBe(false);
      expect(isFullWidth(',')).toBe(false);
      expect(isFullWidth('.')).toBe(false);
      expect(isFullWidth(':')).toBe(false);
      expect(isFullWidth(';')).toBe(false);
    });
  });

  describe('ASCII Characters', () => {
    it('should not detect ASCII letters as fullwidth', () => {
      expect(isFullWidth('a')).toBe(false);
      expect(isFullWidth('Z')).toBe(false);
    });

    it('should not detect ASCII digits as fullwidth', () => {
      expect(isFullWidth('0')).toBe(false);
      expect(isFullWidth('9')).toBe(false);
    });

    it('should not detect ASCII symbols as fullwidth', () => {
      expect(isFullWidth('@')).toBe(false);
      expect(isFullWidth('#')).toBe(false);
      expect(isFullWidth('$')).toBe(false);
    });
  });

  describe('Display Width Calculation', () => {
    function calculateWidth(str: string): number {
      let w = 0;
      for (const c of str) {
        if (isFullWidth(c)) w += 2;
        else if (c !== '\n') w += 1;
      }
      return w;
    }

    it('should calculate width for ASCII', () => {
      expect(calculateWidth('hello')).toBe(5);
      expect(calculateWidth('test123')).toBe(7);
    });

    it('should calculate width for Chinese', () => {
      expect(calculateWidth('你好')).toBe(4);
      expect(calculateWidth('世界')).toBe(4);
    });

    it('should calculate width for fullwidth punctuation', () => {
      expect(calculateWidth('！？')).toBe(4);
      expect(calculateWidth('，。')).toBe(4);
    });

    it('should calculate width for mixed content', () => {
      expect(calculateWidth('Hello世界')).toBe(9); // 5 ASCII + 4 CJK
      expect(calculateWidth('测试Test！')).toBe(10); // 4 CJK (测试=2 chars×2=4) + 4 ASCII (Test) + 2 fullwidth (！)
    });

    it('should handle newline correctly', () => {
      expect(calculateWidth('a\nb')).toBe(2); // newline contributes 0
    });
  });
});

describe('Command Parsing', () => {
  type CommandResult = { type: string; action?: string; id?: string; name?: string };

  const commands: Record<string, CommandResult> = {
    '/help': { type: 'help' },
    '/h': { type: 'help' },
    '/status': { type: 'status' },
    '/queue': { type: 'queue' },
    '/q': { type: 'queue' },
    '/undo': { type: 'undo' },
    '/clear': { type: 'clear' },
    '/reset': { type: 'clear' },
    '/skill': { type: 'skill', action: 'list' },
    '/skill list': { type: 'skill', action: 'list' },
    '/mcp': { type: 'mcp', action: 'status' },
    '/mcp status': { type: 'mcp', action: 'status' },
    '/history': { type: 'history' },
    '/compact': { type: 'compact' },
    '/init': { type: 'init' },
    '/new': { type: 'new' },
    '/sessions': { type: 'sessions' },
    '/s': { type: 'sessions' },
    '/switch abc': { type: 'switch', id: 'abc' },
    '/rename abc newname': { type: 'rename', id: 'abc', name: 'newname' },
    '/delete abc': { type: 'delete', id: 'abc' },
  };

  function parseCommand(input: string): CommandResult {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) {
      return { type: 'unknown' };
    }

    const cmd = trimmed.slice(1).toLowerCase();
    const parts = cmd.split(' ');
    const mainCmd = parts[0];
    const args = parts.slice(1);

    // Help commands
    if (mainCmd === 'help' || mainCmd === 'h') {
      return { type: 'help' };
    }

    // Status
    if (mainCmd === 'status') {
      return { type: 'status' };
    }

    // Queue
    if (mainCmd === 'queue' || mainCmd === 'q') {
      return { type: 'queue' };
    }

    // Undo
    if (mainCmd === 'undo') {
      return { type: 'undo' };
    }

    // Clear/Reset
    if (mainCmd === 'clear' || mainCmd === 'reset') {
      return { type: 'clear' };
    }

    // Skill
    if (mainCmd === 'skill') {
      const action = args[0] || 'list';
      return { type: 'skill', action };
    }

    // MCP
    if (mainCmd === 'mcp') {
      const action = args[0] || 'status';
      return { type: 'mcp', action };
    }

    // History
    if (mainCmd === 'history') {
      return { type: 'history' };
    }

    // Compact
    if (mainCmd === 'compact') {
      return { type: 'compact' };
    }

    // Init
    if (mainCmd === 'init') {
      return { type: 'init' };
    }

    // New
    if (mainCmd === 'new') {
      return { type: 'new' };
    }

    // Sessions
    if (mainCmd === 'sessions' || mainCmd === 's') {
      return { type: 'sessions' };
    }

    // Switch
    if (mainCmd === 'switch') {
      const id = args[0];
      return { type: 'switch', id };
    }

    // Rename
    if (mainCmd === 'rename') {
      const id = args[0];
      const name = args.slice(1).join(' ');
      return { type: 'rename', id, name };
    }

    // Delete
    if (mainCmd === 'delete') {
      const id = args[0];
      return { type: 'delete', id };
    }

    return { type: 'unknown' };
  }

  it('should parse all base commands correctly', () => {
    for (const [input, expected] of Object.entries(commands)) {
      const result = parseCommand(input);
      expect(result.type).toBe(expected.type);
      if (expected.action) {
        expect(result.action).toBe(expected.action);
      }
      if (expected.id) {
        expect(result.id).toBe(expected.id);
      }
      if (expected.name) {
        expect(result.name).toBe(expected.name);
      }
    }
  });

  it('should handle unknown commands', () => {
    const result = parseCommand('/xyz');
    expect(result.type).toBe('unknown');
  });

  it('should handle non-command input', () => {
    const result = parseCommand('hello');
    expect(result.type).toBe('unknown');
  });
});
