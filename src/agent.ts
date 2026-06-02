import { LLMClient } from './llm/LLMClient';
import { TokenCounter } from './llm/TokenCounter';
import { executeTool, getAllToolDefinitions, setWorkspace, getWorkspace } from './tools/index';
import { initMCP, shutdownMCP } from './mcp/client';
import { initSkills, listSkills, getSkill, buildSkillPrompt } from './skills/index';
import { getProviderConfig } from './utils/settings';
import { getSystemPrompt, getCompactPrompt } from './prompts/system';
import { loadProjectConfig as loadAgentsConfig, autoDetectProject, createAgentsMd } from './utils/projectConfig';
import { SkillDefinition } from './utils/settings';
import { cleanMessages } from './utils/messageCleaner';
import { loadProjectState, saveProjectState, updateProjectTodos, loadProjectContext, saveProjectContext, ensureProjectDir } from './storage/projectState';
import { runPreHooks, runPostHooks } from './hooks';
import { COLORS } from './cli/ui/colors';
// classifyIntent merged into matchSkill — see enhanced matchSkill() below
import { EventEmitter } from 'events';
import fs from 'fs-extra';
import * as path from 'path';
import os from 'os';
import simpleGit from 'simple-git';
import type { ChatMessage } from './llm/providers/BaseProvider';

export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface ProjectConfig {
  type?: string;
  framework?: string;
  language?: string;
  commands?: {
    build?: string;
    test?: string;
    dev?: string;
  };
  constraints?: string[];
}

export class SpicaAgent extends EventEmitter {
  private llm: LLMClient | null = null;

  getLLM(): LLMClient | null {
    return this.llm;
  }
  private interruptFlag = false;
  private workspacePath: string;
  private projectConfig: ProjectConfig = {};
  private _todos: Todo[] = [];
  private _initialized = false;
  private _initPromise: Promise<void> | null = null;
  private _providerName?: string;
  private _initAbortController: AbortController | null = null;
  private _cachedSkills: SkillDefinition[] = [];
  private _compacting = false;

  // 权限确认状态
  private permissionQueue: Array<{ reason: string; resolve: (approved: boolean) => void }> = [];
  private permissionPending = false;
  private permissionResolve: ((approved: boolean) => void) | null = null;
  private bypassPermissions = false;

  // 工具级 AbortController（用于中断单个工具）
  private toolAbortControllers: Map<string, AbortController> = new Map();

  // 待处理的新输入（用于在工具执行间隙插入新指令）
  private pendingInput: string | null = null;

  // 工具白名单（用于限制subagent工具访问）
  private toolWhitelist: string[] | null = null;

  constructor(providerName?: string, workspacePath?: string) {
    super();
    this._providerName = providerName;
    this.workspacePath = workspacePath || process.cwd();
  }

  get todos(): Todo[] {
    return this._todos;
  }

  interrupt() {
    this.interruptFlag = true;
    // 中断 init 中的连接检测
    if (this._initAbortController) {
      this._initAbortController.abort();
    }
    if (this.llm) {
      this.llm.interrupt();
    }
    // 中断所有正在执行的工具
    this.toolAbortControllers.forEach((controller, toolName) => {
      controller.abort();
      this.emit('tool_aborted', { tool: toolName });
    });
    this.toolAbortControllers.clear();
    // 拒绝所有待处理的权限请求
    this.permissionQueue.forEach(p => p.resolve(false));
    this.permissionQueue = [];
    this.permissionPending = false;
  }

  // 权限检查
  private checkNeedsPermission(toolName: string, args: Record<string, any>): string | null {
    const safeArgs = args || {};

    if (toolName === 'file_delete') {
      return `Delete: ${safeArgs.path || 'unknown'}`;
    }

    if (toolName === 'bash') {
      const cmd = String(safeArgs.command || '');

      // 更精确的危险命令检测
      const dangerousPatterns = [
        { pattern: 'rm -rf', name: '删除整个目录' },
        { pattern: 'rm /*', name: '删除根目录' },
        { pattern: 'rm -r /', name: '递归删除根目录' },
        { pattern: 'chmod 777', name: '开放所有权限' },
        { pattern: 'chmod -R 777', name: '递归开放所有权限' },
        { pattern: 'chown ', name: '修改文件所有者' },
        { pattern: 'sudo ', name: '使用sudo权限' },
        { pattern: 'dd if=', name: '磁盘操作' },
        { pattern: 'mkfs', name: '格式化磁盘' },
        { pattern: '> /dev/', name: '写入设备文件' },
        { pattern: 'mv /', name: '移动根目录文件' },
        { pattern: 'git push --force', name: '强制推送' },
        { pattern: 'git reset --hard', name: '硬重置（已保护）' },
        { pattern: 'git clean -fd', name: '删除未跟踪文件' },
        { pattern: ':(){ :|:& };:', name: 'Fork 炸弹' },
        { pattern: 'wget ', name: '远程下载（可能下载恶意脚本）' },
        { pattern: 'curl ', name: '远程请求（可能下载恶意脚本）' },
        { pattern: 'shutdown', name: '关机' },
        { pattern: 'reboot', name: '重启' },
        { pattern: 'init 0', name: '关机' },
        { pattern: 'mkswap', name: '格式化交换分区' },
        { pattern: 'fdisk', name: '磁盘分区操作' },
      ];

      for (const { pattern, name } of dangerousPatterns) {
        if (cmd.includes(pattern)) {
          return `${name}: ${cmd.slice(0, 60)}`;
        }
      }
    }
    
    // Git工具的危险操作（增强保护）
    if (toolName === 'git') {
      const action = safeArgs.action;
      const gitArgs = safeArgs.args || {};
      
      // clean操作 - 删除未跟踪文件
      if (action === 'clean') {
        return `删除所有未跟踪文件和目录，无法恢复！`;
      }
      
      // 用户确认的reset操作（AI已告知风险，用户明确确认）
      if (action === 'reset' && gitArgs.userConfirmed === true) {
        return `用户已确认reset ${gitArgs.mode || 'mixed'}操作`;
      }
      
      // 用户确认的checkout操作
      if (action === 'checkout' && gitArgs.userConfirmed === true) {
        return `用户已确认checkout操作，将切换到 ${gitArgs.branch}`;
      }
    }

    return null;
  }

