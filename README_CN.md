# spica - AI coding agent CLI

```
              _)
   __|  __ \   |   __|   _` |
 \__ \  |   |  |  (     (   |
 ____/  .__/  _| \___| \__,_|
       _|
```

终端里的 AI coding agent。帮你写代码、改代码、跑命令——交互式和单任务都行。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue.svg)](https://www.typescriptlang.org/)

[English](README.md) | [中文](README_CN.md)

## 安装

```bash
git clone https://github.com/zisonzishen0415-stack/spica-cli
cd spica-cli
npm install && npm run build && npm link
```

## 使用

```bash
spica set <name> <base-url> <api-key> <model>   # 添加 provider
spica use <name>                                 # 切换到该 provider
spica                                            # 交互模式
spica run "fix the bug"                          # 单次任务
```

## 特性

- **工具批处理** — 并行读取、并行写入（同文件冲突检测），每轮一次 LLM 往返
- **tiktoken 精确计数** — 真实 tokenizer 而非估算，60% 窗口触发压缩
- **双阶段压缩** — 即时规则截断 + 后台 LLM 摘要
- **8K 输出截断** — 大结果自动截断，按需 `offset`/`limit` 再读
- **Prompt cache 感知** — 消息前缀稳定化，命中 OpenAI 缓存
- **Checkpoint** — 文件快照存 `.spica/snapshots/`，不污染 git，自动清理
- **Learnings** — `.spica/learnings/` 持久化你的纠正，跨 session 生效
- **会话管理** — `/archive`、`/clear`、`/history`；归档+摘要，不丢记录
- **14 个内置 skill** — brainstorming、TDD、debugging、code review 等
- **中断安全** — ESC ESC 中断，tool 结果和消息序列不损坏
- **子代理** — `task` 工具分派 3 个并行代理
- **Windows 兼容** — PowerShell 回退，跨平台 bin 脚本
- **MCP 扩展** — Model Context Protocol 接入外部工具
- **TUI** — 流式输出、思考动画、compact 模式、resize 处理

## 架构

```mermaid
graph TB
    subgraph Presentation["Presentation 层"]
        TUI["TUI 模式\n全屏终端"]
        Simple["简单模式\n--no-tui"]
        Cmds["CLI 命令\n/archive /compact ..."]
        InputQ["输入队列\n处理期间缓冲"]
        UIComp["UI 组件\nspinner, diff, scrollback"]
    end

    subgraph Application["Application 层"]
        Agent["<b>SpicaAgent</b>\nEventEmitter 编排器\nprocessInput / executeTools\n_fullHistory / provider.messages"]
        Events["事件总线\nstream, tool_call, tool_result\nmessage, interrupt, done"]
        Interrupt["中断处理\nAbortController\ncancelSeq"]
        Session["会话与归档\n两态模型\nsaveSession / archiveSession"]
        Subagent["子代理\nexplore / review / fix / build"]
    end

    subgraph Domain["Domain 层"]
        LLM["LLMClient\nOpenAI 兼容流式\nRateLimiter, TokenCounter"]
        Providers["LLM 供应商\nOpenAI, Anthropic\nDeepSeek, Gemini, Groq"]
        Tools["工具系统\n33 个内置工具\nfile, bash, git, grep, glob"]
        MCP["MCP 客户端\n外部工具服务器"]
        Skills["技能与钩子\n14 个内置技能\nPreToolUse / PostToolUse"]
    end

    subgraph Infrastructure["Infrastructure 层"]
        GlobalCfg["全局配置\n~/.spica/\nproviders, MCP, hooks"]
        ActiveSess["活跃会话\n.spica/session.json\n追加写入，永不截断"]
        HistSess["历史会话\n.spica/sessions/&lt;id&gt;.json\n每会话一份"]
        ProjState["项目状态\n.spica/state.json\ntodos, decisions"]
    end

    %% 数据流
    TUI --> InputQ
    Simple --> InputQ
    InputQ --> Agent
    Cmds --> Agent
    Agent <--> LLM
    Providers --> LLM
    LLM --> Agent
    Agent --> Tools
    MCP --> Tools
    Tools --> Agent
    Agent --> Events
    Events --> UIComp
    Interrupt --> Agent
    Agent --> Session
    Session --> ActiveSess
    ActiveSess --> HistSess
    Agent --> Subagent
    Subagent --> Agent
    Agent --> ProjState
    GlobalCfg --> LLM
    Skills --> Agent
    Skills --> Tools
```

![架构图](docs/architecture_cn.png)

## 工具

| 类别 | 工具 |
|------|------|
| 文件 | `file_read` `file_write` `file_edit` `file_multi_edit` `file_replace` `file_insert` `file_delete` `file_copy` `file_move` `file_exists` `file_patch` |
| 搜索 | `glob` `grep` `directory_list` `directory_create` |
| Shell | `bash` `monitor` `task_stop` `git` `workspace` |
| 质量 | `lint` `test` `format` `code_health` `test_quality_check` |
| Web | `web_search` `web_fetch` `gh` |
| 任务 | `todo_write` `todo_read` `task` `skill` `question` |

## 命令

| 命令 | 说明 |
|------|------|
| `/help` | 命令列表 |
| `/archive` | 归档会话+摘要，开始新会话 |
| `/history` | 浏览历史会话（只读） |
| `/summary` | 当前会话进度摘要 |
| `/compact` | 压缩上下文 |
| `/checkpoint` | Checkpoint 管理 |
| `/skill` | Skill 管理 |
| `/mcp` | MCP 管理 |
| `/status` | 会话状态 |

## 配置

```
~/.spica/settings.json    # 全局
<project>/.spica/         # 项目级
```

## 开发

```bash
npm run dev      # 开发模式 (tsx)
npm run build    # 构建
npm test         # 测试 (vitest)
npm run lint     # lint
```

## 文档

- [MANUAL.md](docs/MANUAL.md)
- [CONTRIBUTING.md](docs/CONTRIBUTING.md)

## License

MIT
