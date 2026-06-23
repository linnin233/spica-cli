import fs from 'fs';
import path from 'path';

export interface ProjectState {
  phase: 'mvp' | 'cycle' | 'archive' | 'unknown';
  todos: Array<{
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
  }>;
  decisions: Array<{
    decision: string;
    reason: string;
    timestamp: string;
  }>;
  lastActivity: string;
  recentFiles: string[];
  summary?: string;
}

const STATE_FILE = '.spica/state.json';

export function ensureProjectDir(workspacePath: string): void {
  const spicaDir = path.join(workspacePath, '.spica');
  if (!fs.existsSync(spicaDir)) {
    fs.mkdirSync(spicaDir, { recursive: true });
  }
}

export function loadProjectState(workspacePath: string): ProjectState | null {
  try {
    const statePath = path.join(workspacePath, STATE_FILE);
    if (fs.existsSync(statePath)) {
      const data = fs.readFileSync(statePath, 'utf-8');
      return JSON.parse(data);
    }
  } catch {
    // Failed to load project state - returning null is expected behavior
  }
  return null;
}

export function saveProjectState(workspacePath: string, state: ProjectState): void {
  try {
    ensureProjectDir(workspacePath);
    const statePath = path.join(workspacePath, STATE_FILE);
    state.lastActivity = new Date().toISOString();
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch {
    // Failed to save project state - non-critical error
  }
}

export function updateProjectTodos(workspacePath: string, todos: ProjectState['todos']): void {
  const state = loadProjectState(workspacePath) || {
    phase: 'unknown',
    todos: [],
    decisions: [],
    lastActivity: new Date().toISOString(),
    recentFiles: [],
  };
  state.todos = todos;
  saveProjectState(workspacePath, state);
}

export function addDecision(workspacePath: string, decision: string, reason: string): void {
  const state = loadProjectState(workspacePath) || {
    phase: 'unknown',
    todos: [],
    decisions: [],
    lastActivity: new Date().toISOString(),
    recentFiles: [],
  };
  state.decisions.push({
    decision,
    reason,
    timestamp: new Date().toISOString(),
  });
  saveProjectState(workspacePath, state);
}

export function setProjectPhase(workspacePath: string, phase: ProjectState['phase']): void {
  const state = loadProjectState(workspacePath) || {
    phase: 'unknown',
    todos: [],
    decisions: [],
    lastActivity: new Date().toISOString(),
    recentFiles: [],
  };
  state.phase = phase;
  saveProjectState(workspacePath, state);
}

