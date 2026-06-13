import { COLORS } from '../../cli/ui/colors';
import { getInputQueue } from '../../cli/ui/queue';
import type { SlashHandler } from './types';

export const statusHandler: SlashHandler = async (_args, ctx) => {
  // Use context messages (includes system prompts) for token estimation.
  // _fullHistory omits system prompts set directly on the provider.
  const contextMsgs = ctx.agent.getContextMessages();
  const msgs = contextMsgs.length;
  const queue = getInputQueue();
  const queueStatus = queue.getStatus();

  const usedTokens = ctx.tokenCounter.estimateMessages(contextMsgs);

  ctx.screen.appendScroll(COLORS.primary.bold('\nStatus\n'));
  ctx.screen.appendScroll(COLORS.muted('─'.repeat(60) + '\n'));
  ctx.screen.appendScroll(`${COLORS.muted('Messages:')} ${msgs}\n`);
  ctx.screen.appendScroll(`${COLORS.muted('Tokens:')} ~${usedTokens} / ${ctx.tokenCounter.getContextWindow()}\n`);
  ctx.screen.appendScroll(`${COLORS.muted('Model:')} ${ctx.providerConfig.model}\n`);
  ctx.screen.appendScroll(`${COLORS.muted('Queue:')} ${queueStatus.pending} pending, ${queueStatus.total} total\n`);
  ctx.screen.appendScroll('\n');
};
