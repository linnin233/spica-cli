import { SpicaAgent } from '../agent';
import { getScreenManager } from './ui/screenManager';
import { COLORS } from './ui/colors';
import { getRuntimeState } from '../core/RuntimeState';
import { getRunningCount } from './subagentPanel';
import * as os from 'os';

const screen = getScreenManager();
const state = getRuntimeState();

// ============================================
// 事件数据类型（共享）
// ============================================

export interface ToolResultData {
  name: string;
  success: boolean;
  output?: string;
  error?: string;
  diff?: string;
  syntaxErrors?: string[];
  content?: string;
  id?: string;
}

// ============================================
// 终端宽度自适应
// ============================================

export function getTerminalWidth(): number {
  return screen.state.terminalWidth || process.stdout.columns || 80;
}

// 截断字符串到指定宽度（考虑中文字符宽度）
export function truncateToWidth(str: string, maxWidth: number): string {
  const width = getStringDisplayWidth(str);
  if (width <= maxWidth) return str;

  // 从末尾截断
  let result = '';
  let currentWidth = 0;
  const graphemes = Array.from(str);

  for (const char of graphemes) {
    const charWidth = getCharDisplayWidth(char);
    if (currentWidth + charWidth > maxWidth - 3) {
      return result + '...';
    }
    result += char;
    currentWidth += charWidth;
  }
  return result;
}

export function getCharDisplayWidth(char: string): number {
  if (char === '\n') return 0;
  if (char === '\t') return 2;
  const codePoint = char.codePointAt(0);
  if (!codePoint) return 1;
  // Emoji 和其他复杂 grapheme cluster 宽度为 2
  if (char.length > 1 || codePoint > 0xffff) return 2;
  // 全角字符宽度为 2
  if (isFullWidth(char)) return 2;
  return 1;
}

export function getStringDisplayWidth(str: string): number {
  let width = 0;
  const graphemes = Array.from(str);
  for (const char of graphemes) {
    width += getCharDisplayWidth(char);
  }
  return width;
}

export function isFullWidth(char: string): boolean {
  const codePoint = char.codePointAt(0) || 0;
  // CJK 统一汉字范围
  if (codePoint >= 0x4e00 && codePoint <= 0x9fff) return true;
  // CJK 扩展 A
  if (codePoint >= 0x3400 && codePoint <= 0x4dbf) return true;
  // CJK 扩展 B-F
  if (codePoint >= 0x20000 && codePoint <= 0x2ceaf) return true;
  // 日文平假名、片假名
  if (codePoint >= 0x3040 && codePoint <= 0x30ff) return true;
  // 韩文
  if (codePoint >= 0xac00 && codePoint <= 0xd7af) return true;
  // 全角符号
  if (codePoint >= 0xff00 && codePoint <= 0xffef) return true;
  return false;
}

// ============================================
// 格式化函数
// ============================================

// 构建状态栏文本（状态 | 模型 | 分支 | 工作区）
export function buildStatusText(agent: SpicaAgent, model: string | undefined): string {
  const isBusy = state.isProcessing();
  const statusText = isBusy ? COLORS.warning('busy') : COLORS.success('idle');

  // Subagent count
  const subCount = getRunningCount();
  const subInfo = subCount > 0 ? ` ${COLORS.primary(`${subCount} sub`)} |` : '';

  // Git 分支（无 repo 则不显示）
  const branch = state.getCurrentBranch();
  const branchInfo = branch ? ` | ${branch}` : '';

  // 工作区路径显示（智能缩写）
  const workspace = agent.getWorkspacePath();
  const homeDir = os.homedir();
  let displayPath = workspace;

  // 缩写用户目录为 ~
  if (workspace.startsWith(homeDir)) {
    displayPath = '~' + workspace.slice(homeDir.length);
  }

  // 路径过长时显示最后两级
  if (displayPath.length > 30) {
    const parts = displayPath.split(/[/\\]/);
    if (parts.length > 2) {
      displayPath = '...' + parts.slice(-2).join('/');
    }
  }

  return `${statusText} |${subInfo} ${model || '?'}${branchInfo} | ${displayPath}`;
}

