# Spica Coding Agent 规格差距分析

基于现代Coding Agent设计方式与用户需求的调研，对比spica现有功能，识别改进点和新增功能需求。

---

## 一、现状总结

### Spica已有优势

| 功能 | 状态 | 说明 |
|------|------|------|
| **Skills系统** | ✅ 完善 | 14个内置技能（superpowers包），支持安装/卸载/自定义 |
| **Hooks系统** | ✅ 完善 | PreToolUse/PostToolUse拦截，支持none/warn/confirm/block |
| **工具系统** | ✅ 完善 | 28个内置工具，覆盖文件/Shell/Git/Web/测试等 |
| **MCP支持** | ✅ 完善 | 外部工具集成，stdio/SSE模式 |
| **Checkpoint系统** | ✅ 完善 | 文件快照，不污染git历史 |
| **并行子Agent** | ✅ 基础 | task工具支持最多3个并行 |
| **上下文压缩** | ✅ 基础 | 超过70%阈值自动压缩 |
| **项目持久化** | ✅ 完善 | .spica/目录存储session/tasks/learnings |
| **AGENTS.md** | ✅ 支持 | 项目上下文注入系统提示词 |
| **Learnings系统** | ✅ 创新 | .spica/learnings/从经验学习 |
| **安全检查** | ✅ 基础 | Shell注入检测，危险操作确认 |

### 与行业最佳实践的差距

| 维度 | 行业标准 | Spica现状 | 差距程度 |
|------|----------|-----------|----------|
| 上下文工程 | 分层预算、文件范围命令优化 | 基础压缩 | ⚠️ 中等 |
| 错误恢复 | 自动重试、策略调整 | 手动干预 | ⚠️ 高 |
| 计划模式 | Plan Mode先规划后执行 | 无 | ⚠️ 高 |
| 代码质量 | Code Health指标、自动检测 | 语法检查 | ⚠️ 中等 |
| 多项目支持 | 跨项目上下文 | 单项目会话 | ⚠️ 中等 |
| 持久记忆 | 跨会话记忆、全局+项目 | 项目级 | ⚠️ 低 |
| 规则系统 | 分层规则、可追溯标签 | AGENTS.md | ⚠️ 中等 |
| 并行可视化 | 分屏显示、独立box | 顺序显示 | ⚠️ 低 |
| Undo功能 | 原生撤销 | Git依赖 | ⚠️ 低 |

---

## 二、改进规格清单

### P0 - 关键缺失（影响核心体验）

#### 1. Plan Mode（计划模式）

**用户痛点来源：**
- Cursor Plan Mode：先研究代码库、询问澄清问题、创建详细计划、等待批准后执行
- 芝加哥大学研究：经验丰富的开发者更倾向于先规划后编码

**行业最佳实践：**
```
Plan Mode流程：
1. Research codebase → 找到相关文件
2. Ask clarifying questions → 确认需求
3. Create implementation plan → 文件路径+代码引用
4. Wait for approval → 用户编辑计划
5. Execute → 按计划构建
```

**Spica改进方案：**
```typescript
// 新增工具: plan_mode
{
  name: 'plan_mode',
  description: 'Enter plan mode: research, ask questions, create plan, wait for approval before executing',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Task description' },
      auto_approve: { type: 'boolean', description: 'Auto-approve after plan creation (default: false)' }
    }
  }
}

// 实现要点：
// 1. 禁止file_write/file_edit等修改工具
// 2. 只允许file_read/glob/grep/bash(非修改)
// 3. 生成.plan.md文件供用户编辑
// 4. 用户批准后切换到执行模式
```

**存储：**
```
.spica/plans/
├── 2026-06-04-feature-x.md    # 计划文档
└── approved.json              # 已批准计划列表
```

---

#### 2. 错误自动恢复

**用户痛点来源：**
- Claude Code Pain Points #7：陷入调试循环，重复相同错误修复
- 66%开发者花更多时间修复"几乎正确"的AI代码

**行业最佳实践：**
```typescript
// Claude Code做法：
// 1. Rate limit → 自动等待重试
// 2. Not found → 提供替代方案
// 3. Syntax error → 自动修复尝试
// 4. Test failure → 分析根因，调整策略
```

