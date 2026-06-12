import fs from 'fs-extra';
import { execa } from 'execa';
import simpleGit from 'simple-git';
import { resolve as pathResolve, isAbsolute, dirname, join, basename } from 'path';
import fastGlob from 'fast-glob';
import { SubAgentTask, getSubAgentConfig, summarizeResult } from './subAgent';
import { computeDiff, formatDiff, generateEditDiff } from '../cli/ui/diff';
import { getMCPManager } from '../mcp/client';
import { getBashPath, getBashOrFallback } from '../utils/platform';
import type { Todo } from '../agent';
import type { PersistedTask } from '../storage/taskPersistence';
import { analyzeCodeHealth, formatCodeHealthResult } from './codeHealth';
import { analyzeTestQuality, formatTestQualityResult } from './testQuality';

// Shared utilities from helpers.ts
import {
  isWindows,
  WORKSPACE,
  activeMonitors,
  setWorkspace,
  getWorkspace,
  linkAbortSignals,
  resolvePath,
  detectProjectType,
  runSyntaxCheck,
  formatSyntaxResult,
  applyUnifiedPatch,
} from './helpers';
import type { ToolResult, ToolEventCallback } from './helpers';

import { mcpToolNameMap } from './registry';
import { executeWorkspace } from './impl/workspace';
import { executeDirectoryCreate, executeDirectoryList } from './impl/directory';
import { executeQuestion } from './impl/question';
import { executeTodoRead, executeTodoWrite } from './impl/todo';
import { executeSkill } from './impl/skill';
import { executeFileRead } from './impl/file_read';
import {
  executeFileExists,
  executeFileDelete,
  executeFileCopy,
  executeFileMove,
} from './impl/file_manage';
import { executeGlob } from './impl/glob';
import { executeGrep } from './impl/grep';
import { executeWebSearch, executeWebFetch } from './impl/web';
import { executeLint, executeTest } from './impl/lint_test';

