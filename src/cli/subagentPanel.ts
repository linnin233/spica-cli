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

// ── Type icons ──────────────────────────────────────────────

export const SUBAGENT_TYPE_ICONS: Record<string, string> = {
  explore: 'exp',
  review: 'rev',
  fix: 'fix',
  build: 'bld',
};

export function getSortedAgents(): SubAgentRecord[] {
  return Array.from(subAgentState.agents.values())
    .sort((a, b) => a.priority - b.priority);
}

export function getRunningCount(): number {
  let count = 0;
  for (const a of subAgentState.agents.values()) {
    if (a.status === 'running') count++;
  }
  return count;
}
