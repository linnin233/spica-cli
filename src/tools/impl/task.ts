import { execa } from 'execa';
import fs from 'fs-extra';
import { join } from 'path';
import { SubAgentTask, getSubAgentConfig, summarizeResult, type SubAgentResult } from '../subAgent';
import { WORKSPACE } from '../helpers';
import type { ToolResult, ToolEventCallback } from '../helpers';
import { getSkill, buildSkillPrompt } from '../../skills';
import { registerWaitingSubagent, unregisterWaitingSubagent } from './replySubagent';

interface TaskResult {
  status: SubAgentResult['status'];
  taskLabel: string;
  summary?: string;
  error?: string;
}

// ── Background task tracking ──────────────────────────────────────────

interface BackgroundTask {
  taskId: string;
  abort: () => void;
}

const backgroundTasks = new Map<string, BackgroundTask>();

export function getBackgroundTaskIds(): string[] {
  return Array.from(backgroundTasks.keys());
}

export function stopBackgroundTask(taskId: string): boolean {
  const task = backgroundTasks.get(taskId);
  if (!task) return false;
  task.abort();
  backgroundTasks.delete(taskId);
  return true;
}

// ── Worktree isolation helpers ────────────────────────────────────────────

interface WorktreeHandle {
  worktreePath: string;
  branchName: string;
}

/** Create a git worktree for isolated sub-agent work. Returns null on failure. */
async function createWorktree(basePath: string, taskIndex: number): Promise<WorktreeHandle | null> {
  const suffix = `${Date.now().toString(36)}`;
  const branchName = `spica-wt-${taskIndex}-${suffix}`;
  const worktreePath = join(basePath, '.spica', 'worktrees', branchName);

  try {
    // Ensure we're in a git repo
    await execa('git', ['rev-parse', '--git-dir'], { cwd: basePath, timeout: 5000, reject: true });

    // Create the worktree
    await fs.ensureDir(join(basePath, '.spica', 'worktrees'));
    await execa('git', ['worktree', 'add', worktreePath, '-b', branchName], {
      cwd: basePath,
      timeout: 10000,
      reject: true,
    });

    return { worktreePath, branchName };
  } catch {
    // Not a git repo, or worktree creation failed — fall back to normal mode
    return null;
  }
}

/** Check if a worktree has uncommitted changes and commit them. */
async function commitWorktreeChanges(
  basePath: string,
  handle: WorktreeHandle,
  taskLabel: string
): Promise<boolean> {
  try {
    const status = await execa('git', ['status', '--porcelain'], {
      cwd: handle.worktreePath,
      timeout: 5000,
      reject: false,
    });

    if (!status.stdout.trim()) return false; // No changes

    await execa('git', ['add', '-A'], { cwd: handle.worktreePath, timeout: 5000 });
    await execa('git', ['commit', '-m', `subagent(${taskLabel}): isolated worktree changes`], {
      cwd: handle.worktreePath,
      timeout: 10000,
      reject: false,
    });

    // Merge back to the original branch
    const originalBranch = await execa('git', ['branch', '--show-current'], {
      cwd: basePath,
      timeout: 5000,
      reject: false,
    });
    if (originalBranch.stdout.trim()) {
      await execa('git', ['merge', '--no-ff', handle.branchName, '-m',
        `merge: subagent changes from ${handle.branchName}`], {
        cwd: basePath,
        timeout: 15000,
        reject: false,
      });
    }

    return true;
  } catch {
    return false;
  }
}

/** Remove a worktree and its branch. */
async function cleanupWorktree(basePath: string, handle: WorktreeHandle): Promise<void> {
  try {
    // Remove the worktree directory
    await execa('git', ['worktree', 'remove', handle.worktreePath, '--force'], {
      cwd: basePath,
      timeout: 10000,
      reject: false,
    });
    // Delete the branch
    await execa('git', ['branch', '-D', handle.branchName], {
      cwd: basePath,
      timeout: 5000,
      reject: false,
    });
  } catch {
    // Best-effort cleanup — if it fails, the worktree stays on disk
  }
}

// ── Background execution path ──────────────────────────────────────

