# Subagent Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace polluting appendScroll-based subagent panel with a fixed 6-row overlay between scrollback and status bar, with real-time refresh, visual hierarchy, and a `/subagents` detail command.

**Architecture:** ScreenManager gains an overlay region API. `subagentPanel.ts` is rewritten to render into overlay lines instead of appendScroll. Events drive data updates; a 1-second timer drives overlay rerenders. The overlay never enters scrollback — only the final panel is written once on close.

**Tech Stack:** TypeScript, chalk, ANSI escape codes, existing ScreenManager

---

## File Structure

| File | Role |
|------|------|
| `src/cli/subagentPanel.ts` | **Rewrite** — Data model, overlay render function, type icons, priority sort |
| `src/cli/ui/screenManager.ts` | **Add** — `setSubAgentOverlay()`, `writeSubAgentOverlay()`, `startSubAgentRefresh()`, `stopSubAgentRefresh()` |
| `src/cli/events.ts` | **Modify** — Subagent event handlers use overlay lifecycle |
| `src/cli/formatting.ts` | **Modify** — `formatToolArgs` already exists, no changes needed |
| `src/commands/slash/subagents.ts` | **New** — `/subagents` slash command (full detail view) |
| `src/commands/slash/index.ts` | **Modify** — Register `/subagents` route |

---

### Task 1: Extend SubAgentRecord and subAgentState

**Files:**
- Modify: `src/cli/subagentPanel.ts:5-19`

- [ ] **Step 1: Add new fields to SubAgentRecord interface**

Replace the `SubAgentRecord` interface:

```typescript
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
  // NEW fields
  currentTool?: string;
  toolStartTime?: number;
  priority: number; // 0=error, 1=running, 2=done
}
```

- [ ] **Step 2: Add type icon mapping and getSortedAgents helper**

Add after the `subAgentState` object definition:

```typescript
export const SUBAGENT_TYPE_ICONS: Record<string, string> = {
  explore: '🔍',
  review: '🔎',
  fix: '🔧',
  build: '🏗️',
};

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerIndex = 0;

export function nextSpinnerFrame(): string {
  spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[spinnerIndex];
}

export function getSortedAgents(): SubAgentRecord[] {
  return Array.from(subAgentState.agents.values())
    .sort((a, b) => a.priority - b.priority);
}
```

- [ ] **Step 3: Verify typecheck**

```bash
npx tsc --noEmit src/cli/subagentPanel.ts
```

Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/cli/subagentPanel.ts
git commit -m "feat(subagent): extend SubAgentRecord with priority, currentTool, type icons"
```

---

### Task 2: Add overlay API to ScreenManager

**Files:**
- Modify: `src/cli/ui/screenManager.ts`

- [ ] **Step 1: Add overlay state fields to ScreenState interface**

Add after `rainTop: number;` (line ~37):

```typescript
  /** Subagent overlay: 0 when hidden, 6 when visible */
  subAgentOverlayRows: number;
