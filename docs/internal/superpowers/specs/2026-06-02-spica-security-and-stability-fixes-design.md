# Spica CLI Security & Stability Fixes — Design Spec

**Date**: 2026-06-02
**Status**: Approved
**Scope**: Fix 29 issues (10 HIGH, 15 MEDIUM, 4 LOW) from comprehensive security assessment

---

## Overview

This spec covers targeted fixes for all 29 issues identified in the spica-cli security assessment. The work is organized into 5 phases: security fixes, resource leak fixes, state management fixes, remaining HIGH/MEDIUM/LOW fixes, and test verification. All fixes are local to existing modules — no new modules are introduced and no existing interface signatures change.

### Principles

1. **Safety-first**: Security vulnerabilities are breaking changes. Prioritize correctness over backward compatibility.
2. **Regression coverage**: Every fix gets at least one automated test.
3. **All existing tests pass**: 285 tests must stay green throughout.
4. **Local changes only**: Each fix modifies existing functions or adds inline validation. No new abstractions.
5. **Breaking changes documented**: Where behavior changes, note in CHANGELOG.

### Modules Affected

| Module | Files | Fix Count |
|--------|-------|-----------|
| Tools | `src/tools/index.ts` | 4 |
| Agent | `src/agent.ts` | 8 |
| LLMClient | `src/llm/LLMClient.ts` | 5 |
| RateLimiter | `src/llm/RateLimiter.ts` | 2 |
| OpenAICompatible | `src/llm/providers/OpenAICompatible.ts` | 4 |
| Other | events, hooks, ProcessMonitor, TokenCounter, history, index.ts | 6 |

---

## Phase 1: Security Fixes (4 issues)

### #4 — Symlink Path Traversal Protection

**Issue**: `resolvePath()` in `src/tools/index.ts:1757-1763` only does string prefix checking against WORKSPACE. A symlink pointing outside the workspace passes the check, granting arbitrary file read/write.

**Fix**:
- After resolving the path, call `fs.realpathSync(resolved)` to get the canonical path.
- Verify `realPath.startsWith(realWorkspacePath)` (also resolve workspace to its real path).
- Throw `Access denied: symlink points outside workspace` on mismatch.

**Files**: `src/tools/index.ts` — `resolvePath()` function
**Breaking**: Yes. Previously accessible symlinks outside workspace will now be denied.
**Test**: Create temp symlink → `/etc/passwd`, verify `resolvePath()` throws. Verify normal paths still work.

### #5 — Shell Injection Pattern Expansion

**Issue**: `injectionPatterns` array in bash tool (`src/tools/index.ts:807-822`) only catches 6 patterns. Missing: `;`, `&&`, `||`, `${}`, heredoc, `eval`.

**Fix**: Add 6 new patterns to the `injectionPatterns` array:
- `{ pattern: /;/, name: 'command separator' }`
- `{ pattern: /&&/, name: 'AND operator' }`
- `{ pattern: /\|\|/, name: 'OR operator' }`
- `{ pattern: /\$\{/, name: 'variable expansion' }`
- `{ pattern: /<<\s*</, name: 'heredoc' }`
- `{ pattern: /\beval\b/, name: 'eval command' }`

**Files**: `src/tools/index.ts` — bash tool `injectionPatterns`
**Breaking**: Yes. Commands using `&&` chaining will be blocked. Users must split into separate bash calls or use a script file.
**Test**: Inject `ls; rm -rf /`, `echo ${HOME}`, `cmd && whoami`, `cat << EOF`, `eval $CMD` — verify all blocked.

### #6 — Format Tool Shell Injection

**Issue**: Format tool (`src/tools/index.ts:660-673`) builds command string with direct string interpolation: `npx prettier --write "${target}"`. The `target` variable (resolved from user input) is inserted unescaped into a shell command.

**Fix**:
- Change `execa(cmd, { shell: true, ... })` to array-based invocation.
- For Prettier: `execa('npx', ['prettier', '--write', target], { shell: false, ... })`.
- For Python black: `execa('python', ['-m', 'black', target], { shell: false, ... })`.
- For gofmt: `execa('gofmt', ['-w', target], { shell: false, ... })`.
- For rustfmt: `execa('rustfmt', [target], { shell: false, ... })`.
- Fallback: if a formatter genuinely requires shell (e.g., piped post-processing), apply `shell-escape` on the path argument only and keep shell: true.

**Files**: `src/tools/index.ts` — format tool case
**Breaking**: No. Output format unchanged, only execution method differs.
**Test**: Set `target` to `"; rm -rf /"` or `/tmp/foo --config /etc/passwd`, verify no shell metacharacter execution.