  // 等待权限确认（串行处理）
  async waitForPermission(reason: string): Promise<boolean> {
    // 如果bypass模式开启，自动批准
    if (this.bypassPermissions) {
      this.auditLog('BYPASS_APPROVED', reason);
      this.emit('permission_bypassed', { reason });
      return true;
    }

    // 将请求加入队列
    const request = { reason, resolve: null as ((approved: boolean) => void) | null };
    const promise = new Promise<boolean>((resolve) => {
      request.resolve = resolve;
    });
    this.permissionQueue.push(request as any);

    // 如果当前没有正在处理的请求，开始处理队列
    if (!this.permissionPending) {
      this.processPermissionQueue();
    }

    return promise;
  }

  // 危险操作审计日志
  private auditLog(action: string, detail: string): void {
    try {
      const logDir = path.join(this.workspacePath, '.spica');
      fs.ensureDirSync(logDir);
      const logPath = path.join(logDir, 'audit.log');
      const timestamp = new Date().toISOString();
      const entry = `[${timestamp}] ${action}: ${detail}\n`;
      fs.appendFileSync(logPath, entry);
    } catch {
      // 审计日志失败不应阻塞正常操作
    }
  }

  // 处理权限队列
  private async processPermissionQueue(): Promise<void> {
    while (this.permissionQueue.length > 0 && !this.interruptFlag) {
      this.permissionPending = true;
      const request = this.permissionQueue.shift()!;

      // 发送事件给CLI
      this.emit('permission_request', { reason: request.reason });

      // 等待用户响应（通过 approvePermission/denyPermission）
      const approved = await new Promise<boolean>((resolve) => {
        this.permissionResolve = resolve;
      });

      // 处理结果
      if (request.resolve) {
        request.resolve(approved);
      }
      this.auditLog(approved ? 'USER_APPROVED' : 'USER_DENIED', request.reason);
      this.emit('permission_result', { approved });
    }
    this.permissionPending = false;
    this.permissionResolve = null;
  }

  // 用户批准（处理当前请求）
  approvePermission() {
    if (this.permissionResolve) {
      this.permissionResolve(true);
      this.permissionResolve = null;
    }
  }

  // 用户拒绝（处理当前请求）
  denyPermission() {
    if (this.permissionResolve) {
      this.permissionResolve(false);
      this.permissionResolve = null;
    }
  }

  get isPermissionPending(): boolean {
    return this.permissionPending;
  }

  // 中断单个工具（不中断整个 runLoop）
  abortTool(toolName: string): void {
    const controller = this.toolAbortControllers.get(toolName);
    if (controller) {
      controller.abort();
      this.toolAbortControllers.delete(toolName);
      this.emit('tool_aborted', { tool: toolName });
    }
  }

  // 注册工具 AbortController
  registerToolAbortController(toolName: string, controller: AbortController): void {
    this.toolAbortControllers.set(toolName, controller);
  }

  // 清除工具 AbortController
  clearToolAbortController(toolName: string): void {
    this.toolAbortControllers.delete(toolName);
  }

  // 设置待处理的新输入（用于在工具执行间隙插入新指令）
  setPendingInput(input: string | null): void {
    this.pendingInput = input;
  }

  // 获取待处理的新输入
  getPendingInput(): string | null {
    return this.pendingInput;
  }

  // 设置 Bypass 模式
  setBypassPermissions(enabled: boolean): void {
    this.bypassPermissions = enabled;
    this.emit('bypass_changed', { enabled });
  }

  get isBypassPermissions(): boolean {
    return this.bypassPermissions;
  }

  setToolWhitelist(allowedTools: string[]): void {
    this.toolWhitelist = allowedTools;
  }

