import type { ToolDefinition } from './helpers';
import { getMCPManager } from '../mcp/client';

export const TOOLS_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'read',
    batchHint: 'read' as const,
    description: 'Read file contents. Required before write/edit.',
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path' },
        offset: {
          type: 'number',
          description: 'Start line (1-based, optional). Reads from that line to end of file.',
        },
        limit: {
          type: 'number',
          description: 'Deprecated — ignored when offset is set. Kept for backward compatibility.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write',
    batchHint: 'write' as const,
    description:
      'Write/create file. Overwrites existing. Auto-checks syntax for code files (TS/JS/Python/Go/Rust/Shell). Returns syntaxErrors if issues found.',
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit',
    batchHint: 'write' as const,
    description:
      'Edit file by exact text replacement. Read first. Auto-checks syntax after edit. Returns error if oldString matches multiple times (use replace_all:true or file_multi_edit).',
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path' },
        oldString: { type: 'string', description: 'Text to replace (exact)' },
        newString: { type: 'string', description: 'New text' },
        replace_all: {
          type: 'boolean',
          description: 'Replace all occurrences of oldString. Default: false. Set to true to replace every match.',
        },
      },
      required: ['path', 'oldString', 'newString'],
    },
  },
  {
    name: 'file_multi_edit',
    batchHint: 'write' as const,
    description:
      'Edit file with multiple replacements at once. More efficient than multiple edit calls. Read file first. Auto-checks syntax after edit.',
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path' },
        edits: {
          type: 'array',
          description: 'List of edits to apply',
          items: {
            type: 'object',
            properties: {
              oldString: { type: 'string', description: 'Text to replace (exact)' },
              newString: { type: 'string', description: 'New text' },
            },
            required: ['oldString', 'newString'],
          },
        },
      },
      required: ['path', 'edits'],
    },
  },
  {
    name: 'file_replace',
    batchHint: 'write' as const,
    description:
      'Replace text in file using regex pattern. More flexible than edit for pattern matching. Read file first. Auto-checks syntax after edit.',
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path' },
        pattern: {
          type: 'string',
          description: 'Regex pattern to match (e.g., "oldFunc\\\\(\\\\)" for oldFunc())',
        },
        replacement: {
          type: 'string',
          description: 'Replacement text. Use $1, $2 for capture groups.',
        },
        flags: {
          type: 'string',
          description: 'Regex flags: g (global), i (ignore case), m (multiline). Default: "g"',
        },
        all: { type: 'boolean', description: 'Replace all occurrences. Default: true' },
      },
      required: ['path', 'pattern', 'replacement'],
    },
  },
  {
    name: 'file_insert',
    batchHint: 'write' as const,
    description:
      'Insert text at specific line number. Read file first. Auto-checks syntax after edit.',
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path' },
        line: {
          type: 'number',
          description:
            'Line number to insert at (1-based). Use 0 to append at end, -1 to prepend at beginning.',
        },
        content: { type: 'string', description: 'Content to insert' },
        after: {
          type: 'string',
          description: 'Insert after line matching this pattern (alternative to line)',
        },
        before: {
          type: 'string',
          description: 'Insert before line matching this pattern (alternative to line)',
        },
      },
    },
  },
  {
    name: 'file_exists',
    batchHint: 'read' as const,
    description: 'Check if path exists.',
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_delete',
    batchHint: 'write' as const,
    description: 'Delete file or directory.',
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_copy',
    batchHint: 'write' as const,
    description: 'Copy file/directory.',
    parameters: {
      type: 'object' as const,
      properties: {
        source: { type: 'string', description: 'Source' },
        destination: { type: 'string', description: 'Dest' },
      },
      required: ['source', 'destination'],
    },
  },
  {
    name: 'file_move',
    batchHint: 'write' as const,
    description: 'Move/rename file/directory.',
    parameters: {
      type: 'object' as const,
      properties: {
        source: { type: 'string', description: 'Source' },
        destination: { type: 'string', description: 'Dest' },
      },
      required: ['source', 'destination'],
    },
  },
  {
    name: 'directory_create',
    batchHint: 'write' as const,
    description: 'Create directory (with parents).',
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'directory_list',
    batchHint: 'read' as const,
    description: 'List directory contents.',
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path (default: workspace)' },
      },
      required: [],
    },
  },
  {
    name: 'glob',
    batchHint: 'read' as const,
    description: 'Find files by pattern.',
    parameters: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Glob pattern' },
        ignore: {
          type: 'array',
          items: { type: 'string' },
          description: 'Patterns to ignore (default: node_modules, .git, dist, build, *.lock)',
        },
        maxFiles: {
          type: 'number',
          description: 'Max files to return (default: 100, prevents overflow)',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    batchHint: 'read' as const,
    description: 'Search text patterns in files. Returns matches with file paths and line numbers.',
    parameters: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search' },
        path: { type: 'string', description: 'Directory to search (default: workspace)' },
        include: { type: 'string', description: 'File pattern to include (e.g., "*.ts")' },
        maxLines: {
          type: 'number',
          description: 'Max lines to return (default: 100, prevents overflow)',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'bash',
    batchHint: 'write' as const,
    description: 'Run shell command. For dev servers (bun run, npm run dev, python -m http.server) and ANY command expected to run >10s, you MUST set detached:true. Foreground bash blocks the agent — use ONLY for quick commands (<10s expected). Use sandbox:true for untrusted commands (requires bubblewrap).',
    parameters: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Command to execute' },
        timeout: { type: 'number', description: 'Timeout in seconds (default 120)' },
        detached: { type: 'boolean', description: 'Run in background (tmux/screen). MANDATORY for: dev servers, bun run, npm run dev, long builds, watch modes, any command not expected to exit within 10s. Returns immediately with session ID.' },
        interactive: { type: 'boolean', description: 'Enable PTY interaction' },
        maxOutputLength: { type: 'number', description: 'Max output chars (default 50000)' },
        sandbox: {
          type: 'boolean',
          description: 'Run inside bwrap sandbox (no network, read-only system, writable workspace only). Falls back gracefully if bwrap not installed.',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'monitor',
    batchHint: 'neutral' as const,
    description:
      'Start a background monitor that streams stdout lines as real-time events. Returns immediately — does NOT block. Use for: tailing server logs, watching build output, polling health checks, monitoring file changes. Each stdout line becomes a notification in chat. Persistent mode runs until task_stop. Combine with bash(detached:true) to start a server, then monitor its logs.',
    parameters: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to run. Each stdout line is an event.',
        },
        description: { type: 'string', description: 'Short description shown in notifications' },
        timeout: { type: 'number', description: 'Timeout in seconds (default 300, max 3600)' },
        persistent: {
          type: 'boolean',
          description: 'Run for session lifetime (no timeout). Stop with task_stop.',
        },
      },
      required: ['command', 'description'],
    },
  },
  {
    name: 'task_stop',
    batchHint: 'neutral' as const,
    description: 'Stop a running background task (subagent, monitor, or detached bash).',
    parameters: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'Task ID from task (non-blocking), monitor, or bash (detached mode)' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'reply_subagent',
    batchHint: 'neutral' as const,
    description: 'Reply to a background subagent that asked a question mid-execution. The subagent will continue with your answer injected into its context.',
    parameters: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'Task ID from the subagent question event' },
        answer: { type: 'string', description: 'Answer to the subagent\'s question. Be specific and concise.' },
      },
      required: ['task_id', 'answer'],
    },
  },
  {
    name: 'git',
    batchHint: 'write' as const,
    description:
      'Git operations. Actions: status, diff, log, add, commit, branch, checkout, push, pull, reset, stash. Use for version control.',
    parameters: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: [
            'status',
            'diff',
            'log',
            'add',
            'commit',
            'branch',
            'checkout',
            'push',
            'pull',
            'reset',
            'stash',
          ],
          description: 'Git action to perform',
        },
        args: {
          type: 'object',
          properties: {
            files: { type: 'string', description: 'Files for add/reset (default: all)' },
            message: { type: 'string', description: 'Commit message' },
            branch: { type: 'string', description: 'Branch name for checkout/branch' },
            limit: { type: 'number', description: 'Log count limit' },
            mode: { type: 'string', description: 'Reset mode: soft/mixed/hard' },
          },
          description: 'Action-specific arguments',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'workspace',
    batchHint: 'neutral' as const,
    description: 'Get/switch workspace.',
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'New path (optional)' },
      },
      required: [],
    },
  },
  {
    name: 'web_search',
    batchHint: 'read' as const,
    description:
      'Search web using DuckDuckGo (free) or Tavily API (if configured). Returns up to 10 results with titles and URLs. Use for finding documentation, solutions, current information.',
    parameters: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
        engine: {
          type: 'string',
          enum: ['duckduckgo', 'tavily'],
          description: 'Search engine (default: duckduckgo)',
        },
        timeout: { type: 'number', description: 'Timeout in seconds (default 30)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    batchHint: 'read' as const,
    description: 'Fetch URL content.',
    parameters: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'URL' },
        timeout: { type: 'number', description: 'Timeout in seconds (default 15)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'question',
    batchHint: 'neutral' as const,
    description: 'Ask user for clarification.',
    parameters: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Question' },
      },
      required: ['text'],
    },
  },
  {
    name: 'gh',
    batchHint: 'write' as const,
    description:
      'GitHub CLI operations. Actions: pr_view, pr_list, pr_create, pr_comment, pr_review, pr_merge, pr_diff, issue_list, issue_view, issue_create, issue_comment, search, repo_view, run_list, run_view.',
    parameters: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: [
            'pr_view',
            'pr_list',
            'pr_create',
            'pr_comment',
            'pr_review',
            'pr_merge',
            'pr_diff',
            'issue_list',
            'issue_view',
            'issue_create',
            'issue_comment',
            'search',
            'repo_view',
            'run_list',
            'run_view',
          ],
          description: 'GitHub action',
        },
        args: {
          type: 'object',
          properties: {
            number: { type: 'number', description: 'PR/Issue number' },
            state: { type: 'string', description: 'State filter: open/closed/all' },
            limit: { type: 'number', description: 'Result limit' },
            label: { type: 'string', description: 'Label filter' },
            title: { type: 'string', description: 'PR/Issue title (for create)' },
            body: { type: 'string', description: 'Comment/PR body text' },
            base: { type: 'string', description: 'Base branch (for PR create)' },
            head: { type: 'string', description: 'Head branch (for PR create)' },
            action: {
              type: 'string',
              description: 'Review action: approve/comment/request-changes',
            },
            method: { type: 'string', description: 'Merge method: squash/rebase/merge' },
            type: { type: 'string', description: 'Search type: code/issues/prs' },
            query: { type: 'string', description: 'Search query' },
          },
          description: 'Action-specific arguments',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'todo_write',
    batchHint: 'neutral' as const,
    description:
      'Write or update task todos. Use to create task list at start, or update status during work.',
    parameters: {
      type: 'object' as const,
      properties: {
        todos: {
          type: 'array',
          description: 'Todo list',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
          },
        },
      },
      required: ['todos'],
    },
  },
  {
    name: 'skill',
    batchHint: 'neutral' as const,
    description:
      'Load one or more skills. When ANY skill may apply to your task, invoke it immediately — before responding. Provide multiple skill names (comma-separated) to load several at once. The tool returns each skill\'s complete instructions and auto-detects cross-references. You CAN and SHOULD combine skills (e.g. "test-driven-development, frontend-design") when multiple skills apply.',
    parameters: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Skill name or comma-separated names (e.g., "brainstorming" or "test-driven-development, verification-before-completion, frontend-design")',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'todo_read',
    batchHint: 'read' as const,
    description:
      'Read current persisted tasks from .spica/tasks.json. Use to check existing tasks before adding new ones.',
    parameters: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'task',
    batchHint: 'neutral' as const,
    description:
      'Run parallel subagents (max 3). Each subagent works independently. IMPORTANT: If a subagent fails (returns [FAIL]), you should: 1) Analyze the error message, 2) Retry with a modified prompt or different approach, 3) Or handle the failed task yourself in main agent. Do NOT ignore failed subagents - investigate and resolve them.',
    parameters: {
      type: 'object' as const,
      properties: {
        tasks: {
          type: 'array',
          description:
            'Tasks to run in parallel. Each task should be independent and self-contained.',
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              description: { type: 'string', description: 'Short desc for display' },
              prompt: {
                type: 'string',
                description:
                  'Full prompt with clear instructions, context, and expected output format',
              },
              type: {
                type: 'string',
                enum: ['explore', 'review', 'fix', 'build'],
                description:
                  'Subagent type: explore(read-only), review(+lint), fix(+edit), build(full)',
              },
              skill: {
                type: 'string',
                description:
                  'Skill name to auto-load into subagent context (e.g., "test-driven-development", "systematic-debugging"). Injects the skill prompt as a system message before the task prompt.',
              },
            },
            required: ['description', 'prompt'],
          },
        },
        blocking: {
          type: 'boolean',
          description:
            'Wait for subagents to complete before returning (default: true). Set false to run subagents in background — results arrive as system messages.',
        },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'lint',
    batchHint: 'read' as const,
    description:
      'Run project-level linter/type checker. Auto-detects: TypeScript (tsc), ESLint, Go (golangci-lint), Python (pylint), Rust (clippy). Use after code changes to catch errors.',
    parameters: {
      type: 'object' as const,
      properties: {
        fix: { type: 'boolean', description: 'Auto-fix (optional)' },
        files: { type: 'string', description: 'Files (optional)' },
      },
      required: [],
    },
  },
  {
    name: 'test',
    batchHint: 'read' as const,
    description:
      'Run tests. Auto-detects: vitest, npm test, go test, pytest, cargo test. IMPORTANT: Run after code changes to verify functionality.',
    parameters: {
      type: 'object' as const,
      properties: {
        filter: { type: 'string', description: 'Pattern (optional)' },
        coverage: { type: 'boolean', description: 'Coverage (optional)' },
      },
      required: [],
    },
  },
  {
    name: 'file_patch',
    batchHint: 'write' as const,
    description:
      'Apply a unified diff patch to a file. Accepts full unified diff content with @@ hunk headers. Returns error if patch does not apply cleanly.',
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Target file path to patch' },
        patch: { type: 'string', description: 'Unified diff content with @@ hunks' },
      },
      required: ['path', 'patch'],
    },
  },
  {
    name: 'format',
    batchHint: 'write' as const,
    description:
      'Format code using project formatter. Auto-detects: prettier (TS/JS), gofmt (Go), rustfmt (Rust), black (Python). Use after file edits to fix style.',
    parameters: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'File or directory to format (defaults to workspace root)',
        },
      },
      required: [],
    },
  },
  {
    name: 'code_health',
    batchHint: 'read' as const,
    description:
      "Analyze code health score (maintainability, complexity, nesting). Target: >= 9.5 for AI-friendly code. Based on Martin Fowler's recommendations.",
    parameters: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File or directory to analyze' },
        threshold: { type: 'number', description: 'Minimum acceptable score (default: 9.5)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'test_quality_check',
    batchHint: 'read' as const,
    description:
      'Detect test anti-patterns: over-mocking (TST-004), happy-path-only (TST-005), assertion-free (TST-008). Use after writing tests to ensure quality.',
    parameters: {
      type: 'object' as const,
      properties: {
        testFile: { type: 'string', description: 'Test file to analyze' },
        threshold: { type: 'number', description: 'Minimum acceptable score (default: 7.0)' },
      },
      required: ['testFile'],
    },
  },
];

