import { COLORS } from '../../cli/ui/colors';
import { addIdea, getAllIdeas, deleteIdea, markDone, markOpen } from '../../storage/ideaStore';
import { renderIdeaOverlay } from '../../cli/ui/ideaOverlay';
import type { SlashHandler } from './types';

export const ideaHandler: SlashHandler = async (args, ctx) => {
  const parts = args.trim().split(/\s+/);
  const subCmd = parts[0];
  const workspacePath = ctx.agent.getWorkspacePath();

  // /ideas — list all ideas in scrollback
  if (subCmd === 'ideas') {
    const ideas = getAllIdeas(workspacePath);
    ctx.screen.appendScroll(COLORS.primary.bold('\nIdeas\n'));
    ctx.screen.appendScroll(COLORS.muted('─'.repeat(50) + '\n'));

    if (ideas.length === 0) {
      ctx.screen.appendScroll(COLORS.muted('  No ideas yet.\n'));
      ctx.screen.appendScroll(COLORS.muted('  Use /idea <text> to capture one.\n\n'));
      return;
    }

    const openCount = ideas.filter(i => i.status === 'open').length;
    ctx.screen.appendScroll(COLORS.muted(`  ${openCount} open, ${ideas.length - openCount} done\n\n`));

    for (const idea of ideas) {
      const marker = idea.status === 'done' ? '[x]' : '[ ]';
      const date = new Date(idea.createdAt).toLocaleDateString();
      ctx.screen.appendScroll(COLORS.muted(`  ${marker} [${idea.id}] ${idea.text} — ${date}\n`));
    }
    ctx.screen.appendScroll(COLORS.muted('\n  /idea <text>  /idea-done <id>  /idea-delete <id>\n\n'));
    return;
  }

  // /idea-done <id>
  if (subCmd === 'idea-done') {
    const id = parseInt(parts[1], 10);
    if (isNaN(id)) {
      ctx.screen.appendScroll(COLORS.warning('\nUsage: /idea-done <id>\n'));
      return;
    }
    const ok = markDone(workspacePath, id);
    if (ok) {
      ctx.screen.appendScroll(COLORS.success(`\n[OK] Idea #${id} marked done\n`));
    } else {
      ctx.screen.appendScroll(COLORS.warning(`\nIdea #${id} not found\n`));
    }
    // Refresh overlay if in idea workspace
    if (ctx.screen.isInIdeaWorkspace()) {
      const ideas = getAllIdeas(workspacePath);
      ctx.screen.writeOverlay(renderIdeaOverlay(ideas));
    }
    return;
  }

  // /idea-delete <id>
  if (subCmd === 'idea-delete') {
    const id = parseInt(parts[1], 10);
    if (isNaN(id)) {
      ctx.screen.appendScroll(COLORS.warning('\nUsage: /idea-delete <id>\n'));
      return;
    }
    const ok = deleteIdea(workspacePath, id);
    if (ok) {
      ctx.screen.appendScroll(COLORS.success(`\n[OK] Idea #${id} deleted\n`));
    } else {
      ctx.screen.appendScroll(COLORS.warning(`\nIdea #${id} not found\n`));
    }
    if (ctx.screen.isInIdeaWorkspace()) {
      const ideas = getAllIdeas(workspacePath);
      ctx.screen.writeOverlay(renderIdeaOverlay(ideas));
    }
    return;
  }

  // /idea-open <id> — toggle back to open
  if (subCmd === 'idea-open') {
    const id = parseInt(parts[1], 10);
    if (isNaN(id)) {
      ctx.screen.appendScroll(COLORS.warning('\nUsage: /idea-open <id>\n'));
      return;
    }
    const ok = markOpen(workspacePath, id);
    if (ok) {
      ctx.screen.appendScroll(COLORS.success(`\n[OK] Idea #${id} re-opened\n`));
    } else {
      ctx.screen.appendScroll(COLORS.warning(`\nIdea #${id} not found\n`));
    }
    if (ctx.screen.isInIdeaWorkspace()) {
      const ideas = getAllIdeas(workspacePath);
      ctx.screen.writeOverlay(renderIdeaOverlay(ideas));
    }
    return;
  }

  // /idea [text] — enter workspace or quick-add
  if (args.trim()) {
    // /idea <text> — quick add
    const idea = addIdea(workspacePath, args.trim());
    if (idea) {
      ctx.screen.appendScroll(COLORS.success(`\n[IDEA] #${idea.id}: ${idea.text.slice(0, 80)}\n`));
    }
    return;
  }

  // /idea (no args) — enter idea workspace (overlay rendered via callback)
  ctx.screen.enterIdeaWorkspace();
};
