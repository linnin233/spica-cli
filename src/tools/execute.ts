import fs from 'fs-extra';
import { execa } from 'execa';

import { resolve as pathResolve, isAbsolute, dirname, join, basename } from 'path';
import fastGlob from 'fast-glob';
import { executeTask } from './impl/task';
import { executeReplySubagent } from './impl/replySubagent';
import { computeDiff, formatDiff, generateEditDiff } from '../cli/ui/diff';
import { getMCPManager } from '../mcp/client';
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

import { getCachedResult, setCachedResult, invalidateCache } from './cache';
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
import { executeAstSearch } from './impl/ast_search';
import { executeAstReplace } from './impl/ast_replace';
import { executeWebSearch, executeWebFetch } from './impl/web';
import { executeLint, executeTest } from './impl/lint_test';
import { executeBash, executeMonitor, executeTaskStop } from './impl/bash';
import { executeGit } from './impl/git';
import { executeGh } from './impl/gh';

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

  // Check read-only cache before execution
  const cached = getCachedResult(name, safeArgs);
  if (cached !== null) {
    return { success: true, output: cached };
  }

  // Invalidate cache before any write tool
  const WRITE_TOOLS = new Set([
    'write', 'edit', 'file_multi_edit', 'file_replace', 'file_insert',
    'file_delete', 'file_copy', 'file_move', 'file_patch', 'directory_create',
    'bash', 'git', 'format',
  ]);
  if (WRITE_TOOLS.has(name)) {
    invalidateCache();
  }

  // Track whether to cache this result (read-only tools only)
  const READ_TOOLS_CACHE = new Set(['read', 'glob', 'grep', 'directory_list', 'file_exists']);
  const shouldCache = READ_TOOLS_CACHE.has(name);

  // Wrapper that caches successful read-tool results
  const withCache = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => {
    const result = await fn();
    if (result.success && shouldCache) {
      setCachedResult(name, safeArgs, result.output || result.content || '');
    }
    return result;
  };

  try {
    switch (name) {
      case 'workspace':
        return await executeWorkspace(safeArgs);

      case 'read':
        return await withCache(() => executeFileRead(safeArgs));

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
        const replaceAll = safeArgs.replace_all === true;

        if (!fileContent.includes(oldStr)) {
          return {
            success: false,
            error: `Text not found in file. Read the file to get exact text.`,
          };
        }

        // Count occurrences — if multiple and replace_all not set, return error
        if (!replaceAll) {
          let count = 0;
          let idx = 0;
          while ((idx = fileContent.indexOf(oldStr, idx)) !== -1) {
            count++;
            idx += oldStr.length;
          }
          if (count > 1) {
            return {
              success: false,
              error: `Found ${count} matches for the given text. Use replace_all: true to replace all, or file_multi_edit to handle each occurrence separately.`,
            };
          }
        }

        const newContent = replaceAll
          ? fileContent.split(oldStr).join(newStr)
          : fileContent.replace(oldStr, newStr);
        const diff = generateEditDiff(oldStr, newStr);

        await fs.writeFile(editPath, newContent, 'utf-8');

        // 自动语法检查
        const syntaxResult = await runSyntaxCheck(editPath);
        const syntaxWarning = formatSyntaxResult(syntaxResult, editPath);

        const occurrenceNote = replaceAll ? ` (${fileContent.split(oldStr).length - 1} occurrences)` : '';

        return {
          success: true,
          output: `Edited ${editPath}${occurrenceNote}${syntaxWarning}`,
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
          const edReplaceAll = edit.replace_all === true;

          if (!newContent.includes(oldStr)) {
            return { success: false, error: `Text not found: "${oldStr.slice(0, 30)}..."` };
          }

          // Count occurrences for multi-match detection
          if (!edReplaceAll) {
            let count = 0;
            let idx = 0;
            while ((idx = newContent.indexOf(oldStr, idx)) !== -1) {
              count++;
              idx += oldStr.length;
            }
            if (count > 1) {
              return {
                success: false,
                error: `Found ${count} matches for "${oldStr.slice(0, 30)}...". Use replace_all: true in this edit, or split into separate edits.`,
              };
            }
          }

          newContent = edReplaceAll
            ? newContent.split(oldStr).join(newStr)
            : newContent.replace(oldStr, newStr);
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

        // Backup original file before patching
        try {
          const backupDir = join(WORKSPACE, '.spica', 'backups');
          await fs.ensureDir(backupDir);
          const timestamp = Date.now();
          const safeName = safeArgs.path.replace(/[/\\]/g, '_');
          const backupPath = join(backupDir, `${timestamp}-${safeName}`);
          await fs.writeFile(backupPath, originalContent, 'utf-8');
        } catch (backupErr) {
          // Non-fatal: continue without backup
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
        return await withCache(() => executeFileExists(safeArgs));

      case 'file_delete':
        return await executeFileDelete(safeArgs);

      case 'file_copy':
        return await executeFileCopy(safeArgs);

      case 'file_move':
        return await executeFileMove(safeArgs);

      case 'directory_create':
        return await executeDirectoryCreate(safeArgs);

      case 'directory_list':
        return await withCache(() => executeDirectoryList(safeArgs));

      case 'glob':
        return await withCache(() => executeGlob(safeArgs));

      case 'grep':
        return await withCache(() => executeGrep(safeArgs));

      case 'ast_search':
        return await withCache(() => executeAstSearch(safeArgs));

      case 'ast_replace':
        return await executeAstReplace(safeArgs);

      case 'bash':
        return await executeBash(safeArgs, eventCallback);

      case 'monitor':
        return await executeMonitor(safeArgs, eventCallback);

      case 'task_stop':
        return await executeTaskStop(safeArgs);

      case 'reply_subagent':
        return await executeReplySubagent(safeArgs);

      case 'git':
        return await executeGit(safeArgs);

      case 'web_search':
        return await executeWebSearch(safeArgs);

      case 'web_fetch':
        return await executeWebFetch(safeArgs);

      case 'question':
        return await executeQuestion(safeArgs);

      case 'gh':
        return await executeGh(safeArgs);

      case 'skill':
        return await executeSkill(safeArgs);

      case 'todo_read':
        return await executeTodoRead(safeArgs);

      case 'todo_write':
        return await executeTodoWrite(safeArgs);

      case 'task':
        return await executeTask(safeArgs, eventCallback);

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
