# AGENTS.md

## Project Overview

spica-cli is an AI coding agent CLI with interactive and single-task modes. It supports multiple LLM providers, MCP servers, and a skill system for extending capabilities.

**Entry points:**
- `src/index.ts` — CLI entry (166 lines), commander setup, delegates to mode-specific modules
- `src/commands/interactive.ts` — Full interactive TUI mode (slash commands, session mgmt, agent loop)
- `src/commands/simpleMode.ts` — Single-task mode (one-shot prompt → exit)
- `src/commands/providers.ts` — Provider management commands (`set`, `use`, `list`, `show`, `remove`)
- `src/agent.ts` — Core agent loop (`SpicaAgent` class), tool execution dispatch, message handling, conflict detection, compression
- `src/tools/execute.ts` — All tool execution logic
- `src/tools/registry.ts` — All tool definitions (names, descriptions, parameters)
- `src/prompts/system.ts` — System prompt assembly, AGENTS.md loading, learnings injection
- `src/cli/ui/screenManager.ts` — TUI rendering, input handling, thinking animation

**Key directories:**
- `src/commands/` — CLI mode modules (`interactive.ts`, `simpleMode.ts`, `providers.ts`) and slash command subsystem
- `src/commands/slash/` — Slash command handlers (9 modules + dispatch `index.ts` + `types.ts`)
- `src/llm/` — LLM client, providers (BaseProvider, OpenAICompatible), rate limiter, token counter
- `src/tools/` — Tool definitions (`registry.ts`), execution (`execute.ts`), helpers (`helpers.ts`), subagents (`subAgent.ts`), and type-specific impls (`impl/`)
- `src/skills/` — Skill loading and invocation
- `src/cli/` — TUI (`ui/`), events, input handling, diff rendering, skill gate
- `src/core/` — RuntimeState (singleton), EventBus (pub/sub), ProcessMonitor
- `src/storage/` — Idea store, project state persistence, task persistence
- `src/mcp/` — MCP client (`client.ts`)
- `src/hooks/` — Pre/post hook execution
- `src/utils/` — Settings, project config, session, history, platform, message cleaner, logger, bell
- `src/builtin-skills/superpowers/` — 15 built-in skills

**Stats:** 99 source files, 69 test files (168 git tracked `.ts` files)

## Existing Instruction Files

- `CLAUDE.md` — Detailed architecture reference covering agent internals, event system, interrupt handling, compaction, hooks, sub-agents, input queue, and LLM provider architecture. Complement to this file.

## Build

```bash
npm install           # Install dependencies
npm run build         # Generate CLI wrapper scripts (bin/spica, bin/spica.cmd)
./bin/spica --version # Verify build (outputs: 1.0.0)
npx tsc --noEmit      # Type check without building (0 errors)
```

**Build pipeline:** `npm run build` → `npm run build:cli` → `node scripts/build-bin.js`

**Build outputs:**
- `bin/spica` — Unix/macOS/Windows Node.js wrapper that resolves tsconfig path and runs via `npx tsx`
- `bin/spica.cmd` — Windows cmd wrapper (alternative entry point)

**Runtime:** The project uses `tsx` (TypeScript runner) — there is no compiled `dist/` output from `npm run build`. TypeScript declarations output to `dist/` but are not part of the build pipeline.

**Dev mode:** `npm run dev` runs `tsx src/index.ts` directly (no watch mode).

## Test

```bash
npm test                          # Run tests in watch mode (vitest)
npm run test:run                  # Run all tests once
npm run test:run -- src/__tests__/  # Run only src tests (exclude dist)
npx vitest run <file-pattern>     # Run specific test file
npx vitest run -t "<test name>"   # Run specific test by name
npm run test:run -- --coverage    # Run with coverage (requires @vitest/coverage-v8)
```

**Test locations:** `src/__tests__/` and `src/**/__tests__/`

**Test environment:** vitest 1.6, `environment: 'node'`, `globals: true` (no need to import `describe`/`it`/`expect`). Config in `vitest.config.ts`.

**Coverage:** Uses v8 provider (`@vitest/coverage-v8` — must install separately: `npm install @vitest/coverage-v8`). Coverage excludes `src/builtin-skills/`.

