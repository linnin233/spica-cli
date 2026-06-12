import { COLORS } from '../../cli/ui/colors';
import { getInputQueue } from '../../cli/ui/queue';
import type { SlashHandler } from './types';

export const statusHandler: SlashHandler = async (_args, ctx) => {
  const msgs = ctx.agent.getMessages().length;
  const queue = getInputQueue();
  const queueStatus = queue.getStatus();

  const usedTokens = ctx.tokenCounter.estimateMessages(
    ctx.agent.getMessages()
  );

  ctx.screen.appendScroll(COLORS.primary.bold('\nStatus\n'));
  ctx.screen.appendScroll(COLORS.muted('─'.repeat(60) + '\n'));
  ctx.screen.appendScroll(`${COLORS.muted('Messages:')} ${msgs}\n`);
  ctx.screen.appendScroll(`${COLORS.muted('Tokens:')} ~${usedTokens} / ${ctx.tokenCounter.getContextWindow()}\n`);
  ctx.screen.appendScroll(`${COLORS.muted('Model:')} ${ctx.providerConfig.model}\n`);
  ctx.screen.appendScroll(`${COLORS.muted('Queue:')} ${queueStatus.pending} pending, ${queueStatus.total} total\n`);
  ctx.screen.appendScroll('\n');
};
