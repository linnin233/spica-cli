import { SpicaAgent } from '../agent';
import { getScreenManager } from './ui/screenManager';
import { COLORS } from './ui/colors';
import { TokenCounter } from '../llm/TokenCounter';
import { getRuntimeState } from '../core/RuntimeState';
import { execSync } from 'child_process';
import { getAllToolDefinitions } from '../tools/index';
import {
  getTerminalWidth,
  truncateToWidth,
  getCharDisplayWidth,
  getStringDisplayWidth,
  isFullWidth,
  buildStatusText,
  formatArgsCompact,
  formatToolArgs,
  countDiffLines,
  countMatches,
  countFiles,
  countTestPassed,
  countTestFailed,
  countLintErrors,
  countAgents,
  formatToolSummary,
  formatElapsed,
  getMainArg,
} from './formatting';
import type { ToolResultData } from './formatting';
import { resetToolTracking, registerToolCall, matchToolResult, calcElapsedMs, displayToolResult, isInterruptAlreadyShown, markInterruptShown, type ToolCallRecord } from './results';
import { subAgentState, displaySubAgentPanel, type SubAgentRecord } from './subagentPanel';

// 事件数据类型定义
interface ConnectionErrorData {
  type: string;
  hint: string;
  error?: string;
}

interface StreamData {
  chunk: string;
}

interface ReasoningData {
  content: string;
}

interface ToolCallData {
  name: string;
  arguments: Record<string, unknown>;
  id?: string; // 工具调用 ID（用于匹配结果）
}


interface ContextWarningData {
  level: string;
  usage: number;
  message: string;
  suggestion?: string;
}

interface ContextCompressedData {
  before: number;
  after: number;
  tokensBefore?: number;
  tokensAfter?: number;
  message?: string;
  // Structured observability fields (compression v3)
  kept?: { user: number; assistant: number; tool: number };
  dropped?: { user: number; assistant: number; tool: number };
  phase?: 'phase1-only' | 'phase1+sync-summary' | 'phase1+deferred-summary';
  droppedRatio?: number;     // fraction of compressible messages dropped
  summaryLength?: number;    // chars in Phase 2 summary (if applicable)
}

interface QueueInjectedData {
  input: string;
}

interface RetryAttemptData {
  operation: string;
  attempt: number;
  maxRetries: number;
  delay: number;
  error: string;
}

interface ErrorSuggestionData {
  tool?: string;
  toolName?: string;
  error: string;
  suggestion: string;
}

interface DiffPreviewData {
  filePath: string;
  diff: string;
}

interface HookBlockedData {
  tool: string;
  reason: string;
}

interface HookWarningData {
  tool: string;
  message: string;
}

interface HookLogData {
  tool: string;
  message: string;
}

interface WorkspaceChangedData {
  path: string;
}

interface SubAgentStartData {
  id: string;
  prompt: string;
  type?: string;
  description?: string;
}

