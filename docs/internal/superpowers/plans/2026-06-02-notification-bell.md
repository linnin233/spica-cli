# Notification Bell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Play audible notification sounds when the agent needs user interaction (permission request) or finishes work (success/error).

**Architecture:** Extract the existing duplicate bell code from `src/index.ts` and `src/cli/events.ts` into a single `src/utils/bell.ts` module. Fix platform-specific sound playback (Linux PipeWire/ALSA fallbacks, Windows reliability). Add bell calls at all agent completion/error/interrupt points currently missing them.

**Tech Stack:** Node.js built-in modules only (`child_process.exec`, `os`, `fs`). No new dependencies.

---

## Current State (What's Broken)

There are **two** separate bell implementations:
- `src/index.ts:54-98` — `playBell(reason)` — older, only `done`/`error`, uses `paplay` only
- `src/cli/events.ts:15-73` — `bell(reason)` — newer, adds `permission`, still uses `paplay` only

**Problems:**
1. Duplicate code — two implementations drifting apart
2. Debug `console.error` spam always printed (lines like `[BELL] playBell called: ...`)
3. Linux only tries `paplay` (PulseAudio). Fails silently on PipeWire-only or ALSA-only systems
4. `bell('permission')` is called in `events.ts` — ✓ works
5. `playBell('done')`/`playBell('error')` only called in `/skill` handler — ✗ missing from main execution path, `run` command, and simple mode
6. No bell on interrupt/stop events

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/utils/bell.ts` | **Create** | Single bell module: play sound for permission/done/error |
| `src/utils/__tests__/bell.test.ts` | **Create** | Unit tests for bell logic |
| `src/index.ts` | **Modify** | Delete old `playBell`, import from `utils/bell`, add missing calls |
| `src/cli/events.ts` | **Modify** | Delete old `bell`, import from `utils/bell` |

---

### Task 1: Create `src/utils/bell.ts` — the unified bell module

**Files:**
- Create: `src/utils/bell.ts`

- [ ] **Step 1: Write the module**

```typescript
// Bell notification utility — cross-platform audible alerts
import { exec } from 'child_process';
import { platform } from 'os';
import { existsSync } from 'fs';

const currentPlatform = platform();

type BellReason = 'permission' | 'done' | 'error';

interface BellOptions {
  /** Override env vars for testing */
  env?: Record<string, string | undefined>;
}

// Default system sounds per platform per reason
const DARWIN_SOUNDS: Record<BellReason, string> = {
  permission: '/System/Library/Sounds/Ping.aiff',
  done: '/System/Library/Sounds/Glass.aiff',
  error: '/System/Library/Sounds/Sosumi.aiff',
};

const LINUX_SOUNDS: Record<BellReason, string> = {
  permission: '/usr/share/sounds/freedesktop/stereo/bell.oga',
  done: '/usr/share/sounds/freedesktop/stereo/complete.oga',
  error: '/usr/share/sounds/freedesktop/stereo/dialog-error.oga',
};

const WIN_SOUNDS: Record<BellReason, string> = {
  permission: 'C:\\Windows\\Media\\Windows Notify System Generic.wav',
  done: 'C:\\Windows\\Media\\Windows Notify Calendar.wav',
  error: 'C:\\Windows\\Media\\Windows Critical Stop.wav',
};

/** Try each command until one succeeds. Each command runs with 2>/dev/null. */
function tryPlay(commands: string[]): void {
  if (commands.length === 0) return;
  const [cmd, ...rest] = commands;
  // Use sh -c so 2>/dev/null works cross-shell on Linux/macOS
  const shellCmd = currentPlatform === 'win32'
    ? cmd
    : `sh -c '${cmd.replace(/'/g, "'\\''")}' 2>/dev/null`;
  exec(shellCmd, (err) => {
    if (err && rest.length > 0) {
      tryPlay(rest);
    }
  });
}

