# TUI Compact Mode Improvements Design

## Overview

改进 spica TUI 的 compact 模式显示和终端 resize 处理。

## Goals

1. **工具调用折叠** - compact 模式下隐藏工具输出内容，只显示摘要
2. **终端 resize** - 窗口大小变化时自动调整布局

## Non-Goals

- Home/End 键支持（后续迭代）
- Ctrl+箭头跳词（后续迭代）
- 输入框行数限制（后续迭代）
- 状态栏增强（后续迭代）

---

## Part 1: 工具调用折叠

### Current Behavior

**Compact 模式（当前）：**
```
┌─ grep (pattern=compact) ────┐
  │ Found 4 matches:
  │ src/cli/events.ts:254: if (state.isVerboseMode()) {
  │ src/cli/events.ts:274: ...
  │ ...
└─ ✓ grep ───────────────────┘
```

**Verbose 模式（当前）：** 同上，完整显示输出

### Desired Behavior

**Compact 模式（改进后）：**
```
┌─ grep (pattern=compact) ────┐
└─ ✓ grep → 4 matches ───────┘
```

**Verbose 模式（保持不变）：**
```
┌─ grep (pattern=compact) ────┐
  │ Found 4 matches:
  │ src/cli/events.ts:254: ...
  │ ...
└─ ✓ grep ───────────────────┘
```

### Implementation

**改动文件：** `src/cli/events.ts`

**改动位置：** `on('tool_result', ...)` 处理函数

**改动逻辑：**

```typescript
on('tool_result', (data: ToolResultData) => {
  state.setStreamingOutput(false);
  screen.setStreaming(false);
  const icon = data.success ? '✓' : '✗';
  const colorFn = data.success ? COLORS.success : COLORS.error;

  // 显示语法错误（如果有）- 两种模式都显示
  if (data.syntaxErrors && data.syntaxErrors.length > 0) {
    screen.appendScroll(COLORS.error(`  ⚠ Syntax errors:\n`));
    data.syntaxErrors.forEach((err: string) => {
      screen.appendScroll(COLORS.error(`    ${err}\n`));
    });
  }

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

  // 结束边框 - compact 模式添加摘要
  let statusLabel: string;
  if (state.isVerboseMode()) {
    statusLabel = `${icon} ${data.name}`;
  } else {
    statusLabel = `${icon} ${data.name}${formatToolSummary(data)}`;
  }
  const boxWidth = Math.max(statusLabel.length + 4, 20);
  screen.appendScroll(colorFn(`└─ ${statusLabel} ${'─'.repeat(boxWidth - statusLabel.length - 4)}┘\n`));

  // Diff 预览 - 只在 verbose 模式显示
  if (state.isVerboseMode() && data.diff && ['file_write', 'file_edit', 'file_multi_edit'].includes(data.name)) {
    screen.appendScroll(COLORS.muted(`${data.diff}\n`));
  }

  screen.restoreCursor();
  screen.refreshInput();
});
```

### Summary Format Function

新增函数 `formatToolSummary(data: ToolResultData): string`

```typescript
function formatToolSummary(data: ToolResultData): string {
  if (!data.success) {
    // 失败时显示简短错误
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
      // 从 diff 或 output 解析行数变化
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
      // 从 output 解析行数和耗时
      const bashLines = output.split('\n').filter(l => l.trim()).length;
      const timeMatch = output.match(/\((\d+\.?\d*)s\)/);
      const time = timeMatch ? timeMatch[1] : '';
      return time ? ` (${bashLines} lines, ${time}s)` : ` (${bashLines} lines)`;

    case 'grep':
      const matchCount = countMatches(output);
      return ` → ${matchCount} matches`;

    case 'glob':
      const fileCount = countFiles(output);
      return ` → ${fileCount} files`;

    case 'test':
      const passed = countTestPassed(output);
      const failed = countTestFailed(output);
      if (failed > 0) {
        return ` (${passed} passed, ${failed} failed)`;
      }
      return ` (${passed} passed)`;

    case 'lint':
      const errors = countLintErrors(output);
      return errors > 0 ? ` (${errors} errors)` : ' (0 errors)';

    case 'git':
      // git action 从 arguments 获取，已在 tool_call 显示
      return '';

    case 'monitor':
      // task_id 在 content 字段
      const taskId = data.content || '';
      return taskId ? ` (${taskId.slice(0, 20)})` : '';

    case 'task_stop':
      return '';

    case 'skill':
      return '';

    case 'task':
      // 子 agent 数量
      const agentCount = countAgents(output);
      return ` (${agentCount} agents)`;

    default:
      return '';
  }
}
```