interface SubAgentToolCallData {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface SubAgentToolResultData {
  id: string;
  name: string;
  result: string;
  success?: boolean;
}

interface SubAgentDoneData {
  id: string;
  result: string;
  summary?: string;
}

interface SubAgentErrorData {
  id: string;
  error: string;
}

interface SubAgentMessageData {
  id: string;
  role: string;
  content: string;
}

interface SubAgentReasoningData {
  id: string;
  content: string;
}

interface SubAgentStreamData {
  id: string;
  chunk: string;
}

interface PendingInputDetectedData {
  content: string;
  input?: string;
}

interface ToolStuckWarningData {
  tool: string;
  timeout: number;
  elapsedMs?: number;
}

interface ToolAbortedData {
  tool: string;
  reason: string;
}

interface TodoUpdateData {
  todos: Array<{ content: string; status: string }>;
}

interface AgentInterruptedData {
  toolResults?: Array<{ name: string; result: string }>;
  reason?: string;
  cancelSeq?: number; // 🔴 用于防止重复显示
}

interface AgentStoppedOnErrorData {
  tool: string;
  error: string;
  suggestion: string;
}

interface MessageData {
  role: string;
  content: string;
}

const screen = getScreenManager();
const state = getRuntimeState();


// ============================================
// 主事件处理
// ============================================

let subAgentSeq = 0;

export function setupAgentEvents(
  agent: SpicaAgent,
  _interactive: boolean = false,
  model?: string,
  _tokenCounter?: TokenCounter
): () => void {
  // 收集所有注册的监听器，用于 cleanup
  type EventHandler = (...args: any[]) => void;
  const listeners: Array<{ event: string; handler: EventHandler }> = [];
  const on = (event: string, handler: EventHandler) => {
    agent.on(event, handler);
    listeners.push({ event, handler });
  };

  // 追踪 reasoning 状态
  let reasoningStarted = false;
  let justSwitchedFromReasoning = false;

  // 每次新对话开始时重置状态
  on('waiting_for_llm', () => {
    reasoningStarted = false;
    justSwitchedFromReasoning = false;
    resetToolTracking();
    subAgentState.clear();
    subAgentStreamBuffer.clear();
    subAgentSeq = 0;
    // 清除thinking动画
    screen.clearThinkingAnimation();
  });

  on('connection_error', (data: ConnectionErrorData) => {
    state.setConnectionErrorShown(true);
    screen.appendScroll(COLORS.error(`\nError: ${data.type}\n`));
    if (data.hint && data.hint.length < 50) {
      screen.appendScroll(COLORS.muted(`${data.hint}\n`));
    }
  });

  on('stream', (data: StreamData) => {
    // 从 reasoning 切换到 stream 时，清除thinking动画并换行
    if (reasoningStarted && !justSwitchedFromReasoning) {
      justSwitchedFromReasoning = true;
      screen.clearThinkingAnimation();
      // 先刷新流式缓冲，再换行
      screen.flushStreamBuffer();
      screen.appendScroll('\n');
    }

    // 设置流式状态
    if (!state.isStreamingOutput()) {
      state.setStreamingOutput(true);
      screen.setStreaming(true);
    }
    // AI流式输出使用行缓冲
    screen.appendStreamChunk(COLORS.primary(data.chunk));
  });

  on('message', (data: { role: string; content: string }) => {
    if (data.role === 'assistant' && data.content) {
      // 确保thinking动画已清除
      screen.clearThinkingAnimation();
      // 如果流式没有输出（非流式响应），直接显示完整消息
      if (!state.isStreamingOutput()) {
        screen.appendScroll(COLORS.primary(data.content + '\n'));
      }
    }
  });

  on('reasoning', (data: ReasoningData) => {
    if (!reasoningStarted) {
      reasoningStarted = true;
      justSwitchedFromReasoning = false;
      // compact模式：启动thinking动画
      if (!state.isVerboseMode()) {
        screen.startThinkingAnimation();
      }
      if (!state.isStreamingOutput()) {
        state.setStreamingOutput(true);
        screen.setStreaming(true);
      }
    }

    // verbose 模式下显示完整 reasoning（使用行缓冲）
    if (state.isVerboseMode()) {
      screen.appendStreamChunk(COLORS.reasoning(data.content));
    }
  });

  // 工具调用开始 - 清除thinking动画，更新状态栏
  on('tool_call', (data: ToolCallData) => {
    state.setStreamingOutput(false);
    screen.setStreaming(false);

    // 总是清除thinking动画（无论reasoningStarted状态）
    screen.clearThinkingAnimation();
    reasoningStarted = false;

    // 注册工具调用
    registerToolCall(data);

    // 🔴 关键：显示工具开始提示（让用户知道 bash 正在执行，可以 ESC ESC）
    // Show key tools (bash, write, etc)
    const importantTools = ['bash', 'write', 'edit', 'web_fetch', 'web_search'];
    if (importantTools.includes(data.name)) {
      const args = data.arguments || {};
      const termWidth = getTerminalWidth();
      const maxDisplay = Math.min(termWidth - 15, 80);
      const raw =
        data.name === 'bash'
          ? String(args.command || '')
          : String(args.path || args.url || '');
      const argsDisplay = truncateToWidth(raw, maxDisplay);
      screen.appendScroll(COLORS.muted(`  ${data.name} ${argsDisplay} → `));
    }

    screen.flushOutput();
  });

  // 工具进度更新 — 刷新状态栏以显示最新耗时
  on('tool_progress', (_data: { elapsed?: number; stage?: string; command?: string }) => {
    if (model) {
      screen.setStatus(buildStatusText(agent, model));
    }
  });

  // 工具调用结果 - 清除thinking动画
  on('tool_result', (data: ToolResultData) => {
    state.setStreamingOutput(false);
    screen.setStreaming(false);

    // 确保清除thinking动画
    screen.clearThinkingAnimation();

    // 匹配工具调用
    const record = matchToolResult(data);

    if (record) {
      // 显示简洁的结果行（不显示序号）
      displayToolResult(record, data);
    } else {
      // 未找到匹配，显示简单格式
      const icon = data.success ? COLORS.success('✓') : COLORS.error('✗');
      const summary = formatToolSummary(data);
      screen.appendScroll(`${icon} ${data.name} → ${summary}\n`);
    }
    // 强制刷新
    screen.flushOutput();

    // 更新状态栏
    if (model) {
      screen.setStatus(buildStatusText(agent, model));
    }

    screen.restoreCursor();
    screen.refreshInput();
  });

  // Diff 预览
  on('diff_preview', (data: DiffPreviewData) => {
    screen.appendScroll(COLORS.file(`\n[diff] ${data.filePath}\n`));
    const lines = data.diff.split('\n').slice(0, 10);
    for (const line of lines) {
      if (line.startsWith('+')) {
        screen.appendScroll(COLORS.diffAdd(`  ${line}\n`));
      } else if (line.startsWith('-')) {
        screen.appendScroll(COLORS.diffRemove(`  ${line}\n`));
      } else {
        screen.appendScroll(COLORS.muted(`  ${line}\n`));
      }
    }
    screen.restoreCursor();
  });

  // AI建议信息 - 内部机制，不显示给用户

  // 空响应警告 - 内部机制，自动重试

  // 重试信息 - 内部机制，不显示给用户

  on('workspace_changed', (data: WorkspaceChangedData) => {
    screen.appendScroll(COLORS.muted(`\nWorkspace: ${data.path}\n`));
    // 重新检测 Git 分支
    try {
      const branch = execSync('git branch --show-current', {
        cwd: data.path,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
      state.setCurrentBranch(branch || null);
    } catch {
      state.setCurrentBranch(null);
    }
    if (model) {
      screen.setStatus(buildStatusText(agent, model));
    }
  });

  // Subagent 事件
  on('sub_agent_start', (data: SubAgentStartData) => {
    subAgentSeq++;
    const type = data.type || 'sub';
    // Generate unique label: [#1 explore], [#2 review], etc.
    const label = `[#${subAgentSeq} ${type}]`;
    subAgentState.add(data.id, {
      type,
      description: truncateToWidth(data.description || data.prompt.slice(0, 60), 50),
      status: 'running',
      startTime: Date.now(),
      toolCount: 0,
      label,
    });

    // 显示状态面板
    displaySubAgentPanel();
  });

  on('sub_agent_tool_call', (data: SubAgentToolCallData) => {
    // Track tool count
    const record = subAgentState.get(data.id);
    if (record) record.toolCount++;

    // Show tool call with subagent label and key args
    const prefix = record?.label || '[sub]';
    const args = formatToolArgs(data.name, data.arguments);
    screen.appendScroll(COLORS.subAgent(`  ${prefix} → ${data.name}${args ? ` ${args}` : ''}\n`));
  });

  on('sub_agent_tool_result', (data: SubAgentToolResultData) => {
    const record = subAgentState.get(data.id);
    const prefix = record?.label || '[sub]';
    const icon = data.success ? '✓' : '✗';
    const colorFn = data.success ? COLORS.success : COLORS.error;
    screen.appendScroll(colorFn(`  ${prefix} ${icon} ${data.name}\n`));
  });

  on('sub_agent_done', (data: SubAgentDoneData) => {
    // Flush any remaining stream buffer
    const remaining = subAgentStreamBuffer.get(data.id);
    if (remaining?.trim()) {
      const record = subAgentState.get(data.id);
      const prefix = record?.label || '[sub]';
      screen.appendScroll(COLORS.subAgent(`  ${prefix} │ ${remaining.slice(0, 300)}\n`));
    }
    subAgentStreamBuffer.delete(data.id);

    const record = subAgentState.get(data.id);
    if (record) {
      record.status = 'done';
      record.summary = truncateToWidth(data.summary || 'done', 60);
    }

    // 更新状态面板
    displaySubAgentPanel();
  });

  on('sub_agent_error', (data: SubAgentErrorData) => {
    // Flush any remaining stream buffer
    const remaining = subAgentStreamBuffer.get(data.id);
    if (remaining?.trim()) {
      const record = subAgentState.get(data.id);
      const prefix = record?.label || '[sub]';
      screen.appendScroll(COLORS.subAgent(`  ${prefix} │ ${remaining.slice(0, 300)}\n`));
    }
    subAgentStreamBuffer.delete(data.id);

    const record = subAgentState.get(data.id);
    if (record) {
      record.status = 'error';
      record.error = truncateToWidth(data.error, 80);
    }

    // 更新状态面板
    displaySubAgentPanel();
  });

  // Subagent text output — show what subagent is saying
  on('sub_agent_message', (data: SubAgentMessageData) => {
    if (data.role === 'assistant' && data.content) {
      const record = subAgentState.get(data.id);
      const prefix = record?.label || '[sub]';
      const lines = data.content.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          screen.appendScroll(COLORS.subAgent(`  ${prefix} │ ${line.slice(0, 200)}\n`));
        }
      }
    }
  });

  // Subagent reasoning — show with reasoning color
  on('sub_agent_reasoning', (data: SubAgentReasoningData) => {
    if (data.content && data.content.trim()) {
      const record = subAgentState.get(data.id);
      const prefix = record?.label || '[sub]';
      const lines = data.content.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          screen.appendScroll(COLORS.reasoning(`  ${prefix} │ ${line.slice(0, 200)}\n`));
        }
      }
    }
  });

  // Subagent streaming — buffer chunks per subagent, flush on newline
  const subAgentStreamBuffer = new Map<string, string>();
  on('sub_agent_stream', (data: SubAgentStreamData) => {
    if (!data.chunk) return;
    const record = subAgentState.get(data.id);
    const prefix = record?.label || '[sub]';

    let buffer = subAgentStreamBuffer.get(data.id) || '';
    buffer += data.chunk;

    // Flush on newline or when buffer gets large
    const newlineIdx = buffer.indexOf('\n');
    if (newlineIdx >= 0 || buffer.length > 120) {
      const lines = buffer.split('\n');
      // Keep the last incomplete line in the buffer
      const incomplete = buffer.endsWith('\n') ? '' : (lines.pop() || '');
      for (const line of lines) {
        if (line.trim()) {
          screen.appendScroll(COLORS.subAgent(`  ${prefix} │ ${line.slice(0, 300)}\n`));
        }
      }
      subAgentStreamBuffer.set(data.id, incomplete);
    } else {
      subAgentStreamBuffer.set(data.id, buffer);
    }
  });

  on('hook_blocked', (data: HookBlockedData) => {
    screen.appendScroll(COLORS.error(`\n[block] ${data.tool}: ${data.reason}\n`));
  });

  on('sub_agent_warning', (data: { message: string }) => {
    screen.appendScroll(COLORS.warning(`\n[subagent] ${data.message}\n`));
  });

  on('queue_injected', (data: QueueInjectedData) => {
    screen.appendScroll(COLORS.primary(`\n[queue] ${data.input}...\n`));
  });

  on('hook_warning', (data: HookWarningData) => {
    screen.appendScroll(COLORS.warning(`\n[warn] ${data.message}\n`));
  });

  on('hook_log', (data: HookLogData) => {
    screen.appendScroll(COLORS.muted(`\n[log] ${data.message}\n`));
  });

  on('pending_input_detected', (data: PendingInputDetectedData) => {
    screen.appendScroll(COLORS.warning(`\n[input] ${data.input?.slice(0, 30)}...\n`));
    screen.restoreCursor();
    screen.refreshInput();
  });

  on('tool_stuck_warning', (data: ToolStuckWarningData) => {
    const elapsedSec = (data.elapsedMs ?? data.timeout) / 1000;
    screen.appendScroll(COLORS.warning(`\n[stuck] ${data.tool} ${elapsedSec}s, aborting...\n`));
  });

  on('tool_aborted', (data: ToolAbortedData) => {
    screen.appendScroll(COLORS.warning(`\n[abort] ${data.tool}\n`));
    screen.restoreCursor();
    screen.refreshInput();
  });

  // 工具冲突警告 - 内部机制，不显示给用户

  // AI提示信息 - 内部机制，不显示给用户

  // Checkpoint创建 - 内部信息，不显示给用户

  on('agent_interrupted', (data: AgentInterruptedData) => {
    state.setStreamingOutput(false);
    screen.setStreaming(false);
    screen.clearThinkingAnimation();

    // 🔴 基于 cancelSeq 防止重复显示（只显示最新的 cancelSeq）
    const currentCancelSeq = data.cancelSeq || 0;

    if (isInterruptAlreadyShown(currentCancelSeq)) {
      return;
    }
    markInterruptShown(currentCancelSeq);

    screen.appendScroll(COLORS.warning(`\n[interrupt] stopped\n`));
    if (data.toolResults && data.toolResults.length > 0) {
      screen.appendScroll(
        COLORS.muted(`  tools: ${data.toolResults.map(t => t.name).join(', ')}\n`)
      );
    }

    screen.restoreCursor();
    screen.refreshInput();
  });

  on('agent_stopped_on_error', (data: AgentStoppedOnErrorData) => {
    screen.appendScroll(COLORS.error(`\n[stop] ${data.tool}: ${data.error?.slice(0, 50)}\n`));
    screen.appendScroll(COLORS.warning(`  → ${data.suggestion}\n`));
    screen.restoreCursor();
    screen.refreshInput();
  });

  on(
    'agent_blocked',
    (data: {
      status: string;
      task: string;
      attempted: string[];
      failed: string[];
      error: string;
      suggestions: string[];
      timestamp: string;
    }) => {
      screen.appendScroll(COLORS.error(`\n[block] need help\n`));
      screen.appendScroll(COLORS.muted(`  task: ${data.task.slice(0, 50)}\n`));
      screen.appendScroll(COLORS.warning(`  error: ${data.error.slice(0, 50)}\n`));
      data.suggestions.slice(0, 2).forEach(s => {
        screen.appendScroll(COLORS.primary(`  → ${s.slice(0, 50)}\n`));
      });
      screen.restoreCursor();
      screen.refreshInput();
    }
  );

  // Todo progress
  on('todos_set', (todos: TodoUpdateData['todos']) => {
    if (todos.length > 0) {
      displayTodoProgress(todos);
    }
  });

  on('todo_update', (data: TodoUpdateData) => {
    if (data.todos && data.todos.length > 0) {
      displayTodoProgress(data.todos);
    }
  });

  function displayTodoProgress(todos: TodoUpdateData['todos']) {
    const statusIcons: Record<string, string> = {
      completed: '✔',
      in_progress: '◼',
      pending: '◻',
    };

    screen.appendScroll(COLORS.secondary('\n[tasks]\n'));
    todos.forEach(todo => {
      const icon = statusIcons[todo.status] || '◻';
      const colorFn =
        todo.status === 'completed'
          ? COLORS.success
          : todo.status === 'in_progress'
            ? COLORS.primary
            : COLORS.muted;
      // 不截断，完整显示todo内容
      screen.appendScroll(colorFn(`  ${icon} ${todo.content}\n`));
    });
    if (todos.length > 5) {
      screen.appendScroll(COLORS.muted(`  ... (${todos.length - 5} more)\n`));
    }
    screen.restoreCursor();
    screen.refreshInput();
  }

  on('context_compressed', (data: ContextCompressedData) => {
    const formatTokens = (t: number) => (t >= 1000 ? `${Math.floor(t / 1000)}k` : `${t}`);
    const tokensInfo =
      data.tokensBefore && data.tokensAfter
        ? ` (${formatTokens(data.tokensBefore)}→${formatTokens(data.tokensAfter)})`
        : '';
    const phaseLabel = data.phase === 'phase1+sync-summary'
      ? 'compress+summary'
      : data.phase === 'phase1+deferred-summary'
        ? 'compress+deferred'
        : 'compress';
    const roleInfo = data.kept
      ? ` [u${data.kept.user}/a${data.kept.assistant}/t${data.kept.tool}]`
      : '';
    const dropInfo = data.droppedRatio !== undefined
      ? ` drop:${Math.round(data.droppedRatio * 100)}%`
      : '';
    screen.appendScroll(
      COLORS.secondary(
        `\n[${phaseLabel}] ${data.before}→${data.after}${tokensInfo}${roleInfo}${dropInfo}\n`
      )
    );
    screen.restoreCursor();
  });

  // Monitor 工具输出事件
  on('monitor_event', (data: { task_id: string; description: string; line: string }) => {
    screen.appendScroll(COLORS.muted(`[monitor:${data.description}] ${data.line}\n`));
  });

  on('monitor_error', (data: { task_id: string; error: string }) => {
    screen.appendScroll(COLORS.error(`[monitor error] ${data.error}\n`));
  });

  // 返回 cleanup 函数
  return () => {
    for (const { event, handler } of listeners) {
      agent.off(event, handler);
    }
    listeners.length = 0;
  };
}

