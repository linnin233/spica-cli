# Split Large Files — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Split 3 oversized files (5134 total lines) into 9 focused modules by extracting reusable functions — pure code movement, zero logic changes.

**Architecture:** Shallow extraction — move functions/cases to new files, keep switch dispatcher and class structure intact. Each new file exports pure functions with identical signatures. Source files shrink to dispatch/coordination roles.

**Tech Stack:** TypeScript, vitest, execa, simple-git

---

## File Structure

```
src/tools/
├── execute.ts             1698 → ~640  (pure dispatch switch + inline file ops)
├── impl/
│   ├── bash.ts              新  ~440  (bash + monitor + task_stop)
│   ├── git.ts               新  ~170  (git 15 subcommands + checkpoint_restore)
│   ├── gh.ts                新  ~160  (GitHub 15 actions)
│   └── task.ts              新  ~310  (task sub-agent dispatch)

src/
├── agent.ts               1940 → ~1250 (runLoop + interrupt + core)
├── core/
│   ├── compression.ts       新  ~600  (all compression/cleanup/score logic)
│   └── init.ts              新  ~120  (init + initAsSubAgent)

src/cli/
├── events.ts              1496 → ~700  (setupAgentEvents + interfaces)
├── formatting.ts            新  ~550  (terminal width, format helpers, summary stats)
├── results.ts               新  ~280  (tool tracking state + displayToolResult)
└── subagentPanel.ts         新  ~85   (subagent state + displaySubAgentPanel)
```

---

### Task 0: Pre-flight verification

**Files:** (none)

- [ ] **Step 1: Run full test suite to establish baseline**

```bash
npm run test:run 2>&1 | tail -20
```
Expected: All tests pass (0 failures). Note any existing failures.

- [ ] **Step 2: Type check baseline**

```bash
npx tsc --noEmit 2>&1 | tail -5
```
Expected: 0 errors.

---

## Part 1: execute.ts → impl/

### Task 1: Extract `impl/bash.ts` (bash + monitor + task_stop)

**Files:**
- Create: `src/tools/impl/bash.ts`
- Modify: `src/tools/execute.ts:411-843`

- [ ] **Step 1: Create `src/tools/impl/bash.ts` with extracted cases**

Content: Move lines 411-843 from execute.ts. Export three functions:

```ts
import fs from 'fs-extra';
import { execa } from 'execa';
import { resolve as pathResolve } from 'path';
import {
  isWindows,
  WORKSPACE,
  activeMonitors,
  linkAbortSignals,
} from '../helpers';
import { getBashOrFallback, getBashPath } from '../../utils/platform';
import type { ToolResult, ToolEventCallback } from '../helpers';

export async function executeBash(
  args: Record<string, any>,
  eventCallback?: ToolEventCallback
): Promise<ToolResult> {
  // ... lines 411-719 from execute.ts (the entire bash case body)
}

export async function executeMonitor(
  args: Record<string, any>,
  eventCallback?: ToolEventCallback
): Promise<ToolResult> {
  // ... lines 720-823 from execute.ts (the entire monitor case body)
}

export async function executeTaskStop(
  args: Record<string, any>
): Promise<ToolResult> {
  // ... lines 824-843 from execute.ts (the entire task_stop case body)
}
```

Also move the `runInteractivePty` helper function (lines 1571-1698) and the `killProcessTree` closure inner function. Merge `killProcessTree` as a module-level function.

- [ ] **Step 2: Update `execute.ts` — replace cases with delegation**

Remove line 411 through line 843. Remove `runInteractivePty` (lines 1571-1698).

Add import at top of execute.ts:
```ts
import { executeBash, executeMonitor, executeTaskStop } from './impl/bash';
```

Replace removed cases:
```ts
      case 'bash':
        return await executeBash(safeArgs, eventCallback);

      case 'monitor':
        return await executeMonitor(safeArgs, eventCallback);

      case 'task_stop':
        return await executeTaskStop(safeArgs);
```

- [ ] **Step 3: Remove unused execute.ts imports**

After extraction, check if these are still needed in execute.ts — remove if only used in bash.ts:
- If `execa` only used in bash/monitor: remove from execute.ts import
- If `pathResolve` only used in bash: check if still needed
- `getBashOrFallback`, `getBashPath` — likely only in bash.ts now

- [ ] **Step 4: Run tests**

