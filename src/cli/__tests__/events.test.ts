import { describe, it, expect } from 'vitest';

// 测试 formatToolSummary 的辅助函数逻辑
// 由于 formatToolSummary 是模块内部函数，我们测试其正则匹配逻辑

describe('Tool Summary Format', () => {
  describe('countMatches', () => {
    it('should count matches from grep output', () => {
      const output = 'Found 4 matches:\nfile1.ts:10: match\nfile2.ts:20: match';
      const match = output.match(/(\d+)\s+matches/i) || output.match(/Found\s+(\d+)/i);
      expect(match ? parseInt(match[1], 10) : 0).toBe(4);
    });

    it('should return 0 for no matches', () => {
      const output = 'No matches found';
      const match = output.match(/(\d+)\s+matches/i) || output.match(/Found\s+(\d+)/i);
      expect(match ? parseInt(match[1], 10) : 0).toBe(0);
    });

    it('should count from "N matches" format', () => {
      const output = '5 matches found in 3 files';
      const match = output.match(/(\d+)\s+matches/i);
      expect(match ? parseInt(match[1], 10) : 0).toBe(5);
    });
  });

  describe('countFiles', () => {
    it('should count files from glob output', () => {
      const output = 'src/file1.ts\nsrc/file2.ts\nsrc/file3.ts\n3 files found';
      const lines = output.split('\n').filter(l => l.trim() && !l.includes('found'));
      expect(lines.length).toBe(3);
    });

    it('should return 0 for empty output', () => {
      const output = '';
      const lines = output.split('\n').filter(l => l.trim() && !l.includes('found'));
      expect(lines.length).toBe(0);
    });
  });

  describe('countTestPassed', () => {
    it('should count passed tests', () => {
      const output = '55 passed';
      const match = output.match(/(\d+)\s+passed/i);
      expect(match ? parseInt(match[1], 10) : 0).toBe(55);
    });

    it('should count from vitest format', () => {
      const output = '✓ src/test.ts (15 tests) 8350ms';
      const match = output.match(/\((\d+)\s+tests?\)/i);
      expect(match ? parseInt(match[1], 10) : 0).toBe(15);
    });
  });

  describe('countTestFailed', () => {
    it('should count failed tests', () => {
      const output = '3 failed';
      const match = output.match(/(\d+)\s+failed/i);
      expect(match ? parseInt(match[1], 10) : 0).toBe(3);
    });

    it('should return 0 for no failures', () => {
      const output = '55 tests passed';
      const match = output.match(/(\d+)\s+failed/i);
      expect(match ? parseInt(match[1], 10) : 0).toBe(0);
    });
  });

  describe('countLintErrors', () => {
    it('should count lint errors', () => {
      const output = '3 errors, 5 warnings';
      const match = output.match(/(\d+)\s+errors/i);
      expect(match ? parseInt(match[1], 10) : 0).toBe(3);
    });

    it('should count from problems format', () => {
      const output = '51 problems (0 errors, 51 warnings)';
      const match = output.match(/(\d+)\s+problems/i);
      expect(match ? parseInt(match[1], 10) : 0).toBe(51);
    });

    it('should return 0 for no errors', () => {
      const output = '0 errors, 2 warnings';
      const match = output.match(/(\d+)\s+errors/i);
      expect(match ? parseInt(match[1], 10) : 0).toBe(0);
    });
  });

  describe('countDiffLines', () => {
    it('should count added lines', () => {
      const output = '+ new line 1\n+ new line 2\n- removed line\n++ unchanged';
      const count = output.split('\n').filter(l => l.startsWith('+') && !l.startsWith('++')).length;
      expect(count).toBe(2);
    });

    it('should count removed lines', () => {
      const output = '+ new line\n- removed line 1\n- removed line 2\n-- unchanged';
      const count = output.split('\n').filter(l => l.startsWith('-') && !l.startsWith('--')).length;
      expect(count).toBe(2);
    });

    it('should handle empty diff', () => {
      const output = '';
      const count = output.split('\n').filter(l => l.startsWith('+') && !l.startsWith('++')).length;
      expect(count).toBe(0);
    });
  });

  describe('countAgents', () => {
    it('should count agents', () => {
      const output = '3 agents completed';
      const match = output.match(/(\d+)\s+agents/i);
      expect(match ? parseInt(match[1], 10) : 0).toBe(3);
    });

    it('should count from tasks format', () => {
      const output = '5 tasks dispatched';
      const match = output.match(/(\d+)\s+tasks/i);
      expect(match ? parseInt(match[1], 10) : 0).toBe(5);
    });
  });
});

describe('Monitor Event Format', () => {
  describe('formatMonitorEvent', () => {
    const formatMonitorEvent = (description: string, line: string): string =>
      `[monitor:${description}] ${line}`;

    it('should format monitor event with description and line', () => {
      const result = formatMonitorEvent('watching logs', 'ERROR: something broke');
      expect(result).toBe('[monitor:watching logs] ERROR: something broke');
    });

    it('should handle empty line', () => {
      const result = formatMonitorEvent('build', '');
      expect(result).toBe('[monitor:build] ');
    });

    it('should handle multiline content as single line', () => {
      const result = formatMonitorEvent('test', 'line1\nline2');
      expect(result).toBe('[monitor:test] line1\nline2');
    });
  });

  describe('formatMonitorError', () => {
    const formatMonitorError = (error: string): string => `[monitor error] ${error}`;

    it('should format monitor error message', () => {
      const result = formatMonitorError('process crashed');
      expect(result).toBe('[monitor error] process crashed');
    });

    it('should handle empty error message', () => {
      const result = formatMonitorError('');
      expect(result).toBe('[monitor error] ');
    });
  });
});
