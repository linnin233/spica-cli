import type { ToolResult } from '../helpers';

// Registry of background subagents waiting for replies.
// Keyed by task_id, value is a resolver that resumes the subagent.
const waitingSubagents = new Map<string, (answer: string) => void>();

export function registerWaitingSubagent(taskId: string, resolver: (answer: string) => void): void {
  waitingSubagents.set(taskId, resolver);
}

export function unregisterWaitingSubagent(taskId: string): void {
  waitingSubagents.delete(taskId);
}

export function executeReplySubagent(
  args: Record<string, unknown>
): ToolResult {
  const taskId = args.task_id as string | undefined;
  const answer = args.answer as string | undefined;

  if (!taskId || !answer) {
    return { success: false, error: 'task_id and answer are required' };
  }

  const resolver = waitingSubagents.get(taskId);
  if (!resolver) {
    return { success: false, error: `No subagent waiting for reply with task_id: ${taskId}` };
  }

  resolver(answer);
  unregisterWaitingSubagent(taskId);

  return { success: true, output: `Reply sent to subagent ${taskId}` };
}
