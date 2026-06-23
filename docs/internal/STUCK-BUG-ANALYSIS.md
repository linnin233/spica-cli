# TUI 工具卡住问题完整分析

## 一、问题汇总

### 🔴 问题 #1: execa 没有 `detached: true`

**位置:** `src/tools/index.ts:1155`

**代码:**
```typescript
bashProcess = execa(actualCommand, {
  shell: true,
  cwd: WORKSPACE,
  timeout: timeout,
  reject: false,
  cancelSignal: abortController.signal,
});
```

**问题:** 没有 `detached: true`，进程不会创建自己的进程组。

**后果:** `process.kill(-pid, 'SIGKILL')` 会失败（ESRCH），无法杀死子进程。

**验证:**
```
$ npx tsx test-execa-pid.ts
pid: 439381
trying to kill pid: 439381
kill process group failed: kill ESRCH  ← 进程组不存在
```

---

### 🔴 问题 #2: bashProcess.pid 在 timer 触发时可能未就绪

**位置:** `src/tools/index.ts:1111-1129`

**代码结构:**
```typescript
let bashProcess: any = null;  // Line 1111: 先设为 null

const stuckTimeoutPromise = new Promise((_, reject) => {
  stuckWarningTimer = setTimeout(() => {
    // Line 1129: timer 触发时检查
    if (bashProcess && bashProcess.pid) {
      process.kill(-bashProcess.pid, 'SIGKILL');
    }
  }, stuckWarningMs);
});

// Line 1155: 稍后才赋值
bashProcess = execa(...);
```

**问题:** 虽然 execa 的 pid 是"立即可用"的 Promise 属性，但 JavaScript 的异步执行顺序不能保证在 timer 触发时 bashProcess 已赋值。

**场景:** 如果工具快速完成（< 60s），timer 不会触发；但如果卡住，timer 触发时 bashProcess 应该已赋值。但这个假设不保证。

---

### 🔴 问题 #3: Promise.race 后进程可能还在运行

**位置:** `src/tools/index.ts:1164-1177`

**代码:**
```typescript
const bashResult = await Promise.race([bashProcess, stuckTimeoutPromise])
  .catch((err) => {
    if (err.message === 'STUCK_TIMEOUT') {
      return { timedOut: true, exitCode: null, stdout: '', stderr: '', isStuck: true };
    }
    throw err;
  });
```

**问题:** 当 stuckTimeoutPromise reject 时，我们只是返回了一个假结果，但：
1. bashProcess 这个 Promise 还在等待
2. 实际的 shell 进程可能还在运行（如果杀死失败）
3. Promise.race 不会取消其他 Promise

**后果:** 进程可能变成孤儿进程，继续消耗资源。

---

### 🔴 问题 #4: tool_stuck_warning 事件发送两次

**位置:** 
- `src/tools/index.ts:1120` (timer 触发时)
- `src/tools/index.ts:1195` (超时检查时)

**代码:**
```typescript
// Line 1120: 第一次发送
eventCallback?.('tool_stuck_warning', { ... });

// Line 1195: 第二次发送（如果 autoRetry）
eventCallback?.('tool_stuck_warning', { 
  command: actualCommand.slice(0, 50),
  timeout: timeout / 1000,
  retrying: true,
  message: 'Command stuck/timeout, auto-retrying in detached mode...'
});
```

**后果:** 用户看到两次 `[STUCK]` 提示，可能混淆。

---

### 🟡 问题 #5: interruptFlag 设置后工具执行继续

**位置:** `src/agent.ts:861-863`

**代码:**
```typescript
if (event === 'tool_stuck_warning') {
  this.abortTool(tc.name);
  this.interruptFlag = true;
}
```

**问题:** interruptFlag 设置后，executeTool 还在等待 Promise.race 结果。虽然有 Promise.race 会快速返回，但如果杀死失败，进程还在运行。

**后果:** interruptFlag 只影响后续工具调用，不影响当前正在卡住的工具。

---

### 🟡 问题 #6: 流式输出状态与工具执行状态不同步

**位置:** `src/cli/events.ts:291-293`

**代码:**
```typescript
on('tool_call', (data: ToolCallData) => {
  state.setStreamingOutput(false);
  screen.setStreaming(false);
  // ...
});
```

**问题:** 工具调用开始时设置 `isStreaming = false`，但工具执行期间没有进度显示。

**后果:** 用户看不到工具执行进度，只有完成后才显示结果。如果工具卡住，用户只看到 `┌─ bash ┐` 然后 5-6 分钟没有更新。

---

### 🟡 问题 #7: 进度报告定时器只在大 timeout 时启动

**位置:** `src/tools/index.ts:1146`

**代码:**
```typescript
if (eventCallback && timeout > 10000) {
  progressTimer = setInterval(...);
}
```

**问题:** 默认 timeout 是 120s，所以这个条件通常成立。但如果用户设置了短 timeout（如 30s），就没有进度报告。

---

## 二、修复方案

### 修复 #1: 添加 `detached: true`

```typescript
bashProcess = execa(actualCommand, {
  shell: true,
  cwd: WORKSPACE,
  timeout: timeout,
  reject: false,
  cancelSignal: abortController.signal,
  detached: true,  // ← 创建进程组，允许杀死整个进程树
});
```

### 修复 #2: 在 timer 触发时先获取 pid

由于 execa 的 pid 是立即可用的，可以重新组织代码：

