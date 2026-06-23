# Spica-CLI Implementation Issues Log

## Session: Security & Stability Fixes (Tasks 10, 11, 12, 16 + audit)

---

### Category A: Coding Agent Tool Interface Issues

#### A1. `git` tool `args.files` doesn't accept multiple paths
- **When**: Committing tasks 10, 11, 16 together
- **What**: `git({ action: 'add', args: { files: 'src/agent.ts src/utils/history.ts ...' } })` failed with "No such file or directory"
- **Root cause**: The `args.files` parameter is passed as a single string. Git CLI treats the entire string as one literal path.
- **Workaround**: Used `bash('git add src/agent.ts src/utils/history.ts ...')` instead
- **Category**: Coding agent tool interface — the `git` tool should split `files` on whitespace or accept an array.

#### A2. `file_edit` oldString matching is fragile
- **When**: Multiple edits throughout the session
- **What**: `file_edit` failed with "oldString not found" 3+ times across the session
- **Root cause**: 
  - Whitespace/indentation differences between expected and actual file content
  - Previous edits had modified the file, making the old string stale
  - The tool requires exact string matching (including tabs/spaces)
- **Mitigation**: Re-read file with exact offset before every edit
- **Category**: Partly tool design (could support fuzzy/flexible matching), partly AI failing to re-read after previous edits

#### A3. `file_edit` succeeds silently but changes nothing
- **When**: Editing the compact loop section
- **What**: Edit returned success but the loop guard didn't appear in the file
- **Root cause**: The oldString matched a *different* location in the file than intended (a similar while loop pattern appeared elsewhere)
- **Category**: Tool design — should report which line the match was found on, or require context anchors

---

### Category B: AI Mistakes

#### B1. Incorrect file path assumptions
- **When**: Auditing RateLimiter and git.ts
- **What**: Ran `grep` on `src/utils/RateLimiter.ts` and `src/tools/git.ts` — neither file exists at those paths
- **Correct paths**: `src/llm/RateLimiter.ts`, git operations are in `src/tools/index.ts`
- **Root cause**: Assumed file organization based on conventions rather than verifying with `glob` first
- **Category**: AI error — should have verified file existence before running commands

#### B2. Incorrect assumption about existing code
- **When**: Planning the bypass test
- **What**: Assumed `NEVER_BYPASS_PATTERNS` was a class-level constant already in `agent.ts`
- **Reality**: It needed to be created from scratch (was part of task #11)
- **Root cause**: Conflated the plan's desired end-state with current code state
- **Category**: AI error — should have read current code before making assumptions

#### B3. Task ordering was suboptimal
- **What**: Completed tasks 10, 11, 12, 16 (medium difficulty) before task 9 (init cleanup) and task 3 (format tool verification)
- **Root cause**: User initially asked for tasks 10, 11, 16 specifically; later expanded to task 12
- **Category**: Primarily directed by user, but AI didn't highlight the dependency/priority mismatch

#### B4. Test file content didn't match actual module exports
- **When**: Creating `hooksOverride.test.ts`
- **What**: First draft imported from wrong path or tested functions that didn't match the actual API
- **Root cause**: Didn't read the actual `hooks/index.ts` exports before writing the test
- **Category**: AI error — test-first should mean reading the module's actual interface first

---

### Category C: Project Configuration Issues

#### C1. Stale backup files pollute vitest test run
- **When**: Running full test suite after all commits
- **What**: `FAIL .spica/backups/1780381220710-src___tests___security_bypass.test.ts`
- **Root cause**: `.spica/backups/` contains old `.test.ts` files that match vitest's default test glob patterns
- **Fix needed**: Add `.spica/` to vitest's `exclude` in `vitest.config.ts` or delete stale backups
- **Category**: Project configuration — vitest config should exclude `.spica/`

#### C2. No `RateLimiter.ts` at expected path
- **What**: Multiple plan tasks reference `src/llm/RateLimiter.ts` — file exists but at that path
- **Verified**: Task 6 (RateLimiter clearInterval) was already completed in commit `dc587c6`
- **Category**: Documentation — plan file references correct paths, my quick grep used wrong path

---

### Category D: Positive Observations

1. **Test files auto-discovered by vitest** — No config changes needed, vitest picked up all `*.test.ts` files
2. **`file_read` with offset/limit works well** — Reading partial file sections was fast and accurate
3. **`bash` fallback for `git` tool** — When the `git` function failed, `bash` with raw `git add` worked perfectly
4. **All new tests pass** — 9 new tests across 3 files, zero failures on first run
5. **No regressions** — Pre-existing 332 tests all pass (2 backup pollution failures are false positives)

---

### Summary

| Category | Count | Severity |
|----------|-------|----------|
| Tool interface issues | 3 | Medium |
| AI mistakes | 4 | Low-Medium |
| Project config issues | 2 | Low |
| Total | 9 | — |

### Recommendations

1. **`git` tool**: Support `files` as string array, not single space-joined string
2. **`file_edit` tool**: Report matched line number; consider context-anchored matching
3. **vitest config**: Add `.spica/` to exclude patterns
4. **AI workflow**: Always `glob` or `file_exists` before `grep` on assumed paths
5. **AI workflow**: Always `file_read` the target section before `file_edit`
