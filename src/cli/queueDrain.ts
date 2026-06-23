import { InputQueue } from './ui/queue';

/**
 * Auto-drain the input queue after processing completes.
 * Merges pending queue items and calls handler recursively until queue is empty.
 *
 * @returns true if any items were drained, false if queue was empty
 */
export async function autoDrainQueue(
  queue: InputQueue,
  handler: (mergedInput: string) => Promise<void>
): Promise<boolean> {
  if (!queue.hasPending()) {
    return false;
  }

  const merged = queue.mergePending();

  await handler(merged);

  // Check for items added during handler execution
  if (queue.hasPending()) {
    await autoDrainQueue(queue, handler);
  }

  return true;
}
