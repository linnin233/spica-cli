# TUI界面全面审查报告

## 一、架构概述

### 核心组件

| 文件 | 功能 | 关键职责 |
|------|------|----------|
| `screenManager.ts` | 屏幕管理器 | ANSI滚动区域、光标管理、输入缓冲 |
| `input.ts` | 输入处理器 | Bracketed Paste Mode、Unicode支持 |
| `tuiInput.ts` | TUI输入包装 | 整合ScreenManager、处理中断 |
| `stringWidth.ts` | 字符宽度计算 | CJK/全角字符显示宽度 |
| `colors.ts` | ANSI配色方案 | 终端标准色、动画 |
| `events.ts` | Agent事件映射 | 输出显示、状态更新 |

### 布局结构

```
┌─────────────────────────────────────┐
│ 滚动区域 (lines 1 to N-3)           │  ← AI输出、工具调用
│ appendScroll() 写入这里             │
│ 自动滚动                            │
├─────────────────────────────────────┤  ← 状态行 (N-2)
│ Status: idle/busy | model | path    │
├─────────────────────────────────────┤  ← 分隔线
│ 输入框                              │  ← 固定底部 (N-1 to N)
│ > [用户输入]                        │
└─────────────────────────────────────┘
```

---

## 二、已修复的问题

### 1. 光标位置错乱 (commit 7a11e50)

**问题描述：**
- 流式输出后，光标可能停留在滚动区域（输出区域）
- 用户按键时，光标不在输入框，导致输入位置错误

