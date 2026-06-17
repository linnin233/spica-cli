import { COLORS } from '../../cli/ui/colors';
import type { SlashHandler } from './types';

export const helpHandler: SlashHandler = async (_args, ctx) => {
  ctx.screen.appendScroll(COLORS.primary.bold('\nCommands:\n'));
  ctx.screen.appendScroll(COLORS.muted('  quit/exit   Exit\n'));
  ctx.screen.appendScroll(COLORS.muted('  help        Show help\n'));
  ctx.screen.appendScroll('\n');
  ctx.screen.appendScroll(COLORS.primary.bold('Session:\n'));
  ctx.screen.appendScroll(COLORS.muted('  /history /h      List archived sessions\n'));
  ctx.screen.appendScroll(COLORS.muted('  /view <id>       View session details\n'));
  ctx.screen.appendScroll(COLORS.muted('  /rename <id> <n>  Rename session\n'));
  ctx.screen.appendScroll(COLORS.muted('  /delete <id>     Delete session\n'));
  ctx.screen.appendScroll(COLORS.muted('  /archive         Archive current session\n'));
  ctx.screen.appendScroll('\n');
  ctx.screen.appendScroll(COLORS.primary.bold('Skills:\n'));
  ctx.screen.appendScroll(COLORS.muted('  /skill list               List skills\n'));
  ctx.screen.appendScroll(COLORS.muted('  /skill install <url>      Install skill\n'));
  ctx.screen.appendScroll(COLORS.muted('  /skill uninstall <name>   Uninstall\n'));
  ctx.screen.appendScroll(COLORS.muted('  /skill add <name> <tmpl>  Add skill\n'));
  ctx.screen.appendScroll(COLORS.muted('  /skill remove <name>      Remove skill\n'));
  ctx.screen.appendScroll(COLORS.muted('  /skill edit <name> <tmpl> Edit skill\n'));
  ctx.screen.appendScroll('\n');
  ctx.screen.appendScroll(COLORS.primary.bold('MCP:\n'));
  ctx.screen.appendScroll(COLORS.muted('  /mcp status     Show MCP status\n'));
  ctx.screen.appendScroll(COLORS.muted('  /mcp init       Create example config\n'));
  ctx.screen.appendScroll(COLORS.muted('  /mcp tools      List available tools\n'));
  ctx.screen.appendScroll(COLORS.muted('  /mcp disconnect  Disconnect all servers\n'));
  ctx.screen.appendScroll('\n');
  ctx.screen.appendScroll(COLORS.muted('  /status     Show status\n'));
  ctx.screen.appendScroll('\n');
};

export const initHandler: SlashHandler = async (args, ctx) => {
  const userArgs = args.trim();

  const initPrompt = `Analyze this project and create AGENTS.md. Reference https://agents.md/ for the standard.

What to include: how to build, how to test, code conventions, PR workflow.
Verify every command by running it. Don't guess. Be specific to this project.

If AGENTS.md already exists, preserve valuable content and supplement updates.${userArgs ? '\n\nAdditional instructions: ' + userArgs : ''}`;

  await ctx.handleInput(initPrompt);
};

export const historyMsgHandler: SlashHandler = async (_args, ctx) => {
  const msgs = ctx.agent.getMessages();

  ctx.screen.appendScroll(COLORS.primary.bold('\nHistory:\n'));
  if (msgs.length === 0) {
    ctx.screen.appendScroll(COLORS.muted('  (empty)\n'));
  } else {
    msgs.forEach((m: { role: string; content?: string }, i: number) => {
      const role = m.role === 'user' ? 'YOU' : m.role === 'assistant' ? 'AI' : 'SYS';
      const content = m.content || '';
      ctx.screen.appendScroll(COLORS.muted(`  ${i + 1}. [${role}]\n`));
      content.split('\n').forEach((line: string) => {
        ctx.screen.appendScroll(COLORS.muted(`     ${line}\n`));
      });
    });
    ctx.screen.appendScroll(COLORS.muted(`\n  Total: ${msgs.length} messages\n`));
  }
  ctx.screen.appendScroll('\n');
};
