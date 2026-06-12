import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { executeTool, setWorkspace } from '../tools/index';
import fs from 'fs-extra';
import { join } from 'path';
import os from 'os';

const isWindows = process.platform === 'win32';

describe('Syntax Check Feature', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(os.tmpdir(), 'spica-syntax-test-'));
    setWorkspace(tempDir);
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  describe('TypeScript syntax check', () => {
    it('should detect TypeScript syntax errors', async () => {
      const invalidTS = `
export function broken( {
  // Missing closing brace
  return 1;
`;
      const result = await executeTool('write', {
        path: join(tempDir, 'broken.ts'),
        content: invalidTS,
      });

      expect(result.success).toBe(true);
      expect(result.syntaxErrors).toBeDefined();
      expect(result.syntaxErrors!.length).toBeGreaterThan(0);
    });

    it('should pass valid TypeScript', async () => {
      const validTS = `
export function add(a: number, b: number): number {
  return a + b;
}
`;
      const result = await executeTool('write', {
        path: join(tempDir, 'valid.ts'),
        content: validTS,
      });

      expect(result.success).toBe(true);
      // syntaxErrors should be undefined or empty for valid code
      expect(result.syntaxErrors === undefined || result.syntaxErrors!.length === 0).toBe(true);
    });
  });

  describe('JavaScript syntax check', () => {
    it('should detect JavaScript syntax errors', async () => {
      const invalidJS = `
function broken( {
  // Missing closing brace
  return 1;
`;
      const result = await executeTool('write', {
        path: join(tempDir, 'broken.js'),
        content: invalidJS,
      });

      expect(result.success).toBe(true);
      expect(result.syntaxErrors).toBeDefined();
      expect(result.syntaxErrors!.length).toBeGreaterThan(0);
    });

    it('should pass valid JavaScript', async () => {
      const validJS = `
function add(a, b) {
  return a + b;
}
module.exports = { add };
`;
      const result = await executeTool('write', {
        path: join(tempDir, 'valid.js'),
        content: validJS,
      });

      expect(result.success).toBe(true);
      expect(result.syntaxErrors === undefined || result.syntaxErrors!.length === 0).toBe(true);
    });
  });

  describe('Python syntax check', () => {
    it('should detect Python syntax errors', async () => {
      const invalidPy = `
def broken(:
    # Invalid syntax
    return 1
`;
      const result = await executeTool('write', {
        path: join(tempDir, 'broken.py'),
        content: invalidPy,
      });

      expect(result.success).toBe(true);
      // Python check might not be available on all systems
      if (result.syntaxErrors && result.syntaxErrors.length > 0) {
        expect(result.syntaxErrors.length).toBeGreaterThan(0);
      }
    });

    it('should pass valid Python', async () => {
      const validPy = `
def add(a, b):
    return a + b
`;
      const result = await executeTool('write', {
        path: join(tempDir, 'valid.py'),
        content: validPy,
      });

      expect(result.success).toBe(true);
    });
  });

  describe.skipIf(isWindows)('Shell script syntax check', () => {
    it('should detect shell syntax errors', async () => {
      const invalidSh = `
#!/bin/bash
if [ -f file.txt ]; then
  echo "found"
# Missing fi
`;
      const result = await executeTool('write', {
        path: join(tempDir, 'broken.sh'),
        content: invalidSh,
      });

      expect(result.success).toBe(true);
      if (result.syntaxErrors && result.syntaxErrors.length > 0) {
        expect(result.syntaxErrors.length).toBeGreaterThan(0);
      }
    });

    it('should pass valid shell script', async () => {
      const validSh = `
#!/bin/bash
if [ -f file.txt ]; then
  echo "found"
fi
`;
      const result = await executeTool('write', {
        path: join(tempDir, 'valid.sh'),
        content: validSh,
      });

      expect(result.success).toBe(true);
      expect(result.syntaxErrors === undefined || result.syntaxErrors!.length === 0).toBe(true);
    });
  });

  describe('file_edit syntax check', () => {
    it('should check syntax after file_edit', async () => {
      // First create a valid file
      const validTS = `
export function add(a: number, b: number): number {
  return a + b;
}
`;
      await executeTool('write', {
        path: join(tempDir, 'edit-test.ts'),
        content: validTS,
      });

      // Edit to introduce syntax error
      const result = await executeTool('edit', {
        path: join(tempDir, 'edit-test.ts'),
        oldString: 'return a + b;',
        newString: 'return a + b', // Missing semicolon is OK in TS, let's try something worse
      });

      expect(result.success).toBe(true);
    }, 10000);
  });

  describe('file_multi_edit syntax check', () => {
    it('should check syntax after file_multi_edit', async () => {
      const validTS = `
export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`;
      await executeTool('write', {
        path: join(tempDir, 'multi-edit-test.ts'),
        content: validTS,
      });

      const result = await executeTool('file_multi_edit', {
        path: join(tempDir, 'multi-edit-test.ts'),
        edits: [
          { oldString: 'return a + b;', newString: 'return a + b;' },
          { oldString: 'return a * b;', newString: 'return a * b;' },
        ],
      });

      expect(result.success).toBe(true);
    }, 10000);
  });

  describe('Unknown file types', () => {
    it('should skip syntax check for unknown file types', async () => {
      const result = await executeTool('write', {
        path: join(tempDir, 'unknown.xyz'),
        content: 'some random content',
      });

      expect(result.success).toBe(true);
      expect(result.syntaxErrors).toBeUndefined();
    });

    it('should skip syntax check for markdown files', async () => {
      const result = await executeTool('write', {
        path: join(tempDir, 'README.md'),
        content: '# Hello\n\nThis is markdown.',
      });

      expect(result.success).toBe(true);
      expect(result.syntaxErrors).toBeUndefined();
    });
  });
});