**Known flaky tests:**
- `src/cli/ui/__tests__/tuiPty.test.ts` — PTY tests (14 tests): `node-pty` Windows agent unavailable for `npx tsx` (Windows only)
- `src/tools/__tests__/monitor.test.ts` — Monitor tests (15 tests): process management timing on Windows (Windows only)
- `src/__tests__/security/resolvePath.test.ts` — Symlink tests (6 tests): Windows symlink permissions (Windows only)
- `src/__tests__/fullFeature.test.ts` — TUI tests (4 tests): Chinese input encoding on Windows (Windows only)
- `src/tools/__tests__/toolsCore.test.ts` — occasional syntax check timeout (cross-platform)
- `src/utils/__tests__/session.test.ts` — Session persistence (2 tests): filesystem write timing (cross-platform, can fail on slow Linux filesystems)
- `src/__tests__/boundaryCases.test.ts` — Interrupt edge case (1 test): timing-sensitive tool result preservation (cross-platform)

CI (ubuntu) typically passes all tests, but session and boundary tests may fail on slower runners. CI sets `SKIP_API_TESTS: true` and `CI: true`.

## Lint

```bash
npm run lint         # Run ESLint on src/**/*.ts (0 errors, 102 warnings)
npm run lint:fix     # Auto-fix lint issues (0 auto-fixable warnings)
npm run lint:strict  # Fail on warnings (--max-warnings 0, not used in CI)
```

**Config:** `eslint.config.js` — `@eslint/js` recommended + `typescript-eslint` recommended. Rules:
- `@typescript-eslint/no-explicit-any`: warn
- `@typescript-eslint/no-unused-vars`: warn (argsIgnorePattern/VarsIgnorePattern: `^_`)
- `@typescript-eslint/explicit-module-boundary-types`: off
- `no-console`: off, `no-var`: error, `prefer-const`: warn, `no-empty`: error (allowEmptyCatch: true)
- `no-case-declarations`: warn, `no-control-regex`: warn, `no-useless-escape`: warn
- `preserve-caught-error`: warn, `no-useless-assignment`: off

**Ignores:** `dist`, `node_modules`, `**/*.test.ts`, `**/*.spec.ts`, `bin`

CI only runs lint on Node >= 20.

## Format

```bash
npx prettier --write <file>   # Format file with prettier
npx prettier --check <file>   # Check formatting only
```

**Pre-commit:** Run `npx prettier --check <file>` to verify formatting before committing. There is no prettier check in CI.

**Config (`.prettierrc`):**
- `singleQuote: true`, `semi: true`
- `printWidth: 100`, `tabWidth: 2`, `useTabs: false`
- `trailingComma: "es5"`, `arrowParens: "avoid"`
- `endOfLine: "lf"`, `bracketSpacing: true`

### EditorConfig

`.editorconfig` enforces (supported editors auto-apply):
- `charset: utf-8`, `end_of_line: lf`, `insert_final_newline: true`
- `indent_style: space`, `indent_size: 2` (for `*.ts`, `*.js`, `*.json`, `*.yml`)
- `trim_trailing_whitespace: true` (except `*.md` for line break preservation)
- Makefile uses `indent_style: tab`

### `.gitignore`

Key entries: `.spica/`, `node_modules/`, `dist/`, `*.log`, `.DS_Store`, `.env`, `.env.local`, `test-compress.txt`

## Code Style

- TypeScript `ES2022` target, `ESNext` modules, `"type": "module"` in package.json
- `moduleResolution: "bundler"`, `jsx: "react"` (for ink/react in some paths)
- `strict: true` in tsconfig but `noImplicitAny: false` — explicit `any` allowed (warning only via ESLint)
- `tsconfig.json` excludes `src/builtin-skills/superpowers/**/*.ts` from typecheck
- No comments unless explicitly requested
- Import style: `import { x } from 'y'` (ESM named imports)
- Tool results: `{ success, output?, error?, content?, diff?, syntaxErrors? }`
- Path resolution: Use `resolvePath()` from `src/tools/helpers.ts` for relative paths
- Shell commands: Use array-based `execa` to prevent injection — never string interpolation
- Project state: `RuntimeState` (in `src/core/RuntimeState.ts`) is the single source of truth — never use raw globals
- Writing style (from `docs/STYLE_GUIDE.md`): one sentence per point, command-first, no modifiers, no transitions, keep English terms in English

