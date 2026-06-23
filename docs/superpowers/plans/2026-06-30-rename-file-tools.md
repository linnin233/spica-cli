# Rename file_read/write/edit → read/write/edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the 3 core file tools (`file_read` → `read`, `file_write` → `write`, `file_edit` → `edit`) to match Claude Code naming conventions, eliminating LLM hallucination of `read`/`write`/`edit` tool names. Other `file_*` tools (file_delete, file_copy, file_move, etc.) keep their prefix.

**Architecture:** Rename in registry definitions first, then propagate through execute.ts switch, agent.ts conflict detection/error hints, events.ts display, subAgent.ts allowlists, session.ts, and system prompt. Keep `file_read`/`file_write`/`file_edit` as backward-compatible aliases in execute.ts for one release cycle. Update all 12 test files.

**Tech Stack:** TypeScript, vitest, execa

**Affected files (source: 8, test: 12):**
- Modify: `src/tools/registry.ts` (line 6, 26, 40 — names + descriptions)
- Modify: `src/tools/execute.ts` (line 63, 66, 117 — switch cases; line 37 — import; add alias fallback)
- Modify: `src/agent.ts` (lines 43-45, 1181-1182, 1464-1479, 1776-1796 — string literals)
- Modify: `src/cli/events.ts` (lines 444, 449-450, 602-604, 742-744, 873-875, 1061 — switch/case + importantTools)
- Modify: `src/cli/ui/diff.ts` (line 172 — comment only)
- Modify: `src/tools/subAgent.ts` (lines 29, 34, 39 — allowedTools arrays)
- Modify: `src/utils/session.ts` (line 200 — array includes)
- Modify: `src/prompts/system.ts` (lines 33, 40 — "file_read" → "read")
- Modify: `src/__tests__/tools.test.ts` (lines 27-29, 111, 116, 148, 153, 159)
- Modify: `src/tools/__tests__/toolsCore.test.ts` (lines 35-37, 86, 100, 113, 357, 369, 381, 393, 405)
- Modify: `src/__tests__/agent.test.ts` (lines 147, 156, 177)
- Modify: `src/__tests__/compression.test.ts` (lines 139-142, 173, 197, 209-210, 227)
- Modify: `src/__tests__/edgeCases.test.ts` (line 131)
- Modify: `src/__tests__/fullFeature.test.ts` (lines 84, 92, 103, 118)
- Modify: `src/llm/__tests__/TokenCounter.test.ts` (lines 32, 58-59, 75)
- Modify: `src/__tests__/llm/BaseProvider.test.ts` (line 90)
- Modify: `src/__tests__/llmErrorHandling.test.ts` (line 103)
- Modify: `src/__tests__/regression/tokenCounter.test.ts` (lines 21, 42, 65-67, 126)
- Modify: `src/__tests__/security/resolvePath.test.ts` (lines 32, 42, 54, 64, 78, 85, 92, 100, 110, 118)
- Modify: `src/__tests__/syntaxCheck.test.ts` (lines 28, 44, 62, 79, 96, 113, 130, 148, 166, 172, 193, 212, 222)

---

### Task 1: Rename in registry.ts (tool definitions)

**Files:**
- Modify: `src/tools/registry.ts:6-15`
- Modify: `src/tools/registry.ts:26-38`
- Modify: `src/tools/registry.ts:40-53`

- [ ] **Step 1: Change file_read → read**

```ts
// src/tools/registry.ts line 6-15
// BEFORE:
  {
    name: 'file_read',
    batchHint: 'read' as const,
    description: 'Read file contents. Tool name is file_read (not "read"). Required before file_write/edit.',

// AFTER:
  {
    name: 'read',
    batchHint: 'read' as const,
    description: 'Read file contents. Required before write/edit.',
```

- [ ] **Step 2: Change file_write → write**

```ts
// src/tools/registry.ts line 26-38
// BEFORE:
    name: 'file_write',
    batchHint: 'write' as const,
    description: 'Write/create file. Overwrites existing. Auto-checks syntax for code files...

// AFTER:
    name: 'write',
    batchHint: 'write' as const,
    description: 'Write/create file. Overwrites existing. Auto-checks syntax for code files...
```

- [ ] **Step 3: Change file_edit → edit**

