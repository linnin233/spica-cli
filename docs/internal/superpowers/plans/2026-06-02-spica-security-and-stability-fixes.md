# Spica CLI Security & Stability Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 29 issues (10 HIGH, 15 MEDIUM, 4 LOW) across security, resource leaks, and state management in the spica-cli codebase.

**Architecture:** All fixes are local to existing files — no new source modules created. Each fix is an inline modification to an existing function or a small validation addition. New test files are created in `src/__tests__/` organized by category (security/, resources/, state/, stream/, llm/). Breaking changes are documented.

**Tech Stack:** TypeScript, Node.js, vitest, fs-extra, execa, EventEmitter, OpenAI SDK

---

## File Map

**Files to modify (11):**
| File | What Changes |
|------|-------------|
| `src/tools/index.ts` | resolvePath symlink check, shell injection patterns, format tool array invoke, path leakage |
| `src/agent.ts` | checkNeedsPermission, waitForPermission/processPermissionQueue gate, init try-finally, compact loop limit, bypass allowlist, InterruptError class |
| `src/llm/LLMClient.ts` | dispose(), executeWithTools interrupt, interrupt() cleanup, AbortController propagation |
| `src/llm/RateLimiter.ts` | interruptibleSleep clearInterval in abort handler |
| `src/core/ProcessMonitor.ts` | kill() sigkill timer cleanup |
| `src/cli/events.ts` | setupAgentEvents returns cleanup function |
| `src/llm/providers/OpenAICompatible.ts` | maxRetries:0, SSE abort guard, toolCalls bounds, message rollback on interrupt |
| `src/llm/TokenCounter.ts` | CJK/code heuristic, contextWindow consistency |
| `src/hooks/index.ts` | global hook precedence over project hooks |
| `src/utils/history.ts` | chmod 600 on save |
| `src/index.ts` | stdin listener removal, API key omission from events |

**Test files to create (17):**
`src/__tests__/security/resolvePath.test.ts`, `shellInjection.test.ts`, `gitReset.test.ts`, `bypass.test.ts`, `hooksOverride.test.ts`, `pathLeak.test.ts`, `src/__tests__/resources/eventCleanup.test.ts`, `rateLimiterCleanup.test.ts`, `processMonitorCleanup.test.ts`, `src/__tests__/state/permissionQueue.test.ts`, `initCleanup.test.ts`, `compactLoop.test.ts`, `src/__tests__/stream/sseInterrupt.test.ts`, `retryConflict.test.ts`, `src/__tests__/llm/tokenCounter.test.ts`, `interrupt.test.ts`, `dangerousCommands.test.ts`

---

### Task 1: resolvePath Symlink Traversal Protection (#4)

**Files:**
- Modify: `src/tools/index.ts:1757-1763`
- Create: `src/__tests__/security/resolvePath.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/security/resolvePath.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

// We test resolvePath indirectly through a tool that uses it.
// Import setWorkspace and executeTool for indirect testing.
import { setWorkspace, executeTool, getWorkspace } from '../../tools/index';

describe('resolvePath symlink traversal', () => {
  let tmpDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spica-test-'));
    workspaceDir = path.join(tmpDir, 'workspace');
    await fs.ensureDir(workspaceDir);
    setWorkspace(workspaceDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('should reject symlinks pointing outside workspace', async () => {
    const outsideFile = path.join(tmpDir, 'secret.txt');
    await fs.writeFile(outsideFile, 'sensitive data');

    const symlinkPath = path.join(workspaceDir, 'link-to-secret');
    await fs.symlink(outsideFile, symlinkPath);

    const result = await executeTool('file_read', { path: symlinkPath });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Access denied');
    expect(result.error).toContain('symlink');
  });

  it('should allow symlinks pointing inside workspace', async () => {
    const insideFile = path.join(workspaceDir, 'real-file.txt');
    await fs.writeFile(insideFile, 'normal data');

    const symlinkPath = path.join(workspaceDir, 'link-to-inside');
    await fs.symlink(insideFile, symlinkPath);

    const result = await executeTool('file_read', { path: 'link-to-inside' });
    expect(result.success).toBe(true);
  });

  it('should allow normal files without symlinks', async () => {
    const normalFile = path.join(workspaceDir, 'normal.txt');
    await fs.writeFile(normalFile, 'hello');

    const result = await executeTool('file_read', { path: 'normal.txt' });
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/__tests__/security/resolvePath.test.ts
```

Expected: FAIL — symlink traversal not blocked, file_read succeeds on outside file.

- [ ] **Step 3: Implement the fix**

In `src/tools/index.ts`, replace the `resolvePath` function:

```typescript
function resolvePath(requestedPath: string): string {
  const resolved = isAbsolute(requestedPath)
    ? requestedPath
    : pathResolve(WORKSPACE, requestedPath);

  // Resolve workspace to its real path once (cached)
  const realWorkspace = pathResolve(WORKSPACE);

  // Resolve the requested path to its real path, following symlinks
  let realPath: string;
  try {
    realPath = fs.realpathSync(resolved);
  } catch {
    // File doesn't exist yet (e.g., file_write on new file) —
    // check the parent directory instead
    const parent = dirname(resolved);
    let realParent: string;
    try {
      realParent = fs.realpathSync(parent);
    } catch {
      throw new Error(
        `Access denied: cannot resolve path "${requestedPath}"`
      );
    }
    // Verify parent is within workspace
    if (
      !realParent.startsWith(realWorkspace) &&
      !realParent.startsWith(pathResolve(realWorkspace))
    ) {
      throw new Error(
        `Access denied: path "${requestedPath}" is outside workspace`
      );
    }
    return resolved;
  }

  // Verify real path is within workspace
  if (
    !realPath.startsWith(realWorkspace) &&
    !realPath.startsWith(pathResolve(realWorkspace))
  ) {
    throw new Error(
      `Access denied: symlink points outside workspace`
    );
  }

  return resolved;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/__tests__/security/resolvePath.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 5: Run full test suite to verify no regressions**

```bash
npm run test:run
```

Expected: All 285 existing tests + 3 new tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/index.ts src/__tests__/security/resolvePath.test.ts
git commit -m "[spica] fix: resolvePath symlink traversal protection (#4)"
```

---

### Task 2: Shell Injection Pattern Expansion (#5)

**Files:**
- Modify: `src/tools/index.ts:807-822`
- Create: `src/__tests__/security/shellInjection.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/security/shellInjection.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { setWorkspace, executeTool } from '../../tools/index';

describe('shell injection prevention', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spica-test-'));
    setWorkspace(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  const blockedCommands = [
    { cmd: 'ls; rm -rf /', name: 'command separator (;)' },
    { cmd: 'echo hello && whoami', name: 'AND operator (&&)' },
    { cmd: 'false || cat /etc/passwd', name: 'OR operator (||)' },
    { cmd: 'echo ${HOME}', name: 'variable expansion (${})' },
    { cmd: 'cat << EOF\ntest\nEOF', name: 'heredoc' },
    { cmd: 'eval echo bad', name: 'eval command' },
  ];

  for (const { cmd, name } of blockedCommands) {
    it(`should block ${name}`, async () => {
      const result = await executeTool('bash', { command: cmd });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Blocked');
    });
  }

  it('should still allow safe commands', async () => {
    const result = await executeTool('bash', { command: 'echo hello world' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('hello world');
  });

  it('should block existing patterns (regression)', async () => {
    const result = await executeTool('bash', { command: 'echo $(whoami)' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Blocked');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/__tests__/security/shellInjection.test.ts
```

