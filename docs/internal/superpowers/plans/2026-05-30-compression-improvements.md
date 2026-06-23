# Compression Mechanism Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded compression thresholds with context-window-adaptive values, add re-entry guard, and improve summary fallback quality.

**Architecture:** All changes stay within `src/agent.ts` (compact methods) and `src/__tests__/compression.test.ts`. No new files. The approach keeps the LLM-based summary strategy but makes all magic numbers derive from `contextWindow` instead of being hardcoded.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Adaptive Message Truncation Length

**Files:**
- Modify: `src/agent.ts:1135-1139`

**Goal:** Replace hardcoded `1500` char truncation with context-window-adaptive value.

- [ ] **Step 1: Compute adaptive truncation length**

In `compactToTarget`, before the `truncatedRecent` map, add:

```typescript
// Adaptive truncation: 1% of context window, floor 500 chars
const maxContentLength = Math.max(500, Math.floor(contextWindow * 0.01));
```

Replace the existing `1500` on line 1136 with `maxContentLength`:

```typescript
const truncatedContent = (m.content || '').length > maxContentLength
  ? (m.content || '').slice(0, maxContentLength) + '...[truncated]'
  : m.content;
```

- [ ] **Step 2: Run existing tests to confirm no regression**

```bash
npx vitest run src/__tests__/compression.test.ts
```

Expected: All tests pass (the existing test checks for `1514` chars = 1500 + "...[truncated]" — this test will now depend on window size of 1000, so `maxContentLength = Math.max(500, Math.floor(1000 * 0.01)) = 500`, expected length = 514)

- [ ] **Step 3: Update the truncation test for adaptive length**

In `src/__tests__/compression.test.ts`, the test "should truncate recent messages to 1500 chars" (line ~100) checks `expect(truncatedMsg!.content!.length).toBe(1514)`. Change it to use the adaptive formula:

```typescript
// Window is 1000, so maxContentLength = Math.max(500, Math.floor(1000 * 0.01)) = 500
const expectedLen = 500 + '...[truncated]'.length; // 514
expect(truncatedMsg!.content!.length).toBe(expectedLen);
```

- [ ] **Step 4: Run tests to verify**

```bash
npx vitest run src/__tests__/compression.test.ts
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent.ts src/__tests__/compression.test.ts
git commit -m "fix: make compression truncation length adaptive to context window"
```

---

### Task 2: Adaptive Minimum Keep Count

**Files:**
- Modify: `src/agent.ts:1124-1126`

**Goal:** Ensure `min=5` hard floor doesn't overflow small context windows. Keep enough for large windows.

- [ ] **Step 1: Replace hardcoded min keepCount**

Replace the keepCount clamping on lines 1124-1126:

```typescript
// Old:
keepCount = Math.max(5, Math.min(keepCount, 15, Math.floor(allMessages.length * 0.25)));

// New: adaptive floor — small windows keep fewer, large windows keep more
const minKeep = Math.max(3, Math.min(8, Math.ceil(contextWindow / 50000)));
keepCount = Math.max(minKeep, Math.min(keepCount, Math.max(minKeep + 2, 15), Math.floor(allMessages.length * 0.25)));
```

- [ ] **Step 2: Add post-check to prevent keepCount overflow**

After computing `truncatedRecent`, before building final messages, add a safety check:

```typescript
// Safety: if kept messages alone exceed target, reduce keepCount until they fit
let keptTokens = tokenCounter.estimateMessages(truncatedRecent);
while (keptTokens > targetTokens * 0.7 && truncatedRecent.length > 2) {
  truncatedRecent.shift(); // remove oldest kept message
  keptTokens = tokenCounter.estimateMessages(truncatedRecent);
}
// Also recompute oldMessages to match
const finalOldMessages = allMessages.slice(0, allMessages.length - truncatedRecent.length);
```

