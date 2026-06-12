import { COLORS } from '../../cli/ui/colors';
import { getInputQueue, clearInputQueue } from '../../cli/ui/queue';
import type { SlashHandler } from './types';

export const queueHandler: SlashHandler = async (args, ctx) => {
  const cmd = args.trim();

  // /undo: remove last queued input
  if (cmd === 'undo') {
    const queue = getInputQueue();
    const removed = queue.undoLast();

    if (removed) {
      ctx.screen.appendScroll(
        COLORS.muted(`\n[QUEUE] Removed: ${removed.content}\n`),
      );
    } else {
      ctx.screen.appendScroll(
        COLORS.muted('\n[QUEUE] No pending inputs\n'),
      );
    }

    return;
  }

  // /queue or /q: show queue status
  const queue = getInputQueue();
  const status = queue.getStatus();

  ctx.screen.appendScroll(COLORS.primary.bold('\nInput Queue\n'));
  ctx.screen.appendScroll(COLORS.muted('─'.repeat(60) + '\n'));
  ctx.screen.appendScroll(
    `${COLORS.muted('Total:')} ${status.total}  ${COLORS.muted('Pending:')} ${status.pending}  ${COLORS.muted('Processed:')} ${status.processed}\n`,
  );

  if (status.pendingPreview.length > 0) {
    ctx.screen.appendScroll(COLORS.muted('\nPending inputs:\n'));
    status.pendingPreview.forEach((item: string) => {
      ctx.screen.appendScroll(COLORS.muted(`  ${item}\n`));
    });
  }

  ctx.screen.appendScroll(COLORS.muted('\nCommands: /q | /undo\n'));
  ctx.screen.appendScroll('\n');
};
