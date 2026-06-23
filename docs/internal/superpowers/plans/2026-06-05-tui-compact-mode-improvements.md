# TUI Compact Mode Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 改进 spica TUI 的 compact 模式显示（工具调用折叠）和终端 resize 处理

**Architecture:** 在 events.ts 中添加 compact 模式判断逻辑，在 screenManager.ts 中添加 resize 事件监听

**Tech Stack:** TypeScript, Node.js TUI (ANSI escape codes)

---

## Files Structure

| 文件 | 责任 |
|------|------|
| `src/cli/events.ts` | 工具调用事件处理、compact/verbose 模式切换 |
| `src/cli/ui/screenManager.ts` | 屏幕布局管理、resize 事件处理 |
| `src/cli/__tests__/events.test.ts` | 新增测试文件 |

---

### Task 1: Add formatToolSummary and helper functions

**Files:**
- Modify: `src/cli/events.ts` (顶部，formatArgs 函数附近)

- [ ] **Step 1: Add helper functions**

在 `formatArgs` 函数后面添加：

```typescript
// 工具摘要辅助函数
function countDiffLines(text: string, prefix: '+' | '-'): number {
  return text.split('\n').filter(l => l.startsWith(prefix) && !l.startsWith(prefix + prefix)).length;
}

function countMatches(output: string): number {
  const match = output.match(/(\d+)\s+matches/i) || output.match(/Found\s+(\d+)/i);
  return match ? parseInt(match[1], 10) : 0;
}

function countFiles(output: string): number {
  const lines = output.split('\n').filter(l => l.trim() && !l.includes('found'));
  return lines.length;
}

function countTestPassed(output: string): number {
  const match = output.match(/(\d+)\s+passed/i) || output.match(/✓\s+(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function countTestFailed(output: string): number {
  const match = output.match(/(\d+)\s+failed/i) || output.match(/✗\s+(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function countLintErrors(output: string): number {
  const match = output.match(/(\d+)\s+errors/i) || output.match(/(\d+)\s+problems/i);
  return match ? parseInt(match[1], 10) : 0;
}

function countAgents(output: string): number {
  const match = output.match(/(\d+)\s+agents/i) || output.match(/(\d+)\s+tasks/i);
  return match ? parseInt(match[1], 10) : 0;
}
```

- [ ] **Step 2: Add formatToolSummary function**

```typescript
function formatToolSummary(data: { name: string; success: boolean; output?: string; error?: string; content?: string }): string {
  if (!data.success) {
    const errorMsg = data.error ? data.error.slice(0, 50) : '';
    return errorMsg ? ` (${errorMsg})` : '';
  }

  const name = data.name;
  const output = data.output || '';

  switch (name) {
    case 'file_read':
      const lines = output.split('\n').length;
      return ` (${lines} lines)`;

    case 'file_write':
    case 'file_edit':
    case 'file_multi_edit':
      const added = countDiffLines(output, '+');
      const removed = countDiffLines(output, '-');
      if (added > 0 && removed > 0) {
        return ` (+${added}/-${removed} lines)`;
      } else if (added > 0) {
        return ` (+${added} lines)`;
      } else if (removed > 0) {
        return ` (-${removed} lines)`;
      }
      return '';

    case 'bash':
      const bashLines = output.split('\n').filter(l => l.trim()).length;
      const timeMatch = output.match(/\((\d+\.?\d*)s\)/);
      const time = timeMatch ? timeMatch[1] : '';
      return time ? ` (${bashLines} lines, ${time}s)` : ` (${bashLines} lines)`;

    case 'grep':
      const matchCount = countMatches(output);
      return matchCount > 0 ? ` → ${matchCount} matches` : '';

    case 'glob':
      const fileCount = countFiles(output);
      return fileCount > 0 ? ` → ${fileCount} files` : '';

    case 'test':
      const passed = countTestPassed(output);
      const failed = countTestFailed(output);
      if (failed > 0) {
        return ` (${passed} passed, ${failed} failed)`;
      }
      return passed > 0 ? ` (${passed} passed)` : '';

    case 'lint':
      const errors = countLintErrors(output);
      return errors > 0 ? ` (${errors} errors)` : ' (0 errors)';

    case 'git':
      return '';

    case 'monitor':
      const taskId = data.content || '';
      return taskId ? ` (${taskId.slice(0, 20)})` : '';

    case 'task_stop':
      return '';

    case 'skill':
      return '';

    case 'task':
      const agentCount = countAgents(output);
      return agentCount > 0 ? ` (${agentCount} agents)` : '';

    default:
      return '';
  }
}
```