**Spica改进方案：**
```typescript
// src/agent.ts 添加 ErrorRecovery 模块

interface ErrorRecoveryStrategy {
  errorType: 'rate_limit' | 'not_found' | 'syntax' | 'test_failure' | 'timeout' | 'unknown';
  maxRetries: number;
  backoffMs: number;
  strategy: 'retry' | 'alternative' | 'ask_user' | 'abort';
}

const ERROR_STRATEGIES: Record<string, ErrorRecoveryStrategy> = {
  rate_limit: { errorType: 'rate_limit', maxRetries: 3, backoffMs: 60000, strategy: 'retry' },
  syntax: { errorType: 'syntax', maxRetries: 2, backoffMs: 0, strategy: 'alternative' },
  test_failure: { errorType: 'test_failure', maxRetries: 3, backoffMs: 1000, strategy: 'alternative' },
};

// 在 agent.ts 的 runLoop 中：
async function handleToolError(error: Error, toolName: string, args: Record<string, any>): Promise<void> {
  const strategy = matchErrorStrategy(error);
  
  if (strategy.strategy === 'retry' && retryCount < strategy.maxRetries) {
    emit('retry_attempt', { attempt: retryCount + 1, max: strategy.maxRetries });
    await sleep(strategy.backoffMs);
    return executeTool(toolName, args);  // 重试
  }
  
  if (strategy.strategy === 'alternative') {
    // 提供替代方案
    emit('error_suggestion', {
      error: error.message,
      suggestions: generateAlternatives(toolName, args, error)
    });
    return;  // 等待用户选择
  }
  
  if (strategy.strategy === 'ask_user') {
    await askUser(`Error: ${error.message}. How should I proceed?`);
  }
}
```

---

#### 3. 上下文工程优化

**用户痛点来源：**
- Anthropic: "Context is a critical but finite resource"
- Context rot：上下文增加时模型准确召回能力下降
- Token预算管理是核心能力

**行业最佳实践：**
```
Token预算分配（agentic-coding-rulebook）：
├── AGENTS.md: 1,500-2,500 tokens (10-15%)
├── 当前文件: 500-1,000 tokens (5-10%)
├── 相关文件: 2,000-3,000 tokens (15-20%)
├── 依赖项: 1,000-2,000 tokens (10%)
└── 输出缓冲: 10,000+ tokens (60%+)

文件范围命令优化（节省97%时间）：
- Type check单文件: 3秒 vs 项目: 2分钟
- Lint单文件: 1秒 vs 项目: 30秒
- Test单文件: 2秒 vs 项目: 4分钟
```

**Spica改进方案：**

1. **系统提示词优化**（src/prompts/system.ts）：
```typescript
// 添加文件范围命令指导
const FILE_SCOPE_GUIDANCE = `
## File-Scoped Commands (Preferred - Fast)

**Critical**: Always prefer file-scoped commands over project-wide. Token savings: 97%.

| Operation | File-Scoped | Project-Wide | Time Saved |
|-----------|-------------|--------------|------------|
| Type check | \`tsc --noEmit path/to/file.ts\` (3s) | \`npm run typecheck\` (2min) | 97% |
| Lint | \`eslint path/to/file.ts\` (1s) | \`npm run lint\` (30s) | 97% |
| Test | \`vitest run path/to/file.test.ts\` (2s) | \`npm run test\` (4min) | 98% |

**Project-Wide Commands (Use Sparingly - Ask First)**:
- \`npm run build\` (5min) - ASK BEFORE RUNNING
- \`npm run test\` (4min) - ASK BEFORE RUNNING
`;
```

2. **Token预算监控**（src/llm/TokenCounter.ts 增强）：
```typescript
interface TokenBudget {
  systemPrompt: number;      // 目标: 2,000-3,000
  projectContext: number;    // 目标: 1,500-2,500
  currentFile: number;       // 目标: 500-1,000
  relatedFiles: number;      // 目标: 2,000-3,000
  messageHistory: number;    // 动态
  outputBuffer: number;      // 目标: 10,000+
}

function checkTokenBudget(budget: TokenBudget): {
  status: 'ok' | 'warning' | 'critical';
  suggestions: string[];
} {
  // 检查各部分是否超出预算
  // 返回优化建议
}
```

---

### P1 - 重要改进（提升用户体验）

#### 4. 规则分层系统

**行业最佳实践：**
```markdown
## Critical Rules (Never Violate)
- All user inputs must be validated with Zod schemas
- Never commit secrets to repository
- All database queries use parameterized queries

## Important Rules (Follow Unless Justified)
- Prefer functional programming over OOP
- Components should be under 200 lines
- Test coverage minimum 80% for critical paths

## Preferences (Default Behavior)
- Use arrow functions for React components
- Prefer named exports over default exports
```

**Spica改进方案：**
```typescript
// AGENTS.md 解析增强
interface ParsedAgentsMd {
  criticalRules: string[];    // [CRITICAL] 标签
  importantRules: string[];   // [IMPORTANT] 标签
  preferences: string[];      // [PREF] 标签
}

