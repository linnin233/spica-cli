# AST-Grep Integration Design

## Summary

Integrate ast-grep (AST-based code search and rewrite) into spica-cli as two new tools: `ast_search` and `ast_replace`. These complement existing text-level tools (grep, edit, file_replace) with AST-level precision.

## Motivation

Current spica-cli code search and modification operates entirely at the text level:

| Tool | Layer | Limitation |
|------|-------|-----------|
| `grep` | Regex text match | Cannot distinguish code from strings/comments |
| `edit` / `file_replace` | Exact/regex text replace | May hit strings/comments with same text |
| `read` | Line-based file read | No understanding of code structure |

ast-grep adds AST semantic understanding: search understands code structure, replacement only hits real code nodes.

## Design

### New Tools

**`ast_search`** — Structural code search

| Param | Type | Description |
|-------|------|-------------|
| `pattern` | string (required) | Code pattern with `$VAR` wildcards |
| `lang` | string (optional) | Language: ts, tsx, js, jsx, py, rs, go, etc. Auto-detect from extension if omitted |
| `path` | string (optional) | Directory to search (default: workspace) |
| `glob` | string (optional) | File filter (e.g., `*.ts`) |
| `maxResults` | number (optional) | Default 50 |

**`ast_replace`** — AST-based code rewrite

| Param | Type | Description |
|-------|------|-------------|
| `pattern` | string (required) | Code pattern to find |
| `rewrite` | string (required) | Replacement with `$VAR` captures |
| `lang` | string (optional) | Auto-detect if omitted |
| `path` | string (optional) | Directory or file |
| `glob` | string (optional) | File filter |
| `confirm` | boolean (optional) | **MUST be true** to actually modify files |

### Safety

1. **Dry-run default**: `ast_replace` without `confirm: true` only reports what would change
2. **Batch threshold**: >10 files triggers warning requiring explicit confirmation

### Implementation

- `@ast-grep/cli` npm dependency provides `sg` CLI
- Called via `execa` with structured arguments
- Parses `--json=compact` output
- Two new impl files: `src/tools/impl/ast_search.ts`, `src/tools/impl/ast_replace.ts`
- Language auto-detection from file extensions
- Graceful error if ast-grep not installed

### Agent Guidance

System prompt addition teaches agent when to use AST vs text tools:

| Task | Tool |
|------|------|
| Search for text/strings/comments | `grep` |
| Search for code patterns/structures | `ast_search` |
| Replace known exact text at known location | `edit` |
| Safe cross-file structural refactor | `ast_replace` |

### Non-Goals

- Does not replace grep, edit, or file_replace
- Does not modify existing tool behavior
- Pure additive change
