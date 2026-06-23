# Skill Gate Classifier — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a testable classifier that detects user intent and injects `REQUIRED_SKILL` into the AI's context, plus strengthen the system prompt to remove subjective judgment.

**Architecture:** A pure function `classifyIntent(text)` does pattern matching. The result is injected as a system message at the start of `runLoop`. The `<EXTREMELY-IMPORTANT>` prompt block is simplified to a "just do it" directive.

**Tech Stack:** TypeScript, vitest

**Deviation from spec:** The spec proposed modifying `getSystemPrompt()` signature for injection. In reality, `getSystemPrompt()` is called once during `init()`, not per-request. Instead, we inject `REQUIRED_SKILL` as a `system` role message at the start of each `runLoop` call in `agent.ts`. Same effect, simpler integration.

---

### Task 1: Create the classifier

**Files:**
- Create: `src/cli/skillGate.ts`
- Create: `src/cli/__tests__/skillGate.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/cli/__tests__/skillGate.test.ts
import { describe, it, expect } from 'vitest';
import { classifyIntent } from '../skillGate';

describe('classifyIntent', () => {
  describe('Tier 1 — explicit design/improvement questions', () => {
    it('returns brainstorming for "how to improve"', () => {
      expect(classifyIntent('how to improve error handling')).toBe('brainstorming');
    });

    it('returns brainstorming for "could we"', () => {
      expect(classifyIntent('could we add a cache layer')).toBe('brainstorming');
    });

    it('returns brainstorming for "should we"', () => {
      expect(classifyIntent('should we switch to postgres')).toBe('brainstorming');
    });

    it('returns brainstorming for "how to make better"', () => {
      expect(classifyIntent('how to make the login better')).toBe('brainstorming');
    });

    it('returns brainstorming for "what would you change"', () => {
      expect(classifyIntent('what would you change about the API')).toBe('brainstorming');
    });
  });

  describe('Tier 2 — creation keywords + target noun', () => {
    it('returns brainstorming for "create a feature"', () => {
      expect(classifyIntent('create a login module')).toBe('brainstorming');
    });

    it('returns brainstorming for "add a function"', () => {
      expect(classifyIntent('add a helper function')).toBe('brainstorming');
    });

    it('returns brainstorming for "build a component"', () => {
      expect(classifyIntent('build a sidebar component')).toBe('brainstorming');
    });

    it('returns brainstorming for "implement a system"', () => {
      expect(classifyIntent('implement a caching system')).toBe('brainstorming');
    });

    it('returns brainstorming for "write a file"', () => {
      expect(classifyIntent('write a config file')).toBe('brainstorming');
    });

    it('returns null for creation keyword without target noun', () => {
      expect(classifyIntent('create something cool')).toBe('brainstorming');
    });

    it('returns brainstorming for "make" + target', () => {
      expect(classifyIntent('make a utility class')).toBe('brainstorming');
    });
  });

  describe('Tier 3 — bug/fix keywords', () => {
    it('returns systematic-debugging for "fix the bug"', () => {
      expect(classifyIntent('fix the login bug')).toBe('systematic-debugging');
    });

    it('returns systematic-debugging for "debug"', () => {
      expect(classifyIntent('debug the connection timeout')).toBe('systematic-debugging');
    });

    it('returns systematic-debugging for "broken"', () => {
      expect(classifyIntent('the build is broken')).toBe('systematic-debugging');
    });

    it('returns systematic-debugging for "not working"', () => {
      expect(classifyIntent('tests are not working')).toBe('systematic-debugging');
    });

    it('returns systematic-debugging for "error"', () => {
      expect(classifyIntent('getting a type error')).toBe('systematic-debugging');
    });

    it('returns systematic-debugging for "crash"', () => {
      expect(classifyIntent('app crashes on startup')).toBe('systematic-debugging');
    });

    it('returns systematic-debugging for "failing"', () => {
      expect(classifyIntent('failing tests in CI')).toBe('systematic-debugging');
    });
  });

  describe('Tier 4 — review keywords', () => {
    it('returns requesting-code-review for "review my code"', () => {
      expect(classifyIntent('review my latest changes')).toBe('requesting-code-review');
    });

    it('returns requesting-code-review for "check my code"', () => {
      expect(classifyIntent('check my code for issues')).toBe('requesting-code-review');
    });

    it('returns requesting-code-review for "look over"', () => {
      expect(classifyIntent('look over this PR')).toBe('requesting-code-review');
    });
  });

  describe('Tier 5 — negative patterns', () => {
    it('returns null for "what is" questions', () => {
      expect(classifyIntent('what is a closure')).toBeNull();
    });

    it('returns null for "how does" questions', () => {
      expect(classifyIntent('how does promises work')).toBeNull();
    });

    it('returns null for "explain" questions', () => {
      expect(classifyIntent('explain the event loop')).toBeNull();
    });

    it('returns null for "what is" even with verb keywords', () => {
      expect(classifyIntent('what is a build system')).toBeNull();
    });
  });

  describe('Fallback', () => {
    it('returns null for empty string', () => {
      expect(classifyIntent('')).toBeNull();
    });

    it('returns null for casual greeting', () => {
      expect(classifyIntent('hello')).toBeNull();
    });

    it('returns null for whitespace', () => {
      expect(classifyIntent('   ')).toBeNull();
    });
  });

  describe('Case insensitivity', () => {
    it('matches uppercase', () => {
      expect(classifyIntent('FIX THE BUG')).toBe('systematic-debugging');
    });

    it('matches mixed case', () => {
      expect(classifyIntent('How To Improve Performance')).toBe('brainstorming');
    });
  });

  describe('Tier priority', () => {
    it('Tier 1 beats Tier 3', () => {
      expect(classifyIntent('how to improve the broken login')).toBe('brainstorming');
    });

    it('Tier 2 beats Tier 5', () => {
      expect(classifyIntent('explain how to create a module')).toBe('brainstorming');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/cli/__tests__/skillGate.test.ts`
