import { SpicaAgent } from '../agent';
import { loadSession, saveSession, archiveSession } from '../utils/session';
import { COLORS, BG } from '../cli/ui/colors';
import { getRuntimeState } from '../core/RuntimeState';
import { playBell } from '../utils/bell';
import * as readline from 'readline';

const state = getRuntimeState();

/**
 * Run in simple (non-TUI, non-interactive terminal) mode.
 * Uses readline for input and console.log for output.
 */
export async function runSimpleMode(agent: SpicaAgent, fresh?: boolean): Promise<void> {
  try {
    await agent.init();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Event data types are dynamic
    agent.on('stream', (data: any) => {
      process.stdout.write(data.chunk);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Event data types are dynamic
    agent.on('reasoning', (data: any) => {
      process.stdout.write(COLORS.reasoning(data.content));
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Event data types are dynamic
    agent.on('tool_call', (data: any) => {
      console.log(COLORS.tool(`\n[TOOL] ${data.name}`));
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Event data types are dynamic
    agent.on('tool_progress', (data: any) => {
      const elapsed = data.elapsed || 0;
      const stage = data.stage || data.command || '';
      process.stdout.write(COLORS.muted(`\r  [${elapsed}s] ${stage}...`));
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Event data types are dynamic
    agent.on('tool_result', (data: any) => {
      const icon = data.success ? COLORS.success('[OK]') : COLORS.error('[ERR]');
      console.log(`\n${icon} ${data.name}`);
      if (data.error) {
        console.log(COLORS.error(`  Error: ${data.error}`));
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Event data types are dynamic
    agent.on('message', (data: any) => {
      if (data.role === 'assistant') {
        console.log(); // 新行
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Event data types are dynamic
    agent.on('context_compressed', (data: any) => {
      console.log(COLORS.secondary(`\n[COMPRESS] ${data.before} -> ${data.after} messages`));
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Event data types are dynamic
    agent.on('connection_error', (data: any) => {
      state.setConnectionErrorShown(true);
      console.log(COLORS.error(`\n[ERR] ${data.type}: ${data.hint}`));
      if (data.error) {
        console.log(COLORS.muted(`Details: ${data.error}`));
      }
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
        console.log('Commands: quit, exit, help, /archive, /compact, /history, /status');
        rl.prompt();
        return;
      }

      if (trimmed.startsWith('/')) {
        const cmd = trimmed.slice(1).toLowerCase();
        if (cmd === 'clear' || cmd === 'archive' || cmd === 'new') {
          // 归档当前聊天并开始新聊天
          const currentMessages = agent.getMessages();
          if (currentMessages.length > 0) {
            const session = loadSession(agent.getWorkspacePath());
            if (session) {
              session.messages = currentMessages;
              session.lastActivity = new Date().toISOString();
              const summary = await archiveSession(agent.getWorkspacePath(), session);
              console.log(COLORS.success(`[ARCHIVED] Saved ${currentMessages.length} messages`));
              if (summary) {
                console.log(COLORS.muted(`  Summary: ${summary}`));
              }
            }
          }
          agent.setMessages([]);
          console.log(COLORS.muted('[NEW] Started fresh session'));
        } else if (cmd === 'compact') {
          await agent.compact();
        } else if (cmd === 'history') {
          const messages = agent.getMessages();
          console.log(COLORS.muted(`\n[History] ${messages.length} messages`));
        } else if (cmd === 'status') {
          const messages = agent.getMessages();
          console.log(COLORS.primary(`\n[Status]`));
          console.log(`  Messages: ${messages.length}`);
        } else {
          console.log(COLORS.warning(`Unknown command: ${trimmed}`));
        }
        rl.prompt();
        return;
      }

      // 执行请求
      try {
        console.log(COLORS.muted('\n[PROCESSING]...'));
        await agent.runLoop(trimmed);
        console.log(COLORS.success('\n[OK] Done'));
        playBell('done');
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.log(COLORS.error(`\n[ERR] ${errorMsg}`));
        playBell('error');
      }

      rl.prompt();
    });

    rl.on('close', () => {
      console.log(COLORS.muted('\n[EXIT] Goodbye!'));
      saveSession(agent.getWorkspacePath(), agent.getSessionState(), undefined, agent.getProgressSnapshot());
      process.exit(0);
    });
  } catch (error: unknown) {
    // 停止banner动画（如果正在运行）
    BG.stopBanner();
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log(COLORS.error(`Error: ${errorMsg}`));
    process.exit(1);
  }
}
