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
  formatToolArgs,
} from './formatting';
import type { ToolResultData } from './formatting';
import { resetToolTracking, registerToolCall, matchToolResult, calcElapsedMs, displayToolResult, isInterruptAlreadyShown, markInterruptShown, type ToolCallRecord } from './results';
import { subAgentState, SUBAGENT_TYPE_ICONS, getRunningCount, type SubAgentRecord } from './subagentPanel';

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

  // 追踪 reasoning 状态和 sub-agent streaming
  let reasoningStarted = false;
  const subAgentStreamedChars = new Map<string, number>();

  // 每次 LLM 请求开始时重置流式状态
  on('waiting_for_llm', () => {
    reasoningStarted = false;
    resetToolTracking();
    subAgentStreamedChars.clear();
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
    if (state.isInterrupted()) return;
    screen.clearThinkingAnimation();

    // Hacker mode: all output → rain during processing
    if (state.getDisplayMode() === 'hacker') {
      screen.feedRain(data.chunk, 'output');
      if (!state.isStreamingOutput()) {
        state.setStreamingOutput(true);
        screen.setStreaming(true);
      }
      return;
    }

    if (!state.isStreamingOutput()) {
      if (reasoningStarted) {
        screen.flushStreamBuffer();
        screen.appendScroll('\n');
      }
      state.setStreamingOutput(true);
      screen.setStreaming(true);
    }
    screen.appendStreamChunk(COLORS.primary(data.chunk));
  });

  on('message', (data: { role: string; content: string }) => {
    if (data.role === 'assistant' && data.content) {
      screen.clearThinkingAnimation();
      if (state.getDisplayMode() === 'hacker') {
        screen.feedRain(data.content, 'output');
      } else if (!state.isStreamingOutput()) {
        screen.appendScroll(COLORS.primary(data.content + '\n'));
      }
    }
  });

  on('reasoning', (data: ReasoningData) => {
    const mode = state.getDisplayMode();

    if (!reasoningStarted) {
      reasoningStarted = true;
      // compact模式：启动thinking动画
      // 但如果stream已开始（DeepSeek: content先于reasoning到达），
      // 不要启动动画——内容已开始输出，spinner只会污染屏幕
      if (mode === 'compact' && !state.isStreamingOutput()) {
        screen.startThinkingAnimation();
      }
      if (!state.isStreamingOutput()) {
        state.setStreamingOutput(true);
        screen.setStreaming(true);
      }
    }

    // Route reasoning based on display mode
    if (mode === 'verbose') {
      screen.appendStreamChunk(COLORS.reasoning(data.content));
    } else if (mode === 'hacker') {
      screen.feedRain(data.content, 'thinking');
    }
    // compact: discard content (spinner only)
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
      screen.appendScroll(COLORS.muted(`  ${data.name} ${argsDisplay}`));
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
      const icon = data.success ? COLORS.success('OK') : COLORS.error('ERR');
      const summary = formatToolSummary(data);
      screen.appendScroll(`${icon} ${data.name} → ${summary}\n`);
    }
    // 强制刷新
    screen.flushOutput();

    // 更新状态栏（先重新检测 git 分支，确保分支切换后实时更新）
    try {
      const branch = execSync('git branch --show-current', {
        cwd: agent.getWorkspacePath(),
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim();
      state.setCurrentBranch(branch || null);
    } catch {
      state.setCurrentBranch(null);
    }
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

  // Subagent 事件 — overlay lifecycle
  on('sub_agent_start', (data: SubAgentStartData) => {
    subAgentSeq++;
    const type = data.type || 'sub';
    const label = `[#${subAgentSeq} ${type}]`;
    subAgentState.add(data.id, {
      type,
      description: truncateToWidth(data.description || data.prompt.slice(0, 60), 50),
      status: 'running',
      startTime: Date.now(),
      toolCount: 0,
      label,
      priority: 1,
    });

    // Inline scrollback announcement
    const icon = SUBAGENT_TYPE_ICONS[type] || '•';
    screen.appendScroll(COLORS.secondary(`${icon} ${label} ${truncateToWidth(data.description || data.prompt.slice(0, 60), 50)}\n`));

    // Refresh status bar to show subagent count
    if (model) {
      screen.setStatus(buildStatusText(agent, model));
    }
  });

  on('sub_agent_tool_call', (data: SubAgentToolCallData) => {
    const record = subAgentState.get(data.id);
    if (record) {
      record.toolCount++;
      record.currentTool = `${data.name}${formatToolArgs(data.name, data.arguments || {})}`;
      record.toolStartTime = Date.now();
    }
  });

  on('sub_agent_tool_result', (_data: SubAgentToolResultData) => {
    const record = subAgentState.get(_data.id);
    if (record) {
      record.currentTool = undefined;
      record.toolStartTime = undefined;
    }
  });

  on('sub_agent_done', (data: SubAgentDoneData) => {
    subAgentStreamedChars.delete(data.id);

    const record = subAgentState.get(data.id);
    if (record) {
      record.status = 'done';
      record.summary = truncateToWidth(data.summary || 'done', 60);
      record.priority = 2;
      record.currentTool = undefined;

      const icon = SUBAGENT_TYPE_ICONS[record.type] || '•';
      const elapsed = formatElapsed(Date.now() - record.startTime);
      screen.appendScroll(COLORS.success(`  [${icon}] OK ${record.label} done (${elapsed}, ${record.toolCount} tools)\n`));

      // Refresh status bar to update subagent count
      if (model) {
        screen.setStatus(buildStatusText(agent, model));
      }
    }
  });

  on('sub_agent_error', (data: SubAgentErrorData) => {
    subAgentStreamedChars.delete(data.id);

    const record = subAgentState.get(data.id);
    if (record) {
      record.status = 'error';
      record.error = data.error;
      record.summary = data.error.split('\n')[0].slice(0, 60);
      record.priority = 0;
      record.currentTool = undefined;

      const icon = SUBAGENT_TYPE_ICONS[record.type] || '•';
      const elapsed = formatElapsed(Date.now() - record.startTime);
      const errBrief = data.error.split('\n')[0].slice(0, 80);
      screen.appendScroll(COLORS.error(`  [${icon}] ERR ${record.label} ${errBrief} (${elapsed})\n`));

      // Refresh status bar to update subagent count
      if (model) {
        screen.setStatus(buildStatusText(agent, model));
      }
    }
  });

  // Background subagent asks a question — inject into parent LLM history
  on('sub_agent_question', (data: { id: string; question: string; label: string }) => {
    const record = subAgentState.get(data.id);
    const icon = record ? SUBAGENT_TYPE_ICONS[record.type] || '•' : '•';

    // Show in scrollback
    screen.appendScroll(COLORS.warning(`  [${icon}] ? ${data.label}: ${data.question.slice(0, 120)}\n`));

    // Inject as system message so parent LLM can see and answer
    const llm = agent.getLLM();
    if (llm) {
      llm.addMessage({
        role: 'system',
        content: `[SUBAGENT QUESTION - ${data.label}]\nTask ID: ${data.id}\nQuestion: ${data.question}\n\nReply with the reply_subagent tool: reply_subagent(task_id="${data.id}", answer="...")`,
      });
    }

    // Update status bar
    if (model) {
      screen.setStatus(buildStatusText(agent, model));
    }

    // If parent is idle, notify user to continue
    if (!getRuntimeState().isProcessing()) {
      screen.appendScroll(COLORS.muted('  (use reply_subagent to answer, or press Enter)\n'));
    }
  });

  // Subagent text output — only track streamed chars, no scroll output
  on('sub_agent_message', (data: SubAgentMessageData) => {
    if (data.role === 'assistant' && data.content) {
      // Reset streamed counter for next turn
      subAgentStreamedChars.set(data.id, 0);
    }
  });

  // Subagent reasoning — only hacker mode rain, no text output
  on('sub_agent_reasoning', (data: SubAgentReasoningData) => {
    const mode = state.getDisplayMode();
    if (mode === 'compact') return;

    if (data.content && data.content.trim()) {
      if (mode === 'hacker') {
        screen.feedRain(data.content, 'subagent');
      }
      // verbose: no text output — panel shows status only
    }
  });

  // Subagent streaming — only hacker mode rain, no text output
  on('sub_agent_stream', (data: SubAgentStreamData) => {
    if (!data.chunk) return;

    // Track streamed chars
    subAgentStreamedChars.set(data.id, (subAgentStreamedChars.get(data.id) || 0) + data.chunk.length);

    // Hacker mode: route to matrix rain
    if (state.getDisplayMode() === 'hacker') {
      screen.feedRain(data.chunk, 'subagent');
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
    state.setInterrupted(true);
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

  on('context_compressing', (data: { before: number; tokensBefore: number; target: number }) => {
    const fmt = (t: number) => (t >= 1000 ? `${(t / 1000).toFixed(1)}k` : `${t}`);
    screen.appendScroll(
      COLORS.secondary(`\n[compress] ${data.before} msgs (${fmt(data.tokensBefore)} tok) → target ${fmt(data.target)} tok …\n`)
    );
  });

  on('context_compressed', (data: ContextCompressedData) => {
    const formatTokens = (t: number) => (t >= 1000 ? `${Math.floor(t / 1000)}k` : `${t}`);
    const tokensInfo =
      data.tokensBefore && data.tokensAfter
        ? ` (${formatTokens(data.tokensBefore)}→${formatTokens(data.tokensAfter)})`
        : '';
    const phaseLabel = data.phase === 'phase1+sync-summary'
      ? 'compress'
      : data.phase === 'phase1+deferred-summary'
        ? 'compress'
        : 'compress';
    const roleInfo = data.kept
      ? ` [u${data.kept.user}/a${data.kept.assistant}/t${data.kept.tool}]`
      : '';
    const dropInfo = data.droppedRatio !== undefined
      ? ` drop:${Math.round(data.droppedRatio * 100)}%`
      : '';
    screen.appendScroll(
      COLORS.secondary(
        `[compress] ${data.before}→${data.after}${tokensInfo}${roleInfo}${dropInfo}\n`
      )
    );
    screen.restoreCursor();
  });

  on('compress_auto_continue', (_data: { content: string }) => {
    // Subtle indicator that the agent is continuing after compression
    screen.appendScroll(COLORS.secondary(`[compress] auto-continuing…\n`));
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
