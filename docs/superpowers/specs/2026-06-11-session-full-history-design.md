# Design: Full Session History (Decoupled from LLM Context)

**Date:** 2026-06-11
**Status:** Draft — pending review

## Problem

Currently spica has three overlapping problems:

1. **Compression destroys history**: `startNonBlockingCompression()` calls `this.llm.setMessages([])` with truncated content, permanently discarding old messages.
2. **saveSession reads from compressed LLM context**: `agent.getMessages()` delegates to `this.llm.getMessages()`, which returns post-compression truncated data.
3. **saveSession further truncates**: `MAX_SESSION_MESSAGES=50` and `MAX_MESSAGE_LENGTH=2000` per message.

**Result**: After compression, old messages vanish from both LLM context AND disk. Archived sessions are incomplete. This violates user expectation that archived chat records should be complete.

## Core Principle

> Compression manages LLM context window. Chat history persists to disk independently. These are two separate concerns and must not share a data source.

## Design

### Architecture

```
 addMessage() ──→ _fullHistory[]          ──→ getMessages() ──→ saveSession() → .spica/session.json
       │              (append-only)            (full history)      (no truncation)
       │
       └──→ provider.messages[]          ──→ LLM API context
              (compression mutates this)      (context window bound)
```

### Changes

#### 1. `src/agent.ts` — `SpicaAgent`

**New field:**
```ts
private _fullHistory: ChatMessage[] = [];
```

**`getMessages()` — now returns full history (for session saving):**
```ts
getMessages(): ChatMessage[] {
  return this._fullHistory;
}
```

**New method `getContextMessages()` — returns LLM context (for internal use):**
```ts
getContextMessages(): ChatMessage[] {
  return this.llm?.getMessages() || [];
}
```

**`setMessages(messages)` — writes both:**
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
  // _fullHistory is NOT replaced — it's append-only.
  // setMessages() on /archive or /new clears LLM context but preserves history in _fullHistory.
}
```

Wait — this needs refinement. `setMessages` is used for:
- `/archive`, `/new`, `/clear` → should reset `_fullHistory` too (new session)
- Loading from session.json on init → should set `_fullHistory`
- Switching workspace → should reset `_fullHistory`

So we need a `resetFullHistory(messages)` for those cases, and `getMessages()` returns `_fullHistory`.

**Revised approach:**

```ts
// Append a message (called from agent's internal addMessage wrapper)
private addToFullHistory(message: ChatMessage): void {
  this._fullHistory.push(message);
}

// Full reset (workspace switch, /archive, /new, session load)
private resetFullHistory(messages: ChatMessage[]): void {
  this._fullHistory = [...messages];
}
```

**Sync points — every place that calls `this.llm.addMessage()` must also call `this.addToFullHistory()`:**

- `_doInit()` — sub-agent context injection (line ~573)
- `runLoop()` — user message injection (line ~810)
- `runLoop()` — queued input injection (line ~881)
- `runLoop()` — empty response retry message (line ~935)
- `runLoop()` — error results summary (line ~1172)
- Provider's `generate()` — assistant response is auto-added to `provider.messages` by the provider itself. We need to sync after LLM generates.

The provider auto-pushes assistant messages. We can sync in two ways:
- **Option A**: After each `generate()` return, copy the new messages from `provider.messages` to `_fullHistory`. (Fragile — need to diff what's new.)
- **Option B**: Listen to provider events and mirror. (Over-engineered.)
- **Option C (recommended)**: Add a `syncFullHistory()` call at the end of `runLoop()` and also after tool execution completes. This copies any messages in `provider.messages` that aren't yet in `_fullHistory`.

Actually the simplest correct approach: make `addMessage()` on the agent (not the LLM client) the canonical write point. The agent already has `addMessage`? No — let's check...

The agent doesn't have its own `addMessage`. All calls go through `this.llm.addMessage()`. We need to intercept those.

**Recommended: add a private `agentAddMessage(msg)` that writes both:**

```ts
private agentAddMessage(message: ChatMessage): void {
  this._fullHistory.push(message);
  this.llm?.addMessage(message);
}
```

Then replace all `this.llm!.addMessage(...)` calls in agent.ts with `this.agentAddMessage(...)`.

For messages auto-added by the provider (assistant responses, tool messages via `addToolMessage`), we sync at safe points:
- In `runLoop()` after each `generate()` call
- After tool execution + `continueWithAllToolResults()`

This can be a simple `syncFullHistory()` method:
```ts
private syncFullHistory(): void {
  if (!this.llm) return;
  const providerMessages = this.llm.getMessages();
  // If provider has more messages than _fullHistory, copy the new ones
  if (providerMessages.length > this._fullHistory.length) {
    const newMessages = providerMessages.slice(this._fullHistory.length);
    this._fullHistory.push(...newMessages);
  }
}
```

**Compression unchanged**: Only touches `provider.messages[]` via `this.llm.setMessages(...)`. `_fullHistory` grows independently.

**Workspace switch / session load / archive-reset**: Must reset `_fullHistory`:
```ts
// In switchWorkspace:
this._fullHistory = [];