export async function executeTool(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool arguments are dynamic
  args: Record<string, any>,
  eventCallback?: ToolEventCallback
): Promise<ToolResult> {
  // 保护 args 参数，确保不为 undefined
  const safeArgs = args || {};

  // Backward-compatible aliases for renamed tools (file_read→read, file_write→write, file_edit→edit)
  const TOOL_ALIASES: Record<string, string> = {
    'file_read': 'read',
    'file_write': 'write',
    'file_edit': 'edit',
  };
  name = TOOL_ALIASES[name] || name;

  try {
    switch (name) {
      case 'workspace':
        return await executeWorkspace(safeArgs);

      case 'read':
        return await executeFileRead(safeArgs);

      case 'write': {
        const writePath = resolvePath(safeArgs.path);
        await fs.ensureDir(dirname(writePath));

        // 备份旧文件（如果存在）到 .spica/backups/
        let oldContentForBackup = '';
        try {
          oldContentForBackup = await fs.readFile(writePath, 'utf-8');
          if (oldContentForBackup !== safeArgs.content) {
            const backupDir = join(WORKSPACE, '.spica', 'backups');
            await fs.ensureDir(backupDir);
            const timestamp = Date.now();
            const safeName = safeArgs.path.replace(/[/\\]/g, '_');
            const backupPath = join(backupDir, `${timestamp}-${safeName}`);
            await fs.writeFile(backupPath, oldContentForBackup, 'utf-8');
          }
        } catch {
          // 新文件，无需备份
        }

        // 读取旧内容（如果存在）生成实际diff
        let diff = '';
        try {
          if (oldContentForBackup) {
            if (oldContentForBackup !== safeArgs.content) {
              const diffLines = computeDiff(oldContentForBackup, safeArgs.content);
              diff = formatDiff(diffLines, 3);
            }
          } else {
            const diffLines = computeDiff('', safeArgs.content);
            diff = formatDiff(diffLines, 2);
          }
        } catch {
          const diffLines = computeDiff('', safeArgs.content);
          diff = formatDiff(diffLines, 2);
        }

        await fs.writeFile(writePath, safeArgs.content, 'utf-8');

        // 自动语法检查
        const syntaxResult = await runSyntaxCheck(writePath);
        const syntaxWarning = formatSyntaxResult(syntaxResult, writePath);

        return {
          success: true,
          output: `Wrote ${writePath}${syntaxWarning}`,
          diff,
          syntaxErrors: syntaxResult.hasErrors ? syntaxResult.errors : undefined,
        };
      }

      case 'edit': {
        const editPath = resolvePath(safeArgs.path);
        const fileContent = await fs.readFile(editPath, 'utf-8');

        const oldStr = String(safeArgs.oldString || '');
        const newStr = String(safeArgs.newString || '');

        if (!fileContent.includes(oldStr)) {
          return {
            success: false,
            error: `Text not found in file. Read the file to get exact text.`,
          };
        }

        const newContent = fileContent.replace(oldStr, newStr);
        const diff = generateEditDiff(oldStr, newStr);

        await fs.writeFile(editPath, newContent, 'utf-8');

        // 自动语法检查
        const syntaxResult = await runSyntaxCheck(editPath);
        const syntaxWarning = formatSyntaxResult(syntaxResult, editPath);

        return {
          success: true,
          output: `Edited ${editPath}${syntaxWarning}`,
          diff,
          syntaxErrors: syntaxResult.hasErrors ? syntaxResult.errors : undefined,
        };
      }

      case 'file_multi_edit': {
        const editPath = resolvePath(safeArgs.path);
        const fileContent = await fs.readFile(editPath, 'utf-8');
        const edits = safeArgs.edits || [];

        let newContent = fileContent;
        const diffs: string[] = [];
        let editCount = 0;

        for (const edit of edits) {
          const oldStr = String(edit.oldString || '');
          const newStr = String(edit.newString || '');

          if (!newContent.includes(oldStr)) {
            return { success: false, error: `Text not found: "${oldStr.slice(0, 30)}..."` };
          }

          newContent = newContent.replace(oldStr, newStr);
          diffs.push(generateEditDiff(oldStr, newStr));
          editCount++;
        }

        await fs.writeFile(editPath, newContent, 'utf-8');

        // 自动语法检查
        const syntaxResult = await runSyntaxCheck(editPath);
        const syntaxWarning = formatSyntaxResult(syntaxResult, editPath);

        return {
          success: true,
          output: `Edited ${editPath} (${editCount} changes)${syntaxWarning}`,
          diff: diffs.join('\n---\n'),
          syntaxErrors: syntaxResult.hasErrors ? syntaxResult.errors : undefined,
        };
      }

      case 'file_patch': {
        const patchPath = resolvePath(safeArgs.path);
        const patchText = String(safeArgs.patch || '');
        if (!patchText) return { success: false, error: 'Patch content is required' };

        const originalContent = await fs.readFile(patchPath, 'utf-8');

        // 备份旧文件
        try {
          const backupDir = join(WORKSPACE, '.spica', 'backups');
          await fs.ensureDir(backupDir);
          const timestamp = Date.now();
          const safeName = safeArgs.path.replace(/[/\\]/g, '_');
          const backupPath = join(backupDir, `${timestamp}-${safeName}`);
          await fs.writeFile(backupPath, originalContent, 'utf-8');
        } catch {
          /* 新文件无需备份 */
        }

        const patchResult = applyUnifiedPatch(originalContent, patchText);
        if (!patchResult.success) {
          return { success: false, error: `Patch failed: ${patchResult.error}` };
        }

        await fs.writeFile(patchPath, patchResult.content!, 'utf-8');

        const patchDiff = computeDiff(originalContent, patchResult.content!);
        const patchDiffStr = formatDiff(patchDiff, 3);
        const patchSyntax = await runSyntaxCheck(patchPath);
        const patchSyntaxWarn = formatSyntaxResult(patchSyntax, patchPath);

        return {
          success: true,
          output: `Patched ${patchPath} (${patchResult.hunksApplied} hunks)${patchSyntaxWarn}`,
          diff: patchDiffStr,
          syntaxErrors: patchSyntax.hasErrors ? patchSyntax.errors : undefined,
        };
      }

      case 'file_replace': {
        const replacePath = resolvePath(safeArgs.path);
        const fileContent = await fs.readFile(replacePath, 'utf-8');

        const pattern = String(safeArgs.pattern);
        const replacement = String(safeArgs.replacement);
        const flags = String(safeArgs.flags || 'g');
        const replaceAll = safeArgs.all !== false; // default true

        try {
          const effectiveFlags = replaceAll ? flags : flags.replace('g', '');
          const regex = new RegExp(pattern, effectiveFlags);
          // Count matches using global flag
          const countRegex = new RegExp(
            pattern,
            effectiveFlags.includes('g') ? effectiveFlags : effectiveFlags + 'g'
          );
          const matches = fileContent.match(countRegex) || [];

          if (matches.length === 0) {
            return { success: false, error: `Pattern not found: ${pattern}` };
          }

          const newContent = fileContent.replace(regex, replacement);
          const diff = generateEditDiff(fileContent.slice(0, 500), newContent.slice(0, 500));

          await fs.writeFile(replacePath, newContent, 'utf-8');

          const syntaxResult = await runSyntaxCheck(replacePath);
          const syntaxWarning = formatSyntaxResult(syntaxResult, replacePath);

          return {
            success: true,
            output: `Replaced ${matches.length} match(es) in ${replacePath}${syntaxWarning}`,
            diff,
            syntaxErrors: syntaxResult.hasErrors ? syntaxResult.errors : undefined,
          };
        } catch (regexError: unknown) {
          return {
            success: false,
            error: `Invalid regex: ${regexError instanceof Error ? regexError.message : String(regexError)}`,
          };
        }
      }

      case 'file_insert': {
        const insertPath = resolvePath(safeArgs.path);
        const fileContent = await fs.readFile(insertPath, 'utf-8');
        const lines = fileContent.split('\n');
        const insertContent = String(safeArgs.content || '');

        let insertLine = -1;

        // Determine insertion point
        if (safeArgs.after !== undefined) {
          const afterPattern = String(safeArgs.after);
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(afterPattern)) {
              insertLine = i + 1; // Insert after this line
              break;
            }
          }
          if (insertLine === -1) {
            return { success: false, error: `Pattern not found for 'after': ${afterPattern}` };
          }
        } else if (safeArgs.before !== undefined) {
          const beforePattern = String(safeArgs.before);
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(beforePattern)) {
              insertLine = i; // Insert before this line
              break;
            }
          }
          if (insertLine === -1) {
            return { success: false, error: `Pattern not found for 'before': ${beforePattern}` };
          }
        } else if (safeArgs.line !== undefined) {
          const lineNum = Number(safeArgs.line);
          if (lineNum === 0) {
            // Append at end
            insertLine = lines.length;
          } else if (lineNum === -1) {
            // Prepend at beginning
            insertLine = 0;
          } else {
            insertLine = lineNum - 1; // Convert to 0-based
          }
        } else {
          return { success: false, error: 'Must specify line, after, or before' };
        }

        // Insert the content
        const insertLines = insertContent.split('\n');
        lines.splice(insertLine, 0, ...insertLines);

        const newContent = lines.join('\n');
        const diff = generateEditDiff(fileContent.slice(0, 500), newContent.slice(0, 500));

        await fs.writeFile(insertPath, newContent, 'utf-8');

        const syntaxResult = await runSyntaxCheck(insertPath);
        const syntaxWarning = formatSyntaxResult(syntaxResult, insertPath);

        return {
          success: true,
          output: `Inserted ${insertLines.length} line(s) at line ${insertLine + 1} in ${insertPath}${syntaxWarning}`,
          diff,
          syntaxErrors: syntaxResult.hasErrors ? syntaxResult.errors : undefined,
        };
      }

      case 'format': {
        const target = safeArgs.path ? resolvePath(safeArgs.path) : WORKSPACE;
        const projectType = await detectProjectType(WORKSPACE);

        // Use array-based invocation to avoid shell injection
        const formatCmds: Record<string, { cmd: string; args: string[] }> = {
          typescript: { cmd: 'npx', args: ['prettier', '--write', target] },
          javascript: { cmd: 'npx', args: ['prettier', '--write', target] },
          python: { cmd: 'python', args: ['-m', 'black', target] },
          go: { cmd: 'gofmt', args: ['-w', target] },
          rust: { cmd: 'rustfmt', args: [target] },
        };

        const fmtConfig = formatCmds[projectType];
        if (!fmtConfig) {
          return { success: false, error: `No formatter for project type: ${projectType}` };
        }

        const fmtResult = await execa(fmtConfig.cmd, fmtConfig.args, {
          cwd: WORKSPACE,
          timeout: 30000,
          reject: false,
        });

        // For Python, try autopep8 as fallback
        if (projectType === 'python' && fmtResult.exitCode !== 0) {
          const fallbackResult = await execa('python', ['-m', 'autopep8', '--in-place', target], {
            cwd: WORKSPACE,
            timeout: 30000,
            reject: false,
          });
          return {
            success: fallbackResult.exitCode === 0,
            output: fallbackResult.stdout || 'Formatted successfully',
            error: fallbackResult.exitCode !== 0 ? fallbackResult.stderr : undefined,
          };
        }

        return {
          success: fmtResult.exitCode === 0,
          output: fmtResult.stdout || 'Formatted successfully',
          error: fmtResult.exitCode !== 0 ? fmtResult.stderr : undefined,
        };
      }

      case 'file_exists':
        return await executeFileExists(safeArgs);

      case 'file_delete':
        return await executeFileDelete(safeArgs);

      case 'file_copy':
        return await executeFileCopy(safeArgs);

      case 'file_move':
        return await executeFileMove(safeArgs);

      case 'directory_create':
        return await executeDirectoryCreate(safeArgs);

      case 'directory_list':
        return await executeDirectoryList(safeArgs);

      case 'glob':
        return await executeGlob(safeArgs);

      case 'grep':
        return await executeGrep(safeArgs);

      case 'bash': {
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

        // 卡住检测阈值（默认120秒，可通过 stuckWarning 参数调整）
        const stuckWarningMs = (safeArgs.stuckWarning as number) || 120000;

        // 跨平台进程树杀死: Windows taskkill /F /T, Unix SIGKILL to process group
        const killProcessTree = async (pid: number): Promise<void> => {
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
        };

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

          const actualCommand = command;

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

            return {
              success: bashResult.exitCode === 0,
              output: bashResult.exitCode === 0 ? output : undefined,
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

      case 'monitor': {
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

      case 'task_stop': {
        const taskId = safeArgs.task_id as string;

        if (!activeMonitors.has(taskId)) {
          return {
            success: false,
            error: `Task not found: ${taskId}. Active tasks: ${Array.from(activeMonitors.keys()).join(', ') || 'none'}`,
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

      case 'git': {
        const git = simpleGit(WORKSPACE);
        const action = safeArgs.action as string;
        const args = safeArgs.args || {};

        switch (action) {
          case 'status': {
            const status = await git.status();
            return {
              success: true,
              output: status.files.map(f => `${f.index} ${f.path}`).join('\n') || 'clean',
            };
          }
          case 'diff': {
            const diff = await git.diff();
            return { success: true, output: diff || 'No changes' };
          }
          case 'log': {
            const log = await git.log({ maxCount: args.limit || 10 });
            return {
              success: true,
              output: log.all.map(c => `${c.hash.substring(0, 7)} ${c.message}`).join('\n'),
            };
          }
          case 'add': {
            await git.add(args.files || '.');
            return { success: true, output: 'Files added' };
          }
          case 'commit': {
            if (!args.message) return { success: false, error: 'Message required' };
            await git.commit(args.message);
            return { success: true, output: `Committed: ${args.message}` };
          }
          case 'branch': {
            if (args.branch) {
              await git.branch(args.branch);
              return { success: true, output: `Created branch: ${args.branch}` };
            }
            const branches = await git.branchLocal();
            return { success: true, output: branches.all.join('\n') };
          }
          case 'checkout': {
            const branchName = String(args.branch || '');
            if (!branchName) return { success: false, error: 'Branch required' };

            // 安全检查：检测未提交更改
            const status = await git.status();
            if (status.files.length > 0) {
              // 不直接执行，返回教育性错误让AI决定如何处理
              const fileList = status.files
                .slice(0, 10)
                .map(f => f.path)
                .join('\n');
              return {
                success: false,
                error: `未提交更改存在 (${status.files.length} files)，切换分支将丢失工作。\n建议安全操作顺序：\n1. git action:stash (保存当前工作)\n2. git action:checkout (安全切换)\n3. git action:stash_pop (恢复工作)\n\n或者提交当前工作：\n1. git action:add files:. (添加所有文件)\n2. git action:commit message:"work in progress" (提交)\n3. git action:checkout (安全切换)\n\n受影响文件：\n${fileList}${status.files.length > 10 ? '\n... 更多文件' : ''}`,
                filesAtRisk: status.files.map(f => f.path),
                safetyMode: 'protected',
              };
            }

            // 安全：可以切换分支
            const branches = await git.branchLocal();
            if (branches.all.includes(branchName)) {
              await git.checkout(branchName);
              return { success: true, output: `Switched to ${branchName}` };
            }
            await git.checkoutLocalBranch(branchName);
            return { success: true, output: `Created and switched to ${branchName}` };
          }
          case 'push': {
            await git.push();
            return { success: true, output: 'Pushed' };
          }
          case 'pull': {
            await git.pull();
            return { success: true, output: 'Pulled' };
          }
          case 'reset': {
            // 安全检查：所有reset模式都需要检查未提交更改
            const status = await git.status();
            const mode = args.mode || 'mixed';

            if (status.files.length > 0 && (mode === 'hard' || mode === 'mixed')) {
              const fileList = status.files
                .slice(0, 10)
                .map(f => f.path)
                .join('\n');
              const warningMsg =
                mode === 'hard'
                  ? `Reset --hard 将永久丢失 ${status.files.length} 个文件的所有更改！`
                  : `Reset --mixed 将取消 ${status.files.length} 个文件的暂存状态`;

              return {
                success: false,
                error: `${warningMsg}\n建议安全操作：\n1. git action:stash (保存工作)\n2. git action:reset mode:${mode} (执行reset)\n3. 如需恢复：git action:stash_pop\n\n受影响文件：\n${fileList}${status.files.length > 10 ? '\n... 更多文件' : ''}\n\n如确认继续，请明确说明：用户已确认reset操作`,
                filesAtRisk: status.files.map(f => f.path),
                safetyMode: 'protected',
                requiresUserConfirmation: true,
              };
            }

            // 执行reset（已确认安全或clean状态）
            await git.reset(mode);
            return { success: true, output: `Reset (${mode}) completed safely` };
          }
          case 'stash': {
            const stashAction = args.stash_action || 'push';

            if (stashAction === 'push' || stashAction === 'save') {
              const message = args.message || `spica-auto-backup-${Date.now()}`;
              await git.stash({ message } as any);
              return { success: true, output: `Stashed: ${message}` };
            } else if (stashAction === 'pop') {
              await execa('git stash pop', { shell: true, cwd: WORKSPACE });
              return { success: true, output: 'Stash restored' };
            } else if (stashAction === 'apply') {
              await execa('git stash apply', { shell: true, cwd: WORKSPACE });
              return { success: true, output: 'Stash applied' };
            } else if (stashAction === 'list') {
              const stashList = await git.stashList();
              return {
                success: true,
                output:
                  stashList.all.map(s => `${s.hash.substring(0, 7)} ${s.message}`).join('\n') ||
                  'No stashes',
              };
            } else if (stashAction === 'drop') {
              await execa('git stash drop', { shell: true, cwd: WORKSPACE });
              return { success: true, output: 'Stash dropped' };
            }

            return { success: false, error: `Unknown stash action: ${stashAction}` };
          }
          case 'checkpoint_restore': {
            // 查找最近的SPICA-CHECKPOINT commit
            const log = await git.log({ maxCount: 20 });
            const checkpoint = log.all.find(c => c.message.includes('[SPICA-CHECKPOINT]'));

            if (!checkpoint) {
              return {
                success: false,
                error:
                  '没有找到checkpoint。建议：\n1. git action:log (查看历史)\n2. git action:reset mode:hard (手动恢复到某个commit)',
              };
            }

            // 检查当前是否有未保存工作
            const currentStatus = await git.status();
            if (currentStatus.files.length > 0) {
              return {
                success: false,
                error: `当前有 ${currentStatus.files.length} 个未保存更改。\n建议先处理：\n1. git action:stash (保存当前工作)\n2. git action:reset mode:hard (恢复checkpoint)\n3. git action:stash_pop (恢复之前工作)`,
              };
            }

            // 安全恢复到checkpoint
            await git.reset(['--hard', checkpoint.hash]);
            return {
              success: true,
              output: `Restored to checkpoint: ${checkpoint.hash.substring(0, 7)}\nMessage: ${checkpoint.message}\nTime: ${checkpoint.date}`,
            };
          }
          default:
            return { success: false, error: `Unknown git action: ${action}` };
        }
      }

      case 'web_search':
        return await executeWebSearch(safeArgs);

      case 'web_fetch':
        return await executeWebFetch(safeArgs);

      case 'question':
        return await executeQuestion(safeArgs);

      case 'gh': {
        const action = safeArgs.action as string;
        const args = safeArgs.args || {};
        const timeout = (args.timeout || 15) * 1000;

        switch (action) {
          case 'pr_view': {
            const ghArgs = ['pr', 'view'];
            if (args.number) ghArgs.push(String(args.number));
            const ghResult = await execa('gh', ghArgs, { cwd: WORKSPACE, timeout, reject: false });
            return { success: ghResult.exitCode === 0, output: ghResult.stdout || ghResult.stderr };
          }
          case 'pr_list': {
            const state = args.state || 'open';
            const limit = args.limit || 20;
            const ghResult = await execa(
              'gh',
              ['pr', 'list', '--state', state, '--limit', String(limit)],
              { cwd: WORKSPACE, timeout, reject: false }
            );
            return { success: ghResult.exitCode === 0, output: ghResult.stdout || 'No PRs found' };
          }
          case 'pr_create': {
            const title = args.title || '';
            const body = args.body || '';
            const base = args.base || 'main';
            const head = args.head || '';
            if (!title) return { success: false, error: 'Title required' };
            const ghArgs = ['pr', 'create', '--title', title, '--body', body, '--base', base];
            if (head) ghArgs.push('--head', head);
            const ghResult = await execa('gh', ghArgs, { cwd: WORKSPACE, timeout, reject: false });
            return { success: ghResult.exitCode === 0, output: ghResult.stdout || ghResult.stderr };
          }
          case 'issue_list': {
            const state = args.state || 'open';
            const limit = args.limit || 20;
            const ghArgs = ['issue', 'list', '--state', state, '--limit', String(limit)];
            if (args.label) ghArgs.push('--label', args.label);
            const ghResult = await execa('gh', ghArgs, { cwd: WORKSPACE, timeout, reject: false });
            return {
              success: ghResult.exitCode === 0,
              output: ghResult.stdout || 'No issues found',
            };
          }
          case 'issue_view': {
            const ghArgs = ['issue', 'view'];
            if (args.number) ghArgs.push(String(args.number));
            const ghResult = await execa('gh', ghArgs, { cwd: WORKSPACE, timeout, reject: false });
            return { success: ghResult.exitCode === 0, output: ghResult.stdout || ghResult.stderr };
          }
          case 'issue_create': {
            const title = args.title || '';
            const body = args.body || '';
            if (!title) return { success: false, error: 'Title required' };
            const ghResult = await execa(
              'gh',
              ['issue', 'create', '--title', title, '--body', body],
              { cwd: WORKSPACE, timeout, reject: false }
            );
            return { success: ghResult.exitCode === 0, output: ghResult.stdout || ghResult.stderr };
          }
          case 'repo_view': {
            const ghResult = await execa('gh', ['repo', 'view'], {
              cwd: WORKSPACE,
              timeout,
              reject: false,
            });
            return {
              success: ghResult.exitCode === 0,
              output: ghResult.stdout || 'Not in a GitHub repository',
            };
          }
          case 'run_list': {
            const limit = args.limit || 10;
            const ghResult = await execa('gh', ['run', 'list', '--limit', String(limit)], {
              cwd: WORKSPACE,
              timeout,
              reject: false,
            });
            return {
              success: ghResult.exitCode === 0,
              output: ghResult.stdout || 'No workflow runs found',
            };
          }
          case 'run_view': {
            const ghArgs = ['run', 'view'];
            if (args.number) ghArgs.push(String(args.number));
            const ghResult = await execa('gh', ghArgs, { cwd: WORKSPACE, timeout, reject: false });
            return { success: ghResult.exitCode === 0, output: ghResult.stdout || ghResult.stderr };
          }
          case 'pr_comment': {
            if (!args.number) return { success: false, error: 'PR number required' };
            const ghArgs = ['pr', 'comment', String(args.number)];
            if (args.body) ghArgs.push('--body', args.body);
            const ghResult = await execa('gh', ghArgs, { cwd: WORKSPACE, timeout, reject: false });
            return {
              success: ghResult.exitCode === 0,
              output: ghResult.stdout || 'Comment posted',
            };
          }
          case 'pr_review': {
            if (!args.number) return { success: false, error: 'PR number required' };
            const reviewAction = args.action || 'comment';
            const ghArgs = ['pr', 'review', String(args.number), `--${reviewAction}`];
            if (args.body) ghArgs.push('--body', args.body);
            const ghResult = await execa('gh', ghArgs, { cwd: WORKSPACE, timeout, reject: false });
            return {
              success: ghResult.exitCode === 0,
              output: ghResult.stdout || `Review (${reviewAction}) submitted`,
            };
          }
          case 'pr_merge': {
            if (!args.number) return { success: false, error: 'PR number required' };
            const mergeMethod = args.method || 'squash';
            const ghArgs = ['pr', 'merge', String(args.number), `--${mergeMethod}`];
            const ghResult = await execa('gh', ghArgs, { cwd: WORKSPACE, timeout, reject: false });
            return {
              success: ghResult.exitCode === 0,
              output: ghResult.stdout || `PR merged (${mergeMethod})`,
            };
          }
          case 'pr_diff': {
            if (!args.number) return { success: false, error: 'PR number required' };
            const ghResult = await execa('gh', ['pr', 'diff', String(args.number)], {
              cwd: WORKSPACE,
              timeout,
              reject: false,
            });
            return { success: ghResult.exitCode === 0, output: ghResult.stdout || 'No diff' };
          }
          case 'issue_comment': {
            if (!args.number) return { success: false, error: 'Issue number required' };
            const ghArgs = ['issue', 'comment', String(args.number)];
            if (args.body) ghArgs.push('--body', args.body);
            const ghResult = await execa('gh', ghArgs, { cwd: WORKSPACE, timeout, reject: false });
            return {
              success: ghResult.exitCode === 0,
              output: ghResult.stdout || 'Comment posted',
            };
          }
          case 'search': {
            const searchType = args.type || 'code';
            const searchQuery = args.query || '';
            if (!searchQuery) return { success: false, error: 'Search query required' };
            const searchLimit = args.limit || 10;
            const ghResult = await execa(
              'gh',
              ['search', searchType, searchQuery, '--limit', String(searchLimit)],
              { cwd: WORKSPACE, timeout, reject: false }
            );
            return { success: ghResult.exitCode === 0, output: ghResult.stdout || 'No results' };
          }
          default:
            return { success: false, error: `Unknown gh action: ${action}` };
        }
      }

      case 'skill':
        return await executeSkill(safeArgs);

      case 'todo_read':
        return await executeTodoRead(safeArgs);

      case 'todo_write':
        return await executeTodoWrite(safeArgs);

      case 'task': {
        const tasks = safeArgs.tasks as SubAgentTask[];
        const externalSignal = safeArgs._abortSignal as AbortSignal | undefined;

        // 限制最多3个并行任务
        if (tasks.length > 3) {
          return {
            success: false,
            error: '最多支持3个并行任务。请将任务拆分为多次调用。',
          };
        }

        // Shared controller for early termination: when one subagent finds a
        // definitive answer, it signals siblings to stop (saves tokens).
        const siblingAbortController = new AbortController();
        let earlyExitTriggered = false;

        const results = await Promise.all(
          tasks.map(async (task, i) => {
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
            const { SpicaAgent } = await import('../agent');
            const { getRuntimeState } = await import('../core/RuntimeState');
            const parentAgent = getRuntimeState().getAgent();

            // Determine if error is retryable (timeout, network, transient)
            const isRetryableError = (errMsg: string): boolean => {
              const lower = errMsg.toLowerCase();
              if (lower.includes('interrupted') || lower.includes('parent agent')) return false;
              if (lower.includes('blocked by whitelist')) return false;
              if (lower.includes('authentication') || lower.includes('unauthorized')) return false;
              return (
                lower.includes('timeout') ||
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

            const MAX_RETRIES = 1;
            let lastError: string = 'Unknown error';

            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
              // Check parent interrupt and sibling early-exit before each attempt
              if (externalSignal?.aborted) {
                return `[FAIL] ${taskLabel}: Parent agent interrupted`;
              }
              if (siblingAbortController.signal.aborted) {
                return `[FAIL] ${taskLabel}: Early exit — sibling subagent already solved the task`;
              }

              const taskAgent = new SpicaAgent(undefined, WORKSPACE);

              // 设置工具白名单（限制subagent权限，避免context pollution）
              if (config.allowedTools !== '*') {
                taskAgent.setToolWhitelist(config.allowedTools);
              }

              // 监听器引用，用于清理
              const toolResultHandler = (data: any) => {
                if (eventCallback) {
                  eventCallback('sub_agent_tool_result', { id: subTaskId, ...data });
                }
              };
              taskAgent.on('tool_result', toolResultHandler);

              // 创建超时 AbortController
              const timeoutController = new AbortController();
              const timeoutId = setTimeout(() => {
                timeoutController.abort();
                taskAgent.interrupt();
              }, config.timeout);

              // 监听外部中断信号（父 agent 中断）和 sibling early-exit
              let abortHandler: (() => void) | null = null;
              let siblingAbortHandler: (() => void) | null = null;
              if (externalSignal) {
                if (externalSignal.aborted) {
                  taskAgent.off('tool_result', toolResultHandler);
                  taskAgent.interrupt();
                  taskAgent.dispose();
                  clearTimeout(timeoutId);
                  return `[FAIL] ${taskLabel}: Parent agent interrupted`;
                }
                abortHandler = () => {
                  externalSignal.removeEventListener('abort', abortHandler!);
                  taskAgent.interrupt();
                  clearTimeout(timeoutId);
                };
                externalSignal.addEventListener('abort', abortHandler);
              }
              // Listen for sibling early-exit
              if (!siblingAbortController.signal.aborted) {
                siblingAbortHandler = () => {
                  siblingAbortController.signal.removeEventListener('abort', siblingAbortHandler!);
                  taskAgent.interrupt();
                  clearTimeout(timeoutId);
                };
                siblingAbortController.signal.addEventListener('abort', siblingAbortHandler);
              } else {
                taskAgent.off('tool_result', toolResultHandler);
                taskAgent.interrupt();
                taskAgent.dispose();
                clearTimeout(timeoutId);
                return `[FAIL] ${taskLabel}: Early exit — sibling subagent already solved the task`;
              }

              try {
                // Use lightweight sub-agent init
                if (parentAgent) {
                  await taskAgent.initAsSubAgent(parentAgent);
                } else {
                  await taskAgent.init();
                }

                const retryNote =
                  attempt > 0
                    ? '\n[RETRY] Previous attempt failed. Please try a different approach.'
                    : '';
                const resultPromise = taskAgent.runLoop(task.prompt + retryNote);

                // 使用 AbortController 的 promise 来处理超时和中断
                const abortPromise = new Promise<string>((_, reject) => {
                  timeoutController.signal.addEventListener('abort', () => {
                    reject(new Error(timeoutController.signal.reason || 'Timeout'));
                  });
                });

                const result = await Promise.race([resultPromise, abortPromise]);

                // Success — cleanup and return
                clearTimeout(timeoutId);
                taskAgent.off('tool_result', toolResultHandler);
                if (abortHandler && externalSignal) {
                  externalSignal.removeEventListener('abort', abortHandler);
                }
                if (siblingAbortHandler) {
                  siblingAbortController.signal.removeEventListener('abort', siblingAbortHandler);
                }
                taskAgent.dispose();

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
                    /✓/,
                    /成功/,
                    /完成/,
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

                if (eventCallback) {
                  eventCallback('sub_agent_done', { id: subTaskId, summary });
                }

                return `[PASS] ${taskLabel}: ${summary}`;
              } catch (err: any) {
                // Cleanup
                clearTimeout(timeoutId);
                taskAgent.off('tool_result', toolResultHandler);
                if (abortHandler && externalSignal) {
                  externalSignal.removeEventListener('abort', abortHandler);
                }
                if (siblingAbortHandler) {
                  siblingAbortController.signal.removeEventListener('abort', siblingAbortHandler);
                }
                taskAgent.interrupt();
                taskAgent.dispose();

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
                return `[FAIL] ${taskLabel}: ${lastError}`;
              }
            }

            // Should not reach here, but just in case
            return `[FAIL] ${taskLabel}: ${lastError}`;
          })
        );

        // 分析结果，检测失败
        const failedTasks = results.filter(r => r.startsWith('[FAIL]'));
        const succeededTasks = results.filter(r => r.startsWith('[PASS]'));

        // Cap total output size to prevent context pollution
        const MAX_TOTAL_OUTPUT = 2000;
        let output = results.join('\n');
        const warningSuffix =
          failedTasks.length > 0
            ? `\n\n[WARNING] ${failedTasks.length}/${results.length} subagent(s) failed. Retry failed tasks or handle directly.`
            : '';

        if (output.length + warningSuffix.length > MAX_TOTAL_OUTPUT) {
          // Truncate individual results to fit
          const availablePerResult = Math.floor(
            (MAX_TOTAL_OUTPUT - warningSuffix.length) / results.length
          );
          output = results
            .map(r => (r.length > availablePerResult ? r.slice(0, availablePerResult) + '...' : r))
            .join('\n');
        }
        output += warningSuffix;

        if (failedTasks.length > 0) {
          return {
            success: succeededTasks.length > 0,
            output,
            error: failedTasks.length > 0 ? `${failedTasks.length} subagent(s) failed` : undefined,
          };
        }

        return { success: true, output };
      }

      case 'lint':
        return await executeLint(safeArgs, eventCallback);

      case 'test':
        return await executeTest(safeArgs, eventCallback);

      case 'code_health': {
        const healthPath = resolvePath(safeArgs.path);
        const threshold = safeArgs.threshold ?? 9.5;

        try {
          const result = await analyzeCodeHealth(healthPath, threshold);
          const output = formatCodeHealthResult(result);

          return {
            success: result.passed,
            output,
            content: JSON.stringify(result),
          };
        } catch (healthError: unknown) {
          const errorMsg = healthError instanceof Error ? healthError.message : String(healthError);
          return { success: false, error: `Code health analysis failed: ${errorMsg}` };
        }
      }

      case 'test_quality_check': {
        const testFilePath = resolvePath(safeArgs.testFile);
        const threshold = safeArgs.threshold ?? 7.0;

        try {
          const result = await analyzeTestQuality(testFilePath, threshold);
          const output = formatTestQualityResult(result);

          return {
            success: result.passed,
            output,
            content: JSON.stringify(result),
          };
        } catch (testError: unknown) {
          const errorMsg = testError instanceof Error ? testError.message : String(testError);
          return { success: false, error: `Test quality analysis failed: ${errorMsg}` };
        }
      }

      default:
        // MCP 工具（格式：servername/toolname）
        if (name.includes('/')) {
          const mcpManager = getMCPManager();
          if (mcpManager.hasTool(name)) {
            return await mcpManager.callTool(name, safeArgs);
          }
        }
        // 通过 sanitized name 映射查找 MCP 工具
        const originalName = mcpToolNameMap.get(name);
        if (originalName) {
          const mcpManager = getMCPManager();
          return await mcpManager.callTool(originalName, safeArgs);
        }
        return { success: false, error: `Unknown tool: ${name}` };
    }
  } catch (error: any) {
    return { success: false, error: error.message };
  }
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
