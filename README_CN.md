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

> 源码: [docs/architecture_cn.mermaid](docs/architecture_cn.mermaid)。渲染: [docs/architecture_cn.png](docs/architecture_cn.png)

```mermaid
graph TB
    subgraph PRES["🎨 展示层 Presentation"]
        direction TB
        TUI["<b>TUI 模式</b><br/>全屏终端<br/>screenManager / scrollback<br/>状态栏 / thinking 动画"]
        SIMPLE["<b>简单模式</b><br/>--no-tui / 非 TTY<br/>readline / 纯文本输出"]
        CMD["<b>斜杠命令</b><br/>/help /init /history /summary<br/>/compact /archive /view /rename<br/>/delete /clear /reset /new<br/>/checkpoint list|show|restore|clean<br/>/skill list|install|uninstall<br/>/mcp status|init|tools|disconnect<br/>/queue /q /undo /status"]
        IQ["<b>输入队列</b><br/>最多 50 条 / 处理期间缓冲<br/>/queue 查看 / /undo 撤销<br/>处理完成后自动排空"]
        UI["<b>UI 组件</b><br/>diff 渲染 / spinner<br/>流式输出 / bracketed paste<br/>fixedBox / tableRenderer / scrollback"]
    end

    subgraph APP["⚙️ 应用层 Application"]
        direction TB
        AGENT["<b>SpicaAgent</b> (src/agent.ts)<br/>EventEmitter 编排器<br/>_fullHistory (追加持久化)<br/>getContextMessages (LLM 上下文)<br/>工具冲突检测<br/>消息自动清理<br/>危险命令扫描"]
        GATE["<b>Skill Gate</b> (src/cli/skillGate.ts)<br/>8 个意图分类<br/>SKILL HINT 注入<br/>路径匹配 / 工具白名单"]
        EVENTS["<b>事件总线 (42 事件)</b><br/>核心: stream · reasoning · message<br/>工具: tool_call · tool_result<br/>压缩: context_compressed · context_warning<br/>子代理: sub_agent_start/done/error<br/>  sub_agent_tool_call/tool_result<br/>  sub_agent_message/reasoning/stream<br/>监控: monitor_event · monitor_error<br/>Hooks: hook_blocked/warning/log<br/>+ 14 更多 (详见 agent.ts emits)"]
        INTR["<b>中断处理</b><br/>AbortController 每请求独立<br/>cancelSeq 高水位标记<br/>SIGKILL 杀进程组<br/>ESC×2 触发 / 200ms 去抖<br/>保留部分工具结果不丢失"]
        SESSION["<b>会话 & 归档</b><br/>两态模型 (解耦)<br/>活跃 → session.json<br/>历史 → sessions/&lt;id&gt;.json<br/>归档时 LLM 生成摘要<br/>自动清理 (保留 50)"]
        SUB["<b>子代理 (4 种类型)</b><br/>explore: 只读 (90s→180s)<br/>review: +lint (120s→240s)<br/>fix: +edit (180s→360s)<br/>build: 全部工具 (300s→600s)<br/>自适应: prompt 长度加成<br/>worktree 隔离选项<br/>最多 3 并行 / 提前退出信号<br/>per-task 模型覆盖"]
        PMON["<b>ProcessMonitor</b><br/>PID 追踪 / 进程组强杀<br/>卡死检测 (SIGKILL)<br/>超时管理"]
        LEARN["<b>教训系统</b><br/>自动检测用户纠正<br/>保存到 .spica/learnings/<br/>YYYY-MM-DD-topic.md<br/>启动时注入系统提示"]
    end

    subgraph DOMAIN["🧠 领域层 Domain"]
        direction TB
        LLM["<b>LLMClient</b><br/>OpenAI 兼容流式接口<br/>temperature=0.3<br/>stream + reasoning 双通道<br/>rate limiter · 指数退避重试<br/>abort-controller 去重"]
        PROV["<b>Provider</b> (OpenAICompatible.ts)<br/>单一适配器对接所有 API<br/>model: 默认 / models: 别名→ID 映射<br/>resolveModel() 自动解析<br/>分隔前缀缓存 (stable+variable)<br/>OpenAI · DeepSeek · Gemini<br/>Groq · Anthropic 代理 · 本地"]
        TOK["<b>TokenCounter + 压缩 v2</b><br/>tiktoken 真实 tokenizer<br/>缓存前缀感知截断<br/>分级保留 (10–25 条)<br/>双阶段: 规则截断 + LLM 摘要<br/>重度丢弃同步等待摘要 (>50%)<br/>per-role 内容限制 (自适应)<br/>60% 触发 / 目标 40%"]
        TOOLS["<b>33 工具</b> (registry.ts + impl/)<br/>📁 文件 (11) · 🔍 搜索 (4)<br/>💻 Shell (5): bash (沙箱)<br/>✅ 质量 (5) · 🌐 Web (3) · 📋 任务 (5)<br/>自动: 语法检查 · 工具缓存 (30s TTL)<br/>沙箱 (bwrap) · replace_all 检测<br/>详见下方工具表"]
        MCP["<b>MCP 客户端</b><br/>@modelcontextprotocol/sdk<br/>外部工具服务器<br/>内置: playwright"]
        HOOKS["<b>Hooks 系统</b><br/>PreToolUse / PostToolUse<br/>block · confirm · warn · log<br/>全局 + 项目双层级<br/>项目 ≤ 全局严格度"]
        SKILLS["<b>14 内置技能</b><br/>brainstorming · systematic-debugging<br/>test-driven-development · verification<br/>executing-plans · writing-plans<br/>dispatching-parallel-agents<br/>subagent-driven-development<br/>requesting-code-review · receiving<br/>finishing-a-development-branch<br/>using-git-worktrees · writing-skills<br/>using-superpowers"]
    end

    subgraph INFRA["💾 基础设施层 Infrastructure"]
        direction TB
        GLOBAL["<b>~/.spica/settings.json</b><br/>providers (含模型别名)<br/>MCP servers · skills · hooks<br/>chmod 600 / .gitignore 保护"]
        ACTIVE["<b>.spica/session.json</b><br/>活跃 / 追加写入<br/>压缩不截断历史"]
        HIST["<b>.spica/sessions/&lt;id&gt;.json</b><br/>历史 / 每次归档一份<br/>LLM 或本地摘要"]
        STATE["<b>.spica/state.json</b><br/>todos / decisions"]
        TASKS["<b>.spica/tasks.json</b><br/>持久化任务列表<br/>启动时自动恢复"]
        LEARNINGS["<b>.spica/learnings/</b><br/>YYYY-MM-DD-topic.md<br/>启动时注入"]
        SNAPS["<b>.spica/snapshots/</b><br/>checkpoint 文件快照<br/>自动清理 (保留 20)"]
        CHKJSON["<b>.spica/checkpoints.json</b><br/>元数据索引"]
        BACKUPS["<b>.spica/backups/</b><br/>write/edit 时自动备份"]
        PSKILLS["<b>.spica/skills.json<br/>.spica/skills/</b><br/>项目级技能覆盖"]
        PHOOKS["<b>.spica/hooks.json</b><br/>项目级 hooks 覆盖<br/>严格度须 ≥ 全局"]
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

![架构图](docs/architecture_cn.png)

Mermaid 源码: [docs/architecture_cn.mermaid](docs/architecture_cn.mermaid)<br/>
渲染: `mmdc -i docs/architecture_cn.mermaid -o docs/architecture_cn.png -w 2400 -H 3600 -b white -s 2`

## 工具

| 类别 | 工具 |
|------|------|
| 文件 | `read` `write` `edit` `file_multi_edit` `file_replace` `file_insert` `file_delete` `file_copy` `file_move` `file_exists` `file_patch` |
| 搜索 | `glob` `grep` `directory_list` `directory_create` |
| Shell | `bash` `monitor` `task_stop` `git` `workspace` |
| 质量 | `lint` `test` `format` `code_health` `test_quality_check` |
| Web | `web_search` `web_fetch` `gh` |
| 任务 | `todo_write` `todo_read` `task` `skill` `question` |

## 命令

| 命令 | 说明 |
|------|------|
| `/help` | 命令列表 |
| `/init` | 为当前项目初始化 AGENTS.md |
| `/archive` | 归档会话+摘要，开始新会话 |
| `/history` | 浏览历史会话或消息历史 |
| `/view` | 查看会话详情 |
| `/rename` | 重命名会话 |
| `/delete` | 删除会话 |
| `/clear` | 清空当前会话 |
| `/reset` | 重置 agent 状态 |
| `/new` | 开始全新会话 |
| `/summary` | 当前会话进度摘要 |
| `/compact` | 压缩上下文 |
| `/checkpoint` | Checkpoint 管理（列表、查看、恢复、清理） |
| `/skill` | Skill 管理（列表、安装、卸载） |
| `/mcp` | MCP 管理（状态、初始化、工具、断开） |
| `/status` | 会话状态（token、模型、分支） |
| `/queue` | 显示或撤销排队输入 |
| `/q` | /queue 的快捷方式 |

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
