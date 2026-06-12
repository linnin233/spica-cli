# Code Health Improvements Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve code health: reduce lint warnings, fix formatting, split oversized files, remove dead code, update AGENTS.md.

**Architecture:** Six independent phases. Phases 1-3 are low-risk code cleanup. Phases 4-5 are structural refactors (extract subsystems from oversized files). Phase 6 is documentation. Each phase can be verified independently.

**Tech Stack:** TypeScript, ESLint, Prettier, vitest

**Context:**
- 127 files have prettier formatting issues
- 126 ESLint warnings (0 errors)
- 4 oversized files: agent.ts (1706), index.ts (1577), execute.ts (1512), events.ts (1339)
- ts-prune found ~20 dead exports
- 42 Windows test failures (platform-specific)

---

### Task 1: Format All Files with Prettier

**Files:** All 127 files from `npx prettier --check 'src/**/*.ts'`

- [ ] **Step 1: Run prettier --write**

```bash
npx prettier --write 'src/**/*.ts'
```

- [ ] **Step 2: Verify formatting**

```bash
npx prettier --check 'src/**/*.ts'
```

Expected: "All matched files use Prettier code style!"

- [ ] **Step 3: Verify type check**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Verify tests**

```bash
npm run test:run 2>&1 | tail -5
```

Expected: No new failures.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "style: format all files with prettier"
```

---

### Task 2: Clean ESLint Warnings — Unused Variables

**Files:** `src/agent.ts`, `src/cli/events.ts`, `src/index.ts`, `src/cli/ui/__tests__/tuiTestFramework.ts`, `src/cli/ui/screenManager.ts`, `src/utils/projectConfig.ts`, `src/utils/session.ts`

- [ ] **Step 1: Fix agent.ts unused vars**

Remove unused `getSystemPrompt` import (line 6). Prefix unused args: `a` → `_a` (line 1300), `e` → `_e`, `a` → `_a` (line 1309). Remove unused `summaryPrompt` (line 1466).

- [ ] **Step 2: Fix cli/events.ts unused vars**

Prefix unused type exports: `ContextWarningData`, `RetryAttemptData`, `ErrorSuggestionData`, `MessageData`. Remove/prefix: `batchToolCount`, `formatArgsCompact`, `getMainArg`, `subAgentSeq`.

- [ ] **Step 3: Fix index.ts unused vars**

Remove: `prompts`, `join` imports. Prefix/remove: `shouldExit`, `i`, `archiveSessionWithSummary`, `err`, `userArgs`, `result`, `providerConfig`.

- [ ] **Step 4: Fix misc files**

`tuiTestFramework.ts`: remove spawn import, prefix `_screenContent`, change `let timeoutId` to `const timeoutId`.
`screenManager.ts`: remove unused eslint-disable directives (lines 716, 736).
`projectConfig.ts`: remove unused `writeFile` import.
`session.ts`: prefix `_cleanupOldSessions`.
`tuiStateTest.ts`: remove unused eslint-disable (line 1).

- [ ] **Step 5: Run lint:fix**

```bash
npm run lint:fix
```

- [ ] **Step 6: Verify**

```bash
npm run lint 2>&1 | tail -3
npx tsc --noEmit
npm run test:run 2>&1 | tail -5
```

Expected: warnings ≤ 80, type check 0 errors, no new test failures.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "fix: clean unused variables, imports, and eslint-disable comments"
```

---

### Task 3: Clean ESLint Warnings — no-explicit-any

**Files:** agent.ts, events.ts, execute.ts, index.ts, screenManager.ts, web.ts, and other files with `@typescript-eslint/no-explicit-any` (~40 instances)

- [ ] **Step 1: Replace safe `any` with `unknown`**

For tool arguments, error handling, generic data containers: change `any` → `unknown`. Add type guards where needed.

- [ ] **Step 2: Suppress intentional `any`**

For third-party API shapes, JSON parsing results: add `// eslint-disable-next-line @typescript-eslint/no-explicit-any`.

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
npm run lint 2>&1 | tail -3
npm run test:run 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "fix: replace safe any with unknown, suppress remaining explicit any"
```

---

### Task 4: Clean ESLint Warnings — no-control-regex

**Files:** `src/agent.ts`, `src/cli/ui/screenManager.ts`, `src/cli/ui/__tests__/tuiTestFramework.ts`

- [ ] **Step 1: Extract named regex constants in agent.ts**

```typescript
// eslint-disable-next-line no-control-regex
const BACKSPACE_RE = /[\x08\x08]+/g;
// Use BACKSPACE_RE instead of inline regex
```

- [ ] **Step 2: Extract named regex constants in screenManager.ts**

Move ANSI escape sequences to named constants with single suppress comment each.

- [ ] **Step 3: Extract named regex constants in tuiTestFramework.ts**

Same pattern.

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit
npm run lint 2>&1 | grep 'no-control-regex' | wc -l
npm run test:run 2>&1 | tail -5
```