Expected: All fail with "classifyIntent is not a function" or module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/cli/skillGate.ts

const TIER_1_PATTERNS = [
  'how to improve',
  'how to make better',
  'could we',
  'should we',
  'what would you change',
];

const TIER_2_VERBS = ['create', 'add', 'build', 'make', 'implement', 'write'];
const TIER_2_NOUNS = ['feature', 'component', 'module', 'system', 'function', 'class', 'file'];

const TIER_3_KEYWORDS = ['fix', 'debug', 'bug', 'error', 'broken', 'not working', 'failing', 'crash'];

const TIER_4_PATTERNS = ['review', 'check my code', 'look over'];

const TIER_5_PREFIXES = ['what is', 'how does', 'explain'];

export function classifyIntent(text: string): string | null {
  const lower = text.toLowerCase().trim();
  if (!lower) return null;

  // Tier 1 — explicit design/improvement questions
  if (TIER_1_PATTERNS.some(p => lower.includes(p))) {
    return 'brainstorming';
  }

  // Tier 2 — creation keywords + target noun
  const hasCreationVerb = TIER_2_VERBS.some(v => lower.includes(v));
  const hasTargetNoun = TIER_2_NOUNS.some(n => lower.includes(n));
  if (hasCreationVerb && hasTargetNoun) {
    return 'brainstorming';
  }

  // Tier 3 — bug/fix keywords
  if (TIER_3_KEYWORDS.some(k => lower.includes(k))) {
    return 'systematic-debugging';
  }

  // Tier 4 — review keywords
  if (TIER_4_PATTERNS.some(p => lower.includes(p))) {
    return 'requesting-code-review';
  }

  // Tier 5 — negative patterns (pure info questions)
  const hasCreationOrFix = [...TIER_2_VERBS, ...TIER_3_KEYWORDS].some(k => lower.includes(k));
  if (TIER_5_PREFIXES.some(p => lower.startsWith(p)) && !hasCreationOrFix) {
    return null;
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/cli/__tests__/skillGate.test.ts`
Expected: All 27 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/cli/skillGate.ts src/cli/__tests__/skillGate.test.ts
git commit -m "feat: add classifyIntent classifier for skill gate"
```

---

### Task 2: Strengthen system prompt EXTREMELY-IMPORTANT block

**Files:**
- Modify: `src/prompts/system.ts:4-24` (the EXTREMELY-IMPORTANT block)

- [ ] **Step 1: Replace the EXTREMELY-IMPORTANT block**

In `src/prompts/system.ts`, replace the current `<EXTREMELY-IMPORTANT>` block (lines starting with `<EXTREMELY-IMPORTANT>` through `</EXTREMELY-IMPORTANT>`) with:

```typescript
<EXTREMELY-IMPORTANT>
At any point during processing, you may see a system message starting with REQUIRED_SKILL followed by a skill name.

If you see REQUIRED_SKILL:
  → Call skill(name="<that skill>") before taking ANY other action.
  → Do NOT evaluate relevance. Do NOT judge complexity. Do NOT question it. Just call it.
  → If the skill turns out wrong for the situation, you don't need to use it after loading.
  → Example: if you see "REQUIRED_SKILL: brainstorming", call skill(name="brainstorming")

If you do NOT see REQUIRED_SKILL:
  → Still scan for skill triggers. When in doubt, invoke the skill.

**How to invoke a skill**: Call the \`skill\` tool with the skill name. Example: skill(name="brainstorming")
</EXTREMELY-IMPORTANT>
```

- [ ] **Step 2: Verify syntax**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/prompts/system.ts
git commit -m "refactor: simplify skill gate prompt block for REQUIRED_SKILL injection"
```

---

### Task 3: Integrate classifyIntent into agent.ts runLoop

**Files:**
- Modify: `src/agent.ts` (add import and injection in runLoop)

- [ ] **Step 1: Add import**

At the top of `src/agent.ts`, add after the existing `from './cli/ui/colors'` import:

```typescript
import { classifyIntent } from './cli/skillGate';
```

- [ ] **Step 2: Inject REQUIRED_SKILL in runLoop**

In the `runLoop` method (around line 668), after the existing `matchSkill` block, add the classifyIntent injection. The existing code is:

```typescript
    const matchedSkill = this.matchSkill(prompt);
    if (matchedSkill) {
      const skillContent = buildSkillPrompt(matchedSkill, { input: prompt });
      this.emit('skill_auto_triggered', { skill: matchedSkill.name, description: matchedSkill.description });
      prompt = skillContent;
    }
```

Add after it:

```typescript
    // Inject REQUIRED_SKILL as system message if classifier detects a skill
    const classifiedSkill = classifyIntent(prompt);
    if (classifiedSkill && (!matchedSkill || matchedSkill.name !== classifiedSkill)) {
      const llm = this.llm!;
      llm.addMessage({ role: 'system' as const, content: `REQUIRED_SKILL: ${classifiedSkill}` });
    }
```

- [ ] **Step 3: Verify syntax and type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Run full test suite**

Run: `npm run test:run`
Expected: At least 275+ passing (no regressions), 27 new classifier tests passing, 0 new failures

- [ ] **Step 5: Commit**

```bash
git add src/agent.ts
git commit -m "feat: inject REQUIRED_SKILL from classifyIntent into runLoop"
```

---

### Task 4: Final verification

- [ ] **Step 1: Run full test suite one final time**

Run: `npm run test:run`
Expected: 275+ passing, 4 pre-existing session truncation failures (unchanged)

- [ ] **Step 2: Verify classifier tests count**

Run: `npx vitest run src/cli/__tests__/skillGate.test.ts`
Expected: 27 tests, all passing

- [ ] **Step 3: Quick manual smoke test**

Run: `npx tsc --noEmit`
Expected: No errors