```bash
npx tsc --noEmit && npm run test:run -- src/tools/__tests__/toolsCore.test.ts
```
Expected: 0 type errors. All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/impl/bash.ts src/tools/execute.ts
git commit -m "refactor(tools): extract bash/monitor/task_stop to impl/bash.ts"
```

---

### Task 2: Extract `impl/git.ts`

**Files:**
- Create: `src/tools/impl/git.ts`
- Modify: `src/tools/execute.ts:844-1010`

- [ ] **Step 1: Create `src/tools/impl/git.ts`**

Move git case (lines 844-1010). Export:

```ts
import simpleGit from 'simple-git';
import { execa } from 'execa';
import { WORKSPACE } from '../helpers';
import type { ToolResult } from '../helpers';

export async function executeGit(
  args: Record<string, any>
): Promise<ToolResult> {
  const git = simpleGit(WORKSPACE);
  const action = args.action as string;
  const actionArgs = args.args || {};

  switch (action) {
    case 'status': { /* ... */ }
    case 'diff': { /* ... */ }
    case 'log': { /* ... */ }
    case 'add': { /* ... */ }
    case 'commit': { /* ... */ }
    case 'branch': { /* ... */ }
    case 'checkout': { /* ... */ }
    case 'push': { /* ... */ }
    case 'pull': { /* ... */ }
    case 'reset': { /* ... */ }
    case 'stash': { /* ... */ }
    case 'checkpoint_restore': { /* ... */ }
    default:
      return { success: false, error: `Unknown git action: ${action}` };
  }
}
```

- [ ] **Step 2: Update `execute.ts` — replace git case**

Remove lines 844-1010. Add import:
```ts
import { executeGit } from './impl/git';
```

Replace:
```ts
      case 'git':
        return await executeGit(safeArgs);
```

- [ ] **Step 3: Run tests**

```bash
npx tsc --noEmit && npm run test:run -- src/tools/__tests__/toolsCore.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/tools/impl/git.ts src/tools/execute.ts
git commit -m "refactor(tools): extract git to impl/git.ts"
```

---

### Task 3: Extract `impl/gh.ts`

**Files:**
- Create: `src/tools/impl/gh.ts`
- Modify: `src/tools/execute.ts:1021-1176`

- [ ] **Step 1: Create `src/tools/impl/gh.ts`**

Move gh case (lines 1021-1176). Export:

```ts
import { execa } from 'execa';
import { WORKSPACE } from '../helpers';
import type { ToolResult } from '../helpers';

export async function executeGh(
  args: Record<string, any>
): Promise<ToolResult> {
  const action = args.action as string;
  const ghArgs_sub = args.args || {};
  const timeout = (ghArgs_sub.timeout || 15) * 1000;

  switch (action) {
    case 'pr_view': { /* ... */ }
    case 'pr_list': { /* ... */ }
    case 'pr_create': { /* ... */ }
    case 'issue_list': { /* ... */ }
    case 'issue_view': { /* ... */ }
    case 'issue_create': { /* ... */ }
    case 'repo_view': { /* ... */ }
    case 'run_list': { /* ... */ }
    case 'run_view': { /* ... */ }
    case 'pr_comment': { /* ... */ }
    case 'pr_review': { /* ... */ }
    case 'pr_merge': { /* ... */ }
    case 'pr_diff': { /* ... */ }
    case 'issue_comment': { /* ... */ }
    case 'search': { /* ... */ }
    default:
      return { success: false, error: `Unknown gh action: ${action}` };
  }
}
```

- [ ] **Step 2: Update `execute.ts` — replace gh case**

Remove lines 1021-1176. Add import:
```ts
import { executeGh } from './impl/gh';
```

Replace:
```ts
      case 'gh':
        return await executeGh(safeArgs);
```

- [ ] **Step 3: Run tests**

```bash
npx tsc --noEmit && npm run test:run -- src/tools/__tests__/toolsCore.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/tools/impl/gh.ts src/tools/execute.ts
git commit -m "refactor(tools): extract gh to impl/gh.ts"
```

---

### Task 4: Extract `impl/task.ts`

**Files:**
- Create: `src/tools/impl/task.ts`
- Modify: `src/tools/execute.ts:1187-1493`

- [ ] **Step 1: Create `src/tools/impl/task.ts`**

Move task case (lines 1187-1493). Export:

```ts
import { SubAgentTask, getSubAgentConfig } from '../subAgent';
import { WORKSPACE } from '../helpers';
import type { ToolResult, ToolEventCallback } from '../helpers';