async function executeTaskBackground(
  tasks: SubAgentTask[],
  externalSignal: AbortSignal | undefined,
  eventCallback: ToolEventCallback
): Promise<ToolResult> {
  const taskIds: string[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const subTaskId = `bg-${i}-${Date.now().toString(36)}`;
    taskIds.push(subTaskId);

    // Fire each background task
    runBackgroundSubagent(subTaskId, task, i, externalSignal, eventCallback);
  }

  return {
    success: true,
    output: `Dispatched ${tasks.length} background subagent(s): ${taskIds.join(', ')}`,
  };
}

async function runBackgroundSubagent(
  subTaskId: string,
  task: SubAgentTask,
  taskIndex: number,
  externalSignal: AbortSignal | undefined,
  eventCallback: ToolEventCallback
): Promise<void> {
  const config = getSubAgentConfig(task.type);
  const taskLabel = task.description || task.prompt.slice(0, 30);
  const taskWorkspace = WORKSPACE;

  let abortController: AbortController | null = null;

  // Register for external stop
  const cleanup = () => {
    backgroundTasks.delete(subTaskId);
    unregisterWaitingSubagent(subTaskId);
    if (abortController) abortController.abort();
  };
  backgroundTasks.set(subTaskId, { taskId: subTaskId, abort: cleanup });

  try {
    if (externalSignal?.aborted) {
      eventCallback('sub_agent_error', { id: subTaskId, error: 'Cancelled before start' });
      return;
    }

    // Emit start
    eventCallback('sub_agent_start', {
      id: subTaskId,
      type: task.type || 'sub',
      description: taskLabel,
      prompt: task.prompt,
    });

    const { SpicaAgent } = await import('../../agent');
    const { getRuntimeState } = await import('../../core/RuntimeState');
    const parentAgent = getRuntimeState().getAgent();

    abortController = new AbortController();

    if (externalSignal) {
      if (externalSignal.aborted) {
        eventCallback('sub_agent_error', { id: subTaskId, error: 'Parent interrupted' });
        return;
      }
      externalSignal.addEventListener('abort', () => abortController?.abort(), { once: true });
    }

    let currentPrompt = task.prompt;
    const MAX_QUESTIONS = 3;

    for (let round = 0; round <= MAX_QUESTIONS; round++) {
      if (abortController.signal.aborted) {
        eventCallback('sub_agent_error', { id: subTaskId, error: 'Aborted' });
        return;
      }

      const taskAgent = new SpicaAgent(undefined, taskWorkspace);

      if (config.allowedTools !== '*') {
        taskAgent.setToolWhitelist(config.allowedTools);
      }

      // Wire subagent events
      const forwardEvent = (event: string) => (data: any) => {
        eventCallback(event as any, { id: subTaskId, ...data });
      };
      taskAgent.on('tool_call', forwardEvent('sub_agent_tool_call'));
      taskAgent.on('tool_result', forwardEvent('sub_agent_tool_result'));
      taskAgent.on('message', forwardEvent('sub_agent_message'));
      taskAgent.on('reasoning', forwardEvent('sub_agent_reasoning'));
      taskAgent.on('stream', (data: any) => {
        eventCallback('sub_agent_stream', { id: subTaskId, chunk: data.chunk });
      });

      try {
        if (parentAgent) {
          await taskAgent.initAsSubAgent(parentAgent, task.model);
        } else {
          await taskAgent.init();
        }

        // Inject skill if specified
        if (task.skill) {
          const skill = getSkill(task.skill, taskWorkspace);
          if (skill) {
            const skillPrompt = buildSkillPrompt(skill, {});
            taskAgent.getLLM()?.addMessage({
              role: 'system',
              content: `[SKILL: ${task.skill}]\n\n${skillPrompt}`,
            });
          }
        }

        const retryNote = round > 0 ? '\n[CONTEXT] Previous answer: see above.' : '';
        const result = await taskAgent.runLoop(currentPrompt + retryNote);

        // runLoop returns string on interrupt, not throw. Check for it.
        if (result.includes('[INTERRUPTED]')) {
          taskAgent.dispose();
          eventCallback('sub_agent_error', { id: subTaskId, error: 'Interrupted by user' });
          return;
        }

        // Check if result indicates a question.
        // RELIABLE: explicit NEEDS_CONTEXT status or text ending with a question mark.
        // Unreliable (false positives): question-word at start without "?".
        const isQuestion =
          result.includes('NEEDS_CONTEXT') ||
          (result.includes('?') && result.trim().length < 500);

        if (isQuestion && round < MAX_QUESTIONS) {
          // Extract question from result
          const question = result.slice(0, 400);

          eventCallback('sub_agent_question', {
            id: subTaskId,
            question,
            label: taskLabel,
          });

          // Wait for reply (with abort safety — reject if aborted while waiting)
          const answer = await new Promise<string>((resolve, reject) => {
            registerWaitingSubagent(subTaskId, resolve);
            const onAbort = () => {
              unregisterWaitingSubagent(subTaskId);
              reject(new Error('Aborted while waiting for reply'));
            };
            abortController?.signal.addEventListener('abort', onAbort, { once: true });
          });

          if (abortController.signal.aborted) {
            eventCallback('sub_agent_error', { id: subTaskId, error: 'Aborted while waiting for reply' });
            return;
          }

          // Prep for next round with answer
          currentPrompt = `${task.prompt}\n\n[ANSWER TO YOUR QUESTION]\n${answer}\n\nContinue with the task using the answer above.`;
          taskAgent.dispose();
          continue;
        }

        // Done — success
        const summary = summarizeResult(result);
        taskAgent.dispose();

        eventCallback('sub_agent_done', {
          id: subTaskId,
          result,
          summary,
          status: 'DONE',
        });
        return;
      } catch (err: any) {
        taskAgent.interrupt();
        taskAgent.dispose();

        const errMsg = String(err.message || err);
        if (errMsg.includes('interrupt') || errMsg.includes('abort')) {
          eventCallback('sub_agent_error', { id: subTaskId, error: 'Interrupted' });
          return;
        }

        eventCallback('sub_agent_error', { id: subTaskId, error: errMsg });
        return;
      }
    }

    // Max questions exceeded
    eventCallback('sub_agent_error', {
      id: subTaskId,
      error: 'Max questions (3) exceeded — subagent could not resolve task',
    });
  } finally {
    cleanup();
  }
}

