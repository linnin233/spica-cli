import { WORKSPACE } from '../helpers';
import type { ToolResult } from '../helpers';
import type { PersistedTask } from '../../storage/taskPersistence';
import type { Todo } from '../../agent';
import { getRuntimeState } from '../../core/RuntimeState';

export async function executeTodoRead(_args: Record<string, unknown>): Promise<ToolResult> {
  const { loadPersistedTasks, getTaskStats } = await import('../../storage/taskPersistence');
  const tasks = loadPersistedTasks(WORKSPACE);
  const stats = getTaskStats(WORKSPACE);

  if (tasks.length === 0) {
    return { success: true, output: 'No persisted tasks found. Use todo_write to create tasks.' };
  }

  const statusLabels: Record<string, string> = {
    completed: '[DONE]',
    in_progress: '[ACTV]',
    pending: '[PEND]',
  };

  const lines = [`\nPersisted Tasks (${stats.completed}/${stats.total} done)`];
  lines.push('---------------------------------');
  tasks.forEach((t: PersistedTask, i: number) => {
    const label = statusLabels[t.status] || '[PEND]';
    lines.push(`${label} ${i + 1}. ${t.subject}`);
  });
  lines.push('---------------------------------');
  lines.push('Use todo_write to update or add new tasks.');

  return { success: true, output: lines.join('\n') };
}

export async function executeTodoWrite(args: Record<string, unknown>): Promise<ToolResult> {
  const todos = (args.todos || []) as Todo[];
  const total = todos.length;
  const completed = todos.filter(t => t.status === 'completed').length;
  const inProgress = todos.filter(t => t.status === 'in_progress').length;
  const pending = todos.filter(t => t.status === 'pending').length;

  // Persist to .spica/tasks.json
  const { savePersistedTasks } = await import('../../storage/taskPersistence');
  const persistedTasks: PersistedTask[] = todos.map((t, i) => ({
    id: `task_${i + 1}`,
    subject: t.content,
    description: t.content,
    status: t.status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  savePersistedTasks(WORKSPACE, persistedTasks);

  // Emit todos_set event so the TUI displays the task list
  const agent = getRuntimeState().getAgent();
  if (agent) {
    agent.setTodos(todos);
  }

  const statusLabels: Record<string, string> = {
    completed: '[DONE]',
    in_progress: '[ACTV]',
    pending: '[PEND]',
  };

  const lines = [
    `\nTask List (${completed}/${total} done, ${inProgress} active, ${pending} pending)`,
  ];
  lines.push('---------------------------------');
  todos.forEach((t: Todo, i: number) => {
    const label = statusLabels[t.status] || '[PEND]';
    lines.push(`${label} ${i + 1}. ${t.content}`);
  });
  lines.push('---------------------------------');
  lines.push('(Saved to .spica/tasks.json)');

  return { success: true, output: lines.join('\n') };
}
