import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { executeTool, setWorkspace } from '../../tools/index';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

describe('resolvePath symlink traversal protection', () => {
  let tmpDir: string;
  let workspaceDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spica-resolve-test-'));
    workspaceDir = path.join(tmpDir, 'workspace');
    outsideDir = path.join(tmpDir, 'outside');
    await fs.mkdir(workspaceDir);
    await fs.mkdir(outsideDir);
    await fs.writeFile(path.join(workspaceDir, 'safe.txt'), 'safe content');
    await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'secret content');
    setWorkspace(workspaceDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('should block symlink pointing outside workspace', async () => {
    const symlinkPath = path.join(workspaceDir, 'escape-link');
    const secretPath = path.join(outsideDir, 'secret.txt');
    await fs.symlink(secretPath, symlinkPath);

    const result = await executeTool('read', { path: symlinkPath });

    expect(result.success).toBe(false);
    expect(result.error).toContain('outside workspace');
  });

  it('should block symlink pointing outside workspace via relative path', async () => {
    const symlinkPath = path.join(workspaceDir, 'escape-link-rel');
    await fs.symlink('../outside/secret.txt', symlinkPath);

    const result = await executeTool('read', { path: symlinkPath });

    expect(result.success).toBe(false);
    expect(result.error).toContain('outside workspace');
  });

  it('should block symlink via nested directory traversal', async () => {
    const nestedDir = path.join(workspaceDir, 'nested');
    await fs.mkdir(nestedDir);
    const symlinkPath = path.join(nestedDir, 'escape-link');
    await fs.symlink(path.join(outsideDir, 'secret.txt'), symlinkPath);

    const result = await executeTool('read', { path: symlinkPath });

    expect(result.success).toBe(false);
    expect(result.error).toContain('outside workspace');
  });

  it('should allow symlink pointing inside workspace', async () => {
    const symlinkPath = path.join(workspaceDir, 'safe-link');
    await fs.symlink(path.join(workspaceDir, 'safe.txt'), symlinkPath);

    const result = await executeTool('read', { path: symlinkPath });

    expect(result.success).toBe(true);
    expect(result.content).toContain('safe content');
  });

  it('should allow symlink to directory inside workspace', async () => {
    const subDir = path.join(workspaceDir, 'sub');
    const fileInSub = path.join(subDir, 'inner.txt');
    await fs.mkdir(subDir);
    await fs.writeFile(fileInSub, 'inner content');
    const symlinkPath = path.join(workspaceDir, 'sub-link');
    await fs.symlink(subDir, symlinkPath);

    const result = await executeTool('read', { path: path.join(symlinkPath, 'inner.txt') });

    expect(result.success).toBe(true);
    expect(result.content).toContain('inner content');
  });

  it('should allow normal file read inside workspace', async () => {
    const result = await executeTool('read', { path: path.join(workspaceDir, 'safe.txt') });

    expect(result.success).toBe(true);
    expect(result.content).toContain('safe content');
  });

  it('should block direct path outside workspace (no symlink)', async () => {
    const result = await executeTool('read', { path: path.join(outsideDir, 'secret.txt') });

    expect(result.success).toBe(false);
    expect(result.error).toContain('outside workspace');
  });

  it('should handle non-existent file inside workspace gracefully', async () => {
    const nonExistent = path.join(workspaceDir, 'nonexistent.txt');
    const result = await executeTool('read', { path: nonExistent });

    expect(result.success).toBe(false);
    expect(result.error).not.toContain('outside workspace');
  });

  it('should block non-existent symlink that would point outside workspace', async () => {
    const symlinkPath = path.join(workspaceDir, 'dead-escape-link');
    await fs.symlink(path.join(outsideDir, 'nonexistent.txt'), symlinkPath);

    const result = await executeTool('read', { path: symlinkPath });

    expect(result.success).toBe(false);
    expect(result.error).toContain('outside workspace');
  });

  it('should allow writing new file inside workspace', async () => {
    const newFile = path.join(workspaceDir, 'will-create.txt');
    const result = await executeTool('write', { path: newFile, content: 'new file' });

    expect(result.success).toBe(true);
  });
});