function playFile(filePath: string): void {
  if (!existsSync(filePath)) return;

  if (currentPlatform === 'darwin') {
    tryPlay([`afplay "${filePath}"`]);
  } else if (currentPlatform === 'linux') {
    // Try PipeWire first, then PulseAudio, then ALSA
    tryPlay([
      `pw-play "${filePath}"`,
      `paplay "${filePath}"`,
      `aplay "${filePath}"`,
    ]);
  } else if (currentPlatform === 'win32') {
    // PlaySync blocks — use a detached powershell
    exec(
      `powershell -NoProfile -Command "Start-Process powershell -ArgumentList '-NoProfile (New-Object Media.SoundPlayer ''${filePath}'').PlaySync()' -WindowStyle Hidden"`,
      () => {} // fire-and-forget
    );
  }
}

export function playBell(reason: BellReason, opts?: BellOptions): void {
  const env = opts?.env ?? process.env;

  if (env.SPICA_BELL === 'false') return;

  // Custom sound file from env (overrides defaults)
  const envKey = reason === 'permission'
    ? 'SPICA_BELL_PERMISSION'
    : reason === 'done'
      ? 'SPICA_BELL_DONE'
      : 'SPICA_BELL_ERROR';

  const customSound = env[envKey];
  if (customSound && existsSync(customSound)) {
    playFile(customSound);
    return;
  }

  // Platform default sounds
  if (currentPlatform === 'darwin') {
    playFile(DARWIN_SOUNDS[reason]);
  } else if (currentPlatform === 'linux') {
    playFile(LINUX_SOUNDS[reason]);
  } else if (currentPlatform === 'win32') {
    playFile(WIN_SOUNDS[reason]);
  }
}

