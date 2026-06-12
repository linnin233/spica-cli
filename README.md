# spica - AI coding agent CLI

```
              _)
   __|  __ \   |   __|   _` |
 \__ \  |   |  |  (     (   |
 ____/  .__/  _| \___| \__,_|
       _|
```

AI coding agent for the terminal. Write, edit, run commands — interactive or single-task.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue.svg)](https://www.typescriptlang.org/)

[English](README.md) | [中文](README_CN.md)

## Install

```bash
git clone https://github.com/zisonzishen0415-stack/spica-cli
cd spica-cli
npm install && npm run build && npm link
```

## Use

```bash
spica set <name> <base-url> <api-key> <model>   # add a provider
spica use <name>                                 # switch to it
spica                                            # interactive
spica run "fix the bug"                          # single task
```

## Features

- **Tool batching** — parallel reads, parallel writes (conflict-aware), one LLM round-trip per turn
- **tiktoken-accurate counting** — real tokenizer, not heuristics; compression at 60% window
- **Two-phase compression** — instant rule-based truncation + background LLM summarization
- **8K output cap** — large tool results truncated; fetch more with `offset`/`limit`
- **Prompt cache aware** — prefix stabilization for OpenAI cache hits
- **Checkpoints** — file snapshots in `.spica/snapshots/`, no git pollution, auto-pruned
- **Learnings** — `.spica/learnings/` persists corrections across sessions
- **Session management** — `/archive`, `/clear`, `/history`; archive with summary, never delete
- **14 built-in skills** — brainstorming, TDD, debugging, code review, verification, more
- **Interrupt-safe** — ESC ESC preserves tool results and message ordering
- **Sub-agents** — `task` tool dispatches 3 parallel agents
- **Windows compatible** — PowerShell fallback, cross-platform bin scripts
- **MCP extensible** — Model Context Protocol for external tools
- **TUI** — streaming output, thinking animation, compact mode, resize handling

## Architecture

![Architecture](docs/architecture.png)

## Tools

| Category | Tools |
|----------|-------|
| File | `file_read` `file_write` `file_edit` `file_multi_edit` `file_replace` `file_insert` `file_delete` `file_copy` `file_move` `file_exists` `file_patch` |
| Search | `glob` `grep` `directory_list` `directory_create` |
| Shell | `bash` `monitor` `task_stop` `git` `workspace` |
| Quality | `lint` `test` `format` `code_health` `test_quality_check` |
| Web | `web_search` `web_fetch` `gh` |
| Task | `todo_write` `todo_read` `task` `skill` `question` |

## Commands

| Command | Description |
|---------|-------------|
| `/help` | List commands |
| `/archive` | Archive session + summary, start new |
| `/history` | Browse past sessions (read-only) |
| `/summary` | Session progress summary |
| `/compact` | Compress context |
| `/checkpoint` | Checkpoint management |
| `/skill` | Skill management |
| `/mcp` | MCP management |
| `/status` | Session status |

## Config

```
~/.spica/settings.json    # global
<project>/.spica/         # per-project
```

## Dev

```bash
npm run dev      # dev mode (tsx)
npm run build    # build
npm test         # tests (vitest)
npm run lint     # lint
```

## Docs

- [MANUAL.md](docs/MANUAL.md)
- [CONTRIBUTING.md](docs/CONTRIBUTING.md)

## License

MIT