// 在系统提示词中分层显示
function buildRulesSection(parsed: ParsedAgentsMd): string {
  return `
## Critical Rules (NEVER violate)
${parsed.criticalRules.map(r => `- ${r}`).join('\n')}

## Important Rules (Follow unless justified)
${parsed.importantRules.map(r => `- ${r}`).join('\n')}

## Preferences (Default behavior)
${parsed.preferences.map(r => `- ${r}`).join('\n')}
`;
}
```

---

#### 5. 规则可追溯性

**行业最佳实践：**
```markdown
## Core Principles
* **Simplicity First (SF):** Choose simplest solution
* **Readability Priority (RP):** Code must be immediately understandable
* **Security First (SecF):** Validate all inputs

// AI应用时引用：
[SF] Chose simple forEach over complex reduce
[SecF] Added input validation with Zod
```

**Spica改进方案：**
```typescript
// 工具结果中添加规则引用
interface ToolResult {
  // ...existing fields
  appliedRules?: string[];  // 如 ['SF', 'SecF']
}

// 在file_write/file_edit中检测规则应用
function detectAppliedRules(content: string, existingRules: string[]): string[] {
  // 检测是否应用了已知规则
  // 返回规则标签列表
}
```

---

#### 6. Code Health指标

**用户痛点来源：**
- CodeScene: "AI operates in a self-harm mode, often writing code it cannot reliably maintain"
- Code Health >= 9.5 时AI表现最佳

**行业最佳实践：**
```typescript
// CodeScene MCP工具：
- code_health_review: 每个代码片段生成时检查
- pre_commit_code_health_safeguard: 提交前检查
- analyze_change_set: PR前检查
```

**Spica改进方案：**
```typescript
// 新增工具: code_health
{
  name: 'code_health',
  description: 'Analyze code health score (maintainability, complexity, duplication). Target: >= 9.5',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File or directory to analyze' },
      threshold: { type: 'number', description: 'Minimum acceptable score (default: 9.5)' }
    }
  }
}

// 返回结果：
interface CodeHealthResult {
  score: number;           // 0-10
  issues: {
    type: 'complexity' | 'duplication' | 'coupling' | 'size';
    location: string;
    severity: 'low' | 'medium' | 'high';
    suggestion: string;
  }[];
  passed: boolean;         // score >= threshold
}
```

---

#### 7. 测试假通过检测

**用户痛点来源：**
- Claude Code Pain Points #8：写测试用mock代替真实验证，声称完成但实际未验证

**行业最佳实践：**
```markdown
// 检测模式：
1. 测试中只有mock调用，无真实业务逻辑验证
2. 测试断言只检查mock被调用，不检查结果
3. 测试覆盖率虚高但实际验证不足
```

**Spica改进方案：**
```typescript
// 新增工具: test_quality_check
{
  name: 'test_quality_check',
  description: 'Detect test anti-patterns: mock-only tests, false passes, coverage gaming',
  parameters: {
    type: 'object',
    properties: {
      testFile: { type: 'string', description: 'Test file to analyze' }
    }
  }
}

// 检测规则：
const TEST_ANTI_PATTERNS = [
  'mock-only-test',        // 只有mock，无真实验证
  'assertion-free',        // 无断言
  'coverage-gaming',       // 只为覆盖率写测试
  'always-passes',         // 测试永远通过
];
```

---

#### 8. 多项目支持

**用户痛点来源：**
- Coding Agent Frustrations：在一个会话中处理多个项目会导致混乱
- Agent假设当前工作目录是主项目

**行业最佳实践：**
```typescript
// Hierarchical Configuration (Monorepos)：
monorepo/
├── AGENTS.md              # Universal team standards
├── packages/
│   ├── frontend/
│   │   └── AGENTS.md      # Frontend-specific rules
│   ├── backend/
│   │   └── AGENTS.md      # Backend-specific rules
```

**Spica改进方案：**
```typescript
// workspace工具增强
interface WorkspaceInfo {
  path: string;
  name: string;
  agentsMd?: string;
  activeSkills?: string[];
  recentFiles?: string[];
}

// 新增命令: /workspace switch <path>
// 支持在会话中切换工作目录，加载对应的AGENTS.md

// 存储结构：
.spica/
├── workspaces.json        # 已注册工作区列表
└── sessions/
    └── <workspace-id>/    # 每个工作区独立会话
```

---

### P2 - 增强功能（提升竞争力）

#### 9. 分屏并行显示

**行业最佳实践：**
- Claude Code：多task时自动分屏，每个task独立box，完成后合并

**Spica改进方案：**
```typescript
// src/cli/ui/screenManager.ts 增强

