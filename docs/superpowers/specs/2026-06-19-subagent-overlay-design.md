# Subagent Overlay — TUI Display Improvement

Date: 2026-06-19
Branch: `improve-subagent-display`

## Problem

Current subagent panel uses `appendScroll()` — each state change writes a new copy into scrollback. This causes:

1. **Scrollback pollution**: 5–7 duplicate panels for a 3‑subagent task
2. **Zero runtime feedback**: panel freezes between state changes, user sees stale `(3.2s)` for 25 seconds
3. **Black‑box tool calls**: subagent tools invisible to the user
4. **Weak visual hierarchy**: uniform color weight across all rows
5. **Truncated errors**: 80‑char error cutoff loses diagnostic info
6. **No priority ordering**: error subagents may be hidden behind `.slice(0,3)`
7. **Missing keyboard access**: no `/subagents` command or detail view

## Design

### Layout

Overlay 6 fixed rows between scrollback and status bar:

```
行 1..scrollBottom-6  → scrollback (shrink by 6)
行 scrollBottom-5..statusRow-1 → subagent overlay (fixed, always visible)
行 statusRow           → status bar
行 statusRow+1..end    → input box
```

Overlay content (example):

```
┌─ Subagents (2 running, 1 done, 0 error) ──────────────┐  ← bold magentaBright
│ ⠇ 🔍 [#1 explore] search auth logic (3.2s)            │  ← cyanBright
│    ↳ grep "authenticate" src/ (1.1s)                  │  ← gray.dim
│ ⠙ 🔧 [#2 build]  implement feature X (5.1s)           │  ← cyanBright
│    ↳ read auth.ts (0.8s)                              │  ← gray.dim
│ ✓ [#3 review]  no issues found                        │  ← greenBright
└────────────────────────────────────────────────────────┘  ← bold magentaBright
```

Status icons: 🔍 explore 🔎 review 🔧 fix 🏗️ build

Spinner frames reuse existing: `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`

### Lifecycle

```
sub_agent_start (first) → screen.setSubAgentOverlay(true)
                           screen.startSubAgentRefresh(1000, renderOverlayFn)
                           SubAgentRecord.priority = 1

sub_agent_tool_call      → record.currentTool = formatToolArgs(name, args)
                           record.toolStartTime = Date.now()
                           (next timer tick refreshes overlay)

sub_agent_done           → record.status = 'done', priority = 2

sub_agent_error          → record.status = 'error', priority = 0
                           record.error = full error (untruncated)

all done/error           → screen.stopSubAgentRefresh()
                           screen.setSubAgentOverlay(false)
                           write final panel to scrollback (once)
```

### Data Structures

`SubAgentRecord` extended:

| Field | Type | New? | Purpose |
|-------|------|------|---------|
| `currentTool` | `string?` | new | Current tool name+args for display |
| `toolStartTime` | `number?` | new | Elapsed time for current tool |
| `priority` | `number` | new | Sort key: error=0, running=1, done=2 |
| `error` | `string` | changed | No longer truncated to 80 chars |

### Color Scheme (chalk)

| Element | Color | Rationale |
|---------|-------|-----------|
| Title / border | `magentaBright.bold` | Top visual layer |
| Running agent | `cyanBright` | High contrast on dark terminal (replaces yellow) |
| Done agent | `greenBright` | Semantic success |
| Error agent | `redBright.bold` | Semantic danger + emphasis |
| Tool detail | `gray.dim` | Background visual layer |
| Spinner | `cyanBright` | Matches running state |

### Sorting

```typescript
// error (0) → running (1) → done (2)
agents.sort((a, b) => a.priority - b.priority);
```

If more than 3 agents active: display 2 highest priority (with tool lines), fold others into title count.

### ScreenManager API

```typescript
setSubAgentOverlay(visible: boolean): void
// Reserves/frees 6 rows. Adjusts scrollBottom. Redraws layout.

writeSubAgentOverlay(lines: string[]): void
// Direct write to overlay rows — no scrollback buffer, no table state machine.
// Uses ESC[row;1H + ESC[2K + text.

startSubAgentRefresh(intervalMs: number, renderFn: () => string[]): void
stopSubAgentRefresh(): void
```

### `/subagents` Slash Command

Shows full detail for all subagents (past + present):

```
Subagents (History)

[#1 explore] DONE — search auth logic
  Duration: 3.2s | Tools: 2
  Summary: Found AuthService in src/auth/service.ts

[#2 build] ERROR — implement feature X
  Duration: 5.1s | Tools: 3
  Error: EACCES: permission denied, open '/etc/config'
  Full trace:
    at Object.openSync (node:fs:...)
    ...
```

### Modified Files

| File | Change | Notes |
|------|--------|-------|
| `src/cli/subagentPanel.ts` | **Rewrite** | Overlay rendering, real-time timer, sorting, weights |
| `src/cli/ui/screenManager.ts` | **Add** | `setSubAgentOverlay`, `writeSubAgentOverlay`, timer start/stop |
| `src/cli/events.ts` | **Modify** | New event handlers for overlay lifecycle |
| `src/cli/formatting.ts` | **Add** | `formatToolArgs` already exists, may need minor tuning |
| `src/tools/impl/task.ts` | **Modify** | `sub_agent_tool_call` already passes `name`+`arguments`, no extra change needed |
| `src/commands/slash/subagents.ts` | **New** | `/subagents` command |
| `src/commands/slash/index.ts` | **Modify** | Register `/subagents` route |

### NOT Changed

- `hacker` mode: subagent events continue to route to matrix rain — overlay is skipped
- `sub_agent_message` / `sub_agent_stream` / `sub_agent_reasoning`: behavior unchanged
- `subAgentState` singleton: enhanced but same API surface
- Tool whitelist / worktree isolation / early‑exit logic in `task.ts`: untouched

## Acceptance Criteria

1. Overlay appears on first `sub_agent_start`, disappears when all done/error
2. Elapsed times update every second in real time
3. Current tool shows with its own elapsed time
4. Error agents sorted to top, errors stored untruncated
5. Final panel written to scrollback once on close
6. No scrollback pollution from intermediate renders
7. `/subagents` shows full detail for all agents
8. Hacker mode unaffected
9. `npm run lint` passes, `npx tsc --noEmit` clean
10. Existing tests pass
