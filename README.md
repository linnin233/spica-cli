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

> See [docs/architecture.mermaid](docs/architecture.mermaid) for source. Rendered: [docs/architecture.png](docs/architecture.png)

```mermaid
graph TB
    subgraph PRES["🎨 Presentation Layer"]
        direction TB
        TUI["<b>TUI Mode</b><br/>full-screen terminal<br/>screenManager / scrollback<br/>status bar / thinking animation"]
        SIMPLE["<b>Simple Mode</b><br/>--no-tui / non-TTY<br/>readline / plain text output"]
        CMD["<b>Slash Commands</b><br/>/help /init /history /summary<br/>/compact /archive /view /rename<br/>/delete /clear /reset /new<br/>/checkpoint list|show|restore|clean<br/>/skill list|install|uninstall<br/>/mcp status|init|tools|disconnect<br/>/queue /q /undo /status"]
        IQ["<b>Input Queue</b><br/>max 50 / buffers during processing<br/>/queue show / /undo remove<br/>auto-drain after processing"]
        UI["<b>UI Components</b><br/>diff renderer / spinner<br/>streaming output / bracketed paste<br/>fixedBox / tableRenderer / scrollback"]
    end

    subgraph APP["⚙️ Application Layer"]
        direction TB
        AGENT["<b>SpicaAgent</b> (src/agent.ts)<br/>EventEmitter orchestrator<br/>_fullHistory (append-only)<br/>getContextMessages (LLM context)<br/>tool conflict detection<br/>auto message cleaner<br/>dangerous pattern scanner"]
        GATE["<b>Skill Gate</b> (src/cli/skillGate.ts)<br/>8 intent categories<br/>SKILL HINT injection<br/>path matching / tool whitelisting"]
        EVENTS["<b>Event Bus (42 events)</b><br/>Core: stream · reasoning · message<br/>Tools: tool_call · tool_result<br/>Compress: context_compressed · context_warning<br/>Subagent: sub_agent_start/done/error<br/>  sub_agent_tool_call/tool_result<br/>  sub_agent_message/reasoning/stream<br/>Monitor: monitor_event · monitor_error<br/>Hooks: hook_blocked/warning/log<br/>+ 14 more (see agent.ts emits)"]
        INTR["<b>Interrupt Handler</b><br/>AbortController per request<br/>cancelSeq high-water mark<br/>SIGKILL to process group<br/>ESC×2 trigger / 200ms debounce<br/>preserves partial tool results"]
        SESSION["<b>Session & Archive</b><br/>two-state model (decoupled)<br/>active → session.json<br/>historical → sessions/&lt;id&gt;.json<br/>LLM summary on archive<br/>auto-cleanup (keep 50)"]
        SUB["<b>Sub-Agents (4 types)</b><br/>explore: read-only (90s→180s)<br/>review: +lint (120s→240s)<br/>fix: +edit (180s→360s)<br/>build: all tools (300s→600s)<br/>adaptive: prompt-length bonus<br/>worktree isolation option<br/>max 3 parallel / early-exit signal<br/>per-task model override"]
        PMON["<b>ProcessMonitor</b><br/>PID tracking / process group kill<br/>stuck detection (SIGKILL)<br/>timeout management"]
        LEARN["<b>Learnings System</b><br/>auto-detects user corrections<br/>saves to .spica/learnings/<br/>YYYY-MM-DD-topic.md<br/>auto-injected into system prompt"]
    end

    subgraph DOMAIN["🧠 Domain Layer"]
        direction TB
        LLM["<b>LLMClient</b><br/>OpenAI-compatible streaming<br/>temperature=0.3<br/>stream + reasoning channels<br/>rate limiter · retry with backoff<br/>abort-controller dedup"]
        PROV["<b>Provider</b> (OpenAICompatible.ts)<br/>single adapter for all APIs<br/>model: default / models: alias→ID map<br/>resolveModel() auto-resolution<br/>split-prefix caching (stable+variable)<br/>OpenAI · DeepSeek · Gemini<br/>Groq · Anthropic proxy · local"]
        TOK["<b>TokenCounter + Compression v2</b><br/>tiktoken real tokenizer<br/>cache-prefix-aware truncation<br/>graduated keep tiers (10–25 msgs)<br/>2-phase: rule trunc + LLM summary<br/>sync summary on heavy drop (>50%)<br/>per-role content limits (adaptive)<br/>trigger: 60% / target: 40%"]
        TOOLS["<b>33 Tools</b> (registry.ts + impl/)<br/>📁 File (11) · 🔍 Search (4)<br/>💻 Shell (5): bash (sandbox)<br/>✅ Quality (5) · 🌐 Web (3) · 📋 Task (5)<br/>Auto: syntax check · tool cache (30s TTL)<br/>sandbox (bwrap) · replace_all detection<br/>see tool table below"]
        MCP["<b>MCP Client</b><br/>@modelcontextprotocol/sdk<br/>external tool servers<br/>built-in: playwright"]
        HOOKS["<b>Hooks System</b><br/>PreToolUse / PostToolUse<br/>block · confirm · warn · log<br/>global + project layers<br/>project ≤ global strictness"]
        SKILLS["<b>14 Built-in Skills</b><br/>brainstorming · systematic-debugging<br/>test-driven-development · verification<br/>executing-plans · writing-plans<br/>dispatching-parallel-agents<br/>subagent-driven-development<br/>requesting-code-review · receiving<br/>finishing-a-development-branch<br/>using-git-worktrees · writing-skills<br/>using-superpowers"]
    end

    subgraph INFRA["💾 Infrastructure Layer"]
        direction TB
        GLOBAL["<b>~/.spica/settings.json</b><br/>providers (model aliases)<br/>MCP servers · skills · hooks<br/>chmod 600 / .gitignore protected"]
        ACTIVE["<b>.spica/session.json</b><br/>active / append-only<br/>never truncated by compression"]
        HIST["<b>.spica/sessions/&lt;id&gt;.json</b><br/>historical / one per archive<br/>LLM or local summary"]
        STATE["<b>.spica/state.json</b><br/>todos / decisions"]
        TASKS["<b>.spica/tasks.json</b><br/>persisted task list<br/>auto-restored on start"]
        LEARNINGS["<b>.spica/learnings/</b><br/>YYYY-MM-DD-topic.md<br/>auto-injected"]
        SNAPS["<b>.spica/snapshots/</b><br/>checkpoint snapshots<br/>auto-pruned (keep 20)"]
        CHKJSON["<b>.spica/checkpoints.json</b><br/>metadata index"]
        BACKUPS["<b>.spica/backups/</b><br/>auto-created on write/edit"]
        PSKILLS["<b>.spica/skills.json<br/>.spica/skills/</b><br/>project-level skill overrides"]
        PHOOKS["<b>.spica/hooks.json</b><br/>project-level hook overrides<br/>must be ≥ global strictness"]
    end

    TUI --> IQ
    SIMPLE --> IQ
    CMD --> AGENT
    IQ --> AGENT
    AGENT <--> LLM
    PROV --> LLM
    TOK --> LLM
    LLM --> AGENT
    AGENT --> TOOLS
    MCP --> TOOLS
    TOOLS --> AGENT
    AGENT --> EVENTS
    EVENTS --> UI
    INTR --> AGENT
    AGENT --> SESSION
    SESSION --> ACTIVE
    ACTIVE --> HIST
    AGENT --> SUB
    SUB --> AGENT
    AGENT --> PMON
    LEARN --> AGENT
    GATE --> AGENT
    HOOKS --> AGENT
    HOOKS --> TOOLS
    SKILLS --> AGENT
    SKILLS --> TOOLS
    GLOBAL --> LLM
    GLOBAL --> PROV
    AGENT --> STATE
    AGENT --> TASKS
    SESSION --> HIST
    LEARN --> LEARNINGS
    AGENT --> SNAPS
    SNAPS --> CHKJSON
    TOOLS --> BACKUPS
    PSKILLS --> SKILLS
    PHOOKS --> HOOKS
```

