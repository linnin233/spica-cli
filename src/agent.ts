import { LLMClient } from './llm/LLMClient';
import { executeTool, getAllToolDefinitions, setWorkspace, getToolBatchHint } from './tools/index';
import { initMCP } from './mcp/client';
import { initSkills, listSkills } from './skills/index';
import { getProviderConfig } from './utils/settings';
import {
  getSystemPrompt,
  getSystemPromptStable,
  getSystemPromptVariable,
  getCompactPrompt,
} from './prompts/system';
import {
  loadProjectConfig as loadAgentsConfig,
  autoDetectProject,
  createAgentsMd,
  type ProjectConfig,
} from './utils/projectConfig';
import { SkillDefinition } from './utils/settings';
import { cleanMessages } from './utils/messageCleaner';
import {
  loadProjectState,
  saveProjectState,
  updateProjectTodos,
  saveProjectContext,
  ensureProjectDir,
} from './storage/projectState';
import { loadSession } from './utils/session';
import { runPreHooks, runPostHooks } from './hooks';
import {
  createCheckpoint,
  listCheckpoints,
  type CheckpointMeta,
} from './storage/checkpointManager';
import { EventEmitter } from 'events';
import simpleGit from 'simple-git';
import type { ChatMessage } from './llm/providers/BaseProvider';