## PR Workflow

1. Run `npm run lint` and `npm run test:run` before committing
2. Ensure build succeeds: `npm run build && ./bin/spica --version`
3. Title format: `[spica] <Title>` or `[spica-cli] <Title>`
4. CI runs on: Node 18, 20, 22 on ubuntu-latest and windows-latest

**CI checks (in order):** `npm ci` → `npx tsc --noEmit` → `npm run lint` (Node >= 20 only) → `npm run test:run` (CI=true, SKIP_API_TESTS=true) → `npm run build`
**CI workflow files:**
- `.github/workflows/ci.yml` — Primary: matrix (Node 18/20/22 on ubuntu-latest, windows-latest)
- `.github/workflows/test.yml` — Legacy: ubuntu-only Node 18/20, runs `npm run build` (typecheck proxy) → `npm run test:run` → `npm run lint` (continue-on-error, non-blocking)

## Commands Architecture

Refactored from a monolithic `src/index.ts` (~1400 lines) into modular components:

```
src/commands/
├── interactive.ts    # runInteractiveMode() — TUI, agent init, stdin handler, slash dispatch
├── simpleMode.ts     # runSimpleMode() — one-shot prompt execution
├── providers.ts      # registerProviderCommands() — set/use/list/show/remove providers
└── slash/            # Slash command subsystem
    ├── index.ts      # dispatchSlash() — routes commands to handlers
    ├── types.ts      # SlashContext, SlashHandler type definitions
    ├── help.ts       # /help, /init, /history (message history)
    ├── session.ts    # /history(sessions), /view, /rename, /delete, /archive, /clear, /reset, /new
    ├── subagents.ts  # /subagents — view subagent dispatch history
    ├── idea.ts       # /idea, /ideas, /idea-done, /idea-delete, /idea-open
    ├── skill.ts      # /skill list|install|uninstall|add|remove|edit, /<skill_name> (invoke)
    ├── mcp.ts        # /mcp status|init|tools|disconnect
    ├── compact.ts    # /summary, /compact
    ├── queue.ts      # /queue, /q, /undo
    └── status.ts     # /status
```

**Slash command dispatch flow:**
1. `interactive.ts` `handleInput()` detects leading `/`
2. Calls `dispatchSlash(trimmed, ctx)` from `slash/index.ts`
3. If dispatch returns `false`, treats input as regular message (send to agent)
4. Each handler follows the `SlashHandler` type: `(args: string, ctx: SlashContext) => Promise<void>`

## Architecture Notes

### Tool Architecture
- **Definitions:** `src/tools/registry.ts` — all tool schemas (`TOOLS_DEFINITIONS` array)
- **Execution:** `src/tools/execute.ts` — giant switch statement dispatching to impl modules
- **Barrel:** `src/tools/index.ts` — re-exports (12 lines only)
- **Impl modules (16):** `src/tools/impl/` — `bash.ts`, `directory.ts`, `file_manage.ts`, `file_read.ts`, `gh.ts`, `git.ts`, `glob.ts`, `grep.ts`, `lint_test.ts`, `question.ts`, `replySubagent.ts`, `skill.ts`, `task.ts`, `todo.ts`, `web.ts`, `workspace.ts`
- **Specialized tools:** `codeHealth.ts`, `testQuality.ts`, `subAgent.ts`

### Subagent Types
| Type | Allowed Tools | Description |
|------|-------------|-------------|
| `explore` | glob, grep, read, directory_list, file_exists | Read-only exploration |
| `review` | explore + lint | Code review, find issues |
| `fix` | read, edit, bash, lint | Fix specific issues |
| `build` | * (all tools) | Full feature implementation |

