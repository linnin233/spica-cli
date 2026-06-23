// Task persistence - save and restore task progress across sessions

import fs from 'fs-extra';
import { join } from 'path';

const TASKS_FILE = '.spica/tasks.json';

export interface PersistedTask {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  activeForm?: string;
  owner?: string;
  blockedBy?: string[];
  blocks?: string[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, any>;
}

export interface TasksState {
  tasks: PersistedTask[];
  lastUpdated: string;
}

// Load persisted tasks
export function loadPersistedTasks(workspacePath: string): PersistedTask[] {
  try {
    const tasksPath = join(workspacePath, TASKS_FILE);
    if (fs.existsSync(tasksPath)) {
      const state: TasksState = fs.readJsonSync(tasksPath);
      return state.tasks.filter(t => t.status !== 'deleted');
    }
  } catch {
    // Failed to load - return empty
  }
  return [];
}

// Save tasks to file
export function savePersistedTasks(workspacePath: string, tasks: PersistedTask[]): void {
  try {
    const spicaDir = join(workspacePath, '.spica');
    fs.ensureDirSync(spicaDir);

    const state: TasksState = {
      tasks: tasks.filter(t => t.status !== 'deleted'),
      lastUpdated: new Date().toISOString(),
    };

    fs.writeJsonSync(join(spicaDir, 'tasks.json'), state, { spaces: 2 });
  } catch {
    // Failed to save - non-critical
  }
}

// Add or update a task
export function updatePersistedTask(workspacePath: string, task: PersistedTask): void {
  const tasks = loadPersistedTasks(workspacePath);
  const existingIndex = tasks.findIndex(t => t.id === task.id);

  task.updatedAt = new Date().toISOString();

  if (existingIndex >= 0) {
    tasks[existingIndex] = { ...tasks[existingIndex], ...task };
  } else {
    task.createdAt = task.createdAt || new Date().toISOString();
    tasks.push(task);
  }

  savePersistedTasks(workspacePath, tasks);
}

// Delete a task
export function deletePersistedTask(workspacePath: string, taskId: string): void {
  const tasks = loadPersistedTasks(workspacePath);
  const filtered = tasks.filter(t => t.id !== taskId);
  savePersistedTasks(workspacePath, filtered);
}

// Clear all tasks
export function clearPersistedTasks(workspacePath: string): void {
  try {
    const tasksPath = join(workspacePath, TASKS_FILE);
    if (fs.existsSync(tasksPath)) {
      fs.removeSync(tasksPath);
    }
  } catch {}
}

// Get task statistics
export function getTaskStats(workspacePath: string): {
  total: number;
  pending: number;
  in_progress: number;
  completed: number;
} {
  const tasks = loadPersistedTasks(workspacePath);
  return {
    total: tasks.length,
    pending: tasks.filter(t => t.status === 'pending').length,
    in_progress: tasks.filter(t => t.status === 'in_progress').length,
    completed: tasks.filter(t => t.status === 'completed').length,
  };
}