interface ParallelDisplay {
  tasks: {
    id: string;
    box: Box;              // 独立显示区域
    status: 'running' | 'done' | 'error';
    output: string[];
  }[];
  layout: 'horizontal' | 'vertical' | 'grid';
}

// 事件监听：
eventBus.on('sub_agent_start', (data) => {
  // 创建新box
});

eventBus.on('sub_agent_done', (data) => {
  // 合并输出到主区域
});
```

---

#### 10. Undo功能

**用户痛点来源：**
- Claude Code Pain Points #6：缺少原生撤销，依赖Git回滚

**Spica改进方案：**
```typescript
// 新增命令: /undo [steps]
// 利用checkpoint系统实现撤销

interface UndoOperation {
  checkpointId: string;
  files: string[];
  timestamp: Date;
}

function undo(steps: number = 1): void {
  // 从checkpoints.json获取最近的checkpoint
  // 恢复文件快照
  // 更新消息历史（移除相关工具调用）
}
```

---

#### 11. 性能监控面板

**行业最佳实践：**
- Token使用统计
- 时间统计
- 成本估算

**Spica改进方案：**
```typescript
// 新增命令: /stats
// 显示当前会话统计

interface SessionStats {
  tokens: {
    input: number;
    output: number;
    total: number;
    cost: number;        // 基于provider定价
  };
  time: {
    total: number;       // 总时长
    llmWait: number;     // 等待LLM时间
    toolExec: number;    // 工具执行时间
  };
  tools: {
    calls: number;
    byType: Record<string, number>;
  };
  compression: {
    count: number;
    tokensSaved: number;
  };
}

// TUI显示：底部状态栏显示实时统计
```

---

#### 12. 长期运行循环（Hooks增强）

**行业最佳实践：**
```typescript
// Cursor hooks示例：
// 运行直到所有测试通过

{
  "hooks": {
    "stop": [{
      "command": "bun run .cursor/hooks/grind.ts"
    }]
  }
}

// grind.ts：
if (scratchpad.includes("DONE")) {
  // 完成，退出
} else {
  // 继续迭代
  return { followup_message: "Continue working..." };
}
```

**Spica改进方案：**
```typescript
// hooks/index.ts 增强

interface HookConfig {
  // ...existing
  loop?: {
    maxIterations: number;
    condition: 'tests_pass' | 'lint_clean' | 'custom';
    customCheck?: string;   // 自定义检查脚本
  };
}

// 支持stop hook返回followup_message继续循环
```

---

#### 13. 自动格式化

**行业最佳实践：**
- 编辑代码文件后自动运行format

**Spica改进方案：**
```typescript
// file_write/file_edit/file_multi_edit 后自动调用format

async function executeTool(name: string, args: Record<string, any>): Promise<ToolResult> {
  const result = await actualExecute(name, args);
  
  // 代码文件编辑后自动格式化
  if (['file_write', 'file_edit', 'file_multi_edit'].includes(name) && 
      isCodeFile(args.path)) {
    await executeTool('format', { path: args.path });
  }
  
  return result;
}
```

---

#### 14. 依赖变更检测

**用户痛点来源：**
- Claude Code Pain Points #6：忘记编译后再运行测试

**Spica改进方案：**
```typescript
// 新增工具: check_dependencies
{
  name: 'check_dependencies',
  description: 'Check if dependencies changed and need rebuild/reinstall',
  parameters: {
    type: 'object',
    properties: {
      since: { type: 'string', description: 'Check changes since this ref (default: last checkpoint)' }
    }
  }
}

// 检测：
// 1. package.json/package-lock.json变更 → npm install
// 2. tsconfig.json变更 → tsc --noEmit
// 3. go.mod变更 → go mod download
```

---

#### 15. 团队协作功能

**行业最佳实践：**
- 共享AGENTS.md到git
- 共享skills包
- 团队learnings

**Spica改进方案：**
```typescript
// 新增命令: /team

// /team sync - 同步团队规则
// 从团队仓库拉取最新的AGENTS.md模板和skills

// /team share-skill <name> - 分享skill到团队仓库
// /team share-learning <file> - 分享learning

