import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { analyzeTestQuality, formatTestQualityResult } from '../testQuality';
import * as fs from 'fs-extra';
import * as path from 'path';

describe('analyzeTestQuality', () => {
  const testDir = path.join(__dirname, 'test-fixtures-quality');

  beforeAll(async () => {
    await fs.ensureDir(testDir);
  });

  afterAll(async () => {
    await fs.remove(testDir);
  });

  it('should detect over-mocking', async () => {
    const overMockedTest = `
import { describe, it, expect, vi } from 'vitest';

describe('UserService', () => {
  it('should get user', async () => {
    const mockDb = vi.mock('./db');
    const mockCache = vi.mock('./cache');
    const mockLogger = vi.mock('./logger');
    const mockApi = vi.mock('./api');
    const mockAuth = vi.mock('./auth');
    const mockValidator = vi.mock('./validator');
    const mockTransformer = vi.mock('./transformer');
    
    const user = await getUser('123');
    expect(user).toBeDefined();
  });
});
`;
    const filePath = path.join(testDir, 'over-mock.test.ts');
    await fs.writeFile(filePath, overMockedTest);

    const result = await analyzeTestQuality(filePath);

    // Should detect issues (over-mocking or happy-path-only)
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(10);
  });

  it('should detect assertion-free tests', async () => {
    const noAssertionTest = `
import { describe, it } from 'vitest';

describe('BadTest', () => {
  it('does nothing', () => {
    const x = 1 + 1;
    // No assertions!
  });
});
`;
    const filePath = path.join(testDir, 'no-assert.test.ts');
    await fs.writeFile(filePath, noAssertionTest);

    const result = await analyzeTestQuality(filePath);

    // Should have issues (assertion-free tests)
    expect(result.stats.totalTests).toBeGreaterThan(0);
    expect(result.stats.assertionCount).toBe(0);
  });

  it('should detect happy-path only tests', async () => {
    const happyPathOnly = `
import { describe, it, expect } from 'vitest';

describe('UserService', () => {
  it('should create user', () => {
    const user = createUser({ name: 'John' });
    expect(user.name).toBe('John');
  });
  
  it('should update user', () => {
    const user = updateUser('123', { name: 'Jane' });
    expect(user.name).toBe('Jane');
  });
});
`;
    const filePath = path.join(testDir, 'happy-path.test.ts');
    await fs.writeFile(filePath, happyPathOnly);

    const result = await analyzeTestQuality(filePath);

    // Should detect that all tests are happy-path
    expect(result.stats.happyPathTests).toBe(result.stats.totalTests);
    expect(result.stats.errorPathTests).toBe(0);
  });

  it('should pass for good tests', async () => {
    const goodTest = `
import { describe, it, expect } from 'vitest';

describe('Calculator', () => {
  it('should add numbers', () => {
    expect(add(1, 2)).toBe(3);
  });
  
  it('should handle null input', () => {
    expect(() => add(null, 1)).toThrow();
  });
  
  it('should handle empty string', () => {
    expect(add('', 1)).toBeNaN();
  });
});
`;
    const filePath = path.join(testDir, 'good.test.ts');
    await fs.writeFile(filePath, goodTest);

    const result = await analyzeTestQuality(filePath);

    expect(result.score).toBeGreaterThan(5);
  });

  it('should handle non-existent file gracefully', async () => {
    const result = await analyzeTestQuality('/non/existent/file.test.ts');

    expect(result.passed).toBe(false);
    expect(result.issues).toHaveLength(1);
  });
});

describe('formatTestQualityResult', () => {
  it('should format result correctly', () => {
    const result = {
      score: 6.5,
      issues: [
        {
          type: 'over-mocking' as const,
          location: 'test.ts:10',
          severity: 'high' as const,
          message: 'Mock ratio: 85%',
          suggestion: 'Reduce mocking',
        },
      ],
      passed: false,
      stats: {
        totalTests: 5,
        mockCount: 10,
        assertionCount: 8,
        errorPathTests: 2,
        happyPathTests: 3,
        mockRatio: 0.85,
      },
    };

    const output = formatTestQualityResult(result);

    expect(output).toContain('6.5/10');
    expect(output).toContain('[FAIL]');
    expect(output).toContain('Total tests: 5');
    expect(output).toContain('TST-004');
  });
});
