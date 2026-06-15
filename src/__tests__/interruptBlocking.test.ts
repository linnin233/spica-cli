/**
 * Test: ESC ESC interrupt MUST work during blocking bash commands.
 */
import { describe, it, expect, vi } from 'vitest';
import { SpicaAgent } from '../agent';
import { TokenCounter } from '../llm/TokenCounter';
import type { ChatMessage } from '../llm/providers/BaseProvider';

function makeAgent(ctxWindow: number = 100000) {
  const agent = new SpicaAgent('test', '/tmp');
  let _msgs: ChatMessage[] = [];

  let generateCount = 0;
  const mockLLM = {
    _msgs: [] as ChatMessage[],
    getMessages: vi.fn(function (this: any) { return this._msgs; }),
    setMessages: vi.fn(function (this: any, msgs: ChatMessage[]) { this._msgs = msgs; }),
    addMessage: vi.fn(function (this: any, msg: ChatMessage) { this._msgs.push(msg); }),
    addToolMessages: vi.fn(),
    getProvider: vi.fn(() => ({
      getContextWindow: () => ctxWindow,
      getCachePrefixEnd: () => -1,
      setCachePrefixEnd: vi.fn(),
      validateCachePrefix: () => ({ valid: true, errors: [] }),
    })),
    getTokenCounter: vi.fn(() => {
      const counter = new TokenCounter();
      counter.setContextWindow(ctxWindow);
      return counter;
    }),
    generate: vi.fn().mockImplementation(() => {
      generateCount++;
      return Promise.resolve({
        content: 'Running a blocking command.',
        finished: false,
        toolCalls: [{
          id: 'bash_block',
          name: 'bash',
          arguments: { command: 'sleep 100', timeout: 120 },
        }],
      });
    }),
    generateFromHistory: vi.fn().mockResolvedValue({ content: 'SHOULD_NOT_REACH', finished: true, toolCalls: [] }),
    continueWithAllToolResults: vi.fn().mockResolvedValue({ content: 'SHOULD_NOT_REACH', finished: true, toolCalls: [] }),
    generateForCompression: vi.fn().mockResolvedValue({ content: 'Mock summary with file.ts fix.' }),
    generateDirect: vi.fn().mockResolvedValue({ content: 'ok' }),
    checkConnection: vi.fn().mockResolvedValue({ success: true }),
    setSystemPromptSplit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    interrupt: vi.fn(),
  };

  Object.defineProperty(agent, 'llm', { value: mockLLM, writable: true });
  agent.stateMachine.forceTransition('idle');

  return { agent, mockLLM };
}

describe('Interrupt during blocking bash', () => {
  it('interrupt kills sleep 100 and returns INTERRUPTED', async () => {
    const { agent } = makeAgent();
    const runPromise = agent.runLoop('Run a blocking command');

    // Wait for bash to actually start executing sleep 100
    await new Promise(r => setTimeout(r, 500));

    // Verify abortController is set
    const ctrl = (agent as any).currentAbortController;
    expect(ctrl).not.toBeNull();

    // Interrupt
    const t0 = Date.now();
    agent.interrupt();

    // Verify signal was aborted
    expect(ctrl.signal.aborted).toBe(true);

    const result = await runPromise;
    const elapsed = Date.now() - t0;

    // Must return quickly (not wait 100s for sleep)
    expect(elapsed).toBeLessThan(3000);
    expect(result).toContain('INTERRUPTED');
    expect(agent.stateMachine.current).toBe('idle');
  }, 10000);

  it('can accept new input after interrupt', async () => {
    const { agent, mockLLM } = makeAgent();

    const run1 = agent.runLoop('Blocking command');
    await new Promise(r => setTimeout(r, 300));
    agent.interrupt();
    await run1;
    expect(agent.stateMachine.current).toBe('idle');

    // Second run should work normally
    mockLLM.generate.mockResolvedValue({ content: 'Done.', finished: true, toolCalls: [] });
    const result = await agent.runLoop('Hello');
    expect(result).toBe('Done.');
    expect(agent.stateMachine.current).toBe('idle');
  }, 10000);
});