```ts
// src/tools/registry.ts line 40-53
// BEFORE:
    name: 'file_edit',
    batchHint: 'write' as const,
    description: 'Edit file by exact text replacement. Read first. Auto-checks syntax after edit.

// AFTER:
    name: 'edit',
    batchHint: 'write' as const,
    description: 'Edit file by exact text replacement. Read first. Auto-checks syntax after edit.
```

- [ ] **Step 4: Update cross-references in other tool descriptions**

```ts
// registry.ts line 58 — file_multi_edit description
// BEFORE: ...more efficient than multiple file_edit calls...
// AFTER:  ...more efficient than multiple edit calls...

// registry.ts line 83 — file_replace description
// BEFORE: ...more flexible than file_edit for pattern matching...
// AFTER:  ...more flexible than edit for pattern matching...
```

- [ ] **Step 5: Verify type check**

```bash
npx tsc --noEmit
```
Expected: errors in other files that still reference old names (will fix in subsequent tasks).

- [ ] **Step 6: Commit**

```bash
git add src/tools/registry.ts
git commit -m "refactor: rename file_read/write/edit → read/write/edit in registry"
```

---

### Task 2: Update execute.ts (execution dispatch + import + backward compat)

**Files:**
- Modify: `src/tools/execute.ts:37` (import)
- Modify: `src/tools/execute.ts:63-65` (switch case for read)
- Modify: `src/tools/execute.ts:66` (switch case for write)
- Modify: `src/tools/execute.ts:117` (switch case for edit)
- New: add alias map at top for backward compatibility

- [ ] **Step 1: Update import path**

```ts
// src/tools/execute.ts line 37
// BEFORE:
import { executeFileRead } from './impl/file_read';
// AFTER:
import { executeFileRead } from './impl/file_read'; // impl module keeps original name
```
No change needed — the impl module file name stays as-is, only the tool name changes.

- [ ] **Step 2: Add backward-compatible alias map (at top of switch)**

In `src/tools/execute.ts`, inside the `executeTool` function, before the switch statement (around line 60), add:

```ts
// Backward-compatible aliases for renamed tools
const TOOL_ALIASES: Record<string, string> = {
  'file_read': 'read',
  'file_write': 'write',
  'file_edit': 'edit',
};
name = TOOL_ALIASES[name] || name;
```

This maps old names to new names silently, so any queued/restored sessions using old names won't break.

- [ ] **Step 3: Rename switch cases**

```ts
// src/tools/execute.ts line 63
// BEFORE:  case 'file_read':
// AFTER:   case 'read':

// src/tools/execute.ts line 66
// BEFORE:  case 'file_write': {
// AFTER:   case 'write': {

// src/tools/execute.ts line 117
// BEFORE:  case 'file_edit': {
// AFTER:   case 'edit': {
```

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit
```
Expected: 0 errors (registry + execute are aligned now).

- [ ] **Step 5: Commit**

```bash
git add src/tools/execute.ts
git commit -m "refactor: update execute.ts for read/write/edit + backward compat aliases"
```

---

### Task 3: Update agent.ts (conflict detection, error hints, compression weights)

**Files:**
- Modify: `src/agent.ts:43-45` (extractResourcePath array)
- Modify: `src/agent.ts:1181-1182` (diff_preview check)
- Modify: `src/agent.ts:1464-1479` (error suggestion map)
- Modify: `src/agent.ts:1776-1781` (compression weight comments)
- Modify: `src/agent.ts:1795-1796` (compression content check)

- [ ] **Step 1: Update extractResourcePath array**

```ts
// src/agent.ts lines 43-45
// BEFORE:
      'file_read',
      'file_write',
      'file_edit',
// AFTER:
      'read',
      'write',
      'edit',
