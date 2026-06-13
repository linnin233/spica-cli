// SubAgent type definitions and configuration

export type SubAgentType = 'explore' | 'review' | 'fix' | 'build';

export interface SubAgentResult {
  status: 'DONE' | 'DONE_WITH_CONCERNS' | 'NEEDS_CONTEXT' | 'BLOCKED';
  output?: string;
  concerns?: string[];
  neededContext?: string[];
  blocker?: string;
  success: boolean;
}

export interface SubAgentTask {
  prompt: string;
  description?: string;
  type?: SubAgentType;
  skill?: string;
  model?: string; // Optional model override for this task (e.g., 'haiku' for mechanical, 'opus' for design)
  isolation?: 'worktree'; // Run in an isolated git worktree to prevent file conflicts
}

export interface SubAgentConfig {
  allowedTools: string[] | '*'; // Allowed tools, '*' means all
  timeout: number; // Timeout in milliseconds (base, adjusted by task complexity)
  description: string; // Type description
}

// Base timeouts — floors that adapt upward based on task complexity.
// Prompt length is used as a complexity proxy: longer prompts → more work.
const BASE_TIMEOUTS: Record<SubAgentType, number> = {
  explore: 90_000,
  review: 120_000,
  fix: 180_000,
  build: 300_000,
};

const MAX_TIMEOUTS: Record<SubAgentType, number> = {
  explore: 180_000,   // 2× base
  review: 240_000,    // 2× base
  fix: 360_000,       // 2× base
  build: 600_000,     // 2× base
};

/** Compute adaptive timeout: base + prompt-length bonus, capped at 2× base. */
export function computeTimeout(type: SubAgentType, promptLength: number): number {
  const base = BASE_TIMEOUTS[type] || 120_000;
  const max = MAX_TIMEOUTS[type] || base * 2;

  // Each 100 chars over 500 adds 10% to the base timeout
  const complexityBonus = Math.max(0, (promptLength - 500) / 100) * (base * 0.10);
  return Math.min(max, Math.floor(base + complexityBonus));
}

export const SUB_AGENT_CONFIGS: Record<SubAgentType, SubAgentConfig> = {
  explore: {
    allowedTools: ['glob', 'grep', 'read', 'directory_list', 'file_exists'],
    timeout: BASE_TIMEOUTS.explore,
    description: 'Read-only exploration, locate files and code',
  },
  review: {
    allowedTools: ['glob', 'grep', 'read', 'directory_list', 'lint', 'file_exists'],
    timeout: BASE_TIMEOUTS.review,
    description: 'Code review, find issues',
  },
  fix: {
    allowedTools: ['read', 'edit', 'bash', 'lint'],
    timeout: BASE_TIMEOUTS.fix,
    description: 'Fix specific issues, minimal changes',
  },
  build: {
    allowedTools: '*', // All tools
    timeout: BASE_TIMEOUTS.build,
    description: 'Full feature implementation',
  },
};

// Get subagent config
export function getSubAgentConfig(type?: SubAgentType): SubAgentConfig {
  if (!type) {
    // Default: full access
    return {
      allowedTools: '*',
      timeout: 120000,
      description: 'General purpose subagent',
    };
  }
  return SUB_AGENT_CONFIGS[type];
}

// 检查工具是否允许
export function isToolAllowed(toolName: string, config: SubAgentConfig): boolean {
  if (config.allowedTools === '*') return true;
  if (!config.allowedTools) return false; // 保护
  return config.allowedTools.includes(toolName);
}

// Summarize result — extract key information from sub-agent output
export function summarizeResult(result: string, maxLength: number = 400): string {
  if (!result || result.length <= maxLength) return result || '';

  const lines = result.split('\n');

  // Signal words that indicate important lines (case-insensitive)
  const signalPatterns = [
    /✓/,
    /✗/,
    /✅/,
    /❌/,
    /⚠️/,
    /🔴/,
    /🟢/,
    /error/i,
    /fail/i,
    /success/i,
    /done/i,
    /complete/i,
    /pass/i,
    /build/i,
    /found/i,
    /result/i,
    /fix/i,
    /issue/i,
    /warning/i,
    /critical/i,
  ];

  const isSignalLine = (l: string): boolean => signalPatterns.some(p => p.test(l));

  const keyLines = lines.filter(isSignalLine);

  if (keyLines.length > 0) {
    // Take up to 5 key lines, prefer first and last
    const selected =
      keyLines.length <= 5 ? keyLines : [...keyLines.slice(0, 3), ...keyLines.slice(-2)];
    return selected.join('\n').slice(0, maxLength);
  }

  // No signal lines — try structural extraction
  // Take first non-empty paragraph (lines until blank line)
  const firstParagraph: string[] = [];
  for (const l of lines) {
    if (l.trim() === '' && firstParagraph.length > 0) break;
    if (l.trim()) firstParagraph.push(l);
    if (firstParagraph.join('\n').length > maxLength) break;
  }
  if (firstParagraph.length > 0 && firstParagraph.join('\n').length > 20) {
    return firstParagraph.join('\n').slice(0, maxLength);
  }

  // Last resort: take first meaningful chars, try to break at word boundary
  const truncated = result.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  const lastNewline = truncated.lastIndexOf('\n');
  const breakPoint = Math.max(lastSpace, lastNewline);
  return breakPoint > maxLength * 0.7 ? truncated.slice(0, breakPoint) + '...' : truncated + '...';
}
