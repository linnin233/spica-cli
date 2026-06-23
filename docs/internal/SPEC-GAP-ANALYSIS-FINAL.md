# Spica Coding Agent 规格差距分析（基于行业调研与实际代码）

## 一、行业调研关键发现

### 1. Token优化与上下文工程

**行业共识（多来源验证）：**

| 来源 | 关键观点 |
|------|----------|
| Token Optimisation 101 | "15-20条消息后开始新会话，第30条消息成本是第1条的31倍" |
| agentic-coding-rulebook | "文件范围命令节省97%时间：Type check 3秒 vs 2分钟" |
| Anthropic context engineering | "Context is a critical but finite resource，存在context rot" |

**用户痛点：**
- 上下文窗口耗尽后质量下降
- 不必要的全项目命令浪费tokens
- 长会话成本指数增长

**Spica现状：**
- ✅ 已有TokenCounter估算
- ✅ 已有多级预警（50%/60%/70%）
- ✅ 已有自动压缩
- ⚠️ **缺少：系统提示词中指导AI优先使用文件范围命令**

---

### 2. Code Health指标

**行业共识（Martin Fowler + Moderne + CodeScene）：**

| 指标 | 说明 | AI相关性 |
|------|------|----------|
| **Cyclomatic complexity** | 函数路径数，>10需重构 | AI在复杂函数中易出错 |
| **Cognitive complexity** | 考虑嵌套深度的可读性评分 | AI在深层嵌套中迷失 |
| **Nesting depth** | 最大嵌套层数，>3-4需提取 | AI难以理解深层逻辑 |
| **LCOM4** | 类内聚度，=3表示应拆成3个类 | AI在God Class中混乱 |
| **Parameter count** | 参数数量，>5表示接口问题 | AI倾向添加更多参数 |
| **File/Function length** | 文件/函数行数限制 | AI生成过长代码 |

**Martin Fowler特别指出：**
> "AI failure modes that are the most low-hanging fruit for static code analysis are: Max number of arguments, File length, Function length, Cyclomatic complexity"

**用户痛点：**
- AI生成的代码难以维护
- 复杂度累积导致后续修改困难
- 缺少客观质量标准

**Spica现状：**
- ✅ 已有语法检查（tsc/eslint等）
- ⚠️ **缺少：复杂度、嵌套、内聚度等可维护性指标**

---

### 3. 测试假通过检测

**行业共识（VibeDoctor + arXiv论文 + superpowers）：**

| 反模式 | 编号 | 说明 |
|--------|------|------|
| **Over-mocking** | TST-004 | Mock所有依赖，测试的是mock而非真实行为 |
| **Happy-path-only** | TST-005 | 只测试成功路径，忽略错误/边界情况 |
| **Assertion-free** | TST-008 | 无断言测试，永远通过 |
| **Incomplete mocks** | - | Mock缺少真实API的字段 |
| **Test-only methods** | - | 为测试添加生产代码中不需要的方法 |

**arXiv论文《Are Coding Agents Generating Over-Mocked Tests?》结论：**
- AI生成的测试倾向于过度mock
- 60%的生产bug发生在未测试的错误处理路径
- Happy-path测试团队的change failure rate是全面测试团队的2-3倍

**用户痛点：**
- AI写的测试看起来通过但实际未验证
- 覆盖率高但实际检测能力低
- 生产bug在测试中未被发现

**Spica现状：**
- ✅ 已有test工具运行测试
- ⚠️ **缺少：测试质量检测，识别反模式**

---

## 二、Spica已有功能确认（无需改进）

| 功能 | 实现位置 | 行业对比 |
|------|----------|----------|
| **错误自动恢复** | `callLLMWithRetry()` 10次重试+指数退避 | ✅ 达到行业标准 |
| **Checkpoint系统** | `checkpointManager.ts` 文件快照 | ✅ 达到行业标准 |
| **上下文压缩** | `compact()` 70%触发+LLM摘要 | ✅ 达到行业标准 |
| **AGENTS.md系统** | 直接注入原始内容 | ✅ 符合AGENTS.md标准 |
| **工具冲突检测** | `detectToolConflicts()` | ✅ 超过多数竞品 |
| **消息清理** | `cleanMessages()` | ✅ 达到行业标准 |
| **Skills系统** | 14个内置技能 | ✅ 超过多数竞品 |

---

## 三、确认需要改进的功能

### P0 - 立即改进（低成本高收益）

#### 1. 文件范围命令指导

**行业证据：**
- agentic-coding-rulebook明确列出时间节省数据
- Token Optimisation 101强调"lean context produces better results"

**改进方案：**
在`SYSTEM_PROMPT`中添加：

