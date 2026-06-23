import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { analyzeCodeHealth, formatCodeHealthResult } from '../codeHealth';
import * as fs from 'fs-extra';
import * as path from 'path';

describe('analyzeCodeHealth', () => {
  const testDir = path.join(__dirname, 'test-fixtures-health');

  beforeAll(async () => {
    await fs.ensureDir(testDir);
  });

  afterAll(async () => {
    await fs.remove(testDir);
  });

  it('should return perfect score for simple code', async () => {
    const simpleCode = `
function add(a: number, b: number): number {
  return a + b;
}
`;
    const filePath = path.join(testDir, 'simple.ts');
    await fs.writeFile(filePath, simpleCode);

    const result = await analyzeCodeHealth(filePath);

    expect(result.score).toBeGreaterThanOrEqual(9);
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('should detect high complexity', async () => {
    const complexCode = `
function complex(a: number, b: number, c: number, d: number, e: number, f: number): number {
  if (a > 0) {
    if (b > 0) {
      if (c > 0) {
        if (d > 0) {
          if (e > 0) {
            if (f > 0) {
              return a + b + c + d + e + f;
            } else {
              return a + b + c + d + e;
            }
          } else {
            return a + b + c + d;
          }
        } else {
          return a + b + c;
        }
      } else {
        return a + b;
      }
    } else {
      return a;
    }
  } else {
    return 0;
  }
}
`;
    const filePath = path.join(testDir, 'complex.ts');
    await fs.writeFile(filePath, complexCode);

    const result = await analyzeCodeHealth(filePath);

    // Should detect either nesting or complexity issues
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(10);
  });

  it('should detect long functions', async () => {
    const lines: string[] = ['function longFunction(): void {'];
    for (let i = 0; i < 60; i++) {
      lines.push(`  console.log('line ${i}');`);
    }
    lines.push('}');
    const longCode = lines.join('\n');

    const filePath = path.join(testDir, 'long.ts');
    await fs.writeFile(filePath, longCode);

    const result = await analyzeCodeHealth(filePath);

    expect(result.issues.some(i => i.type === 'length')).toBe(true);
  });

  it('should handle non-existent file gracefully', async () => {
    const result = await analyzeCodeHealth('/non/existent/file.ts');

    expect(result.passed).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].message).toContain('does not exist');
  });
});

describe('formatCodeHealthResult', () => {
  it('should format result correctly', () => {
    const result = {
      score: 8.5,
      issues: [
        {
          type: 'complexity' as const,
          location: 'test.ts:10',
          severity: 'medium' as const,
          message: 'High complexity',
          suggestion: 'Refactor',
        },
      ],
      passed: false,
      stats: {
        totalLines: 100,
        totalFunctions: 5,
        avgComplexity: 3.2,
        maxComplexity: 10,
        maxNesting: 3,
        maxParameters: 4,
      },
    };

    const output = formatCodeHealthResult(result);

    expect(output).toContain('8.5/10');
    expect(output).toContain('[FAIL]');
    expect(output).toContain('Total lines: 100');
    expect(output).toContain('complexity');
  });
});
