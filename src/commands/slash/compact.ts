import { COLORS } from '../../cli/ui/colors';
import type { SlashHandler } from './types';
import { generateSessionSummary } from '../../utils/session';

export const compactHandler: SlashHandler = async (_args, ctx) => {
  await ctx.agent.compact();
};

export const summaryHandler: SlashHandler = async (_args, ctx) => {
  const msgs = ctx.agent.getMessages();
  ctx.screen.appendScroll(COLORS.primary.bold('\nSession Summary\n'));
  ctx.screen.appendScroll(COLORS.muted('─'.repeat(60) + '\n'));

  // Try LLM-based summarization first, fall back to local
  const llm = ctx.agent.getLLM();
  if (llm) {
    try {
      const userMessages = msgs
        .filter((m: { role: string; content?: string }) => m.role === 'user')
        .map((m: { content?: string }) => (m.content || '').slice(0, 200))
        .slice(0, 5);

      const assistantMessages = msgs
        .filter((m: { role: string; content?: string; toolCalls?: Array<{ name: string }> }) => m.role === 'assistant')
        .map((m: { content?: string; toolCalls?: Array<{ name: string }> }) => {
          let content = m.content || '';
          if (m.toolCalls && m.toolCalls.length > 0) {
            const tools = m.toolCalls.map((tc: { name: string }) => tc.name).join(', ');
            content = `[Tools: ${tools}] ${content.slice(0, 50)}`;
          }
          return content;
        })
        .slice(0, 10);

      const prompt = `Summarize this coding session concisely (under 200 chars). Include completed tasks, pending work, and files touched. User requests: ${userMessages.join(' | ')}. AI actions: ${assistantMessages.join(' | ')}`;

      const response = await llm.generateDirect(prompt);
      const summary = response.content || generateSessionSummary(msgs);

      ctx.screen.appendScroll(summary + '\n');
      ctx.screen.appendScroll(COLORS.muted(`\nSession: ${msgs.length} messages analyzed\n`));
      return;
    } catch {
      // Fall back to local summary
    }
  }

  const summary = generateSessionSummary(msgs);
  ctx.screen.appendScroll(summary || COLORS.muted('No summary available.\n'));
  ctx.screen.appendScroll('\n');
};
