import { getScreenManager } from './ui/screenManager';
import { COLORS } from './ui/colors';
import { getTerminalWidth, truncateToWidth, formatElapsed, getStringDisplayWidth } from './formatting';

export interface SubAgentRecord {
  id: string;
  type: string;
  description: string;
  status: 'running' | 'done' | 'error';
  startTime: number;
  summary?: string;
  error?: string;
  toolCount: number;
  label: string;
}

export const subAgentState = {
  agents: new Map<string, SubAgentRecord>(),

  clear(): void {
    this.agents.clear();
  },

  add(id: string, data: Omit<SubAgentRecord, 'id'>): void {
    this.agents.set(id, { id, ...data });
  },

  get(id: string): SubAgentRecord | undefined {
    return this.agents.get(id);
  },
};

export function displaySubAgentPanel(): void {
  const screen = getScreenManager();
  const termWidth = getTerminalWidth();
  const agents = Array.from(subAgentState.agents.values());

  if (agents.length === 0) return;

  // 面板标题
  const running = agents.filter(a => a.status === 'running').length;
  const done = agents.filter(a => a.status === 'done').length;
  const error = agents.filter(a => a.status === 'error').length;

  const title = `Subagents (${running} running, ${done} done, ${error} error)`;
  const boxWidth = Math.min(termWidth - 4, Math.max(getStringDisplayWidth(title) + 4, 40));

  screen.appendScroll(COLORS.secondary(`\n┌${'─'.repeat(boxWidth - 2)}┐\n`));
  screen.appendScroll(
    COLORS.secondary(
      `│ ${title}${' '.repeat(Math.max(0, boxWidth - 2 - getStringDisplayWidth(title)))}│\n`
    )
  );

  // 每个 subagent 的状态
  for (const agent of agents.slice(0, 3)) {
    // 最多显示 3 个
    const elapsed = formatElapsed(Date.now() - agent.startTime);
    const statusIcon = agent.status === 'running' ? '⏳' : agent.status === 'done' ? '✓' : '✗';
    const statusColor =
      agent.status === 'running'
        ? COLORS.warning
        : agent.status === 'done'
          ? COLORS.success
          : COLORS.error;

    const desc = truncateToWidth(agent.description, 35);
    const line = `${statusIcon} ${agent.label} ${desc} (${elapsed})`;
    screen.appendScroll(
      statusColor(
        `│ ${line}${' '.repeat(Math.max(0, boxWidth - 2 - getStringDisplayWidth(line)))}│\n`
      )
    );

    // Show summary or error detail for completed agents
    if (agent.status === 'error' && agent.error) {
      const errLine = `   err: ${truncateToWidth(agent.error, boxWidth - 8)}`;
      screen.appendScroll(COLORS.error(`│ ${errLine}${' '.repeat(Math.max(0, boxWidth - 2 - getStringDisplayWidth(errLine)))}│\n`));
    } else if (agent.status === 'done' && agent.summary) {
      const sumLine = `   ${truncateToWidth(agent.summary, boxWidth - 5)}`;
      screen.appendScroll(COLORS.muted(`│ ${sumLine}${' '.repeat(Math.max(0, boxWidth - 2 - getStringDisplayWidth(sumLine)))}│\n`));
    }
  }

  if (agents.length > 3) {
    screen.appendScroll(
      COLORS.muted(`│ ... (${agents.length - 3} more)${' '.repeat(Math.max(0, boxWidth - 15))}│\n`)
    );
  }

  screen.appendScroll(COLORS.secondary(`└${'─'.repeat(boxWidth - 2)}┘\n`));
}
