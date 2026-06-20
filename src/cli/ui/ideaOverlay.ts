// Render the idea overlay panel — follows the same pattern as subagentPanel.ts
// renderOverlay(). Fixed 7-row overlay displayed between scrollback and status bar.

import { COLORS } from './colors';
import { getTerminalWidth, getStringDisplayWidth } from '../formatting';
import type { Idea } from '../../storage/ideaStore';

const MAX_VISIBLE = 4;
export const IDEA_OVERLAY_ROWS = 7;

/** Render the fixed idea overlay. Always returns exactly IDEA_OVERLAY_ROWS lines. */
export function renderIdeaOverlay(ideas: Idea[]): string[] {
  const termWidth = getTerminalWidth();
  const lines: string[] = [];

  if (ideas.length === 0) {
    const boxWidth = Math.min(termWidth - 4, 50);
    const title = 'Ideas';

    const topBorder = `┌${'─'.repeat(boxWidth - 2)}┐`;
    lines.push(COLORS.secondary.bold(topBorder));

    const titlePad = boxWidth - 3 - getStringDisplayWidth(title);
    const paddedTitle = `│ ${COLORS.primary.bold(title)}${' '.repeat(Math.max(0, titlePad))}│`;
    lines.push(COLORS.secondary.bold(paddedTitle));

    const msg = '  No ideas yet. Type to create one.';
    const msgPad = boxWidth - 3 - getStringDisplayWidth(msg);
    const paddedMsg = `│ ${msg}${' '.repeat(Math.max(0, msgPad))}│`;
    lines.push(COLORS.secondary(paddedMsg));

    // Pad to IDEA_OVERLAY_ROWS
    while (lines.length < IDEA_OVERLAY_ROWS) {
      lines.push(COLORS.secondary(`│${' '.repeat(boxWidth - 2)}│`));
    }

    return lines;
  }

  const openCount = ideas.filter(i => i.status === 'open').length;
  const title = `Ideas [${openCount} open]`;
  const boxWidth = Math.min(termWidth - 4, Math.max(getStringDisplayWidth(title) + 12, 50));

  // Row 0: top border
  const topBorder = `┌${'─'.repeat(boxWidth - 2)}┐`;
  lines.push(COLORS.secondary.bold(topBorder));

  // Row 1: title
  const titlePad = boxWidth - 3 - getStringDisplayWidth(title);
  const paddedTitle = `│ ${title}${' '.repeat(Math.max(0, titlePad))}│`;
  lines.push(COLORS.secondary.bold(paddedTitle));

  // Rows 2-5: ideas (max 4 visible, newest last)
  const visible = ideas.slice(-MAX_VISIBLE);
  for (const idea of visible) {
    const marker = idea.status === 'done' ? '[x]' : '[ ]';
    const idLabel = `[${idea.id}]`;
    // Grapheme-safe truncation — slice may cut surrogate pairs
    const maxText = boxWidth - 3 - 10;
    const graphemes = idea.text.match(/\P{M}\p{M}*/gu) || [idea.text];
    let displayLen = 0;
    let cutoff = graphemes.length;
    for (let g = 0; g < graphemes.length; g++) {
      const w = getStringDisplayWidth(graphemes[g]);
      if (displayLen + w > maxText) { cutoff = g; break; }
      displayLen += w;
    }
    const text = cutoff < graphemes.length
      ? graphemes.slice(0, cutoff).join('') + '…'
      : idea.text;
    const line = `${marker} ${idLabel} ${text}`;
    const pad = boxWidth - 3 - getStringDisplayWidth(line);
    const padded = `│ ${line}${' '.repeat(Math.max(0, pad))}│`;
    lines.push(idea.status === 'done' ? COLORS.muted.dim(padded) : COLORS.secondary(padded));
  }

  // Row N+2: help line
  const help = 'n=new  [1-9]=fill  bN=brainstorm  dN=done  xN=delete';
  const helpPad = boxWidth - 3 - getStringDisplayWidth(help);
  const paddedHelp = `│ ${help}${' '.repeat(Math.max(0, helpPad))}│`;
  lines.push(COLORS.secondary(paddedHelp));

  // Pad to IDEA_OVERLAY_ROWS
  while (lines.length < IDEA_OVERLAY_ROWS) {
    lines.push(COLORS.secondary(`│${' '.repeat(boxWidth - 2)}│`));
  }

  return lines;
}