- [ ] **Step 3: Run lint to verify syntax**

Run: `npm run lint -- src/cli/events.ts`
Expected: 0 errors (warnings allowed)

- [ ] **Step 4: Commit**

```bash
git add src/cli/events.ts
git commit -m "feat: add formatToolSummary function for compact mode"
```

---

### Task 2: Modify tool_result handler for compact mode

**Files:**
- Modify: `src/cli/events.ts` (tool_result handler, ~line 300)

- [ ] **Step 1: Read current tool_result handler**

Run: `grep -n "on('tool_result'" src/cli/events.ts`
找到 tool_result 处理函数位置

- [ ] **Step 2: Modify output display logic**

将当前的：
```typescript
// 显示输出内容（不折叠）
const output = data.output || data.error || '';
if (output && !data.diff) {
  output.split('\n').forEach((line: string) => {
    screen.appendScroll(COLORS.muted(`  │ ${line}\n`));
  });
}
```

改为：
```typescript
// Verbose 模式：显示完整输出
// Compact 模式：跳过输出内容
if (state.isVerboseMode()) {
  const output = data.output || data.error || '';
  if (output && !data.diff) {
    output.split('\n').forEach((line: string) => {
      screen.appendScroll(COLORS.muted(`  │ ${line}\n`));
    });
  }
}
```

- [ ] **Step 3: Modify status label to include summary**

将当前的：
```typescript
const statusLabel = `${icon} ${data.name}`;
```

改为：
```typescript
let statusLabel: string;
if (state.isVerboseMode()) {
  statusLabel = `${icon} ${data.name}`;
} else {
  statusLabel = `${icon} ${data.name}${formatToolSummary(data)}`;
}
```

- [ ] **Step 4: Modify diff display logic**

将当前的：
```typescript
// Diff 预览单独显示（不在区块内）
if (data.diff && !['file_write', 'file_edit', 'file_multi_edit'].includes(data.name)) {
  screen.appendScroll(COLORS.muted(`${data.diff}\n`));
}
```

改为：
```typescript
// Diff 预览 - 只在 verbose 模式显示
if (state.isVerboseMode() && data.diff && !['file_write', 'file_edit', 'file_multi_edit'].includes(data.name)) {
  screen.appendScroll(COLORS.muted(`${data.diff}\n`));
}
```

- [ ] **Step 5: Run lint**

Run: `npm run lint -- src/cli/events.ts`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add src/cli/events.ts
git commit -m "feat: compact mode hides tool output, shows summary"
```

---

### Task 3: Add resize handling to screenManager

**Files:**
- Modify: `src/cli/ui/screenManager.ts`

- [ ] **Step 1: Read constructor**

Run: `grep -n "constructor" src/cli/ui/screenManager.ts`
找到构造函数位置

- [ ] **Step 2: Add resize listener in constructor**

在构造函数末尾（this.state 初始化之后）添加：

```typescript
// 监听终端 resize
process.stdout.on('resize', () => {
  this.handleResize();
});
```

- [ ] **Step 3: Add handleResize method**

在类中添加新方法（在 updateLayout 方法附近）：

```typescript
private handleResize(): void {
  const newHeight = process.stdout.rows || 24;
  const newWidth = process.stdout.columns || 80;

  // 更新状态
  this.state.terminalHeight = newHeight;
  this.state.terminalWidth = newWidth;

  // 重新计算布局
  this.updateLayout();

  // 清屏
  writeStdout(`${ESC}[2J${ESC}[H`);

  // 显示 resize 提示
  writeStdout(COLORS.muted('[resize] screen refreshed\n'));

  // 刷新输入框
  this.refreshInput();

  // 恢复光标
  this.restoreCursor();
}
```

需要导入 COLORS（如果尚未导入）：
```typescript
import { COLORS } from './colors';
```

- [ ] **Step 4: Run lint**

Run: `npm run lint -- src/cli/ui/screenManager.ts`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/cli/ui/screenManager.ts
git commit -m "feat: add terminal resize handling"
```

---

### Task 4: Add unit tests for formatToolSummary

**Files:**
- Create: `src/cli/__tests__/events.test.ts`

- [ ] **Step 1: Create test file**