export function isBellEnabled(): boolean {
  return process.env.SPICA_BELL !== 'false';
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit src/utils/bell.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/utils/bell.ts
git commit -m "feat: add unified bell notification module"
```

---

### Task 2: Write tests for `src/utils/bell.ts`

**Files:**
- Create: `src/utils/__tests__/bell.test.ts`

- [ ] **Step 1: Write the tests**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { playBell, isBellEnabled } from '../bell';

// Mock child_process.exec
vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, cb?: Function) => {
    if (cb) cb(null, '', '');
    return {} as any;
  }),
}));

// Mock fs.existsSync
vi.mock('fs', () => ({
  existsSync: vi.fn((_p: string) => false),
}));

// Mock os.platform
vi.mock('os', () => ({
  platform: vi.fn(() => 'linux'),
}));

import { exec } from 'child_process';
import { existsSync } from 'fs';
import { platform } from 'os';

const mockExec = vi.mocked(exec);
const mockExistsSync = vi.mocked(existsSync);
const mockPlatform = vi.mocked(platform);

describe('playBell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlatform.mockReturnValue('linux');
    mockExistsSync.mockReturnValue(false);
  });

  it('does nothing when SPICA_BELL is "false"', () => {
    playBell('done', { env: { SPICA_BELL: 'false' } });
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('defaults to enabled when SPICA_BELL is not set', () => {
    playBell('done', { env: {} });
    // should attempt to play default sound
    expect(mockExec).toHaveBeenCalled();
  });

  it('plays custom sound file when env var points to existing file', () => {
    mockExistsSync.mockImplementation((p: string) => p === '/my/custom.wav');
    playBell('done', { env: { SPICA_BELL_DONE: '/my/custom.wav' } });
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('/my/custom.wav'),
      expect.any(Function)
    );
  });

  it('falls back to default when custom file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    playBell('done', { env: { SPICA_BELL_DONE: '/nonexistent.wav' } });
    // should try freedesktop complete.oga
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('complete.oga'),
      expect.any(Function)
    );
  });

  it('uses SPICA_BELL_PERMISSION for permission reason', () => {
    mockExistsSync.mockImplementation((p: string) => p === '/perm.wav');
    playBell('permission', { env: { SPICA_BELL_PERMISSION: '/perm.wav' } });
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('/perm.wav'),
      expect.any(Function)
    );
  });

  it('uses SPICA_BELL_ERROR for error reason', () => {
    mockExistsSync.mockImplementation((p: string) => p === '/err.wav');
    playBell('error', { env: { SPICA_BELL_ERROR: '/err.wav' } });
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('/err.wav'),
      expect.any(Function)
    );
  });

  it('tries pw-play, paplay, aplay in order on linux', () => {
    mockPlatform.mockReturnValue('linux');
    // Make each command fail so it tries the next
    let callCount = 0;
    mockExec.mockImplementation((_cmd: string, cb?: Function) => {
      callCount++;
      if (cb) cb(new Error('fail'), '', '');
      return {} as any;
    });

    playBell('done', { env: {} });
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it('uses afplay on darwin', () => {
    mockPlatform.mockReturnValue('darwin');
    playBell('done', { env: {} });
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('afplay'),
      expect.any(Function)
    );
  });
});

describe('isBellEnabled', () => {
  it('returns true when SPICA_BELL is not set', () => {
    // can't easily mock process.env, but default is true
    expect(isBellEnabled()).toBe(true);
  });

  it('returns false when SPICA_BELL is "false"', () => {
    const original = process.env.SPICA_BELL;
    process.env.SPICA_BELL = 'false';
    expect(isBellEnabled()).toBe(false);
    if (original === undefined) {
      delete process.env.SPICA_BELL;
    } else {
      process.env.SPICA_BELL = original;
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
npx vitest run src/utils/__tests__/bell.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/utils/__tests__/bell.test.ts
git commit -m "test: add bell utility tests"
```

---

### Task 3: Remove old bell code from `src/cli/events.ts`, import from utils

**Files:**
- Modify: `src/cli/events.ts`

- [ ] **Step 1: Remove old bell function and its imports**

Delete lines 15-73 in `src/cli/events.ts` (the entire `bell()` function, `playSound()`, `playSoundWindows()`, and the `BELL_*` constants at module level, plus the `exec`, `os`, `fs` imports if they're only used for the bell):

Remove these lines:
```typescript
// 提示音配置
const BELL_ENABLED = process.env.SPICA_BELL !== 'false';
const BELL_PERMISSION = process.env.SPICA_BELL_PERMISSION || '';  // 自定义声音文件路径
const BELL_DONE = process.env.SPICA_BELL_DONE || '';
const BELL_ERROR = process.env.SPICA_BELL_ERROR || '';

function bell(reason: 'permission' | 'done' | 'error'): void {
  if (!BELL_ENABLED) {
    console.error('[BELL] Disabled by SPICA_BELL=false');
    return;
  }

  const platform = os.platform();
  console.error(`[BELL] reason=${reason}, platform=${platform}`);

  // 优先使用用户自定义声音文件
  const customSound = reason === 'permission' ? BELL_PERMISSION : reason === 'done' ? BELL_DONE : BELL_ERROR;

  if (customSound && fs.existsSync(customSound)) {
    console.error(`[BELL] Playing custom: ${customSound}`);
    playSound(customSound);
    return;
  }

  // 默认系统声音
  if (platform === 'linux') {
    const sounds: Record<string, string> = {
      permission: '/usr/share/sounds/freedesktop/stereo/bell.oga',
      done: '/usr/share/sounds/freedesktop/stereo/complete.oga',
      error: '/usr/share/sounds/freedesktop/stereo/dialog-error.oga',
    };
    const defaultSound = sounds[reason];
    console.error(`[BELL] Linux default: ${defaultSound}, exists=${fs.existsSync(defaultSound)}`);
    if (defaultSound) {
      playSound(defaultSound);
    }
  } else if (platform === 'darwin') {
    const sounds: Record<string, string> = {
      permission: '/System/Library/Sounds/Ping.aiff',
      done: '/System/Library/Sounds/Glass.aiff',
      error: '/System/Library/Sounds/Sosumi.aiff',
    };
    playSound(sounds[reason] || '/System/Library/Sounds/Glass.aiff');
  } else if (platform === 'win32') {
    const sounds: Record<string, string> = {
      permission: 'C:\\Windows\\Media\\Windows Notify System Generic.wav',
      done: 'C:\\Windows\\Media\\Windows Notify Calendar.wav',
      error: 'C:\\Windows\\Media\\Windows Critical Stop.wav',
    };
    playSoundWindows(sounds[reason] || 'C:\\Windows\\Media\\notify.wav');
  }
}

function playSound(soundFile: string): void {
  const platform = os.platform();
  if (platform === 'linux') {
    exec(`paplay "${soundFile}" 2>/dev/null || true`);
  } else if (platform === 'darwin') {
    exec(`afplay "${soundFile}" 2>/dev/null || true`);
  }
}

function playSoundWindows(soundFile: string): void {
  exec(`powershell -c "(New-Object Media.SoundPlayer '${soundFile}').PlaySync()" 2>/dev/null || true`);
}
```

And remove the imports at the top that are only used by the bell:
- `import os from 'os';` — if not used elsewhere (check: `os.homedir()` is used in `buildStatusText`, so keep `os`)
- `import { exec } from 'child_process';` — if not used elsewhere (check: not used elsewhere in events.ts — remove)
- `import fs from 'fs-extra';` — if not used elsewhere (check: not used elsewhere in events.ts — remove)

- [ ] **Step 2: Add import for the new bell module**

Add at the top of `src/cli/events.ts`, near the other imports:

```typescript
import { playBell } from '../utils/bell';
```

- [ ] **Step 3: Update the `bell()` call site**

Find the line:
```typescript
bell('permission');  // 需要用户交互时发出提示音
```

Replace with:
```typescript
playBell('permission');
```

- [ ] **Step 4: Verify compilation and run existing event tests**

```bash
npx tsc --noEmit
npx vitest run src/cli/__tests__/ src/__tests__/agent.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/events.ts
git commit -m "refactor: replace inline bell with unified bell module in events"
```

---

### Task 4: Remove old `playBell` from `src/index.ts`, add missing bell calls

**Files:**
- Modify: `src/index.ts`

This task has two parts: (A) delete the old `playBell` function, (B) add `playBell` calls at all missing points.

- [ ] **Step 1: Delete old `playBell` and its constants**

Delete lines 54-98 in `src/index.ts`:

```typescript
// 提示音函数（跨平台，支持自定义声音文件）
const BELL_ENABLED = process.env.SPICA_BELL !== "false";
const BELL_DONE = process.env.SPICA_BELL_DONE || "";
const BELL_ERROR = process.env.SPICA_BELL_ERROR || "";

function playBell(reason: "done" | "error"): void {
  console.error(`[BELL] playBell called: reason=${reason}, enabled=${BELL_ENABLED}`);
  if (!BELL_ENABLED) return;

  const platform = os.platform();
  const customSound = reason === "done" ? BELL_DONE : BELL_ERROR;
  console.error(`[BELL] platform=${platform}, customSound=${customSound}`);

  // 优先使用自定义声音文件
  if (customSound && fs.existsSync(customSound)) {
    console.error(`[BELL] Playing custom sound`);
    if (platform === "linux") {
      exec(`paplay "${customSound}"`);
    } else if (platform === "darwin") {
      exec(`afplay "${customSound}"`);
    } else if (platform === "win32") {
      exec(`powershell -c "(New-Object Media.SoundPlayer '${customSound}').PlaySync()"`);
    }
    return;
  }

  // 默认系统声音
  console.error(`[BELL] Playing default sound`);
  if (platform === "linux") {
    const sounds = {
      done: "/usr/share/sounds/freedesktop/stereo/complete.oga",
      error: "/usr/share/sounds/freedesktop/stereo/dialog-error.oga",
    };
    exec(`paplay ${sounds[reason]} 2>/dev/null || true`);
  } else if (platform === "darwin") {
    const sounds = {
      done: "/System/Library/Sounds/Glass.aiff",
      error: "/System/Library/Sounds/Sosumi.aiff",
    };
    exec(`afplay ${sounds[reason]} 2>/dev/null || true`);
  } else if (platform === "win32") {
    const sounds = {
      done: "C:\\Windows\\Media\\Windows Notify Calendar.wav",
      error: "C:\\Windows\\Media\\Windows Critical Stop.wav",
    };
    exec(`powershell -c "(New-Object Media.SoundPlayer '${sounds[reason]}').PlaySync()" 2>/dev/null || true`);
  }
}
```

- [ ] **Step 2: Add import for the new bell module**

Add near the top of `src/index.ts` (after the `import` from `"./cli/events"`):

```typescript
import { playBell } from "./utils/bell";
```

- [ ] **Step 3: Add bell calls in the interactive mode main path**

Find the `=== 执行请求 ===` section (around line 828-862). There are two bell points needed:

**After success** — right after `screen.appendScroll(COLORS.success("[OK] Done\n"));`:

```typescript
screen.appendScroll(COLORS.success("[OK] Done\n"));
playBell("done");  // 工作完成提示音
```

**After error** — right after `screen.appendScroll(COLORS.error(`[ERR] ${error.message}\n`));`:

```typescript
screen.appendScroll(COLORS.error(`[ERR] ${error.message}\n`));
playBell("error");  // 错误提示音
```

- [ ] **Step 4: Update the `/skill` handler bell calls**

Find the two `playBell` calls in the `/skill` handler (lines 797 and 803). They already exist but use the old local function. Since we deleted the local function and imported the new one, these calls will now use the unified `playBell`. Verify the calls are:

```typescript
playBell("done"); // 工作完成提示音  (after [OK] Done)
playBell("error"); // 错误提示音      (after [ERR] ...)
```

These should already be correct. No change needed beyond the import.

- [ ] **Step 5: Add bell calls in the `run` command path**

Find the `run` command handler (around line 965-978):

```typescript
const result = await agent.runLoop(request);
console.log(COLORS.success("\n[OK] Completed"));
```

Add `playBell` after completion and error:

```typescript
const result = await agent.runLoop(request);
console.log(COLORS.success("\n[OK] Completed"));
playBell("done");
```

And for the error:

```typescript
} catch (error: any) {
  if (!state.isConnectionErrorShown()) {
    console.log(COLORS.error(`Error: ${error.message}`));
  }
  playBell("error");
}
```

- [ ] **Step 6: Add bell calls in the simple (non-TUI) mode path**

Find the simple mode handler (around line 1475-1483):

```typescript
const response = await agent.runLoop(trimmed);
console.log(COLORS.success("\n[OK] Done"));
```

Add:

```typescript
const response = await agent.runLoop(trimmed);
console.log(COLORS.success("\n[OK] Done"));
playBell("done");
```

And for the error:

```typescript
} catch (error: any) {
  console.log(COLORS.error(`\n[ERR] ${error.message}`));
  playBell("error");
}
```

- [ ] **Step 7: Add bell calls for interrupt and stop events**

Add bell in the `agent_interrupted` handler (in `setupAgentEvents` within `events.ts`):

In `src/cli/events.ts`, find `on('agent_interrupted', ...)` and add `playBell('error');` after displaying the message:

```typescript
on('agent_interrupted', (data: any) => {
  // 重置流式状态
  state.setStreamingOutput(false);
  screen.setStreaming(false);

  screen.appendScroll(COLORS.warning(`\n[INTERRUPTED] Agent stopped. Press Enter to continue.\n`));
  if (data.toolResults && data.toolResults.length > 0) {
    screen.appendScroll(COLORS.muted(`  Interrupted tools: ${data.toolResults.map(t => t.name).join(', ')}\n`));
  }
  screen.restoreCursor();
  screen.refreshInput();
  playBell('error');
});
```

Also add in `on('agent_stopped_on_error', ...)`:

```typescript
on('agent_stopped_on_error', (data: any) => {
  screen.appendScroll(COLORS.error(`\n[STOPPED] Agent stopped due to critical error.\n`));
  screen.appendScroll(COLORS.muted(`  Error: ${data.error || 'Unknown'}\n`));
  screen.appendScroll(COLORS.muted(`  Tool: ${data.tool || 'Unknown'}\n`));
  screen.appendScroll(COLORS.warning(`  Suggestion: ${data.suggestion || 'Check the error and retry.'}\n`));
  screen.restoreCursor();
  screen.refreshInput();
  playBell('error');
});
```

- [ ] **Step 8: Verify compilation and run tests**

```bash
npx tsc --noEmit
npx vitest run src/__tests__/ src/cli/__tests__/ src/utils/__tests__/
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/index.ts src/cli/events.ts
git commit -m "feat: add notification bell at all completion/error/interrupt points"
```

---

### Task 5: Manual smoke test

- [ ] **Step 1: Build**

```bash
npm run build
```

- [ ] **Step 2: Test that bell is callable without crashing**

```bash
SPICA_BELL=true node -e "
const { playBell } = require('./dist/utils/bell');
playBell('done');
console.log('Bell called without crash');
"
```

Expected: "Bell called without crash" printed with no errors.

- [ ] **Step 3: Test that bell can be disabled**

```bash
SPICA_BELL=false node -e "
const { playBell } = require('./dist/utils/bell');
playBell('done');
console.log('Bell disabled, no sound played');
"
```

Expected: "Bell disabled, no sound played" printed with no errors.

- [ ] **Step 4: Verify binary works**

```bash
./bin/spica --version
```

Expected: `1.0.0`

- [ ] **Step 5: Commit (if any fixes needed)**

```bash
git add -A
git commit -m "chore: smoke test fixes for notification bell"
```

---

## Self-Review

### 1. Spec Coverage

User request: "当需要交互 比如需要确认 或者结束工作的时候，播放提示音"

| Requirement | Task | Status |
|-------------|------|--------|
| Bell on permission/confirmation request | Already exists in events.ts (`bell('permission')`), Task 3 preserves it | ✓ |
| Bell on work completion (success) | Task 4 Steps 3,5,6 — all `runLoop` success paths | ✓ |
| Bell on work completion (error) | Task 4 Steps 3,5,6 — all `runLoop` error paths | ✓ |
| Bell on interrupt | Task 4 Step 7 — `agent_interrupted` | ✓ |
| Bell on critical error stop | Task 4 Step 7 — `agent_stopped_on_error` | ✓ |
| Cross-platform (Linux/PipeWire) | Task 1 — pw-play/paplay/aplay fallback | ✓ |
| Cross-platform (macOS) | Task 1 — afplay | ✓ |
| Cross-platform (Windows) | Task 1 — PowerShell | ✓ |
| Custom sound file support | Task 1 — SPICA_BELL_PERMISSION/DONE/ERROR env vars | ✓ |
| Disable bell | Task 1 — SPICA_BELL=false | ✓ |
| Consolidate duplicate code | Tasks 3,4 — delete old implementations | ✓ |

### 2. Placeholder Scan

No TBDs, no TODOs, no "write tests for the above" without actual test code. All code steps contain complete implementations.

### 3. Type Consistency

- `BellReason` type: `'permission' | 'done' | 'error'` — consistent across `playBell` signature, sound maps, and all call sites.
- `playBell(reason, opts?)` — same signature everywhere.
- Env var naming: `SPICA_BELL`, `SPICA_BELL_PERMISSION`, `SPICA_BELL_DONE`, `SPICA_BELL_ERROR` — consistent in implementation, tests, and docs.
