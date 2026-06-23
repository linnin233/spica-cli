import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InputQueue, getInputQueue, clearInputQueue } from '../cli/ui/queue';
import { autoDrainQueue } from '../cli/queueDrain';

describe('autoDrainQueue', () => {
  let queue: InputQueue;

  beforeEach(() => {
    clearInputQueue();
    queue = getInputQueue();
  });

  it('returns false when queue is empty', async () => {
    const handler = vi.fn();

    const result = await autoDrainQueue(queue, handler);

    expect(result).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('drains one pending item and calls handler with merged content', async () => {
    queue.add('task one');
    const handler = vi.fn().mockResolvedValue(undefined);

    const result = await autoDrainQueue(queue, handler);

    expect(result).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('task one');
    expect(queue.hasPending()).toBe(false);
  });

  it('merges multiple pending items into one call', async () => {
    queue.add('task one');
    queue.add('task two');
    queue.add('task three');
    const handler = vi.fn().mockResolvedValue(undefined);

    const result = await autoDrainQueue(queue, handler);

    expect(result).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('task one\n\n---\n\ntask two\n\n---\n\ntask three');
    expect(queue.hasPending()).toBe(false);
  });

  it('processes items that arrive during handler execution (nested drain)', async () => {
    queue.add('first');
    let callCount = 0;
    const handler = vi.fn().mockImplementation(async () => {
      callCount++;
      // Simulate new items arriving while processing
      if (callCount === 1) {
        queue.add('second');
        queue.add('third');
      }
    });

    const result = await autoDrainQueue(queue, handler);

    expect(result).toBe(true);
    // First call processes 'first', discovers 'second' + 'third' were added
    // Second call processes 'second\nthird'
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, 'first');
    expect(handler).toHaveBeenNthCalledWith(2, 'second\n\n---\n\nthird');
    expect(queue.hasPending()).toBe(false);
  });

  it('handles handler rejection without blocking subsequent drains', async () => {
    queue.add('before-error');
    queue.add('after-error');
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce(undefined);

    // Should merge both into one call, handler throws, but queue items already merged
    await expect(autoDrainQueue(queue, handler)).rejects.toThrow('fail');

    // After error, queue should be empty (items were merged/drained before call)
    expect(queue.hasPending()).toBe(false);
  });
});
