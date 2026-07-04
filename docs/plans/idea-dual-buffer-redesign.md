# Plan: Idea Workspace — Full-Screen Dual-Buffer Redesign

## Context

The current idea workspace uses a **7-row fixed overlay** that steals space from the main scrollback area. This causes several problems:

- Only 4 ideas visible, no pagination for larger lists
- Overlay rows reduce main scrollback area — visual interference
- Subagent overlay and idea overlay share the same row reservation mechanism (`overlayRows`) — conflicts possible
- Help text misleading (`[1-9]=fill` but multi-digit IDs work)

The fix: give each workspace its **own independent scrollback buffer** and **full terminal height**. Toggling via Shift+Tab switches the entire screen to the target workspace's saved state.

## Design

### Core idea

```
Before (overlay):                    After (dual-buffer):
┌──────────────────────┐             ┌──────────────────────┐
│ main scrollback      │             │ main scrollback      │
│ ...                  │             │ ...                  │
│ [7 rows stolen by    │             │ full height          │
│  idea overlay]       │             │                      │
│ status               │             │ status               │
│ > _                  │             │ > _                  │
└──────────────────────┘             └──────────────────────┘
                                     ⇅ Shift+Tab
                                     ┌──────────────────────┐
                                     │ idea scrollback      │
                                     │  [ ] [1] idea text   │
                                     │  [x] [2] done idea   │
                                     │ ...                  │
                                     │ status               │
                                     │ idea> _              │
                                     └──────────────────────┘
```

### Data model changes

Add to `ScreenState`:
```typescript
ideaScrollbackBuffer: ScrollbackBuffer;   // independent scrollback for idea workspace
```

Remove / repurpose:
- `ideaOverlayRenderFn` — no longer needed (no overlay to render)
- `setIdeaOverlayRenderFn()` — removed
- `writeOverlay()` for idea — removed; idea output goes to scrollback

### Key changes in screenManager.ts

**1. Active scrollback getter**
```typescript
private get activeScrollback(): ScrollbackBuffer {
  return this.state.workspace === 'idea'
    ? this.state.ideaScrollbackBuffer
    : this.state.scrollbackBuffer;
}
```
All methods that write to `this.state.scrollbackBuffer` use `this.activeScrollback` instead:
- `appendScroll()` (lines 251, 257)
- `appendStreamChunk()` (line ~304)
- `handleResize()` replay source

**2. `enterIdeaWorkspace()`** — full-screen switch, no overlay
- Save main input buffer + cursor (already done)
- Save main scroll position (cursor row in scrollback — not needed for replay since we replay from buffer)
- Clear screen (`ESC[2J`)
- Set scroll region to full height (no `overlayRows` reservation)
- Replay `ideaScrollbackBuffer` history to terminal (same pattern as `handleResize()`)
- Draw idea status bar
- Draw `idea> ` input prompt
- Restore cursor to idea input

**3. `exitIdeaWorkspace()`** — full-screen switch back
- Save idea input buffer + cursor (already done)
- Clear screen
- Set scroll region normally
- Replay main `scrollbackBuffer` history to terminal
- Draw main status bar
- Draw `> ` input prompt
- Restore cursor to main input

**4. `toggleWorkspace()`** — no change, just calls enter/exit

### Changes in interactive.ts — idea input handler

Replace overlay refresh calls with scrollback writes:

| Current (overlay) | New (scrollback) |
|---|---|
| `screen.writeOverlay(renderIdeaOverlay(ideas))` | `screen.appendScroll(...)` with confirmation line |
| After creating idea | `[+] #N: idea text` |
| After marking done | `[✓] #N marked done` |
| After deleting | `[✗] #N deleted` |
| `/ideas` in idea workspace | Already writes to scrollback via `appendScroll` |

Remove:
- `screen.setIdeaOverlayRenderFn(...)` call from `interactive.ts` line 170-173
- `screen.writeOverlay(renderIdeaOverlay(ideas))` calls (lines 312, 325, 366)

### Changes in slash/idea.ts

- `ctx.screen.writeOverlay(renderIdeaOverlay(...))` → remove or replace with scrollback write
- `ctx.screen.enterIdeaWorkspace()` on `/idea` (no args) stays the same

