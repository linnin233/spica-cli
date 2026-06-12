// Test token counting with toolCalls
import { TokenCounter } from '../TokenCounter';

describe('TokenCounter', () => {
  let counter: TokenCounter;

  beforeEach(() => {
    counter = new TokenCounter();
    counter.setContextWindow(100000);
  });

  it('should estimate basic text tokens', () => {
    const text = 'Hello world'; // 11 chars ≈ 3 tokens
    const tokens = counter.estimateTokens(text);
    expect(tokens).toBeGreaterThanOrEqual(3);
    expect(tokens).toBeLessThanOrEqual(4);
  });

  it('should count message with role and content', () => {
    const msg = { role: 'user', content: 'Hello world' };
    const tokens = counter.estimateMessage(msg);
    // role (1-2) + content (3) + overhead (4) ≈ 8-9 tokens
    expect(tokens).toBeGreaterThanOrEqual(7);
    expect(tokens).toBeLessThanOrEqual(12);
  });

  it('should count toolCalls overhead', () => {
    const msgNoTools = { role: 'assistant', content: '' };
    const msgWithTools = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'tc-123', name: 'read', arguments: { path: '/test/file.txt' } }],
    };

    const tokensNoTools = counter.estimateMessage(msgNoTools);
    const tokensWithTools = counter.estimateMessage(msgWithTools);

    // toolCalls should add: id (2-3) + name (2-3) + args JSON (5-10) + overhead (10) ≈ 20-25
    expect(tokensWithTools).toBeGreaterThan(tokensNoTools + 15);
  });

  it('should count toolCallId', () => {
    const msgNoId = { role: 'tool', content: 'result' };
    const msgWithId = { role: 'tool', content: 'result', toolCallId: 'tc-abc123' };

    const tokensNoId = counter.estimateMessage(msgNoId);
    const tokensWithId = counter.estimateMessage(msgWithId);

    // toolCallId should add 2-3 tokens
    expect(tokensWithId).toBeGreaterThan(tokensNoId);
  });

  it('should count multiple toolCalls', () => {
    const msg = {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'tc-1', name: 'read', arguments: { path: 'a' } },
        { id: 'tc-2', name: 'write', arguments: { path: 'b', content: 'x' } },
        { id: 'tc-3', name: 'bash', arguments: { command: 'ls' } },
      ],
    };

    const tokens = counter.estimateMessage(msg);
    // Each toolCall adds ~15-25 tokens, 3 should add 45-75
    expect(tokens).toBeGreaterThan(50);
  });

  it('should estimate total messages correctly', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: 'Hi there',
        toolCalls: [{ id: 'tc-1', name: 'read', arguments: {} }],
      },
      { role: 'tool', content: 'file content', toolCallId: 'tc-1' },
    ];

    const total = counter.estimateMessages(messages);
    // Should sum all messages + array overhead (3)
    expect(total).toBeGreaterThan(20);

    // Manual check
    const manual = messages.reduce((sum, m) => sum + counter.estimateMessage(m), 0) + 3;
    expect(total).toBe(manual);
  });

  it('should check context window fit', () => {
    const smallMessages = [{ role: 'user', content: 'hi' }];
    expect(counter.canFitInContext(smallMessages, 4096)).toBe(true);

    // Create large messages that exceed context (100k window)
    // Each message: 100 chars = 25 tokens + overhead 5 = 30 tokens
    // Need ~3400 messages to exceed 100k
    const largeMessages: { role: string; content: string }[] = [];
    for (let i = 0; i < 3500; i++) {
      largeMessages.push({ role: 'user', content: 'A'.repeat(100) });
    }
    const tokens = counter.estimateMessages(largeMessages);
    // Should exceed 100k
    expect(tokens).toBeGreaterThan(100000);
    expect(counter.canFitInContext(largeMessages, 4096)).toBe(false);
  });

  it('should return remaining tokens', () => {
    const messages = [{ role: 'user', content: 'Hello world' }];
    const remaining = counter.getRemainingTokens(messages, 4096);

    // Should be positive for small messages
    expect(remaining).toBeGreaterThan(90000);

    // Create messages that nearly fill context
    const largeMessages2: { role: string; content: string }[] = [];
    for (let i = 0; i < 500; i++) {
      largeMessages2.push({ role: 'user', content: 'A'.repeat(400) }); // ~100 tokens each
    }
    const largeRemaining = counter.getRemainingTokens(largeMessages2, 4096);
    expect(largeRemaining).toBeLessThan(50000);
  });
});