export async function executeTask(
  args: Record<string, any>,
  eventCallback?: ToolEventCallback
): Promise<ToolResult> {
  const tasks = args.tasks as SubAgentTask[];
  const externalSignal = args._abortSignal as AbortSignal | undefined;

  // ... rest of lines 1187-1493 (the entire case body)
}
```

- [ ] **Step 2: Update `execute.ts` — replace task case**

Remove lines 1187-1493. Add import:
```ts
import { executeTask } from './impl/task';
```

Replace:
```ts
      case 'task':
        return await executeTask(safeArgs, eventCallback);
```

- [ ] **Step 3: Run tests**

```bash
npx tsc --noEmit && npm run test:run -- src/tools/__tests__/toolsCore.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/tools/impl/task.ts src/tools/execute.ts
git commit -m "refactor(tools): extract task to impl/task.ts"
```

---

### Task 5: Part 1 integration test

- [ ] **Step 1: Run full tool test suite**

```bash
npm run test:run -- src/tools/__tests__/
```
Expected: All tests pass.

- [ ] **Step 2: Verify execute.ts line count**

```bash
wc -l src/tools/execute.ts
```
Should be ~640 lines (down from 1698).

---

## Part 2: agent.ts → core/

### Task 6: Extract `core/compression.ts`

**Files:**
- Create: `src/core/compression.ts`
- Modify: `src/agent.ts:859-1940` (compression-related methods)

- [ ] **Step 1: Identify all compression-related code**

The following methods and constants move to `compression.ts`:
- `SUMMARY_KEY_ARGS` (static, line 229)
- `cleanMessagesForLLM` (private, line 859)
- `applyPendingSummary` (private, line 914)
- `startNonBlockingCompression` (private, line 1587)
- `scoreMessage` (private, line 1638)
- `buildSummaryPrompt` (private, line 1854)
- `cleanToolMessages` (private, line 1743)
- `_compacting`, `_pendingCompression`, `_deferredSummary` — these remain on agent as flags

- [ ] **Step 2: Create `src/core/compression.ts`**

The module exports functions that take `agent: SpicaAgent` as first parameter:

```ts
import { SpicaAgent } from '../agent';

// Static constants
export const SUMMARY_KEY_ARGS = new Set([
  'path', 'command', 'action', 'pattern', 'query', 'url', 'question', 'prompt',
]);

// Score message importance for compression
export function scoreMessage(
  msg: ChatMessage,
  index: number,
  totalLength: number
): number { /* ... */ }

// Build summary prompt for compression
export function buildSummaryPrompt(messages: ChatMessage[]): string { /* ... */ }

// Clean orphaned tool messages
export function cleanToolMessages(messages: ChatMessage[]): ChatMessage[] { /* ... */ }

// Clean messages before sending to LLM
export function cleanMessagesForLLM(
  agent: SpicaAgent,
  messages: ChatMessage[]
): ChatMessage[] { /* ... */ }

// Apply pending compression summary
export function applyPendingSummary(agent: SpicaAgent): void { /* ... */ }

// Non-blocking compression (rule-truncate now, LLM summary in background)
export async function startNonBlockingCompression(
  agent: SpicaAgent,
  targetTokens: number,
  signal?: AbortSignal
): Promise<void> { /* ... */ }
```

- [ ] **Step 3: Update `agent.ts` — replace compression logic**

Add import:
```ts
import {
  startNonBlockingCompression,
  applyPendingSummary,
  scoreMessage,
  buildSummaryPrompt,
  cleanMessagesForLLM,
  cleanToolMessages,
  SUMMARY_KEY_ARGS,
} from './core/compression';
```

Keep `_compacting`, `_pendingCompression`, `_deferredSummary` on the class as they're used in runLoop flow control.

Replace each method body with delegation:
```ts
// Old: private cleanToolMessages(messages) { ... }
// New: calls cleanToolMessages from compression module

// Old: private cleanMessagesForLLM(messages) { ... }
// New: cleanMessagesForLLM(this, messages)

// Old: private applyPendingSummary() { ... }  
// New: applyPendingSummary(this)

