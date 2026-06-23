# Prompt Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify spica's prompt pipeline: replace command-and-control SYSTEM_PROMPT with minimal prose, shorten init prompt, stop injecting full skill content into system prompt, remove redundant per-message projectContext.

**Architecture:** Three targeted edits to `src/prompts/system.ts`, `src/index.ts`, and `src/agent.ts`. No new files. No test changes needed (no tests reference the removed content).

**Tech Stack:** TypeScript, Node.js

---

### Task 1: Simplify SYSTEM_PROMPT

**Files:**
- Modify: `src/prompts/system.ts:7-45`

- [ ] **Step 1: Replace SYSTEM_PROMPT constant**

Replace the current SYSTEM_PROMPT (lines 7-45, from `export const SYSTEM_PROMPT` through the closing backtick before `buildSkillsSection`) with:

```typescript
export const SYSTEM_PROMPT = `You are spica, a coding agent CLI. You edit files, run commands, and help developers.

Before acting, read the project context below. It tells you how to work on this project.

Available tools: file_read/write/edit, bash, git, glob/grep, web_search/fetch, test, lint.
Ask before: rm -rf, sudo, git push --force, git reset --hard.
Output: plain text, file:line for refs, no trailing summaries.
`;
```

- [ ] **Step 2: Verify type check and build**

```bash
npx tsc --noEmit && npm run build
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/prompts/system.ts
git commit -m "refactor: simplify SYSTEM_PROMPT to minimal prose"
```

---

### Task 2: Simplify init prompt

**Files:**
- Modify: `src/index.ts` (the init prompt block near line 540)

- [ ] **Step 1: Read exact init prompt lines for precise replacement**

Read `src/index.ts` from the `// Init - 让AI分析代码库并创建 AGENTS.md` comment through the closing backtick of `initPrompt`.

- [ ] **Step 2: Replace init prompt**

Replace the entire init prompt string with:

```typescript
const initPrompt = `Analyze this project and create AGENTS.md. Reference https://agents.md/ for the standard.

What to include: how to build, how to test, code conventions, PR workflow.
Verify every command by running it. Don't guess. Be specific to this project.

If AGENTS.md already exists, preserve valuable content and supplement updates.`;
```

- [ ] **Step 3: Verify type check and build**

```bash
npx tsc --noEmit && npm run build
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "refactor: simplify init prompt to minimal prose"
```

---

### Task 3: Stop injecting full skill content into system prompt

**Files:**
- Modify: `src/agent.ts` (initialize method, ~lines 686-692)
- Modify: `src/prompts/system.ts` (getSystemPrompt signature and body)

- [ ] **Step 1: Remove superpowersContent from getSystemPrompt call in agent.ts**

In `src/agent.ts`, `initialize()` method. Remove these lines:

```typescript
const superpowersSkill = skills.find(s => s.name === 'using-superpowers');
const superpowersContent = superpowersSkill?.promptTemplate || '';
```

And change the setSystemPrompt call from:

```typescript
this.llm.setSystemPrompt(getSystemPrompt(this.projectConfig, skillsMetadata, superpowersContent, this.workspacePath));
```

To:

```typescript
this.llm.setSystemPrompt(getSystemPrompt(this.projectConfig, skillsMetadata, this.workspacePath));
```

- [ ] **Step 2: Remove usingSuperpowersContent parameter from getSystemPrompt**

In `src/prompts/system.ts`, change the `getSystemPrompt` function signature from:

```typescript
export function getSystemPrompt(projectConfig?: any, skillsMetadata?: string, usingSuperpowersContent?: string, workspacePath?: string): string {
```

To:

```typescript
export function getSystemPrompt(projectConfig?: any, skillsMetadata?: string, workspacePath?: string): string {
```

And remove the using-superpowers injection block:

```typescript
// Using-superpowers core content injected at session start
if (usingSuperpowersContent) {
  prompt += '\n\n' + usingSuperpowersContent;
}
```

- [ ] **Step 3: Verify type check and build**

```bash
npx tsc --noEmit && npm run build
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/agent.ts src/prompts/system.ts
git commit -m "refactor: stop injecting full skill content into system prompt"
```

---

### Task 4: Remove redundant projectContext from runLoop

**Files:**
- Modify: `src/agent.ts` (runLoop method, ~lines 825-835)

- [ ] **Step 1: Remove projectContext construction and append**

In `src/agent.ts`, `runLoop()` method. Remove these lines:

```typescript
// Simplified project context (减少token)
const projectContext = this.projectConfig.type
  ? `Project: ${this.projectConfig.type}, Build: ${this.projectConfig.commands?.build || 'N/A'}, Test: ${this.projectConfig.commands?.test || 'N/A'}`
  : '';
```

And change the generate call from:

```typescript
response = await this.callLLMWithRetry(
  () => this.llm!.generate(prompt + (projectContext ? `\n${projectContext}` : ''), toolDefinitions),
  'llm_generate'
);
```

To:

```typescript
response = await this.callLLMWithRetry(
  () => this.llm!.generate(prompt, toolDefinitions),
  'llm_generate'
);
```

- [ ] **Step 2: Verify type check and build**

```bash
npx tsc --noEmit && npm run build
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/agent.ts
git commit -m "refactor: remove redundant per-message projectContext append"
```

---

### Task 5: Full test suite verification

**Files:** None (verification only)

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run src/__tests__/
```

Expected: 25 test files pass, 182 tests pass (the one pre-existing flaky test may fail — format tool spaces timeout — this is unrelated).

- [ ] **Step 2: Run targeted tests for changed modules**

```bash
npx vitest run src/__tests__/agent.test.ts src/__tests__/state/
```

Expected: all pass.

- [ ] **Step 3: Final build verification**

```bash
npm run build && ./bin/spica --version
```

Expected: builds successfully, outputs version.
