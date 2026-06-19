import { LLMClient } from './llm/LLMClient';
import {
  executeTool,
  getActiveToolDefinitions,
  isLazyTool,
  setWorkspace,
  getToolBatchHint,
} from './tools/index';
import { type SkillDefinition } from './utils/settings';
import { type ProjectConfig } from './utils/projectConfig';
import {
  loadProjectState,
  saveProjectState,
  updateProjectTodos,
} from './storage/projectState';
import { runPreHooks, runPostHooks } from './hooks';
import { isCorrection, saveLearning } from './core/learnings';
import { saveSession } from './utils/session';
import { EventEmitter, setMaxListeners } from 'events';

// 提高默认 MaxListeners 上限 — 单次 runLoop 内可能有
// LLMClient (2) + task subagents (≤6) + retry delays (≤10) 同时监听同一个 AbortSignal
setMaxListeners(30);
import simpleGit from 'simple-git';
import type { ChatMessage } from './llm/providers/BaseProvider';
import {
  cleanMessagesForLLM as _cleanMessagesForLLM,
  manageContext as _manageContext,
  autoCompactContext as _autoCompactContext,
  generateSummary as _generateSummary,
  buildSummaryPrompt as _buildSummaryPrompt,
} from './core/compression';
import { ProgressTracker } from './core/progressTracker';
import { AgentStateMachine } from './core/AgentState';
import { sessionStats } from './core/sessionStats';
import { recordToolUsage } from './tools/analytics';
import {
  initAgent,
  initAgentAsSubAgent,
  doInit,
  loadProjectConfig as _loadProjectConfig,
} from './core/init';

// 解析向后兼容的工具别名
function resolveAlias(toolName: string): string {
  const ALIASES: Record<string, string> = {
    'file_read': 'read',
    'file_write': 'write',
    'file_edit': 'edit',
  };
  return ALIASES[toolName] || toolName;
}

// 工具冲突检测：提取资源路径
function extractResourcePath(toolName: string, args: Record<string, unknown>): string | null {
  const resolved = resolveAlias(toolName);
  // 文件操作工具
  if (
    [
      'read',
      'write',
      'edit',
      'file_multi_edit',
      'file_delete',
      'file_copy',
      'file_move',
      'file_exists',
      'file_patch',
    ].includes(resolved)
  ) {
    return (args.path || args.file_path || args.source || args.from) as string | null;
  }
  // bash 命令中可能涉及的文件（检测 rm、mv、cp 等操作）
  if (toolName === 'bash') {
    const cmd = (args.command as string) || '';
    // 检查是否有文件修改操作
    if (/\b(rm|mv|cp|rsync)\b/.test(cmd)) {
      // 提取最后一个非选项参数作为文件路径
      const parts = cmd.split(/\s+/).filter(p => !p.startsWith('-') && !p.startsWith('--'));
      // rm/mv/cp 通常最后一个或倒数第二个参数是目标文件
      const filePath = parts[parts.length - 1] || parts[parts.length - 2];
      if (filePath && !filePath.includes('|') && !filePath.includes('>')) {
        return filePath;
      }
    }
    // 检查写入重定向
    const writeMatch = cmd.match(/>>\s*(\S+)/);
    if (writeMatch) return writeMatch[1];
    const redirectMatch = cmd.match(/>\s*(\S+)/);
    if (redirectMatch && !cmd.includes('>>') && !cmd.includes('|')) return redirectMatch[1];
  }
  // git 操作（整个仓库）
  if (toolName === 'git') {
    return 'git:repo'; // git 操作视为同资源
  }
  return null;
}

// 检测工具调用冲突：返回需要顺序执行的工具组
function detectToolConflicts(
  toolCalls: Array<{ name: string; id: string; arguments: Record<string, unknown> }>
): {
  parallel: Array<{ name: string; id: string; arguments: Record<string, unknown> }>;
  sequential: Array<Array<{ name: string; id: string; arguments: Record<string, unknown> }>>;
  conflicts: Array<{ path: string; tools: string[] }>;
} {
  const pathToTools: Map<
    string,
    Array<{ name: string; id: string; arguments: Record<string, unknown> }>
  > = new Map();
  const noConflictTools: Array<{ name: string; id: string; arguments: Record<string, unknown> }> =
    [];

  for (const tc of toolCalls) {
    const resourcePath = extractResourcePath(tc.name, tc.arguments);
    if (resourcePath) {
      if (!pathToTools.has(resourcePath)) {
        pathToTools.set(resourcePath, []);
      }
      pathToTools.get(resourcePath)!.push(tc);
    } else {
      noConflictTools.push(tc);
    }
  }

  // 分组：无冲突的并行执行，有冲突的顺序执行
  const sequential: Array<Array<{ name: string; id: string; arguments: Record<string, unknown> }>> =
    [];
  const parallel: Array<{ name: string; id: string; arguments: Record<string, unknown> }> = [
    ...noConflictTools,
  ];
  const conflicts: Array<{ path: string; tools: string[] }> = [];

  for (const [path, tools] of pathToTools) {
    if (tools.length === 1) {
      // 单个工具操作该资源，可以并行
      parallel.push(tools[0]);
    } else {
      // 多个工具操作同一资源，需要顺序执行
      sequential.push(tools);
      conflicts.push({ path, tools: tools.map(t => t.name) });
    }
  }

  return { parallel, sequential, conflicts };
}

/**
 * Todo item for task tracking
 */
export interface Todo {
  /** Task content/description */
  content: string;
  /** Task status: pending, in_progress, or completed */
  status: 'pending' | 'in_progress' | 'completed';
}

export class InterruptError extends Error {
  constructor(message = 'Interrupted by user') {
    super(message);
    this.name = 'InterruptError';
  }
}

/**
 * SpicaAgent - AI coding agent with three-step workflow
 *
 * Core responsibilities:
 * - Manage LLM client and tool orchestration
 * - Handle interrupt signals (ESC ESC / Ctrl+C)
 * - Manage project state and session persistence
 * - Coordinate MCP servers and skills
 *
 * @extends EventEmitter
 * @example
 * ```ts
 * const agent = new SpicaAgent('openai', '/path/to/workspace');
 * await agent.init();
 * const result = await agent.runLoop('fix the bug in app.ts');
 * ```
 */
export class SpicaAgent extends EventEmitter {
  private llm: LLMClient | null = null;

  /**
   * Get the LLM client instance
   * @returns LLMClient instance or null if not initialized
   */
  getLLM(): LLMClient | null {
    return this.llm;
  }

  /** @internal — used by compression.ts to prevent concurrent compaction */
  isCompacting(): boolean { return this._compacting; }
  setCompacting(v: boolean): void { this._compacting = v; }

  // ── Init accessors (typed — replaces string-index access from init.ts) ──

  /** @internal — used by init.ts */
  setLLM(llm: LLMClient): void {
    this.llm = llm;
    // Register session-wide usage tracker — every LLM request is recorded
    llm.on('llm_usage', (usage) => {
      sessionStats.record(usage);
    });
  }

  /** @internal — used by init.ts for session loading */
  getFullHistory(): ChatMessage[] { return this._fullHistory; }
  setFullHistory(msgs: ChatMessage[]): void { this._fullHistory = msgs; }

  /** @internal — used by init.ts for session sync tracking */
  getLastSyncedProviderIndex(): number { return this._lastSyncedProviderIndex; }
  setLastSyncedProviderIndex(idx: number): void { this._lastSyncedProviderIndex = idx; }

  /** @internal — used by init.ts */
  isInitialized(): boolean { return this._initialized; }
  setInitialized(v: boolean): void { this._initialized = v; }

  /** Unified state machine — for lifecycle transitions (init, interrupt, compact). */
  get stateMachine(): AgentStateMachine { return this._stateMachine; }

  /** @internal — used by init.ts */
  getInitPromise(): Promise<void> | null { return this._initPromise; }
  setInitPromise(p: Promise<void> | null): void { this._initPromise = p; }