Expected: 0 no-control-regex warnings.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: extract control char regexes to named constants"
```

---

### Task 5: Extract Compression Subsystem from agent.ts

**Files:**
- Create: `src/agent/compression.ts` (~350 lines)
- Modify: `src/agent.ts` — remove compression methods (lines 1383-1706), delegate to compression module

**Methods to extract:**
- `startNonBlockingCompression(targetTokens, signal?)` — main orchestrator (lines 1383-1488)
- `applyPendingSummary()` — inject deferred summary (lines 1490-1519)
- `cleanToolMessages(messages)` — orphan cleanup (lines 1521-1571)
- `scoreMessage(msg, index, total)` — importance scoring (lines 1573-1606)
- `compact(signal?)` — public compact (lines 1608-1628)
- `buildSummaryPrompt(messages)` — build prompt (lines 1630-1667)
- `generateSummary(messages, signal?)` — LLM summary (lines 1669-1706)

**Approach:** Create a standalone module that receives the agent instance. This avoids circular imports while keeping the methods callable.

```typescript
// src/agent/compression.ts
import type { SpicaAgent } from '../agent.js';

export function startNonBlockingCompression(
  agent: SpicaAgent,
  targetTokens: number,
  signal?: AbortSignal
): Promise<void> { /* ... */ }
```

- [ ] **Step 1: Create src/agent/compression.ts**

Copy all compression methods. Change `this.xxx` to `agent.xxx`. Import types from agent.

- [ ] **Step 2: Update agent.ts**

Replace method bodies with delegation to compression module. Keep method signatures for backward compatibility.

```typescript
import { startNonBlockingCompression as _startNonBlockingCompression } from './agent/compression.js';

private async startNonBlockingCompression(targetTokens: number, signal?: AbortSignal): Promise<void> {
  return _startNonBlockingCompression(this, targetTokens, signal);
}
```

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
npm run test:run 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: extract compression subsystem to agent/compression.ts"
```

---

### Task 6: Extract Event Types from events.ts

**Files:**
- Create: `src/cli/eventTypes.ts` (~100 lines)
- Modify: `src/cli/events.ts` — remove type definitions, import from eventTypes.ts

- [ ] **Step 1: Create src/cli/eventTypes.ts**

Move all interface/type definitions from events.ts lines 10-170:
`ConnectionErrorData`, `StreamData`, `ReasoningData`, `ToolCallData`, `ToolResultData`, `ContextWarningData`, `ContextCompressedData`, `ErrorSuggestionData`, `RetryAttemptData`, `MessageData`, `ProgressData`, `DoneData`, `EventMap`, etc.

- [ ] **Step 2: Update events.ts imports**

```typescript
import type { ConnectionErrorData, StreamData, /* ... */ } from './eventTypes.js';
```

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
npm run test:run 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: extract event type definitions to cli/eventTypes.ts"
```

---

### Task 7: Remove Dead Code

**Files:** Various files with exports not imported anywhere.

**Dead exports (from ts-prune):**
- `src/cli/skillGate.ts` — classifyIntent
- `src/cli/status.ts` — displayStatusLine
- `src/mcp/client.ts` — saveExampleConfig
- `src/storage/checkpointManager.ts` — showCheckpointFile
- `src/storage/projectState.ts` — addDecision, setProjectPhase, loadProjectContext
- `src/tools/helpers.ts` — detectFileType, checkBracketMatching, parseHunkHeader

- [ ] **Step 1: Verify each export is truly unused**

```bash
grep -r "functionName" src/ --include='*.ts' | grep -v "functionName("
```

- [ ] **Step 2: Remove dead exports**

Delete functions/types that aren't imported anywhere.

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
npm run test:run 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: remove dead code and unused exports"
```

---

### Task 8: Update AGENTS.md

**File:** `AGENTS.md`

**Updates:**
- Add `src/agent/compression.ts` to entry points
- Add `src/cli/eventTypes.ts` to key directories
- Update file line counts to reflect refactored state
- Update lint warning count target
- Add "Maintenance" section with ts-prune usage
- Update known test failures

- [ ] **Step 1: Edit AGENTS.md**

Update stats, file references, and known issues.

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: update AGENTS.md with current code health state"
```

---

### Task 9: Final Verification

- [ ] **Step 1: Full lint**

```bash
npm run lint 2>&1 | tail -3
```

Expected: ≤ 30 warnings, 0 errors.

- [ ] **Step 2: Full type check**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Build**

```bash
npm run build && ./bin/spica --version
```

- [ ] **Step 4: Full test run**

```bash
npm run test:run 2>&1 | tail -10
```

Expected: No new failures beyond pre-existing.

- [ ] **Step 5: Final commit**

```bash
git status
```
