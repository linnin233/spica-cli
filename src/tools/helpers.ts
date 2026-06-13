// Shared helpers, types, and utilities for tool implementations

import fs from 'fs-extra';
import { execa } from 'execa';
import { resolve as pathResolve, isAbsolute, dirname, join, basename } from 'path';

export const isWindows = process.platform === 'win32';

// WORKSPACE — mutable, set via setWorkspace()
export let WORKSPACE = process.cwd();

export function setWorkspace(path: string): void {
  WORKSPACE = path;
}

export function getWorkspace(): string {
  return WORKSPACE;
}

// Active monitors (used by monitor + task_stop)
export const activeMonitors: Map<
  string,
  { process: any; command: string; description: string; startTime: number }
> = new Map();

/**
 * Link an external AbortSignal to a local AbortController.
 * The listener self-cleans on fire, and returns a cleanup function
 * for normal-completion paths.
 */
export function linkAbortSignals(
  externalSignal: AbortSignal | undefined,
  localController: AbortController
): () => void {
  if (!externalSignal) return () => {};

  if (externalSignal.aborted) {
    localController.abort();
    return () => {};
  }

  const handler = () => {
    externalSignal.removeEventListener('abort', handler);
    localController.abort();
  };
  externalSignal.addEventListener('abort', handler);

  return () => {
    externalSignal.removeEventListener('abort', handler);
  };
}

// Types
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  batchHint?: 'read' | 'write' | 'neutral';
}

export interface ToolResult {
  success: boolean;
  output?: string;
  error?: string;
  diff?: string;
  syntaxErrors?: string[];
  content?: string;
  filesAtRisk?: string[];
  safetyMode?: 'protected' | 'normal';
  requiresUserConfirmation?: boolean;
  referencedSkills?: string[];
}

export interface ToolEventCallback {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool events have dynamic data types
  (event: string, data: any): void;
}

// ——— Path resolution ———

export function resolvePath(path: string): string {
  const resolved = isAbsolute(path) ? path : pathResolve(WORKSPACE, path);
  const realWorkspace = fs.realpathSync(pathResolve(WORKSPACE));

  function isOutside(p: string): boolean {
    if (isWindows) {
      const pLower = p.toLowerCase();
      const wsLower = realWorkspace.toLowerCase();
      const resolvedWsLower = pathResolve(realWorkspace).toLowerCase();
      return !pLower.startsWith(wsLower) && !pLower.startsWith(resolvedWsLower);
    }
    return !p.startsWith(realWorkspace) && !p.startsWith(pathResolve(realWorkspace));
  }

  let realPath: string;
  try {
    realPath = fs.realpathSync(resolved);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      try {
        const lst = fs.lstatSync(resolved);
        if (lst.isSymbolicLink()) {
          const linkTarget = fs.readlinkSync(resolved);
          const resolvedTarget = isAbsolute(linkTarget)
            ? linkTarget
            : pathResolve(dirname(resolved), linkTarget);
          let realTarget: string;
          try {
            realTarget = fs.realpathSync(resolvedTarget);
            if (isOutside(realTarget)) {
              throw new Error('Access denied: symlink points outside workspace');
            }
          } catch (_e) {
            if (_e instanceof Error && _e.message.includes('Access denied')) throw _e;
            const targetParent = dirname(resolvedTarget);
            try {
              const realTargetParent = fs.realpathSync(targetParent);
              const fullPath = pathResolve(realTargetParent, basename(resolvedTarget));
              if (isOutside(fullPath)) {
                throw new Error('Access denied: symlink points outside workspace', { cause: _e });
              }
            } catch (_e2) {
              if (isOutside(pathResolve(resolvedTarget))) {
                throw new Error('Access denied: symlink points outside workspace', { cause: _e2 });
              }
            }
            return resolved;
          }
          return resolved;
        }
      } catch (lstErr: any) {
        if (lstErr.message?.includes('Access denied')) throw lstErr;
      }

      const parent = dirname(resolved);
      let currentParent = parent;
      let realParent: string;
      let foundExistingParent = false;

      while (currentParent && currentParent !== '/' && currentParent !== '.') {
        try {
          realParent = fs.realpathSync(currentParent);
          if (isOutside(realParent)) {
            throw new Error(`Access denied: path "${path}" is outside workspace`);
          }
          foundExistingParent = true;
          break;
        } catch (parentErr: any) {
          if (parentErr.message?.includes('Access denied')) throw parentErr;
          currentParent = dirname(currentParent);
        }
      }

      if (!foundExistingParent) {
        try {
          realParent = fs.realpathSync(pathResolve(WORKSPACE));
          if (isOutside(realParent)) {
            throw new Error(`Access denied: path "${path}" is outside workspace`);
          }
        } catch (resolveErr) {
          throw new Error(`Access denied: cannot resolve path "${path}"`, { cause: resolveErr });
        }
      }

      return resolved;
    }
    throw err;
  }

  if (isOutside(realPath)) {
    throw new Error('Access denied: symlink points outside workspace');
  }

  return resolved;
}

