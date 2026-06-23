import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import {
  BaseProvider,
  ToolDefinition,
  LLMResponse,
  LLMProviderConfig,
  ChatMessage,
  ToolCall,
} from './BaseProvider';
import { sessionStats } from '../../core/sessionStats';
import { cleanMessages } from '../../utils/messageCleaner';

// Error types and hints
const ERROR_MESSAGES: Record<string, { type: string; hint: string }> = {
  // Network errors
  ECONNREFUSED: {
    type: 'Connection refused',
    hint: 'Check if API URL is correct and server is online',
  },
  ENOTFOUND: { type: 'Domain not found', hint: 'Check if API URL is correct' },
  ETIMEDOUT: {
    type: 'Connection timeout',
    hint: 'Network unstable or server slow, try again later',
  },
  ECONNRESET: { type: 'Connection reset', hint: 'Network unstable, try again later' },
  ENETUNREACH: { type: 'Network unreachable', hint: 'Check network connection' },
  EHOSTUNREACH: { type: 'Host unreachable', hint: 'Check network connection or firewall settings' },

  // HTTP status codes
  '401': { type: 'Authentication failed', hint: 'API Key invalid or expired, check configuration' },
  '402': { type: 'Insufficient balance', hint: 'API quota exhausted, recharge or switch account' },
  '403': { type: 'Permission denied', hint: 'No access to this model' },
  '404': { type: 'Resource not found', hint: 'Model name error or incorrect API URL' },
  '429': { type: 'Rate limited', hint: 'Wait for a while before retrying' },
  '500': {
    type: 'Server internal error',
    hint: 'API service temporarily unavailable, try again later',
  },
  '502': { type: 'Gateway error', hint: 'API service temporarily unavailable, try again later' },
  '503': {
    type: 'Service unavailable',
    hint: 'API service maintenance or overload, try again later',
  },
};

// Default context window when model is unknown
const DEFAULT_CONTEXT_WINDOW = 128000;

// Known model context windows — exact match first, then prefix match.
// Sorted by prefix length descending for best-match-first resolution.
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // OpenAI
  'gpt-4.1': 1000000,
  'gpt-4.1-mini': 1000000,
  'gpt-4.1-nano': 1000000,
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  'gpt-3.5-turbo': 16385,
  'o4-mini': 200000,
  o3: 200000,
  'o3-mini': 200000,
  o1: 200000,
  'o1-mini': 128000,
  // Anthropic
  'claude-4': 200000,
  'claude-4-opus': 200000,
  'claude-4-sonnet': 200000,
  'claude-3.5-sonnet': 200000,
  'claude-3.5-haiku': 200000,
  'claude-3-opus': 200000,
  'claude-3-sonnet': 200000,
  'claude-3-haiku': 200000,
  // DeepSeek
  'deepseek-chat': 128000,
  'deepseek-v3': 128000,
  'deepseek-r1': 128000,
  'deepseek-v4': 128000,
  // Gemini
  'gemini-2.5': 1000000,
  'gemini-2.0': 1000000,
  'gemini-1.5': 1000000,
  // GLM / Zhipu
  'glm-5': 190000,
  'glm-4': 128000,
  // Groq
  'llama-4': 128000,
  'llama-3': 128000,
  mixtral: 32000,
  // Qwen
  qwen3: 128000,
  'qwen-max': 128000,
  'qwen-plus': 128000,
};