**修复方案：**
```typescript
// handleAnsi(), handleTab(), handlePaste() 中添加：
if (this.state.cursorInScrollArea) {
  writeStdout(`${ESC}[?25l`);
  const inputStartRow = this.state.statusRow + 1;
  writeStdout(`${ESC}[${inputStartRow};1H`);
  this.state.cursorInScrollArea = false;
}
```

**状态：** ✅ 已修复

### 2. 全角字符宽度判断 (commit 7a11e50)

**问题描述：**
- `screenManager.ts` 使用 `isCJK()` 判断字符宽度
- 但全角ASCII字符（如全角数字、标点）未被识别为宽度2

**修复方案：**
```typescript
// 从 isCJK() 改为 isFullWidth()
// isFullWidth() 包含：
// - CJK字符 (U+4E00-9FFF等)
// - 全角ASCII (U+FF01-FF5E)
```

**状态：** ✅ 已修复

### 3. 流式输出时光标显示 (commit cc21667)

**问题描述：**
- 流式输出期间光标被隐藏
- 用户看不到输出进度

**修复方案：**
```typescript
appendScroll(text: string): void {
  // ...
  if (this.state.isStreaming) {
    writeStdout(`${ESC}[?25h`);  // 显示光标
  }
}
```

**状态：** ✅ 已修复

---

## 三、发现的严重Bug（已修复）

### 🔴 Bug #1: 工具卡住时无用户提示

**位置：** `src/tools/index.ts:1111-1116`

**问题描述：**
```typescript
let stuckWarningTimer: NodeJS.Timeout | null = setTimeout(() => {
  if (!stuckWarningSent) {
    stuckWarningSent = true;
    abortController.abort();  // ⚠️ 只abort，没有发送事件！
  }
}, stuckWarningMs);
```

**影响：**
- 当 bash 工具卡住超过 60秒时，timer 只 abort 了 controller
- **没有发送任何事件通知用户**
- `tool_stuck_warning` 事件在 execa 返回后才发送（第1153行）
- 如果 execa 因为 shell 模式不正确响应 cancel signal，永远不返回
- 用户看到 TUI 一动不动，完全不知道发生了什么
- **实际表现：卡住 5-6 分钟没有任何提示**

**修复方案：**
```typescript
let stuckWarningTimer: NodeJS.Timeout | null = setTimeout(() => {
  if (!stuckWarningSent) {
    stuckWarningSent = true;
    // CRITICAL FIX: 立即发送事件通知用户
    eventCallback?.('tool_stuck_warning', {
      tool: 'bash',
      command: actualCommand.slice(0, 50),
      timeout: stuckWarningMs / 1000,
      elapsedMs: stuckWarningMs,
      message: `Command stuck after ${stuckWarningMs / 1000}s, aborting...`
    });
    abortController.abort();
  }
}, stuckWarningMs);
```

**状态：** ✅ 已修复

---

## 四、当前潜在问题

### 1. 输入框多行处理风险

**位置：** `screenManager.ts:77-92` (calcInputLines)

**问题分析：**
```typescript
private calcInputLines(): number {
  const content = this.state.inputBuffer[0];
  const width = this.state.terminalWidth;

  const logicalLines = content.split('\n');
  let totalLines = 0;

  for (let i = 0; i < logicalLines.length; i++) {
    const line = logicalLines[i];
    const prefixWidth = i === 0 ? 2 : 0;
    const lineWidth = prefixWidth + this.getStringDisplayWidth(line);
    totalLines += Math.max(1, Math.ceil(lineWidth / width));
  }

  return totalLines;
}
```

**潜在风险：**
- 当输入内容超过终端高度时，输入框会占用大部分屏幕
- `scrollBottom` 会变得很小或负数
- 可能导致滚动区域无效

**建议改进：**
```typescript
// 添加最大输入框行数限制
private calcInputLines(): number {
  const MAX_INPUT_LINES = 5;  // 最多占用5行
  const calculated = ...;
  return Math.min(calculated, MAX_INPUT_LINES);
}
```

**严重程度：** 🟡 中等（边缘情况）

---

### 2. 状态栏刷新时机问题

**位置：** `events.ts:307-342` (tool_result)

**问题分析：**
```typescript
on('tool_result', (data: ToolResultData) => {
  state.setStreamingOutput(false);
  screen.setStreaming(false);
  // ... 输出内容 ...
  
  // 输出完成，恢复光标到输入框并刷新显示
  screen.restoreCursor();
  screen.refreshInput();
});
```

**潜在风险：**
- 每次tool_result都调用 `refreshInput()`
- 如果工具调用频繁，可能导致输入框闪烁
- `setStreaming(false)` 后立即刷新可能干扰后续输出

**建议改进：**
- 批量刷新：在一系列tool_result完成后统一刷新
- 或在agent事件循环结束时刷新

**严重程度：** 🟢 低（性能优化）

---

### 3. 粘贴处理缺少换行符处理

**位置：** `screenManager.ts:469-490` (handlePaste)

**问题分析：**
```typescript
handlePaste(data: string): void {
  const content = data.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '');
  const graphemes = content.match(/\P{M}\p{M}*/gu) || [];
  // ...
}
```

**潜在风险：**
- 粘贴内容包含换行符时，直接插入到inputBuffer[0]
- 但calcInputLines()依赖换行符分割逻辑行
- 多行粘贴可能导致光标位置计算错误

**建议改进：**
```typescript
handlePaste(data: string): void {
  // 确保光标在输入框...
  
  const content = data.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '');
  
  // 如果粘贴内容包含换行符，拆分处理
  if (content.includes('\n')) {
    const lines = content.split('\n');
    // 第一行插入当前位置
    // 后续行作为新逻辑行处理
    // 或提示用户确认多行粘贴
  }
}
```

**严重程度：** 🟡 中等

---

### 4. Grapheme Cluster处理不一致

**位置：** 多处使用 `match(/\P{M}\p{M}*/gu)`

**问题分析：**
```typescript
// screenManager.ts 使用：
const graphemes = rawContent.match(/\P{M}\p{M}*/gu) || [];

// input.ts 使用：
chars = [...state.buffer];  // 使用迭代器
```

**潜在风险：**
- 正则 `\P{M}\p{M}*` 和迭代器 `[...str]` 对某些Unicode字符处理不同
- Emoji组合字符可能被拆分

**建议改进：**
- 统一使用一个函数处理grapheme cluster
- 建议使用 `Intl.Segmenter` (现代浏览器/Node支持)

```typescript
// 推荐方案
function getGraphemes(str: string): string[] {
  if (Intl.Segmenter) {
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    return [...segmenter.segment(str)].map(s => s.segment);
  }
  // fallback
  return str.match(/\P{M}\p{M}*/gu) || [];
}
```

**严重程度：** 🟢 低（Emoji等复杂字符边缘情况）

---

### 5. 终端尺寸变化处理缺失

**位置：** `screenManager.ts` 构造函数

**问题分析：**
```typescript
constructor() {
  const height = process.stdout.rows || 24;
  const width = process.stdout.columns || 80;
  // ...
}
```

**潜在风险：**
- 终端窗口resize时，状态不更新
- 滚动区域边界可能失效
- 输入框可能溢出或显示错乱

**建议改进：**
```typescript
// 监听终端resize事件
process.stdout.on('resize', () => {
  this.state.terminalHeight = process.stdout.rows || 24;
  this.state.terminalWidth = process.stdout.columns || 80;
  this.updateLayout();
  this.refreshInput();
  this.restoreCursor();
});
```

**严重程度：** 🟡 中等

---

### 6. ANSI序列处理不完整

**位置：** `screenManager.ts:418-443` (handleAnsi)

**问题分析：**
```typescript
handleAnsi(seq: string): void {
  if (seq === `${ESC}[C`) {
    // 右箭头
  } else if (seq === `${ESC}[D`) {
    // 左箭头
  } else if (seq === `${ESC}[3~`) {
    // Delete键
  }
  // 缺少其他ANSI序列处理
}
```

**缺失的ANSI序列：**
- Home (`\x1b[H` 或 `\x1b[1~`)
- End (`\x1b[F` 或 `\x1b[4~`)
- Ctrl+箭头 (跳词)
- 上下箭头（历史导航，如果有）

**建议改进：**
```typescript
handleAnsi(seq: string): void {
  // 确保光标位置...

  const graphemes = line.match(/\P{M}\p{M}*/gu) || [];
  
  if (seq === `${ESC}[C`) {  // 右箭头
    if (this.state.cursorCol < graphemes.length) this.state.cursorCol++;
  } else if (seq === `${ESC}[D`) {  // 左箭头
    if (this.state.cursorCol > 0) this.state.cursorCol--;
  } else if (seq === `${ESC}[3~`) {  // Delete
    // ...
  } else if (seq === `${ESC}[H` || seq === `${ESC}[1~`) {  // Home
    this.state.cursorCol = 0;
  } else if (seq === `${ESC}[F` || seq === `${ESC}[4~`) {  // End
    this.state.cursorCol = graphemes.length;
  } else if (seq === `${ESC}[5~`) {  // PageUp (可选)
    // 跳到上一个逻辑行开头
  } else if (seq === `${ESC}[6~`) {  // PageDown (可选)
    // 跳到下一个逻辑行结尾
  }
  
  this.refreshInput();
  this.restoreCursor();
}
```

**严重程度：** 🟡 中等（用户体验）

---

## 四、测试覆盖情况

### 现有测试

| 测试文件 | 覆盖内容 | 状态 |
|----------|----------|------|
| `tuiPty.test.ts` | PTY自动化测试 | ✅ 14/14通过 |
| `fullwidth.test.ts` | 全角字符宽度 | ✅ 15/15通过 |
| `screenManagerFullwidth.test.ts` | ScreenManager全角 | ✅ 11/11通过 |

### 未覆盖的场景

| 场景 | 建议 |
|------|------|
| 终端resize | 添加resize事件测试 |
| 多行粘贴 | 添加换行符粘贴测试 |
| Home/End键 | 添加ANSI序列测试 |
| 输入框溢出 | 添加超长输入测试 |
| 流式输出中断 | 添加ESC中断测试 |
| 状态栏更新 | 添加agent状态变化测试 |

---

## 五、代码质量观察

### 优点

1. **ANSI滚动区域实现正确**
   - `\x1b[1;${scrollBottom}r` 正确设置滚动区域
   - 输入框固定在底部

2. **Unicode处理完善**
   - 使用grapheme cluster正则处理复杂字符
   - CJK和全角字符宽度计算正确

3. **流式输出状态管理**
   - `isStreaming` 标志防止输入刷新干扰
   - `pendingInputRefresh` 缓冲输入更新

4. **Bracketed Paste Mode**
   - 正确启用/禁用粘贴模式
   - 粘贴内容作为整体处理

### 可改进

1. **代码重复**
   - `handleAnsi()`, `handleTab()`, `handlePaste()` 中光标位置检查代码重复
   - 建议抽取为私有方法

```typescript
private ensureCursorInInputArea(): void {
  if (this.state.cursorInScrollArea) {
    writeStdout(`${ESC}[?25l`);
    const inputStartRow = this.state.statusRow + 1;
    writeStdout(`${ESC}[${inputStartRow};1H`);
    this.state.cursorInScrollArea = false;
  }
}
```

2. **类型定义分散**
   - `ScreenState` 在screenManager.ts
   - `InputState` 在input.ts
   - 建议统一到types文件

3. **单例模式隐藏依赖**
   - `getScreenManager()` 全局单例
   - 建议改为依赖注入或显式传递

---

## 六、总结

### 当前状态评估

| 维度 | 评分 | 说明 |
|------|------|------|
| **核心功能** | ⭐⭐⭐⭐⭐ | 滚动区域、输入处理正确 |
| **Unicode支持** | ⭐⭐⭐⭐ | Grapheme处理良好，有小改进空间 |
| **状态管理** | ⭐⭐⭐⭐ | 流式状态处理完善 |
| **用户体验** | ⭐⭐⭐ | 缺少Home/End等快捷键 |
| **代码质量** | ⭐⭐⭐⭐ | 结构清晰，有少量重复 |

### 建议优先级

| 改进项 | 优先级 | 工作量 | 影响 |
|--------|--------|--------|------|
| Home/End键支持 | P1 | 低 | 用户体验提升 |
| 终端resize处理 | P1 | 低 | 稳定性提升 |
| 多行粘贴处理 | P2 | 中 | 边缘情况修复 |
| 输入框行数限制 | P2 | 低 | 边缘情况防护 |
| 代码重构（去重复） | P3 | 低 | 可维护性 |

---

## 七、验证命令

```bash
# 运行现有测试
npm run test:run -- src/cli/ui/__tests__/

# 手动测试TUI
npm run dev

# 测试全角字符输入
# 输入: 你好世界 → 检查光标位置
# 输入: Hello世界 → 检查混合字符

# 测试粘贴
# 粘贴多行文本 → 检查是否正确处理

# 测试resize
# 调整终端窗口大小 → 检查布局是否自适应
```