export const mcpToolNameMap = new Map<string, string>();

export function getAllToolDefinitions(): ToolDefinition[] {
  const mcpTools = getMCPManager().getToolDefinitions();
  mcpToolNameMap.clear();
  const mcpConverted: ToolDefinition[] = mcpTools.map(t => {
    const sanitized = t.name.replace(/\//g, '_');
    if (sanitized !== t.name) {
      mcpToolNameMap.set(sanitized, t.name);
    }
    return {
      name: sanitized,
      description: `[MCP] ${t.description}`,
      parameters: t.inputSchema,
    };
  });
  // Sort by name for deterministic order — stabilizes the cache key for API requests.
  // Without this, MCP tool ordering variations cause cache misses on the tools parameter.
  return [...TOOLS_DEFINITIONS, ...mcpConverted].sort((a, b) => a.name.localeCompare(b.name));
}

// ── Lazy-load tool trimming — saves ~1,500 tokens per API call ─────────

/**
 * Tools that are rarely used (<5% of API calls in typical sessions).
 * Their definitions are withheld from the API `tools` parameter until the
 * tool is actually called, at which point it's promoted to the active set.
 *
 * This saves ~1,500 tokens per API call for most sessions (18 lazy tools ×
 * ~85 tokens each, compressed against the prompt cache).
 */
const LAZY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'file_multi_edit',
  'file_replace',
  'file_insert',
  'file_copy',
  'file_move',
  'file_patch',
  'directory_create',
  'directory_list',
  'monitor',
  'task_stop',
  'reply_subagent',
  'workspace',
  'question',
  'gh',
  'format',
  'code_health',
  'test_quality_check',
]);

