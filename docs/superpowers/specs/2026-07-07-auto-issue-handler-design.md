# Auto Issue Handler — Design Spec

## Overview

为 spica-cli 添加自动 GitHub Issue 处理功能。spica 作为后台守护进程运行，定时轮询指定仓库的 issues，自动处理带有特定 label 的 bug issue，处理流水线为：复现 → 修复 → 测试 → 提交 PR。处理失败时自动在 issue 下留言并发送邮件通知。

## Trigger Modes

| Mode | Command | Description |
|------|---------|-------------|
| 后台守护 | `spica issue daemon` | 持续轮询，有 issue 就处理 |
| 一次性 | `spica issue once [repo]` | 处理所有未处理的 issues 后退出 |
| 单次调试 | `spica issue run <repo>#<n>` | 手动触发单个 issue |

## Architecture

```
spica issue daemon / once / run
  └── IssuePoller (轮询器)
       └── BugPipeline (5 阶段流水线)
            ├── Phase 1: Understand    理解 issue 内容
            ├── Phase 2: Reproduce     尝试复现 bug
            ├── Phase 3: Fix           SpicaAgent 修复
            ├── Phase 4: Verify        测试验证（硬门禁）
            └── Phase 5: Submit        创建分支 + PR
```

## Settings Extension

```json
{
  "github": {
    "token": "ghp_xxx",
    "repos": ["owner/repo1", "owner/repo2"],
    "pollInterval": 300,
    "labels": ["bug", "auto-fix"]
  },
  "email": {
    "host": "smtp.example.com",
    "port": 587,
    "user": "bot@example.com",
    "pass": "password",
    "to": "admin@example.com"
  }
}
```

## Module Design

### 1. GitHubClient (`src/issues/github.ts`)
- GitHub REST API 封装（fetch），无额外依赖
- Token 来自 settings.github.token
- 提供 listIssues / getIssue / addComment / createBranch / createPR
- Git 操作（clone/commit/push）通过 bash 执行

### 2. IssuePoller (`src/issues/poller.ts`)
- EventEmitter 模式
- 按 configurable interval 轮询
- 通过 state manager 去重（不重复处理）

### 3. BugPipeline (`src/issues/pipeline.ts`)
- 5 阶段串联，阶段间硬性门禁
- 任何阶段失败 → 退出 + 留言 + 邮件
- 绝对不越过 Phase 4 verify 创建 PR
- verify 失败时回退所有本地修改

### 4. Notifier (`src/issues/notify.ts`)
- 手写 SMTP 客户端（net 模块），纯文本邮件
- 无额外 npm 依赖

### 5. IssueStateManager (`src/issues/state.ts`)
- JSON 文件持久化 processed/processing/failed
- 重启恢复：stale processing 重新入队

### 6. Prompts (`src/issues/prompts.ts`)
- 各阶段 LLM prompt 模板集中管理

## Reproduce Strategy

```
REPRODUCED  → 写单测复现成功 → 进入 Fix
PARTIAL     → 找到根因但环境受限 → Fix，PR 标记 "needs verification"
CANNOT      → 无法复现 → STOP，留言 + 邮件请求更多信息
```

## Failure Handling

每个失败分支（Understand fail / CANNOT reproduce / Fix error / Verify fail）：
1. 在 issue 下留言说明原因和尝试过程
2. 发送邮件通知
3. 绝对不创建 PR、不 push 任何代码

## Safety Constraints

- 代理账号只有 PR 权限，无 merge 权限
- Clone 时 token 嵌入 URL，不落盘
- 所有代码修改在临时目录/worktree，verify 失败时丢弃
- PipeLine 阶段间硬门禁，不存在意外 fall-through

## Files

```
新增:
src/issues/
├── index.ts
├── github.ts
├── poller.ts
├── pipeline.ts
├── prompts.ts
├── notify.ts
└── state.ts

修改:
src/utils/settings.ts     (+可选字段 +helper 函数)
src/index.ts              (+1 行注册命令)

测试:
src/__tests__/issues/
├── github.test.ts
├── poller.test.ts
├── pipeline.test.ts
├── notify.test.ts
└── state.test.ts
```
