# spica-cli User Manual

---

## CLI Commands

### Provider Management

```bash
spica set <name> <url> <apiKey> [model]  # Add/update provider
    --models fast:id1,pro:id2            #   with model aliases
spica use <name>                         # Switch default provider
spica list                               # List all providers
spica show [name]                        # Show provider details
spica remove <names...>                  # Remove providers
spica remove --all                       # Remove all providers
```

Example:
```bash
# Add provider with multiple models
spica set deepseek https://api.deepseek.com/v1 sk-xxx deepseek-v4-pro \
  --models fast:deepseek-v4-flash,pro:deepseek-v4-pro

spica use deepseek
spica list
# Output:
# ● deepseek (default)
# ○ openai
```

### Model Alias Management

```bash
spica models list [provider]              # List model aliases
spica models set <provider> <alias> <id>  # Add alias (e.g., fast → model-id)
spica models remove <provider> <alias>    # Remove alias
spica models default <provider> <alias>   # Change default model
spica models resolve <provider> [alias]   # Resolve alias → actual model ID
```

Each provider has one `model` (default) and optional `models` (alias→ID map).
Subagents can use `"model": "fast"` to select a specific model via alias.
If the value looks like a real model ID (contains digits or `-`), it is used directly
without going through the alias map.

### Session

```bash
spica              # Start interactive session (auto-load history)
spica --fresh      # Start fresh session (no history)
spica --no-tui     # Run in non-interactive mode (simple output)
spica run "task"   # Execute single task and exit
spica -p <name>    # Use specific provider
```

---

## Interactive Commands (TUI)

### Help & Status

| Command | Description |
|---------|-------------|
| `/help` or `/h` | Show all commands |
| `/status` | Show session status (messages, context usage, queue) |

### Session Management

| Command | Description |
|---------|-------------|
| `/archive` or `/new` or `/clear` | Archive current & start new |
| `/history` or `/sessions` | Browse archived chats (read-only) |
| `/view <id>` | Read specific archived chat |
| `/summary` | Summarize current session |
| `/compact` | Compress context to reduce token usage |
| `/rename <id> <name>` | Rename a session |
| `/delete <id>` | Delete a session |

### Input Queue

| Command | Description |
|---------|-------------|
| `/queue` or `/q` | Show input queue status |
| `/undo` | Remove last queued input |

### Skill Management

| Command | Description |
|---------|-------------|
| `/skill` or `/skill list` | List available skills |
| `/skill install <url>` | Install skill package |
| `/skill uninstall <name>` | Uninstall skill package |
| `/skill add <name> [template]` | Add custom skill |
| `/skill remove <name>` | Remove skill |
| `/skill edit <name> <template>` | Edit skill template |
| `/<skill-name> [args]` | Execute a skill |

### MCP Management

| Command | Description |
|---------|-------------|
| `/mcp` or `/mcp status` | Show MCP server status |
| `/mcp init` | Create example MCP config |
| `/mcp tools` | List available MCP tools |
| `/mcp disconnect` | Disconnect all MCP servers |

### Ideas & Subagents

| Command | Description |
|---------|-------------|
| `/idea` | Enter idea capture workspace |
| `/idea <text>` | Quick add an idea |
| `/ideas` | List all ideas |
| `/idea-done <id>` | Mark idea as done |
| `/idea-delete <id>` | Delete an idea |
| `/idea-open <id>` | Re-open a done idea |
| `/subagents` | View subagent dispatch history |

### Project

| Command | Description |
|---------|-------------|
| `/init` | Generate AGENTS.md for current project |

---

## Tools

### File Operations (11 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `read` | Read file content | path, offset, limit |
| `write` | Write/create file | path, content |
| `edit` | Edit by exact replacement | path, oldString, newString, replace_all |
| `file_multi_edit` | Multiple edits at once | path, edits[] |
| `file_replace` | Regex replacement | path, pattern, replacement, flags, all |
| `file_insert` | Insert at line or pattern | path, line, content, after, before |
| `file_patch` | Apply unified diff patch | path, patch |
| `file_exists` | Check if exists | path |
| `file_delete` | Delete file/directory | path |
| `file_copy` | Copy file | source, destination |
| `file_move` | Move/rename file | source, destination |

### Directory & Search (4 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `directory_create` | Create directory (nested) | path |
| `directory_list` | List directory contents | path |
| `glob` | Pattern match files | pattern, path, ignore, maxFiles |
| `grep` | Search file contents | pattern, path, include, maxLines |

### Shell & Git (6 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `bash` | Execute shell command | command, timeout, detached, interactive, maxOutputLength, sandbox |
| `monitor` | Background monitor task | command, description, timeout, persistent |
| `task_stop` | Stop background task | task_id |
| `reply_subagent` | Reply to subagent question | task_id, answer |
| `git` | Git operations | action, args |
| `workspace` | Change working directory | path |