/**
 * Get tool definitions filtered for the current session state.
 * Lazy tools are excluded until they are first called (present in usedTools).
 * All MCP tools are always included (they're explicitly configured by the user).
 *
 * @param usedTools - Set of tool names that have been called this session.
 *   Pass `null` or omit to get all tools (backward-compatible full set).
 */
export function getActiveToolDefinitions(usedTools?: Set<string> | null): ToolDefinition[] {
  if (!usedTools || usedTools.size === 0) {
    return getAllToolDefinitions();
  }

  const mcpTools = getMCPManager().getToolDefinitions();
  mcpToolNameMap.clear();

  // Filter built-in tools: keep core + any lazy tool that's been used
  const activeBuiltin = TOOLS_DEFINITIONS.filter(
    t => !LAZY_TOOL_NAMES.has(t.name) || usedTools.has(t.name)
  );

  // MCP tools: always included (user explicitly configured them)
  const mcpConverted: ToolDefinition[] = mcpTools.map(t => {
    const sanitized = t.name.replace(/\//g, '_');
    if (sanitized !== t.name) {
      mcpToolNameMap.set(sanitized, t.name);
    }
    return {
      name: sanitized,
      description: `[MCP] ${t.description}`,
      parameters: t.inputSchema,
    };
  });

  return [...activeBuiltin, ...mcpConverted].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}

/** Check if a tool is in the lazy set (for promoting on first use). */
export function isLazyTool(toolName: string): boolean {
  return LAZY_TOOL_NAMES.has(toolName);
}

/** Look up the batchHint for a tool by name. Falls back to 'neutral' for unknown/MCP tools. */
export function getToolBatchHint(toolName: string): 'read' | 'write' | 'neutral' {
  const def = TOOLS_DEFINITIONS.find(t => t.name === toolName);
  return def?.batchHint || 'neutral';
}