  /** @internal — used by init.ts */
  getProviderName(): string | undefined { return this._providerName; }

  /** @internal — used by init.ts */
  getTodosInternal(): Todo[] { return this._todos; }
  setTodosInternal(todos: Todo[]): void { this._todos = todos; }

  /** @internal — used by init.ts */
  getProjectConfigInternal(): ProjectConfig { return this.projectConfig; }
  setProjectConfigInternal(config: ProjectConfig): void { this.projectConfig = config; }

  /** @internal — used by init.ts */
  getWorkspacePathInternal(): string { return this.workspacePath; }
  setWorkspacePathInternal(path: string): void { this.workspacePath = path; }

  /** @internal — used by init.ts for cached skills */
  getCachedSkills(): SkillDefinition[] { return this._cachedSkills; }
  setCachedSkills(skills: SkillDefinition[]): void { this._cachedSkills = skills; }

  /** Progress snapshot for session persistence. */
  getProgressSnapshot(): { entries: Array<{ type: string; description: string; at: string }>; maxEntries: number } {
    return this._progress.toJSON();
  }

  /** Restore progress from session data. */
  restoreProgress(snapshot: { entries: Array<{ type: string; description: string; at: string }>; maxEntries: number }): void {
    if (snapshot.entries && snapshot.entries.length > 0) {
      this._progress = ProgressTracker.fromJSON(snapshot as any);
    }
  }

  private workspacePath: string;
  private projectConfig: ProjectConfig = {};
  private _todos: Todo[] = [];
  private _initialized = false;
  private _initPromise: Promise<void> | null = null;
  private _providerName?: string;
  private _cachedSkills: SkillDefinition[] = [];
  private _compacting = false;
  /**
   * Full transcript — append-only, independent of LLM context compression.
   *
   * INVARIANT: _fullHistory NEVER contains system prompts. System prompts are
   * injected directly into provider.messages via `setSystemPromptSplit()` and
   * never synced to _fullHistory. This split is intentional:
   *   - _fullHistory → getMessages() for display (/history, /summary, archive)
   *   - provider.msgs → getSessionState() for persistence (session.json)
   *
   * Never truncated by compression — grows throughout the session.
   * On restart, restored from session.json (which is the compressed state).
   * Updated by syncFullHistory() which copies new messages from provider.msgs.
   */
  private _fullHistory: ChatMessage[] = [];
  // Track last synced index from provider to _fullHistory.
  // Using index-based tracking instead of length comparison because cleanMessages()
  // can reduce provider message count below _fullHistory.length, causing permanent
  // desync where new user/assistant messages are never picked up.
  private _lastSyncedProviderIndex: number = -1;
  // Lazy tool loading: track which tools have been used this session.
  // Tools not in this set are withheld from the API `tools` parameter to
  // reduce per-request overhead (~1,500 tokens saved per call).
  private _usedTools: Set<string> = new Set();
  // Progress tracker: survives compression, records completed work
  private _progress: ProgressTracker = new ProgressTracker();
  // Stagnation detection: replaces 50-round hard cap
  private _stagnationCounter: number = 0;
  private static readonly STAGNATION_WARNING = 16;
  private static readonly STAGNATION_LIMIT = 32;
  // 防止 reasoning-only 响应无限循环（DeepSeek 等模型可能连续返回 reasoning 而没有 content/tool_calls）
  private _reasoningContinueCount: number = 0;
  private static readonly MAX_REASONING_CONTINUE = 5;
  // finish_reason="stop" = LLM's turn is over. Respect it.
  // No reflection hacks, no heuristic counters, no exceptions.
  // Periodic session save: persist every N tool rounds for crash resilience
  private _roundCount: number = 0;
  private static readonly SAVE_EVERY_N_ROUNDS = 5;
  // Unified state machine — replaces scattered _initialized/_compacting/pendingCancel
  private _stateMachine: AgentStateMachine = new AgentStateMachine();

  // === Interrupt 机制（参考 Crush 设计）===
  // 当前活跃的 AbortController（每个请求独立）
  private currentAbortController: AbortController | null = null;
  // pendingCancel 标记（interrupt 后设置，防止新请求进入）
  private pendingCancel: boolean = false;
  // cancelSeq 序号（高水位标记）
  private cancelSeq: number = 0;
  // 中断 debounce：200ms 内重复中断不递增 cancelSeq
  private lastInterruptTime: number = 0;
  private static readonly INTERRUPT_DEBOUNCE_MS = 200;

  // 极危险操作模式（即使在 bypass 模式也需要确认）
  private static readonly DANGEROUS_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /rm\s+-rf\s+\//, label: 'Recursive force delete root' },
    { pattern: /rm\s+-rf\s+\*/, label: 'Recursive force delete all' },
    { pattern: />\s*\/dev\//, label: 'Write to device' },
    { pattern: /mkfs\./, label: 'Filesystem format' },
    { pattern: /dd\s+if=/, label: 'Disk copy' },
    { pattern: /chmod\s+777/, label: 'World-writable permissions' },
    { pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, label: 'Fork bomb' },
    { pattern: /sudo\s+su\b/, label: 'Switch to root' },
  ];

  // 检查是否为极危险操作
  isDangerousOperation(command: string): boolean {
    return SpicaAgent.DANGEROUS_PATTERNS.some(p => p.pattern.test(command));
  }

