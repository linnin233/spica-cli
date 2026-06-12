import { COLORS } from '../../cli/ui/colors';
import {
  listSessions,
  loadSession,
  loadSessionById,
  archiveSession,
  deleteSession,
  renameSession,
  generateSessionSummary,
} from '../../utils/session';
import { clearInputQueue } from '../../cli/ui/queue';
import type { SlashHandler } from './types';

export const sessionHandler: SlashHandler = async (args, ctx) => {
  const parts = args.trim().split(/\s+/);
  const subCmd = parts[0];

  // /archive, /clear, /reset, /new
  if (subCmd === 'archive' || subCmd === 'clear' || subCmd === 'reset' || subCmd === 'new') {
    const currentMessages = ctx.agent.getMessages();
    if (currentMessages.length === 0) {
      ctx.screen.appendScroll(COLORS.muted('\nNo messages to archive.\n'));
      return;
    }

    const workspacePath = ctx.agent.getWorkspacePath();
    const session = loadSession(workspacePath);

    if (session) {
      let summary = session.summary;
      let fallbackReason: string | undefined;

      if (!summary) {
        try {
          const llm = ctx.agent.getLLM();
          if (llm) {
            const response = await llm.generateDirect(
              `Summarize this coding session: ${generateSessionSummary(currentMessages)}`
            );
            summary = response.content || '';
          }
        } catch (err: unknown) {
          fallbackReason = err instanceof Error ? err.message : String(err);
        }
      }

      if (!summary) {
        summary = generateSessionSummary(currentMessages);
      }

      session.summary = summary;
      archiveSession(workspacePath, session);

      ctx.screen.appendScroll(
        COLORS.success(`\n[ARCHIVED] Saved ${currentMessages.length} messages\n`),
      );
      ctx.screen.appendScroll(COLORS.muted(`  ID: ${session.id}\n`));
      if (summary) {
        if (fallbackReason) {
          ctx.screen.appendScroll(COLORS.muted(`  Summary: ${summary}\n`));
          ctx.screen.appendScroll(COLORS.warning(`  [!] LLM summarization failed: ${fallbackReason}\n`));
          ctx.screen.appendScroll(COLORS.muted(`  Using local fallback instead.\n`));
        } else {
          ctx.screen.appendScroll(COLORS.muted(`  Summary: ${summary}\n`));
        }
      }
    }

    ctx.agent.setMessages([]);
    clearInputQueue();

    ctx.screen.appendScroll(COLORS.success('[NEW] Started fresh session\n'));
    ctx.screen.appendScroll(COLORS.muted('Use /history to view archived chats (read-only)\n'));

    return;
  }

  // /view <id>
  if (subCmd === 'view') {
    const sessionId = parts[1];
    if (!sessionId) {
      ctx.screen.appendScroll(COLORS.warning('\nUsage: /view <session-id>\n'));
      return;
    }

    const session = loadSessionById(ctx.agent.getWorkspacePath(), sessionId);
    if (!session) {
      ctx.screen.appendScroll(COLORS.warning(`\nSession not found: ${sessionId}\n`));
      return;
    }

    ctx.screen.appendScroll(COLORS.primary.bold(`\nSession: ${session.name || session.id}\n`));
    if (session.summary) {
      ctx.screen.appendScroll(COLORS.muted(`  ${session.summary}\n`));
    }
    ctx.screen.appendScroll(COLORS.muted(`  Messages: ${session.messages?.length || 0}\n`));
    ctx.screen.appendScroll(COLORS.muted(`  Created: ${session.createdAt}\n`));
    ctx.screen.appendScroll(COLORS.muted(`  Last activity: ${session.lastActivity}\n`));
    ctx.screen.appendScroll('\n');

    return;
  }

  // /rename <id> <name>
  if (subCmd === 'rename') {
    const sessionId = parts[1];
    const newName = parts.slice(2).join(' ');
    if (!sessionId || !newName) {
      ctx.screen.appendScroll(COLORS.warning('\nUsage: /rename <session-id> <name>\n'));
      return;
    }

    const ok = renameSession(ctx.agent.getWorkspacePath(), sessionId, newName);
    if (ok) {
      ctx.screen.appendScroll(COLORS.success(`\n[OK] Session renamed to: ${newName}\n`));
    } else {
      ctx.screen.appendScroll(COLORS.warning(`\nSession not found: ${sessionId}\n`));
    }

    return;
  }

  // /delete <id>
  if (subCmd === 'delete') {
    const sessionId = parts[1];
    if (!sessionId) {
      ctx.screen.appendScroll(COLORS.warning('\nUsage: /delete <session-id>\n'));
      return;
    }

    const ok = deleteSession(ctx.agent.getWorkspacePath(), sessionId);
    if (ok) {
      ctx.screen.appendScroll(COLORS.success(`\n[OK] Session deleted: ${sessionId}\n`));
    } else {
      ctx.screen.appendScroll(COLORS.warning(`\nSession not found: ${sessionId}\n`));
    }

    return;
  }

  // /history, /sessions, /h (default)
  const sessions = listSessions(ctx.agent.getWorkspacePath());

  ctx.screen.appendScroll(COLORS.primary.bold('\nSessions\n'));
  ctx.screen.appendScroll(COLORS.muted('─'.repeat(60) + '\n'));

  const currentMsgs = ctx.agent.getMessages();
  const currentId = loadSession(ctx.agent.getWorkspacePath())?.id;
  ctx.screen.appendScroll(COLORS.primary(`* Current: ${currentMsgs.length} messages`) +
    (currentId ? COLORS.muted(`  (id: ${currentId.slice(-12)})`) : '') + '\n');
  ctx.screen.appendScroll(COLORS.muted('─'.repeat(60) + '\n'));

  if (sessions.length === 0) {
    ctx.screen.appendScroll(COLORS.muted('  No archived sessions.\n'));
    ctx.screen.appendScroll(COLORS.muted('  /archive to save current and start new.\n\n'));
    return;
  }

  sessions.slice(0, 20).forEach((s, i) => {
    const isCurrent = s.id === currentId;
    const prefix = isCurrent ? '*' : ' ';
    const date = new Date(s.lastActivity).toLocaleDateString();
    const name = s.name || s.id;
    const summary = s.summary || '';

    ctx.screen.appendScroll(
      COLORS.muted(`${prefix} ${i + 1}. ${name}  (${s.messageCount} msgs, ${date})\n`),
    );
    if (summary) {
      ctx.screen.appendScroll(COLORS.muted(`     ${summary.slice(0, 100)}\n`));
    }
  });

  ctx.screen.appendScroll('\n');
};
