# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev                    # Run CLI in development mode (tsx)
npm run build                  # Generate executable bin/spica script
npm test                       # Run tests with Vitest (watch mode)
npm run test:run               # Run tests once (vitest run)
npm run lint                   # Run ESLint
npm run lint:fix               # Auto-fix lint issues
npm run lint:strict            # ESLint with --max-warnings 0 (CI-ready)
npx tsc --noEmit               # Type check only
vitest run src/__tests__/agent.test.ts  # Run specific test file
vitest run --grep "interrupt"           # Run tests matching pattern
```

Note: Project is ESM (`"type": "module"` in package.json). Use `import`/`export`, not `require`. Dev uses `tsx` for TypeScript execution.

## Architecture

### Core Components

**SpicaAgent** (`src/agent.ts`)
- Central orchestrator, EventEmitter-based
- Manages LLM client, tools, project state, session history
- Key events: `tool_call`, `tool_result`, `message`, `interrupt`, `done`
- Tool conflict detection for concurrent file operations

**LLMClient** (`src/llm/LLMClient.ts`)
- OpenAI-compatible provider abstraction
- Streaming responses, temperature=0.3
- Providers in `src/llm/providers/`: OpenAI, Anthropic, DeepSeek, Gemini, etc.

**Tools** (`src/tools/index.ts`)
- 33 built-in tools: file ops, bash, git, grep, glob, web, lint, test, etc.
- MCP tools dynamically added via `src/mcp/client.ts`
- Each tool returns `{ success, output, error, diff?, syntaxErrors? }`

**CLI/TUI** (`src/cli/`)
- Commands: `/help`, `/archive`, `/history`, `/summary`, `/compact`, `/queue`, `/checkpoint`, `/skill`, `/mcp`, `/status`, `/init`
- Events handler in `events.ts`
- UI components in `ui/`: spinner, diff display, messages

### Data Flow

1. User input → InputQueue (supports queued inputs)
2. Agent.processInput() → LLMClient.stream()
3. LLM returns tool_calls → Agent.executeTools()
4. Tool results → Agent.runLoop() continues
5. finish_reason="tool_calls" → execute → continue. finish_reason="stop" → exit (show text to user). Stagnation detection (16 rounds) as safety net.

### Storage

```
~/.spica/                      # Global
├── settings.json              # Provider configs (API keys, URLs), MCP, Hooks, Skills
├── skills/                    # Custom skill packages
├── sessions/                  # Archived sessions
├── learnings/                 # Global learnings

