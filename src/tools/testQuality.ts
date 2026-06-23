// Test Quality Analysis Tool
// Based on VibeDoctor's testing anti-patterns and arXiv paper "Are Coding Agents Generating Over-Mocked Tests?"

import fs from 'fs-extra';
import { resolve as pathResolve } from 'path';

export interface TestQualityIssue {
  type:
    | 'over-mocking'
    | 'happy-path-only'
    | 'assertion-free'
    | 'incomplete-mock'
    | 'test-only-method';
  location: string;
  severity: 'low' | 'medium' | 'high';
  message: string;
  suggestion: string;
}

export interface TestQualityResult {
  score: number; // 0-10
  issues: TestQualityIssue[];
  passed: boolean; // score >= threshold
  stats: {
    totalTests: number;
    mockCount: number;
    assertionCount: number;
    errorPathTests: number;
    happyPathTests: number;
    mockRatio: number; // mock calls / total calls
  };
}

// Thresholds based on industry research
const THRESHOLDS = {
  maxMockRatio: 0.7, // Max 70% mock calls (TST-004)
  minAssertionPerTest: 1, // At least 1 assertion per test (TST-008)
  minErrorPathRatio: 0.3, // At least 30% error path tests (TST-005)
  targetScore: 7.0, // Minimum acceptable score
};

