import { describe, it, expect } from 'vitest';

// Test the setSystemPrompt behavior through OpenAICompatibleProvider
import { OpenAICompatibleProvider } from '../../llm/providers/OpenAICompatible';

describe('BaseProvider setSystemPrompt', () => {
  it('should preserve existing messages when setting system prompt', () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://api.test.com/v1',
    });

    // Add some messages first
    provider.addMessage({ role: 'user', content: 'Hello' });
    provider.addMessage({ role: 'assistant', content: 'Hi there' });

    // Verify messages are there
    const messagesBefore = provider.getMessages();
    expect(messagesBefore.length).toBe(2);
    expect(messagesBefore[0].role).toBe('user');

    // Now set system prompt
    provider.setSystemPrompt('You are spica, a coding agent CLI.');

    // Verify: system prompt at index 0, existing messages preserved
    const messagesAfter = provider.getMessages();
    expect(messagesAfter.length).toBe(3);
    expect(messagesAfter[0].role).toBe('system');
    expect(messagesAfter[0].content).toContain('spica');
    expect(messagesAfter[1].role).toBe('user');
    expect(messagesAfter[1].content).toBe('Hello');
    expect(messagesAfter[2].role).toBe('assistant');
    expect(messagesAfter[2].content).toBe('Hi there');
  });

  it('should replace existing system prompt when setting new one', () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://api.test.com/v1',
    });

    // Set first system prompt
    provider.setSystemPrompt('Old system prompt');

    // Add some messages
    provider.addMessage({ role: 'user', content: 'Hello' });
    provider.addMessage({ role: 'assistant', content: 'Hi there' });

    // Set new system prompt
    provider.setSystemPrompt('New system prompt - spica coding agent');

    // Verify: only one system prompt (the new one)
    const messages = provider.getMessages();
    expect(messages.length).toBe(3);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('spica');
    expect(messages.filter(m => m.role === 'system').length).toBe(1);
  });

  it('should handle setting system prompt on empty messages', () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://api.test.com/v1',
    });

    // Set system prompt on empty messages
    provider.setSystemPrompt('You are spica, a coding agent CLI.');

    const messages = provider.getMessages();
    expect(messages.length).toBe(1);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('spica');
  });

  it('should preserve tool messages when setting system prompt', () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      model: 'test-model',
      baseUrl: 'https://api.test.com/v1',
    });

    // Add messages including tool messages
    provider.addMessage({ role: 'user', content: 'Read file' });
    provider.addMessage({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'tc1', name: 'read', arguments: { path: '/test.txt' } }],
    });
    provider.addMessage({ role: 'tool', toolCallId: 'tc1', content: 'file content' });

    // Set system prompt
    provider.setSystemPrompt('You are spica, a coding agent CLI.');

    // Verify: system prompt + all messages preserved
    const messages = provider.getMessages();
    expect(messages.length).toBe(4);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    expect(messages[2].role).toBe('assistant');
    expect(messages[3].role).toBe('tool');
  });
});