### Web & GitHub (3 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `web_search` | Web search | query, engine, timeout |
| `web_fetch` | Fetch URL content | url, timeout |
| `gh` | GitHub CLI | action, args |

### Task & Quality (7 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `todo_write` | Write todo list | todos[] |
| `todo_read` | Read todo list | - |
| `task` | Parallel sub-agent | tasks[] (description, prompt, type, model, isolation) |
| `skill` | Execute skill | name, args |
| `lint` | Code linting | fix, files |
| `test` | Run tests | filter, coverage |
| `format` | Format code | path |

### Other (4 tools)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `question` | Ask user | text |
| `code_health` | Analyze code quality | path, threshold |
| `test_quality_check` | Detect test anti-patterns | testFile, threshold |

---

## Bash Tool Modes

```json
// Normal execution
{ "command": "ls -la" }

// Sandboxed (bwrap: read-only system, no network, writable workspace only)
{ "command": "rm -rf /tmp/build", "sandbox": true }

// Detached (background)
{ "command": "npm run dev", "detached": true }

// Interactive (AI provides input)
{ "command": "npm run dev", "interactive": true }

// With timeout
{ "command": "npm test", "timeout": 60000 }
```

---

## Monitor Tool

Background task monitoring - streams stdout as events.

```json
// Start monitoring a log file
{ "command": "tail -f /var/log/app.log", "description": "Watch app logs" }

// Monitor with custom timeout (default 300s, max 3600s)
{ "command": "npm run dev", "description": "Dev server", "timeout": 600 }

// Persistent mode (no timeout, runs until stopped)
{ "command": "npm run dev", "description": "Dev server", "persistent": true }

// Stop a running monitor
{ "task_id": "monitor_1234567890_abc123" }
```

Monitor events are streamed via `monitor_event`:
- `task_id` - Monitor task identifier
- `description` - Task description
- `line` - Output line
- `timestamp` - Event timestamp

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Submit input |
| `ESC ESC` | Interrupt current operation |
| `Ctrl+C` (3x) | Force exit |
| `Ctrl+O` | Toggle verbose/compact mode |
| `Tab` | Command completion |
| `Backspace` | Delete character |
| `Arrow keys` | Move cursor |

---

## Config Location

### Global (~/.spica/)

```
~/.spica/
├── settings.json     # Providers, MCP, Hooks, Skills
├── history.json      # Command history
├── sessions/         # Archived sessions
├── skills/           # Skill packages
└── learnings/        # Global learnings
```

### Project (<project>/.spica/)

```
<project>/.spica/
├── session.json      # Current session messages
├── sessions/         # Archived sessions
├── state.json        # Project state
├── tasks.json        # Task persistence
├── ideas.json        # Captured ideas
├── backups/          # Auto-backups on write/edit
├── hooks.json        # Project-level hook overrides
├── skills.json       # Project-level skill config
├── skills/           # Project-level skill packages
└── learnings/        # Project learnings
```

---

## Local Models

```bash
# llama.cpp
llama-server -m llama.gguf --port 8000
spica set local http://localhost:8000/v1 dummy llama

# Ollama
ollama serve
spica set ollama http://localhost:11434/v1 dummy llama3

# vLLM
python -m vllm.entrypoints.openai.api_server --model <model>
spica set vllm http://localhost:8000/v1 dummy <model>
```

---

## MCP Config Example

```json
{
  "mcp": {
    "servers": [
      {
        "name": "filesystem",
        "command": "npx",
        "args": ["-y", "@anthropic-ai/mcp-server-filesystem", "/path"]
      },
      {
        "name": "brave-search",
        "command": "npx",
        "args": ["-y", "@anthropic-ai/mcp-server-brave-search"],
        "env": { "BRAVE_API_KEY": "your-key" }
      }
    ]
  }
}
```

---

## Hooks Config Example

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": { "tool": "bash", "args": { "command": "*rm -rf*" } },
        "action": "confirm",
        "message": "Confirm deletion?"
      },
      {
        "matcher": { "tool": "bash", "args": { "command": "*--force*" } },
        "action": "block",
        "message": "Force operations blocked"
      }
    ],
    "PostToolUse": [
      {
        "matcher": { "tool": "write" },
        "action": "log",
        "message": "File written"
      }
    ]
  }
}
```

---

## Skills Config Example

```json
{
  "skills": {
    "review": {
      "name": "review",
      "description": "Code review for specified files",
      "promptTemplate": "Review these files: {input}. Check for bugs, style, and improvements.",
      "allowedTools": ["read", "grep", "glob"]
    },
    "debug": {
      "name": "debug",
      "description": "Debug an issue",
      "promptTemplate": "Debug this issue: {input}"
    }
  }
}
```

---

## See Also

- [CONTRIBUTING.md](CONTRIBUTING.md) - Contributing guide