// Count mock calls in test code
function countMockCalls(code: string): number {
  const mockPatterns = [
    /vi\.mock\(/g,
    /jest\.mock\(/g,
    /mockResolvedValue\(/g,
    /mockRejectedValue\(/g,
    /mockReturnValue\(/g,
    /mockImplementation\(/g,
    /\.mock\(/g,
    /sinon\.mock\(/g,
  ];

  let count = 0;
  for (const pattern of mockPatterns) {
    const matches = code.match(pattern);
    if (matches) {
      count += matches.length;
    }
  }

  return count;
}

// Count assertions in test code
function countAssertions(code: string): number {
  const assertionPatterns = [
    /expect\(/g,
    /assert\(/g,
    /should\./g,
    /\.toBe\(/g,
    /\.toEqual\(/g,
    /\.toThrow\(/g,
    /\.toBeTruthy\(/g,
    /\.toBeFalsy\(/g,
    /\.toContain\(/g,
    /\.toMatch\(/g,
  ];

  let count = 0;
  for (const pattern of assertionPatterns) {
    const matches = code.match(pattern);
    if (matches) {
      count += matches.length;
    }
  }

  return count;
}

// Extract test blocks from code
function extractTestBlocks(code: string): { name: string; code: string; startLine: number }[] {
  const blocks: { name: string; code: string; startLine: number }[] = [];
  const lines = code.split('\n');

  // Match test patterns: it(), test() blocks (with optional leading whitespace)
  const testPattern = /^\s*(?:it|test)\s*\(\s*['"`]([^'"`]+)['"`]/;

  let braceCount = 0;
  let inTest = false;
  let testStart = 0;
  let testName = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect test start
    const match = line.match(testPattern);
    if (match && !inTest) {
      testName = match[1];
      inTest = true;
      testStart = i;
      braceCount = 0;
    }

    if (inTest) {
      braceCount += (line.match(/{/g) || []).length;
      braceCount -= (line.match(/}/g) || []).length;

      if (braceCount === 0 && line.includes('}')) {
        blocks.push({
          name: testName,
          code: lines.slice(testStart, i + 1).join('\n'),
          startLine: testStart + 1,
        });
        inTest = false;
      }
    }
  }

  return blocks;
}

// Check if test is happy-path only (no error/error handling assertions)
function isHappyPathOnly(testCode: string): boolean {
  const errorPatterns = [
    /toThrow\(/g,
    /rejects\./g,
    /\.catch\(/g,
    /Error/g,
    /fail/g,
    /invalid/g,
    /missing/g,
    /null/g,
    /undefined/g,
    /empty/g,
    /boundary/g,
    /edge/g,
  ];

  for (const pattern of errorPatterns) {
    if (pattern.test(testCode)) {
      return false;
    }
  }

  return true;
}

// Analyze a single test file
async function analyzeTestFile(filePath: string): Promise<TestQualityIssue[]> {
  const issues: TestQualityIssue[] = [];
  const content = await fs.readFile(filePath, 'utf-8');

  // Count mocks and assertions globally
  const mockCount = countMockCalls(content);
  const _assertionCount = countAssertions(content); // Used for stats

  // Check over-mocking (TST-004)
  if (mockCount > 5) {
    // Count non-mock function calls (rough estimate)
    const functionCalls = (content.match(/\w+\.\w+\(/g) || []).length;
    const mockRatio = mockCount / (functionCalls || mockCount);

    if (mockRatio > THRESHOLDS.maxMockRatio) {
      issues.push({
        type: 'over-mocking',
        location: `${filePath}:1`,
        severity: mockRatio > 0.9 ? 'high' : 'medium',
        message: `Mock ratio: ${Math.round(mockRatio * 100)}% (${mockCount} mocks, ${functionCalls} total calls)`,
        suggestion:
          'Reduce mocking. Only mock external services (APIs, payment gateways). Use real implementations for internal code.',
      });
    }
  }

  // Extract individual tests
  const testBlocks = extractTestBlocks(content);

  for (const test of testBlocks) {
    const testAssertions = countAssertions(test.code);
    const _testMocks = countMockCalls(test.code); // Used for stats

    // Check assertion-free tests (TST-008)
    if (testAssertions < THRESHOLDS.minAssertionPerTest) {
      issues.push({
        type: 'assertion-free',
        location: `${filePath}:${test.startLine}`,
        severity: 'high',
        message: `Test "${test.name}" has no assertions`,
        suggestion:
          'Add expect() or assert() calls. Use expect.hasAssertions() to enforce assertions.',
      });
    }

    // Check happy-path only (TST-005)
    if (isHappyPathOnly(test.code) && testAssertions > 0) {
      issues.push({
        type: 'happy-path-only',
        location: `${filePath}:${test.startLine}`,
        severity: 'medium',
        message: `Test "${test.name}" only tests success path`,
        suggestion:
          'Add tests for error cases: invalid inputs, null values, network failures, edge cases.',
      });
    }

    // Check incomplete mocks (mock returns partial data)
    const mockReturns = test.code.match(/mockResolvedValue\(\s*{([^}]+)}\s*\)/g) || [];
    for (const mockReturn of mockReturns) {
      // Check if mock returns very simple object (potential incomplete mock)
      const mockObj = mockReturn.match(/{([^}]+)}/)?.[1] || '';
      if (mockObj.length < 20 && mockObj.includes(':') && !mockObj.includes(',')) {
        // Single field mock - potentially incomplete
        issues.push({
          type: 'incomplete-mock',
          location: `${filePath}:${test.startLine}`,
          severity: 'low',
          message: `Mock returns minimal data: ${mockObj}`,
          suggestion:
            'Mirror real API response structure. Include all fields that downstream code might use.',
        });
      }
    }
  }

  // Check for test-only methods in production code (if source file exists)
  const sourceFilePath = filePath.replace('.test.', '.').replace('.spec.', '.');
  if (await fs.pathExists(sourceFilePath)) {
    const sourceContent = await fs.readFile(sourceFilePath, 'utf-8');

    // Look for methods that might be test-only (common patterns)
    const testOnlyPatterns = [
      /_test\w*\(/g,
      /__test\w*\(/g,
      /resetForTest\(/g,
      /clearForTest\(/g,
      /setupForTest\(/g,
    ];

    for (const pattern of testOnlyPatterns) {
      if (pattern.test(sourceContent)) {
        issues.push({
          type: 'test-only-method',
          location: sourceFilePath,
          severity: 'medium',
          message: 'Found potential test-only method in production code',
          suggestion:
            'Move test utilities to separate test helper files. Never add test-only methods to production classes.',
        });
      }
    }
  }

  return issues;
}

// Calculate overall score
function calculateScore(issues: TestQualityIssue[], stats: TestQualityResult['stats']): number {
  // Base score
  let score = 10.0;

  // Penalty for over-mocking
  if (stats.mockRatio > THRESHOLDS.maxMockRatio) {
    score -= (stats.mockRatio - THRESHOLDS.maxMockRatio) * 5;
  }

  // Penalty for assertion-free tests
  const assertionFreeCount = issues.filter(i => i.type === 'assertion-free').length;
  if (stats.totalTests > 0) {
    score -= (assertionFreeCount / stats.totalTests) * 3;
  }

  // Penalty for happy-path only tests
  const happyPathRatio = stats.happyPathTests / (stats.totalTests || 1);
  if (happyPathRatio > 1 - THRESHOLDS.minErrorPathRatio) {
    score -= (happyPathRatio - (1 - THRESHOLDS.minErrorPathRatio)) * 2;
  }

  // Penalty from issue severity
  const issueWeight = issues.reduce((sum, issue) => {
    const weight = issue.severity === 'high' ? 2 : issue.severity === 'medium' ? 1 : 0.3;
    return sum + weight;
  }, 0);
  score -= issueWeight * 0.2;

  return Math.max(0, Math.min(10, Math.round(score * 10) / 10));
}

// Main analysis function
export async function analyzeTestQuality(
  targetPath: string,
  threshold: number = THRESHOLDS.targetScore
): Promise<TestQualityResult> {
  const resolvedPath = pathResolve(targetPath);
  const issues: TestQualityIssue[] = [];

  // Stats tracking
  let totalTests = 0;
  let mockCount = 0;
  let assertionCount = 0;
  let happyPathTests = 0;
  let errorPathTests = 0;

  // Check if path exists
  if (!(await fs.pathExists(resolvedPath))) {
    return {
      score: 0,
      issues: [
        {
          type: 'assertion-free',
          location: resolvedPath,
          severity: 'high',
          message: 'Test file does not exist',
          suggestion: 'Check the file path',
        },
      ],
      passed: false,
      stats: {
        totalTests: 0,
        mockCount: 0,
        assertionCount: 0,
        errorPathTests: 0,
        happyPathTests: 0,
        mockRatio: 0,
      },
    };
  }

  // Analyze test file
  const fileIssues = await analyzeTestFile(resolvedPath);
  issues.push(...fileIssues);

  // Get stats from file
  const content = await fs.readFile(resolvedPath, 'utf-8');
  const testBlocks = extractTestBlocks(content);
  totalTests = testBlocks.length;

  for (const test of testBlocks) {
    mockCount += countMockCalls(test.code);
    assertionCount += countAssertions(test.code);

    if (isHappyPathOnly(test.code)) {
      happyPathTests++;
    } else {
      errorPathTests++;
    }
  }

  // Calculate mock ratio
  const functionCalls = (content.match(/\w+\.\w+\(/g) || []).length;
  const mockRatio = functionCalls > 0 ? mockCount / functionCalls : 0;

  const stats: TestQualityResult['stats'] = {
    totalTests,
    mockCount,
    assertionCount,
    errorPathTests,
    happyPathTests,
    mockRatio: Math.round(mockRatio * 100) / 100,
  };

  // Calculate score
  const score = calculateScore(issues, stats);

  return {
    score,
    issues,
    passed: score >= threshold,
    stats,
  };
}

// Format result for display
export function formatTestQualityResult(result: TestQualityResult): string {
  const lines: string[] = [];

  lines.push(`Test Quality Score: ${result.score}/10 (target: >= 7.0)`);
  lines.push(`Status: ${result.passed ? '[PASS]' : '[FAIL]'}`);
  lines.push('');
  lines.push('Stats:');
  lines.push(`  Total tests: ${result.stats.totalTests}`);
  lines.push(`  Mock calls: ${result.stats.mockCount}`);
  lines.push(`  Assertions: ${result.stats.assertionCount}`);
  lines.push(`  Mock ratio: ${Math.round(result.stats.mockRatio * 100)}%`);
  lines.push(`  Happy-path tests: ${result.stats.happyPathTests}`);
  lines.push(`  Error-path tests: ${result.stats.errorPathTests}`);

  if (result.issues.length > 0) {
    lines.push('');
    lines.push('Issues (Anti-Patterns):');
    for (const issue of result.issues) {
      const severityIcon =
        issue.severity === 'high' ? '[HIGH]' : issue.severity === 'medium' ? '[MED]' : '[LOW]';
      const typeLabel =
        {
          'over-mocking': 'TST-004',
          'happy-path-only': 'TST-005',
          'assertion-free': 'TST-008',
          'incomplete-mock': 'TST-006',
          'test-only-method': 'TST-007',
        }[issue.type] || issue.type;

      lines.push(`  ${severityIcon} [${typeLabel}] ${issue.location}`);
      lines.push(`     ${issue.message}`);
      lines.push(`     Suggestion: ${issue.suggestion}`);
    }
  }

  return lines.join('\n');
}