![Architecture](docs/architecture.png)

Mermaid source: [docs/architecture.mermaid](docs/architecture.mermaid)<br/>
Render: `mmdc -i docs/architecture.mermaid -o docs/architecture.png -w 2400 -H 3600 -b white -s 2`

## Tools

| Category | Tools |
|----------|-------|
| File | `read` `write` `edit` `file_multi_edit` `file_replace` `file_insert` `file_delete` `file_copy` `file_move` `file_exists` `file_patch` |
| Search | `glob` `grep` `directory_list` `directory_create` |
| Shell | `bash` `monitor` `task_stop` `git` `workspace` |
| Quality | `lint` `test` `format` `code_health` `test_quality_check` |
| Web | `web_search` `web_fetch` `gh` |
| Task | `todo_write` `todo_read` `task` `skill` `question` |

## Commands

| Command | Description |
|---------|-------------|
| `/help` | List commands |
| `/init` | Initialize AGENTS.md for current project |
| `/archive` | Archive session + summary, start new |
| `/history` | Browse past sessions or message history |
| `/view` | View a session in detail |
| `/rename` | Rename a session |
| `/delete` | Delete a session |
| `/clear` | Clear current session |
| `/reset` | Reset agent state |
| `/new` | Start fresh session |
| `/summary` | Session progress summary |
| `/compact` | Compress context |
| `/checkpoint` | Checkpoint management (list, show, restore, clean) |
| `/skill` | Skill management (list, install, uninstall) |
| `/mcp` | MCP management (status, init, tools, disconnect) |
| `/status` | Session status (tokens, model, branch) |
| `/queue` | Show or undo queued inputs |
| `/q` | Shortcut for /queue |

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
