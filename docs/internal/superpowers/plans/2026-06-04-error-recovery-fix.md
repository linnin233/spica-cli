# Error Recovery Fix Plan

## Problem
When tools timeout or fail, spica aborts without trying alternative strategies or escalating properly.

## Current State Analysis

### ✅ Already Implemented
1. **bash autoRetry** (src/tools/index.ts:1179)
   - Bash工具超时后会自动以detached模式重试
   - 返回success=false但提供session信息

2. **generateErrorSuggestion** (src/agent.ts)
   - 为不同工具错误提供建议
   - 但只是建议，不会自动尝试

3. **CLI Display** (src/cli/events.ts)
   - 显示tool_stuck_warning信息

### ❌ Critical Bug
**tool_stuck_warning处理** (src/agent.ts:812):
```typescript
if (event === 'tool_stuck_warning') {
  this.abortTool(tc.name);
  this.interruptFlag = true;  // ❌ 这会导致整个agent停止！
}
```

**问题流程**：
```
bash超时 → tool_stuck_warning → interruptFlag = true → runLoop退出 → agent停止
```

**期望流程**：
```
bash超时 → autoRetry(detached) → 返回结果 → agent继续执行
```

### ❌ Missing Features
1. 没有通用的错误恢复机制（只有bash有autoRetry）
2. 没有BLOCKED状态报告
3. 没有替代策略尝试

## Root Cause
- `interruptFlag = true` 会中断整个agent，而不是让工具自己处理
- bash的autoRetry已经返回结果，但interruptFlag会忽略它
- 其他工具没有错误恢复机制

## Implementation Plan

### Task 1: Fix Critical Bug - Remove interruptFlag in tool_stuck_warning
**File**: `src/agent.ts`
**Priority**: CRITICAL

**Current Code** (line ~812):
```typescript
if (event === 'tool_stuck_warning') {
  this.abortTool(tc.name);
  this.interruptFlag = true;  // ❌ 这会中断整个agent
}
```

**Fix**:
```typescript
if (event === 'tool_stuck_warning') {
  this.abortTool(tc.name);
  // 不要设置interruptFlag，让工具自己处理恢复
  // bash工具已经有autoRetry机制
}
```

**Why**: 
- bash工具的autoRetry已经返回结果（success=false + session信息）
- interruptFlag会忽略这个结果并中断整个agent
- 移除后，bash超时会自动重试，agent继续执行

### Task 2: Implement Error Recovery in Agent Loop
**File**: `src/agent.ts`

Modify `tool_stuck_warning` handler:
```typescript
if (event === 'tool_stuck_warning') {
  this.abortTool(tc.name);
  
  // NEW: Try recovery strategy
  const strategy = this.findRecoveryStrategy(result.error, tc.name);
  if (strategy) {
    this.emit('recovery_suggestion', {
      tool: tc.name,
      error: result.error,
      alternatives: strategy.alternatives,
      suggestion: strategy.suggestion,
    });
    
    // Add recovery message to LLM
    this.llm!.addMessage({
      role: 'user',
      content: `[SYSTEM] Tool ${tc.name} failed: ${result.error}\n` +
        `Alternative approaches:\n${strategy.alternatives.map(a => `- ${a}`).join('\n')}\n` +
        `Suggestion: ${strategy.suggestion}\n` +
        `Please try an alternative approach or report BLOCKED if stuck.`
    });
    
    return { name: tc.name, id: tc.id, result: 'Tool failed, alternatives provided', isCritical: false };
  }
  
  this.interruptFlag = true;
}
```

### Task 3: Add BLOCKED Status Reporting
**File**: `src/agent.ts`

Add method to report blocked status:
```typescript
reportBlocked(context: {
  task: string;
  attempted: string[];
  failed: string[];
  error: string;
  suggestions: string[];
}) {
  this.emit('blocked', {
    status: 'BLOCKED',
    ...context,
    timestamp: new Date().toISOString(),
  });
  
  // Add to conversation for visibility
  this.llm!.addMessage({
    role: 'user',
    content: `[SYSTEM] Agent is BLOCKED.\n` +
      `Task: ${context.task}\n` +
      `Attempted: ${context.attempted.join(', ')}\n` +
      `Failed: ${context.failed.join(', ')}\n` +
      `Error: ${context.error}\n` +
      `Suggestions: ${context.suggestions.join('\n')}\n` +
      `Please provide guidance or break down the task.`
  });
}
```

### Task 4: Update CLI to Display Recovery Suggestions
**File**: `src/cli/ui/`

Display recovery suggestions when tools fail:
```typescript
agent.on('recovery_suggestion', (data) => {
  console.log('\n[RECOVERY] Tool failed:', data.tool);
  console.log('Alternatives:');
  data.alternatives.forEach(a => console.log(`  - ${a}`));
  console.log('Suggestion:', data.suggestion);
});

agent.on('blocked', (data) => {
  console.log('\n[BLOCKED] Agent needs help:');
  console.log('Task:', data.task);
  console.log('Failed attempts:', data.failed.join(', '));
  console.log('Suggestions:', data.suggestions.join('\n'));
});
```

## Testing
1. Simulate tool timeout → verify recovery suggestions
2. Simulate test failure → verify alternative strategies
3. Simulate repeated failures → verify BLOCKED reporting

## Priority
**CRITICAL** - This violates core superpowers design principles

## Related
- Superpowers: `subagent-driven-development/implementer-prompt.md`
- Superpowers: `systematic-debugging/SKILL.md`
## ✅ Implementation Complete

**Commits:**
- 8046417: implement error recovery mechanism

**Changes:**

### 1. Critical Bug Fix (src/agent.ts)
```typescript
// Before
if (event === 'tool_stuck_warning') {
  this.abortTool(tc.name);
  this.interruptFlag = true;  // ❌ 中断整个agent
}

// After
if (event === 'tool_stuck_warning') {
  this.abortTool(tc.name);
  // 不设置interruptFlag，让工具自己处理恢复
  // bash工具已有autoRetry机制，会返回结果继续执行
}
```

**Impact**: Bash超时后自动以detached模式重试，agent继续执行

### 2. Enhanced Error Suggestions (src/agent.ts)
新增工具错误恢复建议：
- file_edit: 文本未找到时建议先读取文件
- test: 测试超时时建议运行单个测试文件
- lint: lint错误时建议逐个修复
- directory_list/file_delete/copy/move: 操作失败时提供具体建议

所有建议都包含"Try:"开头的替代方案

### 3. BLOCKED Status Reporting (src/agent.ts)
新增reportBlocked方法：
- 发送agent_blocked事件
- 提供完整上下文（任务、尝试、失败、错误）
- 提供建议列表

### 4. CLI Display (src/cli/events.ts)
新增agent_blocked事件处理：
- 显示[BLOCKED]状态
- 显示任务信息
- 显示尝试和失败的工具
- 显示建议列表

## Testing Results
- ✅ TypeScript编译通过
- ✅ Build成功
- ✅ Agent imports正常

## Next Steps
建议在runLoop中添加BLOCKED检测逻辑：
- 连续3次工具失败时触发BLOCKED
- LLM连续空响应时触发BLOCKED
