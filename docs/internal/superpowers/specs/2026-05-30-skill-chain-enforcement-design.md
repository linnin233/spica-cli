# Skill Chain Enforcement Design

> **Goal:** When a loaded skill references another skill, the agent MUST invoke that skill before proceeding. No more skipping.

## Problem

`systematic-debugging` Phase 4 Step 1 says "Use superpowers:test-driven-development". Agent reads this, then ignores it and writes code directly. This is a systemic failure — it happens with any skill that references another.

Root cause: skill-to-skill references are plain text ("Use superpowers:xxx"), so they rely entirely on agent discipline. No code-level enforcement exists.

## Design

Two changes, both in spica-cli harness code. No skill files modified.

### Change 1: System prompt — Skill Chain Rule

**File:** `src/prompts/system.ts`

Add to `<EXTREMELY-IMPORTANT>` block:

```
SKILL CHAIN RULE: When a loaded skill's content references another skill by name, you MUST invoke skill(name="<that-skill>") before taking any other action. Skill references are instructions, not suggestions. Skipping them means you did not follow the loaded skill.
```

### Change 2: Skill tool — auto-inject REQUIRED_SKILL

**File:** `src/tools/index.ts`, in the `skill` tool handler

After loading skill content and before returning it, scan the content for references to other skill names. For each referenced skill not yet loaded, inject a `REQUIRED_SKILL: <name>` system message.

Logic:
```
1. Get list of all installed skill names
2. Scan loaded skill content for occurrences of each name
3. Filter out the skill itself (don't recurse)
4. For each found: inject system message "REQUIRED_SKILL: <name>"
```

This makes skill chains mandatory at the harness level — the existing REQUIRED_SKILL mechanism (already in system prompt) handles the rest.

### Change 3: Clean up matchSkill

**File:** `src/agent.ts`

Remove all Chinese keywords from `matchSkill()`. All prompts sent to AI must be English.

## What Does NOT Change

- Skill files — zero modifications
- `classifyIntent` — left as-is (it's a separate concern: initial skill detection from user input)
- `REQUIRED_SKILL` mechanism — unchanged, just triggered more reliably

## Data Flow

```
skill(name="systematic-debugging") called
  → load SKILL.md content
  → scan for skill name references → find "test-driven-development"
  → inject REQUIRED_SKILL: test-driven-development
  → return skill content

LLM receives:
  1. skill content (systematic-debugging)
  2. system message: "REQUIRED_SKILL: test-driven-development"
  3. system prompt rule: "If you see REQUIRED_SKILL, call skill() immediately"

Agent MUST call skill(name="test-driven-development") before any tool_call
```

## Testing

- New test: skill tool injects REQUIRED_SKILL when content references another skill
- New test: skill tool does NOT inject REQUIRED_SKILL for itself (no infinite loop)
- New test: skill tool does NOT inject for already-loaded skills
- Existing tests: all must pass