// Old: private async startNonBlockingCompression(...) { ... }
// New: return startNonBlockingCompression(this, targetTokens, signal)
```

Remove `SUMMARY_KEY_ARGS` static member, replace references with imported `SUMMARY_KEY_ARGS`.

- [ ] **Step 4: Run tests**

```bash
npx tsc --noEmit && npm run test:run -- src/__tests__/agent.test.ts src/__tests__/compression.test.ts
```
Expected: 0 type errors. All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/compression.ts src/agent.ts
git commit -m "refactor(agent): extract compression logic to core/compression.ts"
```

---

### Task 7: Extract `core/init.ts`

**Files:**
- Create: `src/core/init.ts`
- Modify: `src/agent.ts:598-741` (init + initAsSubAgent + _doInit)

- [ ] **Step 1: Create `src/core/init.ts`**

Extract `init()`, `initAsSubAgent()`, and `_doInit()`:

```ts
import { SpicaAgent } from '../agent';

export async function initAgent(agent: SpicaAgent): Promise<void> {
  // ... body of init() method (lines 598-615)
}

export async function initAgentAsSubAgent(
  agent: SpicaAgent, 
  parentAgent: SpicaAgent
): Promise<void> {
  // ... body of initAsSubAgent() method (lines 616-693)
}

export async function doInit(agent: SpicaAgent): Promise<void> {
  // ... body of _doInit() method (lines 696-741)
}
```

- [ ] **Step 2: Update `agent.ts` — replace init methods**

Add import:
```ts
import { initAgent, initAgentAsSubAgent, doInit } from './core/init';
```

Replace methods:
```ts
async init(): Promise<void> {
  return initAgent(this);
}

async initAsSubAgent(parentAgent: SpicaAgent): Promise<void> {
  return initAgentAsSubAgent(this, parentAgent);
}

private async _doInit(): Promise<void> {
  return doInit(this);
}
```

- [ ] **Step 3: Run tests**

```bash
npx tsc --noEmit && npm run test:run -- src/__tests__/agent.test.ts
```
Expected: 0 type errors. All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/core/init.ts src/agent.ts
git commit -m "refactor(agent): extract init logic to core/init.ts"
```

---

### Task 8: Part 2 integration test

- [ ] **Step 1: Run agent tests**

```bash
npm run test:run -- src/__tests__/agent.test.ts src/__tests__/compression.test.ts
```
Expected: All pass.

- [ ] **Step 2: Verify agent.ts line count**

```bash
wc -l src/agent.ts
```
Should be ~1250 (down from 1940).

---

## Part 3: events.ts → cli/

### Task 9: Extract `cli/formatting.ts`

**Files:**
- Create: `src/cli/formatting.ts`
- Modify: `src/cli/events.ts:268-637, 923-940`

- [ ] **Step 1: Create `src/cli/formatting.ts`**

Extract all formatting/display helper functions:

```ts
import { COLORS } from './ui/colors';
import { SpicaAgent } from '../agent';
import { getRuntimeState } from '../core/RuntimeState';
import * as os from 'os';

// Terminal width helpers (lines 268-334)
export function getTerminalWidth(): number { /* ... */ }
export function truncateToWidth(str: string, maxWidth: number): string { /* ... */ }
export function getCharDisplayWidth(char: string): number { /* ... */ }
export function getStringDisplayWidth(str: string): number { /* ... */ }
export function isFullWidth(char: string): boolean { /* ... */ }

