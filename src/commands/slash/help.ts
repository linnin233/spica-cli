import { COLORS } from '../../cli/ui/colors';
import type { SlashHandler } from './types';

export const helpHandler: SlashHandler = async (_args, ctx) => {
  ctx.screen.appendScroll(COLORS.primary.bold('\nCommands:\n'));
  ctx.screen.appendScroll(COLORS.muted('  quit/exit   Exit spica\n'));
  ctx.screen.appendScroll(COLORS.muted('  /help /h    Show this help\n'));
  ctx.screen.appendScroll('\n');
  ctx.screen.appendScroll(COLORS.primary.bold('Session:\n'));
  ctx.screen.appendScroll(COLORS.muted('  /archive /clear /reset /new  Archive current & start new\n'));
  ctx.screen.appendScroll(COLORS.muted('  /history /sessions           Browse archived chats (read-only)\n'));
  ctx.screen.appendScroll(COLORS.muted('  /view <id>                   Read specific archived chat\n'));
  ctx.screen.appendScroll(COLORS.muted('  /rename <id> <name>          Rename archived chat\n'));
  ctx.screen.appendScroll(COLORS.muted('  /delete <id>                 Delete archived chat\n'));
  ctx.screen.appendScroll(COLORS.muted('  /summary /sum                Summarize current session\n'));
  ctx.screen.appendScroll(COLORS.muted('  /compact                     Compress context\n'));
  ctx.screen.appendScroll(COLORS.muted('  /init [instructions]         Create AGENTS.md\n'));
  ctx.screen.appendScroll('\n');
  ctx.screen.appendScroll(COLORS.primary.bold('Queue:\n'));
  ctx.screen.appendScroll(COLORS.muted('  /queue /q    Show input queue\n'));
  ctx.screen.appendScroll(COLORS.muted('  /undo        Remove last queued input\n'));
  ctx.screen.appendScroll('\n');
  ctx.screen.appendScroll(COLORS.primary.bold('Skill:\n'));
  ctx.screen.appendScroll(COLORS.muted('  /skill list             List skills\n'));
  ctx.screen.appendScroll(COLORS.muted('  /skill install <url>    Install skill package\n'));
  ctx.screen.appendScroll(COLORS.muted('  /skill uninstall <name> Uninstall skill package\n'));
  ctx.screen.appendScroll(COLORS.muted('  /skill add <name> [tpl] Add custom skill\n'));
  ctx.screen.appendScroll(COLORS.muted('  /skill remove <name>    Remove skill\n'));
  ctx.screen.appendScroll(COLORS.muted('  /skill edit <name> <tpl> Edit skill\n'));
  ctx.screen.appendScroll('\n');
  ctx.screen.appendScroll(COLORS.primary.bold('MCP:\n'));
  ctx.screen.appendScroll(COLORS.muted('  /mcp status     Show MCP status\n'));
  ctx.screen.appendScroll(COLORS.muted('  /mcp init       Create example config\n'));
  ctx.screen.appendScroll(COLORS.muted('  /mcp tools      List available tools\n'));
  ctx.screen.appendScroll(COLORS.muted('  /mcp disconnect  Disconnect all servers\n'));
  ctx.screen.appendScroll('\n');
  ctx.screen.appendScroll(COLORS.muted('  /status     Show status (messages, tokens, model, queue)\n'));
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
