// Test for message sequence cleaning before API calls
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAICompatibleProvider } from '../llm/providers/OpenAICompatible';
import type { ChatMessage } from '../llm/providers/BaseProvider';

describe('Message Sequence Cleaning', () => {
  let provider: OpenAICompatibleProvider;
  let mockClient: any;

  beforeEach(() => {
    // Mock OpenAI client
    mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [
              {
                message: { content: 'test response' },
                delta: { content: 'test' },
              },
            ],
          }),
        },
      },
    };

    provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://test.api',
      model: 'test-model',
    });

    // Replace internal client with mock
    (provider as any).client = mockClient;
  });

  it('should clean incomplete tool_calls before generate', async () => {
    // 设置一个不完整的消息序列：assistant 有 toolCalls 但没有对应的 tool messages
    const incompleteMessages: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'first user' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_00_test', name: 'test_tool', arguments: {} }],
      },
      // 缺少对应的 tool message！
      { role: 'user', content: 'second user' },
    ];

    (provider as any).messages = incompleteMessages;

    // Mock stream response
    mockClient.chat.completions.create.mockResolvedValueOnce({
      choices: [
        {
          delta: { content: 'response' },
          finish_reason: 'stop',
        },
      ],
    } as any);

    // 调用 generate，应该先清理消息序列
    try {
      await provider.generate('new prompt');
    } catch {
      // 可能因为 mock 不完整而失败，但我们主要检查消息是否被清理
    }

    // 检查消息序列是否被清理
    const messages = provider.getMessages();

    // 找到那个不完整的 assistant 消息
    const assistantWithToolCalls = messages.find(
      m => m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0
    );

    // 如果存在，它应该有对应的 tool messages
    if (assistantWithToolCalls && assistantWithToolCalls.toolCalls) {
      const toolCallIds = assistantWithToolCalls.toolCalls.map(tc => tc.id);
      const toolMessages = messages.filter(m => m.role === 'tool');
      const toolMessageIds = toolMessages.map(m => m.toolCallId || '');

      // 每个 toolCallId 都应该有对应的 tool message
      for (const id of toolCallIds) {
        expect(toolMessageIds).toContain(id);
      }
    }
  });

  it('should preserve complete tool_calls sequences', async () => {
    // 设置一个完整的消息序列
    const completeMessages: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'user prompt' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_00_complete', name: 'test_tool', arguments: {} }],
      },
      { role: 'tool', content: 'tool result', toolCallId: 'call_00_complete' },
    ];

    (provider as any).messages = completeMessages;

    try {
      await provider.generate('new prompt');
    } catch {
      // Mock 可能不完整，但我们主要检查消息是否保留
    }

    const messages = provider.getMessages();

    // 完整的序列应该被保留
    const assistantMsg = messages.find(
      m => m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0
    );
    expect(assistantMsg).toBeDefined();

    const toolMsg = messages.find(m => m.role === 'tool' && m.toolCallId === 'call_00_complete');
    expect(toolMsg).toBeDefined();
  });

  it('should clean incomplete sequences in generateFromHistory', async () => {
    // 设置不完整的消息序列
    const incompleteMessages: ChatMessage[] = [
      { role: 'system', content: 'system' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_missing', name: 'tool', arguments: {} }],
      },
      // 缺少 tool message
    ];

    (provider as any).messages = incompleteMessages;

    try {
      await provider.generateFromHistory();
    } catch {
      // Mock 不完整可能失败
    }

    const messages = provider.getMessages();

    // 不完整的 assistant toolCalls 应该被移除
    const assistantWithToolCalls = messages.find(
      m => m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0
    );

    if (assistantWithToolCalls) {
      // 如果还存在，必须有对应的 tool messages
      const toolMessages = messages.filter(m => m.role === 'tool');
      expect(toolMessages.length).toBeGreaterThan(0);
    }
  });
});
