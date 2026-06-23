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
  description: string; // Type description
}

export const SUB_AGENT_CONFIGS: Record<SubAgentType, SubAgentConfig> = {
  explore: {
    allowedTools: ['glob', 'grep', 'read', 'directory_list', 'file_exists'],
    description: 'Read-only exploration, locate files and code',
  },
  review: {
    allowedTools: ['glob', 'grep', 'read', 'directory_list', 'lint', 'file_exists'],
    description: 'Code review, find issues',
  },
  fix: {
    allowedTools: ['read', 'edit', 'bash', 'lint'],
    description: 'Fix specific issues, minimal changes',
  },
  build: {
    allowedTools: '*', // All tools
    description: 'Full feature implementation',
  },
};

// Get subagent config
export function getSubAgentConfig(type?: SubAgentType): SubAgentConfig {
  if (!type) {
    // Default: full access
    return {
      allowedTools: '*',
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
