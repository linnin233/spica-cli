/**
 * 工具系统核心功能测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import { join } from 'path';
import { TOOLS_DEFINITIONS, executeTool, setWorkspace, getWorkspace } from '../../tools/index';

const TEST_DIR = join(process.cwd(), 'test-tools-temp');
const isWindows = process.platform === 'win32';

describe('Tools System Core Tests', () => {
  // 所有工具定义
  const toolNames = TOOLS_DEFINITIONS.map(t => t.name);

  beforeEach(async () => {
    // 创建测试目录
    await fs.ensureDir(TEST_DIR);
    setWorkspace(TEST_DIR);
  });

  afterEach(async () => {
    // 清理测试目录
    await fs.remove(TEST_DIR);
  });

  describe('Tools Definitions', () => {
    it('should have 30+ tools defined', () => {
      expect(TOOLS_DEFINITIONS.length).toBeGreaterThanOrEqual(30);
    });

    it('should have all required tools', () => {
      const requiredTools = [
        'read',
        'write',
        'edit',
        'file_multi_edit',
        'file_replace',
        'file_insert',
        'file_exists',
        'file_delete',
        'file_copy',
        'file_move',
        'directory_create',
        'directory_list',
        'glob',
        'grep',
        'bash',
        'git',
        'workspace',
        'web_search',
        'web_fetch',
        'question',
        'gh',
        'todo_write',
        'todo_read',
        'task',
        'skill',
        'lint',
        'test',
        'file_patch',
        'format',
      ];

      for (const tool of requiredTools) {
        expect(toolNames).toContain(tool);
      }
    });

    it('should have valid tool definitions', () => {
      for (const tool of TOOLS_DEFINITIONS) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.parameters.type).toBe('object');
        expect(tool.parameters.properties).toBeDefined();
        if (tool.parameters.required) {
          expect(Array.isArray(tool.parameters.required)).toBe(true);
        }
      }
    });
  });

  describe('File Tools', () => {
    it('should write a file', async () => {
      const result = await executeTool('write', {
        path: join(TEST_DIR, 'test.txt'),
        content: 'Hello World',
      });

      expect(result.success).toBe(true);
      expect(await fs.exists(join(TEST_DIR, 'test.txt'))).toBe(true);
      expect(await fs.readFile(join(TEST_DIR, 'test.txt'), 'utf8')).toBe('Hello World');
    });

    it('should read a file', async () => {
      // 先写入文件
      await fs.writeFile(join(TEST_DIR, 'test.txt'), 'Hello World');

      const result = await executeTool('read', {
        path: join(TEST_DIR, 'test.txt'),
      });

      expect(result.success).toBe(true);
      // output 包含文件路径信息，content 字段包含实际内容
      expect(result.content).toContain('Hello World');
    });

    it('should edit a file', async () => {
      // 先写入文件
      await fs.writeFile(join(TEST_DIR, 'test.txt'), 'Hello World');

      const result = await executeTool('edit', {
        path: join(TEST_DIR, 'test.txt'),
        oldString: 'World',
        newString: 'Test',
      });

      expect(result.success).toBe(true);
      expect(await fs.readFile(join(TEST_DIR, 'test.txt'), 'utf8')).toBe('Hello Test');
    });

    it('should multi-edit a file', async () => {
      // 先写入文件
      await fs.writeFile(join(TEST_DIR, 'test.txt'), 'Hello World\nGoodbye World');

      const result = await executeTool('file_multi_edit', {
        path: join(TEST_DIR, 'test.txt'),
        edits: [
          { oldString: 'Hello', newString: 'Hi' },
          { oldString: 'Goodbye', newString: 'Bye' },
        ],
      });

      expect(result.success).toBe(true);
      expect(await fs.readFile(join(TEST_DIR, 'test.txt'), 'utf8')).toBe('Hi World\nBye World');
    });

    it('should replace using regex', async () => {
      // 先写入文件
      await fs.writeFile(join(TEST_DIR, 'test.txt'), 'test123test456test');

      const result = await executeTool('file_replace', {
        path: join(TEST_DIR, 'test.txt'),
        pattern: 'test',
        replacement: 'demo',
        flags: 'g',
      });

      expect(result.success).toBe(true);
      expect(await fs.readFile(join(TEST_DIR, 'test.txt'), 'utf8')).toBe('demo123demo456demo');
    });

    it('should insert content at line', async () => {
      // 先写入文件
      await fs.writeFile(join(TEST_DIR, 'test.txt'), 'Line 1\nLine 2\nLine 3');

      const result = await executeTool('file_insert', {
        path: join(TEST_DIR, 'test.txt'),
        line: 2,
        content: 'Inserted Line',
      });

      expect(result.success).toBe(true);
      const content = await fs.readFile(join(TEST_DIR, 'test.txt'), 'utf8');
      expect(content).toContain('Inserted Line');
    });

    it('should check file exists', async () => {
      // 先写入文件
      await fs.writeFile(join(TEST_DIR, 'test.txt'), 'content');

      const resultExists = await executeTool('file_exists', {
        path: join(TEST_DIR, 'test.txt'),
      });

      const resultNotExists = await executeTool('file_exists', {
        path: join(TEST_DIR, 'notexist.txt'),
      });

      expect(resultExists.success).toBe(true);
      expect(resultExists.output).toContain('exists');
      expect(resultNotExists.success).toBe(true);
      expect(resultNotExists.output).toContain('not found');
    });

    it('should copy a file', async () => {
      // 先写入文件
      await fs.writeFile(join(TEST_DIR, 'source.txt'), 'content');

      const result = await executeTool('file_copy', {
        source: join(TEST_DIR, 'source.txt'),
        destination: join(TEST_DIR, 'copy.txt'),
      });

      expect(result.success).toBe(true);
      expect(await fs.exists(join(TEST_DIR, 'copy.txt'))).toBe(true);
    });

    it('should move a file', async () => {
      // 先写入文件
      await fs.writeFile(join(TEST_DIR, 'source.txt'), 'content');

      const result = await executeTool('file_move', {
        source: join(TEST_DIR, 'source.txt'),
        destination: join(TEST_DIR, 'moved.txt'),
      });

      expect(result.success).toBe(true);
      expect(await fs.exists(join(TEST_DIR, 'moved.txt'))).toBe(true);
      expect(await fs.exists(join(TEST_DIR, 'source.txt'))).toBe(false);
    });

    it('should delete a file', async () => {
      // 先写入文件
      await fs.writeFile(join(TEST_DIR, 'test.txt'), 'content');

      const result = await executeTool('file_delete', {
        path: join(TEST_DIR, 'test.txt'),
      });

      expect(result.success).toBe(true);
      expect(await fs.exists(join(TEST_DIR, 'test.txt'))).toBe(false);
    });
  });

  describe('Directory Tools', () => {
    it('should create a directory', async () => {
      const result = await executeTool('directory_create', {
        path: join(TEST_DIR, 'subdir'),
      });

      expect(result.success).toBe(true);
      expect(await fs.exists(join(TEST_DIR, 'subdir'))).toBe(true);
    });

    it('should create nested directories', async () => {
      const result = await executeTool('directory_create', {
        path: join(TEST_DIR, 'deep', 'nested', 'dir'),
      });

      expect(result.success).toBe(true);
      expect(await fs.exists(join(TEST_DIR, 'deep', 'nested', 'dir'))).toBe(true);
    });

    it('should list directory contents', async () => {
      // 创建一些文件
      await fs.writeFile(join(TEST_DIR, 'file1.txt'), 'content');
      await fs.writeFile(join(TEST_DIR, 'file2.txt'), 'content');
      await fs.ensureDir(join(TEST_DIR, 'subdir'));

      const result = await executeTool('directory_list', {
        path: TEST_DIR,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('file1.txt');
      expect(result.output).toContain('file2.txt');
      expect(result.output).toContain('subdir');
    });
  });

  describe('Search Tools', () => {
    it('should glob files', async () => {
      // 创建一些文件
      await fs.writeFile(join(TEST_DIR, 'test.ts'), 'content');
      await fs.writeFile(join(TEST_DIR, 'test.js'), 'content');
      await fs.writeFile(join(TEST_DIR, 'test.txt'), 'content');

      const result = await executeTool('glob', {
        pattern: '*.ts',
        path: TEST_DIR,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('test.ts');
      expect(result.output).not.toContain('test.js');
      expect(result.output).not.toContain('test.txt');
    });

    it('should grep content', async () => {
      // 创建一些文件
      await fs.writeFile(join(TEST_DIR, 'file1.txt'), 'Hello World');
      await fs.writeFile(join(TEST_DIR, 'file2.txt'), 'Goodbye World');

      const result = await executeTool('grep', {
        pattern: 'Hello',
        path: TEST_DIR,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('file1.txt');
    });
  });

  describe('AST Search and Replace Tools', () => {
    it('should search code by AST pattern', async () => {
      await fs.writeFile(
        join(TEST_DIR, 'test.ts'),
        'const x = 1;\nconsole.log("Hello World");\nconst y = 2;\nconsole.log("Another log");\n'
      );

      const result = await executeTool('ast_search', {
        pattern: 'console.log($A)',
        lang: 'ts',
        path: TEST_DIR,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('console.log("Hello World")');
      expect(result.output).toContain('console.log("Another log")');
    });

    it('should capture meta variables in AST search', async () => {
      await fs.writeFile(
        join(TEST_DIR, 'test.ts'),
        'const x = 1;\nconst y = 2;\n'
      );

      const result = await executeTool('ast_search', {
        pattern: 'const $VAR = $VALUE',
        lang: 'ts',
        path: TEST_DIR,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('x');
      expect(result.output).toContain('y');
    });

    it('should report no matches for AST search', async () => {
      await fs.writeFile(
        join(TEST_DIR, 'test.ts'),
        'console.error("test");\n'
      );

      const result = await executeTool('ast_search', {
        pattern: 'console.log($A)',
        lang: 'ts',
        path: TEST_DIR,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('No matches found');
    });

    it('should do dry-run replace (no confirm)', async () => {
      await fs.writeFile(
        join(TEST_DIR, 'test.ts'),
        'var a = 1;\nvar b = 2;\n'
      );

      const result = await executeTool('ast_replace', {
        pattern: 'var $X = $Y',
        rewrite: 'const $X = $Y',
        lang: 'ts',
        path: TEST_DIR,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('would replace');
      // 文件不应该被修改
      const content = await fs.readFile(join(TEST_DIR, 'test.ts'), 'utf-8');
      expect(content).toContain('var a = 1');
    });

    it('should replace with confirm:true', async () => {
      await fs.writeFile(
        join(TEST_DIR, 'test.ts'),
        'var a = 1;\nvar b = 2;\n'
      );

      const result = await executeTool('ast_replace', {
        pattern: 'var $X = $Y',
        rewrite: 'const $X = $Y',
        lang: 'ts',
        path: TEST_DIR,
        confirm: true,
      });

      expect(result.success).toBe(true);
      const content = await fs.readFile(join(TEST_DIR, 'test.ts'), 'utf-8');
      expect(content).toContain('const a = 1');
      expect(content).not.toContain('var a = 1');
    });

    it('should handle ast_replace with no matches', async () => {
      await fs.writeFile(
        join(TEST_DIR, 'test.ts'),
        'const x = 1;\n'
      );

      const result = await executeTool('ast_replace', {
        pattern: 'var $X = $Y',
        rewrite: 'const $X = $Y',
        lang: 'ts',
        path: TEST_DIR,
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('No matches');
    });

    it('should auto-detect language from file extension', async () => {
      await fs.writeFile(
        join(TEST_DIR, 'test.ts'),
        'const x = 1;\nconsole.log("Hello");\n'
      );

      const result = await executeTool('ast_search', {
        pattern: 'console.log($A)',
        path: TEST_DIR,
        glob: '*.ts',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('console.log');
    });
  });

  describe('Bash Tool', () => {
    it('should execute simple command', async () => {
      const result = await executeTool('bash', {
        command: 'echo "Hello"',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Hello');
    });

    it.skipIf(isWindows)('should execute command with working directory', async () => {
      const result = await executeTool('bash', {
        command: 'pwd',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain(TEST_DIR);
    });
  });

  describe('Workspace Tool', () => {
    it('should get current workspace', () => {
      const workspace = getWorkspace();
      expect(workspace).toBe(TEST_DIR);
    });

    it('should set workspace', () => {
      setWorkspace('/tmp');
      expect(getWorkspace()).toBe('/tmp');
      // 恢复
      setWorkspace(TEST_DIR);
      expect(getWorkspace()).toBe(TEST_DIR);
    });
  });

  describe('Todo Tools', () => {
    it('should write todos', async () => {
      const result = await executeTool('todo_write', {
        todos: [
          { content: 'Task 1', status: 'pending' },
          { content: 'Task 2', status: 'in_progress' },
        ],
      });

      expect(result.success).toBe(true);
    });

    it('should read todos', async () => {
      // 先写入
      await executeTool('todo_write', {
        todos: [{ content: 'Task 1', status: 'pending' }],
      });

      const result = await executeTool('todo_read', {});

      expect(result.success).toBe(true);
    });
  });

  describe('Syntax Check', () => {
    it('should detect syntax errors in TypeScript', async () => {
      const result = await executeTool('write', {
        path: join(TEST_DIR, 'test.ts'),
        content: 'const x = ;', // Syntax error
      });

      expect(result.success).toBe(true);
      // 应该返回语法错误
      expect(result.syntaxErrors).toBeDefined();
      expect(result.syntaxErrors?.length).toBeGreaterThan(0);
    });

    it('should not report errors for valid TypeScript', async () => {
      const result = await executeTool('write', {
        path: join(TEST_DIR, 'test.ts'),
        content: 'const x = 1;',
      });

      expect(result.success).toBe(true);
      expect(result.syntaxErrors).toBeUndefined();
    });
  });

  describe('Chinese Content Support', () => {
    it('should write Chinese content', async () => {
      const result = await executeTool('write', {
        path: join(TEST_DIR, 'chinese.txt'),
        content: '你好世界',
      });

      expect(result.success).toBe(true);
      expect(await fs.readFile(join(TEST_DIR, 'chinese.txt'), 'utf8')).toBe('你好世界');
    });

    it('should read Chinese content', async () => {
      await fs.writeFile(join(TEST_DIR, 'chinese.txt'), '你好世界');

      const result = await executeTool('read', {
        path: join(TEST_DIR, 'chinese.txt'),
      });

      expect(result.success).toBe(true);
      // output 包含文件路径信息，content 字段包含实际内容
      expect(result.content).toContain('你好世界');
    });

    it('should edit Chinese content', async () => {
      await fs.writeFile(join(TEST_DIR, 'chinese.txt'), '你好世界');

      const result = await executeTool('edit', {
        path: join(TEST_DIR, 'chinese.txt'),
        oldString: '你好',
        newString: '再见',
      });

      expect(result.success).toBe(true);
      expect(await fs.readFile(join(TEST_DIR, 'chinese.txt'), 'utf8')).toBe('再见世界');
    });
  });
});