### Helper Functions

```typescript
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

---

## Part 2: 终端 Resize 处理

### Current Behavior

- `screenManager.ts` 在构造函数中获取终端尺寸
- resize 事件未监听
- 窗口大小变化后布局错乱

### Desired Behavior

- 监听 resize 事件
- 自动更新布局参数
- 刷新显示

### Implementation

**改动文件：** `src/cli/ui/screenManager.ts`

**改动位置：** 构造函数末尾

**改动逻辑：**

```typescript
constructor() {
  const height = process.stdout.rows || 24;
  const width = process.stdout.columns || 80;

  this.state = {
    inputBuffer: [''],
    cursorCol: 0,
    terminalHeight: height,
    terminalWidth: width,
    inputLines: 1,
    statusRow: height - 2,
    scrollBottom: height - 3,
    statusText: '',
    completer: null,
    shownCompletionList: false,
    lastCompletionLine: '',
    cursorInScrollArea: false,
    isStreaming: false,
    onVerboseToggle: undefined,
    pendingInputRefresh: false,
  };

  // 监听终端 resize
  process.stdout.on('resize', () => {
    this.handleResize();
  });
}

private handleResize(): void {
  const newHeight = process.stdout.rows || 24;
  const newWidth = process.stdout.columns || 80;

  // 更新状态
  this.state.terminalHeight = newHeight;
  this.state.terminalWidth = newWidth;

  // 重新计算布局
  this.updateLayout();

  // 清屏并重绘
  writeStdout(`${ESC}[2J${ESC}[H`);

  // 刷新输入框
  this.refreshInput();

  // 恢复光标
  this.restoreCursor();
}
```

**注意：** resize 时清屏重绘可能导致滚动区域内容丢失。考虑方案：

**方案 A：清屏重绘（简单）**
- resize 时清屏
- 滚动区域历史丢失
- 用户需要重新查看

**方案 B：保留历史（复杂）**
- 维护滚动区域内容缓冲
- resize 时重新输出历史内容
- 需要额外内存和逻辑

**推荐方案 A**，理由：
1. 实现简单
2. resize 是低频操作
3. 用户可以接受历史丢失
4. 避免内存占用

---

## Testing

### 工具调用折叠测试

手动测试：
1. 启动 spica
2. 执行 `file_read` - 检查 compact 模式只显示摘要
3. 按 Ctrl+O 切换 verbose - 检查完整输出显示
4. 执行 `bash` - 检查摘要包含行数和耗时
5. 执行 `grep` - 检查匹配数显示

### Resize 测试

手动测试：
1. 启动 spica
2. 输入一些内容
3. 调整终端窗口大小
4. 检查输入框位置正确
5. 检查光标位置正确

---

## Files Changed

| 文件 | 改动 |
|------|------|
| `src/cli/events.ts` | 添加 compact 模式逻辑、formatToolSummary 函数 |
| `src/cli/ui/screenManager.ts` | 添加 resize 监听、handleResize 方法 |

---

## Risks

1. **摘要解析失败** - output 格式变化可能导致摘要错误
   - 缓解：使用宽松的正则匹配，失败时显示空摘要

2. **resize 时历史丢失** - 用户可能困惑
   - 缓解：resize 后显示提示 `[resize] screen refreshed`

3. **性能影响** - resize 频繁触发可能导致闪烁
   - 缓解：添加 debounce（300ms）