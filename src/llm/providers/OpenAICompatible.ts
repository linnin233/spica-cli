import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { BaseProvider, ToolDefinition, LLMResponse, LLMProviderConfig, ChatMessage, ToolCall } from './BaseProvider';

// Error types and hints
const ERROR_MESSAGES: Record<string, { type: string; hint: string }> = {
  // Network errors
  ECONNREFUSED: { type: 'Connection refused', hint: 'Check if API URL is correct and server is online' },
  ENOTFOUND: { type: 'Domain not found', hint: 'Check if API URL is correct' },
  ETIMEDOUT: { type: 'Connection timeout', hint: 'Network unstable or server slow, try again later' },
  ECONNRESET: { type: 'Connection reset', hint: 'Network unstable, try again later' },
  ENETUNREACH: { type: 'Network unreachable', hint: 'Check network connection' },
  EHOSTUNREACH: { type: 'Host unreachable', hint: 'Check network connection or firewall settings' },

  // HTTP status codes
  '401': { type: 'Authentication failed', hint: 'API Key invalid or expired, check configuration' },
  '402': { type: 'Insufficient balance', hint: 'API quota exhausted, recharge or switch account' },
  '403': { type: 'Permission denied', hint: 'No access to this model' },
  '404': { type: 'Resource not found', hint: 'Model name error or incorrect API URL' },
  '429': { type: 'Rate limited', hint: 'Wait for a while before retrying' },
  '500': { type: 'Server internal error', hint: 'API service temporarily unavailable, try again later' },
  '502': { type: 'Gateway error', hint: 'API service temporarily unavailable, try again later' },
  '503': { type: 'Service unavailable', hint: 'API service maintenance or overload, try again later' },
};

// 模型上下文窗口大小（默认值，可从API获取）
const DEFAULT_CONTEXT_WINDOW = 128000;

// 常见模型的上下文窗口
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-4': 8192,
  'gpt-4-turbo': 128000,
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-3.5-turbo': 4096,
  'claude-3-opus': 200000,
  'claude-3-sonnet': 200000,
  'claude-3-haiku': 200000,
  'claude-3-5-sonnet': 200000,
  'glm-4': 128000,
  'glm-5': 190000,  // 智谱 GLM-5 API限制202745，保守设置留余量
};

// 解析错误并返回友好提示
function parseError(error: any): { type: string; message: string; hint: string } {
  const code = String(error.code || error.status || '');
  const message = error.message || '';

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
  private contextWindow: number = DEFAULT_CONTEXT_WINDOW;

  constructor(config: LLMProviderConfig) {
    super(config);
    this.providerName = config.name || 'OpenAI-compatible';

    // 从预设表获取上下文窗口，或使用默认值
    this.contextWindow = MODEL_CONTEXT_WINDOWS[config.model] || DEFAULT_CONTEXT_WINDOW;

    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: 60000,  // 60秒超时 (优化)
      maxRetries: 1,
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
  async checkConnection(signal?: AbortSignal): Promise<{ success: boolean; type?: string; error?: string; hint?: string }> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.config.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }, {
        timeout: 15000,
        signal: signal,
      });
      return { success: true };
    } catch (error: any) {
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

async generate(prompt: string, tools?: ToolDefinition[], signal?: AbortSignal): Promise<LLMResponse> {
    this.messages.push({ role: 'user', content: prompt });

    try {
      const stream = await this.client.chat.completions.create({
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
        temperature: 0.3,  // 低温度加速响应
      }, { signal });

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
                this.emit('tool_name_chunk', tc.function.name);
              }
              if (tc.function?.arguments) {
                toolCalls[tc.index].arguments += tc.function.arguments;
              }
            }
          });
        }
      }

      if (hasToolCalls && toolCalls.length > 0) {
        const parsedToolCalls: ToolCall[] = toolCalls.map(tc => ({
          id: tc.id,
          name: tc.name || '',
          arguments: tc.arguments ? ((): Record<string, any> => { try { return JSON.parse(tc.arguments); } catch { return {}; } })() : {},
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
      if (error.message?.includes('streaming')) {
        return await this.generateNonStreaming(prompt, tools);
      }
      throw new Error(`${this.providerName} API error: ${error.message}`);
    }
  }

  // 直接生成（不添加到历史，用于摘要等）
  async generateDirect(prompt: string, signal?: AbortSignal): Promise<LLMResponse> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.config.model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        temperature: 0.3,
      }, { signal });

      const content = response.choices[0]?.message?.content || '';
      return { content, finished: true };
    } catch (error: any) {
      if (signal?.aborted) {
        return { finished: true };
      }
      throw new Error(`${this.providerName} API error: ${error.message}`);
    }
  }
  
  private async generateNonStreaming(prompt: string, tools?: ToolDefinition[]): Promise<LLMResponse> {
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

  async continueWithToolResult(toolCallId: string, result: string, tools?: ToolDefinition[], signal?: AbortSignal): Promise<LLMResponse> {
    this.messages.push({
      role: 'tool',
      content: result,
      toolCallId: toolCallId,
    });

    try {
      const stream = await this.client.chat.completions.create({
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
        temperature: 0.3,  // 低温度加速响应
      }, { signal });

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

      if (hasToolCalls && toolCalls.length > 0) {
        const parsedToolCalls: ToolCall[] = toolCalls.map(tc => ({
          id: tc.id,
          name: tc.name || '',
          arguments: tc.arguments ? ((): Record<string, any> => { try { return JSON.parse(tc.arguments); } catch { return {}; } })() : {},
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
  addToolMessage(toolCallId: string, result: string): void {
    const exists = this.messages.some(m => 
      m.role === 'tool' && m.toolCallId === toolCallId
    );
    if (!exists) {
      this.messages.push({
        role: 'tool',
        content: result,
        toolCallId: toolCallId,
      });
    }
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
    try {
      const stream = await this.client.chat.completions.create({
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
        temperature: 0.3,  // 低温度加速响应
      }, { signal });

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

      if (hasToolCalls && toolCalls.length > 0) {
        const parsedToolCalls: ToolCall[] = toolCalls.map(tc => ({
          id: tc.id,
          name: tc.name || '',
          arguments: tc.arguments ? ((): Record<string, any> => { try { return JSON.parse(tc.arguments); } catch { return {}; } })() : {},
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