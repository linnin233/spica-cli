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

  // ── AbortController management ──────────────────────────────────────────

  /**
   * Create a fresh AbortController for a new request, aborting any previous one.
   * Links the provided external signal so the controller aborts when the external
   * signal fires (e.g. agent interrupt).
   *
   * Returns the new controller — the caller MUST pass it to completeRequest()
   * or manually clean up in a finally block.
   */
  private createRequestController(externalSignal?: AbortSignal): AbortController {
    // Abort previous controller — only one streaming request at a time
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

    return controller;
  }

  /**
   * Create a controller that does NOT touch this.abortController.
   * Used by generateForCompression — runs concurrently with streaming requests.
   */
  private createStandaloneController(externalSignal?: AbortSignal): AbortController {
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

    return controller;
  }

  /**
   * Clean up the request controller after completion.
   * Only clears `this.abortController` if it's still the same controller —
   * prevents a concurrent call's controller from being cleared.
   */
  private completeRequest(controller: AbortController): void {
    if (this.abortController === controller) {
      this.abortController = null;
    }
  }

  /**
   * Wait for rate limiter, respecting abort signal.
   */
  private async waitForRateLimit(signal: AbortSignal): Promise<void> {
    await this.rateLimiter.waitForAvailability(signal);
    if (signal.aborted) {
      throw new Error('Interrupted during rate limit wait');
    }
  }

  /**
   * Record request and token usage for rate limiting.
   */
  private recordUsage(response: LLMResponse): void {
    this.rateLimiter.recordRequest();
    if (response.content) {
      const tokens = this.tokenCounter.estimateTokens(response.content);
      this.rateLimiter.recordTokenUsage(tokens);
    }
  }

  // ── API methods ─────────────────────────────────────────────────────────

  /** Check API connection (supports interrupt). */
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

  /** Main generate: adds user message to history, then streams. */
  async generate(
    prompt: string,
    tools?: ToolDefinition[],
    externalSignal?: AbortSignal
  ): Promise<LLMResponse> {
    const controller = this.createRequestController(externalSignal);
    try {
      await this.waitForRateLimit(controller.signal);
      const toolsToUse = tools || this.tools;
      const response = await this.provider.generate(prompt, toolsToUse, controller.signal);
      this.recordUsage(response);
      return response;
    } finally {
      this.completeRequest(controller);
    }
  }

  /** Generate without adding to history — for summaries, etc. */
  async generateDirect(prompt: string, externalSignal?: AbortSignal): Promise<LLMResponse> {
    const controller = this.createRequestController(externalSignal);
    try {
      await this.waitForRateLimit(controller.signal);
      const response = await this.provider.generateDirect(prompt, controller.signal);
      this.recordUsage(response);
      return response;
    } finally {
      this.completeRequest(controller);
    }
  }

  /**
   * Generate a summary for context compression.
   * Independent of the main request — uses a standalone controller so it can
   * run concurrently with a streaming generate() call.
   */
  async generateForCompression(prompt: string, externalSignal?: AbortSignal): Promise<LLMResponse> {
    const controller = this.createStandaloneController(externalSignal);

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

  /**
   * Continue after all tool results have been collected.
   * Adds tool messages + optional post-tool messages, then streams from history.
   */
  async continueWithAllToolResults(
    toolResults: Array<{ name: string; result: string; id?: string; noTruncate?: boolean }>,
    tools?: ToolDefinition[],
    postToolMessages?: ChatMessage[],
    externalSignal?: AbortSignal
  ): Promise<LLMResponse> {
    const toolsToUse = tools || this.tools;
    const lastMessage = this.provider.getMessages()[this.provider.getMessages().length - 1];

    // 1. Add all tool result messages (must follow assistant tool_calls)
    for (const { name, result, id, noTruncate } of toolResults) {
      const toolCallId = id || lastMessage.toolCalls?.find(tc => tc.name === name)?.id || '';
      // Skill tools must not be truncated — incomplete instructions break agent behavior
      const skipTruncate = noTruncate || name === 'skill';
      this.provider.addToolMessage(toolCallId, result, skipTruncate);
    }

    // 2. Add post-tool messages (e.g. REQUIRED_SKILL)
    if (postToolMessages && postToolMessages.length > 0) {
      for (const msg of postToolMessages) {
        this.provider.addMessage(msg);
      }
    }

    const controller = this.createRequestController(externalSignal);
    try {
      await this.waitForRateLimit(controller.signal);
      const response = await this.provider.generateFromHistory(toolsToUse, controller.signal);
      this.recordUsage(response);
      return response;
    } finally {
      this.completeRequest(controller);
    }
  }

  /** Continue from history without adding a new user message. */
  async generateFromHistory(
    tools?: ToolDefinition[],
    externalSignal?: AbortSignal
  ): Promise<LLMResponse> {
    const controller = this.createRequestController(externalSignal);
    try {
      await this.waitForRateLimit(controller.signal);
      const toolsToUse = tools || this.tools;
      const response = await this.provider.generateFromHistory(toolsToUse, controller.signal);
      this.recordUsage(response);
      return response;
    } finally {
      this.completeRequest(controller);
    }
  }

  // ── Message helpers ─────────────────────────────────────────────────────

  /** Batch-add tool messages (used for preserving results on interrupt). */
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

  addUserMessage(content: string): void {
    this.provider.addUserMessage(content);
  }

  setToolResultMaxChars(maxChars: number): void {
    this.provider.setToolResultMaxChars(maxChars);
  }

  // ── Interrupt ────────────────────────────────────────────────────────────

  interrupt() {
    this.rateLimiter.interrupt();
    if (this.abortController) {
      this.abortController.abort();
    }
  }
}
