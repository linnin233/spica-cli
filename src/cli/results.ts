import { getScreenManager } from './ui/screenManager';
import { COLORS } from './ui/colors';
import { getRuntimeState } from '../core/RuntimeState';
import {
  formatElapsed,
  formatToolSummary,
  type ToolResultData,
} from './formatting';

const screen = getScreenManager();
const state = getRuntimeState();

// ============================================
// Tool Call Tracking System
// ============================================

export interface ToolCallRecord {
  seq: number;
  name: string;
  args: Record<string, unknown>;
  startTime: number;
  id?: string;
  outputLines: string[];
}

// Internal state
const activeToolCalls: Map<number, ToolCallRecord> = new Map();
const idToSeq: Map<string, number> = new Map();
let nextToolSeq = 1;
let interruptDisplayed = false;
let lastInterruptCancelSeq = 0;

export function resetToolTracking(): void {
  activeToolCalls.clear();
  idToSeq.clear();
  nextToolSeq = 1;
  interruptDisplayed = false;
  lastInterruptCancelSeq = 0;
}

export function registerToolCall(data: { name: string; arguments: Record<string, unknown>; id?: string }): number {
  const seq = nextToolSeq++;
  const record: ToolCallRecord = {
    seq,
    name: data.name,
    args: data.arguments || {},
    startTime: Date.now(),
    id: data.id,
    outputLines: [],
  };
  activeToolCalls.set(seq, record);
  if (data.id) {
    idToSeq.set(data.id, seq);
  }
  return seq;
}

export function matchToolResult(data: ToolResultData): ToolCallRecord | null {
  if (data.id && idToSeq.has(data.id)) {
    const seq = idToSeq.get(data.id)!;
    const record = activeToolCalls.get(seq);
    if (record) {
      idToSeq.delete(data.id);
      activeToolCalls.delete(seq);
      return record;
    }
  }

  for (const [seq, record] of activeToolCalls) {
    if (record.name === data.name) {
      activeToolCalls.delete(seq);
      if (record.id) idToSeq.delete(record.id);
      return record;
    }
  }

  return null;
}

export function calcElapsedMs(startTime: number): number {
  return Date.now() - startTime;
}

export function isInterruptAlreadyShown(cancelSeq: number): boolean {
  return cancelSeq === lastInterruptCancelSeq && interruptDisplayed;
}

export function markInterruptShown(cancelSeq: number): void {
  lastInterruptCancelSeq = cancelSeq;
  interruptDisplayed = true;
}

// ============================================

