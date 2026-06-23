# Learnings Mechanism — Design Spec

**Date**: 2025-01-16
**Status**: approved
**Topic**: Cross-session experience retention via .spica/learnings/ directory

## Problem

The AI has no memory across sessions. User corrections ("don't do X", "always do Y") are lost. Each new session starts from scratch.

## Solution

File-based learnings stored in `.spica/learnings/`. Files loaded into system prompt at session start.

### Directory
- `.spica/learnings/` — one `.md` file per learning
- Naming: `YYYY-MM-DD-topic.md` (e.g., `2025-01-16-no-comments-in-code.md`)

### Loading
`getSystemPrompt()` reads all `.spica/learnings/*.md` files, appends content under:

```
## Project Learnings (from .spica/learnings/)
- Always use brainstorming before implementation
- Never add comments unless explicitly requested
```

### Writing
AI uses `file_write` to create learnings. No new tool needed.

### Prompt addition
Add to system prompt:
```
## Project Learnings
Files in .spica/learnings/ contain user preferences and corrections from past sessions.
Read them at session start. When the user corrects your behavior, write a new learning
to .spica/learnings/YYYY-MM-DD-short-topic.md so it persists across sessions.
```

## Files Changed
- `src/prompts/system.ts` — add learnings loading to `getSystemPrompt()`, add learnings section to prompt
- `.spica/learnings/` directory (created on-demand, nothing to commit)

## Testing
- Unit test: `getSystemPrompt` includes learnings content when files exist
- `npx tsc --noEmit`
- `npm run test:run`