// 格式化参数（简洁版）
export function formatArgsCompact(args: Record<string, unknown>, maxWidth: number): string {
  if (!args || Object.keys(args).length === 0) return '';

  // 过滤掉内部参数
  const filteredKeys = Object.keys(args).filter(k => !k.startsWith('_'));
  if (filteredKeys.length === 0) return '';

  const parts = filteredKeys.slice(0, 3).map(k => {
    const v = args[k];
    if (typeof v === 'string') {
      // 路径只显示文件名
      if (k === 'path' || k === 'source' || k === 'destination') {
        const filename = v.split('/').pop() || v.split('\\').pop() || v;
        return filename.length > 20 ? filename.slice(0, 17) + '...' : filename;
      }
      // 其他字符串截断
      if (v.length > 15) return v.slice(0, 12) + '...';
      return v;
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
      return String(v);
    }
    return k;
  });

  const result = parts.join(' ');
  return truncateToWidth(result, maxWidth);
}

// Format key tool args for subagent display (brief, one arg max)
export function formatToolArgs(toolName: string, args: Record<string, unknown>): string {
  if (!args || Object.keys(args).length === 0) return '';

  const filtered = Object.keys(args).filter(k => !k.startsWith('_'));
  if (filtered.length === 0) return '';

  // Pick the most informative arg per tool type
  const keyArg = ((): string | null => {
    switch (toolName) {
      case 'read':
      case 'file_read':
        return typeof args.path === 'string' ? (args.path as string).replace(/.*\//, '') : null;
      case 'write':
      case 'file_write':
      case 'edit':
      case 'file_edit':
        return typeof args.path === 'string' ? (args.path as string).replace(/.*\//, '') : null;
      case 'grep':
        return typeof args.pattern === 'string' ? (args.pattern as string).slice(0, 30) : null;
      case 'glob':
        return typeof args.pattern === 'string' ? (args.pattern as string).slice(0, 30) : null;
      case 'bash':
        return typeof args.command === 'string' ? (args.command as string).slice(0, 40) : null;
      case 'directory_list':
        return typeof args.path === 'string' ? (args.path as string).replace(/.*\//, '') : null;
      default: {
        // Show first string arg
        const firstStr = filtered.find(k => typeof args[k] === 'string');
        if (firstStr) {
          const v = args[firstStr] as string;
          return v.length > 30 ? v.slice(0, 27) + '...' : v;
        }
        return null;
      }
    }
  })();

  return keyArg ? `(${keyArg})` : '';
}

// 工具摘要辅助函数
export function countDiffLines(text: string, prefix: '+' | '-'): number {
  return text.split('\n').filter(l => l.startsWith(prefix) && !l.startsWith(prefix + prefix))
    .length;
}

export function countMatches(output: string): number {
  const match = output.match(/(\d+)\s+matches/i) || output.match(/Found\s+(\d+)/i);
  return match ? parseInt(match[1], 10) : 0;
}

export function countFiles(output: string): number {
  const lines = output.split('\n').filter(l => l.trim() && !l.includes('found'));
  return lines.length;
}

export function countTestPassed(output: string): number {
  const match = output.match(/(\d+)\s+passed/i);
  return match ? parseInt(match[1], 10) : 0;
}

export function countTestFailed(output: string): number {
  const match = output.match(/(\d+)\s+failed/i);
  return match ? parseInt(match[1], 10) : 0;
}

export function countLintErrors(output: string): number {
  const match = output.match(/(\d+)\s+errors/i) || output.match(/(\d+)\s+problems/i);
  return match ? parseInt(match[1], 10) : 0;
}

export function countAgents(output: string): number {
  const match = output.match(/(\d+)\s+agents/i) || output.match(/(\d+)\s+tasks/i);
  return match ? parseInt(match[1], 10) : 0;
}

// 格式化工具结果摘要
export function formatToolSummary(data: {
  name: string;
  success: boolean;
  output?: string;
  error?: string;
  content?: string;
}): string {
  if (!data.success) {
    const errorMsg = data.error || '';
    // 显示第一行错误，截断到 80 字符足够判断原因
    const firstLine = errorMsg.split('\n')[0];
    const shortErr = firstLine.length > 80 ? firstLine.slice(0, 80) + '...' : firstLine;
    return `err: ${shortErr}`;
  }

  const name = data.name;
  const output = data.output || '';

  switch (name) {
    case 'read': {
      const fileContent = data.content || '';
      const lines = fileContent ? fileContent.split('\n').length : 0;
      return `${lines} lines`;
    }
    case 'write':
    case 'edit':
    case 'file_multi_edit':
    case 'file_patch': {
      const added = countDiffLines(output, '+');
      const removed = countDiffLines(output, '-');
      if (added > 0 && removed > 0) {
        return `+${added}/-${removed}`;
      } else if (added > 0) {
        return `+${added}`;
      } else if (removed > 0) {
        return `-${removed}`;
      }
      return 'done';
    }
    case 'file_replace':
    case 'file_insert': {
      return output.includes('replaced') || output.includes('inserted') ? output : 'done';
    }
    case 'file_exists': {
      return output || 'exists';
    }
    case 'file_delete':
      return 'deleted';
    case 'file_copy':
    case 'file_move': {
      return output || 'done';
    }
    case 'directory_create':
      return 'created';
    case 'directory_list': {
      const items = output.split('\n').filter(l => l.trim()).length;
      return `${items} items`;
    }
    case 'bash': {
      const bashLines = output.split('\n').filter(l => l.trim()).length;
      const timeMatch = output.match(/\((\d+\.?\d*)s\)/);
      const time = timeMatch ? timeMatch[1] : '';
      return time ? `${bashLines} lines, ${time}s` : `${bashLines} lines`;
    }
    case 'grep': {
      const matchCount = countMatches(output);
      return matchCount > 0 ? `${matchCount} matches` : '0 matches';
    }
    case 'glob': {
      const fileCount = countFiles(output);
      return fileCount > 0 ? `${fileCount} files` : '0 files';
    }
    case 'test': {
      const passed = countTestPassed(output);
      const failed = countTestFailed(output);
      if (failed > 0) {
        return `${passed} OK, ${failed} FAIL`;
      }
      return passed > 0 ? `${passed} OK` : 'done';
    }
    case 'lint': {
      const errors = countLintErrors(output);
      return errors > 0 ? `${errors} errors` : 'clean';
    }
    case 'git':
      return 'done';
    case 'monitor': {
      const taskId = data.content || '';
      return taskId || 'started';
    }
    case 'task_stop':
      return 'stopped';
    case 'skill':
      return 'loaded';
    case 'task': {
      const agentCount = countAgents(output);
      if (agentCount > 0) return `${agentCount} agents`;
      const doneMatch = output.match(/✓ ([^\n]+)/);
      if (doneMatch) return doneMatch[1].slice(0, 40);
      const failMatch = output.match(/✗ ([^\n]+)/);
      if (failMatch) return `failed: ${failMatch[1].slice(0, 30)}`;
      return 'done';
    }
    case 'web_search': {
      const results = output.split('\n').filter(l => l.includes('http')).length;
      return results > 0 ? `${results} results` : 'done';
    }
    case 'web_fetch': {
      const len = output.length;
      return len > 1000 ? `${Math.floor(len / 1000)}kb` : `${len} chars`;
    }
    case 'gh': {
      if (output.includes('created')) return 'created';
      if (output.includes('merged')) return 'merged';
      if (output.includes('closed')) return 'closed';
      return 'done';
    }
    case 'todo_write': {
      const statsMatch = output.match(
        /\((\d+)\/(\d+)\s*done,\s*(\d+)\s*active,\s*(\d+)\s*pending\)/
      );
      if (statsMatch) {
        return `${statsMatch[1]}/${statsMatch[2]} done, ${statsMatch[3]} active`;
      }
      return 'saved';
    }
    case 'todo_read': {
      const lines = output.split('\n').filter(l => /^\[(DONE|ACTV|PEND)\]/.test(l));
      if (lines.length > 0) {
        return `${lines.length} tasks`;
      }
      return 'empty';
    }
    case 'workspace':
      return output.slice(0, 30) || 'done';
    case 'question':
      return 'asked';
    case 'format':
      return 'formatted';
    case 'code_health':
    case 'test_quality_check': {
      const issues = output
        .split('\n')
        .filter(l => l.includes('✗') || l.includes('warning')).length;
      return issues > 0 ? `${issues} issues` : 'clean';
    }
    default:
      return 'done';
  }
}

// 格式化耗时
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 1000)}s`;
}

// 获取工具的主要参数（用于显示）
export function getMainArg(name: string, args: Record<string, unknown>): string | null {
  switch (name) {
    case 'read':
    case 'write':
    case 'edit':
    case 'file_multi_edit':
      return (args.path as string) || null;
    case 'bash':
      return (args.command as string) || null;
    case 'grep':
      return (args.pattern as string) || null;
    case 'glob':
      return (args.pattern as string) || null;
    default:
      return null;
  }
}
