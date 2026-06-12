import fs from 'fs';
import path from 'path';
import { ChatMessage } from '../llm/providers/BaseProvider';

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
const CONTEXT_FILE = '.spica/context.json';
const MAX_CONTEXT_MESSAGES = 20;

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

export function loadProjectContext(workspacePath: string): ChatMessage[] {
  try {
    const contextPath = path.join(workspacePath, CONTEXT_FILE);
    if (fs.existsSync(contextPath)) {
      const data = fs.readFileSync(contextPath, 'utf-8');
      const messages = JSON.parse(data);
      return messages;
    }
  } catch {
    // Failed to load project context - returning empty array is expected
  }
  return [];
}

export function saveProjectContext(workspacePath: string, messages: ChatMessage[]): void {
  try {
    ensureProjectDir(workspacePath);
    const contextPath = path.join(workspacePath, CONTEXT_FILE);
    const trimmed = messages.slice(-MAX_CONTEXT_MESSAGES);
    fs.writeFileSync(contextPath, JSON.stringify(trimmed, null, 2));
  } catch {
    // Failed to save project context - non-critical error
  }
}
