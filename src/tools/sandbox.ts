import fs from 'fs-extra';
import { execa } from 'execa';
import { WORKSPACE } from './helpers';

/**
 * Bash sandbox using bubblewrap (bwrap).
 *
 * When enabled, bash commands run inside a minimal container that:
 * - Read-only access to /usr, /lib, /etc (system dependencies)
 * - Read-write access to $WORKSPACE only
 * - No network access (--unshare-net)
 * - No new privileges (--no-new-privileges)
 * - Private /tmp (--tmpfs /tmp)
 *
 * Falls back gracefully if bwrap is not installed.
 */

let bwrapAvailable: boolean | null = null;

/** Check if bubblewrap is installed. Result is cached. */
async function checkBwrap(): Promise<boolean> {
  if (bwrapAvailable !== null) return bwrapAvailable;
  try {
    const result = await execa('which', ['bwrap'], { timeout: 2000, reject: false });
    bwrapAvailable = result.exitCode === 0;
  } catch {
    bwrapAvailable = false;
  }
  return bwrapAvailable;
}

/** Build the sandboxed command using bwrap. */
function buildSandboxCommand(command: string, workspacePath: string): string {
  // Escape single quotes in the command
  const escapedCmd = command.replace(/'/g, "'\\''");

  return [
    'bwrap',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/lib64', '/lib64',
    '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/sbin', '/sbin',
    '--ro-bind', '/etc', '/etc',
    '--bind', workspacePath, workspacePath,
    '--tmpfs', '/tmp',
    '--unshare-net',
    '--no-new-privileges',
    '--die-with-parent',
    '--chdir', workspacePath,
    'bash', '-c', escapedCmd,
  ].join(' ');
}

export interface SandboxResult {
  sandboxed: boolean;
  command: string;
  warning?: string;
}

/**
 * Prepare a bash command with optional sandboxing.
 *
 * @param command — the raw bash command
 * @param sandbox — if true, wrap in bwrap (falls back to warning if unavailable)
 * @param workspacePath — path to bind into the sandbox as writable
 * @returns SandboxResult with the final command and metadata
 */
export async function prepareSandbox(
  command: string,
  sandbox: boolean,
  workspacePath: string = WORKSPACE
): Promise<SandboxResult> {
  if (!sandbox) {
    return { sandboxed: false, command };
  }

  const available = await checkBwrap();
  if (!available) {
    return {
      sandboxed: false,
      command,
      warning: 'bwrap (bubblewrap) not installed — running without sandbox. Install: apt install bubblewrap',
    };
  }

  return {
    sandboxed: true,
    command: buildSandboxCommand(command, workspacePath),
  };
}