// Status/formatting (lines 335-637)
export function buildStatusText(agent: SpicaAgent, model?: string): string { /* ... */ }
export function formatArgsCompact(args: Record<string, unknown>, maxWidth: number): string { /* ... */ }
export function formatToolArgs(toolName: string, args: Record<string, unknown>): string { /* ... */ }
export function countDiffLines(text: string, prefix: '+' | '-'): number { /* ... */ }
export function countMatches(output: string): number { /* ... */ }
export function countFiles(output: string): number { /* ... */ }
export function countTestPassed(output: string): number { /* ... */ }
export function countTestFailed(output: string): number { /* ... */ }
export function countLintErrors(output: string): number { /* ... */ }
export function countAgents(output: string): number { /* ... */ }
export function formatToolSummary(data: ToolResultData): string { /* ... */ }
export function formatElapsed(ms: number): string { /* ... */ }
export function getMainArg(name: string, args: Record<string, unknown>): string | null { /* ... */ }
```

Also move the `ToolResultData` interface (lines 30-52) since formatToolSummary uses it. Define it in formatting.ts. Do NOT redefine it in results.ts — results.ts imports it from formatting.ts.

- [ ] **Step 2: Update `events.ts` — replace formatting functions**

Remove lines 268-637 and 923-940. Remove `buildStatusText` and the count* functions, `formatElapsed`, `getMainArg`, `formatToolSummary`, `formatToolArgs`, `formatArgsCompact`.

Add import:
```ts
import {
  getTerminalWidth,
  truncateToWidth,
  getCharDisplayWidth,
  getStringDisplayWidth,
  isFullWidth,
  buildStatusText,
  formatArgsCompact,
  formatToolArgs,
  countDiffLines,
  countMatches,
  countFiles,
  countTestPassed,
  countTestFailed,
  countLintErrors,
  countAgents,
  formatToolSummary,
  formatElapsed,
  getMainArg,
} from './formatting';
```

Remove `import * as os from 'os'` if no longer used directly in events.ts.

Note: `COLORS`, `SpicaAgent`, `getRuntimeState` may still be used in events.ts — keep imports as needed.

- [ ] **Step 3: Run tests**

```bash
npx tsc --noEmit && npm run test:run -- src/cli/__tests__/events.test.ts
```
Expected: 0 type errors. All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/cli/formatting.ts src/cli/events.ts
git commit -m "refactor(cli): extract formatting functions to formatting.ts"
```

---

### Task 10: Extract `cli/results.ts`

**Files:**
- Create: `src/cli/results.ts`
- Modify: `src/cli/events.ts:181-267, 638-922`

- [ ] **Step 1: Create `src/cli/results.ts`**

Extract tool tracking state and display functions:

```ts
import { getScreenManager } from './ui/screenManager';
import { COLORS } from './ui/colors';
import { SpicaAgent } from '../agent';
import { getRuntimeState } from '../core/RuntimeState';
import {
  getTerminalWidth,
  truncateToWidth,
  formatToolSummary,
  formatElapsed,
  formatArgsCompact,
  getMainArg,
  countMatches,
  countFiles,
  countTestPassed,
  countTestFailed,
  countLintErrors,
  countAgents,
  countDiffLines,
  type ToolResultData,
  type ToolCallData,
} from './formatting';

export interface ToolCallRecord {
  seq: number;
  name: string;
  args: Record<string, unknown>;
  startTime: number;
  id?: string;
  outputLines: string[];
}

// Tool tracking state
const activeToolCalls: Map<number, ToolCallRecord> = new Map();
const idToSeq: Map<string, number> = new Map();
let nextToolSeq = 1;
let batchToolCount = 0;

export const toolTracking = {
  registerToolCall(data: ToolCallData): number { /* ... */ },
  matchToolResult(data: ToolResultData): ToolCallRecord | null { /* ... */ },
  resetToolTracking(): void { /* ... */ },
  getBatchCount(): number { return batchToolCount; },
  setBatchCount(n: number): void { batchToolCount = n; },
};

// Display helpers
function calcElapsedMs(startTime: number): number {
  return Date.now() - startTime;
}

export function displayToolResult(
  record: ToolCallRecord,
  data: ToolResultData
): void {
  const screen = getScreenManager();
  const state = getRuntimeState();
  // ... lines 643-922 from events.ts
}
```

- [ ] **Step 2: Update `events.ts` — replace tool tracking and display**

Remove lines 181-267 (tool tracking functions) and 638-922 (displayToolResult, getMainArg — already moved to formatting). Remove `ToolCallRecord`, `ToolCallData`, `ToolResultData` interfaces.

Add import:
```ts
import {
  ToolCallRecord,
  toolTracking,
  displayToolResult,
} from './results';
import type { ToolCallData, ToolResultData } from './formatting';
```

Update references:
- `activeToolCalls` → `toolTracking.activeToolCalls` (internal to results.ts, accessed via toolTracking API)
- `idToSeq` → internal to results.ts
- `nextToolSeq` → internal to results.ts  
- `batchToolCount` → `toolTracking.getBatchCount()` / `toolTracking.setBatchCount()`
- `registerToolCall(data)` → `toolTracking.registerToolCall(data)`
- `matchToolResult(data)` → `toolTracking.matchToolResult(data)`
- `resetToolTracking()` → `toolTracking.resetToolTracking()`
- `calcElapsedMs(start)` → import from results.ts

Remove module-level const declarations for `activeToolCalls`, `idToSeq`, `nextToolSeq`, `batchToolCount`, `calcElapsedMs`, `interruptDisplayed`, `lastInterruptCancelSeq`.

