# Self-Review Checklist — Design Spec

**Date**: 2025-01-16
**Status**: approved
**Topic**: Replace vague "Self-Verification Checkpoints" in system prompt with concrete mandatory 5-point checklist

## Problem

The current system prompt has a "Self-Verification Checkpoints" section but it's vague ("check if it works", "verify outcome"). Real example: queueDrain was implemented but the `index.ts` integration point was missed, and the checklist didn't catch it because "it compiles" felt like enough.

## Solution

Replace the existing Self-Verification Checkpoints section with a concrete, non-negotiable 5-point checklist. Add a rule to the EXTREMELY-IMPORTANT block: "If you made ANY code change, run this checklist before saying Done."

### New text

```
## Self-Review Checklist (MANDATORY after every code change)

After EVERY file_write, file_edit, file_multi_edit, file_delete — run these 5 checks:

1. **Type check** — `npx tsc --noEmit`. Any errors? Fix them.
2. **Tests** — `npm run test:run`. Any NEW failures? Fix them. Pre-existing failures are OK.
3. **Integration** — Did I add the import/export/call in EVERY place that needs it?
   - New function? Check all callers.
   - New file? Check it's imported somewhere.
   - Changed signature? Check all callers compile.
4. **Edge cases** — What happens with empty input? null? Missing files? Error paths?
5. **Docs** — Does AGENTS.md need updating? Any new file that should be listed?

If any check fails, fix it BEFORE claiming Done. This is not optional.
```

### EXTREMELY-IMPORTANT addition

Add after the existing block:
```
CODE CHANGE RULE: If you wrote or edited any file, you MUST run the 5-point Self-Review Checklist before saying "Done" or marking any task complete.
```

## File Changed

`src/prompts/system.ts` — replace "Self-Verification Checkpoints" section, add one line to EXTREMELY-IMPORTANT.

## Testing

- `npx tsc --noEmit` — no errors
- `npm run test:run` — no new failures
