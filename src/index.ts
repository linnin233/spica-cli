#!/usr/bin/env node
import { Command } from "commander";
import { SpicaAgent } from "./agent";
import { loadGlobalSettings, getProviderConfig } from "./utils/settings";
import { playBell } from "./utils/bell";

import { COLORS } from "./cli/ui/colors";
import { setupAgentEvents } from "./cli/events";
import { updateStatusBar } from "./cli/status";
import { getRuntimeState } from "./core/RuntimeState";
import { saveSession } from "./utils/session";
import { getScreenManager } from "./cli/ui/screenManager";

import { registerProviderCommands } from "./commands/providers";
import { runSimpleMode } from "./commands/simpleMode";

import { runInteractiveMode } from "./commands/interactive";
const program = new Command();
const state = getRuntimeState();
const screen = getScreenManager();
const ESC = "\x1b";

// Ctrl+C中断处理（SIGINT - 在非 raw mode 或特殊情况下触发）
let interruptCount = 0;
let interruptTimeout: NodeJS.Timeout | null = null;
let tuiStarted = false; // 标记 TUI 是否已启动

process.on("SIGINT", () => {
  // 连续Ctrl+C强制退出
  interruptCount++;
  if (interruptCount >= 3) {
    // Save session before force exit
    const agent = state.getAgent();
    if (agent) {
      try {
        saveSession(
          agent.getWorkspacePath(),
          agent.getSessionState(),
          undefined,
          agent.getProgressSnapshot(),
        );
      } catch {}
    }
    if (tuiStarted) screen.end();
    console.log(COLORS.error("\n[FORCE EXIT]"));
    process.exit(0);
  }

  // 重置计数器（1秒内没有第二次Ctrl+C）
  if (interruptTimeout) clearTimeout(interruptTimeout);
  interruptTimeout = setTimeout(() => {
    interruptCount = 0;
  }, 1000);

  if (state.getAgent()) {
    state.getAgent()!.interrupt();
    // Save session on every interrupt for crash resilience
    try {
      const a = state.getAgent()!;
      saveSession(
        a.getWorkspacePath(),
        a.getSessionState(),
        undefined,
        a.getProgressSnapshot(),
      );
    } catch {}
    state.setProcessing(false);
    updateStatusBar();
    if (tuiStarted) {
      screen.appendScroll(
        COLORS.warning("\n[INTERRUPTED] Ctrl+C again to exit\n"),
      );
      screen.clearThinkingAnimation();
      screen.setStreaming(false);
      screen.restoreCursor();
      screen.refreshInput();
    } else {
      console.log(COLORS.warning("\n[INTERRUPTED] Ctrl+C again to exit"));
    }
  } else {
    if (tuiStarted) screen.end();
    process.exit(0);
  }
});

program
  .name("spica")
  .description("AI coding assistant")
  .version("1.0.0")
  .addHelpText(
    "after",
    '\nExamples:\n  spica                    Start interactive session\n  spica run "fix bug"      Execute one task\n  spica set openai https://api.openai.com/v1 sk-xxx gpt-4o\n\nInternal commands (in session):\n  /skill, /mcp, /session, /queue, /status, /help',
  );

// 默认：持续对话模式（自动加载历史）
program
  .option("-f, --fresh", "Start fresh session (no history)")
  .option("-p, --provider <name>", "Use specific provider")
  .option("--no-tui", "Run in non-interactive mode (no TUI, simple output)")
  .action(
    async (options: {
      fresh?: boolean;
      provider?: string;
      noTui?: boolean;
    }) => {
      const config = await loadGlobalSettings();
      const providerName =
        options.provider || config.defaultProvider || "openai";

      // 检测是否支持交互式终端
      const isInteractiveTerminal = process.stdin.isTTY && process.stdout.isTTY;
      const useSimpleMode = options.noTui || !isInteractiveTerminal;

      let providerConfig;
      try {
        providerConfig = await getProviderConfig(providerName);
        state.setProviderConfig(providerConfig);
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.log("");
        console.log(COLORS.error(errorMsg));
        console.log("");
        return;
      }

      const agent = new SpicaAgent(providerName, process.cwd());
      state.setAgent(agent);

      // 如果是非交互模式，使用简单输出
      if (useSimpleMode) {
        console.log(
          COLORS.muted("[INFO] Running in non-interactive mode (no TUI)"),
        );
        await runSimpleMode(agent, options.fresh);
        return;
      }
      await runInteractiveMode(agent, options);
    },
  );

// Run command - 单次执行
program
  .command("run <request>")
  .description(
    "Execute single coding task and exit (non-interactive mode)\n\nUse for quick fixes or one-time tasks",
  )
  .option("-p, --provider <name>", "Use specific provider")
  .addHelpText(
    "after",
    '\nExamples:\n  spica run "fix login bug"\n  spica run "add CSV export" -p deepseek\n  spica run "refactor user module"',
  )
  .action(async (request: string, options: { provider?: string }) => {
    const config = await loadGlobalSettings();
    const providerName = options.provider || config.defaultProvider || "openai";

    let providerConfig;
    try {
      providerConfig = await getProviderConfig(providerName);
    } catch (error: unknown) {
      console.log(COLORS.error(`Provider "${providerName}" not configured.`));
      console.log(
        COLORS.warning("Set up with: spica providers set <name> <api-key>"),
      );
      return;
    }

    const agent = new SpicaAgent(providerName, process.cwd());
    state.setAgent(agent);

    const cleanupEvents = setupAgentEvents(agent, false);

    try {
      await agent.init();
      const result = await agent.runLoop(request);
      console.log(COLORS.success("\n[OK] Completed"));
      playBell("done");
    } catch (error: unknown) {
      if (!state.isConnectionErrorShown()) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.log(COLORS.error(`Error: ${errorMsg}`));
      }
      playBell("error");
    } finally {
      cleanupEvents();
      agent.dispose();
    }

    state.setAgent(null);
    state.setConnectionErrorShown(false); // 重置
  });

registerProviderCommands(program);
program.parse();