<project>/.spica/              # Project-specific
├── session.json               # Current session messages (active)
├── sessions/                  # Archived sessions (historical, one per session)
├── state.json                 # Project state (todos, checkpoints)
├── backups/                   # File backups before edits
├── tasks.json                 # Persisted task list
├── tool-usage.json            # Tool usage analytics
```

## Key Patterns

### Runtime State (Singleton)

`src/core/RuntimeState.ts` — singleton managing all session state:
- Agent instance, provider config, processing flag, UI mode, interrupt counter
- One `getRuntimeState()` call gives access to all state everywhere
- Also `EventBus` (`src/core/EventBus.ts`) — pub/sub for decoupled communication

### EventEmitter Pattern

All async communication uses events:
```typescript
agent.on('tool_call', (data) => { ... });
agent.on('tool_result', (data) => { ... });
agent.emit('message', { role: 'assistant', content });
```

Key agent events: `stream`, `reasoning`, `tool_call`, `tool_progress`, `tool_result`, `message`, `context_warning`, `context_compressed`, `connection_error`, `queue_injected`, `interrupt`, `done`, `retry_attempt`, `subagent_result`

### Tool Conflict Detection

Multiple tools on same resource → sequential execution:
- `extractResourcePath()` identifies file paths in tool args
- `detectToolConflicts()` groups conflicting operations
- Non-conflicting tools run in parallel
- Git operations treated as single shared resource (`git:repo`)

### Interrupt Handling

ESC ESC (or Ctrl+C) triggers interrupt:
1. `agent.interrupt()` sets AbortController + `pendingCancel` flag + increments `cancelSeq`
2. AbortController signals all running tools + active LLM request
3. Bash commands killed via process group (-pid)
4. `cancelSeq` is passed to each tool execution — tools check it to skip stale work (prevents race conditions where abort fires between tool completions)
5. Agent returns partial result, user can continue

### Compaction

`/compact` command or auto-trigger at 60% context window compresses conversation history:
- **Phase 1 (instant):** Rule-based truncation — scores messages by importance, keeps high-value + recent tail, drops low-value. Preserves cache prefix messages for API-side caching. Adaptive content limits: base 4000 chars, tool results 1.5×, assistant-with-toolcalls 1.2×, already-truncated content 2×.
- **Phase 2 (background):** Fire LLM summary for old messages, store as `_deferredSummary`, inject after system messages on next request
- Emits `context_compressed` event with before/after counts and structured observability (kept/dropped by role, phase, dropped ratio)

### Hooks System

`src/hooks/index.ts` — intercept tool calls:
- `PreToolUse` / `PostToolUse` hooks with actions: `none`, `warn`, `confirm`, `block`
- Global hooks (`~/.spica/hooks.json`) take precedence — project hooks can only be equally or more strict
- Project hooks loaded from `<project>/.spica/hooks.json`

### Auto-Syntax Check

File write/edit tools auto-check syntax for:
- TypeScript/JavaScript: `tsc --noEmit`
- Python: `python -m py_compile`
- Go: `golangci-lint`
- Rust: `cargo check`
- Shell: `bash -n`

Returns `syntaxErrors` field if issues found.

### Sub-Agent Pattern

`task` tool spawns parallel subagents:
- Types: `explore` (90s, read-only), `review` (120s), `fix` (180s), `build` (300s, all tools)
- Each subagent has tool whitelist per type
- Max 3 concurrent tasks
- Main agent handles failures (retry or take over)

### Input Queue

During agent processing, new user input goes to a queue (max 50):
- Multiple queued inputs merged with `\n\n---\n\n` separator
- `/queue` shows pending, `/undo` removes last
- Auto-drain after processing completes (recursive drain loop)

### Builtin Skills

`src/builtin-skills/superpowers/` — skills shipped with the CLI:
- `brainstorming`, `dispatching-parallel-agents`, `executing-plans`
- `test-driven-development`, `systematic-debugging`, `verification-before-completion`
- `writing-plans`, `writing-skills`, `using-superpowers`, `using-git-worktrees`
- `subagent-driven-development`, `finishing-a-development-branch`
- `receiving-code-review`, `requesting-code-review`

Skills are loaded at startup via `initSkills()` and available as `/<skill-name>` commands.

### Agent State Machine

`src/core/AgentState.ts` — unified state machine replacing scattered booleans:
- States: `uninitialized` → `initializing` → `idle` ↔ `processing` / `compacting` / `interrupted`
- Validated transitions — invalid transitions throw in dev, warn in production
- AgentStateMachine tracks all transitions and exposes `canAcceptInput`, `isBusy`, `isReady`
- `forceTransition()` available for recovery scenarios

### Progress Tracker

`src/core/progressTracker.ts` — structured progress that survives compression:
- Records file changes, decisions, errors, milestones separately from message history
- Compressed context block (~200-500 tokens) injected after system messages
- Persisted to session so it survives restarts
- Max 20 entries, oldest removed when exceeded

### Tool Usage Analytics

`src/tools/analytics.ts` — tracks which tools are actually used across sessions:
- `recordToolUsage()` per invocation, `recordSessionStart()` per session
- Data persisted to `.spica/tool-usage.json`
- Feeds into lazy tool loading: frequently-used tools stay core, unused remain lazy

### LLM Provider Architecture

`src/llm/providers/BaseProvider.ts` — abstract base class
`src/llm/providers/OpenAICompatible.ts` — concrete implementation for OpenAI-compatible APIs
`src/llm/LLMClient.ts` — facade wrapping provider + rate limiter + token counter + function caller

Providers are configured in `~/.spica/settings.json`. Any OpenAI-compatible API works (OpenAI, Anthropic via proxy, DeepSeek, Gemini, Together AI, Groq, local models).

### Token Counting

`src/llm/TokenCounter.ts` — estimates token usage for context window management:
- `estimateMessages()` for full message array
- `estimateText()` for individual strings
- Used by `/status` and context warning system

### Two Runtime Modes

- **TUI mode** (default, interactive terminal): Full screen with scroll region, status bar, thinking animation, bracketed paste. Uses `src/cli/ui/`
- **Simple mode** (`--no-tui` or non-TTY): Readline-based, plain text output. Same agent, simpler UI

### Session & Archive (Two-State Model)

`src/utils/session.ts` — manages session lifecycle:
- **Active**: `session.json` holds current session with append-only full history
- **Historical**: `sessions/<id>.json` — one file per archived session with summary
- `saveSession()` writes only to `session.json` (active). Compression never touches `_fullHistory`.
- `archiveSession()` moves active → historical, generates summary (LLM or local fallback).
- `/archive`, `/clear`, `/reset`, `/new` all trigger archive if messages exist.
- `/history` lists all archived sessions; `/view <id>` shows full content.

## Testing

Test structure mirrors source:
```
src/__tests__/                 # Top-level tests
src/__tests__/security/        # Security tests (shell injection, path traversal, hooks override)
src/tools/__tests__/           # Tool tests
src/llm/__tests__/             # LLM tests
src/cli/__tests__/             # CLI tests
src/core/__tests__/            # Core module tests (EventBus, ProcessMonitor, error handling)
```

Key test categories:
- `agent.test.ts` - Core agent logic
- `interrupt.test.ts` - ESC ESC interrupt handling
- `tools.test.ts` - Tool execution
- `edgeCases.test.ts` - Edge cases and boundary conditions
- `regression/` - Bug regression tests
- `security/` - Shell injection, path traversal, format injection, hooks privilege escalation

Vitest globals enabled: `describe`, `it`, `expect`, `vi`

E2E/manual test scripts in `scripts/`: `e2e-test.sh`, `stress-test.sh`, `test-interrupt.sh`, `test-compression.sh`, `test-skills-invocation.sh`

## Conventions

### Writing Style (from docs/STYLE_GUIDE.md)

Technical documentation:
- One sentence per point, no elaboration
- Command first, then purpose
- No modifiers: "强大的", "高效的", "智能的"
- No transitions: "接下来", "让我们", "首先"
- English terms stay English: session, checkpoint, MCP

### Code Style

- TypeScript ESM (`"type": "module"`)
- Prefer `async/await` over raw promises
- Error messages actionable: tell what to do, not just what failed
- File edits require prior read (enforced by tool descriptions)

## Important Files

- `src/index.ts` - Entry point, TUI setup, CLI command definitions (commander)
- `src/agent.ts` - Core agent orchestrator (1845 lines), tool execution, interrupt management, state machine, progress tracker
- `src/prompts/system.ts` - System prompt for LLM, builtin skills loading
- `src/core/RuntimeState.ts` - Singleton session state (agent, processing, UI, interrupt)
- `src/core/EventBus.ts` - Pub/sub event bus
- `src/core/AgentState.ts` - Unified state machine (6 states, validated transitions)
- `src/core/progressTracker.ts` - Structured progress record (survives compression)
- `src/core/compression.ts` - 2-phase compression: instant rule-based + background LLM summary
- `src/tools/index.ts` - Tool barrel (re-exports registry + execute)
- `src/tools/registry.ts` - 33 built-in tool definitions
- `src/tools/execute.ts` - Tool execution dispatch + cache
- `src/tools/analytics.ts` - Tool usage tracking (feeds lazy loading)
- `src/tools/subAgent.ts` - Sub-agent type configs (explore/review/fix/build)
- `src/tools/codeHealth.ts` - Code health analysis tool
- `src/tools/testQuality.ts` - Test quality analysis tool
- `src/llm/LLMClient.ts` - LLM client facade (provider + rate limiter + token counter)
- `src/llm/FunctionCaller.ts` - Tool executor registry and dispatch
- `src/llm/RateLimiter.ts` - API rate limiting (requests/tokens per minute)
- `src/llm/TokenCounter.ts` - Token estimation for context management
- `src/llm/providers/BaseProvider.ts` - Abstract LLM provider
- `src/llm/providers/OpenAICompatible.ts` - Concrete OpenAI-compatible provider
- `src/utils/settings.ts` - Provider config management, hooks config loading
- `src/storage/projectState.ts` - Project state (todos, decisions, phase)
- `src/utils/session.ts` - Session persistence and archive (two-state model)
- `src/storage/checkpointManager.ts` - File snapshot system (`.spica/snapshots/`)
- `src/hooks/index.ts` - Tool interception hooks (PreToolUse/PostToolUse)
- `src/skills/index.ts` - Skill loading and execution
- `src/builtin-skills/superpowers/` - 14 built-in skills shipped with the CLI
- `src/cli/events.ts` - Agent event handlers, run stats formatting
- `src/cli/queueDrain.ts` - Auto-drain input queue after processing
- `src/mcp/client.ts` - MCP server connection and tool registry
- `docs/MANUAL.md` - Complete user manual
- `docs/STYLE_GUIDE.md` - Technical writing style guide