# Debugging Decision Tree — Design Spec

**Date**: 2025-01-16
**Status**: approved
**Topic**: Force systematic-debugging skill when tests fail, instead of random fix attempts

## Problem

When tests fail, the AI often tries random fixes instead of following a structured debugging process. The `systematic-debugging` skill exists with a proper decision tree (reproduce → isolate → fix → verify), but it's not being invoked in failure scenarios.

## Solution

Two changes:

### 1. Extend classifyIntent

Add detection for test failure patterns:
- "test fail" / "tests fail" / "test failure"
- "X tests failed" / "X tests failing"
- Messages that contain a test failure count pattern

→ `"systematic-debugging"`

### 2. Add to system prompt

Add to the Self-Review Checklist:

```
If tests fail: invoke skill(name="systematic-debugging"). Do NOT guess fixes.
```

## Files Changed

- `src/cli/skillGate.ts` — add test-failure patterns to Tier 3
- `src/cli/__tests__/skillGate.test.ts` — add test-failure tests
- `src/prompts/system.ts` — add "if tests fail, invoke systematic-debugging" rule

## Testing

- New classifier tests for test-failure patterns
- `npx tsc --noEmit`
- `npm run test:run`