// In _doInit after loading session:
this._fullHistory = [...session.messages];

// In setMessages (used by /archive /new /clear):
this._fullHistory = [...messages];
```

**Summary of all agent.ts changes:**
1. Add field `_fullHistory: ChatMessage[] = []`
2. Add `agentAddMessage(msg)` — writes both `_fullHistory` and `llm`
3. Add `syncFullHistory()` — catches provider-auto-added messages
4. Add `getContextMessages()` — returns `this.llm?.getMessages() || []`
5. Change `getMessages()` to return `_fullHistory`
6. Replace all `this.llm!.addMessage(...)` calls with `this.agentAddMessage(...)` (~4-5 call sites)
7. Add `syncFullHistory()` calls in `runLoop()` after generate and after tool processing
8. In `_doInit`, set `_fullHistory` when loading session
9. In `switchWorkspace`, reset `_fullHistory`
10. In `setMessages`, set `_fullHistory` to the new messages
11. Compression code: change `this.llm.getMessages()` to `this.getContextMessages()` (since compression only cares about LLM context)

#### 2. `src/utils/session.ts` — Remove truncation

**Remove:**
```ts
const MAX_SESSION_MESSAGES = 50;
const MAX_MESSAGE_LENGTH = 2000;
```

**Remove:**
- `truncateContent()` function
- `truncateMessages()` function
- `isSummaryMessage()` function (no longer needed for truncation separation)

**Modify `saveSession()`:**
```ts
export function saveSession(workspacePath: string, messages: ChatMessage[], sessionName?: string): void {
  // ... same dir setup ...
  const cleaned = cleanMessages(messages);  // only clean, no truncate
  // ... rest unchanged ...
}
```

The `archiveSession()` and `archiveSessionWithSummary()` functions: they pass through `session.messages` directly — no change needed since truncation was in `saveSession`'s input processing, not in archive writing itself.

#### 3. `src/index.ts` — No changes needed

`/archive` handler already calls `agent.getMessages()` which will now return full history. All `saveSession()` calls will get full messages.

### Unchanged

- Compression (`startNonBlockingCompression`, `generateSummary`, `applyPendingSummary`) — operates on LLM provider messages only
- LLM provider layer (`BaseProvider`, `OpenAICompatible`) — no awareness of `_fullHistory`
- Session storage format (`SessionState`) — same JSON schema
- Archive directory structure — `.spica/sessions/<id>.json`

### Edge Cases

1. **Compression happens mid-session, user saves/archives**: `_fullHistory` has everything, `saveSession` writes everything. Good.
2. **User hits `/compact` manually**: Triggers compression on LLM context only. `_fullHistory` unchanged. Good.
3. **Workspace switch**: `_fullHistory` reset to empty. Previous session was auto-saved (in `index.ts` exit handler). Good.
4. **Interrupt mid-run**: Partial tool results are in both `_fullHistory` (via `syncFullHistory`) and provider. Cleaned by `cleanMessages` on save. Good.
5. **Session file grows large**: No per-message truncation means large tool outputs (e.g., 200KB file reads) are preserved. This is intentional — disk is cheap, truncated history is useless. If this becomes a real problem later, add optional compression (.gz) rather than content truncation.

### Self-Review

- ✅ No placeholders or TODOs
- ✅ Architecture matches feature description — two separate data stores with sync points
- ✅ Scope is focused — 3 files, no new dependencies
- ✅ No ambiguous requirements — the sync strategy is explicit about every call site