// ── Blocking execution path ─────────────────────────────────────────

export async function executeTask(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool arguments are dynamic
  args: Record<string, any>,
  eventCallback?: ToolEventCallback
): Promise<ToolResult> {
  const tasks = args.tasks as SubAgentTask[] | undefined;
  const externalSignal = args._abortSignal as AbortSignal | undefined;

  // Guard: LLM may omit tasks or pass a single object instead of an array
  if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
    return {
      success: false,
      error: 'No tasks provided. Pass an array of tasks with at least one { type, prompt } object.',
    };
  }

  // Limit: max 3 parallel tasks
  if (tasks.length > 3) {
    return {
      success: false,
      error: 'Maximum 3 parallel sub-agents supported. Split your tasks into multiple task() calls.',
    };
  }

  const blocking = args.blocking !== false; // default true

  // Non-blocking path: fire background tasks, return immediately
  if (!blocking && eventCallback) {
    return executeTaskBackground(tasks, externalSignal, eventCallback);
  }

  // Check for parallel implementation subagents (fix/build types)
  // Per subagent-driven-development skill: never dispatch multiple
  // implementation subagents in parallel to avoid git/file conflicts
  const implementationTypes = new Set(['fix', 'build']);
  const implTasks = tasks.filter(t => t.type && implementationTypes.has(t.type));
  if (implTasks.length > 1) {
    if (eventCallback) {
      eventCallback('sub_agent_warning', {
        message: `${implTasks.length} parallel implementation subagents detected. Consider running sequentially to avoid conflicts.`,
      });
    }
  }

  // Shared controller for early termination: when one subagent finds a
  // definitive answer, it signals siblings to stop (saves tokens).
  const siblingAbortController = new AbortController();
  let earlyExitTriggered = false;

  const results: TaskResult[] = await Promise.all(
    tasks.map(async (task, i): Promise<TaskResult> => {
      const subTaskId = `sub-${i}-${Date.now()}`;
      const config = getSubAgentConfig(task.type);
      const taskLabel = task.description || task.prompt.slice(0, 30);

      // 发送子agent启动事件
      if (eventCallback) {
        eventCallback('sub_agent_start', {
          id: subTaskId,
          type: task.type,
          description: taskLabel,
        });
      }

      // 动态导入避免循环依赖
      const { SpicaAgent } = await import('../../agent');
      const { getRuntimeState } = await import('../../core/RuntimeState');
      const parentAgent = getRuntimeState().getAgent();

      // Determine if error is retryable (timeout, network, transient)
      const isRetryableError = (errMsg: string): boolean => {
        const lower = errMsg.toLowerCase();
        if (lower.includes('interrupted') || lower.includes('parent agent')) return false;
        if (lower.includes('blocked by whitelist')) return false;
        if (lower.includes('authentication') || lower.includes('unauthorized')) return false;
        return (
          lower.includes('econnrefused') ||
          lower.includes('enotfound') ||
          lower.includes('etimedout') ||
          lower.includes('econnreset') ||
          lower.includes('network') ||
          lower.includes('rate limit') ||
          lower.includes('429') ||
          lower.includes('500') ||
          lower.includes('502') ||
          lower.includes('503')
        );
      };

      const MAX_RETRIES = 2;
      let lastError: string = 'Unknown error';

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        // Check parent interrupt and sibling early-exit before each attempt
        if (externalSignal?.aborted) {
          return { status: 'BLOCKED', taskLabel, error: 'Parent agent interrupted' };
        }
        if (siblingAbortController.signal.aborted) {
          return { status: 'BLOCKED', taskLabel, error: 'Early exit — sibling subagent already solved the task' };
        }

        // Worktree isolation: create an isolated git worktree for this sub-agent.
        // Prevents file conflicts between parallel fix/build sub-agents.
        let worktree: WorktreeHandle | null = null;
        const useIsolation = task.isolation === 'worktree';
        const taskWorkspace = WORKSPACE;

        if (useIsolation) {
          worktree = await createWorktree(taskWorkspace, i);
          if (worktree && eventCallback) {
            eventCallback('sub_agent_warning', {
              message: `Isolated worktree: ${worktree.worktreePath}`,
            });
          }
        }

        const taskAgent = new SpicaAgent(
          undefined,
          worktree?.worktreePath || taskWorkspace
        );

        // 设置工具白名单（限制subagent权限，避免context pollution）
        if (config.allowedTools !== '*') {
          taskAgent.setToolWhitelist(config.allowedTools);
        }

        // 监听器引用，用于清理
        const toolCallHandler = (data: any) => {
          if (eventCallback) {
            eventCallback('sub_agent_tool_call', { id: subTaskId, ...data });
          }
        };
        const toolResultHandler = (data: any) => {
          if (eventCallback) {
            eventCallback('sub_agent_tool_result', { id: subTaskId, ...data });
          }
        };
        const messageHandler = (data: any) => {
          if (eventCallback) {
            eventCallback('sub_agent_message', { id: subTaskId, ...data });
          }
        };
        const reasoningHandler = (data: any) => {
          if (eventCallback) {
            eventCallback('sub_agent_reasoning', { id: subTaskId, ...data });
          }
        };
        const streamHandler = (data: any) => {
          if (eventCallback) {
            eventCallback('sub_agent_stream', { id: subTaskId, chunk: data.chunk });
          }
        };
        taskAgent.on('tool_call', toolCallHandler);
        taskAgent.on('tool_result', toolResultHandler);
        taskAgent.on('message', messageHandler);
        taskAgent.on('reasoning', reasoningHandler);
        taskAgent.on('stream', streamHandler);

        // 监听外部中断信号（父 agent 中断）和 sibling early-exit
        // 没有子代理超时 — 子代理可以无限运行直到自然完成或被外部中断
        let abortHandler: (() => void) | null = null;
        let siblingAbortHandler: (() => void) | null = null;
        if (externalSignal) {
          if (externalSignal.aborted) {
            taskAgent.off('tool_call', toolCallHandler);
            taskAgent.off('tool_result', toolResultHandler);
            taskAgent.off('message', messageHandler);
            taskAgent.off('reasoning', reasoningHandler);
            taskAgent.off('stream', streamHandler);
            taskAgent.interrupt();
            taskAgent.dispose();
            return { status: 'BLOCKED', taskLabel, error: 'Parent agent interrupted' };
          }
          abortHandler = () => {
            externalSignal.removeEventListener('abort', abortHandler!);
            taskAgent.interrupt();
          };
          externalSignal.addEventListener('abort', abortHandler);
        }
        // Listen for sibling early-exit
        if (!siblingAbortController.signal.aborted) {
          siblingAbortHandler = () => {
            siblingAbortController.signal.removeEventListener('abort', siblingAbortHandler!);
            taskAgent.interrupt();
          };
          siblingAbortController.signal.addEventListener('abort', siblingAbortHandler);
        } else {
          taskAgent.off('tool_call', toolCallHandler);
          taskAgent.off('tool_result', toolResultHandler);
          taskAgent.off('message', messageHandler);
          taskAgent.off('reasoning', reasoningHandler);
          taskAgent.off('stream', streamHandler);
          taskAgent.interrupt();
          taskAgent.dispose();
          return { status: 'BLOCKED', taskLabel, error: 'Early exit — sibling subagent already solved the task' };
        }

        try {
          // Use lightweight sub-agent init with optional model override
          if (parentAgent) {
            await taskAgent.initAsSubAgent(parentAgent, task.model);
          } else {
            await taskAgent.init();
          }

          // Inject skill if specified — load skill prompt into subagent context
          if (task.skill) {
            const skill = getSkill(task.skill, taskWorkspace);
            if (skill) {
              const skillPrompt = buildSkillPrompt(skill, {});
              taskAgent.getLLM()?.addMessage({
                role: 'system',
                content: `[SKILL: ${task.skill}]\n\n${skillPrompt}`,
              });
            }
          }

          const retryNote =
            attempt > 0
              ? '\n[RETRY] Previous attempt failed. Please try a different approach.'
              : '';

          const result = await taskAgent.runLoop(task.prompt + retryNote);

          // runLoop returns string on interrupt, not throw. Check for it.
          if (result.includes('[INTERRUPTED]')) {
            taskAgent.off('tool_call', toolCallHandler);
            taskAgent.off('tool_result', toolResultHandler);
            taskAgent.off('message', messageHandler);
            taskAgent.off('reasoning', reasoningHandler);
            taskAgent.off('stream', streamHandler);
            if (abortHandler && externalSignal) {
              externalSignal.removeEventListener('abort', abortHandler);
            }
            if (siblingAbortHandler) {
              siblingAbortController.signal.removeEventListener('abort', siblingAbortHandler);
            }
            taskAgent.interrupt();
            taskAgent.dispose();
            return { status: 'BLOCKED', taskLabel, error: 'Interrupted by user' };
          }

          // Success — cleanup and return
          taskAgent.off('tool_call', toolCallHandler);
          taskAgent.off('tool_result', toolResultHandler);
          taskAgent.off('message', messageHandler);
          taskAgent.off('reasoning', reasoningHandler);
          taskAgent.off('stream', streamHandler);
          if (abortHandler && externalSignal) {
            externalSignal.removeEventListener('abort', abortHandler);
          }
          if (siblingAbortHandler) {
            siblingAbortController.signal.removeEventListener('abort', siblingAbortHandler);
          }
          taskAgent.dispose();

          // Worktree cleanup: commit changes and merge back
          if (worktree) {
            try {
              await commitWorktreeChanges(taskWorkspace, worktree, taskLabel);
            } catch {
              // Non-fatal — changes stay in the worktree
            }
            await cleanupWorktree(taskWorkspace, worktree);
          }

          // Truncate raw result before summarization
          const MAX_RAW_RESULT = 3000;
          const truncatedResult =
            result.length > MAX_RAW_RESULT
              ? result.slice(0, MAX_RAW_RESULT) + '\n...[truncated]'
              : result;
          const summary = summarizeResult(truncatedResult);

          // Check if this result is definitive — if so, signal siblings to stop early
          if (!earlyExitTriggered && tasks.length > 1) {
            const definitiveMarkers = [
              /success/i,
              /done/i,
              /complete/i,
              /fixed/i,
              /resolved/i,
              /implemented/i,
              /found .* (bug|issue|problem)/i,
              /build .*(pass|success)/i,
            ];
            const isDefinitive =
              definitiveMarkers.some(p => p.test(summary)) &&
              !/couldn't|unable to|cannot find|no results/i.test(summary);
            if (isDefinitive) {
              earlyExitTriggered = true;
              siblingAbortController.abort();
              if (eventCallback) {
                eventCallback('sub_agent_early_exit', {
                  id: subTaskId,
                  reason: 'Definitive result found',
                });
              }
            }
          }

          // Determine status: DONE or DONE_WITH_CONCERNS
          const hasConcerns =
            /however|but|note:|warning|concern/i.test(summary);
          const status = hasConcerns ? 'DONE_WITH_CONCERNS' : 'DONE';

          if (eventCallback) {
            eventCallback('sub_agent_done', { id: subTaskId, summary, status });
          }

          return { status, taskLabel, summary };
        } catch (err: any) {
          // Cleanup
          taskAgent.off('tool_call', toolCallHandler);
          taskAgent.off('tool_result', toolResultHandler);
          taskAgent.off('message', messageHandler);
          taskAgent.off('reasoning', reasoningHandler);
          taskAgent.off('stream', streamHandler);
          if (abortHandler && externalSignal) {
            externalSignal.removeEventListener('abort', abortHandler);
          }
          if (siblingAbortHandler) {
            siblingAbortController.signal.removeEventListener('abort', siblingAbortHandler);
          }
          taskAgent.interrupt();
          taskAgent.dispose();

          // Clean up worktree on error (don't merge — changes may be broken)
          if (worktree) {
            await cleanupWorktree(taskWorkspace, worktree);
          }

          lastError = String(err.message || err || 'Unknown error');

          // Check if we should retry
          if (
            attempt < MAX_RETRIES &&
            isRetryableError(lastError) &&
            !externalSignal?.aborted
          ) {
            if (eventCallback) {
              eventCallback('sub_agent_retry', {
                id: subTaskId,
                attempt: attempt + 1,
                error: lastError,
              });
            }
            continue; // Retry
          }

          // Final failure
          if (eventCallback) {
            eventCallback('sub_agent_error', { id: subTaskId, error: lastError });
          }
          return { status: 'BLOCKED', taskLabel, error: lastError };
        }
      }

      // Should not reach here, but just in case
      return { status: 'BLOCKED', taskLabel, error: lastError };
    })
  );

  // 分析结果，检测失败 (uses structured TaskResult objects)
  const failedTasks = results.filter(r => r.status === 'BLOCKED');
  const successTasks = results.filter(r => r.status !== 'BLOCKED');

  // Format results with SubAgentResult status codes
  const MAX_TOTAL_OUTPUT = 4000;
  const formattedResults = results.map(r => {
    const statusTag = `[${r.status}]`;
    const detail = r.status === 'BLOCKED'
      ? (r.error || 'Unknown error')
      : (r.summary || 'done');
    return `${statusTag} ${r.taskLabel}: ${detail}`;
  });
  let output = formattedResults.join('\n');
  const warningSuffix =
    failedTasks.length > 0
      ? `\n\n[WARNING] ${failedTasks.length}/${results.length} subagent(s) failed. Retry failed tasks or handle directly.`
      : '';

  if (output.length + warningSuffix.length > MAX_TOTAL_OUTPUT) {
    const availablePerResult = Math.floor(
      (MAX_TOTAL_OUTPUT - warningSuffix.length) / formattedResults.length
    );
    output = formattedResults
      .map(r => (r.length > availablePerResult ? r.slice(0, availablePerResult) + '...' : r))
      .join('\n');
  }
  output += warningSuffix;

  if (failedTasks.length > 0) {
    return {
      success: successTasks.length > 0,
      output,
      error: `${failedTasks.length} subagent(s) failed`,
    };
  }

  return { success: true, output };
}
