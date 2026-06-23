# Design: Session & Archive Clean Architecture

**Date:** 2026-06-12
**Status:** Implementing

## Problem

The current session/archive system has accumulated multiple overlapping mechanisms:

| Problem | Detail |
|---------|--------|
| `context.json` dead code | Written by `saveProjectContext()` every round, never read. MAX_CONTEXT_MESSAGES=20. |
| `saveSession()` conflates two purposes | Writes session.json AND calls archiveSession() to sessions/ |
| `/archive` handler duplicates logic | Inline LLM summary code copies `archiveSessionWithSummary()` |
| `archiveSession()` overwrite protection | Confusing: if sessions/ file exists with more msgs, keeps old one |
| `session_backup.json` mystery | Unknown origin, likely dead |

## Clean Model

```
┌─────────────────────────────────────────────────────┐
│                   ACTIVE SESSION                     │
│                                                     │
│  _fullHistory[]  ──→  getMessages()                 │
│  (append-only,       (for session persistence)       │
│   never truncated)                                   │
│                                                     │
│  provider.msgs[]  ──→  LLM context                  │
│  (compression        (context window bound)          │
│   mutates this)                                      │
│                                                     │
│  saveSession()  ──→  .spica/session.json            │
│  (writes full                                      │
│   cleaned history)                                   │
└─────────────────────────────────────────────────────┘
                         │
                    /archive, /clear
                    /reset, /new
                         │
                         ▼
┌─────────────────────────────────────────────────────┐
│                  ARCHIVED SESSION                    │
│                                                     │
│  sessions/<id>.json                                 │
│  {                                                  │
│    id, name, createdAt, lastActivity,               │
│    summary: "one-sentence description",             │
│    messages: [...]  // full history                  │
│  }                                                  │
│                                                     │
│  /history  →  lists all archived sessions           │
│  /view id  →  shows full session content            │
└─────────────────────────────────────────────────────┘
```

## Changes

### 1. Delete `context.json` — Dead Code Removal

**Files:** `src/storage/projectState.ts`, `src/agent.ts`

- Remove `CONTEXT_FILE`, `MAX_CONTEXT_MESSAGES`, `loadProjectContext()`, `saveProjectContext()`
- Remove `saveProjectContext` import and call from `agent.ts`

### 2. `saveSession()` — Only Saves Active Session

**File:** `src/utils/session.ts`

- Remove `archiveSession()` call from `saveSession()`
- `saveSession()` writes only to `session.json`
- Full messages, cleaned but not truncated

### 3. `archiveSession()` — Moves Active → Historical

**File:** `src/utils/session.ts`

- Rename `archiveSessionWithSummary()` → `archiveSession()` (single canonical function)
- Remove old `archiveSession()` with overwrite-protection logic
- LLM summary attempt → fallback to `generateSessionSummary()`
- Writes to `sessions/<id>.json`
- Returns summary string

### 4. `/archive` Handler — One Call Site

**File:** `src/commands/interactive.ts`

- Remove inline LLM summary code (lines 497-521)
- Replace with single call to `archiveSession()`
- Same flow: get messages → archive → clear → new session

### 5. Summary Quality

**File:** `src/utils/session.ts`

- Already improved `generateSessionSummary()` filtering
- Better LLM summary prompt in `archiveSession()`

### 6. `session_backup.json` — Remove If Dead

Check if anything writes/reads this file. If not, document as legacy artifact.

## Invariants

1. `_fullHistory` is append-only during a session. Only cleared on `/archive`/`/new`.
2. Compression (`/compact`, `compressToTarget()`) only touches `provider.messages[]`, never `_fullHistory`.
3. `session.json` = active session only. `sessions/<id>.json` = historical only.
4. One archive file per completed session. Never overwritten.
5. Archive summary is one sentence describing what was done.
