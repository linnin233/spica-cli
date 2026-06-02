#!/usr/bin/env node
import { Command } from 'commander';
import { SpicaAgent } from './agent';
import {
  loadGlobalSettings,
  saveGlobalSettings,
  getProviderConfig,
  setProviderConfig,
  listProviders,
  setDefaultProvider,
  GLOBAL_SETTINGS_FILE,
} from './utils/settings';
import { MCPServerConfig } from './utils/settings';
import { loadSession, saveSession } from './utils/session';
import { parseSkillInput, getSkill, buildSkillPrompt, listSkills, installSkill, uninstallSkill, listInstalledPackages, saveSkill, deleteSkill } from './skills';
import { runInit } from './cli/init';
import { getMCPManager, generateExampleConfig, shutdownMCP } from './mcp/client';
import { COLORS, format, BG } from './cli/ui/colors';
import { getInputQueue, clearInputQueue } from './cli/ui/queue';
import { autoDrainQueue } from './cli/queueDrain';
import { TUIInputHandler } from './cli/ui/tuiInput';
import { setupAgentEvents, formatRunStats } from './cli/events';
import { displayStatusLine } from './cli/status';
import { getRuntimeState, resetRuntimeState } from './core/RuntimeState';

import { getScreenManager } from './cli/ui/screenManager';
import { TokenCounter } from './llm/TokenCounter';
import * as readline from 'readline';
import prompts from 'prompts';
import fs from 'fs-extra';
import { join } from 'path';
import os from 'os';

const program = new Command();
const state = getRuntimeState();
const screen = getScreenManager();
const ESC = '\x1b';

// Ctrl+C中断处理（SIGINT - 在非 raw mode 或特殊情况下触发）
let interruptCount = 0;
let interruptTimeout: NodeJS.Timeout | null = null;
let tuiStarted = false;  // 标记 TUI 是否已启动

process.on('SIGINT', () => {
  // 连续Ctrl+C强制退出
  interruptCount++;
  if (interruptCount >= 3) {
    if (tuiStarted) screen.end();
    console.log(COLORS.error('\n[FORCE EXIT]'));
    process.exit(0);
  }

  // 重置计数器（1秒内没有第二次Ctrl+C）
  if (interruptTimeout) clearTimeout(interruptTimeout);
  interruptTimeout = setTimeout(() => {
    interruptCount = 0;
  }, 1000);

  if (state.getAgent()) {
    state.getAgent()!.interrupt();
    state.setProcessing(false);
    if (tuiStarted) {
      screen.appendScroll(COLORS.warning('\n[INTERRUPTED] Ctrl+C again to exit\n'));
      screen.setStreaming(false);
      screen.restoreCursor();
      screen.refreshInput();
    } else {
      console.log(COLORS.warning('\n[INTERRUPTED] Ctrl+C again to exit'));
    }
  } else {
    if (tuiStarted) screen.end();
    process.exit(0);
  }
});

program
  .name('spica')
  .description('AI coding assistant')
  .version('1.0.0')
  .addHelpText('after', '\nCommands:\n  spica                    Start session\n  spica run "task"         Execute one task\n  spica set name url key model  Add provider\n  spica use name           Switch provider\n  spica list               List providers\n  spica remove name...     Remove providers');

