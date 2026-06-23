# Spica Coding Agent 规格差距分析（基于实际代码调查）

## 一、实际代码调查结果

### 已有功能（比文档描述更完善）

#### 1. 错误自动恢复 ✅ 已完善

**实际实现（src/agent.ts）：**

```typescript
// callLLMWithRetry - 带重试的LLM调用
private async callLLMWithRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries: number = 10  // 最多重试10次
): Promise<T>

// 指数退避策略：2s, 4s, 8s, 16s, 32s, 64s, 120s...（最大120秒）
const delay = Math.min(2000 * Math.pow(2, attempt), 120000);

// isRetryableError - 判断错误是否可重试
private isRetryableError(error: unknown): boolean {
  // 不可重试：400, 401, 403, 404, invalid, unauthorized, permission
  // 可重试：ECONNREFUSED, ENOTFOUND, ETIMEDOUT, 429, 500, 502, 503
}

// isCriticalToolError - 判断工具错误是否关键
private isCriticalToolError(toolName: string, result): boolean

// generateErrorSuggestion - 生成错误建议
private generateErrorSuggestion(toolName: string, error: string, args): string
```

**事件系统：**
- `retry_attempt` - 重试尝试事件
- `error_suggestion` - 错误建议事件
- `agent_stopped_on_error` - 关键错误停止事件

**结论：错误自动恢复已经完善，无需改进。**

---

#### 2. Checkpoint系统 ✅ 已完善

**实际实现（src/storage/checkpointManager.ts）：**

```typescript
// createCheckpoint - 创建文件快照（不污染git）
export async function createCheckpoint(
  workspacePath: string,
  prompt: string
): Promise<CheckpointMeta | null>

// 只备份 git 追踪且有变更的文件（自动遵循 .gitignore）
async function getTrackedChangedFiles(workspacePath: string): Promise<string[]>

// restoreCheckpoint - 恢复文件
export async function restoreCheckpoint(
  workspacePath: string,
  checkpointId: string
): Promise<{ success: boolean; restoredFiles: string[]; error?: string }>

// listCheckpoints - 列出检查点
export async function listCheckpoints(workspacePath: string, limit?: number)

// cleanCheckpoints - 清理旧检查点（保留最近20个）
export async function cleanCheckpoints(workspacePath: string, keepCount: number = 20)
```

**存储结构：**
```
.spica/
├── checkpoints.json       # 检查点元数据
├── snapshots/
│   └── 2026-06-04T10:00/  # 按时间戳命名
│   │   ├── src/index.ts   # 文件快照
│   │   └── metadata.json  # 元数据
```

**结论：Checkpoint系统已完善，支持undo功能。**

---

#### 3. 上下文管理 ✅ 基础完善，需优化指导

**实际实现（src/agent.ts + src/llm/TokenCounter.ts）：**

```typescript
// TokenCounter - token估算
export class TokenCounter {
  private contextWindow: number = 128000;  // 可动态设置
  
  estimateTokens(text: string): number     // 估算tokens
  estimateMessages(messages): number       // 估算消息tokens
  canFitInContext(messages, responseTokens): boolean
  getRemainingTokens(messages, responseTokens): number
}

// 多级预警机制（runLoop中）
if (usagePercent >= 50 && usagePercent < 60) {
  emit('context_warning', { level: 'info', ... });
} else if (usagePercent >= 60 && usagePercent < 70) {
  emit('context_warning', { level: 'warning', ... });
}

// compact - 自动压缩（70%阈值触发）
public async compact(): Promise<void> {
  const targetTokens = Math.floor(provider.getContextWindow() * 0.3);
  await this.compactToTarget(targetTokens);
}

// generateSummary - LLM生成摘要
private async generateSummary(messages: ChatMessage[]): Promise<ChatMessage>
```

**已有功能：**
- Token估算（支持CJK、代码、普通文本不同算法）
- 多级预警（50%, 60%, 70%）
- 自动压缩（70%触发）
- LLM生成摘要
- 自适应保留消息数量

**缺少：**
- 文件范围命令优化指导（在系统提示词中告诉AI优先使用单文件命令）

---

#### 4. AGENTS.md系统 ✅ 已完善

**实际实现（src/utils/projectConfig.ts + src/prompts/system.ts）：**

