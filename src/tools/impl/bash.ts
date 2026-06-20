import fs from 'fs-extra';
import { execa } from 'execa';
import { resolve as pathResolve } from 'path';
import { getBashPath, getBashOrFallback } from '../../utils/platform';
import { prepareSandbox } from '../sandbox';
import {
  isWindows,
  WORKSPACE,
  activeMonitors,
  linkAbortSignals,
} from '../helpers';
import type { ToolResult, ToolEventCallback } from '../helpers';
import { stopBackgroundTask, getBackgroundTaskIds } from './task';

// 跨平台进程树杀死: Windows taskkill /F /T, Unix SIGKILL to process group
async function killProcessTree(pid: number): Promise<void> {
  if (isWindows) {
    await execa('taskkill', ['/F', '/T', '/PID', String(pid)], {
      timeout: 5000,
      reject: false,
    });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
}

export async function executeBash(
  args: Record<string, any>,
  eventCallback?: ToolEventCallback
): Promise<ToolResult> {
  const safeArgs = args;
  const command = String(safeArgs.command || '');
  if (!command) {
    return { success: false, error: 'Command is required' };
  }
  const timeout = safeArgs.timeout ? safeArgs.timeout * 1000 : 120000;
  const detached = safeArgs.detached === true;
  const interactive = safeArgs.interactive === true;
  const maxOutputLength = (safeArgs.maxOutputLength as number) || 50000;
  let inputs = (safeArgs.inputs as string[]) || [];
  const inputFile = safeArgs.inputFile as string;
  const outputFile = safeArgs.outputFile as string;

  // Bypass 模式：跳过 shell injection 检测（用户明确信任）
  const bypassMode = safeArgs._bypassMode === true;

  // 卡住检测阈值（默认10秒，比之前的30秒更快响应）
  const stuckWarningMs = (safeArgs.stuckWarning as number) || 10000;

  // Shell 注入检测 — 只检测真正危险的模式，允许常用操作符 (; && || ${} <<)
  // 注意：bypassPermissions 设置已跳过此检查，此代码为历史遗留，未来可移除
  if (!bypassMode) {
    const dangerousPatterns = [
      // 网络连接 - 真正危险
      { pattern: /\/dev\/tcp\//, name: 'bash network connection' },
      { pattern: /\bnc\s+-[el]/, name: 'netcat listener' },
      { pattern: /mkfifo/, name: 'named pipe creation' },
      // 管道到 shell 解释器 - 可能被利用
      {
        pattern: /\|\s*(bash|sh|zsh|python|perl|ruby)\b/,
        name: 'piping to shell interpreter',
      },
      // eval - 极危险
      { pattern: /\beval\b/, name: 'eval command' },
      // 嵌套命令替换 - 需谨慎但允许简单使用
      // { pattern: /\$\(/, name: 'command substitution $(...)' },  // 允许
      // { pattern: /`[^`]+`/, name: 'backtick command substitution' }, // 允许
    ];
    for (const { pattern, name } of dangerousPatterns) {
      if (pattern.test(command)) {
        return {
          success: false,
          error: `Blocked: command contains ${name}. This pattern is not allowed for security reasons.`,
        };
      }
    }
  }

  try {
    // Read inputs from file if provided
    if (inputFile) {
      const inputPath = pathResolve(WORKSPACE, inputFile);
      if (!fs.existsSync(inputPath)) {
        return { success: false, error: `Input file not found: ${inputFile}` };
      }
      const fileContent = await fs.readFile(inputPath, 'utf-8');
      // Split by lines, each line is one input
      inputs = fileContent.split('\n').filter(line => line.length > 0);
    }

    // 交互式 PTY 模式：AI 可以输入/输出
    if (interactive) {
      const expect = (safeArgs.expect as Array<{ wait: string; input: string }>) || [];
      return await runInteractivePty(
        command,
        WORKSPACE,
        timeout,
        inputs,
        expect,
        maxOutputLength,
        outputFile,
        eventCallback
      );
    }

    // Sandbox: wrap command in bwrap if sandbox:true
    const useSandbox = safeArgs.sandbox === true;
    let sandboxWarning: string | undefined;
    if (useSandbox && !detached && !interactive) {
      const sandboxResult = await prepareSandbox(command, true, WORKSPACE);
      if (sandboxResult.sandboxed) {
        // Will execute inside bwrap — replace command
        safeArgs._sandboxedCommand = sandboxResult.command;
      } else if (sandboxResult.warning) {
        sandboxWarning = sandboxResult.warning;
      }
    }

    // 分离模式：使用 tmux 运行（用户可 attach 查看）
    if (detached) {
      if (isWindows) {
        // Windows: 使用 PowerShell 启动后台进程并获取 PID
        const sessionId = `spica_${Date.now()}`;
        const psCommand = `
$proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c ${command.replace(/"/g, '""')}" -WindowStyle Hidden -PassThru;
Write-Output $proc.Id;
`;
        try {
          const result = await execa('powershell', ['-Command', psCommand], {
            cwd: WORKSPACE,
            timeout: 10000,
            reject: false,
          });
          const pid = result.stdout.trim();
          return {
            success: true,
            output: `Started in detached mode (Windows).\nSession: ${sessionId}\nPID: ${pid || 'unknown'}\nCommand: ${command}\n\nTo monitor: Task Manager or PowerShell "Get-Process -Id ${pid}"\nTo kill: taskkill /PID ${pid} /F`,
          };
        } catch {
          // Fallback: 使用 start /B
          const escapedCmd = command.replace(/"/g, '\\"');
          await execa(`start /B cmd /c "${escapedCmd}"`, {
            shell: true,
            cwd: WORKSPACE,
            timeout: 5000,
            reject: false,
          });
          return {
            success: true,
            output: `Started in detached mode (Windows background).\nCommand: ${command}\n\nNote: Process runs in background. Use Task Manager to monitor.`,
          };
        }
      }

      const sessionId = `spica_${Date.now()}`;
      const escapedCommand = command.replace(/'/g, "'\\''");

      const actualCommand = `tmux new-session -d -s ${sessionId} '${escapedCommand}' 2>/dev/null || screen -dmS ${sessionId} ${escapedCommand} 2>/dev/null || (${escapedCommand} &)`;

      await execa(actualCommand, {
        shell: true,
        cwd: WORKSPACE,
        timeout: 5000,
        reject: false,
      });

      return {
        success: true,
        output: `Started in detached mode.\nSession: ${sessionId}\n\nTo view:\n  tmux attach -t ${sessionId}\n  # or: screen -r ${sessionId}\n\nTo kill:\n  tmux kill-session -t ${sessionId}\n  # or: screen -S ${sessionId} -X quit`,
      };
    }

    // Use sandboxed command if sandbox was applied
    const actualCommand = safeArgs._sandboxedCommand || command;

    // 在 Windows 上优先使用 Git Bash（支持 head/grep/管道等 Unix 命令）
    const bashShellInfo = getBashOrFallback();

    // 链接外部 abort signal（自动清理，防止 listener 累积）
    const externalSignal = safeArgs._abortSignal as AbortSignal | undefined;
    const abortController = new AbortController();
    const cleanupAbortLink = linkAbortSignals(externalSignal, abortController);

    // === 卡住检测和强制终止机制 ===
    // 关键修复：先启动进程，确保 pid 就绪，再设置 timer 和 abort listener
    let stuckWarningSent = false;
    let progressTimer: NodeJS.Timeout | null = null;
    const startTime = Date.now();

    // 先启动进程（detached: true 创建进程组）
    // execa 的 pid 属性在进程启动后立即可用
    const bashProcess = execa(actualCommand, {
      shell: bashShellInfo.shell,
      shellArgs: bashShellInfo.args,
      cwd: WORKSPACE,
      timeout: timeout,
      reject: false,
      cancelSignal: abortController.signal,
      detached: !isWindows, // Windows: detached breaks stdout for external commands; Unix: process group for killProcessTree
    });

    // 进程启动后，pid 立即可用，现在设置 timer
    const stuckWarningTimer = setTimeout(() => {
      if (!stuckWarningSent) {
        stuckWarningSent = true;

        // 立即发送事件通知用户和 agent
        eventCallback?.('tool_stuck_warning', {
          tool: 'bash',
          command: actualCommand.slice(0, 50),
          timeout: stuckWarningMs / 1000,
          elapsedMs: stuckWarningMs,
          message: `Command stuck after ${stuckWarningMs / 1000}s, forcing termination...`,
        });

        abortController.abort();

        // 强制杀死进程树
        if (bashProcess.pid) {
          killProcessTree(bashProcess.pid);
        }
      }
    }, stuckWarningMs);

    // Critical: actively check abort status (every 200ms)
    // execa's cancelSignal doesn't take effect immediately for no-output commands
    // We need to actively check and kill the process group
    const abortCheckInterval = setInterval(() => {
      if (abortController.signal.aborted && bashProcess.pid) {
        clearInterval(abortCheckInterval);
        killProcessTree(bashProcess.pid);
      }
    }, 200);

    // 进度报告定时器（降低阈值，让用户看到进度）
    if (eventCallback) {
      progressTimer = setInterval(() => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        eventCallback('tool_progress', { elapsed, command: actualCommand.slice(0, 50) });
      }, 5000);
    }

    try {
      // 执行命令，等待结果
      const bashResult = await bashProcess;

      // 清除定时器（正常完成）
      clearTimeout(stuckWarningTimer);
      clearInterval(abortCheckInterval);
      if (progressTimer) clearInterval(progressTimer);
      // 清理 abort link
      cleanupAbortLink();

      // 检查是否超时或被中断
      if (bashResult.timedOut || abortController.signal.aborted) {
        // 返回错误给AI，让AI决定下一步
        if (abortController.signal.aborted && !bashResult.timedOut) {
          return {
            success: false,
            error: 'Command aborted by user (ESC ESC).',
          };
        }
        return {
          success: false,
          error: `Command timed out after ${timeout / 1000}s. AI should decide: retry with detached=true, increase timeout, or use different approach.`,
        };
      }
      // 合并stdout和stderr显示完整输出
      const fullOutput = (bashResult.stdout + '\n' + bashResult.stderr).trim();
      // 截断超长输出（防止内存溢出）
      const truncateOutput = (text: string, maxLen: number): string => {
        if (text.length <= maxLen) return text;
        return text.slice(0, maxLen) + `\n... [truncated, total ${text.length} chars]`;
      };
      const output = truncateOutput(fullOutput, maxOutputLength);

      // Write output to file if provided
      if (outputFile) {
        const outputPath = pathResolve(WORKSPACE, outputFile);
        await fs.writeFile(outputPath, fullOutput, 'utf-8');
        return {
          success: bashResult.exitCode === 0,
          output: `Output written to ${outputFile} (${fullOutput.length} chars)`,
          error: bashResult.exitCode !== 0 ? output : undefined,
        };
      }

      const sandboxNote = sandboxWarning ? `\n⚠ ${sandboxWarning}` : '';
      const sandboxTag = useSandbox && !sandboxWarning ? ' [sandboxed]' : '';

      return {
        success: bashResult.exitCode === 0,
        output: bashResult.exitCode === 0 ? output + sandboxNote + sandboxTag : undefined,
        error: bashResult.exitCode !== 0 ? output : undefined,
      };
    } catch (bashError: any) {
      // 清除定时器
      clearTimeout(stuckWarningTimer);
      clearInterval(abortCheckInterval);
      if (progressTimer) clearInterval(progressTimer);
      // 清理 abort link
      cleanupAbortLink();

      // 用户主动中断：立即 kill 进程组并返回
      if (abortController.signal.aborted) {
        // Kill entire process tree
        if (bashProcess.pid) {
          killProcessTree(bashProcess.pid);
        }
        return {
          success: false,
          error: 'Command aborted by user (ESC ESC).',
        };
      }

      // 检查是否是被强制杀死（卡住检测触发）
      const wasKilled =
        bashError.message?.includes('SIGKILL') ||
        bashError.message?.includes('killed') ||
        bashError.message?.includes('terminated') ||
        bashError.isCanceled;

      if (wasKilled) {
        // 返回错误给AI，让AI决定下一步
        return {
          success: false,
          error: `Command stuck after ${stuckWarningMs / 1000}s and was killed. AI should decide: retry with detached=true, increase timeout, or use different approach.`,
        };
      }

      // 其他错误
      return { success: false, error: bashError.message };
    }
  } catch (outerError: any) {
    return { success: false, error: outerError.message };
  }
}

export async function executeMonitor(
  args: Record<string, any>,
  eventCallback?: ToolEventCallback
): Promise<ToolResult> {
  const safeArgs = args;
  const command = safeArgs.command as string;
  const description = (safeArgs.description as string) || 'Monitoring';
  const timeoutMs = safeArgs.persistent
    ? 3600000
    : Math.min((safeArgs.timeout || 300) * 1000, 3600000);
  const persistent = safeArgs.persistent === true;

  // 生成任务 ID
  const taskId = `monitor_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  // 使用 spawn 运行命令，持续监控输出
  const { spawn } = await import('child_process');
  const monitorProcess = spawn(command, [], {
    shell: true,
    cwd: WORKSPACE,
    detached: false,
  });

  // 存储活动监控任务（用于 task_stop）
  activeMonitors.set(taskId, {
    process: monitorProcess,
    command,
    description,
    startTime: Date.now(),
  });

  let outputLines: string[] = [];
  let resolved = false;

  // 处理 stdout - 每行作为事件发送
  monitorProcess.stdout?.on('data', (data: Buffer) => {
    const lines = data
      .toString('utf-8')
      .split('\n')
      .filter(l => l.trim());
    for (const line of lines) {
      outputLines.push(line);
      // 发送监控事件
      eventCallback?.('monitor_event', {
        task_id: taskId,
        description,
        line,
        timestamp: Date.now(),
      });
    }
  });

  // 处理 stderr
  monitorProcess.stderr?.on('data', (data: Buffer) => {
    const lines = data
      .toString('utf-8')
      .split('\n')
      .filter(l => l.trim());
    for (const line of lines) {
      outputLines.push(`[stderr] ${line}`);
      eventCallback?.('monitor_event', {
        task_id: taskId,
        description,
        line: `[stderr] ${line}`,
        timestamp: Date.now(),
      });
    }
  });

  // 设置超时
  const timeoutId = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      monitorProcess.kill();
      activeMonitors?.delete(taskId);
    }
  }, timeoutMs);

  // 进程结束
  monitorProcess.on('close', code => {
    if (!resolved) {
      resolved = true;
      clearTimeout(timeoutId);
      activeMonitors?.delete(taskId);
    }
  });

  // 进程错误
  monitorProcess.on('error', err => {
    if (!resolved) {
      resolved = true;
      clearTimeout(timeoutId);
      activeMonitors?.delete(taskId);
      eventCallback?.('monitor_error', {
        task_id: taskId,
        error: err.message,
      });
    }
  });

  // 立即返回任务 ID（监控在后台继续）
  return {
    success: true,
    output: `Monitor started (task_id: ${taskId})\nDescription: ${description}\nCommand: ${command}\nTimeout: ${timeoutMs / 1000}s\nPersistent: ${persistent}\n\nTo stop: task_stop({ task_id: "${taskId}" })`,
    content: taskId, // 返回 task_id 方便后续操作
  };
}

export async function executeTaskStop(args: Record<string, any>): Promise<ToolResult> {
  const safeArgs = args;
  const taskId = safeArgs.task_id as string;

  // Check background subagents first
  if (stopBackgroundTask(taskId)) {
    return { success: true, output: `Background subagent stopped: ${taskId}` };
  }

  if (!activeMonitors.has(taskId)) {
    const bgIds = getBackgroundTaskIds();
    const allIds = [...Array.from(activeMonitors.keys()), ...bgIds];
    return {
      success: false,
      error: `Task not found: ${taskId}. Active tasks: ${allIds.join(', ') || 'none'}`,
    };
  }

  const monitorInfo = activeMonitors.get(taskId)!;
  monitorInfo.process.kill();
  activeMonitors.delete(taskId);

  return {
    success: true,
    output: `Task stopped: ${taskId}\nDescription: ${monitorInfo.description}\nRan for: ${Math.round((Date.now() - monitorInfo.startTime) / 1000)}s`,
  };
}

async function runInteractivePty(
  command: string,
  cwd: string,
  timeout: number,
  inputs: string[],
  expect: Array<{ wait: string; input: string }>,
  maxOutputLength: number,
  outputFile?: string,
  eventCallback?: (event: string, data: any) => void
): Promise<ToolResult> {
  let pty: typeof import('node-pty');
  try {
    pty = await import('node-pty');
  } catch {
    return {
      success: false,
      error:
        'node-pty not available. Install with: npm install node-pty (requires native build tools).',
    };
  }

  return new Promise(resolve => {
    // 创建 PTY（通过 shell 执行，支持 cd、&& 等语法）
    const bashPath = getBashPath();
    const shell = bashPath || (isWindows ? process.env.COMSPEC || 'cmd.exe' : '/bin/bash');
    const shellArgs = bashPath ? ['-c', command] : isWindows ? ['/c', command] : ['-c', command];

    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-color',
      cols: 80,
      rows: 30,
      cwd: cwd,
      env: process.env as { [key: string]: string },
    });

    let output = '';
    let inputIndex = 0;
    let expectIndex = 0;
    let resolved = false;

    // 监听输出（使用 onData）
    ptyProcess.onData((data: string) => {
      output += data;

      // 发送事件给 UI（实时显示）
      if (eventCallback) {
        eventCallback('pty_output', { data });
      }

      // 检查 expect 匹配
      if (expect.length > 0 && expectIndex < expect.length) {
        const currentExpect = expect[expectIndex];
        // 支持正则表达式匹配（如果 wait 以 ^ 开头）
        const isRegex = currentExpect.wait.startsWith('^');
        const matched = isRegex
          ? new RegExp(currentExpect.wait).test(output)
          : output.includes(currentExpect.wait);

        if (matched) {
          ptyProcess.write(currentExpect.input + '\n');
          expectIndex++;
        }
      }
    });

    // 监听结束（使用 onExit）
    ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
      if (!resolved) {
        resolved = true;
        // 等待确保所有输出被捕获（嵌套 shell 需要更长延迟）
        const delay = command.includes('bash') && command.includes('-c') ? 300 : 150;
        setTimeout(async () => {
          // 截断超长输出
          const truncateOutput = (text: string, maxLen: number): string => {
            if (text.length <= maxLen) return text;
            return text.slice(0, maxLen) + `\n... [truncated, total ${text.length} chars]`;
          };

          // Write to file if outputFile provided
          if (outputFile) {
            const outputPath = pathResolve(cwd, outputFile);
            await fs.writeFile(outputPath, output.trim(), 'utf-8');
            resolve({
              success: exitCode === 0,
              output: `Output written to ${outputFile} (${output.length} chars)`,
              error: exitCode !== 0 ? truncateOutput(output.trim(), maxOutputLength) : undefined,
            });
            return;
          }

          const finalOutput = truncateOutput(output.trim(), maxOutputLength);
          resolve({
            success: exitCode === 0,
            output: exitCode === 0 ? finalOutput : undefined,
            error: exitCode !== 0 ? finalOutput : undefined,
          });
        }, delay);
      }
    });

    // 发送预定义输入（按时间间隔，优化延迟）
    if (inputs.length > 0) {
      // 根据输入数量动态调整间隔（大量输入时更快）
      const inputDelay = inputs.length > 20 ? 50 : 200; // ms

      const sendInputs = () => {
        if (inputIndex < inputs.length && !resolved) {
          // 特殊处理：Ctrl+D 直接发送（不加换行）
          const input = inputs[inputIndex];
          if (input === '\x04') {
            ptyProcess.write('\x04');
          } else {
            ptyProcess.write(input + '\n');
          }
          inputIndex++;
          setTimeout(sendInputs, inputDelay);
        }
      };
      // 根据命令复杂度决定初始延迟
      const initialDelay = command.includes('cat') ? 500 : 1000;
      setTimeout(sendInputs, initialDelay);
    }

    // 超时处理
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ptyProcess.write('\x03'); // 发送 Ctrl+C
        // 等待一小段时间让进程清理
        setTimeout(() => {
          resolve({
            success: false,
            error: `Timeout after ${timeout / 1000}s\nOutput:\n${output.trim()}`,
          });
        }, 100);
      }
    }, timeout);
  });
}
