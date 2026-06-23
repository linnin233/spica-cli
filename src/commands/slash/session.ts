import { COLORS } from '../../cli/ui/colors';
import {
  listSessions,
  loadSession,
  loadSessionById,
  archiveSession,
  deleteSession,
  renameSession,
  clearSession,
} from '../../utils/session';
import { clearInputQueue } from '../../cli/ui/queue';
import { sessionStats } from '../../core/sessionStats';
import { subAgentState } from '../../cli/subagentPanel';
import type { SlashHandler } from './types';

export const sessionHandler: SlashHandler = async (args, ctx) => {
  const parts = args.trim().split(/\s+/);
  const subCmd = parts[0];

  // /archive, /clear, /reset, /new
  if (subCmd === 'archive' || subCmd === 'clear' || subCmd === 'reset' || subCmd === 'new') {
    const currentMessages = ctx.agent.getMessages();
    if (currentMessages.length === 0) {
      ctx.screen.appendScroll(COLORS.muted('\nNo messages to archive.\n'));
      ctx.screen.restoreCursor();
      return;
    }

    // ── Immediate feedback ──
    // Show archiving intent BEFORE the potentially slow LLM summary call.
    // This prevents the user from staring at nothing while the summary generates.
    ctx.screen.appendScroll(
      COLORS.primary(`\n[ARCHIVE] Archiving ${currentMessages.length} messages…\n`),
    );
    ctx.screen.restoreCursor();

    const workspacePath = ctx.agent.getWorkspacePath();
    const session = loadSession(workspacePath);

    if (session) {
      session.messages = currentMessages;
      session.lastActivity = new Date().toISOString();

      ctx.screen.appendScroll(COLORS.muted('  Generating summary…\n'));
      ctx.screen.restoreCursor();

      const llm = ctx.agent.getLLM();
      const summary = await archiveSession(workspacePath, session, llm || undefined);

      ctx.screen.appendScroll(
        COLORS.success(`\n[ARCHIVED] Saved ${currentMessages.length} messages\n`),
      );
      ctx.screen.appendScroll(COLORS.muted(`  ID: ${session.id}\n`));
      if (summary) {
        ctx.screen.appendScroll(COLORS.muted(`  Summary: ${summary}\n`));
      }
    }

    // Delete session.json so the next save generates a fresh session ID.
    // Without this, saveSession() reads the old ID from disk and the next
    // archive overwrites the previous one.
    clearSession(workspacePath);
    ctx.agent.setMessages([]);
    clearInputQueue();
    subAgentState.clear();

    // Reset per-session usage stats for fresh start
    sessionStats.reset();

    ctx.screen.appendScroll(COLORS.success('[NEW] Started fresh session\n'));
    ctx.screen.appendScroll(COLORS.muted('Use /history to view archived chats (read-only)\n'));
    ctx.screen.restoreCursor();

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
      ctx.screen.appendScroll(COLORS.muted(`  Workspace: ${ctx.agent.getWorkspacePath()}\n`));
      return;
    }

    ctx.screen.appendScroll(COLORS.primary.bold(`\nReading: ${session.name || sessionId}\n`));
    ctx.screen.appendScroll(COLORS.muted(`  Created: ${new Date(session.createdAt).toLocaleString()}\n`));
    ctx.screen.appendScroll(COLORS.muted(`  Last: ${new Date(session.lastActivity).toLocaleString()}\n`));
    ctx.screen.appendScroll(COLORS.muted(`  Messages: ${session.messages?.length || 0}\n`));
    if (session.summary) {
      ctx.screen.appendScroll(COLORS.muted(`  Summary: ${session.summary}\n`));
    }

    // Show all messages (500 chars each)
    const messages = session.messages || [];

    messages.forEach((m) => {
      const role = m.role === 'user' ? '[user]' : m.role === 'assistant' ? '[ai]' : m.role === 'tool' ? '[tool]' : '[sys]';
      const content = (m.content || '').slice(0, 500);
      const preview = content.split('\n').slice(0, 3).join(' ');

      ctx.screen.appendScroll(COLORS.primary(`${role} `));
      ctx.screen.appendScroll(COLORS.muted(`${preview}\n`));

      if (m.toolCalls && m.toolCalls.length > 0) {
        ctx.screen.appendScroll(COLORS.muted(`  tools: ${m.toolCalls.map(tc => tc.name).join(', ')}\n`));
      }
    });

    ctx.screen.appendScroll(COLORS.muted(`\n  -- End of session (${messages.length} messages) --\n\n`));

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
    (currentId ? COLORS.muted(`  (id: ${currentId})`) : '') + '\n');
  ctx.screen.appendScroll(COLORS.muted('─'.repeat(60) + '\n'));

  if (sessions.length === 0) {
    ctx.screen.appendScroll(COLORS.muted('  No archived sessions.\n'));
    ctx.screen.appendScroll(COLORS.muted('  /archive to save current and start new.\n\n'));
    return;
  }

  sessions.forEach((s, i) => {
    const isCurrent = s.id === currentId;
    const prefix = isCurrent ? '*' : ' ';
    const date = new Date(s.lastActivity).toLocaleDateString();
    const name = s.name || s.id;
    const idDisplay = s.name ? COLORS.muted(` [${s.id}]`) : '';
    const summary = s.summary || '';

    ctx.screen.appendScroll(
      COLORS.muted(`${prefix} ${i + 1}. ${name}${idDisplay}  (${s.messageCount} msgs, ${date})\n`),
    );
    if (summary) {
      ctx.screen.appendScroll(COLORS.muted(`     ${summary}\n`));
    }
  });

  ctx.screen.appendScroll(COLORS.muted('\n' + '─'.repeat(60) + '\n'));
  ctx.screen.appendScroll(COLORS.muted('/view <id>  /rename <id> <name>  /delete <id>\n\n'));
};
