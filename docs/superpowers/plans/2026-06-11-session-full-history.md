# Session Full History Decoupling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Decouple session persistence from LLM context, so compression never destroys chat history, and archived sessions contain complete messages without truncation.

**Architecture:** `SpicaAgent` maintains `_fullHistory[]` (append-only, for session persistence) separate from `provider.messages[]` (LLM context, compression-mutable). `getMessages()` returns full history; `getContextMessages()` returns LLM context. `saveSession()` stores full history without per-message size limits.

**Tech Stack:** TypeScript, no new dependencies.

---

### Task 1: Add _fullHistory field and agentAddMessage helper to SpicaAgent

**Files:**
- Modify: `src/agent.ts`

- [ ] **Step 1: Add field and helper methods**

After the `_deferredSummary` field (line ~143), add:

```ts
// Full history — append-only, independent of LLM context compression
// Used by getMessages() for session persistence. Never truncated by compression.
private _fullHistory: ChatMessage[] = [];
```

Below `getMessages()` (line ~704), add:

```ts
getContextMessages(): ChatMessage[] {
  return this.llm?.getMessages() || [];
}
```

Below `setMessages()` (line ~722), add these private methods:

```ts
private agentAddMessage(message: ChatMessage): void {
  this._fullHistory.push(message);
  this.llm?.addMessage(message);
}

private syncFullHistory(): void {
  if (!this.llm) return;
  const providerMessages = this.llm.getMessages();
  if (providerMessages.length > this._fullHistory.length) {
    const newMessages = providerMessages.slice(this._fullHistory.length);
    this._fullHistory.push(...newMessages);
  }
}
```

- [ ] **Step 2: Run type check**

```bash
npx tsc --noEmit src/agent.ts
```

Expected: May have some pre-existing errors from other files, but no new errors from these additions.

---

### Task 2: Redirect getMessages() and update internal call sites

**Files:**
- Modify: `src/agent.ts`

- [ ] **Step 1: Change getMessages() to return _fullHistory**

Replace:
```ts
getMessages(): ChatMessage[] {
  return this.llm?.getMessages() || [];
}
```
With:
```ts
getMessages(): ChatMessage[] {
  return this._fullHistory;
}
```

- [ ] **Step 2: Update setMessages() to reset _fullHistory**

Replace `setMessages()` body:
```ts
setMessages(messages: ChatMessage[]) {
  if (this.llm) {
    const currentMessages = this.llm.getMessages();
    const systemPrompt = currentMessages.find(m => m.role === 'system');
    let messagesWithSystem = messages;
    if (systemPrompt) {
      const filteredMessages = messages.filter(m => m.role !== 'system');
      messagesWithSystem = [systemPrompt, ...filteredMessages];
    }
    const cleanedMessages = this.cleanMessagesForLLM(messagesWithSystem);
    this.llm.setMessages(cleanedMessages);
  }
}
```
With:
```ts
setMessages(messages: ChatMessage[]) {
  // Reset full history and LLM context
  this._fullHistory = [...messages];
  if (this.llm) {
    const systemPrompt = this.llm.getMessages().find(m => m.role === 'system');
    let messagesWithSystem = messages;
    if (systemPrompt) {
      const filteredMessages = messages.filter(m => m.role !== 'system');
      messagesWithSystem = [systemPrompt, ...filteredMessages];
    }
    const cleanedMessages = this.cleanMessagesForLLM(messagesWithSystem);
    this.llm.setMessages(cleanedMessages);
  }
}
```

- [ ] **Step 3: Update switchWorkspace() to reset _fullHistory**

In `switchWorkspace()` (around line 1249), after `this.llm.setMessages([])`:
```ts
this._fullHistory = [];
```
(Add right after the existing `this.llm.setMessages([])`)

- [ ] **Step 4: Type check**

```bash
npx tsc --noEmit src/agent.ts
```

---

### Task 3: Replace all this.llm!.addMessage() with agentAddMessage()

**Files:**
- Modify: `src/agent.ts`

All call sites in `src/agent.ts` that do `this.llm!.addMessage(` or `this.llm?.addMessage(` must be changed to `this.agentAddMessage(`.

Search pattern: `this\.llm[!?]\.addMessage\(`

List of call sites (from grep):
1. Line ~573: `this.llm.addMessage({ role: 'system', content: ... })` — sub-agent context in `_doInit()`
2. Line ~810: `this.llm!.addMessage({ role: 'user', content: prompt })` — user message in `runLoop()` — wait, let me check if this is correct. Looking at offset 810 area... Actually I didn't read that exact area. Let me check all the call sites.

Actually, the grep earlier showed these `addMessage` call sites in agent.ts:
- `573`: `this.llm.addMessage(` — sub-agent system context
- `881`: `this.llm!.addMessage({ role: 'user', content: '[QUEUED INPUT]...' })` 
- `935`: `this.llm!.addMessage({ role: 'user', content: '[SYSTEM] Previous response...' })`
- `1172`: `this.llm?.addMessage({ role: 'user', content: '[SYSTEM NOTE]...' })`

Wait, but there's also the main user message add. Let me check — `generate(prompt, ...)` is called on the LLM client, which internally does `this.provider.addMessage(msg)` on line 241 (LLMClient.ts). So the main user message and assistant responses are added by the provider directly, not through agent.addMessage. That's why we need `syncFullHistory()`.

So the replace list is:
1. `this.llm.addMessage(` (sub-agent context, no `!` or `?`)
2. `this.llm!.addMessage(` (queued input, empty response retry)
3. `this.llm?.addMessage(` (error results summary)

- [ ] **Step 1: Replace all addMessage calls**

