# Skill Gate — Testable Classifier + Prompt Injection

**Date**: 2025-01-16
**Status**: approved
**Topic**: Prevent AI from skipping skill checks by adding a testable classifier that injects REQUIRED_SKILL into the system prompt

## Problem

The system prompt mandates skill invocation, but the AI sometimes skips it by self-rationalizing ("too simple," "just a question"). Pure prompt-based solutions cannot be tested — the only way to verify is manual observation in the next session.

Real example: User asked "How would you improve yourself?" — a design question. AI should have invoked `brainstorming` but answered directly.

## Solution

Two-component approach: a **testable code classifier** that pattern-matches user input to skill names, plus **simplified prompt injection** that removes AI judgment from the decision.

```
User message
      ↓
classifyIntent(text)  ←  unit-testable pure function
      ↓
  "brainstorming" | "systematic-debugging" | null
      ↓
injected into system prompt as REQUIRED_SKILL
      ↓
AI sees REQUIRED_SKILL and calls skill(name="...")
```

## Component 1: Classifier

**File**: `src/cli/skillGate.ts` (new)

**Signature**: `classifyIntent(text: string): string | null`

**Logic**: Five priority-ordered tiers, first match wins:

### Tier 1 — Explicit design/improvement questions
Matches if message contains: `"how to improve"`, `"how to make better"`, `"could we"`, `"should we"`, `"what would you change"`
→ `"brainstorming"`

### Tier 2 — Creation keywords + target noun
`"create"`/`"add"`/`"build"`/`"make"`/`"implement"`/`"write"` **AND** `"feature"`/`"component"`/`"module"`/`"system"`/`"function"`/`"class"`/`"file"`
→ `"brainstorming"`

### Tier 3 — Bug/fix keywords
`"fix"`/`"debug"`/`"bug"`/`"error"`/`"broken"`/`"not working"`/`"failing"`/`"crash"`
→ `"systematic-debugging"`

### Tier 4 — Review keywords
`"review"`/`"check my code"`/`"look over"`
→ `"requesting-code-review"`

### Tier 5 — Negative patterns (override)
Starts with `"what is"`/`"how does"`/`"explain"` **AND** contains no creation/fix keywords
→ `null`

### Fallback
No match → `null`

All matching is case-insensitive.

## Component 2: Prompt Injection

**File**: `src/prompts/system.ts` (edit)

### Function signature change

Add `classifiedSkill?: string | null` parameter to `getSystemPrompt()`:

```typescript
export function getSystemPrompt(
  projectConfig?: any,
  skillsMetadata?: string,
  usingSuperpowersContent?: string,
  classifiedSkill?: string | null  // NEW
): string
```

### Injection

When `classifiedSkill` is non-null, prepend to prompt:

```
REQUIRED_SKILL: brainstorming
```

### New EXTREMELY-IMPORTANT block

Replace current block with:

```
<EXTREMELY-IMPORTANT>
At the top of this system prompt, you may see REQUIRED_SKILL followed by a skill name.

If REQUIRED_SKILL is present:
  → Call skill(name="<that skill>") before taking ANY other action.
  → Do NOT evaluate relevance. Do NOT judge complexity. Just call it.
  → If the skill turns out wrong for the situation, you don't need to use it after loading.

If REQUIRED_SKILL is null or absent:
  → Still scan for skill triggers. When in doubt, invoke the skill.
</EXTREMELY-IMPORTANT>
```

## Component 3: Integration

**File**: `src/index.ts` (edit)

Before calling `getSystemPrompt()`, run classifier:

```typescript
const classifiedSkill = classifyIntent(userMessage);
const systemPrompt = getSystemPrompt(projectConfig, skillsMetadata, superpowersContent, classifiedSkill);
```

## Files Changed

| File | Action |
|------|--------|
| `src/cli/skillGate.ts` | **New** — `classifyIntent()` pure function |
| `src/cli/__tests__/skillGate.test.ts` | **New** — tier-by-tier unit tests |
| `src/prompts/system.ts` | **Edit** — add param, simplify EXTREMELY-IMPORTANT, inject REQUIRED_SKILL |
| `src/index.ts` | **Edit** — run classifier before prompt build |

## Testing

### Classifier tests (`skillGate.test.ts`)

| Test | Input | Expected |
|------|-------|----------|
| Tier 1 explicit improvement | `"how to improve error handling"` | `"brainstorming"` |
| Tier 1 "could we" | `"could we add a cache layer"` | `"brainstorming"` |
| Tier 2 create feature | `"create a login module"` | `"brainstorming"` |
| Tier 2 add function | `"add a helper function"` | `"brainstorming"` |
| Tier 3 fix bug | `"fix the login bug"` | `"systematic-debugging"` |
| Tier 3 broken | `"the build is broken"` | `"systematic-debugging"` |
| Tier 3 crash | `"app crashes on startup"` | `"systematic-debugging"` |
| Tier 4 review | `"review my latest changes"` | `"requesting-code-review"` |
| Tier 5 negative | `"what is a closure"` | `null` |
| Tier 5 negative | `"explain how promises work"` | `null` |
| Fallback | `"hello"` | `null` |
| Case insensitive | `"FIX THE BUG"` | `"systematic-debugging"` |
| Empty string | `""` | `null` |
| Mixed (Tier 1 wins) | `"how to improve the broken login"` | `"brainstorming"` |

### Prompt tests

Verify `getSystemPrompt()`:
- Includes `REQUIRED_SKILL: brainstorming` when `classifiedSkill = "brainstorming"`
- Does NOT include `REQUIRED_SKILL` when `classifiedSkill = null` or `undefined`

### Regression

Full test suite (`npm run test:run`) must remain at 275+ passing.

## Non-Goals

- No code-level enforcement/hard gate (user chose against)
- No changes to skill loading/invocation logic
- No changes to how skills work internally
- Classifier does NOT cover every possible phrasing — it catches common patterns; the prompt's "when in doubt" clause is the catch-all
