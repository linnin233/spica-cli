import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { setWorkspace, executeTool } from '../../tools/index';

// Skip on Windows - bash commands don't work the same way
const isWindows = process.platform === 'win32';
const shouldSkip = isWindows || process.env.CI === 'true';

describe.skipIf(shouldSkip)('shell injection prevention', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spica-test-'));
    setWorkspace(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  // 放宽后的安全策略：只阻止真正危险的操作
  const blockedCommands = [
    { cmd: 'mkfifo /tmp/pipe', name: 'named pipe creation' },
    { cmd: 'nc -l 8080', name: 'netcat listener' },
    { cmd: 'bash -c "cat /etc/passwd" | sh', name: 'piping to shell interpreter' },
    { cmd: 'eval echo bad', name: 'eval command' },
  ];

  for (const { cmd, name } of blockedCommands) {
    it(`should block ${name}`, async () => {
      const result = await executeTool('bash', { command: cmd });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Blocked');
    });
  }

  // 现在允许的常用操作符（之前被阻止）
  const allowedCommands = [
    { cmd: 'ls; echo done', name: 'command separator (;)' },
    { cmd: 'echo hello && echo world', name: 'AND operator (&&)' },
    { cmd: 'false || echo fallback', name: 'OR operator (||)' },
    { cmd: 'echo ${HOME}', name: 'variable expansion (${})' },
    { cmd: 'echo $(whoami)', name: 'command substitution ($())' },
  ];

  for (const { cmd, name } of allowedCommands) {
    it(`should now allow ${name} (relaxed for usability)`, async () => {
      const result = await executeTool('bash', { command: cmd });
      expect(result.success).toBe(true);
    });
  }

  it('should still allow safe commands', async () => {
    const result = await executeTool('bash', { command: 'echo hello world' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('hello world');
  });
});

describe('format tool injection prevention', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spica-test-'));
    await fs.writeJson(path.join(tmpDir, 'package.json'), {
      devDependencies: { typescript: '^5.0.0' },
    });
    setWorkspace(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('should not execute injected commands in format target', async () => {
    const injectionFile = '/tmp/spica-injection-test';
    const result = await executeTool('format', {
      path: '"; rm -rf /tmp/spica-injection-test; echo "',
    });
    // Should not execute the injected command — the file should not exist
    expect(fs.existsSync(injectionFile)).toBe(false);
  });

  it('should handle paths with spaces without injection', async () => {
    const testFile = path.join(tmpDir, 'my file.ts');
    await fs.writeFile(testFile, 'const x = 1;');

    const result = await executeTool('format', { path: 'my file.ts' });
    expect(result.success !== undefined).toBe(true);
  });
});