// 工具冲突检测：提取资源路径
function extractResourcePath(toolName: string, args: Record<string, unknown>): string | null {
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
    ].includes(toolName)
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
  private workspacePath: string;
  private projectConfig: ProjectConfig = {};
  private _todos: Todo[] = [];
  private _initialized = false;
  private _initPromise: Promise<void> | null = null;
  private _providerName?: string;
  private _cachedSkills: SkillDefinition[] = [];
  private _compacting = false;
  // Non-blocking compression: LLM summary runs in background
  private _pendingCompression: Promise<void> | null = null;
  private _deferredSummary: ChatMessage | null = null;
  // Full history — append-only, independent of LLM context compression
  // Used by getMessages() for session persistence. Never truncated by compression.
  private _fullHistory: ChatMessage[] = [];

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

  // Summary key args — tool arguments worth preserving in compressed summaries
  private static readonly SUMMARY_KEY_ARGS = new Set([
    'path',
    'command',
    'action',
    'pattern',
    'query',
    'url',
    'question',
    'prompt',
  ]);

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
   * Dispose internal resources — removes LLM event listeners and clears references.
   * Call this when a sub-agent is no longer needed to prevent listener leaks.
   */
  dispose(): void {
    if (this.llm) {
      this.llm.removeAllListeners();
      this.llm = null;
    }
    this.removeAllListeners();
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

  // 创建自动 checkpoint（文件快照，不创建 git commit）
  private async createAutoCheckpoint(prompt: string): Promise<CheckpointMeta | null> {
    try {
      const meta = await createCheckpoint(this.workspacePath, prompt);

      if (meta) {
        this.emit('checkpoint_created', {
          id: meta.id,
          message: meta.message,
          filesBackedUp: meta.filesBackedUp.length,
        });
      }

      return meta;
    } catch {
      // checkpoint 失败不影响 AI 工作
      this.emit('checkpoint_warning', { error: 'Failed to create checkpoint' });
      return null;
    }
  }

  // 获取最近的 checkpoint 列表
  async getCheckpoints(): Promise<CheckpointMeta[]> {
    return await listCheckpoints(this.workspacePath, 50);
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

        const start = Date.now();
        while (Date.now() - start < delay) {
          if (signal?.aborted) {
            throw new InterruptError('Interrupted by user during retry delay');
          }
          await new Promise(resolve => setTimeout(resolve, 100));
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
    if (this._initialized) return;
    if (this._initPromise) return this._initPromise;

    this._initPromise = this._doInit();
    try {
      await this._initPromise;
      this._initialized = true;
    } finally {
      this._initPromise = null;
    }
  }

  /**
   * Lightweight init for sub-agents — skips MCP, skills, API check, session loading.
   * Creates a fresh LLMClient with the same API config (no shared message state).
   * Inherits the parent's system prompt, workspace, and a summary of recent context.
   */
  async initAsSubAgent(parentAgent: SpicaAgent): Promise<void> {
    if (this._initialized) return;

    const parentProviderName = parentAgent._providerName || this._providerName;
    const config = await getProviderConfig(parentProviderName);

    // Fresh LLM client — same API, isolated message history
    this.llm = new LLMClient({
      provider: parentProviderName || 'openai',
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      name: config.name,
    });

    // Inherit system prompt from parent
    const parentMessages = parentAgent.getLLM()?.getMessages() || [];
    const parentSystemMsg = parentMessages.find(m => m.role === 'system');
    if (parentSystemMsg?.content) {
      this.llm.setSystemPrompt(parentSystemMsg.content);
    }

    // Inject recent context summary — so sub-agent knows what's happening
    const recentUserMessages = parentMessages
      .filter(m => m.role === 'user')
      .slice(-3)
      .map(m => (m.content || '').slice(0, 200));
    const recentAssistantActions = parentMessages
      .filter(m => m.role === 'assistant' && m.toolCalls)
      .slice(-3)
      .map(m => {
        const tools = m.toolCalls?.map(tc => tc.name).join(', ') || '';
        const content = (m.content || '').slice(0, 80);
        return `[${tools}] ${content}`;
      });

    if (recentUserMessages.length > 0 || recentAssistantActions.length > 0) {
      const contextParts: string[] = [
        '[SUB-AGENT CONTEXT] You are a sub-agent working on part of a larger task.',
      ];
      if (recentUserMessages.length > 0) {
        contextParts.push(
          `Recent user requests:\n${recentUserMessages.map(m => `- ${m}`).join('\n')}`
        );
      }
      if (recentAssistantActions.length > 0) {
        contextParts.push(
          `Recent actions taken:\n${recentAssistantActions.map(a => `- ${a}`).join('\n')}`
        );
      }
      if (this._todos.length > 0) {
        const pendingTodos = this._todos.filter(t => t.status !== 'completed').slice(0, 5);
        if (pendingTodos.length > 0) {
          contextParts.push(
            `Current todos:\n${pendingTodos.map(t => `- [${t.status}] ${t.content}`).join('\n')}`
          );
        }
      }
      this.agentAddMessage({
        role: 'system',
        content: contextParts.join('\n\n'),
      });
    }

    // Inherit workspace and todos from parent
    this.workspacePath = parentAgent.getWorkspacePath();
    this._todos = [...parentAgent.todos];

    // Setup stream forwarding
    this.llm.on('chunk', (chunk: string) => {
      this.emit('stream', { chunk });
    });
    this.llm.on('reasoning', (content: string) => {
      this.reasoningReceived = true;
      this.emit('reasoning', { content });
    });

    this._initialized = true;
  }

  private async _doInit(): Promise<void> {
    // 初始化Skills（首次运行时复制默认包）
    await initSkills();

    // 初始化MCP服务器连接
    try {
      await initMCP();
    } catch {
      console.log('MCP init skipped (no config or servers unavailable)');
    }

    const config = await getProviderConfig(this._providerName);
    this.llm = new LLMClient({
      provider: this._providerName || 'openai',
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      name: config.name,
    });

    // 检查API连接
    const connectionResult = await this.llm.checkConnection();

    if (!connectionResult.success) {
      this.emit('connection_error', {
        type: connectionResult.type,
        error: connectionResult.error,
        hint: connectionResult.hint,
        provider: this._providerName,
        model: config.model,
      });
      throw new Error(
        `API connection failed: ${connectionResult.type}\n${connectionResult.hint}\nDetails: ${connectionResult.error}`
      );
    }

    ensureProjectDir(this.workspacePath);

    // 从session文件加载完整历史（不是损坏的context.json）
    const session = loadSession(this.workspacePath);
    if (session && session.messages.length > 0) {
      // session.messages已经通过cleanMessages清理过了
      this.llm.setMessages(session.messages);
      this._fullHistory = [...session.messages];
    }

    const projectState = loadProjectState(this.workspacePath);
    if (projectState) {
      this._todos = projectState.todos;
    }

    await this.loadProjectConfig();

    // Build skills metadata for system prompt
    const skills = listSkills(this.workspacePath);
    const skillsMetadata = skills.map(s => `- ${s.name}: ${s.description}`).join('\n');

    const stablePrompt = getSystemPromptStable(this.projectConfig);
    const variablePrompt = getSystemPromptVariable(skillsMetadata, this.workspacePath);
    this.llm.setSystemPromptSplit(stablePrompt, variablePrompt);

    this.llm.on('chunk', (chunk: string) => {
      this.emit('stream', { chunk });
    });

    // 追踪 reasoning 状态，用于判断真正的空响应
    this.llm.on('reasoning', (content: string) => {
      this.reasoningReceived = true;
      this.emit('reasoning', { content });
    });

    this.emit('initialized', {
      model: config.model,
      project: this.projectConfig,
    });
  }

  private async loadProjectConfig(): Promise<void> {
    // 使用新的 projectConfig.ts（兼容多种格式）
    const loadedConfig = loadAgentsConfig(this.workspacePath);

    if (loadedConfig) {
      this.projectConfig = loadedConfig;
      this.emit('projectLoaded', this.projectConfig);
    } else {
      // 无配置文件，自动检测并创建 AGENTS.md
      const autoConfig = autoDetectProject(this.workspacePath);
      this.projectConfig = autoConfig;
      await createAgentsMd(this.workspacePath);
      this.emit('projectCreated', autoConfig);
    }
  }

  setTodos(todos: string[]) {
    this._todos = todos.map(t => ({ content: t, status: 'pending' }));
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

  getMessages(): ChatMessage[] {
    return this._fullHistory;
  }

  setMessages(messages: ChatMessage[]) {
    this._fullHistory = [...messages];
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
    if (providerMessages.length > this._fullHistory.length) {
      const newMessages = providerMessages.slice(this._fullHistory.length);
      this._fullHistory.push(...newMessages);
    }
  }

  private cleanMessagesForLLM(messages: ChatMessage[]): ChatMessage[] {
    return cleanMessages(messages);
  }

  /**
   * Main agent execution loop
   *
   * Workflow:
   * 1. Match skill if input matches skill pattern
   * 2. Create auto checkpoint before work
   * 3. Compress context if needed
   * 4. Generate LLM response
   * 5. Execute tools (parallel or sequential based on conflicts)
   * 6. Continue until finished or max iterations
   *
   * @param prompt - User input/prompt
   * @param maxIterations - Maximum loop iterations (default: 50)
   * @returns Final response string
   * @throws InterruptError if interrupted by user
   */
  async runLoop(prompt: string, maxIterations = 50): Promise<string> {
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

      // Auto-checkpoint before AI work (file snapshot, no git pollution)
      await this.createAutoCheckpoint(prompt);

      // Apply any deferred summary from previous compression
      this.applyPendingSummary();

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

      const triggerThreshold = Math.floor(contextWindow * 0.6); // 触发阈值：60%（现代设计，更早触发避免过满）

      // 当使用超过触发阈值时自动压缩
      // 非阻塞：规则截断立即生效，LLM 摘要在后台异步生成，下次请求前注入
      if (usedTokens > triggerThreshold) {
        const targetTokens = Math.floor(contextWindow * 0.4);
        await this.startNonBlockingCompression(targetTokens, signal);
      }

      this.emit('token_usage', {
        used: usedTokens,
        total: contextWindow,
        ratio: usagePercent / 100,
      });

      this.emit('message', { role: 'user', content: prompt });

      const toolDefinitions = getAllToolDefinitions();
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

      let iterations = 0;

      const allToolResults: Array<{ name: string; id: string; result: string }> = [];
      let criticalErrorDetected: { tool: string; error: string; suggestion: string } | null = null;
      let queueInjectedThisIteration = false; // 防止同一迭代内重复注入队列

      while (!response.finished && iterations < maxIterations && !signal.aborted) {
        iterations++;
        queueInjectedThisIteration = false; // 每次迭代重置

        if (signal.aborted) {
          break;
        }

        // 检查队列输入：在每次迭代开始时（LLM响应后）检查是否有新输入
        const queuedInputAtStart = this.checkQueueInput();
        if (queuedInputAtStart) {
          this.emit('queue_injected', { input: queuedInputAtStart.slice(0, 50) });
          // 将队列输入作为用户消息注入
          this.agentAddMessage({ role: 'user', content: `[QUEUED INPUT] ${queuedInputAtStart}` });
          queueInjectedThisIteration = true; // 标记已注入
        }

        // 检查response状态
        if (!response.toolCalls || response.toolCalls.length === 0) {
          if (response.content) {
            // 有内容输出，任务完成
            break;
          }
          // 空响应处理：需要区分"真正空响应"和"只有 reasoning"
          if (this.reasoningReceived) {
            // 模型发送了 reasoning 但没有 content，可能是正在思考
            // 不触发警告，直接继续调用 LLM 获取下一个响应
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
            iteration: iterations,
            message: 'LLM returned empty response, retrying...',
          });

          // 如果连续多次空响应，停止并报告问题
          if (iterations >= maxIterations - 1) {
            this.emit('error_suggestion', {
              tool: 'llm_generate',
              error: 'Multiple empty responses from LLM',
              suggestion:
                'LLM may be stuck. Try providing more specific instructions or check API status.',
            });
            break;
          }

          // 添加提示消息，让LLM继续尝试
          this.agentAddMessage({
            role: 'user' as const,
            content:
              '[SYSTEM] Previous response was empty. Please continue working on the task and provide a response or use tools.',
          });

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
            (tc: { name: string }) => getToolBatchHint(tc.name) === 'read'
          );
          const writeCalls = response.toolCalls.filter(
            (tc: { name: string }) => getToolBatchHint(tc.name) === 'write'
          );
          const neutralCalls = response.toolCalls.filter(
            (tc: { name: string }) => getToolBatchHint(tc.name) === 'neutral'
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

            // 工具白名单检查
            if (this.toolWhitelist && !this.toolWhitelist.includes(tc.name)) {
              this.emit('tool_result', {
                name: tc.name,
                success: false,
                error: `Tool ${tc.name} not allowed for this subagent`,
              });
              return { name: tc.name, id: tc.id, result: `Tool ${tc.name} blocked by whitelist` };
            }

            this.emit('tool_call', { name: tc.name, arguments: tcArgs });
            setWorkspace(this.workspacePath);

            // 传递 runLoop 的 signal 给工具（让工具能响应中断）
            tcArgs._abortSignal = signal;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const eventCallback = (event: string, data: any) => {
              this.emit(event, data);
            };

            try {
              const result = await executeTool(tc.name, tcArgs, eventCallback);

              if (!result.success) {
                if (result.error?.includes('aborted') || result.error?.includes('interrupted')) {
                  this.emit('tool_result', { name: tc.name, success: false, error: 'interrupted' });
                  return { name: tc.name, id: tc.id, result: `Tool interrupted`, isCritical: true };
                }

                if (this.isCriticalToolError(tc.name, result)) {
                  const suggestion = this.generateErrorSuggestion(
                    tc.name,
                    result.error || '',
                    tcArgs
                  );
                  criticalErrorDetected = {
                    tool: tc.name,
                    error: result.error || 'Unknown error',
                    suggestion,
                  };
                  this.emit('tool_result', { name: tc.name, success: false, error: result.error });
                  return {
                    name: tc.name,
                    id: tc.id,
                    result: `Critical error: ${result.error}`,
                    isCritical: true,
                  };
                }

                this.emit('error_suggestion', {
                  toolName: tc.name,
                  error: result.error || 'Unknown error',
                  suggestion: this.generateErrorSuggestion(tc.name, result.error || '', tcArgs),
                });
              }

              if (
                result.success &&
                (tc.name === 'write' ||
                  tc.name === 'edit' ||
                  tc.name === 'file_multi_edit') &&
                result.diff
              ) {
                this.emit('diff_preview', {
                  filePath: tcArgs.path || tcArgs.file_path,
                  diff: result.diff,
                });
              }

              this.emit('tool_result', {
                name: tc.name,
                success: result.success,
                output: result.output,
                error: result.error,
                diff: result.diff,
                content: result.content,
              });

              const postHookMessage = runPostHooks(tc.name, tcArgs, result);
              if (postHookMessage) {
                this.emit('hook_log', { tool: tc.name, message: postHookMessage });
              }

              if (tc.name === 'workspace' && result.success && tcArgs.path) {
                await this.switchWorkspace(tcArgs.path as string);
              }

              return {
                name: tc.name,
                id: tc.id,
                result: result.content || result.output || result.error || '',
                referencedSkills:
                  tc.name === 'skill' && result.success ? result.referencedSkills : undefined,
              };
            } catch (toolError: unknown) {
              const errorMsg = toolError instanceof Error ? toolError.message : String(toolError);
              this.emit('tool_result', { name: tc.name, success: false, error: errorMsg });
              return { name: tc.name, id: tc.id, result: `Tool execution error: ${errorMsg}` };
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

              const resultsSummary = toolResults
                .map(t => `${t.name}: ${t.result.slice(0, 100)}`)
                .join('\n');
              return `Operations completed but LLM continuation failed.\nError: ${errorMsg}\nCompleted operations:\n${resultsSummary}\nTool results preserved in history. Continue conversation to proceed.`;
            }
          }
        } else {
          break;
        }
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

      if (this.llm) {
        const allMessages = this.llm.getMessages();

        // 结束时保存，只保留 user 和 assistant 消息，移除 toolCalls 防止 API 报错
        const simplifiedMessages = allMessages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .map(m => ({
            role: m.role,
            content: m.content || '',
          }));

        saveProjectContext(this.workspacePath, simplifiedMessages);

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
      }

      return assistantContent;
    } finally {
      this.currentAbortController = null;
      this.clearPendingCancel(this.cancelSeq);
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

    // 清空LLM消息历史
    if (this.llm) {
      this.llm.setMessages([]);
    }
    this._fullHistory = [];

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
   * @returns Promise that resolves when compression complete
   * @emits context_compressed with { before, after, removed }
   */
  /**
   * Non-blocking compression: rule-truncate immediately, LLM summary in background.
   *
   * Phase 1 (instant): Keep last N messages, truncate long content — tokens drop NOW.
   * Phase 2 (background): Fire LLM summary for old messages, store for next request.
   *
   * On the next request, applyPendingSummary() injects the summary after system messages.
   */
  private async startNonBlockingCompression(
    targetTokens: number,
    signal?: AbortSignal
  ): Promise<void> {
    if (!this.llm) return;
    this._compacting = true;

    try {
      const allMessages = this.llm.getMessages();
      const systemMessages = allMessages.filter(m => m.role === 'system');
      const nonSystem = allMessages.filter(m => m.role !== 'system');

      if (nonSystem.length === 0) {
        this.emit('context_compressed', {
          before: allMessages.length,
          after: allMessages.length,
          tokensBefore: 0,
          tokensAfter: 0,
        });
        return;
      }

      const tokenCounter = this.llm.getTokenCounter();
      const provider = this.llm.getProvider();
      tokenCounter.setContextWindow(provider.getContextWindow());
      const contextWindow = provider.getContextWindow();
      const usedTokens = tokenCounter.estimateMessages(nonSystem);

      if (usedTokens < targetTokens) {
        this.emit('context_compressed', {
          before: allMessages.length,
          after: allMessages.length,
          tokensBefore: usedTokens,
          tokensAfter: usedTokens,
        });
        return;
      }

      // --- Phase 1: Rule-based truncation (instant) ---
      const ratio = usedTokens / targetTokens;
      let keepCount = ratio > 2 ? 5 : ratio > 1.5 ? 8 : 12;
      const minKeep = Math.max(3, Math.min(8, Math.ceil(contextWindow / 50000)));
      keepCount = Math.max(
        minKeep,
        Math.min(keepCount, Math.max(minKeep + 2, 15), Math.floor(nonSystem.length * 0.25))
      );

      // Score messages by importance — keep high-value context (file writes, user intent)
      // even if they're not in the recent tail
      const scored = nonSystem.map((m, i) => ({
        msg: m,
        score: this.scoreMessage(m, i, nonSystem.length),
      }));
      const lastCount = Math.max(2, Math.ceil(keepCount / 3)); // always keep recent tail
      const tail = scored.slice(-lastCount);
      const head = scored.slice(0, -lastCount);
      head.sort((a, b) => b.score - a.score);
      const topHead = head.slice(0, Math.max(0, keepCount - lastCount));
      const selected = [...topHead, ...tail]
        .sort((a, b) => {
          // restore chronological order from original indices
          const ai = nonSystem.indexOf(a.msg);
          const bi = nonSystem.indexOf(b.msg);
          return ai - bi;
        })
        .map(s => s.msg);

      const oldMessages = nonSystem.filter(m => !selected.includes(m));

      const maxContentLength = Math.max(500, Math.floor(contextWindow * 0.01));

      const truncatedRecent = selected.map(m => {
        const truncatedContent =
          (m.content || '').length > maxContentLength
            ? (m.content || '').slice(0, maxContentLength) + '...[truncated]'
            : m.content;

        const maxToolCalls = Math.max(3, Math.min(10, Math.floor(contextWindow / 25000)));
        let truncatedToolCalls = m.toolCalls;
        if (m.toolCalls && m.toolCalls.length > maxToolCalls) {
          truncatedToolCalls = m.toolCalls.slice(0, maxToolCalls);
          truncatedToolCalls.push({ id: 'truncated', name: '...[truncated]', arguments: {} });
        }

        return { ...m, content: truncatedContent, toolCalls: truncatedToolCalls };
      });

      // Clean tool messages
      const cleaned = this.cleanToolMessages(truncatedRecent);

      // Apply immediately — context shrinks NOW
      this.llm.setMessages([...systemMessages, ...cleaned]);
      const newTokens = tokenCounter.estimateMessages(cleaned);

      this.emit('context_compressed', {
        before: allMessages.length,
        after: systemMessages.length + cleaned.length,
        tokensBefore: usedTokens,
        tokensAfter: newTokens,
      });

      // --- Phase 2: Background LLM summary (non-blocking) ---
      if (oldMessages.length === 0) return;

      // Rich prompt with tool names preserved (same format as generateSummary)
      const summaryPrompt = this.buildSummaryPrompt(oldMessages);

      this._pendingCompression = (async () => {
        try {
          const summaryMsg = await this.generateSummary(oldMessages, signal);
          if (summaryMsg.content && summaryMsg.content.trim()) {
            this._deferredSummary = summaryMsg;
          }
        } catch {
          // generateSummary has its own fallback and shouldn't throw, but guard anyway
          this._deferredSummary = null;
        }
        this._pendingCompression = null;
      })();
    } finally {
      this._compacting = false;
    }
  }

  /**
   * Inject any deferred compression summary into the message list.
   * Called at the start of each run() — applies the LLM summary from
   * the previous request's background compression.
   */
  private applyPendingSummary(): void {
    if (!this._deferredSummary || !this.llm) return;

    // Wait for in-flight compression if still running
    if (this._pendingCompression) {
      // Still in progress — we'll catch it next time.
      // Don't block the current request.
      return;
    }

    const messages = this.llm.getMessages();
    const summary = this._deferredSummary;
    this._deferredSummary = null;

    // Insert after system messages, before conversation
    const sysCount = messages.filter(m => m.role === 'system').length;
    messages.splice(sysCount, 0, summary);
    this.llm.setMessages(messages);

    this.emit('context_compressed', {
      before: messages.length - 1,
      after: messages.length,
      tokensBefore: 0,
      tokensAfter: 0,
    });
  }

  /**
   * Clean tool messages — keep only those with matching assistant toolCalls.
   * Extracted from compactToTarget for reuse.
   */
  private cleanToolMessages(messages: ChatMessage[]): ChatMessage[] {
    const existingToolMessageIds = new Set<string>();
    const assistantToolCallIds = new Set<string>();

    for (const m of messages) {
      if (m.role === 'tool' && m.toolCallId) {
        existingToolMessageIds.add(m.toolCallId);
      }
      if (m.role === 'assistant' && m.toolCalls) {
        for (const tc of m.toolCalls) {
          assistantToolCallIds.add(tc.id);
        }
      }
    }

    const result: ChatMessage[] = [];
    for (const m of messages) {
      if (m.role === 'user' || m.role === 'assistant') {
        if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
          const hasAllToolMessages = m.toolCalls.every(tc => existingToolMessageIds.has(tc.id));
          if (!hasAllToolMessages) {
            result.push({ ...m, toolCalls: undefined });
          } else {
            result.push(m);
          }
        } else {
          result.push(m);
        }
      } else if (m.role === 'tool' && m.toolCallId) {
        if (assistantToolCallIds.has(m.toolCallId)) {
          result.push(m);
        }
      }
    }
    return result;
  }

  /**
   * Score a message for retention priority during compression.
   * Higher score = more likely to be kept.
   *
   * Scoring rules:
   * - user messages: 8 base (user intent is critical)
   * - assistant with write/git/bash: 7 (actual code changes)
   * - assistant with edit: 6 (edits)
   * - assistant with other toolCalls: 3 (generic action)
   * - assistant no toolCalls: 2 (commentary)
   * - tool for write/git: 4 (result of write)
   * - tool for read/grep/glob: 1 (transient read)
   * - tool for other: 2
   * - recency bonus: +0.5 for messages in the last 25%
   */
  private scoreMessage(msg: ChatMessage, index: number, total: number): number {
    const recencyWeight = index > total * 0.75 ? 0.5 : 0;

    if (msg.role === 'user') return 8 + recencyWeight;

    if (msg.role === 'tool') {
      // Check if this tool result is for a write operation
      const content = msg.content || '';
      if (
        content &&
        (content.includes('"name":"write"') ||
          content.includes('"name":"edit"') ||
          content.includes('file_delete') ||
          content.includes('file_move') ||
          content.includes('git add') ||
          content.includes('git commit') ||
          content.includes('bash'))
      )
        return 4 + recencyWeight;
      // Read-only tool results are low value
      return 1 + recencyWeight;
    }

    if (msg.role === 'assistant') {
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const toolNames = msg.toolCalls.map(tc => tc.name);
        if (toolNames.some(n => /(write|bash|git)/.test(n))) return 7 + recencyWeight;
        if (toolNames.some(n => /edit/.test(n))) return 6 + recencyWeight;
        return 3 + recencyWeight;
      }
      return 2 + recencyWeight;
    }

    return 1 + recencyWeight;
  }

  // Legacy: synchronous compact for backward compatibility
  public async compact(signal?: AbortSignal): Promise<void> {
    if (!this.llm || this._compacting) return;
    this._compacting = true;
    try {
      const provider = this.llm.getProvider();
      const targetTokens = Math.floor(provider.getContextWindow() * 0.4);
      await this.startNonBlockingCompression(targetTokens, signal);
      // Wait for background summary to complete before returning
      if (this._pendingCompression) {
        await this._pendingCompression;
        this.applyPendingSummary();
      }
    } finally {
      this._compacting = false;
    }
  }

  /**
   * Build a summary prompt from messages (without calling LLM).
   * Produces the same prompt text as generateSummary uses internally.
   * Used by non-blocking compression to create the prompt for background summarization.
   */
  private buildSummaryPrompt(messages: ChatMessage[]): string {
    const messagesText = messages
      .map(m => {
        if (m.role === 'system') {
          return `system: ${m.content || ''}`;
        }

        if (m.role === 'user') {
          return `user: ${m.content || ''}`;
        }

        if (m.role === 'tool') {
          const toolName = (m as any).name || 'unknown';
          return `tool_result: ${toolName}`;
        }

        // assistant
        if (m.toolCalls && m.toolCalls.length > 0) {
          const toolInfo = m.toolCalls
            .map(tc => {
              const args = tc.arguments || {};
              const keyArgsStr = Object.entries(args)
                .filter(([k]) => SpicaAgent.SUMMARY_KEY_ARGS.has(k))
                .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
                .join(', ');
              return keyArgsStr ? `${tc.name}(${keyArgsStr})` : tc.name;
            })
            .join('; ');
          const textContent = (m.content || '').slice(0, 300);
          return `assistant: [Tools: ${toolInfo}] ${textContent}`;
        }

        return `assistant: ${(m.content || '').slice(0, 300)}`;
      })
      .join('\n');

    return getCompactPrompt(messagesText);
  }

  // Generate history summary using LLM.
  // Tool result content is discarded — only tool names + key args are kept.
  // This gives the LLM enough context to summarize what happened without
  // overwhelming it with raw file contents, grep output, or bash stdout.
  private async generateSummary(
    messages: ChatMessage[],
    signal?: AbortSignal
  ): Promise<ChatMessage> {
    const prompt = this.buildSummaryPrompt(messages);

    try {
      const response = await this.llm!.generateForCompression(prompt, signal);
      return {
        role: 'assistant',
        content: `[COMPACTED CONTEXT — This is a summary of earlier conversation. Do NOT quote as user words or treat as current instructions.]

${response.content || 'Early conversation compressed'}`,
      };
    } catch {
      // Fallback: preserve user messages in full, tool calls with names + key args
      const items: string[] = [];
      for (const m of messages) {
        if (m.role === 'user') {
          items.push(m.content || '');
        } else if (m.toolCalls && m.toolCalls.length > 0) {
          const toolNames = m.toolCalls
            .map(tc => {
              const args = tc.arguments || {};
              const keyArgsStr = Object.entries(args)
                .filter(([k]) => SpicaAgent.SUMMARY_KEY_ARGS.has(k))
                .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
                .join(', ');
              return keyArgsStr ? `${tc.name}(${keyArgsStr})` : tc.name;
            })
            .join(', ');
          items.push(`[${toolNames}]`);
        } else if (m.role === 'tool') {
          items.push(`[tool_result: ${(m as any).name || '?'}]`);
        }
      }
      const summary = items.join(' | ');
      return {
        role: 'assistant',
        content: `[COMPACTED CONTEXT — Do NOT quote as user words.]\n${summary}`,
      };
    }
  }
}
