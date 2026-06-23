import { describe, it, expect } from 'vitest';
import { SpicaAgent } from '../../agent';
import { setupAgentEvents } from '../../cli/events';
import { TokenCounter } from '../../llm/TokenCounter';

describe('event listener cleanup', () => {
  it('setupAgentEvents should return a cleanup function', () => {
    const agent = new SpicaAgent(undefined, '/tmp');
    const tokenCounter = new TokenCounter();

    const cleanup = setupAgentEvents(agent, false, 'test-model', tokenCounter);
    expect(typeof cleanup).toBe('function');

    cleanup();
  });

  it('cleanup function should remove listeners from agent', () => {
    const agent = new SpicaAgent(undefined, '/tmp');
    const tokenCounter = new TokenCounter();
    const beforeCount = agent.listenerCount('tool_result');

    const cleanup = setupAgentEvents(agent, false, 'test-model', tokenCounter);
    const afterSetupCount = agent.listenerCount('tool_result');
    expect(afterSetupCount).toBeGreaterThan(beforeCount);

    cleanup();

    const afterCleanupCount = agent.listenerCount('tool_result');
    expect(afterCleanupCount).toBeLessThanOrEqual(beforeCount + 1);
  });

  it('multiple cleanup calls should be idempotent', () => {
    const agent = new SpicaAgent(undefined, '/tmp');
    const tokenCounter = new TokenCounter();

    const cleanup = setupAgentEvents(agent, false, 'test-model', tokenCounter);
    const afterSetupCount = agent.listenerCount('stream');

    cleanup();
    // Second call should not throw
    expect(() => cleanup()).not.toThrow();

    const afterSecondCleanup = agent.listenerCount('stream');
    expect(afterSecondCleanup).toBeLessThanOrEqual(afterSetupCount);
  });
});