// 存储结构：
.spica/
├── team/
│   ├── AGENTS-template.md   # 团队规则模板
│   ├── skills/              # 团队共享skills
│   └── learnings/           # 团队共享learnings
```

---

## 三、优先级排序

### 立即实施（P0）

| 功能 | 工作量 | 影响 | 实施顺序 |
|------|--------|------|----------|
| Plan Mode | 中 | 高 | 1 |
| 错误自动恢复 | 中 | 高 | 2 |
| 上下文工程优化 | 低 | 高 | 3 |

### 短期实施（P1）

| 功能 | 工作量 | 影响 | 实施顺序 |
|------|--------|------|----------|
| 规则分层系统 | 低 | 中 | 4 |
| Code Health指标 | 中 | 中 | 5 |
| 测试假通过检测 | 中 | 中 | 6 |
| 多项目支持 | 中 | 中 | 7 |
| 规则可追溯性 | 低 | 中 | 8 |

### 中期实施（P2）

| 功能 | 工作量 | 影响 | 实施顺序 |
|------|--------|------|----------|
| 分屏并行显示 | 高 | 低 | 9 |
| Undo功能 | 低 | 低 | 10 |
| 性能监控面板 | 中 | 低 | 11 |
| 长期运行循环 | 中 | 低 | 12 |
| 自动格式化 | 低 | 低 | 13 |
| 依赖变更检测 | 中 | 低 | 14 |
| 团队协作功能 | 高 | 低 | 15 |

---

## 四、实施路线图

### Phase 1: 核心体验（2周）

```
Week 1:
- Plan Mode工具实现
- 系统提示词优化（文件范围命令）
- Token预算监控

Week 2:
- 错误自动恢复模块
- 规则分层解析
- 规则可追溯性
```

### Phase 2: 代码质量（2周）

```
Week 3:
- Code Health工具（基础版）
- 测试假通过检测
- 自动格式化

Week 4:
- 依赖变更检测
- Undo功能
- 性能监控面板
```

### Phase 3: 高级功能（3周）

```
Week 5-6:
- 多项目支持
- 分屏并行显示
- 长期运行循环Hooks

Week 7:
- 团队协作功能
- Code Health工具（完整版）
```

---

## 五、快速改进清单（可立即实施）

以下改进无需大量代码修改，可快速实施：

### 1. 系统提示词增强（src/prompts/system.ts）

```typescript
// 添加以下内容到SYSTEM_PROMPT：

## File-Scoped Commands (Preferred)
Always prefer file-scoped commands over project-wide:
- Type check: `tsc --noEmit path/to/file.ts` (3s vs 2min)
- Lint: `eslint path/to/file.ts` (1s vs 30s)
- Test: `vitest run path/to/file.test.ts` (2s vs 4min)

## Rule Priority
When AGENTS.md contains rules, follow this priority:
1. [CRITICAL] - Never violate
2. [IMPORTANT] - Follow unless justified
3. [PREF] - Default behavior

## Error Recovery
When encountering errors:
1. Rate limit → Wait 60s, retry (max 3)
2. Syntax error → Analyze, suggest fix
3. Test failure → Trace root cause before fixing
4. Not found → Search alternatives, ask user
```

### 2. AGENTS.md模板更新

```markdown
# AGENTS.md Template (Enhanced)

## Project Overview
[Existing content]

## [CRITICAL] Security Rules
- Never commit secrets to repository
- All user inputs must be validated
- Use parameterized queries for database

## [IMPORTANT] Code Quality Rules
- Test coverage minimum 80% for critical paths
- Components under 200 lines
- Follow existing patterns in [reference file]

## [PREF] Style Preferences
- Use named exports over default exports
- Arrow functions for React components
- Absolute imports with @/ prefix

## File-Scoped Commands
- Type check: `npx tsc --noEmit <file>`
- Lint: `npx eslint <file>`
- Test: `npm run test -- <file>`

## Project-Wide Commands (Ask First)
- Build: `npm run build` (ASK)
- Full test: `npm run test` (ASK)
```

### 3. 新增快速工具

```typescript
// src/tools/index.ts 添加：

{
  name: 'undo',
  description: 'Undo last file operation using checkpoint',
  parameters: { type: 'object', properties: {} }
},

{
  name: 'stats',
  description: 'Show session statistics: tokens, time, tool calls',
  parameters: { type: 'object', properties: {} }
},

{
  name: 'plan',
  description: 'Create implementation plan before executing. Saves to .spica/plans/',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Task description' }
    },
    required: ['task']
  }
}
```

---

## 六、总结

Spica在Skills系统、Hooks系统、工具覆盖、Checkpoint等方面已经达到或超过行业标准。主要差距集中在：

1. **上下文工程** - 缺少精细的token预算管理和文件范围命令优化指导
2. **错误恢复** - 缺少自动重试和策略调整机制
3. **计划模式** - 缺少先规划后执行的工作流
4. **代码质量指标** - 缺少客观的Code Health衡量

建议优先实施P0级别的改进，这些改进对用户体验影响最大，且工作量适中。