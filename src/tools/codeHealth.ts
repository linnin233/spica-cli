// Code Health Analysis Tool
// Based on Martin Fowler's "Maintainability sensors for coding agents" and industry best practices

import fs from 'fs-extra';
import { resolve as pathResolve } from 'path';

export interface CodeHealthIssue {
  type: 'complexity' | 'nesting' | 'length' | 'parameters' | 'maintainability';
  location: string;
  severity: 'low' | 'medium' | 'high';
  message: string;
  suggestion: string;
}

export interface CodeHealthResult {
  score: number; // 0-10, target >= 9.5
  issues: CodeHealthIssue[];
  passed: boolean; // score >= threshold
  stats: {
    totalLines: number;
    totalFunctions: number;
    avgComplexity: number;
    maxComplexity: number;
    maxNesting: number;
    maxParameters: number;
  };
}

// Thresholds based on Martin Fowler's recommendations for AI-friendly code
const THRESHOLDS = {
  maxCyclomaticComplexity: 10, // McCabe cyclomatic complexity
  maxNestingDepth: 4, // Maximum nesting levels
  maxFunctionLength: 50, // Lines per function
  maxFileLength: 200, // Lines per file
  maxParameters: 5, // Parameters per function
  targetScore: 9.5, // Minimum acceptable score
};

// Calculate cyclomatic complexity for a function (simplified)
function calculateCyclomaticComplexity(code: string): number {
  let complexity = 1; // Base complexity

  // Count decision points
  const decisionPatterns = [
    /\bif\b/g,
    /\belse\s+if\b/g,
    /\bfor\b/g,
    /\bwhile\b/g,
    /\bswitch\b/g,
    /\bcase\b/g,
    /\bcatch\b/g,
    /\?\s*:/g, // ternary operator
    /\b&&\b/g,
    /\b\|\|\b/g,
  ];

  for (const pattern of decisionPatterns) {
    const matches = code.match(pattern);
    if (matches) {
      complexity += matches.length;
    }
  }

  return complexity;
}

// Calculate nesting depth
function calculateNestingDepth(code: string): number {
  let maxDepth = 0;
  let currentDepth = 0;

  const lines = code.split('\n');
  for (const line of lines) {
    // Count opening braces
    const opens = (line.match(/{/g) || []).length;
    const closes = (line.match(/}/g) || []).length;

    currentDepth += opens - closes;
    maxDepth = Math.max(maxDepth, currentDepth);
  }

  return maxDepth;
}

// Count parameters in a function signature
function countParameters(code: string): number {
  // Match function signatures
  const funcMatch = code.match(/(?:function|const|let|var)\s+\w+\s*[=:]\s*(?:async\s*)?\([^)]*\)/);
  if (!funcMatch) return 0;

  const paramsStr = funcMatch[0].match(/\(([^)]*)\)/)?.[1] || '';
  if (!paramsStr.trim()) return 0;

  // Split by comma and count non-empty params
  const params = paramsStr.split(',').filter(p => p.trim() && !p.trim().startsWith('...'));
  return params.length;
}

