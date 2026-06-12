import { SpicaAgent } from "../agent";
import { execSync } from "child_process";
import { loadGlobalSettings, getProviderConfig, saveGlobalSettings, GLOBAL_SETTINGS_FILE } from "../utils/settings";
import { loadSession, saveSession, archiveSession, listSessions, archiveSessionWithSummary, generateSessionSummary } from "../utils/session";
import { listSkills, installSkill, uninstallSkill, listInstalledPackages, saveSkill, deleteSkill, getSkill, buildSkillPrompt, parseSkillInput } from "../skills";
import { listCheckpoints, getCheckpoint, restoreCheckpoint, cleanCheckpoints } from "../storage/checkpointManager";
import { getMCPManager, generateExampleConfig, shutdownMCP } from "../mcp/client";
import { COLORS, BG } from "../cli/ui/colors";
import { getInputQueue, clearInputQueue } from "../cli/ui/queue";
import { autoDrainQueue } from "../cli/queueDrain";
import { TUIInputHandler } from "../cli/ui/tuiInput";
import { setupAgentEvents, formatRunStats } from "../cli/events";
import { updateStatusBar, setUpdateStatusBarFn } from "../cli/status";
import { getRuntimeState } from "../core/RuntimeState";
import { getScreenManager } from "../cli/ui/screenManager";
import { TokenCounter } from "../llm/TokenCounter";
import os from "os";
import { playBell } from "../utils/bell";


const state = getRuntimeState();
const screen = getScreenManager();
const ESC = "";
let tuiStarted = false;

