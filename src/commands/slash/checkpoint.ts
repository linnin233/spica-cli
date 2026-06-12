import { COLORS } from '../../cli/ui/colors';
import { listCheckpoints, getCheckpoint, restoreCheckpoint, cleanCheckpoints } from '../../storage/checkpointManager';
import type { SlashHandler } from './types';

export const checkpointHandler: SlashHandler = async (args, ctx) => {
  const parts = args.trim().split(/\s+/);
  const action = parts[0] || 'list';

  if (action === 'list' || !action) {
    const checkpoints = await listCheckpoints(ctx.agent.getWorkspacePath());

    ctx.screen.appendScroll(COLORS.primary.bold('\nCheckpoints\n'));
    ctx.screen.appendScroll(COLORS.muted('─'.repeat(60) + '\n'));

    if (checkpoints.length === 0) {
      ctx.screen.appendScroll(COLORS.muted('  No checkpoints.\n\n'));
      return;
    }

    checkpoints.slice(0, 20).forEach((cp, i) => {
      const date = new Date(cp.timestamp).toLocaleString();
      ctx.screen.appendScroll(
        COLORS.muted(`  ${i + 1}. ${cp.id}  ${date}  ${cp.message || ''}\n`),
      );
    });
    ctx.screen.appendScroll('\n');
    return;
  }

  if (action === 'show') {
    const id = parts[1];
    if (!id) {
      ctx.screen.appendScroll(COLORS.warning('\nUsage: /checkpoint show <id>\n'));
      return;
    }
    const cp = await getCheckpoint(ctx.agent.getWorkspacePath(), id);
    if (!cp) {
      ctx.screen.appendScroll(COLORS.warning(`\nCheckpoint not found: ${id}\n`));
      return;
    }
    ctx.screen.appendScroll(COLORS.primary.bold(`\nCheckpoint: ${cp.id}\n`));
    ctx.screen.appendScroll(COLORS.muted(`  Time: ${new Date(cp.timestamp).toLocaleString()}\n`));
    ctx.screen.appendScroll(COLORS.muted(`  Message: ${cp.message || '(none)'}\n`));
    ctx.screen.appendScroll(COLORS.muted(`  Files: ${cp.filesBackedUp?.length || 0}\n`));
    ctx.screen.appendScroll('\n');
    return;
  }

  if (action === 'restore') {
    const id = parts[1];
    if (!id) {
      ctx.screen.appendScroll(COLORS.warning('\nUsage: /checkpoint restore <id>\n'));
      return;
    }
    try {
      await restoreCheckpoint(ctx.agent.getWorkspacePath(), id);
      ctx.screen.appendScroll(COLORS.success(`\n[OK] Restored checkpoint: ${id}\n`));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.screen.appendScroll(COLORS.error(`\n[ERR] Failed to restore: ${msg}\n`));
    }
    return;
  }

  if (action === 'clean') {
    const removed = await cleanCheckpoints(ctx.agent.getWorkspacePath());
    ctx.screen.appendScroll(COLORS.success(`\n[OK] Cleaned ${removed} old checkpoint(s)\n`));
    return;
  }

  ctx.screen.appendScroll(COLORS.warning('\nUsage: /checkpoint [list|show|restore|clean]\n'));
};
