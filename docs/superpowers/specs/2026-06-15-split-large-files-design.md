# Split Large Files — Design Doc

2026-06-15

## Problem

Three files have grown too large to maintain comfortably:

| File | Lines | Status | Pain Points |
|------|-------|--------|-------------|
| `src/tools/execute.ts` | 1698 | ⚠️ Regressed (was 1508) | `bash`(308L), `task`(307L), `git`(166L), `gh`(155L) still inline in switch |
| `src/agent.ts` | 1940 | 🔴 Never split | Compression(~500L), runLoop(~550L), init(~130L) all in one class |
| `src/cli/events.ts` | 1496 | 🔴 Never split | Formatting(~470L), tool results(~260L), subagent panel(~70L), 20+ event handlers(~700L) |

**Total**: 5134 lines across 3 files. Largest single file: 1940 lines.

## Design

### Strategy: Shallow extraction (move code, keep interfaces)

All 9 new files pull existing functions/cases out of the source files.
No logic changes. No dispatch map refactoring. Every function signature stays identical.

### Part 1: `execute.ts` → `impl/` (4 new files)

**Goal**: `execute.ts` becomes ~200-line pure dispatch switch.

```
src/tools/execute.ts         1698 → ~200  (switch dispatcher only)
src/tools/impl/bash.ts         新  ~350  (bash + monitor + task_stop)
src/tools/impl/task.ts         新  ~320  (task sub-agent dispatch)
src/tools/impl/git.ts          新  ~200  (git 15 subcommands + checkpoint_restore)
src/tools/impl/gh.ts           新  ~180  (GitHub 15 actions)
```

**Impl file signature** (unified):
```ts
// Each impl file exports one or more execute functions
export async function executeBash(
  args: Record<string, any>,
  eventCallback?: ToolEventCallback
): Promise<ToolResult>
```

**execute.ts switch after extraction**:
```ts
case 'bash':
case 'monitor':
case 'task_stop':
  return await executeBash(safeArgs, eventCallback);

case 'task':
  return await executeTask(safeArgs, eventCallback);

case 'git':
  return await executeGit(safeArgs, eventCallback);

case 'gh':
  return await executeGh(safeArgs, eventCallback);
```

**Dependencies**: Each impl file imports from `../helpers` (resolvePath, WORKSPACE, etc.) — same as existing impl files.

### Part 2: `agent.ts` → `core/` (2 new files)

**Goal**: `agent.ts` drops to ~1240 lines.

```
src/agent.ts                 1940 → ~1240 (runLoop + interrupt + core)
src/core/compression.ts        新  ~550  (all compression logic)
src/core/init.ts               新  ~150  (init + initAsSubAgent)
```

**`compression.ts` exports**:
```ts
export async function startNonBlockingCompression(
  agent: SpicaAgent,
  targetTokens: number,
  signal?: AbortSignal
): Promise<void>

export function applyPendingSummary(agent: SpicaAgent): void
```

Extracted functions: `startNonBlockingCompression`, `applyPendingSummary`, `scoreMessage`, `buildSummaryPrompt`, `cleanMessagesForLLM`, and helper `STATIC` constants (SUMMARY_KEY_ARGS).

**`init.ts` exports**:
```ts
export async function initAgent(agent: SpicaAgent): Promise<void>
export async function initAgentAsSubAgent(agent: SpicaAgent, parentAgent: SpicaAgent): Promise<void>
```

**Pattern**: Both modules receive `agent` as first parameter. They access agent internals via public API or parameter passing. No `this` binding tricks.

**agent.ts call sites**:
```ts
// Old
await this.startNonBlockingCompression(targetTokens, signal);

// New
import { startNonBlockingCompression } from './core/compression';
await startNonBlockingCompression(this, targetTokens, signal);
```

### Part 3: `events.ts` → `cli/` (3 new files)

**Goal**: `events.ts` drops to ~700 lines (setupAgentEvents + interfaces only).