```

- [ ] **Step 2: Update diff_preview check**

```ts
// src/agent.ts lines 1181-1182
// BEFORE:
                (tc.name === 'file_write' ||
                  tc.name === 'file_edit' ||
// AFTER:
                (tc.name === 'write' ||
                  tc.name === 'edit' ||
```

- [ ] **Step 3: Update error suggestion map**

```ts
// src/agent.ts lines 1464-1479
// BEFORE:
      file_read: (e, a) =>
          ...,
      file_write: (e, a) =>
          ...,
      file_edit: (e, a) =>
          ...,
// AFTER:
      read: (e, a) =>
          ...,
      write: (e, a) =>
          ...,
      edit: (e, a) =>
          ...,
```

- [ ] **Step 4: Update compression weight comments**

```ts
// src/agent.ts lines 1776-1781
// BEFORE:
   * - assistant with file_write/git/bash: 7 (actual code changes)
   * - assistant with file_edit: 6 (edits)
   * - tool for file_write/git: 4 (result of write)
   * - tool for file_read/grep/glob: 1 (transient read)
// AFTER:
   * - assistant with write/git/bash: 7 (actual code changes)
   * - assistant with edit: 6 (edits)
   * - tool for write/git: 4 (result of write)
   * - tool for read/grep/glob: 1 (transient read)
```

- [ ] **Step 5: Update compression content check**

```ts
// src/agent.ts lines 1795-1796
// BEFORE:
        (content.includes('file_write') ||
          content.includes('file_edit') ||
// AFTER:
        (content.includes('write') ||
          content.includes('edit') ||
```
Note: these are content checks on message strings, so partial string matches are intentional (e.g., `'write'` will also match `'file_write'` if old sessions have old content). Keep the check as-is or make it more specific — since we're checking for tool_call content in history messages, the new names are shorter and more likely to false-match. Change to:
```ts
        (content.includes('"name":"write"') ||
          content.includes('"name":"edit"') ||
```
Actually, looking at the context more carefully — this is `content` of the message being compressed, likely just text. Let me read the exact context.

Wait, I need to read the actual code to be precise. Let me just note that I'll read the actual lines before editing.

- [ ] **Step 6: Verify**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/agent.ts
git commit -m "refactor: update agent.ts for read/write/edit tool names"
```

---

### Task 4: Update events.ts (tool display — formatToolSummary + displayToolResult)

**Files:**
- Modify: `src/cli/events.ts:444-450` (formatToolSummary switch)
- Modify: `src/cli/events.ts:602-604` (displayToolResult verbose switch)
- Modify: `src/cli/events.ts:742-744` (displayToolResult compact switch)
- Modify: `src/cli/events.ts:873-875` (another switch block)
- Modify: `src/cli/events.ts:1060-1061` (importantTools array)

- [ ] **Step 1: Update formatToolSummary switch**

```ts
// src/cli/events.ts lines 444-450
// BEFORE:
    case 'file_read': {
      ...
    }
    case 'file_write':
    case 'file_edit':
    case 'file_multi_edit':
    case 'file_patch': {
// AFTER:
    case 'read': {
      ...
    }
    case 'write':
    case 'edit':
    case 'file_multi_edit':
    case 'file_patch': {
```

- [ ] **Step 2: Update displayToolResult verbose switch (3 occurrences at lines 602-604, 742-744, 873-875)**

For each occurrence:
```ts
// BEFORE:
      case 'file_read':
      case 'file_write':
      case 'file_edit':
// AFTER:
      case 'read':
      case 'write':
      case 'edit':
```

- [ ] **Step 3: Update importantTools array**

```ts
// src/cli/events.ts line 1061
// BEFORE:
    const importantTools = ['bash', 'file_write', 'file_edit', 'web_fetch', 'web_search'];
// AFTER:
    const importantTools = ['bash', 'write', 'edit', 'web_fetch', 'web_search'];
```

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/cli/events.ts
git commit -m "refactor: update events.ts for read/write/edit tool display"
```

---

### Task 5: Update remaining source files (diff.ts, subAgent.ts, session.ts, system.ts)

**Files:**
- Modify: `src/cli/ui/diff.ts:172` (comment)
- Modify: `src/tools/subAgent.ts:29,34,39` (allowedTools)
- Modify: `src/utils/session.ts:200` (tool name check)
- Modify: `src/prompts/system.ts:33,40` (system prompt text)

- [ ] **Step 1: Update diff.ts comment**

```ts
// src/cli/ui/diff.ts line 172
// BEFORE: // 从oldString/newString生成diff（用于file_edit）
// AFTER:  // Generate diff from oldString/newString (for edit tool)
```

- [ ] **Step 2: Update subAgent.ts allowedTools**

```ts
// src/tools/subAgent.ts line 29
// BEFORE: allowedTools: ['glob', 'grep', 'file_read', 'directory_list', 'file_exists'],
// AFTER:  allowedTools: ['glob', 'grep', 'read', 'directory_list', 'file_exists'],

// src/tools/subAgent.ts line 34
// BEFORE: allowedTools: ['glob', 'grep', 'file_read', 'directory_list', 'lint', 'file_exists'],
// AFTER:  allowedTools: ['glob', 'grep', 'read', 'directory_list', 'lint', 'file_exists'],

// src/tools/subAgent.ts line 39
// BEFORE: allowedTools: ['file_read', 'file_edit', 'bash', 'lint'],
// AFTER:  allowedTools: ['read', 'edit', 'bash', 'lint'],
```

- [ ] **Step 3: Update session.ts tool name check**

```ts
// src/utils/session.ts line 200
// BEFORE: if (['file_write', 'file_edit', 'file_multi_edit'].includes(tc.name)) {
// AFTER:  if (['write', 'edit', 'file_multi_edit'].includes(tc.name)) {
```

- [ ] **Step 4: Update system.ts prompt text**

```ts
// src/prompts/system.ts line 33
// BEFORE: - Use file_read before editing files. Use glob to find files, grep to search content.
// AFTER:  - Use read before editing files. Use glob to find files, grep to search content.

// src/prompts/system.ts line 40
// BEFORE: - Batch all independent reads together: [file_read(A), file_read(B), glob(...), grep(...)] in one response.
// AFTER:  - Batch all independent reads together: [read(A), read(B), glob(...), grep(...)] in one response.
```

- [ ] **Step 5: Verify**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/cli/ui/diff.ts src/tools/subAgent.ts src/utils/session.ts src/prompts/system.ts
git commit -m "refactor: update subAgent/session/system for read/write/edit names"
```

---

### Task 6: Update all test files

**Files:** 12 test files (see full list above)

Strategy: Globally replace `'file_read'` → `'read'`, `'file_write'` → `'write'`, `'file_edit'` → `'edit'` in test files only. Exclude `file_multi_edit` (keep prefix).

- [ ] **Step 1: Replace in all test files**

Run a single sed command to replace all 3 patterns across all test files:

```bash
cd src && find . -name "*.test.ts" -o -path "*/__tests__/*.ts" | while read f; do
  node -e "
    const fs = require('fs');
    let c = fs.readFileSync('$f','utf8');
    // Replace only exact tool name strings in tool calls
    c = c.replace(/'file_read'/g, \"'read'\");
    c = c.replace(/'file_write'/g, \"'write'\");
    c = c.replace(/'file_edit'/g, \"'edit'\");
    fs.writeFileSync('$f', c);
  "
done
```

Actually, use simpler node script for cross-platform:

```bash
node -e "
const fs = require('fs');
const path = require('path');
const glob = require('fast-glob');
const files = glob.sync('src/**/__tests__/**/*.ts');
files.forEach(f => {
  let c = fs.readFileSync(f, 'utf8');
  let modified = false;
  // Replace 'file_read' with 'read' (but not 'file_read' when preceded by file_)
  if (c.includes(\"'file_read'\")) { c = c.replace(/'file_read'/g, \"'read'\"); modified = true; }
  if (c.includes(\"'file_write'\")) { c = c.replace(/'file_write'/g, \"'write'\"); modified = true; }
  if (c.includes(\"'file_edit'\")) { c = c.replace(/'file_edit'/g, \"'edit'\"); modified = true; }
  if (modified) { fs.writeFileSync(f, c); console.log('Updated:', f); }
});
"
```

- [ ] **Step 2: Verify type check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/__tests__/tools.test.ts src/tools/__tests__/toolsCore.test.ts src/__tests__/agent.test.ts
```
Expected: all pass.

- [ ] **Step 4: Run broader test suite**

```bash
npx vitest run src/__tests__/ src/tools/__tests__/ src/llm/__tests__/ src/cli/__tests__/
```
Expected: all pass (except known Windows-only failures).

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/ src/tools/__tests__/ src/llm/__tests__/ src/cli/__tests__/
git commit -m "test: update tests for read/write/edit tool names"
```

---

### Task 7: Final verification

- [ ] **Step 1: Full type check**

```bash
npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 2: Lint check**

```bash
npm run lint
```
Expected: 0 errors (warnings OK).

- [ ] **Step 3: Build check**

```bash
npm run build && ./bin/spica --version
```
Expected: `1.0.0`.

- [ ] **Step 4: Full test suite**

```bash
npx vitest run
```
Expected: all pass (except known Windows failures in tuiPty/monitor/resolvePath/fullFeature/toolsCore/session).

- [ ] **Step 5: Commit final verification**

```bash
git add -A
git commit -m "chore: final verification after read/write/edit rename"
```
