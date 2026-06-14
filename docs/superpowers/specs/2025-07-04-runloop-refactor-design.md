# runLoop Refactor — Design Spec

## Date
2025-07-04

## Scope — Three Changes, One Pass

### 1. Delete Skill Gate (`classifyIntent` call)
### 2. Split `runLoop` into three phases
### 3. Replace 50-round hard cap with stagnation detection

All changes touch `src/agent.ts` + remove one import.

---

## Problem

### Skill Gate

`src/cli/skillGate.ts:classifyIntent()` uses keyword matching (105 lines) to inject
`[SKILL HINT]` messages before user input reaches the LLM. This conflicts with the
bootstrap skill ("using-superpowers") which tells the LLM to autonomously judge which
skills apply. The code-level keyword match overrides the LLM's judgment.

**Decision:** Delete the `classifyIntent` call and its import. No replacement needed.

### Monolithic runLoop

`runLoop` is ~700 lines (L495–L1200 area). It interleaves:
- Message preparation (compression, skill invocation, user message injection)
- LLM API call (streaming, retry, interrupt handling)
- Tool execution (parallel/sequential, subagent dispatch, conflict detection)
- Result injection (formatting, state save, loop control)

This makes it hard to test individual phases and hard to insert cross-cutting
concerns like progress tracking.

### 50-Round Hard Cap

```typescript
while (iterations < 50 && !finished)
```

A multi-file refactor (10+ files × 4 rounds each: read→edit→lint→verify = 40 rounds)
can easily exceed 50. The cap is arbitrary and unrelated to actual work patterns.

---

## Design

### RunLoop Flow (Before/After)

**Before:**
```
runLoop(userMessage)
  └── while (iterations < 50 && !finished)
      ├── [700 lines of interleaved logic]
      └── iterations++
```

**After:**
```
runLoop(userMessage)
  └── prepareTurn(userMessage)              // ~100 lines
      └── while (!finished)
          ├── callLLM()                     // ~150 lines
          ├── executeTools(response)        // ~200 lines
          └── injectResults(toolResults)    // ~100 lines
              └── detectStagnation()        // ~30 lines
```

### Phase Interfaces

```typescript
interface TurnInput {
  lastResult: string;
  toolCalls: Array<{ name: string; id: string; arguments: Record<string, unknown> }>;
}

interface TurnResult {
  toolResults: Array<{
    id: string;
    name: string;
    output: string;
    success: boolean;
  }>;
  fileChanges: string[];   // Changed file paths (for stagnation detection)
  hadProgress: boolean;     // True if any file was created/edited/deleted
}
```

### Private Method Signatures

```typescript
// Phase 1: Prepare turn — compression, message cleanup, user message injection
private async prepareTurn(userMessage?: string): Promise<void>;

// Phase 2: Call LLM — send messages, stream, parse response
private async callLLM(): Promise<{
  message: ChatMessage;
  toolCalls: Array<{ name: string; id: string; arguments: Record<string, unknown> }>;
}>;

// Phase 3: Execute tools — conflict detection, parallel/sequential dispatch, subagents
private async executeTools(toolCalls: Array<...>): Promise<TurnResult>;

// Phase 4: Inject results — format tool outputs, add to history, save state
private async injectResults(result: TurnResult): Promise<void>;

// Stagnation check — called at end of injectResults
private checkStagnation(hadProgress: boolean): 'continue' | 'warn' | 'stop';
```

### Stagnation Detection

```typescript
private _stagnationCounter: number = 0;
private readonly STAGNATION_WARNING = 8;   // inject system warning after 8 idle rounds
private readonly STAGNATION_LIMIT = 16;    // force stop after 16 idle rounds

private checkStagnation(hadProgress: boolean): 'continue' | 'warn' | 'stop' {
  if (hadProgress) {
    this._stagnationCounter = 0;
    return 'continue';
  }
  this._stagnationCounter++;
  if (this._stagnationCounter === this.STAGNATION_WARNING) {
    return 'warn';
  }
  if (this._stagnationCounter >= this.STAGNATION_LIMIT) {
    return 'stop';
  }
  return 'continue';
}
```

**"Progress" definition:** A turn has progress if any file was written (`write`),
edited (`edit`), or deleted (`file_delete`), OR if a todo status changed, OR if
a checkpoint was created. Read/grep/glob/list-only turns are not progress.

### ProgressTracker Integration

`ProgressTracker` (already exists in `src/core/progressTracker.ts`) is wired in:

- `executeTools()`: after each write/edit/delete tool → `this._progress.recordFileChange(type, path)`
- `prepareTurn()`: before compression → `this._progress.toContextBlock()` injected as system context

### What Gets Deleted

From `agent.ts`:
- `import { classifyIntent } from './cli/skillGate'` (removed)
- `classifyIntent()` call + `[SKILL HINT]` injection logic (removed)
- `let iterations = 0; while (iterations < 50)` loop control (replaced)

Unused imports removed from `agent.ts`:
- `initMCP` (moved to `init.ts`)
- `initSkills`, `listSkills` (moved to `init.ts`)
- `getSystemPrompt`, `getSystemPromptStable`, `getSystemPromptVariable` (moved to `init.ts`)
- `loadAgentsConfig`, `autoDetectProject`, `createAgentsMd`, `ProjectConfig` (moved to `init.ts`)
- `SkillDefinition` (unused in agent.ts)
- `cleanMessages` (unused in agent.ts)
- `loadProjectState`, `saveProjectState`, `updateProjectTodos`, `ensureProjectDir` (moved to `init.ts`)
- `loadSession` (moved to `init.ts`)
- `runPreHooks`, `runPostHooks` (unused in agent.ts after init extraction)
- `isCorrection`, `saveLearning`, `FailureRecord` (unused in agent.ts)
- `createCheckpoint`, `listCheckpoints`, `CheckpointMeta` (unused in agent.ts)
- `simpleGit` (unused in agent.ts)
- `recordToolUsage` (unused in agent.ts)

### What Does NOT Change

- Tool execution logic (parallel/sequential dispatch, subagent, interrupt)
- Conflict detection algorithm
- Compression/compaction logic (still called from `prepareTurn`)
- Session persistence and state save
- Event emissions (stream, tool_progress, etc.)
- Public API of `SpicaAgent`

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Stagnation false positives | Definition conservative: only file mutations count. Pure exploration (read/grep) resets only if file was previously edited. |
| Stagnation false negatives | 16-round limit catches infinite loops. Warning at 8 gives LLM chance to self-correct. |
| Method extraction breaks `this` binding | All methods use arrow functions or bound methods. |
| Unused import removal breaks `init.ts` | Only removes from `agent.ts`. `init.ts` has its own imports. |

---

## Testing

### New Tests

1. **Stagnation detection unit tests**
   - Progress resets counter to 0
   - 8 rounds no progress → returns 'warn'
   - 16 rounds no progress → returns 'stop'
   - Read-only turns do not count as progress
   - File write/edit/delete counts as progress

2. **Phase method integration tests**
   - `prepareTurn` handles empty user message
   - `callLLM` returns structured response
   - `executeTools` handles empty tool list
   - `injectResults` formats tool outputs correctly

### Existing Tests

All existing agent tests must pass. No behavior changes to public API.

---

## Implementation Order

1. Remove dead imports from `agent.ts`
2. Remove `classifyIntent` call and skill gate logic
3. Extract `prepareTurn` method
4. Extract `callLLM` method
5. Extract `executeTools` method
6. Extract `injectResults` method
7. Implement `checkStagnation` + wire into loop
8. Wire `ProgressTracker` into `executeTools` and `prepareTurn`
9. Run full test suite + lint