```
src/cli/events.ts            1496 → ~700  (setupAgentEvents + interfaces)
src/cli/formatting.ts          新  ~480  (all formatting/display helpers)
src/cli/results.ts             新  ~270  (tool tracking + displayToolResult)
src/cli/subagentPanel.ts       新  ~80   (subagent panel display)
```

**`formatting.ts` exports** (module-level functions):
```ts
export function getTerminalWidth(): number
export function truncateToWidth(str: string, maxWidth: number): string
export function getCharDisplayWidth(char: string): number
export function getStringDisplayWidth(str: string): number
export function isFullWidth(char: string): boolean
export function buildStatusText(agent: SpicaAgent, model?: string): string
export function formatArgsCompact(args: Record<string, unknown>, maxWidth: number): string
export function formatToolArgs(toolName: string, args: Record<string, unknown>): string
export function countDiffLines(text: string, prefix: '+' | '-'): number
export function countMatches(output: string): number
export function countFiles(output: string): number
export function countTestPassed(output: string): number
export function countTestFailed(output: string): number
export function countLintErrors(output: string): number
export function countAgents(output: string): number
export function formatToolSummary(data: ToolResultData): string
export function formatElapsed(ms: number): string
export function getMainArg(name: string, args: Record<string, unknown>): string | null
```

**`results.ts` exports** (tool tracking with internal state):
```ts
export interface ToolCallRecord { seq, name, args, startTime, id, outputLines }
export const toolTracking = {
  registerToolCall(data: ToolCallData): number,
  matchToolResult(data: ToolResultData): ToolCallRecord | null,
  resetToolTracking(): void,
  getActiveCount(): number,
}
export function displayToolResult(
  record: ToolCallRecord,
  data: ToolResultData,
  screen: ScreenManager,
  state: RuntimeState,
  agent: SpicaAgent,
  model?: string
): void
```

Internal state (`activeToolCalls`, `idToSeq`, `nextToolSeq`, `batchToolCount`) lives in `results.ts` module scope.

**`subagentPanel.ts` exports**:
```ts
export const subAgentState = {
  activeSubAgents: Map<string, SubAgentRecord>,
  nextSeq: number,
  clear(): void,
  add(id, data): void,
  update(id, update): void,
}
export function displaySubAgentPanel(screen: ScreenManager): void
```

### Summary Table

| File | Before | After | Delta |
|------|--------|-------|-------|
| `execute.ts` | 1698 | ~200 | -1498 |
| `impl/bash.ts` | — | ~350 | +350 |
| `impl/task.ts` | — | ~320 | +320 |
| `impl/git.ts` | — | ~200 | +200 |
| `impl/gh.ts` | — | ~180 | +180 |
| `agent.ts` | 1940 | ~1240 | -700 |
| `core/compression.ts` | — | ~550 | +550 |
| `core/init.ts` | — | ~150 | +150 |
| `events.ts` | 1496 | ~700 | -796 |
| `cli/formatting.ts` | — | ~480 | +480 |
| `cli/results.ts` | — | ~270 | +270 |
| `cli/subagentPanel.ts` | — | ~80 | +80 |
| **Total** | 5134 | 4720 | +414 |

Largest file drops from 1940 to ~1240. Every new file is under 550 lines.

## Verification

After each file split, run:

```bash
npx tsc --noEmit                    # TypeScript: 0 errors
npm run test:run -- src/__tests__/  # Agent tests
npm run test:run -- src/tools/__tests__/  # Tool tests
npm run test:run -- src/cli/__tests__/events.test.ts  # Events tests
```

Full regression after all splits:
```bash
npm run lint && npm run test:run
```

## Risk Assessment

- **Risk**: Low. Pure code movement. No logic changes. No interface changes.
- **Rollback**: `git stash` per file. Each split is an independent commit.
- **Test coverage**: 26 test files, 5322 lines. Key paths covered: agent (334L), toolsCore (415L), events (158L), compression (430L).
- **Edge cases**: Circular imports avoided by keeping execution in separate modules. `compression.ts` receives agent as parameter — no import cycle. `executeTool` stays in `execute.ts` — no import cycle.