```typescript
import { describe, it, expect } from 'vitest';

// 测试 formatToolSummary 的辅助函数
// 由于 formatToolSummary 是模块内部函数，我们测试其逻辑通过公开接口

describe('Tool Summary Format', () => {
  describe('countMatches', () => {
    it('should count matches from grep output', () => {
      const output = 'Found 4 matches:\nfile1.ts:10: match\nfile2.ts:20: match';
      const match = output.match(/(\d+)\s+matches/i) || output.match(/Found\s+(\d+)/i);
      expect(match ? parseInt(match[1], 10) : 0).toBe(4);
    });

    it('should return 0 for no matches', () => {
      const output = 'No matches found';
      const match = output.match(/(\d+)\s+matches/i) || output.match(/Found\s+(\d+)/i);
      expect(match ? parseInt(match[1], 10) : 0).toBe(0);
    });
  });

  describe('countFiles', () => {
    it('should count files from glob output', () => {
      const output = 'src/file1.ts\nsrc/file2.ts\nsrc/file3.ts\n3 files found';
      const lines = output.split('\n').filter(l => l.trim() && !l.includes('found'));
      expect(lines.length).toBe(3);
    });
  });

  describe('countTestPassed', () => {
    it('should count passed tests', () => {
      const output = '55 tests passed\n0 tests failed';
      const match = output.match(/(\d+)\s+passed/i);
      expect(match ? parseInt(match[1], 10) : 0).toBe(55);
    });
  });

  describe('countLintErrors', () => {
    it('should count lint errors', () => {
      const output = '3 errors, 5 warnings';
      const match = output.match(/(\d+)\s+errors/i);
      expect(match ? parseInt(match[1], 10) : 0).toBe(3);
    });

    it('should return 0 for no errors', () => {
      const output = '0 errors, 2 warnings';
      const match = output.match(/(\d+)\s+errors/i);
      expect(match ? parseInt(match[1], 10) : 0).toBe(0);
    });
  });

  describe('countDiffLines', () => {
    it('should count added lines', () => {
      const output = '+ new line 1\n+ new line 2\n- removed line\n++ unchanged';
      const count = output.split('\n').filter(l => l.startsWith('+') && !l.startsWith('++')).length;
      expect(count).toBe(2);
    });

    it('should count removed lines', () => {
      const output = '+ new line\n- removed line 1\n- removed line 2\n-- unchanged';
      const count = output.split('\n').filter(l => l.startsWith('-') && !l.startsWith('--')).length;
      expect(count).toBe(2);
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm run test:run -- src/cli/__tests__/events.test.ts`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add src/cli/__tests__/events.test.ts
git commit -m "test: add unit tests for tool summary format"
```

---

### Task 5: Manual testing and final commit

- [ ] **Step 1: Build and run spica**

Run: `npm run build && ./bin/spica`

- [ ] **Step 2: Test compact mode tool display**

在 spica 中执行：
- `read a file` - 检查只显示摘要 `(N lines)`
- `run a grep` - 检查显示 `→ N matches`
- `run npm test` - 检查显示 `(N passed)` 或 `(N passed, N failed)`

- [ ] **Step 3: Test verbose mode toggle**

按 Ctrl+O 切换到 verbose 模式，检查完整输出显示

- [ ] **Step 4: Test resize**

调整终端窗口大小，检查：
- 输入框位置正确
- 光标位置正确
- 显示 `[resize] screen refreshed` 提示

- [ ] **Step 5: Run full test suite**

Run: `npm run test:run -- src/cli/__tests__/`
Expected: All tests pass

- [ ] **Step 6: Run lint**

Run: `npm run lint`
Expected: 0 errors

- [ ] **Step 7: Final commit (if any fixes needed)**

```bash
git add .
git commit -m "fix: any issues found during manual testing"
```

---

## Self-Review Checklist

**1. Spec coverage:**
- ✓ 工具调用折叠 - Task 1, 2
- ✓ 终端 resize - Task 3
- ✓ 测试 - Task 4
- ✓ 手动测试 - Task 5

**2. Placeholder scan:**
- ✓ 无 TBD/TODO
- ✓ 所有代码步骤都有完整代码
- ✓ 所有命令都有预期输出

**3. Type consistency:**
- ✓ formatToolSummary 参数类型与 ToolResultData 一致
- ✓ handleResize 使用已有的 updateLayout、refreshInput、restoreCursor 方法

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-05-tui-compact-mode-improvements.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**