Then use `finalOldMessages` instead of `oldMessages` in the summary generation below.

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/__tests__/compression.test.ts
```

Expected: All tests pass. The "should compress large context aggressively" test (40 messages, 1000 token window) should still reduce significantly.

- [ ] **Step 4: Commit**

```bash
git add src/agent.ts
git commit -m "fix: make compression keep-count adaptive to context window size"
```

---

### Task 3: Re-entry Guard Against Double Compression

**Files:**
- Modify: `src/agent.ts:1099-1104` (compact method)
- Add field: `src/agent.ts` class body

**Goal:** Prevent `/compact` and auto-trigger from running simultaneously, which would corrupt message state.

- [ ] **Step 1: Add `_compacting` field to SpicaAgent class**

In the `SpicaAgent` class, near the other private fields (around line 49):

```typescript
private _compacting = false;
```

- [ ] **Step 2: Add guard to `compact()` method**

Replace the `compact()` method body:

```typescript
public async compact(): Promise<void> {
  if (!this.llm || this._compacting) return;
  this._compacting = true;
  try {
    const provider = this.llm.getProvider();
    const targetTokens = Math.floor(provider.getContextWindow() * 0.3);
    await this.compactToTarget(targetTokens);
  } finally {
    this._compacting = false;
  }
}
```

- [ ] **Step 3: Write failing test for re-entry guard**

In `src/__tests__/compression.test.ts`, add to "Edge cases" describe block:

```typescript
it('should not re-enter compact while already compacting', async () => {
  // Fill messages to trigger compression
  for (let i = 0; i < 20; i++) {
    testMessages.push({ role: 'user', content: 'X'.repeat(500) });
    testMessages.push({ role: 'assistant', content: 'Y'.repeat(500) });
  }

  // Make generateDirect slow to simulate in-flight compression
  mockLLM.generateDirect = vi.fn().mockImplementation(() => {
    return new Promise(resolve => {
      setTimeout(() => resolve({ content: 'Slow summary' }), 100);
    });
  });

  // Start first compact
  const compact1 = agent.compact();

  // Try second compact immediately — should be no-op
  await agent.compact();

  // Wait for first to finish
  await compact1;

  // setMessages should only be called once (from the first compact)
  const setCalls = mockLLM.setMessages.mock.calls.length;
  expect(setCalls).toBe(1);
});
```

- [ ] **Step 4: Run test to verify it fails (if guard not in place)**

```bash
npx vitest run src/__tests__/compression.test.ts -t "should not re-enter"
```

If guard is already in place from Step 2, this passes directly.

- [ ] **Step 5: Run all compression tests**

```bash
npx vitest run src/__tests__/compression.test.ts
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/agent.ts src/__tests__/compression.test.ts
git commit -m "fix: add re-entry guard to prevent double compression"
```

---

### Task 4: Improved Fallback Summary

**Files:**
- Modify: `src/agent.ts:1220-1232`

**Goal:** When LLM summary fails, produce a richer fallback that includes tool call info, not just truncated user questions.

- [ ] **Step 1: Replace fallback generation**

Replace the `catch` block in `generateSummary`:

```typescript
} catch {
  // Fallback: preserve user questions AND tool call names in order
  const items: string[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      items.push((m.content || '').slice(0, 60));
    } else if (m.toolCalls && m.toolCalls.length > 0) {
      const toolNames = m.toolCalls.map(tc => tc.name).join(', ');
      items.push(`[${toolNames}]`);
    }
  }
  const summary = items.slice(0, 10).join(' | ');
  return {
    role: 'assistant',
    content: `[History Summary] ${summary}`,
  };
}
```

- [ ] **Step 2: Update the fallback test**

In `src/__tests__/compression.test.ts`, the test "should use fallback summary when generateDirect fails" (line ~248) checks for `'Task chain:'`. Update it:

```typescript
expect(summaryMsg).toBeDefined();
expect(summaryMsg!.content).toContain('[History Summary]');
// Fallback now uses pipe-separated format with tool info
expect(summaryMsg!.content.length).toBeGreaterThan(20);
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/__tests__/compression.test.ts
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/agent.ts src/__tests__/compression.test.ts
git commit -m "fix: improve fallback summary to include tool call context"
```

---

### Task 5: Adaptive Tool Call Truncation

**Files:**
- Modify: `src/agent.ts:1143-1153`

**Goal:** Replace hardcoded `max 4` tool calls with window-adaptive value.

- [ ] **Step 1: Compute adaptive tool call max**

Before the `truncatedRecent` map, alongside `maxContentLength` from Task 1, add:

```typescript
// Adaptive tool call max: larger windows can keep more tool context
const maxToolCalls = contextWindow > 100000 ? 6 : contextWindow > 32000 ? 4 : 2;
```

Replace the hardcoded `4` on line 1143:

```typescript
if (m.toolCalls && m.toolCalls.length > maxToolCalls) {
  truncatedToolCalls = m.toolCalls.slice(0, maxToolCalls);
```

- [ ] **Step 2: Update tool call truncation test**

In `src/__tests__/compression.test.ts`, the test "should truncate excessive toolCalls to max 4" (line ~140). Update the expected value — for 1000 token window: `maxToolCalls = 2`:

```typescript
// Window is 1000, so maxToolCalls = 2, +1 for truncated marker = 3
expect(msgWithToolCalls!.toolCalls!.length).toBeLessThanOrEqual(3);
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/__tests__/compression.test.ts
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/agent.ts src/__tests__/compression.test.ts
git commit -m "fix: make tool call truncation adaptive to context window"
```

---

### Task 6: Final Verification

**Files:**
- None (verification only)

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run
```

Expected: All tests pass, no regressions.

- [ ] **Step 2: Run type check**

```bash
npx tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 3: Verify each improvement works end-to-end**

```bash
npx vitest run src/__tests__/compression.test.ts --reporter=verbose
```

Expected output confirms all 10 original tests + 1 new re-entry test pass.