### #9 — Git Reset Interactive Confirmation

**Issue**: `checkNeedsPermission()` (`src/agent.ts:103-144`) checks `gitArgs.userConfirmed === true` to bypass permission for reset. AI can fabricate this parameter, rendering the safety gate useless.

**Fix**:
- Remove the `userConfirmed` check entirely from `checkNeedsPermission()`.
- All `git reset` operations (regardless of mode) must go through `waitForPermission()` for interactive user confirmation.
- The existing safety check in the `git` tool execute path (`src/tools/index.ts:1057-1080`) already blocks hard/mixed reset with dirty working tree and returns `requiresUserConfirmation: true`. Keep that gate. Remove only the agent-level bypass.

**Files**: `src/agent.ts` — `checkNeedsPermission()`; `src/tools/index.ts` — git reset case
**Breaking**: Yes. Previously AI could pass `userConfirmed: true` to auto-approve resets. Now all resets require explicit user confirmation.
**Test**: Verify `git reset --hard` triggers `waitForPermission()` regardless of `userConfirmed` parameter value. Verify dirty-tree gate still works.

---

## Phase 2: Resource Leak Fixes (3 issues + related LOW #1)

### #1 — EventEmitter Listener Cleanup

**Issue**: `setupAgentEvents()` in `src/cli/events.ts` registers numerous `.on()` listeners on the agent but never returns a cleanup function. Repeated calls (workspace switches, re-initialization) accumulate listeners, causing memory leaks and duplicate event handling. Similarly, `LLMClient` constructor registers provider `chunk`/`reasoning` listeners that aren't cleaned up on client disposal.

**Fix**:
- `setupAgentEvents()` returns `() => void` cleanup function. Internally collects all registered `{ event, handler }` pairs; the returned function calls `agent.off(event, handler)` for each.
- `LLMClient` stores provider listener references and exposes `dispose()` method that calls `removeAllListeners()` on the provider. Called from `agent.switchWorkspace()` and `agent.interrupt()` cleanup paths.
- LOW #1 (stdin listener): In `src/index.ts` main loop, save the `process.stdin.on('data', handler)` handler reference. Remove it on exit (`shouldExit` path) and agent disposal.

**Files**: `src/cli/events.ts`, `src/llm/LLMClient.ts`, `src/index.ts`
**Breaking**: No. API addition only (`setupAgentEvents` return value, `LLMClient.dispose()`).
**Test**: Call `setupAgentEvents()` twice, verify listenerCount equals original after first cleanup. Verify `dispose()` resets provider listeners.

### #2 — RateLimiter setInterval Cleanup

**Issue**: `interruptibleSleep()` (`src/llm/RateLimiter.ts:112-118`) creates both `setTimeout` and `setInterval`. The signal's abort handler clears the timeout but not the interval. The interval continues running (every 100ms) indefinitely.

**Fix**: In `signal?.addEventListener('abort', () => { ... })`, add `clearInterval(checkInterval)` alongside the existing `clearTimeout(timer)`.

**Files**: `src/llm/RateLimiter.ts` — `interruptibleSleep()`
**Breaking**: No.
**Test**: Spy on `clearInterval`. Trigger signal.abort during sleep. Verify clearInterval was called.

### #3 — ProcessMonitor setTimeout Cleanup

**Issue**: `kill()` method (`src/core/ProcessMonitor.ts:132-138`) sets a 5-second `setTimeout` for SIGKILL fallback on Unix. If the process exits before the 5-second window, the timer is never cleared.

**Fix**: Store the timer reference (`const sigkillTimer = setTimeout(...)`). In the process `close` event handler, call `clearTimeout(sigkillTimer)` before updating status.

**Files**: `src/core/ProcessMonitor.ts` — `kill()`
**Breaking**: No.
**Test**: Kill a process quickly, verify timer cleared via spy. Verify double-kill doesn't crash.

---

## Phase 3: State Management Fixes (3 core issues)

### #3 (HIGH) — Permission Queue Race Condition

**Issue**: `waitForPermission()` → `processPermissionQueue()` is check-then-act. Two concurrent tool calls could enqueue two requests and trigger `processPermissionQueue()` twice, leading to interleaved processing.

**Fix**:
- In `waitForPermission()`, after pushing to queue, check `if (this.permissionPending) return;` before calling `processPermissionQueue()`.
- `processPermissionQueue()` already sets `this.permissionPending = true` on entry and `false` on exit. The gap is that `waitForPermission()` could race with itself. Adding the guard prevents double invocation.
- Also set `permissionPending` atomically: move the `this.permissionPending = true` to the top of `processPermissionQueue()` before the while loop, and add a `if (this.permissionPending) return` gate as first line.

