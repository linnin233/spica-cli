import { SpicaAgent } from "../agent";
import { execSync } from "child_process";
import { getProviderConfig } from "../utils/settings";
import { loadSession, saveSession } from "../utils/session";
import { listSkills, listSkillsByPackage } from "../skills";
import { shutdownMCP } from "../mcp/client";
import { COLORS, BG } from "../cli/ui/colors";
import { getInputQueue } from "../cli/ui/queue";
import { autoDrainQueue } from "../cli/queueDrain";
import { addIdea, getAllIdeas, markDone, deleteIdea } from "../storage/ideaStore";
import { renderIdeaOverlay } from "../cli/ui/ideaOverlay";
import { dispatchSlash } from "./slash";
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
          "/idea",
          "/ideas",
          "/idea-done",
          "/idea-delete",
        ];
        const getCommands = () => {
          const skills = listSkills(agent.getWorkspacePath());
          const skillCommands = skills.map((s) => `/${s.name}`).sort();
          // Base commands first, then skills — natural clustering in tab display
          return [...BASE_COMMANDS, ...skillCommands];
        };
        tuiHandler.getScreen().setCompleter((line: string) => {
          return getCommands().filter((c) => c.startsWith(line));
        });

        // Build grouped completion map for categorized tab display.
        // Base commands go under "spica", skills under their package name.
        const skillGroups = listSkillsByPackage(agent.getWorkspacePath());
        const groups: Record<string, string[]> = { spica: [...BASE_COMMANDS].sort() };
        // Merge skill groups into the map
        Object.entries(skillGroups).forEach(([pkg, cmds]) => {
          groups[pkg] = cmds;
        });
        tuiHandler.getScreen().setCompletionGroups(groups);

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

          const wsLabel = screen.isInIdeaWorkspace() ? 'Idea | ' : '';
          screen.setStatus(
            `${wsLabel}${statusText} | ${providerConfig!.model}${branchInfo} | ${displayPath}`,
          );
        };
        setUpdateStatusBarFn(updateStatusBarLocal);
        updateStatusBarLocal();

        // Set idea overlay render function — called when entering idea workspace
        screen.setIdeaOverlayRenderFn(() => {
          const ideas = getAllIdeas(agent.getWorkspacePath());
          return renderIdeaOverlay(ideas);
        });

        // Set workspace change callback for status bar refresh
        screen.state.onWorkspaceChange = () => updateStatusBarLocal();

        // TokenCounter 用于结束统计显示
        const provider = agent.getLLM()?.getProvider();
        const contextWindow = provider?.getContextWindow() || 128000;
        const tokenCounter = new TokenCounter();
        tokenCounter.setContextWindow(contextWindow);

        // 设置 Ctrl+O 切换回调（compact → verbose → hacker → compact）
        screen.setVerboseToggleCallback(() => {
          screen.clearThinkingAnimation();
          const newMode = state.cycleDisplayMode();
          const modeLabels: Record<string, string> = {
            compact: 'Compact',
            verbose: 'Verbose',
            hacker: 'Hacker (matrix rain)',
          };
          screen.appendScroll(
            COLORS.secondary(
              `\n[MODE] ${modeLabels[newMode] || newMode} display enabled\n`,
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
            handleInput(result.content.trim()).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              screen.appendScroll(COLORS.error(`\n[ERR] handleInput: ${msg}\n`));
            });
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
            const messages = agent.getSessionState();
            saveSession(agent.getWorkspacePath(), messages, undefined, agent.getProgressSnapshot());
            await shutdownMCP();
            state.setAgent(null);
            // 使用console.log而不是appendScroll
            console.log(COLORS.muted(`Session saved (${messages.length} messages)`));
            console.log(COLORS.muted("Goodbye!"));
            process.exit(0);
            return;
          }

          // Idea workspace input handling
          if (screen.isInIdeaWorkspace()) {
            const wsp = agent.getWorkspacePath();

            // Empty input → exit to main workspace
            if (!trimmed) {
              screen.exitIdeaWorkspace();
              return;
            }

            // Slash commands work in idea workspace too
            if (trimmed.startsWith('/')) {
              const handled = await dispatchSlash(trimmed, {
                agent, screen, state, tokenCounter,
                isProcessing,
                setProcessing: (v: boolean) => { isProcessing = v; state.setProcessing(v); },
                providerConfig: providerConfig!,
                updateStatusBar: updateStatusBarLocal,
                handleInput,
              });
              if (handled) return;
              return;
            }

            // d<N> — mark done
            const doneMatch = trimmed.match(/^d(\d+)$/i);
            if (doneMatch) {
              const id = parseInt(doneMatch[1], 10);
              markDone(wsp, id);
              const ideas = getAllIdeas(wsp);
              screen.writeOverlay(renderIdeaOverlay(ideas));
              screen.clearInput();
              screen.refreshInput();
              screen.restoreCursor();
              return;
            }

            // x<N> — delete
            const delMatch = trimmed.match(/^x(\d+)$/i);
            if (delMatch) {
              const id = parseInt(delMatch[1], 10);
              deleteIdea(wsp, id);
              const ideas = getAllIdeas(wsp);
              screen.writeOverlay(renderIdeaOverlay(ideas));
              screen.clearInput();
              screen.refreshInput();
              screen.restoreCursor();
              return;
            }

            // b<N> — fill with brainstorm prefix, switch to main
            const brainstormMatch = trimmed.match(/^b(\d+)$/i);
            if (brainstormMatch) {
              const id = parseInt(brainstormMatch[1], 10);
              const ideas = getAllIdeas(wsp);
              const idea = ideas.find(i => i.id === id);
              if (idea) {
                screen.exitIdeaWorkspace();
                screen.setInput(`Let's brainstorm: ${idea.text}`);
                screen.refreshInput();
                screen.restoreCursor();
              }
              return;
            }

            // <N> — fill idea into input, switch to main
            const fillMatch = trimmed.match(/^(\d+)$/);
            if (fillMatch) {
              const id = parseInt(fillMatch[1], 10);
              const ideas = getAllIdeas(wsp);
              const idea = ideas.find(i => i.id === id);
              if (idea) {
                screen.exitIdeaWorkspace();
                screen.setInput(idea.text);
                screen.refreshInput();
                screen.restoreCursor();
              }
              return;
            }

            // Plain text — create new idea
            const idea = addIdea(wsp, trimmed);
            if (idea) {
              const ideas = getAllIdeas(wsp);
              screen.writeOverlay(renderIdeaOverlay(ideas));
              screen.clearInput();
              screen.refreshInput();
              screen.restoreCursor();
            }
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
            const cmd = trimmed.slice(1).toLowerCase().split(/\s+/)[0];

            // 删除 /switch 功能（历史只读）
            if (cmd === "switch") {
              screen.appendScroll(COLORS.warning("\n[NOTE] /switch is disabled\n"));
              screen.appendScroll(COLORS.muted("  History sessions are read-only for review.\n"));
              screen.appendScroll(COLORS.muted("  To continue work, stay in current session.\n"));
              screen.appendScroll(COLORS.muted("  Use /archive to save current and start new.\n\n"));
              return;
            }

            // All slash commands → unified dispatch
            const handled = await dispatchSlash(trimmed, {
              agent,
              screen,
              state,
              tokenCounter,
              isProcessing,
              setProcessing: (v: boolean) => { isProcessing = v; state.setProcessing(v); },
              providerConfig: providerConfig!,
              updateStatusBar: updateStatusBarLocal,
              handleInput,
            });
            screen.restoreCursor();
            if (handled) return;

            // dispatchSlash didn't handle it — unknown command
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
          state.setInterrupted(false);
          updateStatusBar();

          // 设置队列输入回调，让 agent 在迭代间隙获取队列输入
          agent.setQueueInputCallback(() => {
            const queue = getInputQueue();
            if (queue.hasPending()) {
              return queue.mergePending();
            }
            return null;
          });

          // Hacker mode: start rain before processing
          const isHacker = state.getDisplayMode() === 'hacker';
          if (isHacker) {
            screen.startRain();
          } else {
            screen.appendScroll(
              COLORS.muted("Processing... (ESC ESC to interrupt)\n"),
            );
          }

          const startTime = Date.now();
          try {
            const result = await agent.runLoop(finalInput);
            const elapsed = Date.now() - startTime;
            if (state.isStreamingOutput()) {
              state.setStreamingOutput(false);
              screen.setStreaming(false);
            }

            // Hacker mode: stop rain, reprint result that was consumed by rain
            if (isHacker) {
              screen.stopRain();
              screen.appendScroll(COLORS.primary(`\n> ${finalInput}\n`));
              // Reprint the actual response (it was shown as rain, now as text)
              if (result && !result.startsWith('[')) {
                screen.appendScroll(COLORS.primary(result + '\n'));
              }
            }

            screen.appendScroll("\n");
            screen.clearThinkingAnimation();

            const stats = formatRunStats(elapsed, agent, tokenCounter);
            screen.appendScroll(COLORS.muted(`\n${stats}\n`));
            if (result && result.startsWith('[')) {
              screen.appendScroll(COLORS.muted(`${result}\n`));
            } else {
              screen.appendScroll(COLORS.success("[OK] Done\n"));
              playBell("done");
            }
          } catch (error: unknown) {
            const elapsed = Date.now() - startTime;
            const errorMsg = error instanceof Error ? error.message : String(error);
            if (state.isStreamingOutput()) {
              state.setStreamingOutput(false);
              screen.setStreaming(false);
            }

            // Hacker mode: stop rain, restore normal display
            if (isHacker) {
              screen.stopRain();
              screen.appendScroll(COLORS.primary(`\n> ${finalInput}\n`));
            }

            screen.appendScroll("\n");
            screen.clearThinkingAnimation();
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
          
          saveSession(agent.getWorkspacePath(), agent.getSessionState());

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