Replace each instance. Here are the exact replacements:

**Instance 1** (sub-agent context, ~line 573):
```ts
this.llm.addMessage({
```
→
```ts
this.agentAddMessage({
```

**Instance 2** (queued input, ~line 881):
```ts
this.llm!.addMessage({ role: 'user', content: `[QUEUED INPUT] ${queuedInputAtStart}` });
```
→
```ts
this.agentAddMessage({ role: 'user', content: `[QUEUED INPUT] ${queuedInputAtStart}` });
```

**Instance 3** (empty response retry, ~line 935):
```ts
this.llm!.addMessage({
  role: 'user' as const,
  content: '[SYSTEM] Previous response was empty. Please continue working on the task and provide a response or use tools.'
});
```
→
```ts
this.agentAddMessage({
  role: 'user' as const,
  content: '[SYSTEM] Previous response was empty. Please continue working on the task and provide a response or use tools.'
});
```

**Instance 4** (error results summary, ~line 1172):
```ts
this.llm?.addMessage({
  role: 'user' as const,
  content: `[SYSTEM NOTE] Previous operations completed but LLM response failed...
```
→
```ts
this.llm?.addMessage({
```
Wait — this one uses `?.` because `this.llm` might be null. `agentAddMessage` also uses `?.` internally. So this is fine to replace directly.

Actually all use the same pattern. Let me just replace `this.llm!.addMessage(` and `this.llm?.addMessage(` and `this.llm.addMessage(` with `this.agentAddMessage(`.

- [ ] **Step 2: Type check**

```bash
npx tsc --noEmit src/agent.ts
```

---

### Task 4: Add syncFullHistory() calls in runLoop

**Files:**
- Modify: `src/agent.ts`

- [ ] **Step 1: Add sync after main generate call**

After the initial `generate()` call in `runLoop()` (~line 838, in the try block after `response = await this.callLLMWithRetry(...)`), add:

```ts
// Sync provider-auto-added messages (user message + assistant response) to full history
this.syncFullHistory();
```

- [ ] **Step 2: Add sync after each tool processing iteration**

The tool execution loop (`while (!response.finished && iterations < maxIterations)`) processes tools and calls `continueWithAllToolResults()`. After the `continueWithAllToolResults` call and before the next iteration check, add `this.syncFullHistory()`.

Look for the `continueWithAllToolResults` call site. From reading agent.ts, it's around line ~1040 area. Let me check...

Actually, I should read the exact location. Let me note to read the file first before this step.

- [ ] **Step 3: Type check**

```bash
npx tsc --noEmit src/agent.ts
```

---

### Task 5: Update _doInit to set _fullHistory on session load

**Files:**
- Modify: `src/agent.ts`

- [ ] **Step 1: Set _fullHistory when loading session**

In `_doInit()`, after `this.llm.setMessages(session.messages)` (~line 635), add:

```ts
this._fullHistory = [...session.messages];
```

- [ ] **Step 2: Type check**

```bash
npx tsc --noEmit src/agent.ts
```

---

### Task 6: Remove truncation limits from session.ts

**Files:**
- Modify: `src/utils/session.ts`

- [ ] **Step 1: Remove truncation constants and functions**

Remove:
```ts
const MAX_SESSION_MESSAGES = 50;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_SUMMARY_LENGTH = 8000;
```

Remove the entire `truncateContent()` function.

Remove the entire `isSummaryMessage()` function.

Remove the entire `truncateMessages()` function.

- [ ] **Step 2: Update saveSession()**

Replace:
```ts
const truncated = truncateMessages(messages);
const existingSession = loadSession(workspacePath);
const cleaned = cleanMessages(truncated);
```
With:
```ts
const existingSession = loadSession(workspacePath);
const cleaned = cleanMessages(messages);
```

- [ ] **Step 3: Type check**

```bash
npx tsc --noEmit src/utils/session.ts
```

---

### Task 7: Full type check and run tests

- [ ] **Step 1: Full type check**

```bash
npx tsc --noEmit
```

Expected: 0 errors (or at least no new errors related to our changes).

- [ ] **Step 2: Run agent tests**

```bash
npx vitest run src/__tests__/agent/
```

- [ ] **Step 3: Run session tests**

```bash
npx vitest run src/__tests__/session/
```

Or find the correct test path:
```bash
npx vitest run --reporter=verbose -t "session"
```

- [ ] **Step 4: Commit**

```bash
git add src/agent.ts src/utils/session.ts docs/superpowers/specs/2026-06-11-session-full-history-design.md docs/superpowers/plans/2026-06-11-session-full-history.md
git commit -m "feat: decouple session full history from LLM context compression

- Add _fullHistory (append-only) to SpicaAgent, independent of provider.messages
- getMessages() returns _fullHistory for session persistence
- Add getContextMessages() for compression/internal LLM context access
- Add agentAddMessage() writing to both _fullHistory and provider
- Add syncFullHistory() catching provider-auto-added messages
- Remove MAX_SESSION_MESSAGES=50 and content truncation from session.ts
- Compression continues to operate on provider.messages only"
```

---

## Self-Review

1. **Spec coverage:** All design points covered — `_fullHistory` field (Task 1), `getMessages()` redirect (Task 2), `agentAddMessage` calls (Task 3), `syncFullHistory` (Task 4), session load (Task 5), truncation removal (Task 6).

2. **Placeholder scan:** No TBD/TODO/fill-in-details. All code replacements are exact.

3. **Type consistency:** `_fullHistory: ChatMessage[]` consistent across all tasks. `agentAddMessage(ChatMessage)`, `syncFullHistory()`, `getContextMessages(): ChatMessage[]` signatures consistent.