### Key Mechanisms
- **Tool conflict detection:** `detectToolConflicts()` in `agent.ts` — tools operating on same resource path are sequenced
- **Message cleaning:** Orphaned tool messages (result without call or vice versa) are auto-cleaned before API calls
- **Context compression:** Triggers at token threshold, preserves recent messages, uses compact prompt
- **Interrupt handling:** ESC ESC triggers graceful interrupt via `AbortController`, preserves tool results
- **Subagent early exit:** When one subagent finds a definitive result, siblings are signaled to stop (saves tokens)
- **Stuck detection:** Bash commands are killed after `stuckWarningMs` (default 120s) with `SIGKILL` to the process group

### Git Safety
- `checkout` checks for uncommitted changes before switching, suggests stash workflow
- `reset` (hard/mixed) checks for uncommitted changes, requires user confirmation

## Skills System

**Built-in skills (15):**
`brainstorming`, `systematic-debugging`, `test-driven-development`, `verification-before-completion`, `requesting-code-review`, `receiving-code-review`, `executing-plans`, `writing-plans`, `subagent-driven-development`, `dispatching-parallel-agents`, `finishing-a-development-branch`, `using-git-worktrees`, `writing-skills`, `using-superpowers`, `frontend-design`

**Skill locations:**
- Built-in: `src/builtin-skills/superpowers/` (each skill is a subdirectory with `SKILL.md`)
- Project: `.spica/skills/`

**Installation:**
```bash
spica skill install <github-url>
spica skill list
```

## Config Locations

```
~/.spica/settings.json  # Global config (providers, mcp, skills, hooks)
<project>/.spica/       # Project session (ideas, history, learnings, tasks)
```

## Idea System

**Lightweight idea capture during coding sessions:**

```
.spica/
├── ideas.json         # Idea store (open/done, auto-increment IDs)
└── backups/           # Single file backups (auto-created by write tool)
```

**Commands:**
```
/idea              # Enter idea capture workspace
/idea <text>       # Quick add an idea
/ideas             # List all ideas
/idea-done <id>    # Mark idea as done
/idea-delete <id>  # Delete an idea
/idea-open <id>    # Re-open a done idea
```

## Learnings System

When the user corrects the AI, write a new `.spica/learnings/YYYY-MM-DD-topic.md` file. These are auto-loaded into the system prompt on every session start. Format: freeform markdown, one lesson per file.

**Current learnings:**
- `2026-05-30-learnings-mechanism.md` — How the learnings system works
- `2026-06-05-subagent-superpowers-issue.md` — Subagent/superpowers integration issue (workaround: use `executing-plans` skill instead)

## Security Considerations

- Never commit API keys or secrets
- Provider credentials stored in `~/.spica/settings.json`
- Shell commands use `execa` with array arguments to prevent injection
- Bash command injection detection blocks: `/dev/tcp/`, `nc -l/-e`, `mkfifo`, piping to interpreters, `eval`
- File operations validate paths against directory traversal
- Use environment variables for sensitive config: `GITHUB_TOKEN`, `TAVILY_API_KEY`, `HTTPS_PROXY`

## Dependencies

**Runtime:** `execa` (shell), `simple-git` (git), `fast-glob` (glob), `fs-extra` (file ops), `openai` (LLM client), `@modelcontextprotocol/sdk` (MCP), `commander` (CLI parsing), `chalk` (output), `node-pty` (interactive terminal), `ora` (spinners), `prompts` (user prompts), `axios` (HTTP), `https-proxy-agent`

**Dev:** `tsx` (TypeScript runner), `typescript` 5.4, `vitest` 1.6, `eslint` 10, `typescript-eslint` 8

## Additional Documentation

- `docs/MANUAL.md` — Complete user manual
- `docs/STYLE_GUIDE.md` — Technical writing style guide
- `docs/CONTRIBUTING.md` — Contribution guidelines
- `CLAUDE.md` — Detailed architecture reference (agent internals, event system, interrupt handling, compaction, hooks, sub-agents, input queue, LLM provider architecture)
- `scripts/e2e-test.sh` — End-to-end test script
- `scripts/stress-test.sh` — Stress test script
- `scripts/test-interrupt.sh` — Interrupt handling test
- `scripts/test-compression.sh` — Compression test
- `scripts/test-skills-invocation.sh` — Skills invocation test