**Files**: `src/agent.ts` — `waitForPermission()`, `processPermissionQueue()`
**Breaking**: No.
**Test**: Fire two `waitForPermission()` calls concurrently. Verify only one processing loop runs, both requests resolved in order.

### #1 (MEDIUM) — init() Error Cleanup

**Issue**: `init()` (`src/agent.ts:587-594`) sets `this._initPromise` before calling `_doInit()`. If `_doInit()` throws (e.g., API connection failure), `_initPromise` stays set to a rejected promise. Subsequent `init()` calls return this same rejected promise instead of retrying.

**Fix**: Wrap `await this._initPromise` in try-finally. In finally block, always set `this._initPromise = null`. Move `this._initialized = true` inside try block (after successful await).

```typescript
async init() {
  if (this._initialized) return;
  if (this._initPromise) return this._initPromise;
  this._initPromise = this._doInit();
  try {
    await this._initPromise;
    this._initialized = true;
  } finally {
    this._initPromise = null;
  }
}
```

**Files**: `src/agent.ts` — `init()`
**Breaking**: No.
**Test**: Mock connection failure on first init, verify second init creates new promise and retries.

### #10 (HIGH) — Compact Infinite Loop Safety

**Issue**: `compactToTarget()` (`src/agent.ts:1251-1256`) has a while loop that reduces kept messages until tokens fit within the target. No maximum iteration limit. If token estimation is persistently off (e.g., due to #9 estimation bugs), the loop could run forever.

**Fix**: Add `let compactIterations = 0; const MAX_COMPACT_ITERATIONS = 5` and increment inside the while condition. If iterations exceed max, break and keep whatever messages remain (with a warning emitted).

**Files**: `src/agent.ts` — `compactToTarget()`
**Breaking**: No.
**Test**: Mock token counter to always return `targetTokens * 2`. Verify loop exits after 5 iterations with warning event emitted.

---

## Phase 4: Remaining HIGH/MEDIUM/LOW Fixes

### HIGH #7 — Bypass Mode Safety

**Fix**: Add an allowlist of tool+pattern combinations that bypass mode CANNOT skip. Specifically: `git reset --hard`, `rm -rf`, `chmod 777`, `git push --force`, `git clean -fd`. These always require user confirmation even when bypass is enabled. Audit log records bypassed operations.

**Files**: `src/agent.ts` — `waitForPermission()`
**Test**: Enable bypass, attempt git reset --hard, verify confirmation still required.

### HIGH #8 — Project Hooks Cannot Override Global Safety

**Fix**: In `loadHooks()`, after merging project hooks, filter: if a project PreToolUse hook has `action: 'allow'` or `action: 'warn'` for a tool pattern that has a global hook with `action: 'block'` or `action: 'confirm'`, the project hook is dropped (global always stricter). PostToolUse hooks are unaffected (they only log).

**Files**: `src/hooks/index.ts` — `loadHooks()`
**Test**: Global hook blocks rm -rf, project hook allows it. Load hooks, verify project hook suppressed.

### MEDIUM #2, #4-8 — SSE/Message Stream Fixes

**Batch fix** in `src/llm/providers/OpenAICompatible.ts` and `src/agent.ts`:

- **#2 Interrupt error type**: Define `InterruptError extends Error` class. `callLLMWithRetry()` catches and re-throws immediately (no retry).
- **#4 Message sequence**: After `cleanMessages()`, validate alternating user/assistant pattern. If broken, reconstruct minimal sequence.
- **#5 SSE stream abort**: Add `if (signal?.aborted) { break; }` after the `for await` loop body, before any chunk processing that could add partial state.
- **#6 ToolCalls bounds**: Before `toolCalls[tc.index]` access, verify `tc.index >= 0 && tc.index < MAX_TOOL_CALLS`. Define `MAX_TOOL_CALLS = 128` as a module-level constant in `src/llm/providers/OpenAICompatible.ts`.
- **#7 Message state after interrupt**: On stream interrupt, pop the last assistant message (with incomplete toolCalls) from `this.messages`.
- **#8 SDK/client retry conflict**: Set OpenAI SDK `maxRetries: 0`, let our `callLLMWithRetry` handle all retries.

**Files**: `src/llm/providers/OpenAICompatible.ts`, `src/agent.ts`
**Test**: One test per fix — interrupt signal verification, toolCalls boundary, retry count assertion.

### MEDIUM #9-11 — Token/Abort Fixes

- **#9 TokenCounter**: Add heuristics: CJK chars ≈ 1.5 tokens/char, code ≈ 3 chars/token. Keep 4 chars/token for prose.
- **#10 contextWindow sync**: `TokenCounter` stores `contextWindow` and it's set from provider in `LLMClient` constructor (already partially done, verify consistency).
- **#11 AbortController in executeWithTools**: `executeWithTools()` creates an `AbortController`, passes signal to `provider.generate()`. Add interrupt check between iterations.

**Files**: `src/llm/TokenCounter.ts`, `src/llm/LLMClient.ts`

### MEDIUM #13-15, #12 — LLMClient Interrupt Completeness

- **#13 interrupt() cleanup**: Reset `pendingInterrupt` flag. Clear rate limiter state by calling `this.rateLimiter.interrupt()` (which already resets the pendingInterrupt flag internally) and re-instantiate the rate limiter to clear accumulated timestamps.
- **#14 executeWithTools() interrupt**: Check `this.pendingInterrupt` between each tool execution iteration.
- **#15 doas/run0 detection**: Add to `checkNeedsPermission()` dangerous patterns.
- **#12 interruptibleSleep**: Phase 2 already fixes setInterval. Also add cleanup in the reject path (if promise rejects, clear both timer and interval).

**Files**: `src/llm/LLMClient.ts`, `src/agent.ts`

### LOW #2-4 — Minor Hardening

- **#2 API key exposure**: In `connection_error` event emission, omit key from payload. Only include provider name, model, error type.
- **#3 Session history**: Apply `chmod 600` to `~/.spica/history.json` and `.spica/backups/` directory on write.
- **#4 Path leakage**: In error messages that include file paths, convert absolute paths to workspace-relative using `path.relative(WORKSPACE, absolutePath)`.

**Files**: `src/index.ts`, `src/utils/history.ts`, `src/tools/index.ts`

---

## Phase 5: Test Verification

### Test Files to Add

All new tests go in `src/__tests__/` directory, organized by module:

| File | Covers |
|------|--------|
| `security/resolvePath.test.ts` | Symlink traversal (#4) |
| `security/shellInjection.test.ts` | Injection patterns (#5), format injection (#6) |
| `security/gitReset.test.ts` | Git reset confirmation (#9) |
| `resources/eventCleanup.test.ts` | Listener cleanup (#1, LOW #1) |
| `resources/rateLimiterCleanup.test.ts` | setInterval cleanup (#2) |
| `resources/processMonitorCleanup.test.ts` | setTimeout cleanup (#3 MEDIUM) |
| `state/permissionQueue.test.ts` | Race condition (#3 HIGH) |
| `state/initCleanup.test.ts` | init error cleanup (#1 MEDIUM) |
| `state/compactLoop.test.ts` | Compact max iterations (#10) |
| `security/bypass.test.ts` | Bypass mode (#7) |
| `security/hooksOverride.test.ts` | Project hooks (#8) |
| `stream/sseInterrupt.test.ts` | SSE flow (#2, #5, #6, #7 MEDIUM) |
| `stream/retryConflict.test.ts` | SDK retry (#8 MEDIUM) |
| `llm/tokenCounter.test.ts` | Token estimation (#9) |
| `llm/interrupt.test.ts` | Interrupt completeness (#12-14) |
| `llm/dangerousCommands.test.ts` | doas/run0 (#15 MEDIUM) |
| `security/pathLeak.test.ts` | LOW #2-4 |

### Verification Gates

After each phase:
1. `npm run build` — must succeed
2. `npm run test:run` — all 285 existing + new tests pass
3. `npm run lint` — zero errors

After all phases:
- Full test suite run with coverage report
- Manual test of `git reset --hard` confirmation flow
- Manual test of symlink resolution rejection

---

## Breaking Changes Summary

| Fix | Change | User Impact |
|-----|--------|-------------|
| #4 Symlink check | `resolvePath()` rejects symlinks outside workspace | Previously traversable symlinks now blocked |
| #5 Shell patterns | `;`, `&&`, `||`, `${}`, heredoc, `eval` blocked | Commands using these must be restructured |
| #9 Git reset | `userConfirmed` parameter ignored, always interactive | No more silent git resets |
| #7 Bypass | Destructive ops require confirmation even in bypass | Adopted for safety |
| #8 Hooks | Global hooks take precedence over project hooks | Malicious project configs neutralized |

---

## Out of Scope

- Full end-to-end encryption of session history (local file permissions are sufficient for CLI tool)
- Replacing TokenCounter with tiktoken (optional future enhancement, current heuristic is adequate)
- Full async mutex library (simple flag-based locking is sufficient for single-threaded Node.js event loop)
