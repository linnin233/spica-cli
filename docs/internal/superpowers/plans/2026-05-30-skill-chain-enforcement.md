# Skill Chain Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans

**Goal:** When a loaded skill references another skill, the agent MUST invoke that skill.

**Architecture:** System prompt rule + skill tool returns referenced skill names + agent injects REQUIRED_SKILL.

**Tech Stack:** TypeScript, vitest

---

### Task 1: System prompt — Skill Chain Rule

**Files:** `src/prompts/system.ts`

- [ ] Step 1: In `<EXTREMELY-IMPORTANT>`, after REQUIRED_SKILL section, add:

```
SKILL CHAIN RULE: When a loaded skill references another skill by name (e.g., "Use superpowers:test-driven-development" or "invoke skill(name=\"xxx\")"), you MUST invoke skill(name="<that-skill>") before taking any other action. Loaded skill content is your operating procedure. Skipping a referenced step is violating the procedure.
```

- [ ] Step 2: `npm run test:run` — all pass
- [ ] Step 3: `git add src/prompts/system.ts && git commit -m "feat: add Skill Chain Rule to system prompt"`

---

### Task 2: Remove Chinese keywords from matchSkill

**Files:** `src/agent.ts:354-398`

- [ ] Step 1: Replace keywordMap values — remove all Chinese strings:

```
['调查','分析','优化','重构','新建','创建','添加','移除','删除','修改','更改'] → removed
['调试','修复','报错','出错','失败'] → removed
['测试','写测试','加测试'] → removed
['计划','规划','方案','设计'] → removed
['完成','验证','确认','检查'] → removed
['审查','代码审查','合并'] → removed
['反馈','建议','修改意见'] → removed
['功能','能力','技能','会什么','能做什么','你有什么'] → removed
['隔离','分支','工作区'] → removed
['执行计划','实现计划'] → removed
['多任务','并行','同时'] → removed
['完成开发','结束'] → removed
['并行','同时'] → removed
['自定义技能','创建技能','编写技能'] → removed
```

- [ ] Step 2: `npm run test:run` — all pass
- [ ] Step 3: `git add src/agent.ts && git commit -m "fix: remove all Chinese keywords from matchSkill"`

---

### Task 3: Skill tool returns referenced skills + agent injects REQUIRED_SKILL

**Files:** `src/tools/index.ts` (skill tool), `src/agent.ts` (after executeTool)

- [ ] Step 1: Write test `src/__tests__/skillChain.test.ts` with findSkillReferences

- [ ] Step 2: `npx vitest run src/__tests__/skillChain.test.ts` — 5 tests pass

- [ ] Step 3: Modify skill tool to return `referencedSkills`

- [ ] Step 4: Modify agent to inject REQUIRED_SKILL after skill tool returns

- [ ] Step 5: `npm run test:run` — all pass

- [ ] Step 6: Commit