### Changes in ideaOverlay.ts

No longer referenced — can be kept as dead code for now, or removed. The `renderIdeaOverlay()` function is only called in two places:
1. `interactive.ts` — the `setIdeaOverlayRenderFn` callback (will be removed)
2. `slash/idea.ts` — `writeOverlay` calls (will be removed)

We'll remove `renderIdeaOverlay` usage but keep the file for potential future overlay needs.

```typescript
// Path: src/cli/ui/screenManager.ts (modified)
// Removed: line 170-173 (setIdeaOverlayRenderFn call), lines 312,325,366 (writeOverlay calls)
```

### Files modified

1. **`src/cli/ui/screenManager.ts`** — main changes
   - Add `ideaScrollbackBuffer` to state, init in constructor
   - Add `activeScrollback` getter
   - Route buffer writes through getter
   - Rewrite `enterIdeaWorkspace()` / `exitIdeaWorkspace()` — full screen redraw, no overlay
   - Remove `setIdeaOverlayRenderFn()`
   - Keep `setOverlay()` / `writeOverlay()` (still used by subagent)

2. **`src/commands/interactive.ts`** — idea input handler
   - Remove `setIdeaOverlayRenderFn` call
   - Replace `writeOverlay(renderIdeaOverlay(...))` with `appendScroll` confirmations
   - After `addIdea`: append confirmation + refresh idea scrollback
   - After `markDone`/`deleteIdea`: append confirmation + refresh

3. **`src/commands/slash/idea.ts`** — slash command handler
   - Remove `writeOverlay(renderIdeaOverlay(...))` calls from done/delete/open handlers
   - Keep scrollback-based output (already works via `appendScroll`)

4. **`src/cli/ui/ideaOverlay.ts`** — no changes, becomes dead code (clean removal optional)

### Concurrency: blocking toggle during agent processing

**Problem**: Agent output is routed through `activeScrollback`. If user toggles to idea workspace while agent is still processing (after streaming ends but before all tool calls complete), subsequent `appendScroll` calls go to the wrong buffer.

**Fix**: Add `onBeforeToggle` callback to `ScreenState`, set from `interactive.ts`. `toggleWorkspace()` checks it and no-ops if it returns `false`.

```typescript
// ScreenState:
onBeforeToggle?: () => boolean;

// toggleWorkspace():
if (this.state.onBeforeToggle && !this.state.onBeforeToggle()) return;

// interactive.ts:
screen.state.onBeforeToggle = () => !isProcessing;
```

This ensures workspace switching only happens when the agent is idle. Streaming-level blocking (ESC sequences ignored) remains as the first line of defense.

### Edge cases handled

- **Toggle during streaming**: already blocked — Shift+Tab starts with ESC, caught by `data.startsWith(ESC)` at line 828 during streaming mode
- **Toggle during processing (between streaming bursts)**: blocked by `onBeforeToggle` → `!isProcessing` check
- **Resize in idea workspace**: `handleResize()` uses `activeScrollback` via getter — replays correct buffer
- **Subagent overlay active when toggling**: `enterIdeaWorkspace()` no longer calls `stopSubAgentRefresh()` or touches overlay rows — no interference (subagent refresh writes to overlay, which is independent of scrollback)
- **Exit via Ctrl+C**: Input handler stays the same — interrupt clears input buffer, workspace state unchanged
- **Empty idea list**: Replays empty buffer → blank scrollback area with `idea> ` prompt
- **Idea workspace during agent idle only**: Toggle is only possible when agent is not processing → no output routing conflicts

### Verification

1. `npm run build` — compile check
2. `npx tsc --noEmit` — type check
3. Manual test:
   - Start spica, press Shift+Tab → should see full-screen idea workspace
   - Type some ideas → should appear in idea scrollback
   - Type `/ideas` → should list all ideas in scrollback
   - Type `d1`, `x2` → should confirm in scrollback
   - Press Shift+Tab again → back to main workspace, all main output preserved
   - Enter main input, press Shift+Tab → should see main workspace unchanged
   - Empty enter in idea workspace → exit back to main