Keep `interruptDisplayed` and `lastInterruptCancelSeq` in events.ts since they're used in interrupt event handler (not part of tool tracking).

- [ ] **Step 3: Run tests**

```bash
npx tsc --noEmit && npm run test:run -- src/cli/__tests__/events.test.ts
```
Expected: 0 type errors. All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/cli/results.ts src/cli/events.ts
git commit -m "refactor(cli): extract tool results logic to results.ts"
```

---

### Task 11: Extract `cli/subagentPanel.ts`

**Files:**
- Create: `src/cli/subagentPanel.ts`
- Modify: `src/cli/events.ts:941-1019`

- [ ] **Step 1: Create `src/cli/subagentPanel.ts`**

Move subagent panel code (lines 941-1019):

```ts
import { getScreenManager } from './ui/screenManager';
import { COLORS } from './ui/colors';
import { getTerminalWidth, truncateToWidth, formatElapsed } from './formatting';

export interface SubAgentRecord {
  id: string;
  type: string;
  description: string;
  status: 'running' | 'done' | 'error';
  startTime: number;
  summary?: string;
  error?: string;
  toolCount: number;
  label: string;
}

export const subAgentState = {
  agents: new Map<string, SubAgentRecord>(),
  nextSeq: 0,

  clear(): void {
    this.agents.clear();
    this.nextSeq = 0;
  },

  add(id: string, data: Omit<SubAgentRecord, 'id'>): void {
    this.agents.set(id, { id, ...data });
  },

  update(id: string, update: Partial<SubAgentRecord>): void {
    const existing = this.agents.get(id);
    if (existing) {
      Object.assign(existing, update);
    }
  },

  get(id: string): SubAgentRecord | undefined {
    return this.agents.get(id);
  },
};

export function displaySubAgentPanel(): void {
  const screen = getScreenManager();
  const termWidth = getTerminalWidth();
  const agents = Array.from(subAgentState.agents.values());
  // ... rest of displaySubAgentPanel (lines 960-1019)
}
```

- [ ] **Step 2: Update `events.ts` — replace subagent panel**

Remove lines 941-1019 (SubAgentRecord interface, activeSubAgents, subAgentSeq, displaySubAgentPanel).

Add import:
```ts
import { SubAgentRecord, subAgentState, displaySubAgentPanel } from './subagentPanel';
```

Update references in setupAgentEvents:
- `activeSubAgents` → `subAgentState.agents`
- `activeSubAgents.clear()` → `subAgentState.clear()`
- `subAgentSeq` → `subAgentState.nextSeq`
- `activeSubAgents.set(...)` → `subAgentState.add(...)`
- `activeSubAgents.get(...)` → `subAgentState.get(...)`
- `displaySubAgentPanel()` → `displaySubAgentPanel()`

- [ ] **Step 3: Run tests**

```bash
npx tsc --noEmit && npm run test:run -- src/cli/__tests__/events.test.ts
```
Expected: 0 type errors. All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/cli/subagentPanel.ts src/cli/events.ts
git commit -m "refactor(cli): extract subagent panel to subagentPanel.ts"
```

---

### Task 12: Part 3 integration test

- [ ] **Step 1: Run all CLI tests**

```bash
npm run test:run -- src/cli/__tests__/
```
Expected: All pass.

- [ ] **Step 2: Verify events.ts line count**

```bash
wc -l src/cli/events.ts
```
Should be ~700 (down from 1496).

---

### Task 13: Final verification — full test suite

- [ ] **Step 1: Type check entire project**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 2: Lint**

```bash
npm run lint
```
Expected: 0 errors.

- [ ] **Step 3: Full test suite**

```bash
npm run test:run
```
Expected: All tests pass.

- [ ] **Step 4: Verify line counts**

```bash
echo "=== Before/After ===" && wc -l src/tools/execute.ts src/agent.ts src/cli/events.ts src/tools/impl/bash.ts src/tools/impl/git.ts src/tools/impl/gh.ts src/tools/impl/task.ts src/core/compression.ts src/core/init.ts src/cli/formatting.ts src/cli/results.ts src/cli/subagentPanel.ts
```

- [ ] **Step 5: Commit final state**

```bash
git add -A
git commit -m "refactor: complete large-files split — 9 new modules, 0 logic changes"
```
