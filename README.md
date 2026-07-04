# spica

```
              _)
   __|  __ \   |   __|   _` |
 \\__ \\  |   |  |  (     (   |
 ____/  .__/  _| \\___| \\__,_|
       _|
```

AI coding agent for the terminal. Run tools, edit files, execute commands — interactive or single-task.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue.svg)](https://www.typescriptlang.org/)

## Installation

```bash
git clone https://github.com/zisonzishen0415-stack/spica-cli
cd spica-cli
npm install && npm run build && npm link
```

## Quick Start

```bash
spica set <name> <base-url> <api-key> <model>   # add a provider
spica use <name>                                 # switch to it
spica                                            # interactive TUI mode
```

```bash
spica run "fix the bug"                          # single-task mode
```

Supports any OpenAI-compatible API — OpenAI, Anthropic (via proxy), DeepSeek, Gemini, Groq, local models.

## Feature Highlights

- **AST-based search and replace** — `ast_search` / `ast_replace` work at syntax-tree level. Safe from matching strings or comments.
- **Interactive TUI** — full-screen terminal UI with slash commands, session management, and thinking animation.
- **Sub-agent dispatch** — up to 3 parallel sub-agents (`task` tool) for isolated exploration, review, fix, or build tasks.
- **4-layer context compression** — keeps sessions within LLM context windows: snip (zero-cost filtering) → microcompact → collapse → auto-compact.
- **Tool safety** — conflict detection sequences writes to same file, git operations use single resource lock, bash injection prevention.
- **15 built-in skills** — TDD, systematic debugging, brainstorming, code review, frontend design, and more. Extensible via `/skill install`.
- **MCP support** — connect to Model Context Protocol servers for Playwright, filesystem, and more.
- **Learnings system** — corrections persisted to `.spica/learnings/`, auto-injected into future sessions.
- **Interrupt recovery** — `ESC ESC` gracefully stops in-flight LLM requests and running tools, preserves partial results.

## Tools

| Category | Tools |
|----------|-------|
| **File** | `read` `write` `edit` `file_multi_edit` `file_replace` `file_insert` `file_delete` `file_copy` `file_move` `file_exists` `file_patch` |
| **AST** | `ast_search` `ast_replace` |
| **Search** | `glob` `grep` `directory_list` `directory_create` |
| **Shell** | `bash` `monitor` `task_stop` `git` `workspace` |
| **Quality** | `lint` `test` `format` `code_health` `test_quality_check` |
| **Web** | `web_search` `web_fetch` `gh` |
| **Task** | `todo_write` `todo_read` `task` `skill` `question` |
| **Subagent** | `reply_subagent` |

## Commands

| Command | Description |
|---------|-------------|
| `/help` | List all commands |
| `/init` | Initialize project config (CLAUDE.md) |
| `/archive` | Archive session, start fresh |
| `/history` | Browse past sessions |
| `/view <id>` | View session detail |
| `/compact` | Manually compress context |
| `/summary` | Session progress summary |
| `/status` | Token usage, model, branch |
| `/idea` | Capture ideas during coding |
| `/subagents` | View subagent history |
| `/skill` | Manage skills |
| `/mcp` | Manage MCP connections |
| `/queue` / `/undo` | Input queue management |

## Development

```bash
npm run dev          # run with tsx
npm run build        # build CLI wrapper
npm test             # tests (vitest watch)
npm run test:run     # run all tests once
npm run lint         # eslint
npx tsc --noEmit     # type check
```

## Further Documentation

- [Manual](docs/MANUAL.md) — complete user guide
- [Contributing](docs/CONTRIBUTING.md) — contribution guide
- [Architecture](CLAUDE.md) — internals reference

## License

MIT
