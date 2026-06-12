import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { executeTool, setWorkspace } from '../tools/index';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';

const tmpDir = path.join(os.tmpdir(), 'spica-newtools-test');

describe('New Tools - file_replace and file_insert', () => {
  beforeEach(async () => {
    await fs.ensureDir(tmpDir);
    setWorkspace(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  describe('file_replace', () => {
    it('should replace text using regex', async () => {
      const filePath = path.join(tmpDir, 'replace.txt');
      await fs.writeFile(filePath, 'hello world hello', 'utf-8');

      const result = await executeTool('file_replace', {
        path: filePath,
        pattern: 'hello',
        replacement: 'hi',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('2 match');

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe('hi world hi');
    });

    it('should support regex patterns', async () => {
      const filePath = path.join(tmpDir, 'regex.txt');
      await fs.writeFile(filePath, 'HELLO hello HELLO', 'utf-8');

      const result = await executeTool('file_replace', {
        path: filePath,
        pattern: 'hello',
        replacement: 'hi',
        flags: 'gi',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('3 match');

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe('hi hi hi');
    });

    it('should support capture groups', async () => {
      const filePath = path.join(tmpDir, 'capture.ts');
      await fs.writeFile(filePath, 'function oldFunc() {}', 'utf-8');

      const result = await executeTool('file_replace', {
        path: filePath,
        pattern: 'function (\\w+)\\(',
        replacement: 'const $1 = function(',
      });

      expect(result.success).toBe(true);

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe('const oldFunc = function() {}');
    });

    it('should return error when pattern not found', async () => {
      const filePath = path.join(tmpDir, 'notfound.txt');
      await fs.writeFile(filePath, 'hello world', 'utf-8');

      const result = await executeTool('file_replace', {
        path: filePath,
        pattern: 'notfound',
        replacement: 'x',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Pattern not found');
    });

    it('should return error for invalid regex', async () => {
      const filePath = path.join(tmpDir, 'invalid.txt');
      await fs.writeFile(filePath, 'hello', 'utf-8');

      const result = await executeTool('file_replace', {
        path: filePath,
        pattern: '[invalid',
        replacement: 'x',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid regex');
    });
  });

  describe('file_insert', () => {
    it('should insert at specific line number', async () => {
      const filePath = path.join(tmpDir, 'insert.txt');
      await fs.writeFile(filePath, 'line1\nline2\nline3', 'utf-8');

      const result = await executeTool('file_insert', {
        path: filePath,
        line: 2,
        content: 'inserted',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('line 2');

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe('line1\ninserted\nline2\nline3');
    });

    it('should insert after pattern', async () => {
      const filePath = path.join(tmpDir, 'after.txt');
      await fs.writeFile(filePath, 'function foo() {}\nfunction bar() {}', 'utf-8');

      const result = await executeTool('file_insert', {
        path: filePath,
        after: 'function foo()',
        content: '// comment',
      });

      expect(result.success).toBe(true);

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe('function foo() {}\n// comment\nfunction bar() {}');
    });

    it('should insert before pattern', async () => {
      const filePath = path.join(tmpDir, 'before.txt');
      await fs.writeFile(filePath, 'import a;\nimport b;', 'utf-8');

      const result = await executeTool('file_insert', {
        path: filePath,
        before: 'import b',
        content: 'import c;',
      });

      expect(result.success).toBe(true);

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe('import a;\nimport c;\nimport b;');
    });

    it('should append at end with line 0', async () => {
      const filePath = path.join(tmpDir, 'append.txt');
      await fs.writeFile(filePath, 'existing', 'utf-8');

      const result = await executeTool('file_insert', {
        path: filePath,
        line: 0,
        content: 'appended',
      });

      expect(result.success).toBe(true);

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe('existing\nappended');
    });

    it('should prepend at beginning with line -1', async () => {
      const filePath = path.join(tmpDir, 'prepend.txt');
      await fs.writeFile(filePath, 'existing', 'utf-8');

      const result = await executeTool('file_insert', {
        path: filePath,
        line: -1,
        content: 'prepended',
      });

      expect(result.success).toBe(true);

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe('prepended\nexisting');
    });

    it('should return error when after pattern not found', async () => {
      const filePath = path.join(tmpDir, 'notfound.txt');
      await fs.writeFile(filePath, 'hello', 'utf-8');

      const result = await executeTool('file_insert', {
        path: filePath,
        after: 'notfound',
        content: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Pattern not found');
    });

    it('should return error when no insertion point specified', async () => {
      const filePath = path.join(tmpDir, 'nopoint.txt');
      await fs.writeFile(filePath, 'hello', 'utf-8');

      const result = await executeTool('file_insert', {
        path: filePath,
        content: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Must specify');
    });

    it('should insert multi-line content', async () => {
      const filePath = path.join(tmpDir, 'multi.txt');
      await fs.writeFile(filePath, 'line1\nline2', 'utf-8');

      const result = await executeTool('file_insert', {
        path: filePath,
        line: 1,
        content: 'a\nb',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('2 line');

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe('a\nb\nline1\nline2');
    });
  });
});