// 默认：持续对话模式（自动加载历史）
program
  .option('-f, --fresh', 'Start fresh session (no history)')
  .option('-p, --provider <name>', 'Use specific provider')
  .option('--no-tui', 'Run in non-interactive mode (no TUI, simple output)')
  .action(async (options: { fresh?: boolean; provider?: string; noTui?: boolean }) => {
    const config = await loadGlobalSettings();
    const providerName = options.provider || config.defaultProvider || 'openai';

    // 检测是否支持交互式终端
    const isInteractiveTerminal = process.stdin.isTTY && process.stdout.isTTY;
    const useSimpleMode = options.noTui || !isInteractiveTerminal;

    let providerConfig;
    try {
      providerConfig = await getProviderConfig(providerName);
      state.setProviderConfig(providerConfig);
    } catch (error: any) {
      console.log('');
      console.log(COLORS.error(error.message));
      console.log('');
      return;
    }

    const agent = new SpicaAgent(providerName, process.cwd());
    state.setAgent(agent);

    // 如果是非交互模式，使用简单输出
    if (useSimpleMode) {
      console.log(COLORS.muted('[INFO] Running in non-interactive mode (no TUI)'));
      await runSimpleMode(agent, options.fresh);
      return;
    }

    // 开始banner动画（并行）
    const bannerPromise = BG.banner();

    // TUI handler (defined before try to be accessible in catch)
    let tuiHandler: TUIInputHandler | null = null;

    try {
      await agent.init();

      // 停止banner动画
      BG.stopBanner();
      await bannerPromise;

      // 清屏，准备设置滚动区域
      screen.appendScroll(`${ESC}[2J${ESC}[1;1H`);

      // TUI 输入处理（设置滚动区域）
      tuiHandler = new TUIInputHandler();
      tuiHandler.start();
      tuiStarted = true;

      // 自动加载历史
      if (!options.fresh) {
        const session = loadSession(process.cwd());
        if (session && session.messages && session.messages.length > 0) {
          agent.setMessages(session.messages);
          // 显示加载历史提示（在滚动区域）
          
          screen.appendScroll(COLORS.muted(`Loaded ${session.messages.length} messages from history\n`));
        }
      }

      // Tab 补全命令列表
        const BASE_COMMANDS = [
          '/help', '/h', '/status', '/bypass', '/strict',
          '/queue', '/q', '/undo', '/clear', '/reset',
          '/skills', '/skill-add', '/skill-remove', '/skill-edit',
          '/history', '/compact', '/init',
        ];
      const getCommands = () => {
        const skills = listSkills(process.cwd());
        const skillCommands = skills.map(s => `/${s.name}`);
        return [...BASE_COMMANDS, ...skillCommands];
      };
      tuiHandler.getScreen().setCompleter((line: string) => {
        return getCommands().filter(c => c.startsWith(line));
      });

      // 显示状态栏（简洁版）
      // 状态栏：模型 | 模式 | 工作区（智能缩写长路径）
      const updateStatusBar = () => {
        const modeLabel = state.isBypassMode() ? '\x1b[33mBYPASS\x1b[0m' : '\x1b[32mSTRICT\x1b[0m';

        // 工作区路径显示（Windows 下缩写长路径）
        const workspace = agent.getWorkspacePath();
        const homeDir = os.homedir();
        let displayPath = workspace;

        // 缩写用户目录为 ~（跨平台）
        if (workspace.startsWith(homeDir)) {
          displayPath = '~' + workspace.slice(homeDir.length);
        }

        // Windows 下如果路径仍太长（超过 30 字符），显示最后两级目录
        if (displayPath.length > 30) {
          const parts = displayPath.split(/[/\\]/);
          if (parts.length > 2) {
            displayPath = '...' + parts.slice(-2).join('/');
          }
        }

        screen.setStatus(`${providerConfig.model} | ${modeLabel} | ${displayPath}`);
      };
      updateStatusBar();

      // TokenCounter 用于结束统计显示
      const provider = agent.getLLM()?.getProvider();
      const contextWindow = provider?.getContextWindow() || 128000;
      const tokenCounter = new TokenCounter();
      tokenCounter.setContextWindow(contextWindow);

      // 设置 Ctrl+O 切换回调
      screen.setVerboseToggleCallback(() => {
        const newMode = state.toggleVerboseMode();
        screen.appendScroll(COLORS.secondary(`\n[MODE] ${newMode ? 'Verbose' : 'Compact'} display enabled\n`));
        updateStatusBar();
        screen.restoreCursor();
        screen.refreshInput();
      });

      // 启用 Bracketed Paste Mode（粘贴内容作为整体到达）
      screen.appendScroll(`${ESC}[?2004h`);

      // 启用 rawMode
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }

      let isProcessing = false;
      let shouldExit = false;

      // stdin 监听 - 使用 TUIInputHandler
      process.stdin.on('data', (chunk: Buffer) => {
        const result = tuiHandler!.handleStdin(chunk.toString('utf8'), state.isPermissionDialogActive());

        // ESC ESC 中断
        if (result.isInterrupt) {
          if (state.getAgent()) {
            state.getAgent()!.interrupt();
            isProcessing = false;
            state.setProcessing(false);

            screen.appendScroll(COLORS.warning('\n[INTERRUPTED]\n'));
            screen.setStreaming(false);
            screen.restoreCursor();
            screen.refreshInput();
          }
          return;
        }

        // 退出
        if (result.shouldExit) {
          shouldExit = true;
          // 禁用 Bracketed Paste Mode
          screen.appendScroll(`${ESC}[?2004l`);
          tuiHandler!.end();
          screen.appendScroll(COLORS.error('\n[FORCE EXIT]'));
          process.exit(0);
          return;
        }

        // 处理输入
        if (result.shouldProcess && result.content.trim()) {
          handleInput(result.content.trim());
        }
      });

      // 设置agent事件监听
      setupAgentEvents(agent, true, providerConfig.model, tokenCounter);

      // TUI 输出辅助函数（已简化）

      // 输入处理函数
      const handleInput = async (line: string) => {
        const trimmed = line.trim();

        // quit/exit 命令始终有效
        if (trimmed === 'quit' || trimmed === 'exit') {
          shouldExit = true;
          if (isProcessing && state.getAgent()) {
            state.getAgent()!.interrupt();
          }
          // 禁用 Bracketed Paste Mode
          screen.appendScroll(`${ESC}[?2004l`);
          tuiHandler!.end();
          const messages = agent.getMessages();
          saveSession(process.cwd(), messages);
          await shutdownMCP();
          state.setAgent(null);
          screen.appendScroll(COLORS.muted(`\nSession saved (${messages.length} messages)\n`));
          screen.appendScroll(COLORS.muted('Goodbye!\n'));
          process.exit(0);
          return;
        }

        // 如果正在处理，使用队列累积输入
        if (isProcessing && !trimmed.startsWith('/')) {
          const queue = getInputQueue();
          queue.add(trimmed);
          const status = queue.getStatus();
          screen.appendScroll(COLORS.muted(`[QUEUE] Added (${status.pending} pending)\n`));
          return;
        }

        // CRITICAL FIX: 在处理前合并 queue（而不是结束后）
        const queue = getInputQueue();
        let finalInput = trimmed;
        if (queue.hasPending() && !trimmed.startsWith('/')) {
          finalInput = queue.mergePending() + '\n' + trimmed;
          screen.appendScroll(COLORS.muted(`[QUEUE] Merged ${queue.getStatus().total} inputs\n`));
        }

        if (!finalInput.trim()) {
          return;
        }

        if (trimmed === 'help') {
          showHelp();
          
          return;
        }

        // === / 命令 ===
        if (trimmed.startsWith('/')) {
          const cmd = trimmed.slice(1).toLowerCase();

          // 队列管理
          if (cmd === 'queue' || cmd === 'q') {
            const queue = getInputQueue();
            const status = queue.getStatus();
            
            screen.appendScroll(COLORS.primary.bold('\nInput Queue:\n'));
            screen.appendScroll(`  Pending: ${status.pending}\n`);
            if (status.pendingPreview.length > 0) {
              screen.appendScroll(COLORS.muted('  Recent:\n'));
              status.pendingPreview.forEach((p, i) => {
                screen.appendScroll(COLORS.muted(`    ${i + 1}. ${p}\n`));
              });
            }
            screen.appendScroll('\n');
            
            return;
          }

          if (cmd === 'undo') {
            const queue = getInputQueue();
            const removed = queue.undoLast();
            
            if (removed) {
              screen.appendScroll(COLORS.muted(`\n[QUEUE] Removed: ${removed.content}\n`));
            } else {
              screen.appendScroll(COLORS.muted('\n[QUEUE] No pending inputs\n'));
            }
            
            return;
          }

          if (cmd === 'clear' || cmd === 'reset') {
            agent.setMessages([]);
            clearInputQueue();

            screen.appendScroll(COLORS.muted('\n[OK] Session cleared\n'));

            return;
          }

          // 会话管理
          if (cmd === 'sessions' || cmd === 's') {
            const { listSessions } = await import('./utils/session');
            const { getTaskStats } = await import('./storage/taskPersistence');
            const sessions = listSessions(process.cwd());
            const taskStats = getTaskStats(process.cwd());
            const currentMsgs = agent.getMessages().length;

            screen.appendScroll(COLORS.primary.bold('\nSessions:\n'));
            screen.appendScroll(`  Current: ${currentMsgs} messages\n`);
            screen.appendScroll(`  Archived: ${sessions.length} sessions\n`);
            screen.appendScroll(`  Tasks: ${taskStats.total} (${taskStats.completed} done, ${taskStats.in_progress} active)\n`);

            if (sessions.length > 0) {
              screen.appendScroll(COLORS.muted('\n  Recent sessions:\n'));
              sessions.slice(0, 5).forEach((s, i) => {
                const date = new Date(s.lastActivity).toLocaleDateString();
                screen.appendScroll(COLORS.muted(`    ${i + 1}. ${s.name} (${s.messageCount} msgs, ${date})\n`));
              });
              if (sessions.length > 5) {
                screen.appendScroll(COLORS.muted(`    ... and ${sessions.length - 5} more\n`));
              }
            }

            screen.appendScroll(COLORS.muted('\n  Commands: /switch <id>, /rename <name>, /delete <id>\n'));
            screen.appendScroll('\n');

            return;
          }

          if (cmd.startsWith('switch ')) {
            const sessionId = cmd.slice(7).trim();
            const { switchSession } = await import('./utils/session');

            if (switchSession(process.cwd(), sessionId)) {
              screen.appendScroll(COLORS.success(`\n[OK] Switched to session ${sessionId}\n`));
              screen.appendScroll(COLORS.muted('Session loaded. Continue conversation.\n'));
            } else {
              screen.appendScroll(COLORS.error(`\n[ERR] Session ${sessionId} not found\n`));
              screen.appendScroll(COLORS.muted('Use /sessions to list available sessions.\n'));
            }

            return;
          }

          if (cmd.startsWith('rename ')) {
            const args = cmd.slice(7).trim();
            const parts = args.split(' ');
            const sessionId = parts[0];
            const newName = parts.slice(1).join(' ') || 'Unnamed';
            const { renameSession } = await import('./utils/session');

            if (renameSession(process.cwd(), sessionId, newName)) {
              screen.appendScroll(COLORS.success(`\n[OK] Session renamed to: ${newName}\n`));
            } else {
              screen.appendScroll(COLORS.error(`\n[ERR] Failed to rename session ${sessionId}\n`));
            }

            return;
          }

          // 权限模式 (bypass / strict)
          if (cmd === 'bypass') {
            agent.setBypassPermissions(true);
            state.setBypassMode(true);
            screen.appendScroll(COLORS.warning('\n[BYPASS] Auto-approve mode activated\n'));
            return;
          }
          if (cmd === 'strict') {
            agent.setBypassPermissions(false);
            state.setBypassMode(false);
            screen.appendScroll(COLORS.success('\n[STRICT] Permission mode activated\n'));
            return;
          }

          // 状态
          if (cmd === 'status') {
            const mode = state.isBypassMode() ? 'BYPASS' : 'STRICT';
            const msgs = agent.getMessages().length;
            const queue = getInputQueue();
            const queueStatus = queue.getStatus();

            // Token 计数
            const tokenCounter = new TokenCounter();
            const provider = agent.getLLM()?.getProvider();
            if (provider) {
              tokenCounter.setContextWindow(provider.getContextWindow());
            }
            const usedTokens = tokenCounter.estimateMessages(agent.getMessages());
            const contextWindow = provider?.getContextWindow() || 128000;
            const usagePercent = usedTokens / contextWindow * 100;
            const usedK = usedTokens >= 1000 ? `${Math.floor(usedTokens / 1000)}k` : String(usedTokens);
            const maxK = contextWindow >= 1000 ? `${Math.floor(contextWindow / 1000)}k` : String(contextWindow);

            screen.appendScroll(COLORS.primary.bold('\nStatus:\n'));
            screen.appendScroll(`  Mode: ${mode.toUpperCase()}\n`);
            screen.appendScroll(`  Messages: ${msgs}\n`);
            screen.appendScroll(`  Context: ${usagePercent.toFixed(1)}% (${usedK} / ${maxK} tokens)\n`);
            screen.appendScroll(`  Queue: ${queueStatus.pending} pending\n`);
            screen.appendScroll(`  Workspace: ${agent.getWorkspacePath()}\n\n`);

            return;
          }

          // Skills
          if (cmd === 'skills') {
            const skills = listSkills(process.cwd());
            
            screen.appendScroll(COLORS.primary.bold('\nSkills:\n'));
            if (skills.length === 0) {
              screen.appendScroll(COLORS.muted('  (none)\n'));
            } else {
              skills.forEach(s => {
                screen.appendScroll(COLORS.muted(`  /${s.name} - ${s.description || ''}\n`));
              });
            }
            screen.appendScroll('\n');
            
            return;
          }

          // 帮助
          if (cmd === 'help' || cmd === 'h') {
            showHelp();
            
            return;
          }

          // 历史（显示最近消息）
          if (cmd === 'history') {
            const msgs = agent.getMessages();
            
            screen.appendScroll(COLORS.primary.bold('\nHistory:\n'));
            if (msgs.length === 0) {
              screen.appendScroll(COLORS.muted('  (empty)\n'));
            } else {
              msgs.forEach((m, i) => {
                const role = m.role === 'user' ? 'YOU' : m.role === 'assistant' ? 'AI' : 'SYS';
                const content = m.content || '';
                screen.appendScroll(COLORS.muted(`  ${i + 1}. [${role}]\n`));
                content.split('\n').forEach(line => {
                  screen.appendScroll(COLORS.muted(`     ${line}\n`));
                });
              });
              screen.appendScroll(COLORS.muted(`\n  Total: ${msgs.length} messages\n`));
            }
            screen.appendScroll('\n');
            
            return;
          }

          // 压缩上下文
          if (cmd === 'compact') {
            await agent.compact();
            // compact 内部已 emit context_compressed 事件，无需重复输出
            screen.restoreCursor();
            return;
          }

          // Init - 让AI分析代码库并创建 AGENTS.md
          if (cmd === 'init' || cmd.startsWith('init ')) {
            // 提取用户额外指令
            const userArgs = cmd.startsWith('init ') ? cmd.slice(5).trim() : '';

            const initPrompt = `I am using the init skill to analyze the codebase and create AGENTS.md.

<HARD-GATE>
Before outputting any document, you must:
1. Complete all analysis steps
2. Understand the project's core architecture
3. Verify all commands are actually available
</HARD-GATE>

## Analysis Steps (must complete in order)

- [ ] **Step 1: Read project config**
  - package.json / Cargo.toml / setup.py / pyproject.toml etc.
  - Identify: language, framework, dependencies, script commands

- [ ] **Step 2: Read existing documentation**
  - README.md / CHANGELOG.md / docs/ directory
  - Understand: project purpose, features, usage

- [ ] **Step 3: View directory structure**
  - List src/ lib/ app/ tests/ and other main directories
  - Identify entry points: index.ts / main.py / app.js etc.

- [ ] **Step 4: Check test and build configuration**
  - Test framework, test commands, CI configuration
  - Build/package configuration

- [ ] **Step 5: Review core code**
  - Implementation of main modules
  - Data flow and architecture patterns

## Document Structure

If AGENTS.md exists, preserve valuable content and supplement updates. If not, create a new file.

Must include the following sections:

### Project Overview
- Type: CLI tool / Web application / Library / Service
- Purpose: One-sentence description of core functionality
- Use case: Target users and usage scenarios

### Tech Stack
- Language and version requirements
- Core frameworks/libraries (only key ones, max 5)
- Runtime environment requirements

### Project Structure
Use a table to list key directories and files:
| Directory/File | Purpose |
|----------------|---------|
| src/           | ...     |

### Development Commands
List verified available commands:
- Dev: npm run dev
- Build: npm run build
- Test: npm test
- Other key commands

### Core Architecture
- Main modules and responsibilities (max 3-4)
- Data flow/processing flow (one sentence)
- Key design patterns

### Development Notes
- Code style highlights
- Common pitfalls (if found)
- Modules requiring special attention

## Anti-Pattern Warnings

| Thought | Correct Approach |
|---------|------------------|
| "Just write a random overview" | Must be based on actual analysis, cite specific files |
| "List all dependencies" | Only list core dependencies, don't copy entire package.json |
| "Guess commands" | Must verify commands exist and are usable |
| "Write lengthy architecture docs" | Keep it concise, AI agents need quick understanding |

${userArgs ? `\n## Additional Instructions\n${userArgs}\n` : ''}
Start the analysis, execute step by step, then output the document.`;

            handleInput(initPrompt);
            return;
          }

          // 动态 skill 管理
          if (cmd.startsWith('skill-add ')) {
            const parts = cmd.slice('skill-add '.length).split(' ');
            const skillName = parts[0];
            if (!skillName) {
              
            screen.appendScroll(COLORS.warning('\nUsage: /skill-add <name> [promptTemplate]\n'));
              
              return;
            }
            const promptTemplate = parts.slice(1).join(' ') || '{input}';
            const description = `Custom skill: ${skillName}`;
            await saveSkill(skillName, { name: skillName, description, promptTemplate });
            
            screen.appendScroll(COLORS.success(`\n[OK] Skill added: ${skillName}\n`));
            
            return;
          }

          if (cmd.startsWith('skill-remove ')) {
            const skillName = cmd.slice('skill-remove '.length).trim();
            if (!skillName) {
              
              screen.appendScroll(COLORS.warning('\nUsage: /skill-remove <name>\n'));
              
              return;
            }
            const result = await deleteSkill(skillName);
            
              if (result) {
                screen.appendScroll(COLORS.success(`\n[OK] Skill removed: ${skillName}\n`));
              } else {
                screen.appendScroll(COLORS.warning(`\n[WARN] Skill not found: ${skillName}\n`));
              }
            
            return;
          }

          if (cmd.startsWith('skill-edit ')) {
            const rest = cmd.slice('skill-edit '.length);
            const firstSpace = rest.indexOf(' ');
            if (firstSpace === -1) {
              
              screen.appendScroll(COLORS.warning('\nUsage: /skill-edit <name> <promptTemplate>\n'));
              
              return;
            }
            const skillName = rest.slice(0, firstSpace);
            const promptTemplate = rest.slice(firstSpace + 1) || '{input}';
            const existing = getSkill(skillName, process.cwd());
            if (!existing) {
              
              screen.appendScroll(COLORS.warning(`\n[WARN] Skill not found: ${skillName}\n`));
              
              return;
            }
            await saveSkill(skillName, { ...existing, promptTemplate });
            
            screen.appendScroll(COLORS.success(`\n[OK] Skill updated: ${skillName}\n`));
            
            return;
          }

          // Skill 调用（/skill_name args）
          const skillInput = parseSkillInput(trimmed, process.cwd());
          if (skillInput) {
            const skill = getSkill(skillInput.skillName, process.cwd());
            if (skill) {
              const prompt = buildSkillPrompt(skill, skillInput.args);

              screen.appendScroll(COLORS.muted(`\n[${skill.name}] ${skill.description}\n`));
              isProcessing = true;
              state.setProcessing(true);
              try {
                await agent.runLoop(prompt);
                screen.setStreaming(false);
                screen.appendScroll(COLORS.success('\n[OK] Done\n'));
              } catch (error: any) {
                screen.setStreaming(false);
                screen.appendScroll(COLORS.error(`\n[ERR] ${error.message}\n`));
              }
              screen.restoreCursor();
              screen.refreshInput();
              isProcessing = false;
              state.setProcessing(false);
              saveSession(process.cwd(), agent.getMessages());

              // Auto-drain queued inputs
              await autoDrainQueue(getInputQueue(), async (merged) => {
                await handleInput(merged);
              });
              
              return;
            }
          }

          // 未知的 / 命令
          screen.appendScroll(COLORS.warning(`\nUnknown command: ${trimmed}\n`));
          screen.appendScroll(COLORS.muted('Type /h for help\n'));
          return;
        }

        // === 执行请求 ===
        // 先显示用户输入在输出区
        screen.appendScroll(COLORS.primary(`\n> ${finalInput}\n`));

        isProcessing = true;
        state.setProcessing(true);

        // 显示处理状态（心跳由 waiting_for_llm 事件自动启动）
        screen.appendScroll(COLORS.muted('Processing... (ESC ESC to interrupt)\n'));

        const startTime = Date.now();
        try {
          const result = await agent.runLoop(finalInput);
          const elapsed = Date.now() - startTime;
          if (state.isStreamingOutput()) {
            state.setStreamingOutput(false);
            screen.setStreaming(false);
            screen.appendScroll('\n');
          }

          // 显示运行统计
          const stats = formatRunStats(elapsed, agent, tokenCounter);
          screen.appendScroll(COLORS.muted(`\n${stats}\n`));
          screen.appendScroll(COLORS.success('[OK] Done\n'));
        } catch (error: any) {
          const elapsed = Date.now() - startTime;
          if (state.isStreamingOutput()) {
            state.setStreamingOutput(false);
            screen.setStreaming(false);
            screen.appendScroll('\n');
          }
          // 显示运行统计（即使失败也显示）
          const stats = formatRunStats(elapsed, agent, tokenCounter);
          screen.appendScroll(COLORS.muted(`\n${stats}\n`));
          screen.appendScroll(COLORS.error(`[ERR] ${error.message}\n`));
        }
        // 输出完成，恢复光标到输入框并刷新显示
        screen.setStreaming(false);
        screen.restoreCursor();
        screen.refreshInput();
        isProcessing = false;
        state.setProcessing(false);
        saveSession(process.cwd(), agent.getMessages());

        // Auto-drain queued inputs
        await autoDrainQueue(getInputQueue(), async (merged) => {
          await handleInput(merged);
        });
      };

      // 帮助信息
      const showHelp = () => {

        screen.appendScroll(COLORS.primary.bold('\nCommands:\n'));
        screen.appendScroll(COLORS.muted('  quit/exit   Exit\n'));
        screen.appendScroll(COLORS.muted('  help        Show help\n'));
        screen.appendScroll('\n');
        screen.appendScroll(COLORS.primary.bold('Session:\n'));
        screen.appendScroll(COLORS.muted('  /clear      Clear session\n'));
        screen.appendScroll(COLORS.muted('  /history    Show messages\n'));
        screen.appendScroll(COLORS.muted('  /compact    Compress context\n'));
        screen.appendScroll(COLORS.muted('  /sessions   List archived sessions\n'));
        screen.appendScroll(COLORS.muted('  /switch <id> Switch to session\n'));
        screen.appendScroll('\n');
        screen.appendScroll(COLORS.primary.bold('Queue:\n'));
        screen.appendScroll(COLORS.muted('  /queue      Show queue\n'));
        screen.appendScroll(COLORS.muted('  /undo       Remove last input\n'));
        screen.appendScroll('\n');
        screen.appendScroll(COLORS.primary.bold('Mode:\n'));
        screen.appendScroll(COLORS.muted('  /bypass     Auto-approve all permissions\n'));
        screen.appendScroll(COLORS.muted('  /strict     Ask permission (default)\n'));
        screen.appendScroll(COLORS.muted('  /status     Show status\n'));
        screen.appendScroll('\n');
        screen.appendScroll(COLORS.primary.bold('Skills:\n'));
        screen.appendScroll(COLORS.muted('  /skills     List skills\n'));
        screen.appendScroll('\n');
      };

      // 保持进程运行
      await new Promise<void>((resolve) => {
        process.on('exit', resolve);
      });

    } catch (error: any) {
      // 停止banner动画
      BG.stopBanner();
      if (!state.isConnectionErrorShown()) {
        if (tuiHandler) {

          screen.appendScroll(COLORS.error(`\nError: ${error.message}\n`));
        } else {
          console.log(COLORS.error(`Error: ${error.message}`));
        }
      }
    }

    state.setAgent(null);
    state.setConnectionErrorShown(false);  // 重置
  });

// Run command - 单次执行
program
  .command('run <request>')
  .description('Execute single coding task and exit (non-interactive mode)\n\nUse for quick fixes or one-time tasks')
  .option('-p, --provider <name>', 'Use specific provider')
  .addHelpText('after', '\nExamples:\n  spica run "fix login bug"\n  spica run "add CSV export" -p deepseek\n  spica run "refactor user module"')
  .action(async (request: string, options: { provider?: string }) => {
    const config = await loadGlobalSettings();
    const providerName = options.provider || config.defaultProvider || 'openai';

    let providerConfig;
    try {
      providerConfig = await getProviderConfig(providerName);
    } catch (error: any) {
      console.log(COLORS.error(`Provider "${providerName}" not configured.`));
      console.log(COLORS.warning('Set up with: spica providers set <name> <api-key>'));
      return;
    }

    const agent = new SpicaAgent(providerName, process.cwd());
    state.setAgent(agent);

    setupAgentEvents(agent, false);

    try {
      await agent.init();
      const result = await agent.runLoop(request);
      console.log(COLORS.success('\n[OK] Completed'));
    } catch (error: any) {
      if (!state.isConnectionErrorShown()) {
        console.log(COLORS.error(`Error: ${error.message}`));
      }
    }

    state.setAgent(null);
    state.setConnectionErrorShown(false);  // 重置
  });

// Provider commands
program
  .command('set <name> <url> <apiKey> <model>')
  .description('Add or update a provider')
  .action(async (name, url, apiKey, model) => {
    await setProviderConfig(name, apiKey, url, model);
    console.log(COLORS.success(`[OK] ${name}`));
  });

program
  .command('use <name>')
  .description('Switch default provider')
  .action(async (name) => {
    try {
      await setDefaultProvider(name);
      console.log(COLORS.success(`[OK] using ${name}`));
    } catch (e: any) {
      console.log(COLORS.error(e.message));
    }
  });

program
  .command('list')
  .description('List providers')
  .action(async () => {
    const providers = await listProviders();
    const defaultProvider = (await loadGlobalSettings()).defaultProvider;
    providers.forEach(p => {
      const mark = p === defaultProvider ? '●' : '○';
      console.log(`${mark} ${p}`);
    });
  });

program
  .command('show [name]')
  .description('Show provider config')
  .action(async (name) => {
    name = name || (await loadGlobalSettings()).defaultProvider;
    if (!name) return console.log('No default provider');
    try {
      const c = await getProviderConfig(name);
      console.log(`name:   ${c.name}`);
      console.log(`url:    ${c.baseUrl}`);
      console.log(`key:    ${c.apiKey.slice(0,8)}...`);
      console.log(`model:  ${c.model}`);
    } catch (e: any) {
      console.log(COLORS.error(e.message));
    }
  });

program
  .command('remove [names...]')
  .description('Remove providers (use --all to remove all)')
  .option('-a, --all', 'Remove all')
  .action(async (names, opts) => {
    const config = await loadGlobalSettings();
    if (opts.all) {
      const all = Object.keys(config.providers || {});
      config.providers = {};
      config.defaultProvider = undefined;
      await saveGlobalSettings(config);
      console.log(COLORS.success(`[OK] removed: ${all.join(', ')}`));
      return;
    }
    if (!names.length) return console.log('Usage: remove <names...> or --all');
    for (const n of names) {
      if (config.providers?.[n]) {
        delete config.providers[n];
        if (config.defaultProvider === n) config.defaultProvider = undefined;
        console.log(COLORS.success(`[OK] ${n}`));
      } else {
        console.log(COLORS.error(`[ERR] ${n} not found`));
      }
    }
    await saveGlobalSettings(config);
  });

// Skills管理
program
  .command('skills')
  .description('Manage custom skills (extendable AI templates)')
  .argument('[action]', 'list|install|uninstall')
  .argument('[source]', 'Skill source (URL or path)')
  .addHelpText('after', '\nExamples:\n  spica skills list            # List installed skills\n  spica skills install https://github.com/user/skill')
  .action(async (action?: string, source?: string) => {
    if (!action) {
      // 默认列出所有skills
      const skills = listSkills(process.cwd());
      const packages = await listInstalledPackages();

      console.log(COLORS.primary.bold('\nInstalled skill packages:'));
      if (packages.length === 0) {
        console.log(COLORS.muted('  (none)'));
      } else {
        packages.forEach(p => {
          console.log(`  ${COLORS.success('●')} ${p.name} (${p.skills.length} skills)`);
        });
      }

      console.log(COLORS.primary.bold('\nAvailable skills:'));
      if (skills.length === 0) {
        console.log(COLORS.muted('  (none)'));
        console.log(COLORS.muted('\nInstall skills with:'));
        console.log(COLORS.muted('  spica skills install <url-or-file>'));
      } else {
        skills.forEach(s => {
          console.log(`  ${COLORS.muted(`/${s.name}`)} - ${s.description}`);
        });
      }
      console.log('');
      return;
    }

    switch (action) {
      case 'list':
        const skills = listSkills(process.cwd());
        console.log(COLORS.primary.bold('\nAvailable skills:'));
        skills.forEach(s => {
          console.log(`  ${COLORS.muted(`/${s.name}`)} - ${s.description}`);
        });
        break;

      case 'install':
        if (!source) {
          console.log(COLORS.warning('Usage: spica skills install <url-or-file>'));
          console.log(COLORS.muted('Example: spica skills install https://example.com/skills.json'));
          return;
        }
        const result = await installSkill(source);
        if (result.success) {
          console.log(COLORS.success(`[OK] ${result.message}`));
          if (result.skills) {
            console.log(COLORS.muted('Installed skills:'));
            result.skills.forEach(s => console.log(COLORS.muted(`  /${s}`)));
          }
        } else {
          console.log(COLORS.error(`[ERR] ${result.message}`));
        }
        break;

      case 'uninstall':
        if (!source) {
          console.log(COLORS.warning('Usage: spica skills uninstall <package-name>'));
          return;
        }
        const uninstallResult = await uninstallSkill(source);
        if (uninstallResult.success) {
          console.log(COLORS.success(`[OK] ${uninstallResult.message}`));
        } else {
          console.log(COLORS.error(`[ERR] ${uninstallResult.message}`));
        }
        break;

      case 'packages':
        const packages = await listInstalledPackages();
        console.log(COLORS.primary.bold('\nInstalled skill packages:'));
        if (packages.length === 0) {
          console.log(COLORS.muted('  (none)'));
        } else {
          packages.forEach(p => {
            console.log(`  ${COLORS.success('●')} ${p.name}`);
            console.log(COLORS.muted(`    Skills: ${p.skills.join(', ')}`));
          });
        }
        break;

      default:
        console.log(COLORS.warning('Available actions: list, install, uninstall, packages'));
    }
  });

// MCP管理
program
  .command('mcp')
  .description('Manage MCP servers (external tool servers)')
  .argument('[action]', 'list|add|remove')
  .argument('[server]', 'Server name')
  .addHelpText('after', '\nExamples:\n  spica mcp list              # List configured MCP servers')
  .action(async (action?: string, server?: string) => {
    const manager = getMCPManager();  // 定义在开头，所有case都能用

    if (!action) {
      // 默认显示状态
      const connected = manager.listConnectedServers();
      const tools = manager.listAvailableTools();

      console.log(COLORS.primary.bold('\nMCP Status:'));
      if (connected.length === 0) {
        console.log(COLORS.muted('  No servers connected'));
        console.log(COLORS.muted('\n  Run `spica mcp init` to create example config'));
      } else {
        console.log(COLORS.success(`  Connected servers: ${connected.join(', ')}`));
        console.log(COLORS.muted(`  Available tools: ${tools.length}`));
        if (tools.length > 0) {
          tools.slice(0, 10).forEach(t => {
            console.log(COLORS.muted(`    - ${t}`));
          });
          if (tools.length > 10) {
            console.log(COLORS.muted(`    ... and ${tools.length - 10} more`));
          }
        }
      }
      console.log('');
      return;
    }

    switch (action) {
      case 'list':
        const servers = manager.listConnectedServers();
        console.log(COLORS.primary.bold('\nConnected MCP servers:'));
        if (servers.length === 0) {
          console.log(COLORS.muted('  (none)'));
        } else {
          servers.forEach(s => {
            const toolsCount = manager.listAvailableTools().filter(t => t.startsWith(`${s}/`)).length;
            console.log(`  ${COLORS.success('●')} ${s} (${toolsCount} tools)`);
          });
        }
        break;

      case 'init':
        // 写入 settings.json
        const currentSettings = await loadGlobalSettings();

        if ((currentSettings.mcp?.servers?.length ?? 0) > 0) {
          console.log(COLORS.warning(`MCP servers already configured in settings.json`));
          console.log(COLORS.muted('Edit ~/.spica/settings.json to modify'));
        } else {
          currentSettings.mcp = generateExampleConfig();
          await saveGlobalSettings(currentSettings);
          console.log(COLORS.success(`[OK] MCP config added to ${GLOBAL_SETTINGS_FILE}`));
          console.log(COLORS.muted('Edit ~/.spica/settings.json to customize servers'));
        }
        break;

      case 'add': {
        const addResponse = await prompts([
          { type: 'text', name: 'name', message: 'Server name:' },
          { type: 'select', name: 'connType', message: 'Connection type:',
            choices: [
              { title: 'stdio (command)', value: 'stdio' },
              { title: 'SSE (URL)', value: 'sse' },
            ] },
          { type: 'text', name: 'command', message: 'Start command (e.g. npx):', hint: 'For stdio mode' },
          { type: 'text', name: 'args', message: 'Arguments (space-separated):', hint: 'e.g. -y @anthropic-ai/mcp-server-filesystem /path' },
          { type: 'text', name: 'url', message: 'SSE URL:', hint: 'For SSE mode' },
          { type: 'text', name: 'headers', message: 'Headers (key=value,key=value):', hint: 'Optional, for OAuth etc.' },
        ]);

        if (!addResponse.name) break;

        const addSettings = await loadGlobalSettings();
        if (!addSettings.mcp) addSettings.mcp = { servers: [] };

        const serverConfig: any = { name: addResponse.name };

        if (addResponse.connType === 'stdio' && addResponse.command) {
          serverConfig.command = addResponse.command;
          if (addResponse.args) serverConfig.args = addResponse.args.split(/\s+/);
        } else if (addResponse.connType === 'sse' && addResponse.url) {
          serverConfig.url = addResponse.url;
        } else {
          console.log(COLORS.warning('Invalid configuration'));
          break;
        }

        if (addResponse.headers) {
          serverConfig.headers = {};
          for (const pair of addResponse.headers.split(',')) {
            const [k, ...v] = pair.split('=');
            if (k) serverConfig.headers[k.trim()] = v.join('=').trim();
          }
        }

        addSettings.mcp.servers.push(serverConfig);
        await saveGlobalSettings(addSettings);
        console.log(COLORS.success(`[OK] MCP server "${addResponse.name}" added`));
        break;
      }

      case 'tools':
        const allTools = manager.listAvailableTools();
        console.log(COLORS.primary.bold('\nAvailable MCP tools:'));
        if (allTools.length === 0) {
          console.log(COLORS.muted('  (none)'));
          console.log(COLORS.muted('Connect a MCP server first'));
        } else {
          allTools.forEach(t => {
            console.log(COLORS.muted(`  ${t}`));
          });
        }
        break;

      case 'disconnect':
        if (server) {
          // 断开特定服务器（未实现）
          console.log(COLORS.warning('Disconnecting specific server not implemented'));
        } else {
          await manager.disconnectAll();
          console.log(COLORS.success('[OK] All MCP servers disconnected'));
        }
        break;

      default:
        console.log(COLORS.warning('Available actions: list, init, tools, disconnect'));
        console.log(COLORS.muted('\nMCP allows connecting external tool servers'));
        console.log(COLORS.muted('Examples: filesystem, postgres, slack, custom APIs'));
    }
  });

// 非交互模式运行函数
async function runSimpleMode(agent: SpicaAgent, fresh?: boolean): Promise<void> {
  try {
    await agent.init();

    // 设置简单的事件处理（无 TUI）
    agent.on('stream', (data: any) => {
      process.stdout.write(data.chunk);
    });

    agent.on('reasoning', (data: any) => {
      process.stdout.write(COLORS.reasoning(data.content));
    });

    agent.on('tool_call', (data: any) => {
      console.log(COLORS.tool(`\n[TOOL] ${data.name}`));
    });

    agent.on('tool_result', (data: any) => {
      const icon = data.success ? COLORS.success('[OK]') : COLORS.error('[ERR]');
      console.log(`${icon} ${data.name}`);
      if (data.error) {
        console.log(COLORS.error(`  Error: ${data.error}`));
      }
    });

    agent.on('message', (data: any) => {
      if (data.role === 'assistant') {
        console.log(); // 新行
      }
    });

    agent.on('context_compressed', (data: any) => {
      console.log(COLORS.secondary(`\n[COMPRESS] ${data.before} -> ${data.after} messages`));
    });

    agent.on('connection_error', (data: any) => {
      console.log(COLORS.error(`\nConnection Error: ${data.type}`));
      console.log(COLORS.muted(data.hint));
    });

    const providerConfig = state.getProviderConfig();
    const model = providerConfig?.model || 'unknown';
    console.log(COLORS.success(`[OK] Connected to ${model}`));
    console.log(COLORS.muted('\nNon-interactive mode: type your request and press Enter'));
    console.log(COLORS.muted('Press Ctrl+C to exit, Ctrl+D to interrupt'));

    // 清空历史（如果指定）
    if (fresh) {
      agent.setMessages([]);
      console.log(COLORS.muted('[INFO] Session cleared'));
    }

    // 简单的 readline 模式
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> ',
    });

    rl.prompt();

    rl.on('line', async (input: string) => {
      const trimmed = input.trim();
      if (!trimmed) {
        rl.prompt();
        return;
      }

      // 处理特殊命令
      if (trimmed === 'quit' || trimmed === 'exit') {
        rl.close();
        return;
      }

      if (trimmed === 'help') {
        console.log('Commands: quit, exit, help, /clear, /compact, /history, /status');
        rl.prompt();
        return;
      }

      if (trimmed.startsWith('/')) {
        const cmd = trimmed.slice(1).toLowerCase();
        if (cmd === 'clear') {
          agent.setMessages([]);
          console.log(COLORS.muted('[OK] Session cleared'));
        } else if (cmd === 'compact') {
          await agent.compact();
        } else if (cmd === 'history') {
          const messages = agent.getMessages();
          console.log(COLORS.muted(`\n[History] ${messages.length} messages`));
        } else if (cmd === 'status') {
          const messages = agent.getMessages();
          console.log(COLORS.primary(`\n[Status]`));
          console.log(`  Messages: ${messages.length}`);
          console.log(`  Mode: ${state.isBypassMode() ? 'BYPASS' : 'STRICT'}`);
        } else {
          console.log(COLORS.warning(`Unknown command: ${trimmed}`));
        }
        rl.prompt();
        return;
      }

      // 执行请求
      try {
        console.log(COLORS.muted('\n[PROCESSING]...'));
        const response = await agent.runLoop(trimmed);
        console.log(COLORS.success('\n[OK] Done'));
      } catch (error: any) {
        console.log(COLORS.error(`\n[ERR] ${error.message}`));
      }

      rl.prompt();
    });

    rl.on('close', () => {
      console.log(COLORS.muted('\n[EXIT] Goodbye!'));
      saveSession(process.cwd(), agent.getMessages());
      process.exit(0);
    });

  } catch (error: any) {
    // 停止banner动画（如果正在运行）
    BG.stopBanner();
    console.log(COLORS.error(`Error: ${error.message}`));
    process.exit(1);
  }
}

program.parse();