export function displayToolResult(record: ToolCallRecord, data: ToolResultData): void {
  const elapsed = formatElapsed(calcElapsedMs(record.startTime));
  const icon = data.success ? COLORS.success('OK') : COLORS.error('ERR');
  const summary = formatToolSummary(data);

  if (state.isVerboseMode()) {
    // Verbose模式：完整显示所有内容
    screen.appendScroll(COLORS.tool(`\n${record.name}`));

    // 根据工具类型显示关键参数
    switch (record.name) {
      case 'read':
      case 'write':
      case 'edit':
      case 'file_multi_edit':
      case 'file_patch':
      case 'file_replace':
      case 'file_insert':
      case 'file_delete':
      case 'file_copy':
      case 'file_move':
      case 'file_exists': {
        const path = record.args.path as string;
        if (path) screen.appendScroll(COLORS.file(` ${path}`));
        break;
      }
      case 'bash': {
        const cmd = record.args.command as string;
        if (cmd) screen.appendScroll(COLORS.muted(`\n  cmd: ${cmd}\n`));
        break;
      }
      case 'grep': {
        const pattern = record.args.pattern as string;
        const path = record.args.path as string;
        if (pattern) screen.appendScroll(COLORS.muted(` pattern: ${pattern}`));
        if (path) screen.appendScroll(COLORS.file(` ${path}`));
        break;
      }
      case 'glob': {
        const pattern = record.args.pattern as string;
        if (pattern) screen.appendScroll(COLORS.muted(` ${pattern}`));
        break;
      }
      case 'web_search':
      case 'web_fetch': {
        const query = (record.args.query || record.args.url) as string | undefined;
        if (query) screen.appendScroll(COLORS.muted(` ${query}`));
        break;
      }
      case 'git': {
        const action = record.args.action as string;
        if (action) screen.appendScroll(COLORS.muted(` ${action}`));
        break;
      }
      case 'test':
      case 'lint': {
        const path = record.args.path as string;
        if (path) screen.appendScroll(COLORS.file(` ${path}`));
        break;
      }
      case 'directory_list':
      case 'directory_create': {
        const path = record.args.path as string;
        if (path) screen.appendScroll(COLORS.file(` ${path}`));
        break;
      }
      case 'todo_write': {
        const todoItems = record.args.todos as any[];
        if (todoItems?.length) {
          const done = todoItems.filter((t: any) => t.status === 'completed').length;
          screen.appendScroll(COLORS.muted(` ${todoItems.length} tasks (${done} done)`));
        }
        break;
      }
      case 'todo_read': {
        // No args to show — tool reads from disk
        break;
      }
      case 'workspace': {
        const path = record.args.path as string;
        if (path) screen.appendScroll(COLORS.file(` ${path}`));
        break;
      }
      case 'skill': {
        const skillName = record.args.name || (record.args.skill as string);
        if (skillName) screen.appendScroll(COLORS.muted(` ${skillName}`));
        break;
      }
      case 'question': {
        const questionText = record.args.question as string;
        if (questionText) screen.appendScroll(COLORS.muted(` ${questionText.slice(0, 60)}`));
        break;
      }
      case 'task': {
        const taskList = record.args.tasks as any[];
        if (taskList?.length) {
          const descs = taskList
            .map((t: any) => (t.description || t.prompt || '').slice(0, 30))
            .join(', ');
          screen.appendScroll(COLORS.muted(` ${descs}`));
        }
        break;
      }
      case 'task_stop': {
        const taskId = record.args.task_id as string;
        if (taskId) screen.appendScroll(COLORS.muted(` ${taskId}`));
        break;
      }
      case 'monitor': {
        const desc = record.args.description as string;
        if (desc) screen.appendScroll(COLORS.muted(` ${desc.slice(0, 60)}`));
        break;
      }
      default:
        break;
    }

    screen.appendScroll(COLORS.muted(` → `));
    screen.appendScroll(COLORS.primary(`${summary}`));
    screen.appendScroll(` ${icon}`);
    screen.appendScroll(COLORS.muted(` ${elapsed}\n`));

    // 显示完整输出（不截断）
    const output = data.output || data.error || '';
    if (output) {
      screen.appendScroll(COLORS.muted(`\n  Output:\n`));
      for (const line of output.split('\n')) {
        screen.appendScroll(COLORS.muted(`  ${line}\n`));
      }
    }

    // 显示完整diff（如果有）
    if (data.diff) {
      screen.appendScroll(COLORS.muted(`\n  Diff:\n`));
      for (const line of data.diff.split('\n')) {
        if (line.startsWith('+')) {
          screen.appendScroll(COLORS.diffAdd(`  ${line}\n`));
        } else if (line.startsWith('-')) {
          screen.appendScroll(COLORS.diffRemove(`  ${line}\n`));
        } else {
          screen.appendScroll(COLORS.muted(`  ${line}\n`));
        }
      }
    }
  } else {
    // Compact模式：完整显示（工具名+参数+结果），带缩进
    screen.appendScroll(COLORS.muted('  ')); // 缩进
    screen.appendScroll(COLORS.tool(`${record.name}`));

    // 根据工具类型显示关键参数
    switch (record.name) {
      case 'read':
      case 'write':
      case 'edit':
      case 'file_multi_edit':
      case 'file_patch':
      case 'file_replace':
      case 'file_insert':
      case 'file_delete':
      case 'file_copy':
      case 'file_move':
      case 'file_exists': {
        const path = record.args.path as string;
        if (path) screen.appendScroll(COLORS.file(` ${path}`));
        break;
      }
      case 'bash': {
        const cmd = (record.args.command as string) || '';
        if (cmd) {
          // 截断超长命令，保持单行可读
          const shortCmd = cmd.length > 50 ? cmd.slice(0, 50) + '...' : cmd;
          screen.appendScroll(COLORS.muted(` ${shortCmd}`));
        }
        break;
      }
      case 'grep': {
        const pattern = record.args.pattern as string;
        const path = record.args.path as string;
        if (pattern) screen.appendScroll(COLORS.muted(` ${pattern}`));
        if (path) screen.appendScroll(COLORS.file(` ${path}`));
        break;
      }
      case 'glob': {
        const pattern = record.args.pattern as string;
        if (pattern) screen.appendScroll(COLORS.muted(` ${pattern}`));
        break;
      }
      case 'web_search':
      case 'web_fetch': {
        const query = (record.args.query || record.args.url) as string | undefined;
        if (query) screen.appendScroll(COLORS.muted(` ${query}`));
        break;
      }
      case 'git': {
        const action = record.args.action as string;
        if (action) screen.appendScroll(COLORS.muted(` ${action}`));
        break;
      }
      case 'test':
      case 'lint': {
        const path = record.args.path as string;
        if (path) screen.appendScroll(COLORS.file(` ${path}`));
        break;
      }
      case 'directory_list':
      case 'directory_create': {
        const path = record.args.path as string;
        if (path) screen.appendScroll(COLORS.file(` ${path}`));
        break;
      }
      case 'todo_write': {
        const todoItems = record.args.todos as any[];
        if (todoItems?.length) {
          const done = todoItems.filter((t: any) => t.status === 'completed').length;
          screen.appendScroll(COLORS.muted(` ${todoItems.length} tasks (${done} done)`));
        }
        break;
      }
      case 'todo_read': {
        // No args to show — tool reads from disk
        break;
      }
      case 'workspace': {
        const path = record.args.path as string;
        if (path) screen.appendScroll(COLORS.file(` ${path}`));
        break;
      }
      case 'skill': {
        const skillName = record.args.name || (record.args.skill as string);
        if (skillName) screen.appendScroll(COLORS.muted(` ${skillName}`));
        break;
      }
      case 'question': {
        const questionText = record.args.question as string;
        if (questionText) screen.appendScroll(COLORS.muted(` ${questionText.slice(0, 40)}`));
        break;
      }
      case 'task': {
        const taskList = record.args.tasks as any[];
        if (taskList?.length) {
          const descs = taskList
            .map((t: any) => (t.description || t.prompt || '').slice(0, 20))
            .join(', ');
          screen.appendScroll(COLORS.muted(` ${descs}`));
        }
        break;
      }
      case 'task_stop': {
        const taskId = record.args.task_id as string;
        if (taskId) screen.appendScroll(COLORS.muted(` ${taskId}`));
        break;
      }
      case 'monitor': {
        const desc = record.args.description as string;
        if (desc) screen.appendScroll(COLORS.muted(` ${desc.slice(0, 40)}`));
        break;
      }
      case 'format': {
        const fmtPath = record.args.path as string;
        if (fmtPath) screen.appendScroll(COLORS.file(` ${fmtPath}`));
        break;
      }
      case 'code_health':
      case 'test_quality_check': {
        const chPath = record.args.path as string;
        if (chPath) screen.appendScroll(COLORS.file(` ${chPath}`));
        break;
      }
      default:
        break;
    }

    screen.appendScroll(COLORS.muted(` → `));
    screen.appendScroll(COLORS.primary(`${summary}`));
    screen.appendScroll(` ${icon}`);
    screen.appendScroll(COLORS.muted(` ${elapsed}\n`));
  }
}

// ============================================
