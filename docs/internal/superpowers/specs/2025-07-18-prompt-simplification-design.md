# Prompt Simplification Design

**Date:** 2025-07-18
**Status:** draft

## Problem

spica's prompt pipeline is command-and-control: 50-line SYSTEM_PROMPT with numbered Gates,
60-line init prompt with checklists and anti-pattern tables, and 200+ lines of
using-superpowers SKILL.md injected into every system prompt.

This contradicts AGENTS.md philosophy: give the agent project context and trust it
to figure out the rest. The two voices (command rules vs. project context) create
conflicting instructions for the LLM.

## Design

Three targeted changes. Nothing else is touched.

### 1. SYSTEM_PROMPT (src/prompts/system.ts)

**Before:** 50 lines of `<EXTREMELY-IMPORTANT>`, MUST, HARD-GATE, numbered Gate 1-5 checklist.

**After:** ~8 lines:

```
You are spica, a coding agent CLI. You edit files, run commands, and help developers.

Before acting, read the project context below. It tells you how to work on this project.

Available tools: file_read/write/edit, bash, git, glob/grep, web_search/fetch, test, lint.
Ask before: rm -rf, sudo, git push --force, git reset --hard.
Output: plain text, file:line for refs, no trailing summaries.
```

Gates, EXTREMELY-IMPORTANT blocks, and workflow rules are removed. The agent is
trusted to figure out workflow from project context.

### 2. Init prompt (src/index.ts)

**Before:** 60 lines with numbered checklist steps, anti-pattern warnings table, section-by-section template.

**After:** ~6 lines:

```
Analyze this project and create AGENTS.md. Reference https://agents.md/ for the standard.

What to include: how to build, how to test, code conventions, PR workflow.
Verify every command by running it. Don't guess. Be specific to this project.

If AGENTS.md already exists, preserve valuable content and supplement updates.
```

### 3. Skills injection (src/agent.ts)

**Before:** Full using-superpowers SKILL.md (200+ lines) injected into system prompt.
`runLoop` appends redundant `projectContext` string to every user message.

**After:**
- Skills metadata (name + description list) still injected so the agent knows what's available.
- Skill content loaded on-demand via `skill()` tool — not pre-loaded into system prompt.
- `runLoop` projectContext append removed — AGENTS.md rawContent already covers this.

## What stays unchanged

- `loadProjectConfig()` and `rawContent` injection — already correct
- Learnings system (`.spica/learnings/`) — independent and useful
- Skill discovery and `skill()` tool mechanism — preserved

## Data flow (after)

```
SYSTEM_PROMPT (~8 lines)
  + AGENTS.md rawContent (project context, direct prose)
  + Skills list (names + descriptions only, not full content)
  + .spica/learnings/

User message → runLoop → prompt (no extra projectContext append)
```

## Test plan

- Update `agent.test.ts`: verify system prompt no longer contains Gate/GATE text
- Update `agent.test.ts`: verify runLoop does not append projectContext
- Verify `loadProjectConfig` / rawContent tests still pass
- Verify init prompt tests (if any) updated for new shorter prompt
- Full test suite must pass
