import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import * as path from 'path';
import os from 'os';
import { getSystemPrompt } from '../system';

describe('getSystemPrompt learnings', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spica-learnings-test-'));
  });

  afterEach(() => {
    fs.removeSync(tmpDir);
  });

  it('returns prompt without learnings section when no .spica/learnings dir', () => {
    const prompt = getSystemPrompt(undefined, undefined, tmpDir);
    expect(prompt).not.toContain('Project Learnings');
  });

  it('returns prompt without learnings section when learnings dir is empty', () => {
    fs.mkdirpSync(path.join(tmpDir, '.spica', 'learnings'));
    const prompt = getSystemPrompt(undefined, undefined, tmpDir);
    expect(prompt).not.toContain('Project Learnings');
  });

  it('includes learnings content when .md files exist', () => {
    fs.mkdirpSync(path.join(tmpDir, '.spica', 'learnings'));
    fs.writeFileSync(
      path.join(tmpDir, '.spica', 'learnings', '2026-01-01-test.md'),
      '# Test Learning\nAlways use fs-extra.'
    );
    const prompt = getSystemPrompt(undefined, undefined, tmpDir);
    expect(prompt).toContain('Project Learnings');
    expect(prompt).toContain('# Test Learning');
    expect(prompt).toContain('Always use fs-extra.');
  });

  it('concatenates multiple learnings in filename order', () => {
    fs.mkdirpSync(path.join(tmpDir, '.spica', 'learnings'));
    fs.writeFileSync(path.join(tmpDir, '.spica', 'learnings', '2026-01-02-second.md'), 'Second');
    fs.writeFileSync(path.join(tmpDir, '.spica', 'learnings', '2026-01-01-first.md'), 'First');
    const prompt = getSystemPrompt(undefined, undefined, tmpDir);
    const idxFirst = prompt.indexOf('First');
    const idxSecond = prompt.indexOf('Second');
    expect(idxFirst).toBeLessThan(idxSecond);
  });

  it('skips non-.md files', () => {
    fs.mkdirpSync(path.join(tmpDir, '.spica', 'learnings'));
    fs.writeFileSync(path.join(tmpDir, '.spica', 'learnings', 'readme.txt'), 'not markdown');
    const prompt = getSystemPrompt(undefined, undefined, tmpDir);
    expect(prompt).not.toContain('Project Learnings');
  });

  it('returns no learnings when workspacePath is undefined', () => {
    const prompt = getSystemPrompt(undefined, undefined, undefined);
    expect(prompt).not.toContain('Project Learnings');
  });

  it('does not crash on permission errors', () => {
    if (process.platform === 'win32') {
      // chmod does not work on Windows, skip this test
      return;
    }
    fs.mkdirpSync(path.join(tmpDir, '.spica', 'learnings'));
    fs.writeFileSync(path.join(tmpDir, '.spica', 'learnings', '2026-01-01-ok.md'), 'ok');
    // Make the dir unreadable
    fs.chmodSync(path.join(tmpDir, '.spica', 'learnings'), 0o000);
    try {
      const prompt = getSystemPrompt(undefined, undefined, tmpDir);
      // Should not crash, just skip learnings
      expect(prompt).not.toContain('Project Learnings');
    } finally {
      fs.chmodSync(path.join(tmpDir, '.spica', 'learnings'), 0o755);
    }
  });
});