  // 创建自动checkpoint（备份未提交工作）
  private async createAutoCheckpoint(prompt: string): Promise<string | null> {
    try {
      const git = simpleGit(this.workspacePath);
      const status = await git.status();
      
      // 只有未提交更改时才创建checkpoint
      if (status.files.length > 0) {
        const checkpointMsg = `[SPICA-CHECKPOINT] ${new Date().toISOString()} - ${prompt.slice(0, 50)}`;
        
        // 1. 添加所有更改
        await git.add('.');
        
        // 2. 创建checkpoint commit
        await git.commit(checkpointMsg);
        
        // 3. 获取hash
        const log = await git.log({ maxCount: 1 });
        const hash = log.latest?.hash || '';
        
        // 4. 通知用户
        this.emit('checkpoint_created', {
          hash: hash.substring(0, 7),
          message: checkpointMsg,
          filesBackedUp: status.files.length
        });
        
        // 5. 记录到checkpoint日志
        const checkpointLog = {
          timestamp: new Date().toISOString(),
          hash,
          message: checkpointMsg,
          promptPreview: prompt.slice(0, 100),
          filesBackedUp: status.files.map(f => f.path)
        };
        
        const logPath = path.join(this.workspacePath, '.spica', 'checkpoints.json');
        const logs = fs.existsSync(logPath) ? fs.readJsonSync(logPath) : [];
        logs.push(checkpointLog);
        fs.writeJsonSync(logPath, logs);
        
        return hash;
      }
      
      return null; // clean状态不需要checkpoint
    } catch (error) {
      // checkpoint失败不影响AI工作，只记录警告
      this.emit('checkpoint_warning', { error: 'Failed to create checkpoint' });
      return null;
    }
  }
  
  // 获取最近的checkpoint列表
  async getCheckpoints(): Promise<Array<{ hash: string; message: string; timestamp: string }>> {
    try {
      const logPath = path.join(this.workspacePath, '.spica', 'checkpoints.json');
      if (fs.existsSync(logPath)) {
        return fs.readJsonSync(logPath);
      }
      
      // 从git历史查找checkpoint commits
      const git = simpleGit(this.workspacePath);
      const log = await git.log({ maxCount: 50 });
      return log.all
        .filter(c => c.message.includes('[SPICA-CHECKPOINT]'))
        .map(c => ({
          hash: c.hash,
          message: c.message,
          timestamp: c.date
        }));
    } catch {
      return [];
    }
  }
  