// ——— URL validation ———

export function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '0.0.0.0'
  ) {
    throw new Error(`Access denied: requests to localhost are not allowed`);
  }

  const ipMatch = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipMatch) {
    const [, a, b] = ipMatch.map(Number);
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      throw new Error(`Access denied: requests to private IP ranges are not allowed`);
    }
    if (a === 169 && b === 254) {
      throw new Error(`Access denied: requests to link-local addresses are not allowed`);
    }
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Access denied: only http/https URLs are allowed`);
  }
}

// ——— Project type detection ———

export async function detectProjectType(workspace: string): Promise<string> {
  if (await fs.pathExists(join(workspace, 'package.json'))) {
    const pkg = await fs.readJson(join(workspace, 'package.json'));
    if (pkg.devDependencies?.typescript) return 'typescript';
    return 'javascript';
  }
  if (await fs.pathExists(join(workspace, 'go.mod'))) return 'go';
  if (await fs.pathExists(join(workspace, 'requirements.txt'))) return 'python';
  if (await fs.pathExists(join(workspace, 'Cargo.toml'))) return 'rust';
  return 'unknown';
}

export function detectFileType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const typeMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    py: 'python',
    go: 'go',
    rs: 'rust',
    java: 'java',
    kt: 'kotlin',
    c: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    h: 'c',
    hpp: 'cpp',
    cs: 'csharp',
    rb: 'ruby',
    php: 'php',
    swift: 'swift',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
  };
  return typeMap[ext] || 'unknown';
}

// ——— Syntax checking ———

export interface SyntaxCheckResult {
  hasErrors: boolean;
  errors: string[];
  warnings: string[];
}

export function checkBracketMatching(content: string, filePath: string): string[] {
  const errors: string[] = [];
  const lines = content.split('\n');
  const stack: Array<{ char: string; line: number; col: number }> = [];
  const pairs: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
  const closing: Record<string, string> = { '}': '{', ']': '[', ')': '(' };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (pairs[ch]) {
        stack.push({ char: ch, line: i + 1, col: j + 1 });
      } else if (closing[ch]) {
        const last = stack.pop();
        if (!last) {
          errors.push(`${filePath}:${i + 1}:${j + 1}: Unexpected closing '${ch}'`);
        } else if (last.char !== closing[ch]) {
          errors.push(
            `${filePath}:${i + 1}:${j + 1}: Mismatched bracket '${ch}' (expected '${pairs[last.char]}' from line ${last.line})`
          );
        }
      }
    }
  }

  for (const unmatched of stack) {
    errors.push(`${filePath}:${unmatched.line}:${unmatched.col}: Unclosed '${unmatched.char}'`);
  }

  return errors;
}

export function formatSyntaxResult(result: SyntaxCheckResult, filePath: string): string {
  const parts: string[] = [];
  if (result.errors.length > 0) {
    parts.push(`Syntax errors in ${filePath}:`);
    result.errors.forEach(e => parts.push(`  ${e}`));
  }
  if (result.warnings.length > 0) {
    parts.push(`Warnings:`);
    result.warnings.forEach(w => parts.push(`  ${w}`));
  }
  if (parts.length === 0) {
    parts.push(`No syntax issues found in ${filePath}`);
  }
  return parts.join('\n');
}

export async function runSyntaxCheck(filePath: string): Promise<SyntaxCheckResult> {
  const result: SyntaxCheckResult = { hasErrors: false, errors: [], warnings: [] };
  const fileType = detectFileType(filePath);
  const absolutePath = resolvePath(filePath);

  if (!(await fs.pathExists(absolutePath))) {
    return result;
  }

  const isProjectFile =
    (await fs.pathExists(join(WORKSPACE, 'package.json'))) ||
    (await fs.pathExists(join(WORKSPACE, 'tsconfig.json')));

  try {
    switch (fileType) {
      case 'typescript': {
        const relativePath = filePath.replace(WORKSPACE, '').replace(/^\/+/, '');
        let fileErrorsFoundInProjectCheck = false;

        if (isProjectFile) {
          const checkResult = await execa('npx tsc --noEmit --skipLibCheck', {
            shell: true,
            cwd: WORKSPACE,
            timeout: 30000,
            reject: false,
          });
          const output = (checkResult.stdout || '') + '\n' + (checkResult.stderr || '');
          if (output.trim()) {
            const lines = output.split('\n');
            for (const line of lines) {
              if (
                (line.includes(relativePath) || line.includes(filePath)) &&
                line.includes('error TS')
              ) {
                result.errors.push(line.trim());
                result.hasErrors = true;
                fileErrorsFoundInProjectCheck = true;
              }
            }
          }
        }

        const content = await fs.readFile(absolutePath, 'utf-8');
        const bracketErrors = checkBracketMatching(content, filePath);
        if (bracketErrors.length > 0) {
          result.errors.push(...bracketErrors);
          result.hasErrors = true;
        }

        if (!fileErrorsFoundInProjectCheck) {
          const tscCwd = (await fs.pathExists(join(WORKSPACE, 'node_modules', 'typescript')))
            ? WORKSPACE
            : process.cwd();
          const singleFileCheck = await execa(
            `npx tsc --noEmit --skipLibCheck --esModuleInterop --target ES2020 --module ESNext "${absolutePath}" 2>&1`,
            {
              shell: true,
              cwd: tscCwd,
              timeout: 15000,
              reject: false,
            }
          );
          if (singleFileCheck.exitCode !== 0) {
            const errorOutput = singleFileCheck.stderr || singleFileCheck.stdout;
            if (errorOutput && errorOutput.includes('error TS')) {
              const errorLines = errorOutput.split('\n').filter(l => l.includes('error TS'));
              result.errors.push(...errorLines.map(l => l.trim()));
              result.hasErrors = true;
            }
          }
        }
        break;
      }

      case 'javascript': {
        const nodeCheck = await execa(`node --check "${absolutePath}" 2>&1`, {
          shell: true,
          cwd: WORKSPACE,
          timeout: 10000,
          reject: false,
        });
        if (nodeCheck.exitCode !== 0) {
          const errorOutput = nodeCheck.stderr || nodeCheck.stdout;
          if (errorOutput && errorOutput.includes('SyntaxError')) {
            result.errors.push(errorOutput);
            result.hasErrors = true;
          }
        }
        break;
      }

      case 'python': {
        const pyCheck = await execa(`python3 -m py_compile "${absolutePath}" 2>&1`, {
          shell: true,
          cwd: WORKSPACE,
          timeout: 15000,
          reject: false,
        });
        if (pyCheck.exitCode !== 0) {
          const errorOutput = pyCheck.stderr || pyCheck.stdout;
          if (
            errorOutput &&
            (errorOutput.includes('SyntaxError') || errorOutput.includes('IndentationError'))
          ) {
            result.errors.push(errorOutput);
            result.hasErrors = true;
          }
        }
        break;
      }

      case 'go': {
        const goCheck = await execa(`go vet "${absolutePath}" 2>&1`, {
          shell: true,
          cwd: WORKSPACE,
          timeout: 30000,
          reject: false,
        });
        if (goCheck.exitCode !== 0) {
          result.errors.push(goCheck.stderr || goCheck.stdout);
          result.hasErrors = true;
        }
        break;
      }

      case 'rust': {
        const rustCheck = await execa(`rustc --edition 2021 --check "${absolutePath}" 2>&1`, {
          shell: true,
          cwd: WORKSPACE,
          timeout: 30000,
          reject: false,
        });
        if (rustCheck.exitCode !== 0) {
          const errorOutput = rustCheck.stderr || rustCheck.stdout;
          if (errorOutput && errorOutput.includes('error')) {
            result.errors.push(errorOutput);
            result.hasErrors = true;
          }
        }
        break;
      }

      case 'shell': {
        const shellCheck = await execa(`bash -n "${absolutePath}" 2>&1`, {
          shell: true,
          cwd: WORKSPACE,
          timeout: 10000,
          reject: false,
        });
        if (shellCheck.exitCode !== 0) {
          const errorOutput = shellCheck.stderr || shellCheck.stdout;
          if (errorOutput && errorOutput.includes('syntax error')) {
            result.errors.push(errorOutput);
            result.hasErrors = true;
          }
        }
        break;
      }
    }
  } catch (checkError: any) {
    result.warnings.push(`Syntax check failed: ${checkError.message}`);
  }

  return result;
}

// ——— Patch / diff helpers ———

export interface PatchResult {
  success: boolean;
  output?: string;
  error?: string;
  content?: string;
  hunksApplied?: number;
}

export function parseHunkHeader(
  header: string
): { oldStart: number; oldCount: number; newStart: number; newCount: number } | null {
  const match = header.match(/^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
  if (!match) return null;
  return {
    oldStart: parseInt(match[1], 10),
    oldCount: parseInt(match[2] || '1', 10),
    newStart: parseInt(match[3], 10),
    newCount: parseInt(match[4] || '1', 10),
  };
}

export function applyUnifiedPatch(original: string, patchText: string): PatchResult {
  const originalLines = original.split('\n');
  const patchLines = patchText.split('\n');

  const result: string[] = [];
  let lineIdx = 0;

  for (let i = 0; i < patchLines.length; i++) {
    const line = patchLines[i];

    if (line.startsWith('@@')) {
      const header = parseHunkHeader(line);
      if (!header) return { success: false, error: `Invalid hunk header: ${line}` };

      // Skip lines in original before the hunk start
      while (lineIdx < header.oldStart - 1 && lineIdx < originalLines.length) {
        result.push(originalLines[lineIdx]);
        lineIdx++;
      }

      let oldConsumed = 0;
      i++; // Move past header
      while (i < patchLines.length && oldConsumed < header.oldCount) {
        const hunkLine = patchLines[i];
        if (hunkLine.startsWith('+')) {
          result.push(hunkLine.slice(1));
        } else if (hunkLine.startsWith('-')) {
          lineIdx++; // Skip this line in original
          oldConsumed++;
        } else if (hunkLine.startsWith(' ') || hunkLine === '') {
          result.push(originalLines[lineIdx] || hunkLine.slice(1));
          lineIdx++;
          oldConsumed++;
        } else {
          break; // Next hunk or end
        }
        i++;
      }
      i--; // Compensate for loop increment
    }
  }

  // Append remaining original lines
  while (lineIdx < originalLines.length) {
    result.push(originalLines[lineIdx]);
    lineIdx++;
  }

  return { success: true, output: result.join('\n') };
}
