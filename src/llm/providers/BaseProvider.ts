import { EventEmitter } from 'events';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface LLMResponse {
  content?: string;
  toolCalls?: ToolCall[];
  finished: boolean;
  reasoning?: string;
}

export interface LLMProviderConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  name?: string;
}

export abstract class BaseProvider extends EventEmitter {
  protected config: LLMProviderConfig;
  protected messages: ChatMessage[] = [];
  // Track where the cacheable prefix ends (index of last stable message)
  protected cachePrefixEnd: number = -1;

  constructor(config: LLMProviderConfig) {
    super();
    this.config = config;
  }

  abstract generate(prompt: string, tools?: ToolDefinition[]): Promise<LLMResponse>;
  abstract checkConnection(
    signal?: AbortSignal
  ): Promise<{ success: boolean; type?: string; error?: string; hint?: string }>;

  setSystemPrompt(prompt: string) {
    // 移除旧的 system 消息，保留其他消息
    this.messages = this.messages.filter(m => m.role !== 'system');
    // 在开头添加新的 system 消息
    this.messages.unshift({ role: 'system', content: prompt });
  }

  /**
   * Set system prompt as two messages: stable (cached) + variable (may change).
   * Splitting the prompt means OpenAI's prefix cache hits the stable message
   * even when skills/learnings change between sessions.
   */
  setSystemPromptSplit(stable: string, variable?: string) {
    this.messages = this.messages.filter(m => m.role !== 'system');
    this.messages.unshift({ role: 'system', content: stable });
    if (variable && variable.length > 0) {
      // Insert after the stable system message
      this.messages.splice(1, 0, { role: 'system', content: variable });
    }
  }

  addMessage(message: ChatMessage) {
    this.messages.push(message);
  }

  clearHistory() {
    this.messages = [];
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  setMessages(messages: ChatMessage[]): void {
    this.messages = messages;
    // Preserve system prompt as cache prefix boundary.
    // System messages are the most stable part — keeping them in the prefix
    // means the API-side (OpenAI automatic prefix caching) sees the same
    // prefix across compaction/new-session, maintaining cache hits.
    // If no system messages, reset to -1 so next generate() re-marks.
    const sysCount = messages.filter(m => m.role === 'system').length;
    this.cachePrefixEnd = sysCount > 0 ? sysCount - 1 : -1;
  }

  /**
   * Validate cache prefix invariants. Called in debug paths to catch silent
   * cache invalidation before it hits production API calls.
   *
   * Invariants:
   * 1. cachePrefixEnd in [-1, messages.length - 1]
   * 2. All system messages must be within [0, cachePrefixEnd]
   * 3. cachePrefixEnd === -1 iff no system messages (or deliberately reset)
   */
  validateCachePrefix(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const end = this.cachePrefixEnd;
    const len = this.messages.length;

    // Invariant 1: bounds
    if (end < -1 || end >= len) {
      errors.push(
        `cachePrefixEnd=${end} out of bounds [${-1}, ${len - 1}] — cache will be broken`
      );
    }

    // Invariant 2: system messages within prefix
    if (end >= 0) {
      for (let i = 0; i < len; i++) {
        if (this.messages[i].role === 'system' && i > end) {
          errors.push(
            `system message at index ${i} is outside cache prefix [0, ${end}] — prefix will miss system prompt`
          );
        }
      }
    }

    // Invariant 3: -1 is valid only when intentional (system-only or fresh start)
    // Not strictly an error — just warn if there are system messages but prefix is -1
    if (end === -1) {
      const hasSystem = this.messages.some(m => m.role === 'system');
      if (hasSystem) {
        errors.push(
          'cachePrefixEnd=-1 but system messages exist — prefix cache will not include them'
        );
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /** Get the cache prefix boundary index for compression-aware truncation. */
  getCachePrefixEnd(): number {
    return this.cachePrefixEnd;
  }

  /** Set the cache prefix boundary to a specific index. */
  setCachePrefixEnd(index: number): void {
    this.cachePrefixEnd = Math.max(-1, Math.min(index, this.messages.length - 1));
  }

  // Mark current messages end as cache prefix boundary
  markCachePrefixEnd(): void {
    this.cachePrefixEnd = this.messages.length - 1;
  }
}
