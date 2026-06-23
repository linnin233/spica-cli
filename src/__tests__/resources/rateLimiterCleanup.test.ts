import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../../llm/RateLimiter';

describe('RateLimiter interruptibleSleep cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should resolve immediately when signal aborts during sleep', async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 0 });
    const controller = new AbortController();

    const waitPromise = limiter.waitForAvailability(controller.signal);

    // Advance time a bit to enter the sleep
    await vi.advanceTimersByTimeAsync(500);

    // Abort should cause the promise to resolve
    controller.abort();

    // Should resolve without hanging
    const result = await Promise.race([
      waitPromise.then(() => 'resolved'),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 1000)),
    ]);

    expect(result).toBe('resolved');
  });

  it('should resolve immediately when interrupt() is called during sleep', async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 0 });

    const waitPromise = limiter.waitForAvailability();

    await vi.advanceTimersByTimeAsync(500);

    limiter.interrupt();

    const result = await Promise.race([
      waitPromise.then(() => 'resolved'),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 1000)),
    ]);

    expect(result).toBe('resolved');
  });

  it('should have cleanup function in abort handler (code verification)', async () => {
    const fs = await import('fs-extra');
    const source = await fs.readFile('src/llm/RateLimiter.ts', 'utf-8');
    // Verify cleanup function is called in abort handler
    const cleanupMatch = source.match(/const cleanup = \(\) =>/);
    expect(cleanupMatch).not.toBeNull();
    // Verify cleanup is called via onAbort handler (proper listener cleanup)
    const abortHandler = source.match(/signal\.addEventListener\('abort',\s*onAbort\)/);
    expect(abortHandler).not.toBeNull();
    // Verify cleanup is called when signal is already aborted
    const alreadyAborted = source.match(/signal\.aborted.*onAbort\(\)/s);
    expect(alreadyAborted).not.toBeNull();
  });
});