```

Add to constructor's `this.state = {` (after `rainTop: 1,`):

```typescript
      subAgentOverlayRows: 0,
```

- [ ] **Step 2: Add screen state field for overlay timer**

Add to the `ScreenManager` class private fields (after `private thinkingAnimationFrames`):

```typescript
  private subAgentRefreshTimer: NodeJS.Timeout | null = null;
```

- [ ] **Step 3: Implement setSubAgentOverlay()**

Add as a public method after `clearThinkingAnimation()`:

```typescript
  /** Reserve/free 6 rows for subagent overlay between scrollback and status bar */
  setSubAgentOverlay(visible: boolean): void {
    const newRows = visible ? 6 : 0;
    if (this.state.subAgentOverlayRows === newRows) return;

    this.state.subAgentOverlayRows = newRows;
    this.state.scrollBottom = this.state.statusRow - 1 - newRows;

    // Clear overlay area if hiding
    if (!visible) {
      for (let row = this.state.scrollBottom + 1; row <= this.state.statusRow - 1; row++) {
        writeStdout(`${ESC}[${row};1H${ESC}[2K`);
      }
    }

    // Reset scroll region
    writeStdout(`${ESC}[1;${this.state.scrollBottom}r`);

    // Reposition cursor to scroll bottom so next appendScroll writes in correct place
    this.state.cursorInScrollArea = true;
    writeStdout(`${ESC}[?25l`);
    writeStdout(`${ESC}[${this.state.scrollBottom};1H`);
  }
```

- [ ] **Step 4: Implement writeSubAgentOverlay()**

Add after `setSubAgentOverlay()`:

```typescript
  /** Write lines directly to overlay region — no scrollback buffer, no table state machine */
  writeSubAgentOverlay(lines: string[]): void {
    if (this.state.subAgentOverlayRows === 0) return;

    const startRow = this.state.scrollBottom + 1;
    writeStdout(`${ESC}[?25l`);
    for (let i = 0; i < this.state.subAgentOverlayRows && i < lines.length; i++) {
      writeStdout(`${ESC}[${startRow + i};1H${ESC}[2K${lines[i]}`);
    }
  }
```

- [ ] **Step 5: Implement startSubAgentRefresh() and stopSubAgentRefresh()**

Add after `writeSubAgentOverlay()`:

```typescript
  /** Start periodic overlay refresh. Stops automatically when renderFn returns empty array. */
  startSubAgentRefresh(intervalMs: number, renderFn: () => string[]): void {
    this.stopSubAgentRefresh();
    this.subAgentRefreshTimer = setInterval(() => {
      const lines = renderFn();
      if (lines.length === 0) {
        this.stopSubAgentRefresh();
        return;
      }
      this.writeSubAgentOverlay(lines);
    }, intervalMs);
  }

  stopSubAgentRefresh(): void {
    if (this.subAgentRefreshTimer) {
      clearInterval(this.subAgentRefreshTimer);
      this.subAgentRefreshTimer = null;
    }
  }
```

- [ ] **Step 6: Update handleResize() to account for overlay**

In `handleResize()`, change the line:
```
this.state.scrollBottom = this.state.statusRow - 1;
```
to:
```
this.state.scrollBottom = this.state.statusRow - 1 - this.state.subAgentOverlayRows;
```

- [ ] **Step 7: Verify typecheck**

```bash
npx tsc --noEmit src/cli/ui/screenManager.ts
```

Expected: 0 errors

- [ ] **Step 8: Commit**

```bash
git add src/cli/ui/screenManager.ts
git commit -m "feat(screen): add subagent overlay region API"
```

---

### Task 3: Rewrite subagentPanel.ts render function

**Files:**
- Modify: `src/cli/subagentPanel.ts` (replace `displaySubAgentPanel` and related exports)

- [ ] **Step 1: Remove displaySubAgentPanel() and add renderOverlay()**

Replace the entire `displaySubAgentPanel()` function with:

```typescript
export function renderOverlay(): string[] {
  const agents = getSortedAgents();
  if (agents.length === 0) return [];

  const termWidth = getTerminalWidth();
  const running = agents.filter(a => a.status === 'running').length;
  const done = agents.filter(a => a.status === 'done').length;
  const error = agents.filter(a => a.status === 'error').length;

  const title = `Subagents (${running} running, ${done} done, ${error} error)`;
  const boxWidth = Math.min(termWidth - 4, Math.max(getStringDisplayWidth(title) + 4, 40));

  const lines: string[] = [];

  // Row 0: title
  const titleLine = `┌${'─'.repeat(boxWidth - 2)}┐`;
  lines.push(COLORS.secondary.bold(titleLine));

  const paddedTitle = `│ ${title}${' '.repeat(Math.max(0, boxWidth - 2 - getStringDisplayWidth(title)))}│`;
  lines.push(COLORS.secondary.bold(paddedTitle));

  // Rows 1-4: display up to 2 highest-priority agents (each 2 rows)
  let displayCount = 0;
  const now = Date.now();

  for (const agent of agents) {
    if (displayCount >= 2) break;

    const elapsed = formatElapsed(now - agent.startTime);
    const icon = SUBAGENT_TYPE_ICONS[agent.type] || '•';

    let statusColor: (s: string) => string;
    let statusIcon: string;

    if (agent.status === 'running') {
      statusColor = COLORS.primary; // cyanBright
      statusIcon = nextSpinnerFrame();
    } else if (agent.status === 'done') {
      statusColor = COLORS.success; // greenBright
      statusIcon = '✓';
    } else {
      statusColor = COLORS.error.bold; // redBright.bold
      statusIcon = '✗';
    }

    const statusLine = `${statusIcon} ${icon} ${agent.label} ${agent.description} (${elapsed})`;
    const paddedStatus = `│ ${statusLine}${' '.repeat(Math.max(0, boxWidth - 2 - getStringDisplayWidth(statusLine)))}│`;
    lines.push(statusColor(paddedStatus));

    // Tool / summary / error line
    if (agent.status === 'running' && agent.currentTool) {
      const toolElapsed = formatElapsed(now - (agent.toolStartTime || agent.startTime));
      const toolLine = `   ↳ ${agent.currentTool} (${toolElapsed})`;
      const paddedTool = `│ ${toolLine}${' '.repeat(Math.max(0, boxWidth - 2 - getStringDisplayWidth(toolLine)))}│`;
      lines.push(COLORS.muted.dim(paddedTool));
    } else if (agent.status === 'done' && agent.summary) {
      const sumLine = `   ${agent.summary}`;
      const paddedSum = `│ ${sumLine}${' '.repeat(Math.max(0, boxWidth - 2 - getStringDisplayWidth(sumLine)))}│`;
      lines.push(COLORS.muted(paddedSum));
    } else if (agent.status === 'error') {
      const firstLine = agent.error ? agent.error.split('\n')[0] : 'unknown error';
      const errLine = `   ${truncateToWidth(firstLine, boxWidth - 6)} [...]`;
      const paddedErr = `│ ${errLine}${' '.repeat(Math.max(0, boxWidth - 2 - getStringDisplayWidth(errLine)))}│`;
      lines.push(COLORS.error(paddedErr));
    } else {
      const emptyLine = `│${' '.repeat(boxWidth - 2)}│`;
      lines.push(COLORS.secondary(emptyLine));
    }

    displayCount++;
  }

  // Fill remaining rows with empty lines
  while (lines.length < 6) {
    const emptyLine = `│${' '.repeat(boxWidth - 2)}│`;
    lines.push(COLORS.secondary(emptyLine));
  }

  // Row 5: bottom border
  const bottomLine = `└${'─'.repeat(boxWidth - 2)}┘`;
  lines.push(COLORS.secondary.bold(bottomLine));

  return lines;
}

/** Render the final panel into scrollback (called once on close). Uses the same visual format. */
export function writeFinalPanelToScrollback(): void {
  const lines = renderOverlay();
  if (lines.length === 0) return;

  const screen = getScreenManager();
  // Strip ANSI: appendScroll stores clean text — but we want colored output.
  // Write directly to stdout within the scroll region.
  screen.appendScroll('\n');
  for (const line of lines) {
    screen.appendScroll(line + '\n');
  }
}
```

- [ ] **Step 2: Remove unused imports from subagentPanel.ts**

Remove `getScreenManager` from the imports (no longer used by `renderOverlay` — `writeFinalPanelToScrollback` imports it locally or we can keep it):

Actually, `writeFinalPanelToScrollback` uses `getScreenManager()`, so keep it. No changes needed to imports.

- [ ] **Step 3: Verify typecheck**

```bash
npx tsc --noEmit src/cli/subagentPanel.ts
```

Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/cli/subagentPanel.ts
git commit -m "feat(subagent): rewrite panel as overlay render function with real-time refresh"
```

---

### Task 4: Rewrite subagent event handlers in events.ts

**Files:**
- Modify: `src/cli/events.ts:421-515` (subagent event handlers)

- [ ] **Step 1: Update imports**

Change the import line:
```typescript
import { subAgentState, displaySubAgentPanel, type SubAgentRecord } from './subagentPanel';
```
to:
```typescript
import { subAgentState, renderOverlay, writeFinalPanelToScrollback, nextSpinnerFrame, type SubAgentRecord } from './subagentPanel';
```

Also add `formatToolArgs` to the formatting imports (it's not imported yet — check):

```bash
# Check if formatToolArgs is imported in events.ts
grep 'formatToolArgs' src/cli/events.ts
```

If not imported, add it to the existing import block from `./formatting`:
```typescript
  formatToolArgs,
```

- [ ] **Step 2: Add overlay state tracking variables**

Add after `let subAgentSeq = 0;` (line ~209):
```typescript
let subAgentOverlayActive = false;
```

- [ ] **Step 3: Add function to check if all agents done/error**

Add after the `subAgentSeq` declaration:
```typescript
function allAgentsFinished(): boolean {
  for (const a of subAgentState.agents.values()) {
    if (a.status === 'running') return false;
  }
  return subAgentState.agents.size > 0;
}
```

- [ ] **Step 4: Add overlay close function**

```typescript
function closeSubAgentOverlay(): void {
  if (!subAgentOverlayActive) return;
  subAgentOverlayActive = false;
  screen.stopSubAgentRefresh();
  writeFinalPanelToScrollback();
  screen.setSubAgentOverlay(false);
}
```

- [ ] **Step 5: Rewrite `sub_agent_start` handler**

Replace lines ~421-437:
```typescript
  on('sub_agent_start', (data: SubAgentStartData) => {
    subAgentSeq++;
    const type = data.type || 'sub';
    const label = `[#${subAgentSeq} ${type}]`;
    subAgentState.add(data.id, {
      type,
      description: truncateToWidth(data.description || data.prompt.slice(0, 60), 50),
      status: 'running',
      startTime: Date.now(),
      toolCount: 0,
      label,
      priority: 1,
    });

    // First subagent: open overlay
    if (!subAgentOverlayActive) {
      subAgentOverlayActive = true;
      screen.setSubAgentOverlay(true);
      screen.startSubAgentRefresh(1000, renderOverlay);
    }
  });
```

- [ ] **Step 6: Rewrite `sub_agent_tool_call` handler**

Replace lines ~439-443:
```typescript
  on('sub_agent_tool_call', (data: SubAgentToolCallData) => {
    const record = subAgentState.get(data.id);
    if (record) {
      record.toolCount++;
      record.currentTool = `${data.name}${formatToolArgs(data.name, data.arguments || {})}`;
      record.toolStartTime = Date.now();
    }
  });
```

- [ ] **Step 7: Rewrite `sub_agent_tool_result` handler**

Replace lines ~445-447:
```typescript
  on('sub_agent_tool_result', (_data: SubAgentToolResultData) => {
    const record = subAgentState.get(_data.id);
    if (record) {
      record.currentTool = undefined;
      record.toolStartTime = undefined;
    }
  });
```

- [ ] **Step 8: Rewrite `sub_agent_done` handler**

Replace lines ~449-459:
```typescript
  on('sub_agent_done', (data: SubAgentDoneData) => {
    subAgentStreamedChars.delete(data.id);

    const record = subAgentState.get(data.id);
    if (record) {
      record.status = 'done';
      record.summary = truncateToWidth(data.summary || 'done', 60);
      record.priority = 2;
      record.currentTool = undefined;
    }

    if (allAgentsFinished()) {
      closeSubAgentOverlay();
    }
  });
```

- [ ] **Step 9: Rewrite `sub_agent_error` handler**

Replace lines ~461-471:
```typescript
  on('sub_agent_error', (data: SubAgentErrorData) => {
    subAgentStreamedChars.delete(data.id);

    const record = subAgentState.get(data.id);
    if (record) {
      record.status = 'error';
      record.error = data.error; // Full error, no truncation
      record.summary = data.error.split('\n')[0].slice(0, 60); // First line as summary
      record.priority = 0;
      record.currentTool = undefined;
    }

    if (allAgentsFinished()) {
      closeSubAgentOverlay();
    }
  });
```

- [ ] **Step 10: Update `waiting_for_llm` handler**

Replace the existing `waiting_for_llm` handler (lines ~230-237) to also close overlay:
```typescript
  on('waiting_for_llm', () => {
    reasoningStarted = false;
    resetToolTracking();
    closeSubAgentOverlay();
    subAgentState.clear();
    subAgentStreamedChars.clear();
    subAgentSeq = 0;
    screen.clearThinkingAnimation();
  });
```

- [ ] **Step 11: Verify typecheck**

```bash
npx tsc --noEmit src/cli/events.ts
```

Expected: 0 errors (may have pre-existing warnings, ignore)

- [ ] **Step 12: Commit**

```bash
git add src/cli/events.ts
git commit -m "feat(subagent): wire overlay lifecycle into event handlers"
```

---

### Task 5: Create `/subagents` slash command

**Files:**
- Create: `src/commands/slash/subagents.ts`
- Modify: `src/commands/slash/index.ts`

- [ ] **Step 1: Create `src/commands/slash/subagents.ts`**

```typescript
import { COLORS } from '../../cli/ui/colors';
import { getSortedAgents, SUBAGENT_TYPE_ICONS } from '../../cli/subagentPanel';
import { formatElapsed } from '../../cli/formatting';
import type { SlashHandler } from './types';

export const subagentsHandler: SlashHandler = async (_args, ctx) => {
  const agents = getSortedAgents();

  if (agents.length === 0) {
    ctx.screen.appendScroll(COLORS.muted('\nNo subagents have been dispatched in this session.\n\n'));
    return;
  }

  ctx.screen.appendScroll(COLORS.secondary.bold('\nSubagents (History)\n'));
  ctx.screen.appendScroll(COLORS.muted('─'.repeat(60) + '\n'));

  for (const agent of agents) {
    const icon = SUBAGENT_TYPE_ICONS[agent.type] || '•';
    const elapsed = formatElapsed(Date.now() - agent.startTime);

    let statusColor: (s: string) => string;
    let statusLabel: string;
    if (agent.status === 'running') {
      statusColor = COLORS.primary;
      statusLabel = 'RUNNING';
    } else if (agent.status === 'done') {
      statusColor = COLORS.success;
      statusLabel = 'DONE';
    } else {
      statusColor = COLORS.error;
      statusLabel = 'ERROR';
    }

    ctx.screen.appendScroll(
      statusColor(`${icon} ${agent.label} ${statusLabel} — ${agent.description}\n`)
    );
    ctx.screen.appendScroll(COLORS.muted(`  Duration: ${elapsed} | Tools: ${agent.toolCount}\n`));

    if (agent.status === 'done' && agent.summary) {
      ctx.screen.appendScroll(COLORS.success(`  Summary: ${agent.summary}\n`));
    } else if (agent.status === 'error') {
      if (agent.error) {
        const lines = agent.error.split('\n');
        ctx.screen.appendScroll(COLORS.error(`  Error: ${lines[0]}\n`));
        if (lines.length > 1) {
          ctx.screen.appendScroll(COLORS.muted(`  Full trace:\n`));
          for (const line of lines.slice(1, 8)) {
            ctx.screen.appendScroll(COLORS.muted(`    ${line.slice(0, 100)}\n`));
          }
          if (lines.length > 8) {
            ctx.screen.appendScroll(COLORS.muted(`    ... (${lines.length - 8} more lines)\n`));
          }
        }
      }
    } else if (agent.status === 'running' && agent.currentTool) {
      ctx.screen.appendScroll(COLORS.primary(`  Currently: ${agent.currentTool}\n`));
    }

    ctx.screen.appendScroll('\n');
  }

  ctx.screen.appendScroll('\n');
};
```

- [ ] **Step 2: Register `/subagents` in `src/commands/slash/index.ts`**

Add import at top:
```typescript
import { subagentsHandler } from './subagents';
```

Add route before the final `return false;` (after the `/init` handler):
```typescript
  // /subagents
  if (cmd === 'subagents') {
    await subagentsHandler('', ctx);
    return true;
  }
```

- [ ] **Step 3: Verify typecheck**

```bash
npx tsc --noEmit src/commands/slash/subagents.ts src/commands/slash/index.ts
```

Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/commands/slash/subagents.ts src/commands/slash/index.ts
git commit -m "feat(subagent): add /subagents slash command for detail view"
```

---

### Task 6: End-to-end build and smoke test

**Files:** None (verification only)

- [ ] **Step 1: Run full typecheck**

```bash
npx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 2: Run build**

```bash
npm run build
```

Expected: builds successfully, `./bin/spica --version` outputs "1.0.0"

- [ ] **Step 3: Run lint**

```bash
npm run lint
```

Expected: 0 errors (pre-existing warnings OK)

- [ ] **Step 4: Run existing tests**

```bash
npm run test:run
```

Expected: all tests pass (same pass/fail as before — no regressions)

- [ ] **Step 5: Manual smoke test**

```bash
./bin/spica "read src/cli/subagentPanel.ts and summarize it"
```

Expected during execution:
- When subagent is dispatched: overlay appears between scrollback and status bar
- elapsed times update every second
- current tool shows with elapsed
- On subagent completion: overlay disappears, final panel written to scrollback
- `/subagents` shows full detail

- [ ] **Step 6: Commit** (if any fixup needed)

---

### Task 7: Write tests

**Files:**
- Create: `src/cli/__tests__/subagentOverlay.test.ts`

- [ ] **Step 1: Write unit test for SubAgentRecord and sorting**

```typescript
import { describe, it, expect } from 'vitest';
import { subAgentState, getSortedAgents, renderOverlay, nextSpinnerFrame, SUBAGENT_TYPE_ICONS } from '../subagentPanel';

describe('subAgentState', () => {
  beforeEach(() => {
    subAgentState.clear();
  });

  it('adds and retrieves agents', () => {
    subAgentState.add('id-1', {
      type: 'explore',
      description: 'find auth',
      status: 'running',
      startTime: Date.now(),
      toolCount: 0,
      label: '[#1 explore]',
      priority: 1,
    });
    expect(subAgentState.agents.size).toBe(1);
    expect(subAgentState.get('id-1')?.type).toBe('explore');
  });
});

describe('getSortedAgents', () => {
  beforeEach(() => {
    subAgentState.clear();
  });

  it('sorts error before running before done', () => {
    subAgentState.add('d', { type: 'explore', description: 'd', status: 'done', startTime: Date.now(), toolCount: 0, label: '[#3]', priority: 2 });
    subAgentState.add('e', { type: 'fix', description: 'e', status: 'error', startTime: Date.now(), toolCount: 0, label: '[#1]', priority: 0, error: 'fail' });
    subAgentState.add('r', { type: 'build', description: 'r', status: 'running', startTime: Date.now(), toolCount: 0, label: '[#2]', priority: 1 });

    const sorted = getSortedAgents();
    expect(sorted[0].id).toBe('e'); // error first
    expect(sorted[1].id).toBe('r'); // running second
    expect(sorted[2].id).toBe('d'); // done last
  });
});

describe('SUBAGENT_TYPE_ICONS', () => {
  it('has icons for all four types', () => {
    expect(SUBAGENT_TYPE_ICONS.explore).toBeTruthy();
    expect(SUBAGENT_TYPE_ICONS.review).toBeTruthy();
    expect(SUBAGENT_TYPE_ICONS.fix).toBeTruthy();
    expect(SUBAGENT_TYPE_ICONS.build).toBeTruthy();
  });
});

describe('nextSpinnerFrame', () => {
  it('cycles through frames', () => {
    const frames = new Set<string>();
    for (let i = 0; i < 10; i++) frames.add(nextSpinnerFrame());
    expect(frames.size).toBe(10); // all 10 unique
  });
});

describe('renderOverlay', () => {
  beforeEach(() => {
    subAgentState.clear();
  });

  it('returns empty array when no agents', () => {
    expect(renderOverlay()).toEqual([]);
  });

  it('returns 7 lines (title + 5 content + bottom) when agents exist', () => {
    subAgentState.add('id-1', {
      type: 'explore',
      description: 'test',
      status: 'running',
      startTime: Date.now(),
      toolCount: 0,
      label: '[#1 explore]',
      priority: 1,
    });
    const lines = renderOverlay();
    expect(lines.length).toBe(7); // top border + title + status + tool + empty + empty + bottom
  });

  it('shows done agent without spinner', () => {
    subAgentState.add('id-1', {
      type: 'explore',
      description: 'test',
      status: 'done',
      startTime: Date.now(),
      toolCount: 0,
      label: '[#1 explore]',
      priority: 2,
      summary: 'all good',
    });
    const lines = renderOverlay();
    const statusLine = lines[2]; // Skip top border and title
    expect(statusLine).toContain('✓');
    expect(statusLine).not.toContain('⠋');
  });

  it('shows error agent with error detail', () => {
    subAgentState.add('id-1', {
      type: 'fix',
      description: 'test',
      status: 'error',
      startTime: Date.now(),
      toolCount: 0,
      label: '[#1 fix]',
      priority: 0,
      error: 'ENOENT: no such file',
    });
    const lines = renderOverlay();
    expect(lines.some(l => l.includes('ENOENT'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run src/cli/__tests__/subagentOverlay.test.ts
```

Expected: all pass

- [ ] **Step 3: Commit**

```bash
git add src/cli/__tests__/subagentOverlay.test.ts
git commit -m "test(subagent): add unit tests for overlay data model and rendering"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run full test suite**

```bash
npm run test:run
```

Expected: no regressions

- [ ] **Step 2: Full lint + typecheck**

```bash
npm run lint && npx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 3: Build**

```bash
npm run build && ./bin/spica --version
```

Expected: outputs "1.0.0"

- [ ] **Step 4: Commit any final fixups**

```bash
git status
# Commit any remaining changes
```