// Resolve context window: exact match → prefix match → default
function resolveContextWindow(model: string): number {
  if (MODEL_CONTEXT_WINDOWS[model]) return MODEL_CONTEXT_WINDOWS[model];
  // Prefix match: e.g. "gpt-4o-2024-08-06" matches "gpt-4o"
  for (const [prefix, window] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (model.startsWith(prefix)) return window;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

// 解析错误并返回友好提示
function parseError(error: unknown): { type: string; message: string; hint: string } {
  const errorObj = error instanceof Error ? error : { message: String(error) };
  const code = String(
    (error as { code?: unknown; status?: unknown }).code ||
      (error as { code?: unknown; status?: unknown }).status ||
      ''
  );
  const message = errorObj.message || '';

  // 查找预定义的错误
  if (ERROR_MESSAGES[code]) {
    return {
      type: ERROR_MESSAGES[code].type,
      message: message,
      hint: ERROR_MESSAGES[code].hint,
    };
  }

  // Network related errors
  if (message.includes('network') || message.includes('connection') || message.includes('socket')) {
    return {
      type: 'Network error',
      message: message,
      hint: 'Check network connection and API URL',
    };
  }

  // Timeout
  if (message.includes('timeout') || message.includes('timed out')) {
    return {
      type: 'Request timeout',
      message: message,
      hint: 'Server slow or network unstable',
    };
  }

  // API相关错误
  if (message.includes('API')) {
    return {
      type: 'API错误',
      message: message,
      hint: 'Check if API configuration is correct',
    };
  }

  // 其他错误
  return {
    type: 'Unknown error',
    message: message,
    hint: 'Check error details or contact support',
  };
}

export class OpenAICompatibleProvider extends BaseProvider {
  private client: OpenAI;
  private providerName: string;
  private onChunk?: (chunk: string) => void;
  private toolResultMaxChars: number = 8000; // chars, ~2000 tokens
  private contextWindow: number = DEFAULT_CONTEXT_WINDOW;

  constructor(config: LLMProviderConfig) {
    super(config);
    this.providerName = config.name || 'OpenAI-compatible';

    // Resolve context window: exact match → prefix match → default
    this.contextWindow = resolveContextWindow(config.model);

    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: 120000, // 120秒超时（支持较慢的 API 如阿里云 GLM）
      maxRetries: 0, // Spica handles retries via callLLMWithRetry
    });
  }

  // 获取模型上下文窗口大小
  getContextWindow(): number {
    return this.contextWindow;
  }

  // 尝试从API获取模型信息（异步）
  async fetchModelInfo(): Promise<void> {
    try {
      const modelInfo = await this.client.models.retrieve(this.config.model);
      // OpenAI API 返回的模型信息中可能包含 context_window 或类似字段
      if (modelInfo && typeof modelInfo === 'object') {
        // 检查是否有上下文窗口信息
        const info = modelInfo as any;
        if (info.context_window) {
          this.contextWindow = info.context_window;
        }
      }
    } catch {
      // 获取失败，使用预设值
    }
  }

  // 快速连接检测（支持中断）
  async checkConnection(
    signal?: AbortSignal
  ): Promise<{ success: boolean; type?: string; error?: string; hint?: string }> {
    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        },
        {
          timeout: 15000,
          signal: signal,
        }
      );
      return { success: true };
    } catch (error: unknown) {
      if (signal?.aborted) {
        return { success: false, type: '中断', error: 'User interrupted', hint: '用户取消' };
      }
      const parsed = parseError(error);
      return {
        success: false,
        type: parsed.type,
        error: parsed.message,
        hint: parsed.hint,
      };
    }
  }

  setChunkHandler(handler: (chunk: string) => void): void {
    this.onChunk = handler;
  }

  async generate(
    prompt: string,
    tools?: ToolDefinition[],
    signal?: AbortSignal
  ): Promise<LLMResponse> {
    // 关键修复：在添加新用户消息前，清理不完整的消息序列
    // 防止出现 assistant toolCalls 没有对应 tool messages 的情况
    // 但保护缓存前缀（system prompt + early stable messages）不被 cleanMessages 破坏
    if (this.cachePrefixEnd >= 0 && this.cachePrefixEnd < this.messages.length - 1) {
      const prefixMessages = this.messages.slice(0, this.cachePrefixEnd + 1);
      const suffixMessages = this.messages.slice(this.cachePrefixEnd + 1);
      const cleanedSuffix = cleanMessages(suffixMessages);
      this.messages = [...prefixMessages, ...cleanedSuffix];
    } else {
      this.messages = cleanMessages(this.messages);
    }

    // Mark prefix boundary on first call (system prompt + initial messages are stable)
    if (this.cachePrefixEnd === -1) {
      this.cachePrefixEnd = this.messages.length - 1;
    }

    // Validate prefix invariants: a bug here means all API calls lose cache hits
    if (process.env.SPICA_CACHE_DEBUG) {
      const { valid, errors } = this.validateCachePrefix();
      if (!valid) {
        console.warn(
          `[OpenAICompatible] cachePrefixEnd validation FAILED before generate:\n`,
          errors.map(e => `  - ${e}`).join('\n')
        );
      }
    }

    this.messages.push({ role: 'user', content: prompt });

    // DEBUG: 检查消息序列是否正确（清理后应该总是正确）
    const converted = this.convertMessages();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OpenAI API message type is complex
    const lastAssistantWithToolCalls = converted
      .filter(m => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0)
      .pop() as any;
    if (lastAssistantWithToolCalls) {
      const lastIndex = converted.indexOf(lastAssistantWithToolCalls);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OpenAI tool_calls structure
      const expectedIds = lastAssistantWithToolCalls.tool_calls.map((tc: any) => tc.id);
      const followingMessages = converted.slice(lastIndex + 1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OpenAI message structure
      const toolMessagesFollowing = followingMessages.filter((m: any) => m.role === 'tool');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OpenAI message structure
      const foundIds = toolMessagesFollowing.map((m: any) => m.tool_call_id);

      if (expectedIds.some((id: string) => !foundIds.includes(id))) {
        console.error(
          '[DEBUG] Invalid message sequence detected AFTER cleaning (should not happen):'
        );
        console.error('[DEBUG] Expected tool_call_ids:', expectedIds);
        console.error('[DEBUG] Found tool_call_ids:', foundIds);
        console.error('[DEBUG] Last assistant message index:', lastIndex);
        console.error('[DEBUG] Following messages:', followingMessages.slice(0, 5));
        // 再次紧急清理（防御性）
        this.messages = cleanMessages(this.messages, true);
      }
    }

    // Per-session request counting (always works, even if API doesn't report usage)
    sessionStats.countRequest();

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: converted,
          tools: tools?.map(t => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          })),
          stream: true,
          stream_options: { include_usage: true },
          temperature: 0.3, // 低温度加速响应
        },
        { signal }
      );

      let fullContent = '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OpenAI tool_calls structure is complex
      const toolCalls: any[] = [];
      let hasToolCalls = false;
      let lastUsage: any = null; // captured from final stream chunk

      for await (const chunk of stream) {
        if (signal?.aborted) break;

        const delta = chunk.choices[0]?.delta;

        if (delta?.content) {
          fullContent += delta.content;
          this.emit('chunk', delta.content);
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DeepSeek reasoning_content field
        if ((delta as any)?.reasoning_content) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DeepSeek reasoning_content field
          this.emit('reasoning', (delta as any).reasoning_content);
        }

        if (delta?.tool_calls) {
          hasToolCalls = true;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OpenAI tool_calls delta structure
          delta.tool_calls.forEach((tc: any) => {
            if (tc.index !== undefined) {
              if (!toolCalls[tc.index]) {
                toolCalls[tc.index] = { id: tc.id, name: '', arguments: '' };
              }
              if (tc.function?.name) {
                toolCalls[tc.index].name += tc.function.name;
                this.emit('tool_name_chunk', tc.function.name);
              }
              if (tc.function?.arguments) {
                toolCalls[tc.index].arguments += tc.function.arguments;
              }
            }
          });
        }

        // Capture usage from final chunk (stream_options.include_usage)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((chunk as any).usage) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          lastUsage = (chunk as any).usage;
        }
      }

      // Emit actual API usage for stats tracking
      if (lastUsage) {
        this.emit('llm_usage', {
          promptTokens: lastUsage.prompt_tokens || 0,
          completionTokens: lastUsage.completion_tokens || 0,
          totalTokens: lastUsage.total_tokens || 0,
          cachedTokens: lastUsage.prompt_tokens_details?.cached_tokens || 0,
        });
      }

      // 中断时抛出错误，让调用者知道是被中断的
      if (signal?.aborted) {
        throw new Error('LLM streaming aborted by user interrupt');
      }

      if (hasToolCalls && toolCalls.length > 0) {
        const parsedToolCalls: ToolCall[] = toolCalls.map(tc => ({
          id: tc.id,
          name: tc.name || '',
          arguments: tc.arguments
            ? ((): Record<string, any> => {
                try {
                  return JSON.parse(tc.arguments);
                } catch {
                  return {};
                }
              })()
            : {},
        }));

        this.messages.push({
          role: 'assistant',
          content: fullContent || '',
          toolCalls: parsedToolCalls,
        });

        return { toolCalls: parsedToolCalls, finished: false };
      }

      if (fullContent) {
        this.messages.push({ role: 'assistant', content: fullContent });
        return { content: fullContent, finished: true };
      }

      return { finished: true };
    } catch (error: any) {
      if (signal?.aborted) {
        throw new Error('LLM streaming aborted by user interrupt');
      }
      if (error.message?.includes('streaming')) {
        return await this.generateNonStreaming(prompt, tools);
      }
      throw new Error(`${this.providerName} API error: ${error.message}`);
    }
  }

  // 直接生成（不添加到历史，用于摘要等）
  async generateDirect(prompt: string, signal?: AbortSignal): Promise<LLMResponse> {
    sessionStats.countRequest();
    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          temperature: 0.3,
        },
        { signal }
      );

      const content = response.choices[0]?.message?.content || '';

      // Emit actual API usage for stats tracking
      if (response.usage) {
        this.emit('llm_usage', {
          promptTokens: response.usage.prompt_tokens || 0,
          completionTokens: response.usage.completion_tokens || 0,
          totalTokens: response.usage.total_tokens || 0,
          cachedTokens: response.usage.prompt_tokens_details?.cached_tokens || 0,
        });
      }

      return { content, finished: true };
    } catch (error: any) {
      if (signal?.aborted) {
        return { finished: true };
      }
      throw new Error(`${this.providerName} API error: ${error.message}`);
    }
  }

  private async generateNonStreaming(
    prompt: string,
    tools?: ToolDefinition[]
  ): Promise<LLMResponse> {
    this.messages.pop();
    this.messages.push({ role: 'user', content: prompt });

    const response = await this.client.chat.completions.create({
      model: this.config.model,
      messages: this.convertMessages(),
      tools: tools?.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
      temperature: 0.3,
    });

    const choice = response.choices[0];
    const message = choice.message;

    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolCalls: ToolCall[] = message.tool_calls.map(tc => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      }));

      this.messages.push({
        role: 'assistant',
        content: message.content || '',
        toolCalls: toolCalls,
      });

      return { toolCalls, finished: false };
    }

    if (message.content) {
      this.messages.push({ role: 'assistant', content: message.content });
      return { content: message.content, finished: true };
    }

    return { finished: true };
  }

  private convertMessages(): ChatCompletionMessageParam[] {
    return this.messages.map(m => {
      if (m.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: m.toolCallId!,
          content: m.content,
        } as any;
      }
      if (m.role === 'assistant' && m.toolCalls) {
        return {
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        } as any;
      }
      return { role: m.role, content: m.content } as any;
    });
  }

  // 添加tool结果消息
  addToolMessage(toolCallId: string, result: string, noTruncate?: boolean): void {
    const exists = this.messages.some(m => m.role === 'tool' && m.toolCallId === toolCallId);
    if (exists) return;

    let trimmedResult = result;
    if (!noTruncate && result.length > this.toolResultMaxChars) {
      const truncated = result.slice(0, this.toolResultMaxChars);
      const omitted = result.length - this.toolResultMaxChars;
      trimmedResult =
        truncated +
        `\n\n[TRUNCATED: ${omitted} chars omitted from tool result. Request the full output if needed with a more specific query.]`;
    }

    this.messages.push({
      role: 'tool',
      content: trimmedResult,
      toolCallId: toolCallId,
    });
  }

  setToolResultMaxChars(maxChars: number): void {
    this.toolResultMaxChars = maxChars;
  }

  // 添加用户消息（不立即生成）
  addUserMessage(content: string): void {
    this.messages.push({
      role: 'user',
      content: content,
    });
  }

  // 从当前历史发起生成请求（不添加新的user消息）
  async generateFromHistory(tools?: ToolDefinition[], signal?: AbortSignal): Promise<LLMResponse> {
    // 关键修复：清理后缀消息，保护缓存前缀不被破坏
    if (this.cachePrefixEnd >= 0 && this.cachePrefixEnd < this.messages.length - 1) {
      const prefixMessages = this.messages.slice(0, this.cachePrefixEnd + 1);
      const suffixMessages = this.messages.slice(this.cachePrefixEnd + 1);
      const cleanedSuffix = cleanMessages(suffixMessages);
      this.messages = [...prefixMessages, ...cleanedSuffix];
    } else {
      this.messages = cleanMessages(this.messages);
    }

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: this.convertMessages(),
          tools: tools?.map(t => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          })),
          stream: true,
          temperature: 0.3, // 低温度加速响应
        },
        { signal }
      );

      let fullContent = '';
      const toolCalls: any[] = [];
      let hasToolCalls = false;

      for await (const chunk of stream) {
        if (signal?.aborted) break;

        const delta = chunk.choices[0]?.delta;

        if (delta?.content) {
          fullContent += delta.content;
          this.emit('chunk', delta.content);
        }

        if ((delta as any)?.reasoning_content) {
          this.emit('reasoning', (delta as any).reasoning_content);
        }

        if (delta?.tool_calls) {
          hasToolCalls = true;
          delta.tool_calls.forEach((tc: any) => {
            if (tc.index !== undefined) {
              if (!toolCalls[tc.index]) {
                toolCalls[tc.index] = { id: tc.id, name: '', arguments: '' };
              }
              if (tc.function?.name) {
                toolCalls[tc.index].name += tc.function.name;
              }
              if (tc.function?.arguments) {
                toolCalls[tc.index].arguments += tc.function.arguments;
              }
            }
          });
        }
      }

      // 中断时抛出错误，让调用者知道是被中断的
      if (signal?.aborted) {
        throw new Error('LLM streaming aborted by user interrupt');
      }

      if (hasToolCalls && toolCalls.length > 0) {
        const parsedToolCalls: ToolCall[] = toolCalls.map(tc => ({
          id: tc.id,
          name: tc.name || '',
          arguments: tc.arguments
            ? ((): Record<string, any> => {
                try {
                  return JSON.parse(tc.arguments);
                } catch {
                  return {};
                }
              })()
            : {},
        }));

        this.messages.push({
          role: 'assistant',
          content: fullContent || '',
          toolCalls: parsedToolCalls,
        });

        return { toolCalls: parsedToolCalls, finished: false };
      }

      if (fullContent) {
        this.messages.push({ role: 'assistant', content: fullContent });
        return { content: fullContent, finished: true };
      }

      return { finished: true };
    } catch (error: any) {
      if (signal?.aborted) {
        return { finished: true };
      }
      throw new Error(`${this.providerName} API error: ${error.message}`);
    }
  }
}