// Extract function blocks from code
function extractFunctionBlocks(code: string): string[] {
  const blocks: string[] = [];
  const lines = code.split('\n');

  let braceCount = 0;
  let inFunction = false;
  let funcStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect function start: TypeScript/JavaScript patterns
    if (
      line.match(
        /(?:function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\(|=>\s*{|\w+\s*:\s*(?:async\s*)?\function)/
      )
    ) {
      if (!inFunction) {
        inFunction = true;
        funcStart = i;
        braceCount = 0;
      }
    }

    if (inFunction) {
      braceCount += (line.match(/{/g) || []).length;
      braceCount -= (line.match(/}/g) || []).length;

      if (braceCount === 0 && line.includes('}')) {
        blocks.push(lines.slice(funcStart, i + 1).join('\n'));
        inFunction = false;
      }
    }
  }

  return blocks;
}

// Analyze a single file
async function analyzeFile(filePath: string): Promise<CodeHealthIssue[]> {
  const issues: CodeHealthIssue[] = [];
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.split('\n');
  const totalLines = lines.length;

  // Check file length
  if (totalLines > THRESHOLDS.maxFileLength) {
    issues.push({
      type: 'length',
      location: `${filePath}:1`,
      severity: totalLines > THRESHOLDS.maxFileLength * 2 ? 'high' : 'medium',
      message: `File has ${totalLines} lines (max: ${THRESHOLDS.maxFileLength})`,
      suggestion: 'Split into smaller modules or extract helper functions',
    });
  }

  // Extract and analyze functions
  const funcBlocks = extractFunctionBlocks(content);

  for (let idx = 0; idx < funcBlocks.length; idx++) {
    const block = funcBlocks[idx];
    const funcLines = block.split('\n').length;
    const complexity = calculateCyclomaticComplexity(block);
    const nesting = calculateNestingDepth(block);
    const params = countParameters(block);

    // Find approximate line number
    const startLine = content.substring(0, content.indexOf(block)).split('\n').length + 1;

    // Check function length
    if (funcLines > THRESHOLDS.maxFunctionLength) {
      issues.push({
        type: 'length',
        location: `${filePath}:${startLine}`,
        severity: funcLines > THRESHOLDS.maxFunctionLength * 2 ? 'high' : 'medium',
        message: `Function has ${funcLines} lines (max: ${THRESHOLDS.maxFunctionLength})`,
        suggestion: 'Extract into smaller helper functions',
      });
    }

    // Check complexity
    if (complexity > THRESHOLDS.maxCyclomaticComplexity) {
      issues.push({
        type: 'complexity',
        location: `${filePath}:${startLine}`,
        severity: complexity > THRESHOLDS.maxCyclomaticComplexity * 2 ? 'high' : 'medium',
        message: `Cyclomatic complexity: ${complexity} (max: ${THRESHOLDS.maxCyclomaticComplexity})`,
        suggestion: 'Reduce branching by extracting methods or using early returns',
      });
    }

    // Check nesting
    if (nesting > THRESHOLDS.maxNestingDepth) {
      issues.push({
        type: 'nesting',
        location: `${filePath}:${startLine}`,
        severity: nesting > THRESHOLDS.maxNestingDepth + 2 ? 'high' : 'medium',
        message: `Nesting depth: ${nesting} (max: ${THRESHOLDS.maxNestingDepth})`,
        suggestion: 'Extract nested logic into separate functions or use guard clauses',
      });
    }

    // Check parameters
    if (params > THRESHOLDS.maxParameters) {
      issues.push({
        type: 'parameters',
        location: `${filePath}:${startLine}`,
        severity: params > THRESHOLDS.maxParameters + 2 ? 'high' : 'low',
        message: `Parameter count: ${params} (max: ${THRESHOLDS.maxParameters})`,
        suggestion: 'Group related parameters into an object or use options pattern',
      });
    }
  }

  return issues;
}

// Calculate overall score based on issues
function calculateScore(issues: CodeHealthIssue[], stats: CodeHealthResult['stats']): number {
  if (stats.totalFunctions === 0) return 10.0; // No functions = perfect score (trivial file)

  // Weight issues by severity
  const issueWeight = issues.reduce((sum, issue) => {
    const weight = issue.severity === 'high' ? 3 : issue.severity === 'medium' ? 1.5 : 0.5;
    return sum + weight;
  }, 0);

  // Base score from average complexity
  const complexityScore = Math.max(
    0,
    10 - (stats.avgComplexity / THRESHOLDS.maxCyclomaticComplexity) * 5
  );

  // Penalty from issues
  const issuePenalty = issueWeight / stats.totalFunctions;

  // Final score
  const score = Math.max(0, Math.min(10, complexityScore - issuePenalty));
  return Math.round(score * 10) / 10; // Round to 1 decimal
}

// Main analysis function
export async function analyzeCodeHealth(
  targetPath: string,
  threshold: number = THRESHOLDS.targetScore
): Promise<CodeHealthResult> {
  const resolvedPath = pathResolve(targetPath);
  const issues: CodeHealthIssue[] = [];

  // Stats tracking
  let totalLines = 0;
  let totalFunctions = 0;
  let complexitySum = 0;
  let maxComplexity = 0;
  let maxNesting = 0;
  let maxParameters = 0;

  // Check if path exists
  if (!(await fs.pathExists(resolvedPath))) {
    return {
      score: 0,
      issues: [
        {
          type: 'maintainability',
          location: resolvedPath,
          severity: 'high',
          message: 'Path does not exist',
          suggestion: 'Check the file path',
        },
      ],
      passed: false,
      stats: {
        totalLines: 0,
        totalFunctions: 0,
        avgComplexity: 0,
        maxComplexity: 0,
        maxNesting: 0,
        maxParameters: 0,
      },
    };
  }

  // Determine if file or directory
  const stat = await fs.stat(resolvedPath);
  const isDir = stat.isDirectory();

  // Get files to analyze
  const filesToAnalyze: string[] = [];
  if (isDir) {
    // Find source files in directory (non-recursive for simplicity)
    const files = await fs.readdir(resolvedPath);
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.go', '.py', '.rs'];
    for (const file of files) {
      const fullPath = pathResolve(resolvedPath, file);
      const fileStat = await fs.stat(fullPath);
      if (fileStat.isFile()) {
        const ext = file.substring(file.lastIndexOf('.'));
        if (extensions.includes(ext) && !file.includes('.test.') && !file.includes('.spec.')) {
          filesToAnalyze.push(fullPath);
        }
      }
    }
  } else {
    filesToAnalyze.push(resolvedPath);
  }

  // Analyze each file
  for (const file of filesToAnalyze) {
    try {
      const fileIssues = await analyzeFile(file);
      issues.push(...fileIssues);

      // Update stats
      const content = await fs.readFile(file, 'utf-8');
      const lines = content.split('\n');
      totalLines += lines.length;

      // Count functions and update max values
      const funcBlocks = extractFunctionBlocks(content);
      totalFunctions += funcBlocks.length;

      for (const block of funcBlocks) {
        const complexity = calculateCyclomaticComplexity(block);
        const nesting = calculateNestingDepth(block);
        const params = countParameters(block);

        complexitySum += complexity;
        maxComplexity = Math.max(maxComplexity, complexity);
        maxNesting = Math.max(maxNesting, nesting);
        maxParameters = Math.max(maxParameters, params);
      }
    } catch {
      // Skip files that can't be analyzed
    }
  }

  // Calculate stats
  const stats: CodeHealthResult['stats'] = {
    totalLines,
    totalFunctions,
    avgComplexity: totalFunctions > 0 ? Math.round((complexitySum / totalFunctions) * 10) / 10 : 0,
    maxComplexity,
    maxNesting,
    maxParameters,
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
export function formatCodeHealthResult(result: CodeHealthResult): string {
  const lines: string[] = [];

  lines.push(`Code Health Score: ${result.score}/10 (target: >= 9.5)`);
  lines.push(`Status: ${result.passed ? '[PASS]' : '[FAIL]'}`);
  lines.push('');
  lines.push('Stats:');
  lines.push(`  Total lines: ${result.stats.totalLines}`);
  lines.push(`  Total functions: ${result.stats.totalFunctions}`);
  lines.push(`  Avg complexity: ${result.stats.avgComplexity}`);
  lines.push(`  Max complexity: ${result.stats.maxComplexity}`);
  lines.push(`  Max nesting: ${result.stats.maxNesting}`);
  lines.push(`  Max parameters: ${result.stats.maxParameters}`);

  if (result.issues.length > 0) {
    lines.push('');
    lines.push('Issues:');
    for (const issue of result.issues) {
      const severityIcon =
        issue.severity === 'high' ? '[HIGH]' : issue.severity === 'medium' ? '[MED]' : '[LOW]';
      lines.push(`  ${severityIcon} [${issue.type}] ${issue.location}`);
      lines.push(`     ${issue.message}`);
      lines.push(`     Suggestion: ${issue.suggestion}`);
    }
  }

  return lines.join('\n');
}