```typescript
## File-Scoped Commands (Preferred - Fast)

**Critical**: Always prefer file-scoped commands over project-wide.

| Operation | File-Scoped (Fast) | Project-Wide (Slow) |
|-----------|-------------------|--------------------|
| Type check | `npx tsc --noEmit <file>` (3s) | `npm run typecheck` (2min) |
| Lint | `npx eslint <file>` (1s) | `npm run lint` (30s) |
| Test | `npm run test -- <file>` (2s) | `npm run test` (4min) |

**Project-Wide Commands (Ask First)**:
- `npm run build` - ASK BEFORE RUNNING
- Full test suite - ASK BEFORE RUNNING
```

**工作量：** 低（仅修改系统提示词）

---

### P1 - 短期改进（中等成本高收益）

#### 2. Code Health指标

**行业证据：**
- Martin Fowler文章详细说明AI失败模式与静态分析的关系
- Moderne Prethink产品专门为此设计
- CodeScene的Code Health评分被广泛采用

**改进方案：**

新增`code_health`工具，检测：

```typescript
interface CodeHealthResult {
  score: number;           // 0-10，目标 >= 9.5
  issues: {
    type: 'complexity' | 'nesting' | 'length' | 'parameters' | 'cohesion';
    location: string;
    severity: 'low' | 'medium' | 'high';
    suggestion: string;
  }[];
}

// 检测规则（基于Martin Fowler建议的AI失败模式）
const RULES = {
  maxCyclomaticComplexity: 10,    // 函数复杂度上限
  maxNestingDepth: 4,             // 嵌套深度上限
  maxFunctionLength: 50,          // 函数行数上限
  maxFileLength: 200,             // 文件行数上限
  maxParameters: 5,               // 参数数量上限
};
```

**实现策略：**
- 使用现有AST解析器（TypeScript compiler API）
- 或集成eslint规则（max-lines, max-lines-per-function, complexity等）
- 返回结构化结果供AI理解

**工作量：** 中（需新增工具，但可复用现有基础设施）

---

#### 3. 测试假通过检测

**行业证据：**
- VibeDoctor详细列出反模式TST-004/005/008
- arXiv论文实证研究AI生成测试的问题
- superpowers项目有testing-anti-patterns.md参考

**改进方案：**

新增`test_quality_check`工具，检测：

```typescript
interface TestQualityResult {
  score: number;
  issues: {
    type: 'over-mocking' | 'happy-path-only' | 'assertion-free' | 'incomplete-mock';
    location: string;
    description: string;
    severity: 'high' | 'medium';
  }[];
}

// 检测规则
const DETECTION_RULES = {
  // Over-mocking: mock调用数 > 真实调用数
  overMockingThreshold: 0.7,  // 70%以上是mock
  
  // Happy-path-only: 只有成功断言，无错误断言
  needsErrorPathTests: true,
  
  // Assertion-free: 无expect/assert调用
  requiresAssertions: true,
};
```

**实现策略：**
- 解析测试文件AST
- 统计mock调用vs真实调用比例
- 检查断言数量和类型
- 参考superpowers/testing-anti-patterns.md的规则

**工作量：** 中（需新增工具，规则相对简单）

---

## 四、改进优先级确认

| 功能 | 优先级 | 行业证据强度 | 工作量 | 收益 |
|------|--------|--------------|--------|------|
| **文件范围命令指导** | P0 | 强（多来源） | 低 | 高 |
| **Code Health指标** | P1 | 强（Martin Fowler等） | 中 | 高 |
| **测试假通过检测** | P1 | 强（arXiv论文等） | 中 | 高 |

---

## 五、不需要改进的功能（确认）

| 功能 | 原因 |
|------|------|
| Plan Mode | 与superpowers工作流冲突，增加理解负担 |
| 规则分层 | AGENTS.md直接注入原始内容，符合行业标准 |
| Undo功能 | Checkpoint系统已完善 |
| 错误恢复 | 已有callLLMWithRetry完善实现 |
| 分屏显示 | TUI改进，未来考虑 |

---

## 六、实施建议

### 立即可实施（P0）

1. **修改`src/prompts/system.ts`**
   - 添加文件范围命令指导表格
   - 约10行代码修改

### 短期实施（P1）

2. **新增`src/tools/codeHealth.ts`**
   - 复用TypeScript compiler API或eslint
   - 约100-200行代码

3. **新增`src/tools/testQuality.ts`**
   - 解析测试文件AST
   - 参考superpowers规则
   - 约100-200行代码

---

## 七、总结

基于行业调研，确认需要改进的功能：

1. ✅ **文件范围命令指导** - 行业共识，低成本高收益
2. ✅ **Code Health指标** - Martin Fowler等权威推荐，解决AI失败模式
3. ✅ **测试假通过检测** - arXiv论文实证，解决AI测试质量问题

Spica在错误恢复、Checkpoint、上下文压缩等方面已达到或超过行业标准，无需改进。