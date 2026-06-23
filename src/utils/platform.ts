import path from 'path';
import fs from 'fs-extra';

const isWindows = process.platform === 'win32';

export function getDefaultShell(): string {
  if (isWindows) {
    return process.env.COMSPEC || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

export function getShellArgs(): string[] {
  if (isWindows) {
    return ['/c'];
  }
  return ['-c'];
}

export function getBashPath(): string | null {
  if (!isWindows) {
    return '/bin/bash';
  }

  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Windows\\System32\\bash.exe',
  ];

  const pathDirs = (process.env.PATH || '').split(';');
  for (const dir of pathDirs) {
    const candidate = path.join(dir, 'bash.exe');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function getBashOrFallback(): { shell: string; args: string[] } {
  const bashPath = getBashPath();
  if (bashPath) {
    return { shell: bashPath, args: ['-c'] };
  }
  // Windows: try PowerShell as better fallback than cmd.exe
  if (isWindows) {
    const pwshExe = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    );
    if (fs.existsSync(pwshExe)) {
      return { shell: pwshExe, args: ['-Command'] };
    }
  }
  return { shell: getDefaultShell(), args: getShellArgs() };
}

export function supportsTmux(): boolean {
  return !isWindows;
}