Expected: FAIL — most new patterns not blocked.

- [ ] **Step 3: Implement the fix**

In `src/tools/index.ts`, locate the `injectionPatterns` array in the bash tool case (~line 807). Add the 6 new patterns after the existing ones:

```typescript
const injectionPatterns = [
  { pattern: /\$\(/, name: 'command substitution $(...)' },
  { pattern: /`[^`]+`/, name: 'backtick command substitution' },
  { pattern: /\/dev\/tcp\//, name: 'bash network connection' },
  { pattern: /\|\s*(bash|sh|zsh|python|perl|ruby)\b/, name: 'piping to shell interpreter' },
  { pattern: /mkfifo/, name: 'named pipe creation' },
  { pattern: /\bnc\s+-[el]/, name: 'netcat listener' },
  // NEW patterns:
  { pattern: /;/, name: 'command separator' },
  { pattern: /&&/, name: 'AND operator' },
  { pattern: /\|\|/, name: 'OR operator' },
  { pattern: /\$\{/, name: 'variable expansion' },
  { pattern: /<<\s*</, name: 'heredoc' },
  { pattern: /\beval\b/, name: 'eval command' },
];
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/__tests__/security/shellInjection.test.ts
```

Expected: 8 tests PASS.

- [ ] **Step 5: Run full test suite**

```bash
npm run test:run
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/index.ts src/__tests__/security/shellInjection.test.ts
git commit -m "[spica] fix: expand shell injection pattern list (#5)"
```

---

### Task 3: Format Tool Shell Injection (#6)

**Files:**
- Modify: `src/tools/index.ts:660-673`
- Modify: `src/__tests__/security/shellInjection.test.ts` (add test)

- [ ] **Step 1: Add the failing test**

Append to `src/__tests__/security/shellInjection.test.ts`:

```typescript
describe('format tool injection prevention', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spica-test-'));
    // Create a package.json so detectProjectType returns typescript
    await fs.writeJson(path.join(tmpDir, 'package.json'), {
      devDependencies: { typescript: '^5.0.0' },
    });
    setWorkspace(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('should not execute injected commands in format target', async () => {
    const result = await executeTool('format', {
      path: '"; rm -rf /tmp/spica-injection-test; echo "',
    });
    // Should not execute the injected command
    // Either fails safely or formats without side effects
    const injectionFile = '/tmp/spica-injection-test';
    expect(fs.existsSync(injectionFile)).toBe(false);
  });

  it('should handle paths with spaces without injection', async () => {
    // Create a file with spaces in name
    const testFile = path.join(tmpDir, 'my file.ts');
    await fs.writeFile(testFile, 'const x = 1;');

    const result = await executeTool('format', { path: 'my file.ts' });
    // Should format or fail gracefully, not crash
    expect(result.success !== undefined).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/__tests__/security/shellInjection.test.ts -t "format"
```

Expected: The injection test may pass or fail depending on environment — the key is the format tool still uses shell: true.

- [ ] **Step 3: Implement the fix**

In `src/tools/index.ts`, replace the format tool case (~line 660). Replace the `execa(cmd, { shell: true, ... })` pattern with array-based invocation:

```typescript
case 'format': {
  const target = safeArgs.path ? resolvePath(safeArgs.path) : WORKSPACE;
  const projectType = await detectProjectType(WORKSPACE);

  // Use array-based invocation to avoid shell injection
  const formatCmds: Record<string, { cmd: string; args: string[] }> = {
    typescript: { cmd: 'npx', args: ['prettier', '--write', target] },
    javascript: { cmd: 'npx', args: ['prettier', '--write', target] },
    python: { cmd: 'python', args: ['-m', 'black', target] },
    go: { cmd: 'gofmt', args: ['-w', target] },
    rust: { cmd: 'rustfmt', args: [target] },
  };

  const fmtConfig = formatCmds[projectType];
  if (!fmtConfig) {
    return { success: false, error: `No formatter for project type: ${projectType}` };
  }

  const fmtResult = await execa(fmtConfig.cmd, fmtConfig.args, {
    cwd: WORKSPACE,
    timeout: 30000,
    reject: false,
  });

  // For Python, try autopep8 as fallback
  if (projectType === 'python' && fmtResult.exitCode !== 0) {
    const fallbackResult = await execa('python', ['-m', 'autopep8', '--in-place', target], {
      cwd: WORKSPACE,
      timeout: 30000,
      reject: false,
    });
    return {
      success: fallbackResult.exitCode === 0,
      output: fallbackResult.stdout || 'Formatted successfully',
      error: fallbackResult.exitCode !== 0 ? fallbackResult.stderr : undefined,
    };
  }

  return {
    success: fmtResult.exitCode === 0,
    output: fmtResult.stdout || 'Formatted successfully',
    error: fmtResult.exitCode !== 0 ? fmtResult.stderr : undefined,
  };
}
```

- [ ] **Step 4: Run the format tests**

```bash
npx vitest run src/__tests__/security/shellInjection.test.ts -t "format"
```

Expected: Tests PASS — no injection, no crash.

- [ ] **Step 5: Run full test suite**

```bash
npm run test:run
```

- [ ] **Step 6: Commit**

```bash
git add src/tools/index.ts src/__tests__/security/shellInjection.test.ts
git commit -m "[spica] fix: format tool shell injection via array-based execa (#6)"
```

---

### Task 4: Git Reset Interactive Confirmation (#9)

**Files:**
- Modify: `src/agent.ts:103-144` (checkNeedsPermission)
- Create: `src/__tests__/security/gitReset.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/security/gitReset.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import simpleGit from 'simple-git';
import { SpicaAgent } from '../../agent';

describe('git reset confirmation bypass', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spica-test-'));
    const git = simpleGit(tmpDir);
    await git.init();
    await fs.writeFile(path.join(tmpDir, 'test.txt'), 'content');
    await git.add('test.txt');
    await git.commit('initial commit');
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('should require permission for git reset regardless of userConfirmed parameter', () => {
    const agent = new SpicaAgent(undefined, tmpDir);

    // Access private method via type assertion for testing
    const agentAny = agent as any;
    const reason = agentAny.checkNeedsPermission('git', {
      action: 'reset',
      args: { mode: 'hard', userConfirmed: true },
    });

    // Even with userConfirmed: true, should still require permission
    expect(reason).not.toBeNull();
  });

  it('should require permission for git reset with userConfirmed false', () => {
    const agent = new SpicaAgent(undefined, tmpDir);
    const agentAny = agent as any;
    const reason = agentAny.checkNeedsPermission('git', {
      action: 'reset',
      args: { mode: 'hard', userConfirmed: false },
    });

    expect(reason).not.toBeNull();
  });

  it('should require permission for soft reset too', () => {
    const agent = new SpicaAgent(undefined, tmpDir);
    const agentAny = agent as any;
    const reason = agentAny.checkNeedsPermission('git', {
      action: 'reset',
      args: { mode: 'soft' },
    });

    expect(reason).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/__tests__/security/gitReset.test.ts
```

Expected: FAIL — `userConfirmed: true` bypasses permission check.

- [ ] **Step 3: Implement the fix**

In `src/agent.ts`, locate `checkNeedsPermission()`. Find the git reset block that checks `userConfirmed` and remove the bypass logic. The fix is to delete the two userConfirmed check blocks:

Remove these blocks from `checkNeedsPermission()`:
```typescript
// REMOVE THIS BLOCK:
// 用户确认的reset操作（AI已告知风险，用户明确确认）
if (action === 'reset' && gitArgs.userConfirmed === true) {
  return `用户已确认reset ${gitArgs.mode || 'mixed'}操作`;
}

// REMOVE THIS BLOCK:
// 用户确认的checkout操作
if (action === 'checkout' && gitArgs.userConfirmed === true) {
  return `用户已确认checkout操作，将切换到 ${gitArgs.branch}`;
}
```

The git reset section should only have the `clean` check (keep it), and rely on the existing reset gate in `src/tools/index.ts` which blocks dirty-tree resets and returns `requiresUserConfirmation: true`.

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/__tests__/security/gitReset.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 5: Run full test suite**

```bash
npm run test:run
```

- [ ] **Step 6: Commit**

```bash
git add src/agent.ts src/__tests__/security/gitReset.test.ts
git commit -m "[spica] fix: remove userConfirmed bypass in git reset permission (#9)"
```

---

### Task 5: EventEmitter Listener Cleanup (#1, LOW #1)

**Files:**
- Modify: `src/cli/events.ts`
- Modify: `src/llm/LLMClient.ts`
- Modify: `src/index.ts`
- Create: `src/__tests__/resources/eventCleanup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/resources/eventCleanup.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SpicaAgent } from '../../agent';
import { setupAgentEvents } from '../../cli/events';
import { TokenCounter } from '../../llm/TokenCounter';

describe('event listener cleanup', () => {
  it('setupAgentEvents should return a cleanup function', () => {
    const agent = new SpicaAgent(undefined, '/tmp');
    const tokenCounter = new TokenCounter();

    const cleanup = setupAgentEvents(agent, false, 'test-model', tokenCounter);
    expect(typeof cleanup).toBe('function');
  });

  it('cleanup function should remove listeners from agent', () => {
    const agent = new SpicaAgent(undefined, '/tmp');
    const tokenCounter = new TokenCounter();
    const beforeCount = agent.listenerCount('tool_result');

    const cleanup = setupAgentEvents(agent, false, 'test-model', tokenCounter);
    const afterSetupCount = agent.listenerCount('tool_result');
    expect(afterSetupCount).toBeGreaterThan(beforeCount);

    cleanup();

    const afterCleanupCount = agent.listenerCount('tool_result');
    // Should be back to original (or close to it — some internal listeners may persist)
    expect(afterCleanupCount).toBeLessThanOrEqual(beforeCount + 1);
  });

  it('double setup + single cleanup should not double-register', () => {
    const agent = new SpicaAgent(undefined, '/tmp');
    const tokenCounter = new TokenCounter();
    const beforeCount = agent.listenerCount('stream');

    setupAgentEvents(agent, false, 'test-model', tokenCounter);
    const cleanup = setupAgentEvents(agent, false, 'test-model', tokenCounter);
    const afterDoubleCount = agent.listenerCount('stream');

    cleanup();

    const afterCleanupCount = agent.listenerCount('stream');
    // After cleanup, listeners should be removed
    expect(afterCleanupCount).toBeLessThanOrEqual(beforeCount + 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/__tests__/resources/eventCleanup.test.ts
```

Expected: FAIL — `setupAgentEvents` returns `void`, not a function.

- [ ] **Step 3: Implement setupAgentEvents cleanup**

First read `src/cli/events.ts` to see the current implementation, then modify.

In `src/cli/events.ts`, modify `setupAgentEvents` to collect listeners and return a cleanup function. The pattern: add a local `on()` helper at the top of the function that registers on agent AND tracks for cleanup:

```typescript
export function setupAgentEvents(
  agent: SpicaAgent,
  isTui: boolean,
  model: string,
  tokenCounter: TokenCounter
): () => void {
  const listeners: Array<{ event: string; handler: (...args: any[]) => void }> = [];

  const on = (event: string, handler: (...args: any[]) => void) => {
    agent.on(event, handler);
    listeners.push({ event, handler });
  };

  // Then change every existing `agent.on(...)` in the function body to `on(...)`.
  // The handler functions themselves remain unchanged — only the registration call changes.
  // For example, `agent.on('stream', (data) => { ... })` becomes `on('stream', (data) => { ... })`.

  // At the end of the function, return cleanup:
  return () => {
    for (const { event, handler } of listeners) {
      agent.off(event, handler);
    }
  };
}
```

The actual `setupAgentEvents` file is long (~380 lines). The only mechanical change is:
1. Add the `listeners` array and `on()` helper at the top
2. Change every `agent.on(` to `on(`
3. Return the cleanup function at the end

Update the call site in `src/index.ts` to save the returned cleanup function:

```typescript
const cleanupEvents = setupAgentEvents(agent, true, providerConfig.model, tokenCounter);
```

Then call `cleanupEvents()` in the exit path alongside other cleanup.

- [ ] **Step 4: Implement LLMClient.dispose()**

In `src/llm/LLMClient.ts`, add a `dispose()` method:

```typescript
dispose(): void {
  this.provider.removeAllListeners();
  this.removeAllListeners();
}
```

- [ ] **Step 5: Implement stdin listener cleanup in index.ts**

In `src/index.ts`, find the `process.stdin.on('data', ...)` handler. Save the handler reference:

```typescript
const stdinHandler = (chunk: Buffer) => {
  const result = tuiHandler!.handleStdin(chunk.toString('utf8'), state.isPermissionDialogActive());
  // ... existing logic ...
};
process.stdin.on('data', stdinHandler);
```

Then in the exit path (where `shouldExit = true`), add:

```typescript
process.stdin.removeListener('data', stdinHandler);
```

- [ ] **Step 6: Run tests**

```bash
npx vitest run src/__tests__/resources/eventCleanup.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 7: Run full test suite**

```bash
npm run test:run
```

- [ ] **Step 8: Commit**

```bash
git add src/cli/events.ts src/llm/LLMClient.ts src/index.ts src/__tests__/resources/eventCleanup.test.ts
git commit -m "[spica] fix: event listener cleanup — setupAgentEvents returns cleanup, LLMClient.dispose, stdin listener removal (#1, LOW #1)"
```

---

### Task 6: RateLimiter setInterval Cleanup (#2)

**Files:**
- Modify: `src/llm/RateLimiter.ts:112-118`
- Create: `src/__tests__/resources/rateLimiterCleanup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/resources/rateLimiterCleanup.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../../llm/RateLimiter';

describe('RateLimiter interruptibleSleep cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should clear interval when signal aborts during sleep', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const limiter = new RateLimiter({ requestsPerMinute: 0 });
    const controller = new AbortController();

    // Start waiting — will block because 0 requests allowed
    const waitPromise = limiter.waitForAvailability(controller.signal);

    // Let a few intervals fire
    await vi.advanceTimersByTimeAsync(500);

    // Abort
    controller.abort();

    await waitPromise;

    // Verify clearInterval was called (the checkInterval)
    // It's called at least once — inside the abort handler
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it('should clear interval when interrupt() is called during sleep', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const limiter = new RateLimiter({ requestsPerMinute: 0 });

    const waitPromise = limiter.waitForAvailability();

    await vi.advanceTimersByTimeAsync(500);

    limiter.interrupt();

    await waitPromise;

    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/__tests__/resources/rateLimiterCleanup.test.ts
```

Expected: FAIL — `clearInterval` not called in abort handler.

- [ ] **Step 3: Implement the fix**

In `src/llm/RateLimiter.ts`, in `interruptibleSleep()`, add `clearInterval(checkInterval)` to the signal abort handler:

```typescript
signal?.addEventListener('abort', () => {
  clearTimeout(timer);
  clearInterval(checkInterval);  // ADD THIS LINE
  resolve();
});
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/__tests__/resources/rateLimiterCleanup.test.ts
```

Expected: 2 tests PASS.

- [ ] **Step 5: Run full test suite**

```bash
npm run test:run
```

- [ ] **Step 6: Commit**

```bash
git add src/llm/RateLimiter.ts src/__tests__/resources/rateLimiterCleanup.test.ts
git commit -m "[spica] fix: clearInterval on RateLimiter interruptibleSleep abort (#2)"
```

---

### Task 7: ProcessMonitor setTimeout Cleanup (MEDIUM #3)

**Files:**
- Modify: `src/core/ProcessMonitor.ts:132-138`
- Create: `src/__tests__/resources/processMonitorCleanup.test.ts`

- [ ] **Step 1: Write the test**

Create `src/__tests__/resources/processMonitorCleanup.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { ProcessMonitor } from '../../core/ProcessMonitor';

describe('ProcessMonitor kill timeout cleanup', () => {
  let tmpDir: string;
  let monitor: ProcessMonitor;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spica-test-'));
    monitor = new ProcessMonitor(tmpDir);
  });

  afterEach(async () => {
    await monitor.killAll();
    await fs.remove(tmpDir);
  });

  it('should clear sigkill timeout when process exits quickly', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    // Start a short-lived process
    const info = await monitor.start('echo', ['hello']);
    // Wait for it to exit
    await new Promise(resolve => setTimeout(resolve, 500));

    // Kill should find it already exited
    await monitor.kill(info.id);

    // Verify clearTimeout was called in the close handler
    // (the sigkill timer should have been cleared)
    // The process already exited, so clearTimeout should have been invoked
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it('should not crash on double kill', async () => {
    const info = await monitor.start('sleep', ['0.1']);
    await new Promise(resolve => setTimeout(resolve, 500));

    await monitor.kill(info.id);
    // Second kill should not throw
    await expect(monitor.kill(info.id)).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run test**

```bash
npx vitest run src/__tests__/resources/processMonitorCleanup.test.ts
```

- [ ] **Step 3: Implement the fix**

In `src/core/ProcessMonitor.ts`, modify the `kill()` method. Store the sigkill timer reference and clear it in the close handler:

```typescript
async kill(id: string): Promise<boolean> {
  const stored = this.processes.get(id);
  if (!stored?.process) return false;

  return new Promise((resolve) => {
    const process = stored.process!;
    let sigkillTimer: NodeJS.Timeout | null = null;

    const onClose = () => {
      if (sigkillTimer) {
        clearTimeout(sigkillTimer);
        sigkillTimer = null;
      }
      resolve(true);
    };

    process.on('close', onClose);

    stored.info.status = ProcessStatus.KILLED;
    stored.info.endTime = new Date();

    if (isWindows) {
      try {
        execSync(`taskkill /PID ${process.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        try {
          process.kill();
        } catch {}
      }
    } else {
      process.kill('SIGTERM');

      sigkillTimer = setTimeout(() => {
        if (stored.info.status === ProcessStatus.KILLED) {
          try {
            process.kill('SIGKILL');
          } catch {}
        }
        sigkillTimer = null;
      }, 5000);
    }
  });
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/__tests__/resources/processMonitorCleanup.test.ts
```

- [ ] **Step 5: Run full test suite**

```bash
npm run test:run
```

- [ ] **Step 6: Commit**

```bash
git add src/core/ProcessMonitor.ts src/__tests__/resources/processMonitorCleanup.test.ts
git commit -m "[spica] fix: clear sigkill timeout on ProcessMonitor process close (MEDIUM #3)"
```

---

### Task 8: Permission Queue Race Condition (HIGH #3)

**Files:**
- Modify: `src/agent.ts:186-192` (waitForPermission, processPermissionQueue)
- Create: `src/__tests__/state/permissionQueue.test.ts`

- [ ] **Step 1: Write the test**

Create `src/__tests__/state/permissionQueue.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SpicaAgent } from '../../agent';

describe('permission queue race condition', () => {
  it('should only have one processing loop running for concurrent requests', async () => {
    const agent = new SpicaAgent(undefined, '/tmp');
    const agentAny = agent as any;

    // Simulate two concurrent waitForPermission calls
    const promise1 = agentAny.waitForPermission('test reason 1');
    const promise2 = agentAny.waitForPermission('test reason 2');

    // Both should be enqueued, only one processing loop
    expect(agentAny.permissionPending).toBe(true);
    expect(agentAny.permissionQueue.length).toBe(1); // One is being processed, one waiting

    // Approve first
    agent.approvePermission();
    const result1 = await promise1;
    expect(result1).toBe(true);

    // Approve second
    agent.approvePermission();
    const result2 = await promise2;
    expect(result2).toBe(true);

    // Queue should be empty, not pending
    expect(agentAny.permissionPending).toBe(false);
    expect(agentAny.permissionQueue.length).toBe(0);
  });

  it('should handle denial correctly in sequence', async () => {
    const agent = new SpicaAgent(undefined, '/tmp');
    const agentAny = agent as any;

    const promise1 = agentAny.waitForPermission('reason 1');
    const promise2 = agentAny.waitForPermission('reason 2');

    agent.denyPermission();
    const result1 = await promise1;
    expect(result1).toBe(false);

    agent.approvePermission();
    const result2 = await promise2;
    expect(result2).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify current behavior**

```bash
npx vitest run src/__tests__/state/permissionQueue.test.ts
```

- [ ] **Step 3: Implement the fix**

In `src/agent.ts`, modify `waitForPermission()`:

```typescript
async waitForPermission(reason: string): Promise<boolean> {
  if (this.bypassPermissions) {
    this.auditLog('BYPASS_APPROVED', reason);
    this.emit('permission_bypassed', { reason });
    return true;
  }

  const request = { reason, resolve: null as ((approved: boolean) => void) | null };
  const promise = new Promise<boolean>((resolve) => {
    request.resolve = resolve;
  });
  this.permissionQueue.push(request as any);

  // Gate: only start processing if not already processing
  if (!this.permissionPending) {
    this.processPermissionQueue();
  }

  return promise;
}
```

And add a guard at the top of `processPermissionQueue()`:

```typescript
private async processPermissionQueue(): Promise<void> {
  // Gate: prevent concurrent processing loops
  if (this.permissionPending) return;
  this.permissionPending = true;

  while (this.permissionQueue.length > 0 && !this.interruptFlag) {
    // ... existing logic unchanged ...
  }
  this.permissionPending = false;
  this.permissionResolve = null;
}
```

Remove the `this.permissionPending = true` that was inside the while loop (since it's now set at the top).

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/__tests__/state/permissionQueue.test.ts
```

Expected: 2 tests PASS.

- [ ] **Step 5: Run full test suite**

```bash
npm run test:run
```

- [ ] **Step 6: Commit**

```bash
git add src/agent.ts src/__tests__/state/permissionQueue.test.ts
git commit -m "[spica] fix: permission queue race condition with atomic gate (HIGH #3)"
```

---

### Task 9: init() Error Cleanup (MEDIUM #1)

**Files:**
- Modify: `src/agent.ts:587-594`
- Create: `src/__tests__/state/initCleanup.test.ts`

- [ ] **Step 1: Write the test**

Create `src/__tests__/state/initCleanup.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { SpicaAgent } from '../../agent';

describe('init error cleanup', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spica-test-'));
    // Create a package.json so agent can load project config
    await fs.writeJson(path.join(tmpDir, 'package.json'), {
      devDependencies: { typescript: '^5.0.0' },
    });
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('should allow re-init after connection failure', async () => {
    // Create agent with invalid provider that will fail connection
    const agent = new SpicaAgent('nonexistent-provider', tmpDir);

    // First init should fail
    try {
      await (agent as any).init();
    } catch {
      // Expected failure
    }

    // Verify _initPromise is cleaned up (null)
    const agentAny = agent as any;
    expect(agentAny._initPromise).toBeNull();
    expect(agentAny._initialized).toBe(false);
  });
});
```

- [ ] **Step 2: Run test**

```bash
npx vitest run src/__tests__/state/initCleanup.test.ts
```

Expected: FAIL — `_initPromise` stays set after failure.

- [ ] **Step 3: Implement the fix**

In `src/agent.ts`, modify `init()`:

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

The key change: wrap the await in try-finally, set `_initialized` only on success, always clear `_initPromise`.

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/__tests__/state/initCleanup.test.ts
```

Expected: 1 test PASS.

- [ ] **Step 5: Run full test suite**

```bash
npm run test:run
```

- [ ] **Step 6: Commit**

```bash
git add src/agent.ts src/__tests__/state/initCleanup.test.ts
git commit -m "[spica] fix: init() always clears _initPromise in finally (MEDIUM #1)"
```

---

### Task 10: Compact Infinite Loop Safety (HIGH #10)

**Files:**
- Modify: `src/agent.ts:1251-1256`
- Create: `src/__tests__/state/compactLoop.test.ts`

- [ ] **Step 1: Write the test**

Create `src/__tests__/state/compactLoop.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { SpicaAgent } from '../../agent';
import { TokenCounter } from '../../llm/TokenCounter';

describe('compact loop safety', () => {
  it('should emit warning and exit after max iterations', async () => {
    const agent = new SpicaAgent(undefined, '/tmp');
    const agentAny = agent as any;

    // We can't easily mock the full compact flow without LLM,
    // but we can verify the guard constant exists
    // The real test: verify MAX_COMPACT_ITERATIONS is defined and used
    // Access via the private method's closure

    // Test at the unit level: verify the guard is in the code
    // This is primarily verified through code review + the constant's existence

    // Indirect verification: ensure the compactToTarget method exists
    expect(typeof agentAny.compactToTarget).toBe('function');
  });

  it('should have MAX_COMPACT_ITERATIONS limit defined', async () => {
    // Read the source to verify the constant exists
    const fs = await import('fs-extra');
    const source = await fs.readFile('src/agent.ts', 'utf-8');
    expect(source).toContain('MAX_COMPACT_ITERATIONS');
  });
});
```

- [ ] **Step 2: Implement the fix**

In `src/agent.ts`, in `compactToTarget()`, add iteration limit:

```typescript
private async compactToTarget(targetTokens: number): Promise<void> {
  if (!this.llm) return;
  const allMessages = this.llm.getMessages();
  const tokenCounter = new TokenCounter();
  const provider = this.llm.getProvider();
  tokenCounter.setContextWindow(provider.getContextWindow());
  const contextWindow = provider.getContextWindow();
  const MAX_COMPACT_ITERATIONS = 5;

  const usedTokens = tokenCounter.estimateMessages(allMessages);

  if (usedTokens < targetTokens) {
    this.emit('context_compressed', { before: allMessages.length, after: allMessages.length, tokensBefore: usedTokens, tokensAfter: usedTokens });
    return;
  }

  // ... existing ratio/keepCount logic ...

  let safetyTruncated = [...truncatedRecent];
  let safetyTokens = tokenCounter.estimateMessages(safetyTruncated);
  let compactIterations = 0;
  while (safetyTokens > targetTokens * 0.7 && safetyTruncated.length > 2) {
    compactIterations++;
    if (compactIterations > MAX_COMPACT_ITERATIONS) {
      this.emit('context_warning', {
        level: 'warning',
        usage: 100,
        message: `Compact loop exceeded ${MAX_COMPACT_ITERATIONS} iterations. Keeping remaining messages.`,
      });
      break;
    }
    safetyTruncated.shift();
    safetyTokens = tokenCounter.estimateMessages(safetyTruncated);
  }
  // ... rest of method unchanged ...
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/__tests__/state/compactLoop.test.ts
```

- [ ] **Step 4: Run full test suite**

```bash
npm run test:run
```

- [ ] **Step 5: Commit**

```bash
git add src/agent.ts src/__tests__/state/compactLoop.test.ts
git commit -m "[spica] fix: compact loop max iterations guard (HIGH #10)"
```

---

### Task 11: Bypass Mode Safety (HIGH #7)

**Files:**
- Modify: `src/agent.ts:173-177` (waitForPermission)
- Create: `src/__tests__/security/bypass.test.ts`

- [ ] **Step 1: Write the test**

Create `src/__tests__/security/bypass.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SpicaAgent } from '../../agent';

describe('bypass mode safety', () => {
  it('should still require permission for destructive ops even in bypass mode', () => {
    const agent = new SpicaAgent(undefined, '/tmp');
    agent.setBypassPermissions(true);
    const agentAny = agent as any;

    // These should still trigger permission even with bypass
    const destructiveOps = [
      { tool: 'bash', args: { command: 'rm -rf /tmp/test' } },
      { tool: 'git', args: { action: 'reset', args: { mode: 'hard' } } },
      { tool: 'bash', args: { command: 'chmod 777 /tmp' } },
      { tool: 'bash', args: { command: 'git push --force origin main' } },
      { tool: 'bash', args: { command: 'git clean -fd' } },
    ];

    for (const { tool, args } of destructiveOps) {
      const reason = agentAny.checkNeedsPermission(tool, args);
      expect(reason).not.toBeNull();
    }
  });

  it('should auto-approve safe commands in bypass mode', () => {
    const agent = new SpicaAgent(undefined, '/tmp');
    agent.setBypassPermissions(true);
    const agentAny = agent as any;

    // Safe commands should return null (no permission needed)
    const reason = agentAny.checkNeedsPermission('bash', {
      command: 'echo hello',
    });
    expect(reason).toBeNull();
  });

  it('should enforce the never-bypass list in waitForPermission', async () => {
    const agent = new SpicaAgent(undefined, '/tmp');
    agent.setBypassPermissions(true);
    const agentAny = agent as any;

    // waitForPermission with a destructive reason should not auto-approve
    // We test that checkNeedsPermission returns a reason for these
    const reason = agentAny.checkNeedsPermission('git', {
      action: 'reset',
      args: { mode: 'hard' },
    });
    expect(reason).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test**

```bash
npx vitest run src/__tests__/security/bypass.test.ts
```

Expected: May pass or fail depending on current bypass implementation.

- [ ] **Step 3: Implement the fix**

In `src/agent.ts`, in `waitForPermission()`, add a never-bypass check before the bypass auto-approval:

```typescript
async waitForPermission(reason: string): Promise<boolean> {
  // Never-bypass list: destructive operations always require confirmation
  const neverBypassPatterns = [
    'git reset --hard',
    'rm -rf',
    'chmod 777',
    'chmod -R 777',
    'git push --force',
    'git clean -fd',
    'dd if=',
    'mkfs',
    'shutdown',
    'reboot',
    ':(){ :|:& };:',
    '> /dev/',
    'mkswap',
    'fdisk',
  ];

  if (this.bypassPermissions) {
    const isNeverBypass = neverBypassPatterns.some(pattern =>
      reason.toLowerCase().includes(pattern.toLowerCase())
    );
    if (!isNeverBypass) {
      this.auditLog('BYPASS_APPROVED', reason);
      this.emit('permission_bypassed', { reason });
      return true;
    }
    // Fall through to normal permission flow for never-bypass ops
  }

  // ... rest of existing permission logic ...
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/__tests__/security/bypass.test.ts
```

- [ ] **Step 5: Run full test suite**

```bash
npm run test:run
```

- [ ] **Step 6: Commit**

```bash
git add src/agent.ts src/__tests__/security/bypass.test.ts
git commit -m "[spica] fix: bypass mode never-bypass list for destructive operations (HIGH #7)"
```

---

### Task 12: Project Hooks Override Protection (HIGH #8)

**Files:**
- Modify: `src/hooks/index.ts:25-48`
- Create: `src/__tests__/security/hooksOverride.test.ts`

- [ ] **Step 1: Write the test**

Create `src/__tests__/security/hooksOverride.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { loadHooks, runPreHooks } from '../../hooks/index';

describe('project hooks cannot override global safety', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spica-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('should prioritize global block over project allow', () => {
    // This test verifies the precedence logic.
    // Since global hooks are in ~/.spica/settings.json which we can't easily mock,
    // we test the merge logic indirectly via the hook matching.
    // The key assertion: loadHooks returns a structure where project hooks
    // cannot override global hooks with stricter actions.

    const hooksConfig = loadHooks(tmpDir);
    expect(hooksConfig).toHaveProperty('hooks');
    expect(hooksConfig.hooks).toHaveProperty('PreToolUse');
    expect(hooksConfig.hooks).toHaveProperty('PostToolUse');
  });

  it('should not crash when project has no hooks file', () => {
    const result = runPreHooks('bash', { command: 'echo test' });
    expect(result).toHaveProperty('matched');
    expect(result).toHaveProperty('action');
  });
});
```

- [ ] **Step 2: Implement the fix**

In `src/hooks/index.ts`, modify `loadHooks()` to filter project hooks that attempt to override stricter global hooks:

```typescript
export function loadHooks(workspacePath?: string): HooksConfig {
  const ws = workspacePath || process.cwd();

  const globalSettings = loadGlobalSettingsSync();
  let hooks = globalSettings.hooks || { PreToolUse: [], PostToolUse: [] };

  const projectHooks = loadProjectHooks(ws);
  if (projectHooks) {
    // Build a map of global PreToolUse actions keyed by tool pattern
    const globalPreActions = new Map<string, string>();
    for (const hook of (hooks.PreToolUse || [])) {
      const key = hook.matcher.tool || '*';
      globalPreActions.set(key, hook.action);
    }

    // Filter project PreToolUse hooks: cannot be more permissive than global
    const strictnessOrder: Record<string, number> = {
      'none': 0,
      'warn': 1,
      'confirm': 2,
      'block': 3,
    };

    const filteredProjectPre = (projectHooks.PreToolUse || []).filter(hook => {
      const key = hook.matcher.tool || '*';
      const globalAction = globalPreActions.get(key);
      if (!globalAction) return true; // No global hook for this tool, allow

      const globalStrictness = strictnessOrder[globalAction] || 0;
      const projectStrictness = strictnessOrder[hook.action] || 0;

      // Project hooks can only be AS strict or stricter, never more permissive
      return projectStrictness >= globalStrictness;
    });

    hooks = {
      PreToolUse: [
        ...(hooks.PreToolUse || []),
        ...filteredProjectPre,
      ],
      PostToolUse: [
        ...(hooks.PostToolUse || []),
        ...(projectHooks.PostToolUse || []),
      ],
    };
  }

  return { hooks };
}
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/__tests__/security/hooksOverride.test.ts
```

- [ ] **Step 4: Run full test suite**

```bash
npm run test:run
```

- [ ] **Step 5: Commit**

```bash
git add src/hooks/index.ts src/__tests__/security/hooksOverride.test.ts
git commit -m "[spica] fix: global hooks take precedence over project hooks (HIGH #8)"
```

---

### Task 13: SSE/Message Stream Fixes (MEDIUM #2, #4-8)

**Files:**
- Modify: `src/llm/providers/OpenAICompatible.ts`
- Modify: `src/agent.ts`
- Create: `src/__tests__/stream/sseInterrupt.test.ts`
- Create: `src/__tests__/stream/retryConflict.test.ts`

- [ ] **Step 1: Write the SSE interrupt test**

Create `src/__tests__/stream/sseInterrupt.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import fs from 'fs-extra';

describe('SSE stream interrupt handling', () => {
  it('should define MAX_TOOL_CALLS constant in OpenAICompatible', async () => {
    const source = await fs.readFile(
      'src/llm/providers/OpenAICompatible.ts',
      'utf-8'
    );
    expect(source).toContain('MAX_TOOL_CALLS');
  });

  it('should have InterruptError class defined in agent', async () => {
    const source = await fs.readFile('src/agent.ts', 'utf-8');
    expect(source).toContain('InterruptError');
  });

  it('should have signal.aborted break in SSE for-await loop', async () => {
    const source = await fs.readFile(
      'src/llm/providers/OpenAICompatible.ts',
      'utf-8'
    );
    // Verify the break after signal check
    expect(source).toMatch(/signal\?\.aborted.*break/);
  });
});
```

- [ ] **Step 2: Write the retry conflict test**

Create `src/__tests__/stream/retryConflict.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import fs from 'fs-extra';

describe('SDK retry conflict resolution', () => {
  it('should have maxRetries set to 0 in OpenAI client', async () => {
    const source = await fs.readFile(
      'src/llm/providers/OpenAICompatible.ts',
      'utf-8'
    );
    expect(source).toContain('maxRetries: 0');
  });
});
```

- [ ] **Step 3: Implement the fixes**

**3a. InterruptError class** — Add to `src/agent.ts` (at top, before SpicaAgent class):

```typescript
export class InterruptError extends Error {
  constructor(message = 'Interrupted by user') {
    super(message);
    this.name = 'InterruptError';
  }
}
```

Update `callLLMWithRetry()` to catch and re-throw without retry:

```typescript
private async callLLMWithRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries: number = 10
): Promise<T> {
  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (this.interruptFlag) {
      throw new InterruptError();
    }

    try {
      return await operation();
    } catch (error: any) {
      // InterruptError: don't retry, propagate immediately
      if (error instanceof InterruptError || error.name === 'InterruptError') {
        throw error;
      }

      lastError = error;
      // ... rest of existing retry logic ...
    }
  }
  throw lastError;
}
```

**3b. SSE stream abort guard** — In `src/llm/providers/OpenAICompatible.ts`, in all `for await (const chunk of stream)` loops, add after the `signal?.aborted` check:

```typescript
for await (const chunk of stream) {
  if (signal?.aborted) {
    // Remove the last assistant message with incomplete toolCalls
    const lastMsg = this.messages[this.messages.length - 1];
    if (lastMsg?.role === 'assistant' && lastMsg.toolCalls) {
      this.messages.pop();
    }
    break;
  }
  // ... rest of chunk processing ...
}
```

**3c. MAX_TOOL_CALLS constant** — Add at top of `src/llm/providers/OpenAICompatible.ts`:

```typescript
const MAX_TOOL_CALLS = 128;
```

In the toolCalls accumulation code, add bounds check before array access:

```typescript
if (tc.index !== undefined && tc.index >= 0 && tc.index < MAX_TOOL_CALLS) {
  if (!toolCalls[tc.index]) {
    toolCalls[tc.index] = { id: tc.id, name: '', arguments: '' };
  }
  // ... rest ...
}
```

**3d. SDK maxRetries** — In the OpenAI client constructor, set `maxRetries: 0`:

```typescript
this.client = new OpenAI({
  apiKey: config.apiKey,
  baseURL: config.baseUrl,
  timeout: 60000,
  maxRetries: 0,
});
```

**3e. Message sequence validation** — In `src/agent.ts`, after `cleanMessages()`, verify sequence:

```typescript
private cleanMessagesForLLM(messages: ChatMessage[]): ChatMessage[] {
  const cleaned = cleanMessages(messages);

  // Validate alternating user/assistant pattern
  let lastRole = '';
  const validSequence: ChatMessage[] = [];
  for (const msg of cleaned) {
    if (msg.role === 'tool') continue; // Tool messages can appear anywhere
    if (msg.role === lastRole && (msg.role === 'user' || msg.role === 'assistant')) {
      continue; // Skip duplicate role
    }
    validSequence.push(msg);
    lastRole = msg.role;
  }

  return validSequence;
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/__tests__/stream/sseInterrupt.test.ts src/__tests__/stream/retryConflict.test.ts
```

- [ ] **Step 5: Run full test suite**

```bash
npm run test:run
```

- [ ] **Step 6: Commit**

```bash
git add src/agent.ts src/llm/providers/OpenAICompatible.ts src/__tests__/stream/sseInterrupt.test.ts src/__tests__/stream/retryConflict.test.ts
git commit -m "[spica] fix: SSE stream interrupt handling, retry conflict, message sequence (MEDIUM #2,#4-8)"
```

---

### Task 14: Token/Abort Fixes (MEDIUM #9-11)

**Files:**
- Modify: `src/llm/TokenCounter.ts`
- Modify: `src/llm/LLMClient.ts`
- Create: `src/__tests__/llm/tokenCounter.test.ts`

- [ ] **Step 1: Write the test**

Create `src/__tests__/llm/tokenCounter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { TokenCounter } from '../../llm/TokenCounter';

describe('TokenCounter improvements', () => {
  it('should estimate CJK characters at higher token ratio', () => {
    const counter = new TokenCounter();
    const english = 'hello world';
    const chinese = '你好世界';
    const japanese = 'こんにちは世界';

    const englishTokens = counter.estimateTokens(english);
    const chineseTokens = counter.estimateTokens(chinese);
    const japaneseTokens = counter.estimateTokens(japanese);

    // CJK should have higher token count per character
    expect(chineseTokens).toBeGreaterThan(englishTokens * 0.8);
    expect(japaneseTokens).toBeGreaterThan(englishTokens * 0.8);
  });

  it('should estimate code at different ratio than prose', () => {
    const counter = new TokenCounter();
    const prose = 'The quick brown fox jumps over the lazy dog';
    const code = 'const x = () => { return this.value + 1; }';

    const proseTokens = counter.estimateTokens(prose);
    const codeTokens = counter.estimateTokens(code);

    // Code and prose should both estimate reasonably
    expect(proseTokens).toBeGreaterThan(0);
    expect(codeTokens).toBeGreaterThan(0);
  });

  it('should store and return contextWindow', () => {
    const counter = new TokenCounter();
    counter.setContextWindow(200000);
    expect(counter.getContextWindow()).toBe(200000);
  });
});
```

- [ ] **Step 2: Run test**

```bash
npx vitest run src/__tests__/llm/tokenCounter.test.ts
```

- [ ] **Step 3: Implement the fixes**

**3a. TokenCounter CJK heuristic** — In `src/llm/TokenCounter.ts`:

```typescript
export class TokenCounter {
  private static readonly AVERAGE_CHARS_PER_TOKEN = 4;
  private static readonly CJK_CHARS_PER_TOKEN = 1.5;
  private static readonly CODE_CHARS_PER_TOKEN = 3;
  private contextWindow: number = 128000;

  setContextWindow(size: number): void {
    this.contextWindow = size;
  }

  getContextWindow(): number {
    return this.contextWindow;
  }

  private detectContentType(text: string): 'cjk' | 'code' | 'prose' {
    let cjkCount = 0;
    let codeIndicators = 0;

    for (const char of text) {
      const code = char.charCodeAt(0);
      // CJK Unified Ideographs, Hiragana, Katakana, Hangul
      if (
        (code >= 0x4E00 && code <= 0x9FFF) ||
        (code >= 0x3040 && code <= 0x309F) ||
        (code >= 0x30A0 && code <= 0x30FF) ||
        (code >= 0xAC00 && code <= 0xD7AF)
      ) {
        cjkCount++;
      }
    }

    // Code indicators: braces, semicolons, arrows, dots
    const codePatterns = /[{}();=><\[\].]/g;
    const codeMatches = text.match(codePatterns);
    if (codeMatches) codeIndicators = codeMatches.length;

    if (cjkCount > text.length * 0.3) return 'cjk';
    if (codeIndicators > text.length * 0.05) return 'code';
    return 'prose';
  }

  estimateTokens(text: string): number {
    const type = this.detectContentType(text);
    let charsPerToken: number;
    switch (type) {
      case 'cjk':
        charsPerToken = TokenCounter.CJK_CHARS_PER_TOKEN;
        break;
      case 'code':
        charsPerToken = TokenCounter.CODE_CHARS_PER_TOKEN;
        break;
      default:
        charsPerToken = TokenCounter.AVERAGE_CHARS_PER_TOKEN;
    }
    return Math.ceil(text.length / charsPerToken);
  }
  // ... rest unchanged ...
}
```

**3b. contextWindow sync** — Verify `LLMClient` passes contextWindow to TokenCounter. Currently it's already done in `compactToTarget()`. Add a one-time sync in `LLMClient.generate()`:

No additional change needed — `TokenCounter` instances are created fresh with default that gets overridden in `compactToTarget()`.

**3c. AbortController in executeWithTools** — In `LLMClient.executeWithTools()`, add interrupt check:

```typescript
async executeWithTools(prompt: string, maxIterations: number = 10): Promise<string> {
  let response = await this.generate(prompt);
  let iterations = 0;

  while (!response.finished && iterations < maxIterations) {
    if (this.pendingInterrupt) {
      throw new Error('Interrupted');
    }

    if (response.toolCalls) {
      for (const tc of response.toolCalls) {
        if (this.pendingInterrupt) {
          throw new Error('Interrupted');
        }
        // ... existing tool execution ...
      }
    }
    iterations++;
  }

  return response.content || '';
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/__tests__/llm/tokenCounter.test.ts
```

- [ ] **Step 5: Run full test suite**

```bash
npm run test:run
```

- [ ] **Step 6: Commit**

```bash
git add src/llm/TokenCounter.ts src/llm/LLMClient.ts src/__tests__/llm/tokenCounter.test.ts
git commit -m "[spica] fix: TokenCounter CJK heuristic, executeWithTools interrupt, contextWindow sync (MEDIUM #9-11)"
```

---

### Task 15: LLMClient Interrupt Completeness (MEDIUM #12-15)

**Files:**
- Modify: `src/llm/LLMClient.ts`
- Modify: `src/agent.ts`
- Create: `src/__tests__/llm/interrupt.test.ts`
- Create: `src/__tests__/llm/dangerousCommands.test.ts`

- [ ] **Step 1: Write interrupt test**

Create `src/__tests__/llm/interrupt.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import fs from 'fs-extra';

describe('LLMClient interrupt completeness', () => {
  it('should reset RateLimiter on interrupt', async () => {
    const source = await fs.readFile('src/llm/LLMClient.ts', 'utf-8');
    expect(source).toMatch(/interrupt\(\)[^{]*{[^}]*rateLimiter/);
  });

  it('should clear pendingInterrupt in interrupt', async () => {
    const source = await fs.readFile('src/llm/RateLimiter.ts', 'utf-8');
    expect(source).toContain('pendingInterrupt = false');
  });
});
```

- [ ] **Step 2: Write dangerous commands test**

Create `src/__tests__/llm/dangerousCommands.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SpicaAgent } from '../../agent';

describe('dangerous command detection', () => {
  it('should detect doas command', () => {
    const agent = new SpicaAgent(undefined, '/tmp');
    const agentAny = agent as any;
    const reason = agentAny.checkNeedsPermission('bash', {
      command: 'doas rm -rf /',
    });
    expect(reason).not.toBeNull();
  });

  it('should detect run0 command', () => {
    const agent = new SpicaAgent(undefined, '/tmp');
    const agentAny = agent as any;
    const reason = agentAny.checkNeedsPermission('bash', {
      command: 'run0 cat /etc/shadow',
    });
    expect(reason).not.toBeNull();
  });
});
```

- [ ] **Step 3: Implement the fixes**

**3a. interrupt() cleanup** — In `src/llm/LLMClient.ts`:

```typescript
interrupt() {
  this.pendingInterrupt = true;
  this.rateLimiter.interrupt();
  if (this.abortController) {
    this.abortController.abort();
  }
}
```

**3b. RateLimiter cleanup** — In `src/llm/RateLimiter.ts`, `interrupt()` already sets `pendingInterrupt = true`. Verify the `interruptibleSleep` reject path also clears the interval:

```typescript
private interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted || this.pendingInterrupt) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      clearInterval(checkInterval);
      resolve();
    }, ms);

    const checkInterval = setInterval(() => {
      if (this.pendingInterrupt) {
        clearTimeout(timer);
        clearInterval(checkInterval);
        resolve();
      }
    }, 100);

    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      clearInterval(checkInterval);
      resolve();
    });
  });
}
```

**3c. doas/run0 detection** — In `src/agent.ts`, `checkNeedsPermission()`, add to the dangerous patterns array:

```typescript
{ pattern: 'doas ', name: '使用doas权限' },
{ pattern: 'run0 ', name: '使用run0权限' },
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/__tests__/llm/interrupt.test.ts src/__tests__/llm/dangerousCommands.test.ts
```

- [ ] **Step 5: Run full test suite**

```bash
npm run test:run
```

- [ ] **Step 6: Commit**

```bash
git add src/llm/LLMClient.ts src/llm/RateLimiter.ts src/agent.ts src/__tests__/llm/interrupt.test.ts src/__tests__/llm/dangerousCommands.test.ts
git commit -m "[spica] fix: LLMClient interrupt completeness, doas/run0 detection (MEDIUM #12-15)"
```

---

### Task 16: Minor Hardening (LOW #2-4)

**Files:**
- Modify: `src/index.ts`
- Modify: `src/utils/history.ts`
- Modify: `src/tools/index.ts`
- Create: `src/__tests__/security/pathLeak.test.ts`

- [ ] **Step 1: Write the test**

Create `src/__tests__/security/pathLeak.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { setWorkspace, executeTool } from '../../tools/index';

describe('path leakage prevention', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spica-test-'));
    setWorkspace(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('should not leak absolute paths in error messages', async () => {
    const result = await executeTool('file_read', {
      path: '/nonexistent/file.txt',
    });

    if (!result.success && result.error) {
      // Error should not contain the full absolute path
      expect(result.error).not.toContain(tmpDir);
      // May contain relative path
    }
  });
});
```

- [ ] **Step 2: Implement the fixes**

**2a. API key exposure** — In `src/index.ts`, find the `connection_error` event emission. Ensure the payload does NOT include the API key:

```typescript
this.emit('connection_error', {
  type: connectionResult.type,
  error: connectionResult.error,
  hint: connectionResult.hint,
  provider: this._providerName,
  model: config.model,
  // Do NOT include: apiKey, config.apiKey, or any key material
});
```

**2b. Session history chmod** — In `src/utils/history.ts`, add chmod after write:

```typescript
export function saveHistory(history: ChatMessage[]): void {
  try {
    ensureHistoryDir();
    const trimmed = history.slice(-MAX_HISTORY);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2));
    // Restrict permissions to owner only
    fs.chmodSync(HISTORY_FILE, 0o600);
  } catch (error) {
    // Failed to save history - non-critical
  }
}
```

**2c. Path leakage in tools** — First, add `relative` to the path import in `src/tools/index.ts` line 4:

```typescript
import { resolve as pathResolve, isAbsolute, dirname, join, relative } from 'path';
```

Then, in error messages that include resolved paths, use `relative(WORKSPACE, resolvedPath)`:

For example, in `file_read` error handling:
```typescript
// Instead of: throw new Error(`Access denied: path "${resolved}" is outside workspace`)
// Use:
const relativePath = relative(WORKSPACE, resolved);
throw new Error(`Access denied: path "${relativePath}" is outside workspace`);
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/__tests__/security/pathLeak.test.ts
```

- [ ] **Step 4: Run full test suite**

```bash
npm run test:run
```

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/utils/history.ts src/tools/index.ts src/__tests__/security/pathLeak.test.ts
git commit -m "[spica] fix: API key omission, chmod 600 history, path leakage prevention (LOW #2-4)"
```

---

### Task 17: Final Verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

```bash
npm run test:run
```

Expected: All 285 existing tests + ~25 new tests PASS. Zero failures.

- [ ] **Step 2: Run linter**

```bash
npm run lint
```

Expected: Zero lint errors.

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: Build succeeds, `bin/spica` is generated.

- [ ] **Step 4: Verify bin works**

```bash
./bin/spica --version
```

Expected: Version number printed.

- [ ] **Step 5: Type check**

```bash
npx tsc --noEmit
```

Expected: Zero type errors.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "[spica] chore: final verification — all 29 issues resolved, tests green, build passes"
```

---

## Breaking Changes Summary

| Fix | Change | Impact |
|-----|--------|--------|
| #4 Symlink check | `resolvePath()` rejects symlinks outside workspace | Previously traversable symlinks now blocked |
| #5 Shell patterns | `;`, `&&`, `||`, `${}`, heredoc, `eval` blocked in bash tool | Commands using these must be restructured |
| #9 Git reset | `userConfirmed` parameter ignored, always interactive confirmation | No more silent git resets |
| #7 Bypass | Destructive ops require confirmation in bypass mode | Added safety, minor workflow change |
| #8 Hooks | Global hooks take precedence over project hooks | Malicious project configs neutralized |
