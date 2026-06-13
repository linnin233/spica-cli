import { EventEmitter } from 'events';
import { OpenAICompatibleProvider } from './providers/OpenAICompatible';
import { TokenCounter } from './TokenCounter';
import { RateLimiter } from './RateLimiter';
import type { ToolDefinition, LLMResponse, ChatMessage } from './providers/BaseProvider';

export interface LLMClientConfig {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  name?: string;
  rateLimit?: { requestsPerMinute?: number; tokensPerMinute?: number };
}

/**
 * LLMClient - LLM API client with streaming and rate limiting
 *
 * Features:
 * - OpenAI-compatible API support
 * - Streaming response handling
 * - Rate limiting (requests/tokens per minute)
 * - Token counting and context management
 * - Interrupt support
 *
 * @extends EventEmitter
 * @example
 * ```ts
 * const client = new LLMClient(config);
 * const response = await client.generate('Hello');
 * ```
 */
export class LLMClient extends EventEmitter {
  private provider: OpenAICompatibleProvider;
  private tokenCounter: TokenCounter;
  private rateLimiter: RateLimiter;
  private tools: ToolDefinition[] = [];
  private abortController: AbortController | null = null;
  private pendingInterrupt = false; // 中断标记（用于rate limiter等待期间）

  constructor(config: LLMClientConfig) {
    super();
    this.provider = new OpenAICompatibleProvider({
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl || 'https://api.openai.com/v1',
      name: config.name || config.provider,
    });

    this.provider.on('chunk', (chunk: string) => {
      this.emit('chunk', chunk);
    });

    this.provider.on('reasoning', (content: string) => {
      this.emit('reasoning', content);
    });

    this.tokenCounter = new TokenCounter(config.model);
    this.rateLimiter = new RateLimiter(config.rateLimit || {});
  }

  // 检查API连接（支持中断）
  async checkConnection(
    signal?: AbortSignal
  ): Promise<{ success: boolean; type?: string; error?: string; hint?: string }> {
    return this.provider.checkConnection(signal);
  }

  setSystemPrompt(prompt: string): void {
    this.provider.setSystemPrompt(prompt);
  }

  setSystemPromptSplit(stable: string, variable?: string): void {
    this.provider.setSystemPromptSplit(stable, variable);
  }

  setToolDefinitions(tools: ToolDefinition[]): void {
    this.tools = tools;
  }