```typescript
// 先启动进程
bashProcess = execa(actualCommand, {
  shell: true,
  detached: true,  // ← 关键
  ...
});

// 然后设置 timer（此时 pid 已就绪）
stuckWarningTimer = setTimeout(() => {
  eventCallback?.('tool_stuck_warning', { ... });
  abortController.abort();
  
  // 确保杀死进程组
  if (bashProcess.pid) {
    try { process.kill(-bashProcess.pid, 'SIGKILL'); } catch {}
  }
}, stuckWarningMs);

// 使用 Promise.race
const bashResult = await Promise.race([bashProcess, stuckTimeoutPromise]);
```

### 修复 #3: 确保进程真的被杀死

使用 `pkill` 作为备选方案：

```typescript
// 在杀死进程组失败时，使用 pkill
if (bashProcess.pid) {
  try {
    process.kill(-bashProcess.pid, 'SIGKILL');
  } catch {
    // 备选：使用 pkill 杀死所有相关进程
    await execa('pkill', ['-P', String(bashProcess.pid)], { reject: false });
    try { process.kill(bashProcess.pid, 'SIGKILL'); } catch {}
  }
}
```

### 修复 #4: 只发送一次 tool_stuck_warning

移除第二次事件发送，或者合并：

```typescript
if (isStuckOrTimeout) {
  // 不再重复发送事件（已经在 timer 中发送了）
  if (_autoRetry && !detached && !isWindows) {
    // 直接重试，不发送第二次事件
    // 或者发送不同的事件：'tool_retry_started'
  }
}
```

### 修复 #5: 显示工具执行进度

在 tool_call 开始时显示进度提示：

```typescript
on('tool_call', (data: ToolCallData) => {
  state.setStreamingOutput(false);
  screen.setStreaming(false);
  screen.appendScroll(COLORS.tool(`\n┌─ ${data.name} ┐\n`));
  screen.appendScroll(COLORS.muted(`  │ Running... (ESC ESC to interrupt)\n`));  // ← 添加进度提示
});
```

---

## 三、代码修改验证

### 测试 #1: 验证 detached 模式杀死进程组

```typescript
// test-detached-kill.ts
const proc = execa('bash', ['-c', 'sleep 10 & sleep 10; wait'], {
  shell: false,
  detached: true,
});

console.log('pid:', proc.pid);
setTimeout(() => {
  process.kill(-proc.pid!, 'SIGKILL');
  console.log('killed process group');
}, 1000);

await proc.catch(e => console.log('error:', e.message));
```

**预期结果:** 进程组被杀死，没有残留 sleep 进程。

---

## 四、执行流程分析

### 当前流程（有Bug）

```
工具开始
  ↓
execa 启动（shell=true, 无 detached）
  ↓
进程启动，但不在独立进程组
  ↓
┌─────────────────────────────────────┐
│ Promise.race 等待                    │
│   ├─ bashProcess Promise            │
│   └─ stuckTimeoutPromise (60s timer) │
└─────────────────────────────────────┘
  ↓
60秒后 timer 触发
  ↓
发送 tool_stuck_warning ← 第一次
  ↓
abortController.abort()
  ↓
尝试 process.kill(-pid) ← 失败！ESRCH
  ↓
尝试 process.kill(pid) ← 可能成功，但子进程还在
  ↓
Promise.race 返回 { isStuck: true }
  ↓
检查 isStuckOrTimeout
  ↓
发送 tool_stuck_warning ← 第二次！重复
  ↓
autoRetry: 启动 tmux detached 模式
  ↓
返回结果给 agent
```

### 修复后流程

```
工具开始
  ↓
execa 启动（shell=true, detached=true）← 关键改动
  ↓
进程启动，在独立进程组（PGID = PID）
  ↓
pid 立即可用 ← 确保赋值顺序
  ↓
设置 timer（此时 pid 已就绪）
  ↓
┌─────────────────────────────────────┐
│ Promise.race 等待                    │
│   ├─ bashProcess Promise            │
│   └─ stuckTimeoutPromise (60s timer) │
└─────────────────────────────────────┘
  ↓
60秒后 timer 触发
  ↓
发送 tool_stuck_warning ← 只发送一次
  ↓
abortController.abort()
  ↓
process.kill(-pid, 'SIGKILL') ← 成功！杀死进程组
  ↓
Promise.race 返回 { isStuck: true }
  ↓
检查 isStuckOrTimeout
  ↓
autoRetry: 启动 tmux detached 模式
  ↓
返回结果给 agent
  ↓
agent 设置 interruptFlag
  ↓
继续处理其他工具（跳过后续卡住风险）
```

---

## 五、紧急程度排序

| 问题 | 紧急度 | 影响 |
|------|--------|------|
| #1 detached: true | 🔴 高 | 进程杀死失败 |
| #2 pid 赋值顺序 | 🔴 高 | timer 触发时 pid 可能未就绪 |
| #3 进程残留 | 🔴 高 | 资源泄漏 |
| #4 事件重复 | 🟡 中 | 用户混淆 |
| #5 interruptFlag | 🟡 中 | 状态不同步 |
| #6 进度显示 | 🟢 低 | 用户体验 |

---

## 六、下一步行动

1. **立即修复:** 添加 `detached: true` 和重新组织代码顺序
2. **测试验证:** 使用测试脚本验证进程组杀死
3. **后续改进:** 添加进度显示和状态同步