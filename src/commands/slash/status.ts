import { COLORS } from '../../cli/ui/colors';
import { getInputQueue } from '../../cli/ui/queue';
import { sessionStats } from '../../core/sessionStats';
import type { SlashHandler } from './types';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export const statusHandler: SlashHandler = async (_args, ctx) => {
  const contextMsgs = ctx.agent.getContextMessages();
  const msgs = contextMsgs.length;
  const queue = getInputQueue();
  const queueStatus = queue.getStatus();

  const usedTokens = ctx.tokenCounter.estimateMessages(contextMsgs);
  const ctxPct = ((usedTokens / ctx.tokenCounter.getContextWindow()) * 100).toFixed(1);

  ctx.screen.appendScroll(COLORS.primary.bold('\nStatus\n'));
  ctx.screen.appendScroll(COLORS.muted('─'.repeat(60) + '\n'));
  ctx.screen.appendScroll(`${COLORS.muted('Messages:')} ${msgs}\n`);
  ctx.screen.appendScroll(
    `${COLORS.muted('Context:')} ${ctxPct}% (${fmtTokens(usedTokens)} / ${fmtTokens(ctx.tokenCounter.getContextWindow())} tokens)\n`
  );

  // API usage stats (per-session, reset on /new)
  const stats = sessionStats.snapshot();
  const parts: string[] = [
    `${stats.requestCount} requests`,
  ];
  if (stats.hasApiData) {
    parts.push(`${fmtTokens(stats.totalPromptTokens)} prompt`);
    if (stats.cacheHitRate >= 0) {
      parts.push(`${fmtTokens(stats.totalCachedTokens)} cached (${(stats.cacheHitRate * 100).toFixed(1)}%)`);
    }
    parts.push(`${fmtTokens(stats.totalCompletionTokens)} completion`);
  } else {
    parts.push(COLORS.muted('cache data unavailable (provider may not support stream usage reporting)'));
  }
  ctx.screen.appendScroll(`${COLORS.muted('API Usage:')} ${parts.join(' | ')}\n`);

  ctx.screen.appendScroll(`${COLORS.muted('Model:')} ${ctx.providerConfig.model}\n`);
  ctx.screen.appendScroll(`${COLORS.muted('Queue:')} ${queueStatus.pending} pending, ${queueStatus.total} total\n`);
  ctx.screen.appendScroll('\n');
};