```typescript
// loadProjectConfig - 加载AGENTS.md原始内容
export function loadProjectConfig(workspace: string): ProjectConfig | null {
  const content = fs.readFileSync(filepath, 'utf-8');
  return { rawContent: content };  // 直接注入系统提示词
}

// getSystemPrompt - 系统提示词构建
export function getSystemPrompt(projectConfig, skillsMetadata, workspacePath): string {
  // 直接注入 AGENTS.md 原始内容
  if (projectConfig.rawContent) {
    prompt += '\n\n## Project Guidelines (from AGENTS.md)\n' + projectConfig.rawContent;
  }
  
  // 加载 .spica/learnings/
  prompt += loadLearnings(workspacePath);
  
  // 加载 skills 元数据
  prompt += buildSkillsSection(skillsMetadata);
}
```

**结论：AGENTS.md系统已完善，直接注入原始内容，无需规则分层。**

---

#### 5. 工具系统 ✅ 已完善

**实际实现（src/tools/index.ts）：**

- 28个内置工具
- 自动语法检查（file_write, file_edit, file_multi_edit, file_patch, file_replace）
- diff预览（emit `diff_preview`）
- 工具冲突检测（`detectToolConflicts`）
- 并行/顺序执行分离
- MCP工具集成

**工具冲突检测：**
```typescript
function detectToolConflicts(toolCalls): {
  parallel: Array<...>;     // 无冲突，可并行
  sequential: Array<...>;   // 有冲突，需顺序执行
  conflicts: Array<{ path: string; tools: string[] }>;
}
```

---

#### 6. Skills系统 ✅ 已完善

**实际实现（src/skills/index.ts）：**

- 14个内置技能（superpowers包）
- `skill` 工具调用
- `using-superpowers` bootstrap skill（自动注入系统提示词）
- 支持安装/卸载/自定义
- YAML frontmatter解析

---

#### 7. 消息清理 ✅ 已完善

**实际实现（src/utils/messageCleaner.ts）：**

```typescript
export function cleanMessages(messages: ChatMessage[], debug = false): ChatMessage[] {
  // 1. 移除空assistant消息（无content且无toolCalls）
  // 2. 去重连续重复的user消息
  // 3. 去重重复的tool消息
  // 4. 确保assistant-tool配对正确
}
```

---

### 真正缺少的功能

#### 1. 文件范围命令优化指导 ⚠️ 需改进

**现状：** 系统提示词中没有指导AI优先使用文件范围命令

**行业最佳实践：**
```
文件范围命令 vs 项目范围命令：
- Type check单文件: 3秒 vs 项目: 2分钟（节省97%）
- Lint单文件: 1秒 vs 项目: 30秒（节省97%）
- Test单文件: 2秒 vs 项目: 4分钟（节省98%）
```

**改进方案：** 在系统提示词中添加指导

---

#### 2. Code Health指标 ⚠️ 需新增

**现状：** 只有语法检查，缺少代码质量指标

**需要：**
- 复杂度检测
- 重复代码检测
- 耦合度检测
- 可维护性评分

---

#### 3. 测试假通过检测 ⚠️ 需新增

**现状：** 无检测机制

**需要检测：**
- mock-only测试（只有mock，无真实验证）
- 无断言测试
- 覆盖率虚高测试
- 永远通过的测试

---

## 二、改进规格清单（精简版）

### P0 - 立即改进

| 功能 | 现状 | 改进方案 | 工作量 |
|------|------|----------|--------|
| **文件范围命令指导** | 无 | 系统提示词添加指导 | 低 |

### P1 - 短期改进

| 功能 | 现状 | 改进方案 | 工作量 |
|------|------|----------|--------|
| **Code Health指标** | 仅语法检查 | 新增工具 `code_health` | 中 |
| **测试假通过检测** | 无 | 新增工具 `test_quality_check` | 中 |

### P2 - 未来考虑

| 功能 | 说明 |
|------|------|
| 分屏并行显示 | TUI改进，未来慢慢做 |
| 多项目支持 | 已有workspace切换，可扩展 |

---

## 三、具体改进方案

### 1. 文件范围命令指导（立即实施）

**修改 src/prompts/system.ts：**

```typescript
export const SYSTEM_PROMPT = `You are spica, a coding agent CLI. You edit files, run commands, and help developers.

Before acting, read the project context below. It tells you how to work on this project.

Available tools: file_read/write/edit, bash, git, glob/grep, web_search/fetch, test, lint, skill.
- skill(name): Load a skill's full instructions. Call this when a skill matches your task, then follow its guidance.

## File-Scoped Commands (Preferred - Fast)

**Critical**: Always prefer file-scoped commands over project-wide. Token savings: 97%.

