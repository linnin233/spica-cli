# runLoop Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split 1712-line `agent.ts` runLoop into 3 phases, replace 50-round hard cap with stagnation detection, remove redundant skill gate.

**Architecture:** runLoop → prepareTurn → while(stagnation alive) { callLLM → executeTools → injectResults → checkStagnation }. ProgressTracker wired into executeTools and prepareTurn.

**Tech Stack:** TypeScript, vitest, ESLint

---

### Task 1: Write stagnation detection tests

**Files:**
- Create: `src/__tests__/stagnation.test.ts`

- [ ] **Step 1: Write tests for stagnation detection**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SpicaAgent } from '../agent';

// Use a test helper to access private checkStagnation
function getCheckStagnation(agent: SpicaAgent): (hadProgress: boolean) => 'continue' | 'warn' | 'stop' {
  return (agent as any).checkStagnation.bind(agent);
}

describe('stagnation detection', () => {
  let agent: SpicaAgent;
  let checkStagnation: (hadProgress: boolean) => 'continue' | 'warn' | 'stop';

  beforeEach(() => {
    agent = new SpicaAgent('openai', '/test/workspace');
    checkStagnation = getCheckStagnation(agent);
  });

  it('returns continue on first no-progress round', () => {
    expect(checkStagnation(false)).toBe('continue');
  });

  it('returns continue after 7 rounds of no progress', () => {
    for (let i = 0; i < 7; i++) {
      expect(checkStagnation(false)).toBe('continue');
    }
  });

  it('returns warn at 8th round of no progress', () => {
    for (let i = 0; i < 7; i++) checkStagnation(false);
    expect(checkStagnation(false)).toBe('warn');
  });

  it('returns stop at 16th round of no progress', () => {
    for (let i = 0; i < 15; i++) checkStagnation(false);
    // 8th round already warned, keep going
    expect(checkStagnation(false)).toBe('stop');
  });

  it('continues beyond 16 with progress reset', () => {
    for (let i = 0; i < 10; i++) checkStagnation(false);
    // Progress resets counter
    expect(checkStagnation(true)).toBe('continue');
    // Now no progress again — starts fresh
    expect(checkStagnation(false)).toBe('continue');
  });

  it('stays at continue when progress is made every round', () => {
    for (let i = 0; i < 30; i++) {
      expect(checkStagnation(true)).toBe('continue');
    }
  });

  it('warns only once — second warn-level round still returns warn', () => {
    for (let i = 0; i < 7; i++) checkStagnation(false);
    expect(checkStagnation(false)).toBe('warn'); // 8th
    expect(checkStagnation(false)).toBe('continue'); // 9th — no double warn
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/stagnation.test.ts`
Expected: FAIL — `checkStagnation is not a function`

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/stagnation.test.ts
git commit -m "test: add stagnation detection unit tests"
```

---

### Task 2: Add stagnation fields + checkStagnation to SpicaAgent

**Files:**
- Modify: `src/agent.ts` — add fields after `_progress`, add method

- [ ] **Step 1: Add fields**

After `private _progress: ProgressTracker = new ProgressTracker()` (~L303), add:

```typescript
  private _stagnationCounter: number = 0;
  private static readonly STAGNATION_WARNING = 8;
  private static readonly STAGNATION_LIMIT = 16;
```

- [ ] **Step 2: Add checkStagnation method**

Add after `getGitStatus()` (~L512):

```typescript
  private checkStagnation(hadProgress: boolean): 'continue' | 'warn' | 'stop' {
    if (hadProgress) {
      this._stagnationCounter = 0;
      return 'continue';
    }
    this._stagnationCounter++;
    if (this._stagnationCounter === SpicaAgent.STAGNATION_WARNING) {
      return 'warn';
    }
    if (this._stagnationCounter >= SpicaAgent.STAGNATION_LIMIT) {
      return 'stop';
    }
    return 'continue';
  }
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/stagnation.test.ts`
Expected: PASS (all 7 tests)

- [ ] **Step 4: Run existing tests**

Run: `npx vitest run src/__tests__/agent.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent.ts
git commit -m "feat: add stagnation detection fields and checkStagnation method"
```

---

### Task 3: Remove dead imports from agent.ts

**Files:**
- Modify: `src/agent.ts` — lines 2-61 (imports section)

- [ ] **Step 1: Remove unused imports**

Apply these exact changes:

**Line 2-7 (remove `getAllToolDefinitions`):**
```
OLD: import {
  executeTool,
  getAllToolDefinitions,
  getActiveToolDefinitions,
  isLazyTool,
  setWorkspace,
  getToolBatchHint,
} from './tools/index';
NEW: import {
  executeTool,
  getActiveToolDefinitions,
  isLazyTool,
  setWorkspace,
  getToolBatchHint,
} from './tools/index';
```

**Line 10 — remove entire line:**
```
OLD: import { initMCP } from './mcp/client';
NEW: (deleted)
```

**Line 11 — remove entire line:**
```
OLD: import { initSkills, listSkills } from './skills/index';
NEW: (deleted)
```

**Line 12 — remove entire line:**
```
OLD: import { getProviderConfig } from './utils/settings';
NEW: (deleted)
```

**Lines 13-17 — remove getSystemPrompt import block:**
```
OLD: import {
  getSystemPrompt,
  getSystemPromptStable,
  getSystemPromptVariable,
} from './prompts/system';
NEW: (deleted)
```

**Lines 18-23 — remove loadAgentsConfig, autoDetectProject, createAgentsMd, keep ProjectConfig:**
```
OLD: import {
  loadProjectConfig as loadAgentsConfig,
  autoDetectProject,
  createAgentsMd,
  type ProjectConfig,
} from './utils/projectConfig';
NEW: import { type ProjectConfig } from './utils/projectConfig';
```

**Line 25 — remove entire line:**
```
OLD: import { SkillDefinition } from './utils/settings';
NEW: (deleted)
```

**Line 26 — remove entire line:**
```
OLD: import { cleanMessages } from './utils/messageCleaner';
NEW: (deleted)
```

**Lines 27-31 — remove ensureProjectDir, keep loadProjectState, saveProjectState, updateProjectTodos:**
```
OLD: import {
  loadProjectState,
  saveProjectState,
  updateProjectTodos,
  ensureProjectDir,
} from './storage/projectState';
NEW: import {
  loadProjectState,
  saveProjectState,
  updateProjectTodos,
} from './storage/projectState';
```

**Line 32 — remove entire line:**
```
OLD: import { loadSession } from './utils/session';
NEW: (deleted)
```

**Line 34 — remove entire line:**
```
OLD: import { classifyIntent } from './cli/skillGate';
NEW: (deleted)
```

**Line 35 — remove FailureRecord:**
```
OLD: import { isCorrection, saveLearning, type FailureRecord } from './core/learnings';
NEW: import { isCorrection, saveLearning } from './core/learnings';
```

**Line 54 — remove AgentState:**
```
OLD: import { AgentStateMachine, type AgentState } from './core/AgentState';
NEW: import { AgentStateMachine } from './core/AgentState';
```

- [ ] **Step 2: Verify lint after removal**

Run: `npx eslint src/agent.ts`
Expected: Reduced warning count (no unused-var warnings for removed imports)

- [ ] **Step 3: Commit**

```bash
git add src/agent.ts
git commit -m "refactor: remove dead imports from agent.ts after init extraction"
```

---

### Task 4: Remove classifyIntent call from runLoop

**Files:**
- Modify: `src/agent.ts` — lines ~948-955

- [ ] **Step 1: Remove skill gate block**

Replace:
```typescript
      // Skill gate: classify user intent and nudge LLM toward relevant skill
      const suggestedSkill = classifyIntent(prompt);
      if (suggestedSkill) {
        this.emit('skill_suggested', { skill: suggestedSkill, prompt: prompt.slice(0, 100) });
        this.agentAddMessage({
          role: 'system',
          content: `[SKILL HINT] The skill "${suggestedSkill}" may be relevant to this task. Use the skill tool to load full instructions: skill(name="${suggestedSkill}")`,
        });
      }

      // Auto-learning: detect user corrections and persist them
```

With:
```typescript
      // Auto-learning: detect user corrections and persist them
```

- [ ] **Step 2: Verify lint**

Run: `npx eslint src/agent.ts --rules '{"@typescript-eslint/no-unused-vars":"error"}'`
Expected: No new errors

- [ ] **Step 3: Run existing tests**

Run: `npx vitest run src/__tests__/agent.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/agent.ts
git commit -m "refactor: remove classifyIntent skill gate — bootstrap skill handles this"
```

---

### Task 5: Extract executeTools method from runLoop

**Files:**
- Modify: `src/agent.ts` — extract tool execution closure to private method

This extracts the `executeSingleTool` closure and the 3-phase execution (read/write/neutral batches) into a private method.

**Method signature:**
```typescript
private async executeTools(
  toolCalls: Array<{ name: string; id: string; arguments: Record<string, unknown> }>,
  signal: AbortSignal
): Promise<{
  toolResults: Array<{
    name: string;
    id: string;
    result: string;
    isCritical?: boolean;
    referencedSkills?: string[];
  }>;
  fileChanges: string[];
  hadProgress: boolean;
  criticalError: { tool: string; error: string; suggestion: string } | null;
}>
```

- [ ] **Step 1: Move executeSingleTool closure + 3-phase batching to private method**

The method body contains:
1. `executeSingleTool` inner function (from current L1110-L1180 area)
2. Read calls → `Promise.all`
3. Write calls → `detectToolConflicts` → parallel/sequential
4. Neutral calls → `Promise.all`
5. ProgressTracker recordFileChange calls for write/edit/delete results
6. Return the structured result

Insert this method before `runLoop()`.

- [ ] **Step 2: Replace inline code in runLoop with method call**

In runLoop, replace the inline executeSingleTool + batching code with:
```typescript
const {
  toolResults,
  fileChanges,
  hadProgress,
  criticalError,
} = await this.executeTools(response.toolCalls, signal);

allToolResults.push(...toolResults);

// Progress tracking: update stagnation counter via file changes
this.checkStagnation(hadProgress);

// Check for critical error
if (criticalError) {
  this.emit('agent_stopped_on_error', { ... });
  return `[STOPPED] ...`;
}
```

- [ ] **Step 3: Run tests to verify refactoring didn't break anything**

Run: `npx vitest run src/__tests__/agent.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/agent.ts
git commit -m "refactor: extract executeTools method from runLoop"
```

---

### Task 6: Extract callLLM method

**Files:**
- Modify: `src/agent.ts` — extract LLM call + empty-response retry to private method

**Method signature:**
```typescript
private async callLLM(
  signal: AbortSignal
): Promise<{
  response: any; // LLM response with toolCalls, content, finished
  interrupted: boolean;
}>
```

- [ ] **Step 1: Extract LLM call + empty-response handling into private method**

The method handles:
1. The initial `llm.generate()` call via `callLLMWithRetry`
2. Empty response detection (reasoning vs true empty)
3. Empty response retry loop → `generateFromHistory`
4. Returns structured result

- [ ] **Step 2: Replace inline code in runLoop with method call**

```typescript
const { response: llmResponse, interrupted } = await this.callLLM(signal);
if (interrupted) return '[INTERRUPTED]';
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/__tests__/agent.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/agent.ts
git commit -m "refactor: extract callLLM method from runLoop"
```

---

### Task 7: Extract prepareTurn and injectResults methods

**Files:**
- Modify: `src/agent.ts`

- [ ] **Step 1: Extract prepareTurn — everything before the LLM call**

`prepareTurn(prompt: string, signal: AbortSignal)` handles:
- Empty prompt check
- LLM init check
- Auto-checkpoint
- Compression (token usage check + non-blocking compression)
- Token usage emit
- User message emit
- Auto-learning detection
- Tool definitions setup

- [ ] **Step 2: Extract injectResults — everything after tool exec before next LLM call**

`injectResults(toolResults, signal)` handles:
- Skill chain via `referencedSkills`
- Queue input check
- Post-tool messages merge
- `addToolMessages` + `generateFromHistory` via `callLLMWithRetry`
- Error handling for LLM continuation failure

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/__tests__/agent.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/agent.ts
git commit -m "refactor: extract prepareTurn and injectResults from runLoop"
```

---

### Task 8: Rewrite runLoop orchestrator + wire stagnation

**Files:**
- Modify: `src/agent.ts`

- [ ] **Step 1: Rewrite runLoop to use extracted methods + stagnation detection**

New runLoop structure:
```typescript
async runLoop(prompt: string): Promise<string> {
  this._stateMachine.transition('processing');
  // ... cancel-on-entry + abortController setup ...

  try {
    await this.prepareTurn(prompt, signal);
    
    let response;
    try {
      response = await this.callLLM(signal);
      if (response.interrupted) return '[INTERRUPTED]';
    } catch { return error message; }

    this.syncFullHistory();
    if (!response) return 'LLM returned exception, please retry';

    const allToolResults = [];
    let queueInjectedThisIteration = false;

    while (!response.finished && !signal.aborted) {
      // Queue check
      // Empty response handling → callLLM again
      // Tool execution → this.executeTools → checkStagnation
      // Result injection → this.injectResults
      
      const stagnationResult = this.checkStagnation(hadProgress);
      if (stagnationResult === 'warn') {
        this.agentAddMessage({
          role: 'system',
          content: `[WARNING] No file changes in ${SpicaAgent.STAGNATION_WARNING} rounds. If stuck, ask clarifying questions or report what's blocking you.`
        });
      }
      if (stagnationResult === 'stop') {
        this.emit('stagnation_limit', { rounds: SpicaAgent.STAGNATION_LIMIT });
        return `[STOPPED] No progress after ${SpicaAgent.STAGNATION_LIMIT} rounds. The agent may be stuck in a loop.`;
      }
    }

    // Extract assistant content + save state + return
  } finally {
    // cleanup
  }
}
```

- [ ] **Step 2: Wire ProgressTracker in executeTools**

In `executeTools`, after successful write/edit/delete/file_delete:
```typescript
if (result.success) {
  if (resolvedName === 'write' || resolvedName === 'file_write') {
    this._progress.recordFileChange('file_written', tcArgs.path as string);
    fileChanges.push(tcArgs.path as string);
  } else if (resolvedName === 'edit' || resolvedName === 'file_edit' || resolvedName === 'file_multi_edit') {
    this._progress.recordFileChange('file_edited', tcArgs.path as string);
    fileChanges.push(tcArgs.path as string);
  } else if (resolvedName === 'file_delete') {
    this._progress.recordFileChange('file_edited', tcArgs.path as string);
    fileChanges.push(tcArgs.path as string);
  }
}
```

- [ ] **Step 3: Wire ProgressTracker context block in prepareTurn**

In `prepareTurn`, after compression:
```typescript
const progressBlock = this._progress.toContextBlock();
if (progressBlock) {
  this.agentAddMessage({ role: 'system', content: progressBlock });
}
```

- [ ] **Step 4: Run existing tests**

Run: `npx vitest run src/__tests__/agent.test.ts src/__tests__/stagnation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent.ts
git commit -m "refactor: rewrite runLoop as orchestrator with stagnation detection + ProgressTracker"
```

---

### Task 9: Run full verification

- [ ] **Step 1: Type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: fewer warnings than 166 (dead imports removed)

- [ ] **Step 3: Full test suite**

Run: `npm run test:run`
Expected: Same pass/fail counts as before (no regressions)

- [ ] **Step 4: Build**

Run: `npm run build && ./bin/spica --version`
Expected: 1.0.0

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: verification pass — typecheck, lint, tests all green"
```