  // 获取危险操作的标签
  getDangerLabel(command: string): string | null {
    for (const { pattern, label } of SpicaAgent.DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return label;
      }
    }
    return null;
  }

  // 待处理的新输入（用于在工具执行间隙插入新指令）
  private pendingInput: string | null = null;

  // 队列输入注入回调（由 CLI 设置，用于在迭代间隙获取队列输入）
  private queueInputCallback: (() => string | null) | null = null;

  // 工具白名单（用于限制subagent工具访问）
  private toolWhitelist: string[] | null = null;

  // 追踪是否收到 reasoning 内容（用于区分真正的空响应）
  private reasoningReceived: boolean = false;

  /**
   * Dispose internal resources — clears all listeners, timers, and references.
   * Call this when a sub-agent is no longer needed to prevent listener leaks.
   */
  dispose(): void {
    // Abort any active request
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
    // Clear LLM and its listeners
    if (this.llm) {
      this.llm.removeAllListeners();
      this.llm = null;
    }
    // Remove all agent event listeners
    this.removeAllListeners();
    // Clear progress tracker
    this._progress.clear();
    // Reset state machine
    this._stateMachine.reset();
  }

  constructor(providerName?: string, workspacePath?: string) {
    super();
    this._providerName = providerName;
    this.workspacePath = workspacePath || process.cwd();
  }

  get todos(): Todo[] {
    return this._todos;
  }

  /**
   * Interrupt agent execution - new simplified mechanism
   *
   * Effects:
   * - Sets pendingCancel = true (prevents new requests)
   * - Increments cancelSeq (high-water mark)
   * - Aborts currentAbortController if exists
   * - Interrupts LLM streaming
   * - Emits 'agent_interrupted' event
   */
  interrupt() {
    const now = Date.now();
    const isDuplicate = now - this.lastInterruptTime < SpicaAgent.INTERRUPT_DEBOUNCE_MS;

    // 设置 pendingCancel（防止新请求进入）
    this.pendingCancel = true;

    // Debounce: 200ms 内重复 ESC 不递增 cancelSeq
    if (!isDuplicate) {
      this.cancelSeq++;
    }
    this.lastInterruptTime = now;

    // Abort 当前活跃的 AbortController（只 abort 一次，第二次调用是 no-op）
    if (this.currentAbortController) {
      this.currentAbortController.abort();
    }

    // 中断 LLM streaming
    if (this.llm) {
      this.llm.interrupt();
    }

    // 通知 UI
    this.emit('agent_interrupted', {
      reason: 'User pressed ESC ESC',
      cancelSeq: this.cancelSeq,
      isDuplicate,
    });

    // State transition: processing → interrupted (only valid during processing)
    if (this._stateMachine.current === 'processing') {
      this._stateMachine.transition('interrupted');
    }
  }

  /**
   * Check if current request should be canceled (cancel-on-entry)
   */
  private checkCanceledOnEntry(): boolean {
    return this.pendingCancel;
  }

  /**
   * Clear pending cancel if we're the current cancelSeq
   */
  private clearPendingCancel(expectedSeq: number): void {
    if (this.cancelSeq === expectedSeq) {
      this.pendingCancel = false;
    }
  }

  /**
   * Check if agent is currently running a runLoop
   */
  isRunning(): boolean {
    return this.currentAbortController !== null;
  }

  // 设置待处理的新输入（用于在工具执行间隙插入新指令）
  setPendingInput(input: string | null): void {
    this.pendingInput = input;
  }

  // 获取待处理的新输入
  getPendingInput(): string | null {
    return this.pendingInput;
  }

  // 设置队列输入回调（由 CLI 设置，用于在迭代间隙获取队列输入）
  setQueueInputCallback(callback: (() => string | null) | null): void {
    this.queueInputCallback = callback;
  }

  // 检查并获取队列输入
  checkQueueInput(): string | null {
    if (this.queueInputCallback) {
      return this.queueInputCallback();
    }
    return this.pendingInput;
  }

  setToolWhitelist(allowedTools: string[]): void {
    this.toolWhitelist = allowedTools;
  }

  // 获取git状态（辅助方法）
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- simpleGit status.files type is complex
  private async getGitStatus(): Promise<{ files: any[] }> {
    try {
      const git = simpleGit(this.workspacePath);
      const status = await git.status();
      return { files: status.files };
    } catch {
      return { files: [] };
    }
  }

  // 停滞检测：替代 50 轮硬上限
  private checkStagnation(hadProgress: boolean): 'continue' | 'warn' | 'stop' {
    if (hadProgress) {
      this._stagnationCounter = 0;
      return 'continue';
    }
    this._stagnationCounter++;
    if (this._stagnationCounter === SpicaAgent.STAGNATION_WARNING) {
      return 'warn';
    }
    if (this._stagnationCounter >= SpicaAgent.STAGNATION_LIMIT) {
      return 'stop';
    }
    return 'continue';
  }

  // 判断错误是否可重试
  private isRetryableError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const code = String(
      (error as { code?: unknown; status?: unknown }).code ||
        (error as { code?: unknown; status?: unknown }).status ||
        ''
    );

    // 不可重试的错误
    const nonRetryablePatterns = [
      '400', // 请求格式错误（如不支持的消息角色）
      '401', // 认证失败
      '403', // 权限不足
      '404', // 资源不存在
      'invalid',
      'unauthorized',
      'permission',
    ];

    for (const pattern of nonRetryablePatterns) {
      if (message.includes(pattern) || code === pattern) {
        return false;
      }
    }

    // 可重试的错误：网络问题、超时、速率限制、服务器错误
    const retryablePatterns = [
      'ECONNREFUSED',
      'ENOTFOUND',
      'ETIMEDOUT',
      'ECONNRESET',
      '429',
      '500',
      '502',
      '503',
      'timeout',
      'network',
      'connection',
      'rate limit',
    ];

    for (const pattern of retryablePatterns) {
      if (message.toLowerCase().includes(pattern.toLowerCase()) || code === pattern) {
        return true;
      }
    }

    // 默认：未知错误也重试（网络波动等临时问题）
    return true;
  }

  // 判断工具错误是否是"关键错误"（应该停止整个生成循环）
  private isCriticalToolError(
    toolName: string,
    result: { success: boolean; error?: string; output?: string }
  ): boolean {
    if (result.success) return false;

    const error = result.error || '';

    // Web 工具的特殊处理优先：网络/API 错误不应该停止整个任务
    // Agent 应该尝试其他方案或使用已有信息继续
    if (toolName === 'web_search' || toolName === 'web_fetch') {
      return false; // web 工具错误永远不 critical
    }

    // 只有 AI 调用相关的错误才是 critical
    const criticalPatterns = [
      'invalid API key',
      'authentication failed',
      'ECONNREFUSED',
      'ENOTFOUND',
      'API connection failed',
      // 注意：403/401 对于非 AI 调用不 critical（如 web 工具已在上面处理）
    ];

    for (const pattern of criticalPatterns) {
      if (error.toLowerCase().includes(pattern.toLowerCase())) {
        return true;
      }
    }

    return false;
  }

  // 带重试的 LLM 调用（参考 Claude Code 等 coding agent 的重试策略）
  private async callLLMWithRetry<T>(
    operation: (signal?: AbortSignal) => Promise<T>,
    operationName: string,
    maxRetries: number = 10,
    signal?: AbortSignal
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // 检查中断信号
      if (signal?.aborted) {
        throw new InterruptError('Interrupted by user');
      }

      try {
        // Pass signal to operation
        return await operation(signal);
      } catch (error: unknown) {
        // InterruptError: don't retry, propagate immediately
        if (
          error instanceof InterruptError ||
          (error instanceof Error && error.name === 'InterruptError')
        ) {
          throw error;
        }

        lastError = error instanceof Error ? error : new Error(String(error));

        // 最后一次尝试不再重试
        if (attempt === maxRetries) {
          break;
        }

        // 检查中断信号
        if (signal?.aborted) {
          throw new InterruptError('Interrupted by user after error');
        }

        // 检查是否可重试（认证等错误直接抛出）
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (!this.isRetryableError(error)) {
          this.emit('error_suggestion', {
            tool: operationName,
            error: errorMsg,
            suggestion: `Error not retryable, user needs to handle: ${errorMsg}`,
          });
          throw error;
        }

        if (signal?.aborted) {
          throw new InterruptError('Interrupted by user before retry');
        }

        // 指数退避：2s, 4s, 8s, 16s, 32s, 64s, 120s...（最大120秒）
        const delay = Math.min(2000 * Math.pow(2, attempt), 120000);
        this.emit('retry_attempt', {
          operation: operationName,
          attempt: attempt + 1,
          maxRetries,
          delay,
          error: errorMsg,
        });

        // Single setTimeout with AbortSignal support for interrupt checking.
        // Avoids Date.now() polling loop which is fragile with fake timers in tests.
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(resolve, delay);
          if (signal) {
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timeout);
                reject(new InterruptError('Interrupted by user during retry delay'));
              },
              { once: true }
            );
          }
        });

        // Double-check: if signal was already aborted before the listener was registered,
        // the above listener won't fire — check here.
        if (signal?.aborted) {
          throw new InterruptError('Interrupted by user during retry delay');
        }
      }
    }

    // If signal was aborted during the last attempt, prefer InterruptError
    if (signal?.aborted) {
      throw new InterruptError('Interrupted by user');
    }
    throw lastError;
  }

  /**
   * Initialize agent and LLM client
   *
   * Steps:
   * 1. Initialize skills system
   * 2. Initialize MCP servers
   * 3. Load provider configuration
   * 4. Create LLM client instance
   * 5. Load workspace state and session
   *
   * @returns Promise that resolves when initialization complete
   * @throws Error if initialization fails or is interrupted
   */
  async init() {
    return initAgent(this);
  }

  /**
   * Lightweight init for sub-agents — skips MCP, skills, API check, session loading.
   * Creates a fresh LLMClient with the same API config (no shared message state).
   * Inherits the parent's system prompt, workspace, and a summary of recent context.
   */
  async initAsSubAgent(parentAgent: SpicaAgent, modelOverride?: string): Promise<void> {
    return initAgentAsSubAgent(this, parentAgent, modelOverride);
  }

  private async _doInit(): Promise<void> {
    return doInit(this);
  }

  private async loadProjectConfig(): Promise<void> {
    return _loadProjectConfig(this);
  }

  setTodos(todos: string[] | Todo[]) {
    this._todos = todos.map(t =>
      typeof t === 'string' ? { content: t, status: 'pending' as const } : t
    );
    this.emit('todos_set', this._todos);
    updateProjectTodos(this.workspacePath, this._todos);
  }

  updateTodo(index: number, status: Todo['status']) {
    if (index >= 0 && index < this._todos.length) {
      this._todos[index].status = status;
      this.emit('todo_update', { index, status, todos: this._todos });
    }
  }

  setSystemPrompt(prompt: string) {
    if (this.llm) {
      this.llm.setSystemPrompt(prompt);
    }
  }

  /**
   * Return the SESSION STATE for persistence.
   *
   * Returns provider.msgs filtered to remove system prompts — this is the
   * compressed working state the LLM actually sees. On restart, restoring this
   * resumes from exactly where the agent left off, without wasted re-compression.
   *
   * Falls back to _fullHistory if provider is unavailable (edge case: called
   * after dispose()).
   */
  getSessionState(): ChatMessage[] {
    if (!this.llm) return [...this._fullHistory];
    return this.llm.getMessages().filter(m => m.role !== 'system');
  }

  /**
   * Return the FULL TRANSCRIPT for display and archiving.
   *
   * Returns `_fullHistory` — append-only, never truncated by compression.
   * Does NOT include system prompts.
   *
   * Use this for: /history, /summary, /archive (user-facing views).
   * For session persistence, use getSessionState().
   * For LLM API context (with system prompts), use getContextMessages().
   */
  getMessages(): ChatMessage[] {
    return this._fullHistory;
  }

  /**
   * Set messages for BOTH _fullHistory and provider.
   * Used during session loading (init) to restore state.
   * System prompts are stripped from the input and re-injected via
   * setSystemPromptSplit() — this keeps the split boundary clean.
   */
  setMessages(messages: ChatMessage[]) {
    this._fullHistory = [...messages];
    // Reset sync tracker: assume all provider messages up to current count are synced.
    // If the provider has fewer messages (due to cleaning), new messages will be
    // picked up from (lastSyncedIndex + 1) regardless.
    this._lastSyncedProviderIndex = this.llm ? this.llm.getMessages().length - 1 : messages.length - 1;
    if (this.llm) {
      // 保留系统提示词
      const currentMessages = this.llm.getMessages();
      const systemPrompt = currentMessages.find(m => m.role === 'system');

      let messagesWithSystem = messages;
      if (systemPrompt) {
        // 过滤掉传入消息中可能存在的 system（避免重复）
        const filteredMessages = messages.filter(m => m.role !== 'system');
        messagesWithSystem = [systemPrompt, ...filteredMessages];
      }

      const cleanedMessages = this.cleanMessagesForLLM(messagesWithSystem);
      this.llm.setMessages(cleanedMessages);
    }
  }

  /**
   * Return messages for LLM API CONTEXT.
   *
   * Returns `provider.messages` — includes system prompts injected by
   * `setSystemPromptSplit()`. This is what the LLM actually sees.
   * These messages are subject to compression (Phase 1 truncation + Phase 2 summary).
   *
   * For session persistence (without system prompts), use getMessages().
   */
  getContextMessages(): ChatMessage[] {
    return this.llm?.getMessages() || [];
  }

  private agentAddMessage(message: ChatMessage): void {
    this._fullHistory.push(message);
    this.llm?.addMessage(message);
  }

  private syncFullHistory(): void {
    if (!this.llm) return;
    const providerMessages = this.llm.getMessages();
    // Use index-based tracking: always sync from (lastSyncedIndex + 1).
    // Length comparison is unreliable because cleanMessages() can shrink
    // provider messages below _fullHistory.length, permanently preventing sync.
    const startIdx = this._lastSyncedProviderIndex + 1;
    if (startIdx < providerMessages.length) {
      const newMessages = providerMessages.slice(startIdx);
      this._fullHistory.push(...newMessages);
      this._lastSyncedProviderIndex = providerMessages.length - 1;
    }
  }

  private cleanMessagesForLLM(messages: ChatMessage[]): ChatMessage[] {
    return _cleanMessagesForLLM(messages);
  }

  /**
   * Main agent execution loop
   *
   * Workflow:
   * 1. Match skill if input matches skill pattern
   * 2. Compress context if needed
   * 3. Generate LLM response
   * 5. Execute tools (parallel or sequential based on conflicts)
   * 6. Continue until finished or stagnation detected
   *
   * @param prompt - User input/prompt
   * @returns Final response string
   * @throws InterruptError if interrupted by user
   */
  async runLoop(prompt: string): Promise<string> {
    // State transition: idle → processing (or interrupted → processing)
    this._stateMachine.transition('processing');


    // Cancel-on-entry: if pendingCancel, refuse to enter
    if (this.checkCanceledOnEntry()) {
      this.pendingCancel = false;
      this.emit('agent_interrupted', { reason: 'Canceled on entry (pendingCancel)' });
      return '[INTERRUPTED] Request canceled before execution';
    }

    // 创建本次 runLoop 专用的 AbortController
    // cancelSeq is captured by clearPendingCancel in the finally block —
    // if interrupt() incremented cancelSeq during execution, clearPendingCancel
    // compares current cancelSeq with itself (always true), unblocking the next runLoop.
    const abortController = new AbortController();
    this.currentAbortController = abortController;
    const signal = abortController.signal;

    try {
      // 验证 prompt 不为空
      if (!prompt || prompt.trim().length === 0) {
        this.emit('empty_input');
        return 'Empty input - no task to execute. Please provide a prompt.';
      }

      if (!this.llm) {
        await this.init();
      }

      if (!this.llm) {
        throw new Error('LLM client not initialized');
      }

      // Pre-request: 基于token数判断是否需要压缩
      const existingMessages = this.llm.getMessages();
      const tokenCounter = this.llm.getTokenCounter();

      // 从provider获取上下文窗口大小
      const provider = this.llm.getProvider();
      const contextWindow = provider.getContextWindow();
      tokenCounter.setContextWindow(contextWindow);

      const usedTokens = tokenCounter.estimateMessages(existingMessages);
      const usagePercent = Math.floor((usedTokens / contextWindow) * 100);

      // 多级预警机制（上下文管理优化）
      if (usagePercent >= 50 && usagePercent < 60) {
        this.emit('context_warning', {
          level: 'info',
          usage: usagePercent,
          message: `Context at ${usagePercent}% - consider using subagent for complex tasks`,
          suggestion: 'Use task tool to dispatch subagent and avoid dumbzone',
        });
      } else if (usagePercent >= 60 && usagePercent < 70) {
        this.emit('context_warning', {
          level: 'warning',
          usage: usagePercent,
          message: `Context at ${usagePercent}% - strongly recommend subagent`,
          suggestion: 'Dispatch independent tasks to subagents immediately',
        });
      }

      // Adaptive thresholds based on context window size.
      // Small windows (<64K) need more aggressive compression to leave room for
      // tool results. Large windows (≥200K) can be more lenient.
      const triggerRatio = contextWindow < 32000 ? 0.55 :  // tiny: compress at 55%
        contextWindow < 64000 ? 0.70 :                     // small: compress at 70%
        contextWindow < 200000 ? 0.80 :                    // normal: compress at 80%
        0.85;                                               // huge: compress at 85%
      const targetRatio = contextWindow < 32000 ? 0.48 :
        contextWindow < 64000 ? 0.55 :
        contextWindow < 200000 ? 0.60 :
        0.65;
      const triggerThreshold = Math.floor(contextWindow * triggerRatio);

      // 当使用超过触发阈值时自动压缩
      // 分层压缩瀑布：Snip → Microcompact → Collapse → AutoCompact
      if (usedTokens > triggerThreshold) {
        const targetTokens = Math.floor(contextWindow * targetRatio);
        this.emit('context_compressing', {
          before: existingMessages.length,
          tokensBefore: usedTokens,
          target: targetTokens,
        });
        await this.manageContext(targetTokens, signal);
      }

      this.emit('token_usage', {
        used: usedTokens,
        total: contextWindow,
        ratio: usagePercent / 100,
      });

      this.emit('message', { role: 'user', content: prompt });

      // Auto-learning: detect user corrections and persist them
      if (isCorrection(prompt)) {
        saveLearning(this.workspacePath, prompt).catch(() => {});
        this.emit('learning_detected', { source: 'correction', text: prompt.slice(0, 100) });
      }

      // Inject progress context from ProgressTracker (survives compression).
      // Provider-only — NOT synced to _fullHistory (system messages don't belong there).
      const progressBlock = this._progress.toContextBlock();
      if (progressBlock && this.llm) {
        this.llm.addMessage({ role: "system" as const, content: progressBlock });
        // Prevent syncFullHistory from picking up this system-only message
        this._lastSyncedProviderIndex = this.llm.getMessages().length - 1;
      }

      const toolDefinitions = getActiveToolDefinitions(this._usedTools);
      // 重置 reasoning 状态（每次新请求前）
      this.reasoningReceived = false;
      this.emit('waiting_for_llm'); // 通知外部启动心跳

      let response;
      try {
        response = await this.callLLMWithRetry(
          sig => this.llm!.generate(prompt, toolDefinitions, sig),
          'llm_generate',
          10,
          signal // Pass abort signal
        );
      } catch (llmError: unknown) {
        const errorMsg = llmError instanceof Error ? llmError.message : String(llmError);
        this.emit('error_suggestion', {
          tool: 'llm_generate',
          error: errorMsg,
          suggestion: 'Network or API temporary error. Check network connection and retry later.',
        });
        return `LLM request failed (retried 10 times): ${errorMsg}. Check API config and network.`;
      }

      // Sync provider-auto-added messages (user + assistant response) to full history
      this.syncFullHistory();

      // 防御性检查：确保 response 存在
      if (!response) {
        this.emit('error_suggestion', {
          tool: 'llm_generate',
          error: 'LLM returned undefined',
          suggestion: 'LLM returned exception, please retry',
        });
        return 'LLM returned exception, please retry';
      }

      this._stagnationCounter = 0;
      this._reasoningContinueCount = 0;

      const allToolResults: Array<{ name: string; id: string; result: string }> = [];
      let criticalErrorDetected: { tool: string; error: string; suggestion: string } | null = null;
      let queueInjectedThisIteration = false; // 防止同一迭代内重复注入队列

      // 循环退出条件：
      //   1. finish_reason="tool_calls" → 执行工具 → 继续
      //   2. finish_reason="stop" + 内容 → LLM 说完了 → break，展示给用户
      //   3. 中断/停滞/错误 → 退出
      // 等价于 Anthropic stop_reason="end_turn" vs "tool_use"。
      while (!signal.aborted) {
        queueInjectedThisIteration = false; // 每次迭代重置

        if (signal.aborted) {
          break;
        }

        // Mid-loop: same layered waterfall as pre-request, but with higher
        // thresholds (Snip+Microcompact are free, so they always run).
        if (this._roundCount > 0 && this._roundCount % 4 === 0 && this.llm) {
          const ctxWindow = this.llm.getProvider().getContextWindow();
          const t = this.llm.getTokenCounter();
          t.setContextWindow(ctxWindow);
          const midTriggerRatio = ctxWindow < 32000 ? 0.65 :
            ctxWindow < 64000 ? 0.80 :
            ctxWindow < 200000 ? 0.88 : 0.92;
          const midTargetRatio = ctxWindow < 32000 ? 0.55 :
            ctxWindow < 64000 ? 0.65 :
            ctxWindow < 200000 ? 0.72 : 0.78;
          if (t.estimateMessages(this.llm.getMessages()) > ctxWindow * midTriggerRatio) {
            await this.manageContext(Math.floor(ctxWindow * midTargetRatio), signal);
          }
        }

        // 检查队列输入：在每次迭代开始时（LLM响应后）检查是否有新输入
        const queuedInputAtStart = this.checkQueueInput();
        if (queuedInputAtStart) {
          this.emit('queue_injected', { input: queuedInputAtStart.slice(0, 50) });
          // 将队列输入作为用户消息注入
          this.agentAddMessage({ role: 'user', content: `[QUEUED INPUT] ${queuedInputAtStart}` });
          queueInjectedThisIteration = true; // 标记已注入
        }

        if (!response.toolCalls || response.toolCalls.length === 0) {
          if (response.content) {
            // If queue was just injected, send it to LLM instead of breaking.
            // Otherwise the queue content is consumed but never processed,
            // and autoDrainQueue cannot recover it (items already marked processed).
            if (queueInjectedThisIteration) {
              this.emit('waiting_for_llm');
              try {
                response = await this.callLLMWithRetry(
                  sig => this.llm!.generateFromHistory(toolDefinitions, sig),
                  'llm_generate_queue',
                  10,
                  signal
                );
              } catch (retryError: unknown) {
                const errorMsg =
                  retryError instanceof Error ? retryError.message : String(retryError);
                this.emit('error_suggestion', {
                  tool: 'llm_generate',
                  error: errorMsg,
                  suggestion: 'LLM failed to process queued input. Check API status.',
                });
                break;
              }
              continue;
            }
            // finished=true with content → LLM intentionally ended its turn.
            // Equivalent to Anthropic's stop_reason="end_turn".
            // Respect the API signal: exit loop, show text to user.
            break;
          }
          // 空响应处理：需要区分"真正空响应"和"只有 reasoning"
          if (this.reasoningReceived) {
            // 模型发送了 reasoning 但没有 content，可能是正在思考
            // 不触发警告，直接继续调用 LLM 获取下一个响应
            this._reasoningContinueCount++;
            if (this._reasoningContinueCount > SpicaAgent.MAX_REASONING_CONTINUE) {
              this.emit('error_suggestion', {
                tool: 'llm_generate',
                error: `Exceeded ${SpicaAgent.MAX_REASONING_CONTINUE} consecutive reasoning-only responses`,
                suggestion: 'LLM is stuck in a reasoning loop. Try rephrasing your request or providing more specific instructions.',
              });
              break;
            }
            this.reasoningReceived = false; // 重置状态
            this.emit('waiting_for_llm');
            try {
              // 关键修复：使用 generateFromHistory 而不是 generate('', ...)
              // generate('', ...) 会添加空 user 消息，破坏对话历史，导致 LLM 混乱
              response = await this.callLLMWithRetry(
                sig => this.llm!.generateFromHistory(toolDefinitions, sig),
                'llm_generate_reasoning_continue',
                10,
                signal // Pass abort signal
              );
            } catch (retryError: unknown) {
              const errorMsg =
                retryError instanceof Error ? retryError.message : String(retryError);
              this.emit('error_suggestion', {
                tool: 'llm_generate',
                error: errorMsg,
                suggestion: 'LLM continuation failed after reasoning. Check API status.',
              });
              break;
            }
            continue;
          }

          // 真正的空响应：既没有 content，也没有 reasoning，也没有 tool calls
          this.emit('empty_response_warning', {
            message: 'LLM returned empty response, retrying...',
          });

          // 如果连续多次空响应，停止并报告问题
          if (this._stagnationCounter >= SpicaAgent.STAGNATION_LIMIT) {
            this.emit('error_suggestion', {
              tool: 'llm_generate',
              error: 'Multiple empty responses from LLM',
              suggestion:
                'LLM may be stuck. Try providing more specific instructions or check API status.',
            });
            break;
          }

          // 不添加额外消息 — generateFromHistory 会基于现有历史继续生成
          // 添加虚假的 user 消息会污染对话历史，让 LLM 困惑

          // 重新调用LLM获取新响应
          this.emit('waiting_for_llm');
          try {
            // 关键修复：使用 generateFromHistory 而不是 generate('', ...)
            // 因为上面已经添加了提示消息，不需要再添加空的 user 消息
            response = await this.callLLMWithRetry(
              sig => this.llm!.generateFromHistory(toolDefinitions, sig),
              'llm_generate_empty_retry',
              10,
              signal // Pass abort signal
            );
          } catch (retryError: unknown) {
            const errorMsg = retryError instanceof Error ? retryError.message : String(retryError);
            this.emit('error_suggestion', {
              tool: 'llm_generate',
              error: errorMsg,
              suggestion: 'LLM retry failed after empty response. Check API status.',
            });
            break;
          }
          continue;
        }

        if (response.toolCalls && response.toolCalls.length > 0) {
          // Batch by hint: reads first (fully parallel), writes second (with conflict detection), neutrals last
          const readCalls = response.toolCalls.filter(
            (tc: { name: string }) => getToolBatchHint(resolveAlias(tc.name)) === 'read'
          );
          const writeCalls = response.toolCalls.filter(
            (tc: { name: string }) => getToolBatchHint(resolveAlias(tc.name)) === 'write'
          );
          const neutralCalls = response.toolCalls.filter(
            (tc: { name: string }) => getToolBatchHint(resolveAlias(tc.name)) === 'neutral'
          );
          // 执行单个工具的内部函数
          const executeSingleTool = async (tc: {
            name: string;
            id: string;
            arguments: Record<string, unknown>;
          }): Promise<{
            name: string;
            id: string;
            result: string;
            isCritical?: boolean;
            referencedSkills?: string[];
          }> => {
            if (signal.aborted) return { name: tc.name, id: tc.id, result: 'interrupted' };

            const tcArgs = tc.arguments || {};

            // Hooks检查
            const hookResult = runPreHooks(tc.name, tcArgs);
            if (hookResult.matched) {
              if (hookResult.action === 'block') {
                this.emit('tool_result', {
                  name: tc.name,
                  success: false,
                  error: `Blocked: ${hookResult.message}`,
                });
                this.emit('hook_blocked', { tool: tc.name, reason: hookResult.message });
                return { name: tc.name, id: tc.id, result: `Blocked: ${hookResult.message}` };
              }

              if (hookResult.action === 'warn') {
                this.emit('hook_warning', { tool: tc.name, message: hookResult.message });
              }
            }

            // 工具白名单检查（先解析别名，确保旧名称也能通过白名单）
            const resolvedName = resolveAlias(tc.name);

            if (this.toolWhitelist && !this.toolWhitelist.includes(resolvedName)) {
              this.emit('tool_result', {
                name: tc.name,
                success: false,
                error: `Tool ${tc.name} not allowed for this subagent`,
              });
              return { name: tc.name, id: tc.id, result: `Tool ${tc.name} blocked by whitelist` };
            }

            this.emit('tool_call', { name: resolvedName, arguments: tcArgs });
            setWorkspace(this.workspacePath);

            // 传递 runLoop 的 signal 给工具（让工具能响应中断）
            tcArgs._abortSignal = signal;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const eventCallback = (event: string, data: any) => {
              this.emit(event, data);
            };

            try {
              const result = await executeTool(resolvedName, tcArgs, eventCallback);

              // Promote lazy tools on first use — the LLM asked for it,
              // so include its definition in subsequent API calls
              if (isLazyTool(resolvedName) && !this._usedTools.has(resolvedName)) {
                this._usedTools.add(resolvedName);
              }

              // Track tool usage for analytics (persisted to .spica/tool-usage.json)
              recordToolUsage(this.workspacePath, resolvedName);

              if (!result.success) {
                if (result.error?.includes('aborted') || result.error?.includes('interrupted')) {
                  this.emit('tool_result', { name: resolvedName, success: false, error: 'interrupted' });
                  return { name: resolvedName, id: tc.id, result: `Tool interrupted`, isCritical: true };
                }

                // Record non-interrupt errors in ProgressTracker
                this._progress.recordError(`${resolvedName}: ${(result.error || '').slice(0, 100)}`);

                if (this.isCriticalToolError(resolvedName, result)) {
                  const suggestion = this.generateErrorSuggestion(
                    resolvedName,
                    result.error || '',
                    tcArgs
                  );
                  criticalErrorDetected = {
                    tool: resolvedName,
                    error: result.error || 'Unknown error',
                    suggestion,
                  };
                  this.emit('tool_result', { name: resolvedName, success: false, error: result.error });
                  return {
                    name: resolvedName,
                    id: tc.id,
                    result: `Critical error: ${result.error}`,
                    isCritical: true,
                  };
                }

                this.emit('error_suggestion', {
                  toolName: resolvedName,
                  error: result.error || 'Unknown error',
                  suggestion: this.generateErrorSuggestion(resolvedName, result.error || '', tcArgs),
                });
              }

              // Record milestones: test pass, build success, git commit
              if (result.success) {
                if (resolvedName === 'bash') {
                  const cmd = String(tcArgs.command || tcArgs.cmd || '');
                  if (/\b(test|vitest|jest|mocha|pytest|cargo test|go test)\b/.test(cmd)) {
                    this._progress.recordMilestone('Tests passed');
                  } else if (/\b(npm run build|tsc|make|cmake|cargo build|go build)\b/.test(cmd)) {
                    this._progress.recordMilestone('Build succeeded');
                  }
                } else if (resolvedName === 'git' && tcArgs.action === 'commit' && tcArgs.message) {
                  this._progress.recordMilestone(`Committed: ${String(tcArgs.message).slice(0, 80)}`);
                }
              }

              if (
                result.success &&
                (resolvedName === 'write' ||
                  resolvedName === 'edit' ||
                  resolvedName === 'file_multi_edit') &&
                result.diff
              ) {
                this.emit('diff_preview', {
                  filePath: tcArgs.path || tcArgs.file_path,
                  diff: result.diff,
                });
              }

              this.emit('tool_result', {
                name: resolvedName,
                success: result.success,
                output: result.output,
                error: result.error,
                diff: result.diff,
                content: result.content,
              });

              const postHookMessage = runPostHooks(resolvedName, tcArgs, result);
              if (postHookMessage) {
                this.emit('hook_log', { tool: resolvedName, message: postHookMessage });
              }

              if (resolvedName === 'workspace' && result.success && tcArgs.path) {
                await this.switchWorkspace(tcArgs.path as string);
              }

              return {
                name: resolvedName,
                id: tc.id,
                result: result.content || result.output || result.error || '',
                referencedSkills:
                  resolvedName === 'skill' && result.success ? result.referencedSkills : undefined,
              };
            } catch (toolError: unknown) {
              const errorMsg = toolError instanceof Error ? toolError.message : String(toolError);
              this.emit('tool_result', { name: resolvedName, success: false, error: errorMsg });
              return { name: resolvedName, id: tc.id, result: `Tool execution error: ${errorMsg}` };
            }
          };

          const toolResults: Array<{
            name: string;
            id: string;
            result: string;
            isCritical?: boolean;
            referencedSkills?: string[];
          }> = [];

          // Phase 1: Execute all reads in parallel (no file conflicts possible)
          if (readCalls.length > 0) {
            const readResults = await Promise.all(readCalls.map(tc => executeSingleTool(tc)));
            toolResults.push(...readResults);
          }

          // Phase 2: Execute writes with conflict detection
          if (writeCalls.length > 0) {
            const { parallel, sequential, conflicts } = detectToolConflicts(writeCalls);
            if (conflicts.length > 0) {
              this.emit('tool_conflict_warning', {
                conflicts,
                message: `Detected ${conflicts.length} resource conflicts. Write tools targeting same resources will execute sequentially.`,
              });
            }
            const parallelResults = await Promise.all(parallel.map(tc => executeSingleTool(tc)));
            toolResults.push(...parallelResults);
            for (const conflictGroup of sequential) {
              for (const tc of conflictGroup) {
                if (signal.aborted) {
                  toolResults.push({ name: tc.name, id: tc.id, result: 'interrupted' });
                  break;
                }
                const result = await executeSingleTool(tc);
                toolResults.push(result);
              }
            }
          }

          // Phase 3: Execute neutral tools (all parallel)
          if (neutralCalls.length > 0) {
            const neutralResults = await Promise.all(neutralCalls.map(tc => executeSingleTool(tc)));
            toolResults.push(...neutralResults);
          }

          allToolResults.push(...toolResults);

          // Progress tracking: detect meaningful agent actions this round.
          // Broadens beyond file I/O — git commits, test runs, and package
          // installs are also progress. Only toolResults carry resolved names.
          const mutationTools = new Set([
            "write", "edit", "file_multi_edit", "file_delete",
          ]);

          /** Check whether a single tool result signals real progress.
           *  "Progress" means the agent is actively working — reading code,
           *  searching, running commands, making changes. Only failures or
           *  interruptions count as no-progress rounds. */
          const isProgressResult = (
            t: { name: string; id: string; result: string },
            _toolCalls: Array<{ name: string; id: string; arguments: Record<string, unknown> }>
          ): boolean => {
            if (t.result.includes("interrupted") || t.result.includes("blocked")) return false;
            if (t.result.includes('"success":false') || t.result.includes('"success": false')) return false;
            // Any successful tool call means the agent is working
            return true;
          };

          const hadProgress = toolResults.some(t => isProgressResult(t, response.toolCalls!));

          // Record progress in ProgressTracker (survives compression).
          // Uses the original toolCalls (which still carry arguments) to
          // extract file paths.
          if (hadProgress && response.toolCalls) {
            for (const tc of response.toolCalls) {
              const resolved = resolveAlias(tc.name);
              if (mutationTools.has(resolved)) {
                const filePath =
                  (tc.arguments as any)?.path ||
                  (tc.arguments as any)?.file_path ||
                  (tc.arguments as any)?.source ||
                  '';
                if (filePath) {
                  this._progress.recordFileChange(
                    resolved === 'file_delete' ? 'file_written' : 'file_edited',
                    filePath
                  );
                }
              }
            }
          }

          // Stagnation check: catch agent stuck in a loop of failing tools.
          // Any successful tool call (read, grep, write, bash, etc.) counts as progress.
          // Only consecutive rounds where ALL tools fail/interrupt are "stagnant".
          const stagnationResult = this.checkStagnation(hadProgress);
          if (stagnationResult === "warn") {
            this.emit("stagnation_warning", { rounds: SpicaAgent.STAGNATION_WARNING });
          } else if (stagnationResult === "stop") {
            this.emit("stagnation_limit", { rounds: SpicaAgent.STAGNATION_LIMIT });
            return "[STAGNATION] No successful tool calls after " + SpicaAgent.STAGNATION_LIMIT +
              " rounds. All tools are failing or interrupted. Please check the environment and provide new instructions.";
          }

          // Periodic session save: persist every N tool rounds for crash resilience
          this._roundCount++;
          if (this._roundCount % SpicaAgent.SAVE_EVERY_N_ROUNDS === 0) {
            try {
              saveSession(
                this.workspacePath,
                this.getSessionState(),
                undefined,
                this._progress.toJSON(),
              );
            } catch {
              // Best-effort — don't crash on save failure
            }
          }

          // 中断检查：如果被中断，先保存tool results到历史，再停止
          if (signal.aborted) {
            // 重要：保存已执行的tool results，避免历史损坏（缺少tool messages导致API报错）
            if (toolResults.length > 0 && this.llm) {
              this.llm.addToolMessages(toolResults.map(t => ({ id: t.id, result: t.result })));
            }
            // 注意：不再 emit agent_interrupted，因为 interrupt() 已经触发过了
            return '[INTERRUPTED] Agent execution stopped by user (ESC ESC). You can retry or continue with a new request.';
          }

          // 关键错误检查：如果检测到关键错误，停止生成并报告
          const criticalError = criticalErrorDetected as {
            tool: string;
            error: string;
            suggestion: string;
          } | null;
          if (criticalError) {
            this.emit('agent_stopped_on_error', {
              tool: criticalError.tool,
              error: criticalError.error,
              suggestion: criticalError.suggestion,
            });
            return `[STOPPED] Agent stopped due to critical error in ${criticalError.tool}.\nError: ${criticalError.error}\nSuggestion: ${criticalError.suggestion}\nPlease fix the issue and retry.`;
          }

          // Skill chain: collect referenced skills for post-tool injection
          const referencedSkills = toolResults
            .filter(t => t.referencedSkills && t.referencedSkills.length > 0)
            .flatMap(t => t.referencedSkills || []);

          const skillMessages = referencedSkills.map(refName => ({
            role: 'system' as const,
            content: `REQUIRED_SKILL: ${refName}`,
          }));

          // 检查队列输入：在工具执行完成后注入新指令（如果迭代开始时没有注入过）
          // 只有当迭代开始时没有注入队列，才在这里检查并注入
          let queuedInput: string | null = null;
          if (!queueInjectedThisIteration) {
            queuedInput = this.checkQueueInput();
            if (queuedInput) {
              this.emit('queue_injected', { input: queuedInput.slice(0, 50) });
            }
          }

          // 合并所有后置消息
          const postToolMessages = [
            ...skillMessages,
            ...(queuedInput
              ? [{ role: 'user' as const, content: `[QUEUED INPUT] ${queuedInput}` }]
              : []),
          ];

          // 所有工具完成后，一次性发送所有结果给LLM继续生成
          if (toolResults.length > 0) {
            this.emit('waiting_for_llm'); // 通知外部启动心跳
            try {
              response = await this.callLLMWithRetry(
                sig =>
                  this.llm!.continueWithAllToolResults(
                    toolResults.map(t => ({ name: t.name, result: t.result, id: t.id })),
                    toolDefinitions,
                    postToolMessages, // 在 tool 消息之后添加
                    sig // Pass signal
                  ),
                'llm_continue',
                10,
                signal // Pass abort signal
              );
              // Sync tool results and assistant response to full history
              this.syncFullHistory();
            } catch (llmError: unknown) {
              const errorMsg = llmError instanceof Error ? llmError.message : String(llmError);
              const isRetryable = this.isRetryableError(llmError);

              // 关键修复：保留已执行的 tool results，不要丢弃
              // 只有当工具确实执行了才保留，否则清理不完整序列
              const toolsActuallyExecuted = toolResults.filter(
                t => t.result !== 'interrupted' && !t.result.includes('blocked by whitelist')
              );

              this.emit('error_suggestion', {
                tool: 'llm_continue',
                error: errorMsg,
                suggestion: isRetryable
                  ? 'Network or API temporary error (retried 10 times). Tool results preserved - continue conversation.'
                  : `Error not retryable: ${errorMsg}. Tool results preserved.`,
              });

              // 添加一个用户消息记录已执行的操作（方便继续）
              if (toolsActuallyExecuted.length > 0) {
                const resultsSummary = toolsActuallyExecuted
                  .map(t => `[${t.name}] ${t.result.slice(0, 200)}`)
                  .join('\n');
                this.agentAddMessage({
                  role: 'user' as const,
                  content: `[SYSTEM NOTE] Previous operations completed but LLM response failed. Results:\n${resultsSummary}\nError: ${errorMsg}\nPlease continue based on these results.`,
                });
              }

              // 不清理 tool messages，保留完整历史
              // cleanMessages 会在下次 generate 时处理不完整序列
              // Sync provider-added messages (tool results, partial assistant response) to full history
              this.syncFullHistory();

              const resultsSummary = toolResults
                .map(t => `${t.name}: ${t.result.slice(0, 100)}`)
                .join('\n');
              return `Operations completed but LLM continuation failed.\nError: ${errorMsg}\nCompleted operations:\n${resultsSummary}\nTool results preserved in history. Continue conversation to proceed.`;
            }
          }
        }
      }

      // 循环退出可能原因：
      // 1. signal.aborted → break at 1055 → 返回中断状态
      // 2. 空响应停滞限制 → break → 返回停滞状态
      if (signal.aborted) {
        return '[INTERRUPTED] Agent execution stopped by user (ESC ESC). You can retry or continue with a new request.';
      }

      const assistantContent =
        response.content ||
        this.llm
          ?.getMessages()
          .filter(m => m.role === 'assistant')
          .pop()?.content ||
        '';

      if (assistantContent) {
        this.emit('message', { role: 'assistant', content: assistantContent });
      }

      if (this._todos.length > 0) {
        const state = loadProjectState(this.workspacePath) || {
          phase: 'unknown' as const,
          todos: [],
          decisions: [],
          lastActivity: new Date().toISOString(),
          recentFiles: [],
        };
        state.todos = this._todos;
        saveProjectState(this.workspacePath, state);
      }

      return assistantContent || '[STAGNATION] No response from LLM. The agent may be stuck.';
    } finally {
      this.currentAbortController = null;
      this.clearPendingCancel(this.cancelSeq);
      // Always transition back to idle. The 'interrupted' state is transient —
      // pendingCancel and cancelSeq handle interrupt gating, not the state machine.
      // Staying in 'interrupted' blocks subsequent user input.
      this._stateMachine.transition('idle');
    }
  }

  getProjectConfig(): ProjectConfig {
    return this.projectConfig;
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  async switchWorkspace(newPath: string): Promise<void> {
    this.workspacePath = newPath;

    // 重置状态
    this.projectConfig = {};
    this._todos = [];
    this._initialized = false;
    this._initPromise = null;
    this._stateMachine.reset(); // sync with _initialized=false
    sessionStats.reset();

    // 清空LLM消息历史
    if (this.llm) {
      this.llm.setMessages([]);
    }
    this._fullHistory = [];
    this._lastSyncedProviderIndex = -1;
    this._usedTools = new Set();
    this._progress.clear(); // clear progress from old project

    // 发送workspace变更事件
    this.emit('workspace_changed', { path: newPath });

    // 重新初始化（检测新项目）
    await this.init();
  }

  private generateErrorSuggestion(
    toolName: string,
    error: string,
    args: Record<string, unknown>
  ): string {
    const suggestions: Record<string, (e: string, a: Record<string, unknown>) => string> = {
      read: (e, a) =>
        e.includes('ENOENT')
          ? `File not found: ${a.path}. Try: glob to find similar files, or check path spelling.`
          : e.includes('EACCES')
            ? `Permission denied: ${a.path}. Try: check file permissions, or use different path.`
            : `Read failed. Try: check path exists, or use glob to search.`,
      write: (e, a) =>
        e.includes('EACCES')
          ? `Permission denied: ${a.path}. Try: check file permissions, or use different path.`
          : e.includes('ENOENT')
            ? `Directory not found: ${a.path}. Try: create directory first with directory_create.`
            : `Write failed. Try: check path and content, or use edit for existing files.`,
      edit: (e, a) =>
        e.includes('not found')
          ? `Text not found in file. Try: read file first to get exact text, or use smaller snippet.`
          : `Edit failed. Try: read file to verify content, or use write to overwrite.`,
      bash: (e, a) =>
        e.includes('command not found')
          ? `Command not found: ${a.command}. Try: install required tool, or use alternative command.`
          : e.includes('Permission denied')
            ? `Permission denied: ${a.command}. Try: check permissions, or use sudo if safe.`
            : e.includes('timeout')
              ? `Command timed out. Consider: detached=true, longer timeout, or break into smaller steps.`
              : `Execution failed. Try: check command syntax, or use simpler command.`,
      glob: (e, a) =>
        `Search failed: ${a.pattern}. Try: simpler pattern (e.g., *.ts), or check directory exists.`,
      grep: (e, a) => `Search failed. Try: simpler pattern, or use glob first to find files.`,
      test: (e, _a) =>
        e.includes('timeout')
          ? `Test timed out. Consider: run with longer timeout, run specific test file, or use quick validation (tsc, lint).`
          : `Test failed. Try: run single test file, or check test output for details.`,
      lint: (e, _a) =>
        e.includes('error')
          ? `Lint errors found. Try: fix errors one by one, or use format tool.`
          : `Lint failed. Try: check file syntax, or run on smaller scope.`,
      directory_list: (e, a) =>
        `Directory listing failed: ${a.path}. Try: check path exists, or use glob to search.`,
      file_delete: (e, a) =>
        `Delete failed: ${a.path}. Try: check file exists, or check permissions.`,
      file_copy: (e, a) =>
        `Copy failed. Try: check source exists: ${a.source}, or check destination path.`,
      file_move: (e, a) =>
        `Move failed. Try: check source exists: ${a.source}, or check destination permissions.`,
    };

    const baseSuggestion =
      suggestions[toolName]?.(error, args) || `Tool ${toolName} failed. Check parameters.`;

    return baseSuggestion;
  }

  /**
   * Report BLOCKED status when agent cannot proceed
   *
   * Triggered when:
   * - Multiple consecutive tool failures
   * - Critical errors that cannot be recovered
   * - Agent needs user guidance
   *
   * @param context - Blocked context information
   * @emits agent_blocked with full context
   */
  private reportBlocked(context: {
    task: string;
    attempted: string[];
    failed: string[];
    error: string;
    suggestions: string[];
  }): string {
    this.emit('agent_blocked', {
      status: 'BLOCKED',
      ...context,
      timestamp: new Date().toISOString(),
    });

    return (
      `[BLOCKED] Agent needs help.\n` +
      `Task: ${context.task}\n` +
      `Attempted: ${context.attempted.join(', ')}\n` +
      `Failed: ${context.failed.join(', ')}\n` +
      `Error: ${context.error}\n` +
      `Suggestions:\n${context.suggestions.map(s => `  - ${s}`).join('\n')}\n` +
      `Please provide guidance or break down the task.`
    );
  }

  // 公开方法：手动压缩历史（使用 LLM 生成摘要）
  /**
   * Compact message history to reduce token usage
   *
   * Triggered when:
   * - Used tokens > 80% of context window
   *
   * Effects:
   * - Summarizes old messages
   * - Keeps recent tool calls and results
   * - Emits 'context_compressed' event
   *
  /** Synchronous context compression — summary REPLACES old messages. */
  /** Layered context management: Snip → Microcompact → Collapse → AutoCompact */
  private async manageContext(
    targetTokens: number,
    signal?: AbortSignal
  ): Promise<void> {
    return _manageContext(this, targetTokens, signal);
  }

  // Legacy: synchronous compact for backward compatibility (/compact command)
  public async compact(signal?: AbortSignal): Promise<void> {
    if (!this.llm) return;
    const provider = this.llm.getProvider();
    const targetTokens = Math.floor(provider.getContextWindow() * 0.4);
    // Delegates to manageContext which handles state + re-entry protection
    await this.manageContext(targetTokens, signal);
  }

  /**
   * Build a summary prompt from messages (without calling LLM).
   */
  private buildSummaryPrompt(messages: ChatMessage[]): string {
    return _buildSummaryPrompt(messages);
  }

  // Generate history summary using LLM.
  // Tool result content is discarded — only tool names + key args are kept.
  // This gives the LLM enough context to summarize what happened without
  // overwhelming it with raw file contents, grep output, or bash stdout.
  private async generateSummary(
    messages: ChatMessage[],
    signal?: AbortSignal
  ): Promise<ChatMessage> {
    return _generateSummary(this.llm!, messages, signal);
  }
}
