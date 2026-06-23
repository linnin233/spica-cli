# 技术文档文风

用于 README、MANUAL、CONTRIBUTING 等技术文档写作。

---

## 核心原则

**一句话说清楚**——不铺垫，不解释，直接说。

```
✓ spica - AI coding agent CLI，帮你写代码、改代码、跑命令。
✗ spica 是一个强大的 AI 编程助手工具，可以帮助您高效地完成各种编程任务...
```

---

## 句式

**短句为主**——每句不超过20字。用换行分隔，不用逗号堆砌。

```
✓ 安装:
npm install -g spica

✓ 使用:
spica              启动
spica run "fix bug"   执行单次任务

✗ 安装非常简单，只需要运行 npm install -g spica 命令即可完成安装过程...
```

**命令+作用**——先给命令，再说作用。一行一个。

```
✓ spica              启动交互模式
✓ spica run "fix bug"   执行单次任务
✓ spica set deepseek https://api.deepseek.com/v1 sk-xxx deepseek-chat

✗ 启动交互模式请使用 spica 命令，执行单次任务请使用 spica run 命令...
```

---

## 词汇

**不用修饰词**——"强大的"、"高效的"、"优秀的"、"智能的"、"完整的"、"全面的"。

```
✓ 33个工具：文件、shell、git、web等
✓ 自动重试：失败后自动换方式重试
✓ checkpoint：文件快照，不污染git历史

✗ 拥有强大的33个内置工具，包括高效的文件操作和智能的git管理...
```

**技术词直接写**——不翻译，不解释。读者知道就是知道，不知道就去查。

```
✓ session管理、checkpoint、coding agent、LLM、API
✗ "会话管理（session）"、"检查点（checkpoint）"、"编程代理（coding agent）"...
```

**定性描述**——不给具体数字，给感觉。

```
✓ 长度应该控制在简洁可读的长度
✓ 聊天记录很大程度上是开发者的资产
✓ 绝大部分时候不会回去历史session

✗ 长度控制在200字以内
✗ 聊天记录80%是开发者的资产
✗ 90%的时候不会回去历史session
```

---

## 结构

**标题：一句话**——不解释标题。

```
✓ ## 安装
✓ ## 使用
✓ ## 特性

✗ ## 如何安装 spica
✗ ## spica 的使用方法
✗ ## spica 的主要特性介绍
```

**列表：一行一事**——不堆砌，不解释。

```
✓ 特性:
- 33个工具
- 自动重试
- checkpoint支持
- MCP扩展

✗ 特性:
- 拥有33个内置工具，包括文件读写、shell执行、git操作、web请求等多种功能
- 自动重试机制会在命令失败时自动换方式重试，确保任务完成
- checkpoint支持让您可以随时回退到之前的状态...
```

**代码块直接给**——不解释"以下是安装命令"。

```
✓ 安装:
```bash
npm install -g spica
```

✗ 安装非常简单，只需要执行以下命令即可:
```bash
npm install -g spica
```
```

---

## 段落

**不写过渡句**——"接下来我们来看..."、"让我们了解..."、"首先..."。

```
✓ ## 安装
...
## 使用
...

✗ 接下来我们来看如何使用 spica...
首先我们需要了解安装方法...
让我们来了解一下主要特性...
```

**不写总结句**——"以上就是..."、"总之..."、"总结来说..."。

```
✓ （列表结束，直接下一节）

✗ 以上就是 spica 的主要特性。总之，spica 是一个非常实用的工具...
```

---

## 英文与中文

**英文直接嵌入**——技术内容用英文，不翻译。

```
✓ session管理
✓ /archive归档
✓ checkpoint混乱
✓ MCP扩展

✗ "会话管理"、"归档命令"、"检查点混乱"、"模型上下文协议扩展"
```

**命令用英文**——不改写，不解释。

```
✓ spica run "fix bug"
✓ spica set deepseek https://api.deepseek.com/v1 sk-xxx deepseek-chat

✗ spica 执行 "修复bug"
✗ spica 设置 deepseek 使用以下配置...
```

---

## 禁止

**禁止的修饰词**——强大的、高效的、优秀的、智能的、完整的、全面的、极其、非常。

**禁止的过渡句**——接下来、让我们、首先、然后、最后、以上就是、总之、总结来说。

**禁止的解释句**——"以下是..."、"这个功能可以..."、"您可以使用..."、"需要注意的是..."。

**禁止的问候**——您好、欢迎、感谢、谢谢。

---

## 示例

**README 示例**：

```markdown
# spica - AI coding agent CLI

帮你写代码、改代码、跑命令。

安装:
npm install -g spica

使用:
spica              启动
spica run "fix bug"   执行单次任务
spica set deepseek https://api.deepseek.com/v1 sk-xxx deepseek-chat

特性:
- 33个工具：文件、shell、git、web等
- 自动重试：失败后换方式重试
- checkpoint：文件快照，不污染git

/session管理:
- 自动加载上次对话
- /archive归档+新建
- /history查看历史（只读）

不然会有问题:
- checkpoint混乱
- 代码进度与聊天进度不统一
```

---

## 更新日志

- 2026-06-08: 基于6月8日对话语料，专门用于技术文档写作