import { COLORS } from '../../cli/ui/colors';
import { getSortedAgents, SUBAGENT_TYPE_ICONS } from '../../cli/subagentPanel';
import { formatElapsed } from '../../cli/formatting';
import type { SlashHandler } from './types';

export const subagentsHandler: SlashHandler = async (_args, ctx) => {
  const agents = getSortedAgents();

  if (agents.length === 0) {
    ctx.screen.appendScroll(COLORS.muted('\nNo subagents have been dispatched in this session.\n\n'));
    return;
  }

  ctx.screen.appendScroll(COLORS.secondary.bold('\nSubagents (History)\n'));
  ctx.screen.appendScroll(COLORS.muted('─'.repeat(60) + '\n'));

  for (const agent of agents) {
    const icon = SUBAGENT_TYPE_ICONS[agent.type] || '•';
    const elapsed = formatElapsed(Date.now() - agent.startTime);

    let statusColor: (s: string) => string;
    let statusLabel: string;
    if (agent.status === 'running') {
      statusColor = COLORS.primary;
      statusLabel = 'RUNNING';
    } else if (agent.status === 'done') {
      statusColor = COLORS.success;
      statusLabel = 'DONE';
    } else {
      statusColor = COLORS.error;
      statusLabel = 'ERROR';
    }

    ctx.screen.appendScroll(
      statusColor(`${icon} ${agent.label} ${statusLabel} — ${agent.description}\n`)
    );
    ctx.screen.appendScroll(COLORS.muted(`  Duration: ${elapsed} | Tools: ${agent.toolCount}\n`));

    if (agent.status === 'done' && agent.summary) {
      ctx.screen.appendScroll(COLORS.success(`  Summary: ${agent.summary}\n`));
    } else if (agent.status === 'error') {
      if (agent.error) {
        const lines = agent.error.split('\n');
        ctx.screen.appendScroll(COLORS.error(`  Error: ${lines[0]}\n`));
        if (lines.length > 1) {
          ctx.screen.appendScroll(COLORS.muted(`  Full trace:\n`));
          for (const line of lines.slice(1, 8)) {
            ctx.screen.appendScroll(COLORS.muted(`    ${line.slice(0, 100)}\n`));
          }
          if (lines.length > 8) {
            ctx.screen.appendScroll(COLORS.muted(`    ... (${lines.length - 8} more lines)\n`));
          }
        }
      }
    } else if (agent.status === 'running' && agent.currentTool) {
      ctx.screen.appendScroll(COLORS.primary(`  Currently: ${agent.currentTool}\n`));
    }

    ctx.screen.appendScroll('\n');
  }

  ctx.screen.appendScroll('\n');
};
