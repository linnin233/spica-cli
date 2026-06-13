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
        TUI["<b>TUI 模式</b><br/>全屏终端 · screenManager<br/>scrollback · 状态栏 · thinking 动画"]
        SIMPLE["<b>简单模式</b><br/>--no-tui / 非 TTY<br/>readline · 纯文本输出"]
        CMD["<b>斜杠命令</b>（16 个处理器）<br/>/help /init /history /summary /compact<br/>/archive /view /rename /delete /clear<br/>/reset /new /checkpoint /skill /mcp<br/>/queue /q /undo /status"]
        IQ["<b>输入队列</b><br/>最多 50 条 · 处理期间缓冲<br/>runLoop 完成后自动排空"]
        UI["<b>UI 组件</b><br/>diff 渲染 · spinner<br/>流式输出 · bracketed paste"]
    end

    subgraph APP["⚙️ 应用层 Application"]
        direction TB

        subgraph AGENT_SUB["SpicaAgent (src/agent.ts)"]
            direction TB
            AGENT["<b>核心循环</b><br/>runLoop(prompt, maxIter=50)<br/>  → applyPendingSummary<br/>  → token 检查（60% 触发）<br/>  → startNonBlockingCompression<br/>  → callLLMWithRetry（10 次，指数退避）<br/>  → syncFullHistory（provider→_fullHistory）<br/>  → executeTools（并行/批处理）<br/>  → 循环直到 LLM 返回纯文本<br/><br/><b>三重消息分离</b><br/>_fullHistory: 追加不截断，会话持久化<br/>provider.msgs: LLM API 上下文，可压缩<br/>toolDefs: 独立 `tools` API 参数"]
        end

        GATE["<b>Skill Gate</b><br/>8 种意图分类<br/>SKILL HINT 注入"]

        subgraph COMPRESS["压缩 v3 (src/core/compression.ts)"]
            direction TB
            COMP1["<b>阶段 1 — 规则截断</b>（即时生效）<br/>① 读取 cachePrefixEnd → 前缀消息免评分<br/>② 评分: user=10, write/bash=9, [COMPACTED]=10<br/>③ 分级保留: 15%-50%, 下限=10 上限=40%<br/>④ 逐角色限制: user=∞, tool=1.5×, 已截断=2×<br/>⑤ llm.setMessages → 恢复 cachePrefixEnd"]
            COMP2["<b>阶段 2 — LLM 摘要</b>（后台异步）<br/>buildSummaryPrompt: 工具名 + 500 字符结果<br/>重度丢弃 (>50%): 同步等待 → 立即注入<br/>轻度丢弃 (≤50%): 后台 → 延迟至下次使用"]
        end

        EVENTS["<b>事件总线（42 个事件）</b><br/>核心: stream · reasoning · message<br/>工具: tool_call · tool_result<br/>压缩: context_compressed · context_warning<br/>子代理: sub_agent_start/done/error<br/>  sub_agent_tool_call/tool_result<br/>监控: monitor_event · monitor_error<br/>Hooks: hook_blocked/warning/log"]
        INTR["<b>中断处理器</b><br/>每个 runLoop 独立 AbortController<br/>cancelSeq 高水位标记<br/>ESC×2 · 200ms 去抖<br/>保留部分工具结果"]
        SESSION["<b>会话 & 归档</b><br/>两态解耦模型<br/>活跃 → session.json（来源 _fullHistory）<br/>历史 → sessions/&lt;id&gt;.json<br/>归档时 LLM 摘要 · 保留 50"]
        SUB["<b>子代理（4 种类型）</b><br/>explore: 90s→180s · review: 120s→240s<br/>fix: 180s→360s · build: 300s→600s<br/>自适应超时 · worktree 隔离<br/>最多 3 并行 · 模型覆盖"]
        PMON["<b>ProcessMonitor</b><br/>PID 追踪 · SIGKILL 升级"]
        LEARN["<b>教训系统</b><br/>6 种纠正模式<br/>.spica/learnings/YYYY-MM-DD-topic.md<br/>注入可变系统提示词"]
    end

    subgraph DOMAIN["🧠 领域层 Domain"]
        direction TB

        subgraph LLM_SUB["LLMClient (src/llm/LLMClient.ts)"]
            LLM["<b>流式客户端</b><br/>temperature=0.3 · stream+reasoning<br/>速率限制（请求+token/分钟）<br/>重试: 10 次指数退避<br/><b>AbortSignal 去重</b><br/>linkExternalSignal + handler-ref 槽位<br/>防止 MaxListenersExceeded"]
        end

        PROV["<b>Provider</b> (OpenAICompatible.ts)<br/>单一适配器对接所有 API<br/>model+models 别名→ID 解析<br/><b>分隔前缀缓存</b><br/>msg[0]=stable（AGENTS.md ~3.8K tok）<br/>msg[1]=variable（skills, learnings）<br/>压缩时保留 cachePrefixEnd（v3）"]
        TOK["<b>TokenCounter + 压缩 v3</b><br/>tiktoken 真实分词器 (o200k_base)<br/>缓存前缀感知截断<br/>分级保留（10–25 条消息）<br/>双阶段: 规则截断 + LLM 摘要<br/>重度丢弃同步等待 (>50%)<br/>二次截断预防<br/>触发: 60% · 目标: 40%"]
        TOOLS["<b>33 个工具</b> (registry.ts + impl/)<br/>📁 文件 (11) · 🔍 搜索 (4)<br/>💻 Shell (5): bash(沙箱) monitor task_stop git workspace<br/>✅ 质量 (5) · 🌐 Web (3) · 📋 任务 (5)<br/>自动: 语法检查 · 工具缓存 (30s TTL)<br/>沙箱 (bwrap) · replace_all · 8K 输出截断"]
        MCP["<b>MCP 客户端</b><br/>@modelcontextprotocol/sdk<br/>外部工具服务器 · 内置: playwright"]
        HOOKS["<b>Hooks 系统</b><br/>PreToolUse / PostToolUse<br/>block · confirm · warn · log<br/>全局 + 项目双层 · 项目 ≤ 全局"]
        SKILLS["<b>14 个内置技能</b><br/>brainstorming · systematic-debugging<br/>test-driven-development · verification<br/>executing-plans · writing-plans<br/>dispatching-parallel-agents<br/>subagent-driven-development<br/>requesting-code-review · receiving<br/>finishing-a-development-branch<br/>using-git-worktrees · writing-skills<br/>using-superpowers"]
    end

    subgraph INFRA["💾 基础设施层 Infrastructure"]
        direction TB
        GLOBAL["<b>~/.spica/settings.json</b><br/>providers（模型别名）<br/>MCP servers · skills · hooks"]
        ACTIVE["<b>.spica/session.json</b><br/>活跃 · _fullHistory（永不截断）"]
        HIST["<b>.spica/sessions/&lt;id&gt;.json</b><br/>历史 · 每次归档一份"]
        STATE["<b>.spica/state.json</b> · todos/decisions"]
        TASKS["<b>.spica/tasks.json</b> · 自动恢复"]
        LEARNINGS["<b>.spica/learnings/</b> · YYYY-MM-DD-topic.md"]
        SNAPS["<b>.spica/snapshots/</b> · checkpoint 快照（保留 20）"]
        CHKJSON["<b>.spica/checkpoints.json</b> · 元数据索引"]
        BACKUPS["<b>.spica/backups/</b> · write/edit 自动创建"]
        PSKILLS["<b>.spica/skills.json · skills/</b> · 项目级覆盖"]
        PHOOKS["<b>.spica/hooks.json</b> · 须 ≥ 全局严格度"]
    end

    TUI --> IQ
    SIMPLE --> IQ
    CMD --> AGENT
    IQ --> AGENT
    AGENT <--> LLM
    PROV --> LLM
    TOK --> LLM
    LLM --> AGENT
    AGENT --> COMP1
    COMP1 --> COMP2
    TOK --> COMP1
    COMP2 -.-> AGENT
    AGENT --> TOOLS
    MCP --> TOOLS
    TOOLS --> AGENT
    AGENT --> EVENTS
    EVENTS --> UI
    INTR --> AGENT
    INTR --> LLM
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

> [精简版](docs/architecture-simplified.png) · [源码 (English)](docs/architecture.mermaid) · [源码 (中文)](docs/architecture_cn.mermaid)<br/>
> 渲染: `bash scripts/render-architecture.sh`

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