  // 获取git状态（辅助方法）
  private async getGitStatus(): Promise<{ files: any[] }> {
    try {
      const git = simpleGit(this.workspacePath);
      const status = await git.status();
      return { files: status.files };
    } catch {
      return { files: [] };
    }
  }

// Unified skill classifier: merges old matchSkill + classifyIntent patterns.
// Returns the best-matching skill, or null if no skill applies.
private matchSkill(prompt: string): SkillDefinition | null {
    if (this._cachedSkills.length === 0) {
      this._cachedSkills = listSkills(this.workspacePath);
    }

    const p = prompt.toLowerCase().trim();
    if (!p) return null;

    // --- Negative patterns (pure info questions → no skill) ---
    // "what is X" / "how does X work" — pure information, no skill needed
    if (/^(what is|how does|who is|where is|when did)\b/.test(p)) return null;
    // "explain X" without creation/fix keywords → pure info
    const hasActionWord = /\b(create|add|build|make|implement|write|fix|debug|bug|error|broken|change|modify|update|remove|delete|refactor|design)\b/.test(p);
    if (/^explain\b/.test(p) && !hasActionWord) return null;

    // --- Composite brainstorming patterns ---
    if ((p.includes('how to make') && p.includes('better')) ||
        (p.includes('how to improve')) ||
        p.includes('could we') ||
        p.includes('should we') ||
        p.includes('what would you change')) {
      return this._cachedSkills.find(s => s.name === 'brainstorming') || null;
    }

    // --- Keyword map (ordered: more specific first) ---
    const keywordMap = new Map([
      ['brainstorming', ['create', 'build', 'implement', 'add', 'refactor', 'design', 'new feature', 'remove', 'delete', 'change', 'modify', 'update']],
      ['systematic-debugging', ['fix', 'bug', 'error', 'failure', 'not working', 'crash', 'test fail', 'broken', 'debug']],
      ['test-driven-development', ['write test', 'add test', 'implement feature', 'need test']],
      ['writing-plans', ['multi-step', 'plan', 'spec', 'requirements', 'before coding', 'strategy']],
      ['verification-before-completion', ['complete', 'done', 'finished', 'verify', 'before commit']],
      ['requesting-code-review', ['review', 'merge', 'pr', 'check code', 'look over']],
      ['receiving-code-review', ['feedback', 'review comment', 'suggestion', 'change requested']],
      ['using-superpowers', ['skill', 'capability', 'ability', 'what can you', 'help']],
      ['using-git-worktrees', ['worktree', 'isolate', 'branch']],
      ['executing-plans', ['execute plan', 'implement plan']],
      ['subagent-driven-development', ['subagent', 'parallel']],
      ['finishing-a-development-branch', ['finish', 'merge branch', 'pr']],
      ['dispatching-parallel-agents', ['parallel', 'dispatch', 'simultaneously']],
      ['writing-skills', ['write skill', 'create skill', 'new skill']],
    ]);

    // Composite Tier 2: creation verb + target noun → brainstorming
    const creationVerbs = ['create', 'add', 'build', 'make', 'implement', 'write'];
    const targetNouns = ['feature', 'component', 'module', 'system', 'function', 'class', 'file', 'something', 'thing'];
    const hasCreationVerb = creationVerbs.some(v => p.includes(v));
    const hasTargetNoun = targetNouns.some(n => p.includes(n));
    if (hasCreationVerb && hasTargetNoun) {
      const brainstorming = this._cachedSkills.find(s => s.name === 'brainstorming');
      if (brainstorming) return brainstorming;
    }
    
    for (const skill of this._cachedSkills) {
      if (!skill.name) continue;
      const skillKeywords = keywordMap.get(skill.name) || [];
      if (skillKeywords.some(kw => p.includes(kw))) {
        return skill;
      }
      
      if (skill.description && p.includes(skill.description.toLowerCase().slice(0, 20))) {
        return skill;
      }
    }

    return null;
  }

// 判断错误是否可重试
  private isRetryableError(error: any): boolean {
    const message = error.message || '';
    const code = String(error.code || error.status || '');

    // 不可重试的错误
    const nonRetryablePatterns = [
      '400',  // 请求格式错误（如不支持的消息角色）
      '401',  // 认证失败
      '403',  // 权限不足
      '404',  // 资源不存在
      'invalid', 'unauthorized', 'permission',
    ];

    for (const pattern of nonRetryablePatterns) {
      if (message.includes(pattern) || code === pattern) {
        return false;
      }
    }

    // 可重试的错误：网络问题、超时、速率限制、服务器错误
    const retryablePatterns = [
      'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET',
      '429', '500', '502', '503',
      'timeout', 'network', 'connection', 'rate limit',
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
  private isCriticalToolError(toolName: string, result: { success: boolean; error?: string; output?: string }): boolean {
    if (result.success) return false;

    const error = result.error || '';

    // 关键错误类型：应该停止生成并让用户处理
    const criticalPatterns = [
      '401', 'Unauthorized', 'invalid API key', 'authentication',
      '403', 'Forbidden', 'permission denied',
      'ECONNREFUSED', 'ENOTFOUND', 'network error', 'no network',
      'aborted by user',
      'API connection failed',
    ];

    for (const pattern of criticalPatterns) {
      if (error.toLowerCase().includes(pattern.toLowerCase())) {
        return true;
      }
    }

    // Web工具的特殊处理：如果代理/网络失败，继续尝试其他方案
    if (toolName === 'web_search' || toolName === 'web_fetch') {
      // 网络问题不应该停止整个任务，让agent尝试其他方案
      return false;
    }

    return false;
  }

  // 带重试的 LLM 调用（参考 Claude Code 等 coding agent 的重试策略）
  private async callLLMWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
    maxRetries: number = 10
  ): Promise<T> {
    let lastError: any;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (this.interruptFlag) {
        throw new Error('Interrupted by user');
      }

      try {
        return await operation();
      } catch (error: any) {
        lastError = error;

        // 最后一次尝试不再重试
        if (attempt === maxRetries) {
          break;
        }

        if (this.interruptFlag) {
          break;
        }

        // 检查是否可重试（认证等错误直接抛出）
        if (!this.isRetryableError(error)) {
          this.emit('error_suggestion', {
            tool: operationName,
            error: error.message,
            suggestion: `错误不可重试，需要用户处理: ${error.message}`
          });
          throw error;
        }

        if (this.interruptFlag) {
          break;
        }

        // 指数退避：1s, 2s, 4s, 8s, 16s, 32s, 60s...（最大60秒）
        const delay = Math.min(1000 * Math.pow(2, attempt), 60000);
        this.emit('retry_attempt', {
          operation: operationName,
          attempt: attempt + 1,
          maxRetries,
          delay,
          error: error.message,
        });

        const start = Date.now();
        while (Date.now() - start < delay) {
          if (this.interruptFlag) {
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (this.interruptFlag) {
          break;
        }
      }
    }

    throw lastError;
  }

async init() {
    if (this._initialized) return;
    if (this._initPromise) return this._initPromise;
    
    this._initPromise = this._doInit();
    await this._initPromise;
    this._initialized = true;
    this._initPromise = null;
  }
  
  private async _doInit(): Promise<void> {
    this._initAbortController = new AbortController();

    // 初始化Skills（首次运行时复制默认包）
    await initSkills();

    // 初始化MCP服务器连接
    try {
      await initMCP();
    } catch (error) {
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

    // 检查API连接（支持中断）
    const connectionResult = await this.llm.checkConnection(this._initAbortController.signal);
    this._initAbortController = null;

    if (!connectionResult.success) {
      this.emit('connection_error', {
        type: connectionResult.type,
        error: connectionResult.error,
        hint: connectionResult.hint,
        provider: this._providerName,
        model: config.model,
      });
      throw new Error(`API connection failed: ${connectionResult.type}\n${connectionResult.hint}\nDetails: ${connectionResult.error}`);
    }

    ensureProjectDir(this.workspacePath);
    const projectContext = loadProjectContext(this.workspacePath);
    if (projectContext.length > 0) {
      this.llm.setMessages(projectContext);
    }
    
    const projectState = loadProjectState(this.workspacePath);
    if (projectState) {
      this._todos = projectState.todos;
    }
    
    await this.loadProjectConfig();
    
    // Build skills metadata for system prompt
    const skills = listSkills(this.workspacePath);
    const skillsMetadata = skills.map(s => `- ${s.name}: ${s.description}`).join('\n');
    
    const superpowersSkill = skills.find(s => s.name === 'using-superpowers');
    const superpowersContent = superpowersSkill?.promptTemplate || '';
    
    this.llm.setSystemPrompt(getSystemPrompt(this.projectConfig, skillsMetadata, superpowersContent, this.workspacePath));
    
    this.llm.on('chunk', (chunk: string) => {
      this.emit('stream', { chunk });
    });
    
    this.llm.on('reasoning', (content: string) => {
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
    return this.llm?.getMessages() || [];
  }

  setMessages(messages: ChatMessage[]) {
    if (this.llm) {
      const cleanedMessages = this.cleanMessagesForLLM(messages);
      this.llm.setMessages(cleanedMessages);
    }
  }

  private cleanMessagesForLLM(messages: ChatMessage[]): ChatMessage[] {
    return cleanMessages(messages);
  }

  async runLoop(prompt: string, maxIterations = 50): Promise<string> {
    this.interruptFlag = false;
    if (!this.llm) {
      await this.init();
    }

    if (!this.llm) {
      throw new Error('LLM client not initialized');
    }

    const matchedSkill = this.matchSkill(prompt);
    if (matchedSkill) {
      const skillContent = buildSkillPrompt(matchedSkill, { input: prompt });
      this.emit('skill_auto_triggered', { skill: matchedSkill.name, description: matchedSkill.description });
      prompt = skillContent;
    }

    // Inject REQUIRED_SKILL to force agent to call the matched skill tool
    if (matchedSkill) {
      this.llm.addMessage({ role: 'system' as const, content: `REQUIRED_SKILL: ${matchedSkill.name}` });
    }

    // 🔒 自动checkpoint：在AI工作前创建备份点
    const checkpointHash = await this.createAutoCheckpoint(prompt);
    
    // Pre-request: 基于token数判断是否需要压缩
    const existingMessages = this.llm.getMessages();
    const tokenCounter = new TokenCounter();

    // 从provider获取上下文窗口大小
    const provider = this.llm.getProvider();
    const contextWindow = provider.getContextWindow();
    tokenCounter.setContextWindow(contextWindow);

    const usedTokens = tokenCounter.estimateMessages(existingMessages);
    const usagePercent = Math.floor(usedTokens / contextWindow * 100);
    
    // 多级预警机制（上下文管理优化）
    if (usagePercent >= 50 && usagePercent < 60) {
      this.emit('context_warning', {
        level: 'info',
        usage: usagePercent,
        message: `Context at ${usagePercent}% - consider using subagent for complex tasks`,
        suggestion: 'Use task tool to dispatch subagent and avoid dumbzone'
      });
    } else if (usagePercent >= 60 && usagePercent < 70) {
      this.emit('context_warning', {
        level: 'warning',
        usage: usagePercent,
        message: `Context at ${usagePercent}% - strongly recommend subagent`,
        suggestion: 'Dispatch independent tasks to subagents immediately'
      });
    }

    const triggerThreshold = Math.floor(contextWindow * 0.7);  // 触发阈值：70%（现代设计，更早触发避免过满）

    // 当使用超过触发阈值时自动压缩
    if (usedTokens > triggerThreshold) {
      this.emit('context_compressed', {
        before: existingMessages.length,
        after: 0,
        tokensBefore: usedTokens,
        tokensAfter: 0,
        message: `Context too large (${usagePercent}%), compressing...`
      });
      await this.compact();
    }

    // Simplified project context (减少token)
    const projectContext = this.projectConfig.type
      ? `Project: ${this.projectConfig.type}, Build: ${this.projectConfig.commands?.build || 'N/A'}, Test: ${this.projectConfig.commands?.test || 'N/A'}`
      : '';

    this.emit('message', { role: 'user', content: prompt });

    const toolDefinitions = getAllToolDefinitions();
    this.emit('waiting_for_llm');  // 通知外部启动心跳

    let response;
    try {
      response = await this.callLLMWithRetry(
        () => this.llm!.generate(prompt + (projectContext ? `\n${projectContext}` : ''), toolDefinitions),
        'llm_generate'
      );
    } catch (llmError: any) {
      this.emit('error_suggestion', {
        tool: 'llm_generate',
        error: llmError.message,
        suggestion: 'Network or API temporary error. Check network connection and retry later.'
      });
      return `LLM request failed (retried 10 times): ${llmError.message}. Check API config and network.`;
    }

    // 防御性检查：确保 response 存在
    if (!response) {
      this.emit('error_suggestion', {
        tool: 'llm_generate',
        error: 'LLM returned undefined',
        suggestion: 'LLM returned exception, please retry'
      });
      return 'LLM returned exception, please retry';
    }

    let iterations = 0;

    const allToolResults: Array<{ name: string; id: string; result: string }> = [];
    let criticalErrorDetected: { tool: string; error: string; suggestion: string } | null = null;

    while (!response.finished && iterations < maxIterations && !this.interruptFlag) {
      iterations++;

      if (this.interruptFlag) {
        break;
      }

      // 检查response状态
      if (!response.toolCalls || response.toolCalls.length === 0) {
        if (response.content) {
          break;
        }
        break;
      }

      if (response.toolCalls && response.toolCalls.length > 0) {
        const toolResults = await Promise.all(response.toolCalls.map(async (tc) => {
          if (this.interruptFlag) return { name: tc.name, id: tc.id, result: 'interrupted' };

          const tcArgs = tc.arguments || {};  // 确保 arguments 存在

          // Hooks检查（优先于权限检查）
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

            if (hookResult.action === 'confirm') {
              const approved = await this.waitForPermission(hookResult.message);
              if (!approved) {
                this.emit('tool_result', {
                  name: tc.name,
                  success: false,
                  error: 'Permission denied by user',
                });
                return { name: tc.name, id: tc.id, result: 'Permission denied by user' };
              }
            }

            if (hookResult.action === 'warn') {
              this.emit('hook_warning', { tool: tc.name, message: hookResult.message });
            }
          }

          // 权限检查（原有逻辑）
          const permissionReason = this.checkNeedsPermission(tc.name, tcArgs);
          if (permissionReason) {
            const approved = await this.waitForPermission(permissionReason);
            if (!approved) {
              this.emit('tool_result', {
                name: tc.name,
                success: false,
                error: 'Permission denied by user',
              });
              return { name: tc.name, id: tc.id, result: 'Permission denied by user' };
            }
          }

          // 工具白名单检查（subagent权限控制）
          if (this.toolWhitelist && !this.toolWhitelist.includes(tc.name)) {
            this.emit('tool_result', {
              name: tc.name,
              success: false,
              error: `Tool ${tc.name} not allowed for this subagent`,
            });
            return { name: tc.name, id: tc.id, result: `Tool ${tc.name} blocked by whitelist` };
          }

          this.emit('tool_call', { name: tc.name, arguments: tcArgs });

          // 同步 workspace 到 tools 模块
          setWorkspace(this.workspacePath);

          // 创建工具级 AbortController（用于中断单个工具）
          const toolAbortController = new AbortController();
          this.registerToolAbortController(tc.name, toolAbortController);

          // 传递 AbortSignal 给工具
          tcArgs._abortSignal = toolAbortController.signal;

          // 事件回调 - 用于转发子agent事件和处理卡住警告
          const eventCallback = (event: string, data: any) => {
            this.emit(event, data);

            // 处理工具卡住警告：自动中断并尝试其他方案
            if (event === 'tool_stuck_warning') {
              // 自动中断卡住的工具（30秒后仍未完成）
              this.abortTool(tc.name);
              // 设置中断标志，让 agent 退出循环
              this.interruptFlag = true;
            }
          };

          try {
            const result = await executeTool(tc.name, tcArgs, eventCallback);

            // 清除 AbortController
            this.clearToolAbortController(tc.name);

            if (!result.success) {
              // 检查是否是被中断的
              if (result.error?.includes('aborted') || result.error?.includes('interrupted')) {
                this.emit('tool_result', {
                  name: tc.name,
                  success: false,
                  error: `Tool execution aborted (stuck or interrupted). Try: detached=true, shorter timeout, or interactive mode.`,
                });
                return { name: tc.name, id: tc.id, result: `Tool interrupted, need to try other approaches`, isCritical: true };
              }

              // 检查是否是关键错误（应该停止整个生成）
              if (this.isCriticalToolError(tc.name, result)) {
                const suggestion = this.generateErrorSuggestion(tc.name, result.error || '', tcArgs);
                criticalErrorDetected = { tool: tc.name, error: result.error || 'Unknown error', suggestion };
                this.emit('tool_result', {
                  name: tc.name,
                  success: false,
                  error: result.error,
                });
                return { name: tc.name, id: tc.id, result: `Critical error: ${result.error}`, isCritical: true };
              }

              this.emit('error_suggestion', {
                toolName: tc.name,
                error: result.error || 'Unknown error',
                suggestion: this.generateErrorSuggestion(tc.name, result.error || '', tcArgs),
              });
            }

            // 文件编辑成功时发送diff预览
            if (result.success && (tc.name === 'file_write' || tc.name === 'file_edit' || tc.name === 'file_multi_edit') && result.diff) {
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
            });

            // PostToolUse hooks
            const postHookMessage = runPostHooks(tc.name, tcArgs, result);
            if (postHookMessage) {
              this.emit('hook_log', { tool: tc.name, message: postHookMessage });
            }

            // workspace切换处理
            if (tc.name === 'workspace' && result.success && tcArgs.path) {
              await this.switchWorkspace(tcArgs.path);
            }

            return { 
              name: tc.name, 
              id: tc.id, 
              result: result.content || result.output || result.error || '',
              referencedSkills: tc.name === 'skill' && result.success ? result.referencedSkills : undefined
            };
          } catch (toolError: any) {
            // 清除 AbortController
            this.clearToolAbortController(tc.name);

            this.emit('tool_result', {
              name: tc.name,
              success: false,
              error: toolError.message,
            });
            return { name: tc.name, id: tc.id, result: `工具执行错误: ${toolError.message}` };
          }
        }));

        allToolResults.push(...toolResults);

        // 中断检查：如果被中断，立即停止整个生成循环
        if (this.interruptFlag) {
          this.emit('agent_interrupted', {
            toolResults: toolResults.map(t => ({ name: t.name, result: t.result.slice(0, 100) })),
          });
          return '[INTERRUPTED] Agent execution stopped by user (ESC ESC). You can retry or continue with a new request.';
        }

        // 关键错误检查：如果检测到关键错误，停止生成并报告
        const criticalError = criticalErrorDetected as { tool: string; error: string; suggestion: string } | null;
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
        
        const postToolMessages = referencedSkills.map(refName => ({
          role: 'system' as const,
          content: `REQUIRED_SKILL: ${refName}`
        }));

        // 所有工具完成后，一次性发送所有结果给LLM继续生成
        if (toolResults.length > 0) {
          this.emit('waiting_for_llm');  // 通知外部启动心跳
          try {
            response = await this.callLLMWithRetry(
              () => this.llm!.continueWithAllToolResults(
                toolResults.map(t => ({ name: t.name, result: t.result, id: t.id })),
                toolDefinitions,
                postToolMessages  // 在 tool 消息之后添加
              ),
              'llm_continue'
            );
          } catch (llmError: any) {
            const isRetryable = this.isRetryableError(llmError);
            const suggestionText = isRetryable
              ? 'Network or API temporary error (retried 10 times), tool results saved. Try continuing conversation or resend request.'
              : `Error not retryable, user needs to handle: ${llmError.message}`;
            
            this.emit('error_suggestion', {
              tool: 'llm_continue',
              error: llmError.message,
              suggestion: suggestionText
            });
            
            if (this.llm) {
              const allMessages = this.llm.getMessages();
              const cleanedMessages = allMessages.map(m => {
                if (m.role === 'assistant' && m.toolCalls) {
                  return { role: 'assistant', content: m.content || '' };
                }
                if (m.role === 'tool') {
                  return null;
                }
                return m;
              }).filter(m => m !== null) as ChatMessage[];
              this.llm.setMessages(cleanedMessages);
            }
            
            const resultsSummary = toolResults.map(t => `${t.name}: ${t.result.slice(0, 100)}`).join('\n');
            const errorTypeText = isRetryable ? '网络或API临时错误' : 'API错误（请求格式问题）';
            return `Tool execution completed but LLM response interrupted.\nError type: ${errorTypeText}\nError: ${llmError.message}\nExecuted operations:\n${resultsSummary}\nSuggestion: ${isRetryable ? 'Continue conversation, previous results retained.' : 'Fix issue and restart session. Message history cleaned.'}`;
          }
        }
      } else {
        break;
      }
    }

    const assistantContent = response.content ||
      this.llm?.getMessages().filter(m => m.role === 'assistant').pop()?.content || '';

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

    // 发送workspace变更事件
    this.emit('workspace_changed', { path: newPath });

    // 重新初始化（检测新项目）
    await this.init();
  }

  private generateErrorSuggestion(toolName: string, error: string, args: any): string {
    const suggestions: Record<string, (e: string, a: any) => string> = {
      file_read: (e, a) =>
        e.includes('ENOENT') ? `File not found: ${a.path}. Check path or use glob.`
        : e.includes('EACCES') ? `Permission denied: ${a.path}. Check file permissions.`
        : `Read failed. Check path.`,
      file_write: (e, a) =>
        e.includes('EACCES') ? `Permission denied: ${a.path}. Check file permissions.`
        : e.includes('ENOENT') ? `Directory not found: ${a.path}. Create directory first.`
        : `Write failed. Check path and content.`,
      bash: (e, a) =>
        e.includes('command not found') ? `Command not found: ${a.command}. Install required tool.`
        : e.includes('Permission denied') ? `Permission denied: ${a.command}. Check permissions or use sudo.`
        : `Execution failed. Check command syntax.`,
      glob: (e, a) => `Search failed. Check pattern: ${a.pattern}`,
      grep: (e, a) => `Search failed. Check pattern and path.`,
    };

    const baseSuggestion = suggestions[toolName]?.(error, args) || `Tool ${toolName} failed. Check parameters.`;

    return baseSuggestion;
  }

  // 公开方法：手动压缩历史（使用 LLM 生成摘要）
  public async compact(): Promise<void> {
    if (!this.llm || this._compacting) return;
    this._compacting = true;
    try {
      const provider = this.llm.getProvider();
      const targetTokens = Math.floor(provider.getContextWindow() * 0.3);
      await this.compactToTarget(targetTokens);
    } finally {
      this._compacting = false;
    }
  }

  // 压缩到指定目标tokens以下
  private async compactToTarget(targetTokens: number): Promise<void> {
    if (!this.llm) return;
    const allMessages = this.llm.getMessages();
    const tokenCounter = new TokenCounter();
    const provider = this.llm.getProvider();
    tokenCounter.setContextWindow(provider.getContextWindow());
    const contextWindow = provider.getContextWindow();

    const usedTokens = tokenCounter.estimateMessages(allMessages);

    // 如果 tokens 已经低于目标，不需要压缩
    if (usedTokens < targetTokens) {
      this.emit('context_compressed', { before: allMessages.length, after: allMessages.length, tokensBefore: usedTokens, tokensAfter: usedTokens });
      return;
    }

    // 根据超量程度决定保留消息数量
    const ratio = usedTokens / targetTokens;
    let keepCount = ratio > 2 ? 5 : ratio > 1.5 ? 8 : 12;
    // 确保最小保留 5 条，最大保留不超过 15 条，且不超过总数的 25%
    // 测试证明 min=3 max=8 过于激进，会丢失太多上下文
    // Adaptive floor: small windows keep fewer, large windows keep more
    const minKeep = Math.max(3, Math.min(8, Math.ceil(contextWindow / 50000)));
    keepCount = Math.max(minKeep, Math.min(keepCount, Math.max(minKeep + 2, 15), Math.floor(allMessages.length * 0.25)));

    const recentMessages = allMessages.slice(-keepCount);
    const oldMessages = allMessages.slice(0, -keepCount);

    // Adaptive truncation: 1% of context window, floor 500 chars
    const maxContentLength = Math.max(500, Math.floor(contextWindow * 0.01));

    // 对 recentMessages 中的超长内容进行截断
    const truncatedRecent = recentMessages.map(m => {
      // 截断 content（adaptive to context window）
      const truncatedContent = (m.content || '').length > maxContentLength
        ? (m.content || '').slice(0, maxContentLength) + '...[truncated]'
        : m.content;

      // 截断 toolCalls（adaptive to context window）
      const maxToolCalls = Math.max(3, Math.min(10, Math.floor(contextWindow / 25000)));
      let truncatedToolCalls = m.toolCalls;
      if (m.toolCalls && m.toolCalls.length > maxToolCalls) {
        truncatedToolCalls = m.toolCalls.slice(0, maxToolCalls);
        // 标记被截断
        truncatedToolCalls.push({
          id: 'truncated',
          name: '...[truncated]',
          arguments: {}
        });
      }

      return {
        ...m,
        content: truncatedContent,
        toolCalls: truncatedToolCalls,
      };
    });

    // 用 LLM 生成摘要（如果还有旧消息）
    // Safety: if kept messages alone exceed 70% of target, reduce until they fit
    const safetyTruncated = [...truncatedRecent];
    let safetyTokens = tokenCounter.estimateMessages(safetyTruncated);
    while (safetyTokens > targetTokens * 0.7 && safetyTruncated.length > 2) {
      safetyTruncated.shift();
      safetyTokens = tokenCounter.estimateMessages(safetyTruncated);
    }
    // Recompute oldMessages to match possibly reduced recent set
    const finalOldMessages = allMessages.slice(0, allMessages.length - safetyTruncated.length);

    if (finalOldMessages.length > 0) {
      const summary = await this.generateSummary(finalOldMessages);
      // Filter tool messages before setting
      const safetyTruncatedClean = safetyTruncated.filter(m => 
        m.role === 'user' || m.role === 'assistant' || m.role === 'system'
      );
      const compressed = [summary, ...safetyTruncatedClean];
      this.llm.setMessages(compressed);

      // 检查压缩后的 tokens，如果仍然超限，继续压缩
      const newTokens = tokenCounter.estimateMessages(compressed);
      if (newTokens > targetTokens && compressed.length > 3) {
        // 再次压缩，只保留最近 2 条 + 摘要
        const finalMessages = compressed.slice(-2);
        const secondSummary = await this.generateSummary(compressed.slice(0, -2));
        this.llm.setMessages([secondSummary, ...finalMessages]);
      }
    } else {
      // 没有旧消息，只截断（也要过滤）
      const safetyTruncatedClean = safetyTruncated.filter(m => 
        m.role === 'user' || m.role === 'assistant' || m.role === 'system'
      );
      this.llm.setMessages(safetyTruncatedClean);
    }

    this.emit('context_compressed', {
      before: allMessages.length,
      after: this.llm.getMessages().length,
      tokensBefore: usedTokens,
      tokensAfter: tokenCounter.estimateMessages(this.llm.getMessages()),
    });
  }

  // Generate history summary using LLM
  private async generateSummary(messages: ChatMessage[]): Promise<ChatMessage> {
    // Filter out tool messages before compression
    const filteredMessages = messages.filter(m => 
      m.role === 'user' || m.role === 'assistant' || m.role === 'system'
    );
    
    // Build messages text (smart truncation)
    const messagesText = filteredMessages.map(m => {
      const role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'AI' : 'System';
      let content = m.content || '';
      
      // Preserve tool call info
      if (m.toolCalls && m.toolCalls.length > 0) {
        const toolInfo = m.toolCalls.map(tc => {
          // Preserve key args (path, command, etc.)
          const args = tc.arguments || {};
          const keyArgs = args.path || args.command || args.files || '';
          return `${tc.name}${keyArgs ? `(${keyArgs})` : ''}`;
        }).join(', ');
        content = `[Tools: ${toolInfo}] ${content.slice(0, 50)}`;
      }
      
      // Smart truncation: preserve start and end
      if (content.length > 150) {
        return `${role}: ${content.slice(0, 80)}...${content.slice(-40)}`;
      }
      return `${role}: ${content}`;
    }).join('\n');

    const prompt = getCompactPrompt(messagesText);

    try {
      const response = await this.llm!.generateDirect(prompt);
      return {
        role: 'assistant',
        content: `[History Summary] ${response.content || 'Early conversation compressed'}`,
      };
    } catch {
      // Fallback: preserve user questions AND tool call names in order
      const items: string[] = [];
      for (const m of messages) {
        if (m.role === 'user') {
          items.push((m.content || '').slice(0, 60));
        } else if (m.toolCalls && m.toolCalls.length > 0) {
          const toolNames = m.toolCalls.map(tc => tc.name).join(', ');
          items.push(`[${toolNames}]`);
        }
      }
      const summary = items.slice(0, 10).join(' | ');
      return {
        role: 'assistant',
        content: `[History Summary] Task chain: ${summary}`,
      };
    }
  }

  // 旧的简单压缩方法（备用）
  }