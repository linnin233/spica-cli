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
  // NEW fields for overlay
  currentTool?: string;
  toolStartTime?: number;
  priority: number; // 0=error, 1=running, 2=done
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

// ── Type icons + spinner ──────────────────────────────────────────────

export const SUBAGENT_TYPE_ICONS: Record<string, string> = {
  explore: '🔍',
  review: '🔎',
  fix: '🔧',
  build: '🏗️',
};

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerIndex = 0;

export function nextSpinnerFrame(): string {
  spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[spinnerIndex];
}

export function getSortedAgents(): SubAgentRecord[] {
  return Array.from(subAgentState.agents.values())
    .sort((a, b) => a.priority - b.priority);
}

/** Render overlay lines for the fixed subagent panel (Task 3). */
export function renderOverlay(): string[] {
  const agents = getSortedAgents();
  if (agents.length === 0) return [];

  const termWidth = getTerminalWidth();
  const running = agents.filter(a => a.status === 'running').length;
  const done = agents.filter(a => a.status === 'done').length;
  const error = agents.filter(a => a.status === 'error').length;

  const title = `Subagents (${running} running, ${done} done, ${error} error)`;
  const boxWidth = Math.min(termWidth - 4, Math.max(getStringDisplayWidth(title) + 4, 40));

  const lines: string[] = [];

  // Row 0: top border
  const topBorder = `┌${'─'.repeat(boxWidth - 2)}┐`;
  lines.push(COLORS.secondary.bold(topBorder));

  const paddedTitle = `│ ${title}${' '.repeat(Math.max(0, boxWidth - 2 - getStringDisplayWidth(title)))}│`;
  lines.push(COLORS.secondary.bold(paddedTitle));

  // Rows 1-4: display up to 2 highest-priority agents (each 2 rows)
  let displayCount = 0;
  const now = Date.now();

  for (const agent of agents) {
    if (displayCount >= 2) break;

    const elapsed = formatElapsed(now - agent.startTime);
    const icon = SUBAGENT_TYPE_ICONS[agent.type] || '•';

    let statusColor: (s: string) => string;
    let statusIcon: string;

    if (agent.status === 'running') {
      statusColor = COLORS.primary;
      statusIcon = nextSpinnerFrame();
    } else if (agent.status === 'done') {
      statusColor = COLORS.success;
      statusIcon = '✓';
    } else {
      statusColor = COLORS.error.bold;
      statusIcon = '✗';
    }

    const statusLine = `${statusIcon} ${icon} ${agent.label} ${agent.description} (${elapsed})`;
    const paddedStatus = `│ ${statusLine}${' '.repeat(Math.max(0, boxWidth - 2 - getStringDisplayWidth(statusLine)))}│`;
    lines.push(statusColor(paddedStatus));

    // Tool / summary / error line (row 2 per agent)
    if (agent.status === 'running' && agent.currentTool) {
      const toolElapsed = formatElapsed(now - (agent.toolStartTime || agent.startTime));
      const toolLine = `   ↳ ${agent.currentTool} (${toolElapsed})`;
      const paddedTool = `│ ${toolLine}${' '.repeat(Math.max(0, boxWidth - 2 - getStringDisplayWidth(toolLine)))}│`;
      lines.push(COLORS.muted.dim(paddedTool));
    } else if (agent.status === 'done' && agent.summary) {
      const sumLine = `   ${agent.summary}`;
      const paddedSum = `│ ${sumLine}${' '.repeat(Math.max(0, boxWidth - 2 - getStringDisplayWidth(sumLine)))}│`;
      lines.push(COLORS.muted(paddedSum));
    } else if (agent.status === 'error') {
      const firstLine = agent.error ? agent.error.split('\n')[0] : 'unknown error';
      const errLine = `   ${truncateToWidth(firstLine, boxWidth - 6)} [...]`;
      const paddedErr = `│ ${errLine}${' '.repeat(Math.max(0, boxWidth - 2 - getStringDisplayWidth(errLine)))}│`;
      lines.push(COLORS.error(paddedErr));
    } else {
      const emptyLine = `│${' '.repeat(boxWidth - 2)}│`;
      lines.push(COLORS.secondary(emptyLine));
    }

    displayCount++;
  }

  // Fill remaining rows with empty lines (up to 6 total: 1 top + 1 title + 2×2 content + 1 bottom)
  while (lines.length < 6) {
    const emptyLine = `│${' '.repeat(boxWidth - 2)}│`;
    lines.push(COLORS.secondary(emptyLine));
  }

  // Bottom border (always row 6 = index 6)
  const bottomLine = `└${'─'.repeat(boxWidth - 2)}┘`;
  lines.push(COLORS.secondary.bold(bottomLine));

  return lines;
}

/** Write the final panel once into scrollback when overlay closes. */
export function writeFinalPanelToScrollback(): void {
  const lines = renderOverlay();
  if (lines.length === 0) return;

  const screen = getScreenManager();
  screen.appendScroll('\n');
  for (const line of lines) {
    screen.appendScroll(line + '\n');
  }
}