  async generate(
    prompt: string,
    tools?: ToolDefinition[],
    externalSignal?: AbortSignal
  ): Promise<LLMResponse> {
    // Abort previous controller and create a new one.
    // Capture in a local variable — `finally` blocks from concurrent calls
    // can overwrite `this.abortController` across await points.
    if (this.abortController) {
      this.abortController.abort();
    }
    const controller = new AbortController();
    this.abortController = controller;

    // Link external signal (from agent's currentAbortController)
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        const onAbort = () => {
          externalSignal.removeEventListener('abort', onAbort);
          controller.abort();
        };
        externalSignal.addEventListener('abort', onAbort);
      }
    }

    const toolsToUse = tools || this.tools;

    try {
      // 等待rate limiter（可被中断）
      await this.rateLimiter.waitForAvailability(controller.signal);

      if (controller.signal.aborted) {
        throw new Error('Interrupted during rate limit wait');
      }

      this.rateLimiter.recordRequest();
      const response = await this.provider.generate(prompt, toolsToUse, controller.signal);

      if (response.content) {
        const tokens = this.tokenCounter.estimateTokens(response.content);
        this.rateLimiter.recordTokenUsage(tokens);
      }

      return response;
    } finally {
      // Only clear if no new controller was created by a concurrent call
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  interrupt() {
    this.rateLimiter.interrupt(); // 中断rate limiter等待
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  // 直接生成（不使用历史消息，用于摘要等）
  async generateDirect(prompt: string, externalSignal?: AbortSignal): Promise<LLMResponse> {
    // Abort previous controller and create a new one.
    // Capture in a local variable — `finally` blocks from concurrent calls
    // can overwrite `this.abortController` across await points.
    if (this.abortController) {
      this.abortController.abort();
    }
    const controller = new AbortController();
    this.abortController = controller;

    // 链接外部 signal（来自 agent 的 AbortController，支持中断传播）
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        const onAbort = () => {
          externalSignal.removeEventListener('abort', onAbort);
          controller.abort();
        };
        externalSignal.addEventListener('abort', onAbort);
      }
    }

    try {
      await this.rateLimiter.waitForAvailability(controller.signal);

      if (controller.signal.aborted) {
        throw new Error('Interrupted during rate limit wait');
      }

      this.rateLimiter.recordRequest();
      // 使用 provider 的 generateDirect 方法（不添加到历史）
      const response = await this.provider.generateDirect(prompt, controller.signal);

      if (response.content) {
        const tokens = this.tokenCounter.estimateTokens(response.content);
        this.rateLimiter.recordTokenUsage(tokens);
      }

      return response;
    } finally {
      // Only clear if no new controller was created by a concurrent call
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  /**
   * Generate a summary for context compression.
   * Independent of the main request — does NOT touch this.abortController,
   * so it can run concurrently with a streaming generate() call.
   * Still respects rate limiter and interrupt signals.
   */
  async generateForCompression(prompt: string, externalSignal?: AbortSignal): Promise<LLMResponse> {
    const controller = new AbortController();

    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        const onAbort = () => {
          externalSignal.removeEventListener('abort', onAbort);
          controller.abort();
        };
        externalSignal.addEventListener('abort', onAbort);
      }
    }

    await this.rateLimiter.waitForAvailability(controller.signal);

    if (controller.signal.aborted) {
      return { content: '', finished: true };
    }

    this.rateLimiter.recordRequest();
    const response = await this.provider.generateDirect(prompt, controller.signal);

    if (response.content) {
      const tokens = this.tokenCounter.estimateTokens(response.content);
      this.rateLimiter.recordTokenUsage(tokens);
    }

    return response;
  }

  async continueWithAllToolResults(
    toolResults: Array<{ name: string; result: string; id?: string; noTruncate?: boolean }>,
    tools?: ToolDefinition[],
    postToolMessages?: ChatMessage[],
    externalSignal?: AbortSignal
  ): Promise<LLMResponse> {
    const toolsToUse = tools || this.tools;
    const lastMessage = this.provider.getMessages()[this.provider.getMessages().length - 1];

    // 1. 先添加所有 tool 结果消息（确保紧跟在 assistant tool_calls 后）
    for (const { name, result, id, noTruncate } of toolResults) {
      const toolCallId = id || lastMessage.toolCalls?.find(tc => tc.name === name)?.id || '';
      // Skill tools must not be truncated — incomplete instructions break agent behavior
      const skipTruncate = noTruncate || name === 'skill';
      this.provider.addToolMessage(toolCallId, result, skipTruncate);
    }

    // 2. 再添加 post-tool 消息（如 REQUIRED_SKILL）
    if (postToolMessages && postToolMessages.length > 0) {
      for (const msg of postToolMessages) {
        this.provider.addMessage(msg);
      }
    }

    // Abort previous and create new controller
    if (this.abortController) {
      this.abortController.abort();
    }
    const controller = new AbortController();
    this.abortController = controller;

    // Link external signal
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        const onAbort = () => {
          externalSignal.removeEventListener('abort', onAbort);
          controller.abort();
        };
        externalSignal.addEventListener('abort', onAbort);
      }
    }

    try {
      await this.rateLimiter.waitForAvailability(controller.signal);

      if (controller.signal.aborted) {
        throw new Error('Interrupted during rate limit wait');
      }

      this.rateLimiter.recordRequest();
      const response = await this.provider.generateFromHistory(toolsToUse, controller.signal);

      if (response.content) {
        const tokens = this.tokenCounter.estimateTokens(response.content);
        this.rateLimiter.recordTokenUsage(tokens);
      }

      return response;
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  // 公开方法：批量添加tool messages（用于中断时保存已执行的结果）
  addToolMessages(toolResults: Array<{ id: string; result: string }>): void {
    for (const { id, result } of toolResults) {
      this.provider.addToolMessage(id, result);
    }
  }

  clearHistory(): void {
    this.provider.clearHistory();
  }

  addMessage(message: ChatMessage): void {
    this.provider.addMessage(message);
  }

  getMessages(): ChatMessage[] {
    return this.provider.getMessages();
  }

  setMessages(messages: ChatMessage[]): void {
    this.provider.setMessages(messages);
  }

  getTokenStatus(): { requestsRemaining: number; tokensRemaining: number } {
    return this.rateLimiter.getStatus();
  }

  getProvider(): OpenAICompatibleProvider {
    return this.provider;
  }

  getTokenCounter(): TokenCounter {
    return this.tokenCounter;
  }

  // 添加用户消息（不立即生成）
  addUserMessage(content: string): void {
    this.provider.addUserMessage(content);
  }

  // 从历史消息继续生成（不添加新的user消息）
  async generateFromHistory(
    tools?: ToolDefinition[],
    externalSignal?: AbortSignal
  ): Promise<LLMResponse> {
    const toolsToUse = tools || this.tools;

    // Abort previous and create new controller
    if (this.abortController) {
      this.abortController.abort();
    }
    const controller = new AbortController();
    this.abortController = controller;

    // Link external signal
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        const onAbort = () => {
          externalSignal.removeEventListener('abort', onAbort);
          controller.abort();
        };
        externalSignal.addEventListener('abort', onAbort);
      }
    }

    try {
      await this.rateLimiter.waitForAvailability(controller.signal);

      if (controller.signal.aborted) {
        throw new Error('Interrupted during rate limit wait');
      }

      this.rateLimiter.recordRequest();
      const response = await this.provider.generateFromHistory(toolsToUse, controller.signal);

      if (response.content) {
        const tokens = this.tokenCounter.estimateTokens(response.content);
        this.rateLimiter.recordTokenUsage(tokens);
      }

      return response;
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }
  setToolResultMaxChars(maxChars: number): void {
    this.provider.setToolResultMaxChars(maxChars);
  }
}