export async function runInteractiveMode(
  agent: SpicaAgent,
  options: { fresh?: boolean },
): Promise<void> {
  const providerConfig = state.getProviderConfig();
      // 开始banner动画（并行）
      const bannerPromise = BG.banner();

      // TUI handler (defined before try to be accessible in catch)
      let tuiHandler: TUIInputHandler | null = null;

      try {
        await agent.init();

        // 检测当前 Git 分支（无 .git 则忽略）
        try {
          const branch = execSync('git branch --show-current', {
            cwd: agent.getWorkspacePath(),
            stdio: ['ignore', 'pipe', 'ignore'],
          }).toString().trim();
          state.setCurrentBranch(branch || null);
        } catch {
          state.setCurrentBranch(null);
        }

        // 停止banner动画
        BG.stopBanner();
        await bannerPromise;

        // 清屏，准备设置滚动区域
        screen.appendScroll(`${ESC}[2J${ESC}[1;1H`);

        // TUI 输入处理（设置滚动区域）
        tuiHandler = new TUIInputHandler();
        tuiHandler.start();
        tuiStarted = true;

        // 首次启动提示
        screen.appendScroll(
          COLORS.muted('ESC ESC to interrupt, Ctrl+C ×3 to force exit\n'),
        );

        // 自动加载历史
        if (!options.fresh) {
          const session = loadSession(agent.getWorkspacePath());
          if (session && session.messages && session.messages.length > 0) {
            agent.setMessages(session.messages);
            // 显示加载历史提示（在滚动区域）

            screen.appendScroll(
              COLORS.muted(
                `Loaded ${session.messages.length} messages from history\n`,
              ),
            );
          }
        }

        // Tab 补全命令列表
        const BASE_COMMANDS = [
          "/help",
          "/h",
          "/status",
          "/queue",
          "/q",
          "/undo",
          "/archive",
          "/clear",
          "/reset",
          "/new",
          "/checkpoint",
          "/skill",
          "/mcp",
          "/history",
          "/sessions",
          "/view",
          "/compact",
          "/summary",
          "/sum",
          "/init",
          "/rename",
          "/delete",
        ];
        const getCommands = () => {
          const skills = listSkills(agent.getWorkspacePath());
          const skillCommands = skills.map((s) => `/${s.name}`);
          return [...BASE_COMMANDS, ...skillCommands];
        };
        tuiHandler.getScreen().setCompleter((line: string) => {
          return getCommands().filter((c) => c.startsWith(line));
        });

        // 显示状态栏（简洁版）
        // 状态栏：状态 | 模型 | 工作区（智能缩写长路径）
        const updateStatusBarLocal = () => {
          const isBusy = state.isProcessing();
          const statusText = isBusy ? COLORS.warning('busy') : COLORS.success('idle');

          // Git 分支（无 repo 则不显示）
          const branch = state.getCurrentBranch();
          const branchInfo = branch ? ` | ${branch}` : '';

          // 工作区路径显示（Windows 下缩写长路径）
          const workspace = agent.getWorkspacePath();
          const homeDir = os.homedir();
          let displayPath = workspace;

          // 缩写用户目录为 ~（跨平台）
          if (workspace.startsWith(homeDir)) {
            displayPath = "~" + workspace.slice(homeDir.length);
          }

          // Windows 下如果路径仍太长（超过 30 字符），显示最后两级目录
          if (displayPath.length > 30) {
            const parts = displayPath.split(/[/\\]/);
            if (parts.length > 2) {
              displayPath = "..." + parts.slice(-2).join("/");
            }
          }

          screen.setStatus(
            `${statusText} | ${providerConfig!.model}${branchInfo} | ${displayPath}`,
          );
        };
        setUpdateStatusBarFn(updateStatusBarLocal);
        updateStatusBarLocal();

        // TokenCounter 用于结束统计显示
        const provider = agent.getLLM()?.getProvider();
        const contextWindow = provider?.getContextWindow() || 128000;
        const tokenCounter = new TokenCounter();
        tokenCounter.setContextWindow(contextWindow);

        // 设置 Ctrl+O 切换回调
        screen.setVerboseToggleCallback(() => {
          screen.clearThinkingAnimation();
          const newMode = state.toggleVerboseMode();
          screen.appendScroll(
            COLORS.secondary(
              `\n[MODE] ${newMode ? "Verbose" : "Compact"} display enabled\n`,
            ),
          );
          updateStatusBar();
          screen.restoreCursor();
          screen.refreshInput();
        });

        // 启用 Bracketed Paste Mode（粘贴内容作为整体到达）
        screen.writeRaw(`${ESC}[?2004h`);

        // 启用 rawMode
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
        }

        let isProcessing = false;
        let shouldExit = false;

        // stdin 监听 - 使用 TUIInputHandler
        process.stdin.on("data", (chunk: Buffer) => {
          const result = tuiHandler!.handleStdin(
            chunk.toString("utf8"),
            false,
          );

          // ESC ESC 中断
          if (result.isInterrupt) {
            if (state.getAgent()) {
              state.getAgent()!.interrupt();
              // agent_interrupted 事件会显示消息并清理 UI
              screen.setStreaming(false);
            }
            return;
          }

          // 退出
          if (result.shouldExit) {
            shouldExit = true;
            // 禁用 Bracketed Paste Mode
            screen.writeRaw(`${ESC}[?2004l`);
            tuiHandler!.end();
            screen.end();
            console.log(COLORS.error("[FORCE EXIT]"));
            process.exit(0);
            return;
          }

          // 处理输入
          if (result.shouldProcess && result.content.trim()) {
            handleInput(result.content.trim());
          }
        });

        // 设置agent事件监听
        setupAgentEvents(agent, true, providerConfig!.model, tokenCounter);

        // TUI 输出辅助函数（已简化）

        // 输入处理函数
        const handleInput = async (line: string) => {
          const trimmed = line.trim();

          // quit/exit 命令始终有效
          if (trimmed === "quit" || trimmed === "exit") {
            shouldExit = true;
            if (isProcessing && state.getAgent()) {
              state.getAgent()!.interrupt();
            }
            // 禁用 Bracketed Paste Mode
            screen.writeRaw(`${ESC}[?2004l`);
            tuiHandler!.end();
            screen.end();  // 先结束TUI，恢复终端
            const messages = agent.getMessages();
            saveSession(agent.getWorkspacePath(), messages);
            await shutdownMCP();
            state.setAgent(null);
            // 使用console.log而不是appendScroll
            console.log(COLORS.muted(`Session saved (${messages.length} messages)`));
            console.log(COLORS.muted("Goodbye!"));
            process.exit(0);
            return;
          }

          // 如果正在处理，使用队列累积输入
          if (isProcessing && !trimmed.startsWith("/")) {
            const queue = getInputQueue();
            const added = queue.add(trimmed);
            const status = queue.getStatus();
            
            // 检查是否接近队列上限
            if (status.droppedWarning) {
              screen.appendScroll(
                COLORS.warning(`[QUEUE] Warning: Queue near limit (${status.total}/${50})\n`),
              );
            }
            
            screen.appendScroll(
              COLORS.muted(`[QUEUE] Added #${added.id} (${status.pending} pending)\n`),
            );
            return;
          }

          // CRITICAL FIX: 在处理前合并 queue（而不是结束后）
          const queue = getInputQueue();
          let finalInput = trimmed;
          if (queue.hasPending() && !trimmed.startsWith("/")) {
            finalInput = queue.mergePending() + "\n\n---\n\n" + trimmed;
            const status = queue.getStatus();
            screen.appendScroll(
              COLORS.muted(
                `[QUEUE] Merged ${status.pending + 1} inputs (use --- separator)\n`,
              ),
            );
            
            // 自动清理已处理的输入
            const cleared = queue.autoCleanup();
            if (cleared > 0) {
              screen.appendScroll(
                COLORS.muted(`[QUEUE] Auto-cleaned ${cleared} processed inputs\n`),
              );
            }
          }

          if (!finalInput.trim()) {
            return;
          }

          if (trimmed === "help") {
            showHelp();

            return;
          }

          // === / 命令 ===
          if (trimmed.startsWith("/")) {
            const cmd = trimmed.slice(1).toLowerCase();

            // 队列管理
            if (cmd === "queue" || cmd === "q") {
              const queue = getInputQueue();
              const status = queue.getStatus();

              screen.appendScroll(COLORS.primary.bold("\nInput Queue:\n"));
              screen.appendScroll(`  Pending: ${status.pending}\n`);
              if (status.pendingPreview.length > 0) {
                screen.appendScroll(COLORS.muted("  Recent:\n"));
                status.pendingPreview.forEach((p, i) => {
                  screen.appendScroll(COLORS.muted(`    ${i + 1}. ${p}\n`));
                });
              }
              screen.appendScroll("\n");

              return;
            }

            if (cmd === "undo") {
              const queue = getInputQueue();
              const removed = queue.undoLast();

              if (removed) {
                screen.appendScroll(
                  COLORS.muted(`\n[QUEUE] Removed: ${removed.content}\n`),
                );
              } else {
                screen.appendScroll(
                  COLORS.muted("\n[QUEUE] No pending inputs\n"),
                );
              }

              return;
            }

            // History browser — archived sessions (read-only)
            if (cmd === "sessions" || cmd === "history") {
              const { listSessions } = await import("../utils/session");
              const sessions = listSessions(agent.getWorkspacePath());

              screen.appendScroll(COLORS.primary.bold("\nSessions\n"));
              screen.appendScroll(COLORS.muted("─".repeat(60) + "\n"));

              // Current session
              const currentMsgs = agent.getMessages();
              const currentId = loadSession(agent.getWorkspacePath())?.id;
              screen.appendScroll(COLORS.primary(`* Current: ${currentMsgs.length} messages`) +
                (currentId ? COLORS.muted(`  (id: ${currentId.slice(-12)})`) : '') + '\n');
              screen.appendScroll(COLORS.muted("─".repeat(60) + "\n"));

              if (sessions.length === 0) {
                screen.appendScroll(COLORS.muted("  No archived sessions.\n"));
                screen.appendScroll(COLORS.muted("  /archive to save current and start new.\n\n"));
                return;
              }

              sessions.slice(0, 20).forEach((s, i) => {
                const isCurrent = s.id === currentId;
                const prefix = isCurrent ? '*' : ' ';
                const date = new Date(s.lastActivity).toLocaleDateString();
                const name = s.name || s.id;
                const summary = s.summary || '';

                screen.appendScroll(
                  COLORS.primary(`${prefix} ${(i + 1).toString().padStart(2)}. `) +
                  COLORS.primary.bold(name.slice(0, 50)) + '\n'
                );
                screen.appendScroll(
                  COLORS.muted(`     ${s.messageCount} msgs  ${date}  ${s.id}`) + '\n'
                );
                if (summary) {
                  screen.appendScroll(COLORS.muted(`     ${summary}\n`));
                }
              });

              if (sessions.length > 20) {
                screen.appendScroll(COLORS.muted(`  ... ${sessions.length - 20} more\n`));
              }

              screen.appendScroll(COLORS.muted("\n" + "─".repeat(60) + "\n"));
              screen.appendScroll(COLORS.muted("/view <id>  /rename <id> <name>  /delete <id>\n\n"));

              return;
            }

            // 查看历史 session 内容（只读）
            if (cmd.startsWith("view ")) {
              const sessionId = cmd.slice(5).trim();
              const { loadSessionById } = await import("../utils/session");
              const session = loadSessionById(agent.getWorkspacePath(), sessionId);

              if (!session) {
                screen.appendScroll(COLORS.error(`\n[ERR] Session ${sessionId} not found\n`));
                return;
              }

              screen.appendScroll(COLORS.primary.bold(`\nReading: ${session.name || sessionId}\n`));
              screen.appendScroll(COLORS.muted(`  Created: ${new Date(session.createdAt).toLocaleString()}\n`));
              screen.appendScroll(COLORS.muted(`  Last: ${new Date(session.lastActivity).toLocaleString()}\n`));
              screen.appendScroll(COLORS.muted(`  Messages: ${session.messages?.length || 0}\n`));
              if (session.summary) {
                screen.appendScroll(COLORS.muted(`  Summary: ${session.summary}\n`));
              }
              // Show all messages (each truncated to 500 chars)
              const messages = session.messages || [];
              const MAX_TO_SHOW = 50;  // protect against huge sessions

              messages.slice(0, MAX_TO_SHOW).forEach((m, i) => {
                const role = m.role === 'user' ? '[user]' : m.role === 'assistant' ? '[ai]' : m.role === 'tool' ? '[tool]' : '[sys]';
                const content = (m.content || '').slice(0, 500);
                const preview = content.split('\n').slice(0, 3).join(' ');

                screen.appendScroll(COLORS.primary(`${role} `));
                screen.appendScroll(COLORS.muted(`${preview}\n`));

                if (m.toolCalls && m.toolCalls.length > 0) {
                  screen.appendScroll(COLORS.muted(`  tools: ${m.toolCalls.map(tc => tc.name).join(', ')}\n`));
                }
              });

              if (messages.length > MAX_TO_SHOW) {
                screen.appendScroll(COLORS.muted(`\n  ... and ${messages.length - MAX_TO_SHOW} more messages\n`));
              }
              screen.appendScroll(COLORS.muted(`\n  -- End of session (${messages.length} messages) --\n\n`));

              return;
            }

            // 删除 /switch 功能（历史只读）
            if (cmd.startsWith("switch ")) {
              screen.appendScroll(COLORS.warning("\n[NOTE] /switch is disabled\n"));
              screen.appendScroll(COLORS.muted("  History sessions are read-only for review.\n"));
              screen.appendScroll(COLORS.muted("  To continue work, stay in current session.\n"));
              screen.appendScroll(COLORS.muted("  Use /archive to save current and start new.\n\n"));
              return;
            }

            if (cmd.startsWith("rename ")) {
              const args = cmd.slice(7).trim();
              const parts = args.split(" ");
              const sessionId = parts[0];
              const newName = parts.slice(1).join(" ") || "Unnamed";
              const { renameSession } = await import("../utils/session");

              if (renameSession(agent.getWorkspacePath(), sessionId, newName)) {
                screen.appendScroll(
                  COLORS.success(`\n[OK] Session renamed to: ${newName}\n`),
                );
              } else {
                screen.appendScroll(
                  COLORS.error(
                    `\n[ERR] Failed to rename session ${sessionId}\n`,
                  ),
                );
              }

              return;
            }

            // 删除 session
            if (cmd.startsWith("delete ")) {
              const sessionId = cmd.slice(7).trim();
              const { deleteSession } = await import("../utils/session");

              if (deleteSession(agent.getWorkspacePath(), sessionId)) {
                screen.appendScroll(
                  COLORS.success(`\n[OK] Session ${sessionId} deleted\n`),
                );
              } else {
                screen.appendScroll(
                  COLORS.error(`\n[ERR] Session ${sessionId} not found or cannot delete\n`),
                );
              }

              return;
            }

            // 归档当前聊天并开始新聊天（/new, /archive, /clear, /reset 都可触发）
            if (cmd === "new" || cmd === "archive" || cmd === "clear" || cmd === "reset") {
              const currentMessages = agent.getMessages();

              // 归档当前 session（如果有消息）
              if (currentMessages.length > 0) {
                const session = loadSession(agent.getWorkspacePath());
                if (session) {
                  session.messages = currentMessages;
                  session.lastActivity = new Date().toISOString();

                  // 生成摘要（使用 LLM）
                  screen.appendScroll(COLORS.muted("\n[ARCHIVING] Generating summary...\n"));

                  const { archiveSessionWithSummary, generateSessionSummary } = await import("../utils/session");
                  let summary = '';
                  let fallbackReason = '';

                  // 尝试 LLM 摘要
                  try {
                    const llm = agent.getLLM();
                    if (!llm) {
                      fallbackReason = 'LLM not initialized';
                    } else {
                      const userMessages = currentMessages
                        .filter(m => m.role === 'user')
                        .map(m => m.content || '')
                        .slice(0, 5);

                      if (userMessages.length === 0) {
                        fallbackReason = 'no user messages found';
                      } else {
                        const prompt = `Summarize this coding session in 50-100 words (Chinese or English). Focus on main tasks and files:\n\n${userMessages.join('\n')}`;
                        const response = await llm.generateDirect(prompt);
                        summary = response.content || '';
                        if (!summary) {
                          fallbackReason = 'LLM returned empty summary';
                        }
                      }
                    }
                  } catch (err: any) {
                    fallbackReason = err?.message || String(err);
                  }

                  if (!summary) {
                    summary = generateSessionSummary(currentMessages);
                  }

                  session.summary = summary;
                  archiveSession(agent.getWorkspacePath(), session);

                  screen.appendScroll(
                    COLORS.success(`\n[ARCHIVED] Saved ${currentMessages.length} messages\n`),
                  );
                  screen.appendScroll(COLORS.muted(`  ID: ${session.id}\n`));
                  if (summary) {
                    if (fallbackReason) {
                      screen.appendScroll(COLORS.muted(`  Summary: ${summary}\n`));
                      screen.appendScroll(COLORS.warning(`  [!] LLM summarization failed: ${fallbackReason}\n`));
                      screen.appendScroll(COLORS.muted(`  Using local fallback instead.\n`));
                    } else {
                      screen.appendScroll(COLORS.muted(`  Summary: ${summary}\n`));
                    }
                  }
                }
              }

              // 清空当前 session，开始新聊天
              agent.setMessages([]);
              clearInputQueue();

              screen.appendScroll(COLORS.success("[NEW] Started fresh session\n"));
              screen.appendScroll(COLORS.muted("Use /history to view archived chats (read-only)\n"));

              return;
            }

            // 状态
            if (cmd === "status") {
              const msgs = agent.getMessages().length;
              const queue = getInputQueue();
              const queueStatus = queue.getStatus();

              // Token 计数
              const tokenCounter = new TokenCounter();
              const provider = agent.getLLM()?.getProvider();
              if (provider) {
                tokenCounter.setContextWindow(provider.getContextWindow());
              }
              const usedTokens = tokenCounter.estimateMessages(
                agent.getMessages(),
              );
              const contextWindow = provider?.getContextWindow() || 128000;
              const usagePercent = (usedTokens / contextWindow) * 100;
              const usedK =
                usedTokens >= 1000
                  ? `${Math.floor(usedTokens / 1000)}k`
                  : String(usedTokens);
              const maxK =
                contextWindow >= 1000
                  ? `${Math.floor(contextWindow / 1000)}k`
                  : String(contextWindow);

              screen.appendScroll(COLORS.primary.bold("\nStatus:\n"));
              screen.appendScroll(`  Messages: ${msgs}\n`);
              screen.appendScroll(
                `  Context: ${usagePercent.toFixed(1)}% (${usedK} / ${maxK} tokens)\n`,
              );
              screen.appendScroll(`  Queue: ${queueStatus.pending} pending\n`);
              screen.appendScroll(
                `  Workspace: ${agent.getWorkspacePath()}\n\n`,
              );

              return;
            }

            // Checkpoint 管理
            if (cmd === "checkpoint" || cmd.startsWith("checkpoint ")) {
              const subCmd = cmd.startsWith("checkpoint ") ? cmd.slice(11).trim() : "";
              const parts = subCmd.split(" ");
              const action = parts[0];
              const id = parts.slice(1).join(" ");

              if (!action || action === "list") {
                const checkpoints = await listCheckpoints(agent.getWorkspacePath(), 20);
                screen.appendScroll(COLORS.primary.bold("\nCheckpoints:\n"));
                if (checkpoints.length === 0) {
                  screen.appendScroll(COLORS.muted("  (none)\n"));
                } else {
                  checkpoints.forEach((c) => {
                    const date = new Date(c.timestamp).toLocaleString();
                    screen.appendScroll(`  ${COLORS.success(c.id)} - ${date}\n`);
                    screen.appendScroll(COLORS.muted(`    ${c.promptPreview}\n`));
                  });
                }
                screen.appendScroll(COLORS.muted("\n  Commands: /checkpoint show <id>, /checkpoint restore <id>, /checkpoint clean\n"));
              } else if (action === "show") {
                if (!id) {
                  screen.appendScroll(COLORS.warning("\nUsage: /checkpoint show <id>\n"));
                } else {
                  const meta = await getCheckpoint(agent.getWorkspacePath(), id);
                  if (!meta) {
                    screen.appendScroll(COLORS.error(`\n[ERR] Checkpoint not found: ${id}\n`));
                  } else {
                    screen.appendScroll(COLORS.primary.bold(`\nCheckpoint: ${meta.id}\n`));
                    screen.appendScroll(`  Timestamp: ${new Date(meta.timestamp).toLocaleString()}\n`);
                    screen.appendScroll(`  Prompt: ${meta.promptPreview}\n`);
                    screen.appendScroll(COLORS.primary.bold("  Files:\n"));
                    meta.filesBackedUp.forEach((f) => {
                      screen.appendScroll(COLORS.muted(`    - ${f}\n`));
                    });
                  }
                }
              } else if (action === "restore") {
                if (!id) {
                  screen.appendScroll(COLORS.warning("\nUsage: /checkpoint restore <id>\n"));
                } else {
                  const result = await restoreCheckpoint(agent.getWorkspacePath(), id);
                  if (result.success) {
                    screen.appendScroll(COLORS.success(`\n[OK] Restored ${result.restoredFiles.length} files from ${id}\n`));
                    result.restoredFiles.forEach((f) => {
                      screen.appendScroll(COLORS.muted(`  - ${f}\n`));
                    });
                  } else {
                    screen.appendScroll(COLORS.error(`\n[ERR] ${result.error}\n`));
                  }
                }
              } else if (action === "clean") {
                const result = await cleanCheckpoints(agent.getWorkspacePath(), 20);
                screen.appendScroll(COLORS.success(`\n[OK] Cleaned checkpoints\n`));
                screen.appendScroll(COLORS.muted(`  Deleted: ${result.deleted.length}, Kept: ${result.kept.length}\n`));
              } else {
                screen.appendScroll(COLORS.warning("\nUsage: /checkpoint [list|show <id>|restore <id>|clean]\n"));
              }
              screen.restoreCursor();
              return;
            }

            // Skill 管理
            if (cmd === "skill" || cmd.startsWith("skill ")) {
              const subCmd = cmd.startsWith("skill ") ? cmd.slice(6).trim() : "";
              const parts = subCmd.split(" ");
              const action = parts[0];

              if (!action || action === "list") {
                const skills = listSkills(agent.getWorkspacePath());
                const packages = await listInstalledPackages();

                screen.appendScroll(COLORS.primary.bold("\nSkill Packages:\n"));
                if (packages.length === 0) {
                  screen.appendScroll(COLORS.muted("  (none)\n"));
                } else {
                  packages.forEach((p) => {
                    screen.appendScroll(`  ${COLORS.success("*")} ${p.name} (${p.skills.length} skills)\n`);
                  });
                }

                screen.appendScroll(COLORS.primary.bold("\nAvailable Skills:\n"));
                if (skills.length === 0) {
                  screen.appendScroll(COLORS.muted("  (none)\n"));
                  screen.appendScroll(COLORS.muted("\n  Install: /skill install <url>\n"));
                } else {
                  skills.forEach((s) => {
                    screen.appendScroll(COLORS.muted(`  /${s.name} - ${s.description || ""}\n`));
                  });
                }
              } else if (action === "install") {
                const source = parts.slice(1).join(" ");
                if (!source) {
                  screen.appendScroll(COLORS.warning("\nUsage: /skill install <url-or-path>\n"));
                } else {
                  const result = await installSkill(source);
                  if (result.success) {
                    screen.appendScroll(COLORS.success(`\n[OK] ${result.message}\n`));
                    if (result.skills) {
                      result.skills.forEach((s) => screen.appendScroll(COLORS.muted(`  /${s}\n`)));
                    }
                  } else {
                    screen.appendScroll(COLORS.error(`\n[ERR] ${result.message}\n`));
                  }
                }
              } else if (action === "uninstall") {
                const pkgName = parts.slice(1).join(" ");
                if (!pkgName) {
                  screen.appendScroll(COLORS.warning("\nUsage: /skill uninstall <package-name>\n"));
                } else {
                  const result = await uninstallSkill(pkgName);
                  if (result.success) {
                    screen.appendScroll(COLORS.success(`\n[OK] ${result.message}\n`));
                  } else {
                    screen.appendScroll(COLORS.error(`\n[ERR] ${result.message}\n`));
                  }
                }
              } else if (action === "add") {
                const skillName = parts[1];
                const promptTemplate = parts.slice(2).join(" ") || "{input}";
                if (!skillName) {
                  screen.appendScroll(COLORS.warning("\nUsage: /skill add <name> [promptTemplate]\n"));
                } else {
                  await saveSkill(skillName, { name: skillName, description: `Custom skill: ${skillName}`, promptTemplate });
                  screen.appendScroll(COLORS.success(`\n[OK] Skill added: ${skillName}\n`));
                }
              } else if (action === "remove") {
                const skillName = parts[1];
                if (!skillName) {
                  screen.appendScroll(COLORS.warning("\nUsage: /skill remove <name>\n"));
                } else {
                  const result = await deleteSkill(skillName);
                  if (result) {
                    screen.appendScroll(COLORS.success(`\n[OK] Skill removed: ${skillName}\n`));
                  } else {
                    screen.appendScroll(COLORS.warning(`\n[WARN] Skill not found: ${skillName}\n`));
                  }
                }
              } else if (action === "edit") {
                const skillName = parts[1];
                const promptTemplate = parts.slice(2).join(" ");
                if (!skillName || !promptTemplate) {
                  screen.appendScroll(COLORS.warning("\nUsage: /skill edit <name> <promptTemplate>\n"));
                } else {
                  const existing = getSkill(skillName, agent.getWorkspacePath());
                  if (!existing) {
                    screen.appendScroll(COLORS.warning(`\n[WARN] Skill not found: ${skillName}\n`));
                  } else {
                    await saveSkill(skillName, { ...existing, promptTemplate });
                    screen.appendScroll(COLORS.success(`\n[OK] Skill updated: ${skillName}\n`));
                  }
                }
              } else {
                screen.appendScroll(COLORS.warning("\nUsage: /skill [list|install|uninstall|add|remove|edit]\n"));
              }
              screen.restoreCursor();
              return;
            }

            // MCP 管理
            if (cmd === "mcp" || cmd.startsWith("mcp ")) {
              const subCmd = cmd.startsWith("mcp ") ? cmd.slice(4).trim() : "";
              const parts = subCmd.split(" ");
              const action = parts[0];
              const manager = getMCPManager();

              if (!action || action === "status") {
                const connected = manager.listConnectedServers();
                const tools = manager.listAvailableTools();

                screen.appendScroll(COLORS.primary.bold("\nMCP Status:\n"));
                if (connected.length === 0) {
                  screen.appendScroll(COLORS.muted("  No servers connected\n"));
                  screen.appendScroll(COLORS.muted("\n  Run /mcp init to create example config\n"));
                } else {
                  screen.appendScroll(COLORS.success(`  Connected: ${connected.join(", ")}\n`));
                  screen.appendScroll(COLORS.muted(`  Tools: ${tools.length}\n`));
                  if (tools.length > 0) {
                    tools.slice(0, 5).forEach((t) => {
                      screen.appendScroll(COLORS.muted(`    - ${t}\n`));
                    });
                    if (tools.length > 5) {
                      screen.appendScroll(COLORS.muted(`    ... and ${tools.length - 5} more\n`));
                    }
                  }
                }
              } else if (action === "init") {
                const currentSettings = await loadGlobalSettings();
                if ((currentSettings.mcp?.servers?.length ?? 0) > 0) {
                  screen.appendScroll(COLORS.warning("\nMCP servers already configured\n"));
                  screen.appendScroll(COLORS.muted("  Edit ~/.spica/settings.json to modify\n"));
                } else {
                  currentSettings.mcp = generateExampleConfig();
                  await saveGlobalSettings(currentSettings);
                  screen.appendScroll(COLORS.success(`\n[OK] MCP config added to ${GLOBAL_SETTINGS_FILE}\n`));
                  screen.appendScroll(COLORS.muted("  Edit ~/.spica/settings.json to customize\n"));
                }
              } else if (action === "tools") {
                const allTools = manager.listAvailableTools();
                screen.appendScroll(COLORS.primary.bold("\nMCP Tools:\n"));
                if (allTools.length === 0) {
                  screen.appendScroll(COLORS.muted("  (none)\n"));
                  screen.appendScroll(COLORS.muted("  Connect a MCP server first\n"));
                } else {
                  allTools.forEach((t) => {
                    screen.appendScroll(COLORS.muted(`  ${t}\n`));
                  });
                }
              } else if (action === "disconnect") {
                await manager.disconnectAll();
                screen.appendScroll(COLORS.success("\n[OK] All MCP servers disconnected\n"));
              } else {
                screen.appendScroll(COLORS.warning("\nUsage: /mcp [status|init|tools|disconnect]\n"));
              }
              screen.restoreCursor();
              return;
            }

            // 帮助
            if (cmd === "help" || cmd === "h") {
              showHelp();

              return;
            }

            // 总结当前 session（已完成 + 未完成）
            if (cmd === "summary" || cmd === "sum") {
              const msgs = agent.getMessages();

              if (msgs.length === 0) {
                screen.appendScroll(COLORS.muted("\n[SUMMARY] No messages to summarize\n"));
                return;
              }

              screen.appendScroll(COLORS.primary.bold("\n[SUMMARY] Analyzing session...\n"));
              screen.appendScroll(COLORS.muted("Generating summary...\n"));

              try {
                const llm = agent.getLLM();
                if (!llm) {
                  screen.appendScroll(COLORS.error("LLM not available\n"));
                  return;
                }

                // 构建总结提示词
                const userMessages = msgs
                  .filter(m => m.role === 'user')
                  .map(m => m.content || '')
                  .slice(0, 10);

                const assistantMessages = msgs
                  .filter(m => m.role === 'assistant')
                  .map(m => {
                    let content = m.content || '';
                    if (m.toolCalls && m.toolCalls.length > 0) {
                      const tools = m.toolCalls.map(tc => tc.name).join(', ');
                      content = `[Tools: ${tools}] ${content.slice(0, 50)}`;
                    }
                    return content;
                  })
                  .slice(0, 10);

                const prompt = `请总结以下对话session的工作内容。要求：
1. 简洁明了（200字以内）
2. 区分"已完成"和"进行中/未完成"的任务
3. 提及主要涉及的文件或功能
4. 如果有未解决的问题，简要说明

用户请求：
${userMessages.join('\n')}

AI回复摘要：
${assistantMessages.join('\n')}

请按以下格式输出：

## 已完成
- ...

## 进行中/未完成
- ...

## 涉及内容
文件/功能: ...`;

                const response = await llm.generateDirect(prompt);
                const summary = response.content || 'Unable to generate summary';

                screen.appendScroll("\n");
                summary.split("\n").forEach((line) => {
                  if (line.startsWith("##")) {
                    screen.appendScroll(COLORS.primary.bold(`${line}\n`));
                  } else if (line.startsWith("-")) {
                    screen.appendScroll(COLORS.muted(`${line}\n`));
                  } else {
                    screen.appendScroll(`${line}\n`);
                  }
                });
                screen.appendScroll("\n");
                screen.appendScroll(COLORS.muted(`Session: ${msgs.length} messages analyzed\n`));

              } catch (err) {
                screen.appendScroll(COLORS.error(`\n[ERR] Failed to generate summary\n`));
              }

              return;
            }

            // 压缩上下文
            if (cmd === "compact") {
              await agent.compact();
              // compact 内部已 emit context_compressed 事件，无需重复输出
              screen.restoreCursor();
              return;
            }

            // Init - 让AI分析代码库并创建 AGENTS.md
            if (cmd === "init" || cmd.startsWith("init ")) {
              // 提取用户额外指令
              const userArgs = cmd.startsWith("init ")
                ? cmd.slice(5).trim()
                : "";

              const initPrompt = `Analyze this project and create AGENTS.md. Reference https://agents.md/ for the standard.

What to include: how to build, how to test, code conventions, PR workflow.
Verify every command by running it. Don't guess. Be specific to this project.

If AGENTS.md already exists, preserve valuable content and supplement updates.`;

              handleInput(initPrompt);
              return;
            }

            // Skill 调用（/skill_name args）
            const skillInput = parseSkillInput(trimmed, agent.getWorkspacePath());
            if (skillInput) {
              const skill = getSkill(skillInput.skillName, agent.getWorkspacePath());
              if (skill) {
                const prompt = buildSkillPrompt(skill, skillInput.args);

                screen.appendScroll(
                  COLORS.muted(`\n[${skill.name}] ${skill.description}\n`),
                );
                isProcessing = true;
                state.setProcessing(true);
                updateStatusBar();
                try {
                  await agent.runLoop(prompt);
                  screen.clearThinkingAnimation();
                  screen.setStreaming(false);
                  screen.appendScroll(COLORS.success("\n[OK] Done\n"));
                  playBell("done"); // 工作完成提示音
                } catch (error: unknown) {
                  screen.clearThinkingAnimation();
                  screen.setStreaming(false);
                  const errorMsg = error instanceof Error ? error.message : String(error);
                  screen.appendScroll(
                    COLORS.error(`\n[ERR] ${errorMsg}\n`),
                  );
                  playBell("error"); // 错误提示音
                }
                screen.restoreCursor();
                screen.refreshInput();
                isProcessing = false;
                state.setProcessing(false);
                updateStatusBar();
                saveSession(agent.getWorkspacePath(), agent.getMessages());

                // Auto-drain queued inputs
                await autoDrainQueue(getInputQueue(), async (merged) => {
                  await handleInput(merged);
                });

                return;
              }
            }

            // 未知的 / 命令
            screen.appendScroll(
              COLORS.warning(`\nUnknown command: ${trimmed}\n`),
            );
            screen.appendScroll(COLORS.muted("Type /h for help\n"));
            return;
          }

          // === 执行请求 ===
          // 先显示用户输入在输出区
          screen.appendScroll(COLORS.primary(`\n> ${finalInput}\n`));

          isProcessing = true;
          state.setProcessing(true);
          updateStatusBar();

          // 设置队列输入回调，让 agent 在迭代间隙获取队列输入
          agent.setQueueInputCallback(() => {
            const queue = getInputQueue();
            if (queue.hasPending()) {
              return queue.mergePending();
            }
            return null;
          });

          // 显示处理状态（心跳由 waiting_for_llm 事件自动启动）
          screen.appendScroll(
            COLORS.muted("Processing... (ESC ESC to interrupt)\n"),
          );

          const startTime = Date.now();
          try {
            const result = await agent.runLoop(finalInput);
            const elapsed = Date.now() - startTime;
            if (state.isStreamingOutput()) {
              state.setStreamingOutput(false);
              screen.setStreaming(false);
              screen.appendScroll("\n");
            }
            screen.clearThinkingAnimation();

            // 显示运行统计
            const stats = formatRunStats(elapsed, agent, tokenCounter);
            screen.appendScroll(COLORS.muted(`\n${stats}\n`));
            screen.appendScroll(COLORS.success("[OK] Done\n"));
            playBell("done");
          } catch (error: unknown) {
            const elapsed = Date.now() - startTime;
            const errorMsg = error instanceof Error ? error.message : String(error);
            if (state.isStreamingOutput()) {
              state.setStreamingOutput(false);
              screen.setStreaming(false);
              screen.appendScroll("\n");
            }
            screen.clearThinkingAnimation();
            // 显示运行统计（即使失败也显示）
            const stats = formatRunStats(elapsed, agent, tokenCounter);
            screen.appendScroll(COLORS.muted(`\n${stats}\n`));
            screen.appendScroll(COLORS.error(`[ERR] ${errorMsg}\n`));
            playBell("error");
          }
          // 输出完成，恢复光标到输入框并刷新显示
          screen.clearThinkingAnimation();
          screen.setStreaming(false);
          screen.restoreCursor();
          screen.refreshInput();
          isProcessing = false;
          state.setProcessing(false);
          updateStatusBar();
          
          // 清理队列输入回调
          agent.setQueueInputCallback(null);
          
          saveSession(agent.getWorkspacePath(), agent.getMessages());

          // Auto-drain remaining queued inputs（处理未被注入的剩余队列）
          await autoDrainQueue(getInputQueue(), async (merged) => {
            await handleInput(merged);
          });
        };

        // 帮助信息
        const showHelp = () => {
          screen.appendScroll(COLORS.primary.bold("\nCommands:\n"));
          screen.appendScroll(COLORS.muted("  quit/exit   Exit spica\n"));
          screen.appendScroll(COLORS.muted("  /help /h    Show this help\n"));
          screen.appendScroll("\n");
          screen.appendScroll(COLORS.primary.bold("Session:\n"));
          screen.appendScroll(COLORS.muted("  /archive /clear /reset /new  Archive current & start new\n"));
          screen.appendScroll(COLORS.muted("  /history /sessions           Browse archived chats (read-only)\n"));
          screen.appendScroll(COLORS.muted("  /view <id>                   Read specific archived chat\n"));
          screen.appendScroll(COLORS.muted("  /rename <id> <name>          Rename archived chat\n"));
          screen.appendScroll(COLORS.muted("  /delete <id>                 Delete archived chat\n"));
          screen.appendScroll(COLORS.muted("  /summary /sum                Summarize current session\n"));
          screen.appendScroll(COLORS.muted("  /compact                     Compress context\n"));
          screen.appendScroll(COLORS.muted("  /init [instructions]         Create AGENTS.md\n"));
          screen.appendScroll("\n");
          screen.appendScroll(COLORS.primary.bold("Queue:\n"));
          screen.appendScroll(COLORS.muted("  /queue /q    Show input queue\n"));
          screen.appendScroll(COLORS.muted("  /undo        Remove last queued input\n"));
          screen.appendScroll("\n");
          screen.appendScroll(COLORS.primary.bold("Checkpoint:\n"));
          screen.appendScroll(COLORS.muted("  /checkpoint list            List checkpoints\n"));
          screen.appendScroll(COLORS.muted("  /checkpoint show <id>       Show checkpoint details\n"));
          screen.appendScroll(COLORS.muted("  /checkpoint restore <id>    Restore files from checkpoint\n"));
          screen.appendScroll(COLORS.muted("  /checkpoint clean           Clean old checkpoints\n"));
          screen.appendScroll("\n");
          screen.appendScroll(COLORS.primary.bold("Skill:\n"));
          screen.appendScroll(COLORS.muted("  /skill list             List skills\n"));
          screen.appendScroll(COLORS.muted("  /skill install <url>    Install skill package\n"));
          screen.appendScroll(COLORS.muted("  /skill uninstall <name> Uninstall skill package\n"));
          screen.appendScroll(COLORS.muted("  /skill add <name> [tpl] Add custom skill\n"));
          screen.appendScroll(COLORS.muted("  /skill remove <name>    Remove skill\n"));
          screen.appendScroll(COLORS.muted("  /skill edit <name> <tpl> Edit skill template\n"));
          screen.appendScroll("\n");
          screen.appendScroll(COLORS.primary.bold("MCP:\n"));
          screen.appendScroll(COLORS.muted("  /mcp status     Show MCP status\n"));
          screen.appendScroll(COLORS.muted("  /mcp init       Create example config\n"));
          screen.appendScroll(COLORS.muted("  /mcp tools      List available tools\n"));
          screen.appendScroll(COLORS.muted("  /mcp disconnect Disconnect all servers\n"));
          screen.appendScroll("\n");
          screen.appendScroll(COLORS.muted("  /status     Show status (messages, tokens, model, queue)\n"));
          screen.appendScroll("\n");
        };

        // 保持进程运行
        await new Promise<void>((resolve) => {
          process.on("exit", resolve);
        });
      } catch (error: unknown) {
        // 停止banner动画
        BG.stopBanner();
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (!state.isConnectionErrorShown()) {
          if (tuiHandler) {
            screen.appendScroll(COLORS.error(`\nError: ${errorMsg}\n`));
          } else {
            console.log(COLORS.error(`Error: ${errorMsg}`));
          }
        }
      }

      state.setAgent(null);
}