// 格式化运行统计
// Uses the LLM provider's actual message list (which includes system prompts)
// rather than _fullHistory (which is append-only for session persistence).
// Tool definitions are sent as a separate 'tools' parameter and estimated separately.
export function formatRunStats(
  elapsedMs: number,
  agent: SpicaAgent,
  tokenCounter: TokenCounter
): string {
  // Use provider messages — the actual context sent to the API (includes system prompts)
  const contextMessages = agent.getContextMessages();
  const msgTokens = tokenCounter.estimateMessages(contextMessages);
  const contextWindow = tokenCounter.getContextWindow();

  const lastAssistant = [...contextMessages].reverse().find(m => m.role === 'assistant');
  const outputTokens = lastAssistant ? tokenCounter.estimateMessage(lastAssistant) : 0;

  // Tool definitions are sent as a separate 'tools' parameter in the API request.
  // Estimate their token cost using the same format the provider sends to the API.
  let toolDefsTokens = 0;
  try {
    const allDefs = getAllToolDefinitions();
    if (allDefs.length > 0) {
      const apiJson = JSON.stringify(
        allDefs.map((t: any) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }))
      );
      toolDefsTokens = tokenCounter.estimateTokens(apiJson);
    }
  } catch {
    // If registry fails (e.g. MCP not initialized), skip tool estimation
  }

  const usedTokens = msgTokens + toolDefsTokens;
  const inputTokens = Math.max(0, usedTokens - outputTokens);

  const toolCallCount = contextMessages.filter(m => m.role === 'tool').length;

  const elapsed = elapsedMs < 1000 ? `${elapsedMs}ms` : `${(elapsedMs / 1000).toFixed(1)}s`;

  const fmt = (t: number) => (t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t));

  return `${elapsed} | ${fmt(inputTokens)} in | ${fmt(outputTokens)} out | ${toolCallCount} tools | ${fmt(usedTokens)}/${fmt(contextWindow)} ctx`;
}