| Operation | File-Scoped (Fast) | Project-Wide (Slow) | Time Saved |
|-----------|-------------------|--------------------|------------|
| Type check | \`npx tsc --noEmit <file>\` (3s) | \`npm run typecheck\` (2min) | 97% |
| Lint | \`npx eslint <file>\` (1s) | \`npm run lint\` (30s) | 97% |
| Test | \`npm run test -- <file>\` (2s) | \`npm run test\` (4min) | 98% |

**Project-Wide Commands (Ask First)**:
- \`npm run build\` (5min) - ASK BEFORE RUNNING
- \`npm run test\` (full suite) - ASK BEFORE RUNNING

Ask before: rm -rf, sudo, git push --force, git reset --hard.
Output: plain text, file:line for refs, no trailing summaries.
`;
```

---

### 2. Code Health指标（新增工具）

**新增 src/tools/codeHealth.ts：**

```typescript
export interface CodeHealthResult {
  score: number;           // 0-10，目标 >= 9.5
  issues: {
    type: 'complexity' | 'duplication' | 'coupling' | 'size' | 'maintainability';
    location: string;      // 文件:行号
    severity: 'low' | 'medium' | 'high';
    suggestion: string;
  }[];
  passed: boolean;         // score >= threshold
}

// 检测规则：
const COMPLEXITY_THRESHOLD = 10;  // 函数圈复杂度上限
const DUPLICATION_THRESHOLD = 50; // 重复代码块最小行数
const SIZE_THRESHOLD = 200;       // 文件行数上限
const COUPLING_THRESHOLD = 5;     // 依赖数量上限
```

**工具定义：**
```typescript
{
  name: 'code_health',
  description: 'Analyze code health score (maintainability, complexity, duplication). Target: >= 9.5 for AI-friendly code.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File or directory to analyze' },
      threshold: { type: 'number', description: 'Minimum acceptable score (default: 9.5)' }
    },
    required: ['path']
  }
}
```

---

### 3. 测试假通过检测（新增工具）

**新增 src/tools/testQuality.ts：**

```typescript
export interface TestQualityResult {
  score: number;           // 0-10
  issues: {
    type: 'mock-only' | 'assertion-free' | 'coverage-gaming' | 'always-passes' | 'fake-assertion';
    location: string;      // 测试文件:行号
    description: string;
    severity: 'low' | 'medium' | 'high';
  }[];
  passed: boolean;
}

// 检测规则：
const TEST_ANTI_PATTERNS = [
  // mock-only: 测试中只有mock调用，无真实业务逻辑验证
  'mock-only-test',
  
  // assertion-free: 无断言或断言只检查mock被调用
  'assertion-free',
  
  // coverage-gaming: 只为覆盖率写测试，不验证行为
  'coverage-gaming',
  
  // always-passes: 测试永远通过（如 expect(true).toBe(true)）
  'always-passes',
  
  // fake-assertion: 断言检查的是mock返回值而非真实结果
  'fake-assertion',
];
```

**工具定义：**
```typescript
{
  name: 'test_quality_check',
  description: 'Detect test anti-patterns: mock-only tests, false passes, coverage gaming. Use after writing tests.',
  parameters: {
    type: 'object',
    properties: {
      testFile: { type: 'string', description: 'Test file to analyze' },
      sourceFile: { type: 'string', description: 'Source file being tested (optional)' }
    },
    required: ['testFile']
  }
}
```

---

## 四、总结

### Spica已有完善功能（无需改进）

| 功能 | 实现位置 | 状态 |
|------|----------|------|
| 错误自动恢复 | src/agent.ts | ✅ 完善 |
| Checkpoint系统 | src/storage/checkpointManager.ts | ✅ 完善 |
| 上下文压缩 | src/agent.ts (compact) | ✅ 基础完善 |
| AGENTS.md系统 | src/utils/projectConfig.ts | ✅ 完善 |
| 工具系统 | src/tools/index.ts | ✅ 完善 |
| Skills系统 | src/skills/index.ts | ✅ 完善 |
| 消息清理 | src/utils/messageCleaner.ts | ✅ 完善 |
| 并行子Agent | src/tools/subAgent.ts | ✅ 完善 |

### 需要改进的功能

| 功能 | 优先级 | 工作量 | 说明 |
|------|--------|--------|------|
| 文件范围命令指导 | P0 | 低 | 系统提示词添加 |
| Code Health指标 | P1 | 中 | 新增工具 |
| 测试假通过检测 | P1 | 中 | 新增工具 |

### 不需要的功能

| 功能 | 原因 |
|------|------|
| Plan Mode | 与superpowers工作流冲突，增加理解负担 |
| 规则分层 | AGENTS.md直接注入原始内容，已足够 |
| Undo功能 | Checkpoint系统已完善 |
| 错误恢复 | 已有callLLMWithRetry完善实现 |