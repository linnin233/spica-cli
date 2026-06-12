/**
 * ANSI escape sequence filter — single entry point for all ANSI/control character stripping.
 *
 * Previously scattered across events.ts (paste), screenManager.ts (render output),
 * and scrollbackBuffer.ts (resize replay). Each new ANSI variant required changes
 * in multiple places. This module prevents that.
 */

function buildAnsiRegexes() {
  // eslint-disable-next-line no-control-regex
  const esc = String.fromCharCode(0x1b);
  return {
    csi: new RegExp(esc + '\\[[0-9;?]*[A-Za-z]', 'g'),
    oscBel: new RegExp(esc + '\\][^' + esc.slice(0, 1) + '\x07]*\x07', 'g'),
    oscSt: new RegExp(esc + '\\][^' + esc + ']*' + esc + '\\\\', 'g'),
    pasteStart: new RegExp(esc + '\\[200~', 'g'),
    pasteEnd: new RegExp(esc + '\\[201~', 'g'),
    c1: new RegExp(esc + '[PX^_][^' + esc + ']*' + esc + '\\\\', 'g'),
    c0: /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,
  };
}

const _RE = buildAnsiRegexes();

/**
 * Strip ALL ANSI escape sequences from text.
 * Used for paste input — must produce clean text for the input buffer.
 */
export function ansiStrip(text: string): string {
  return text
    .replace(_RE.csi, '')
    .replace(_RE.oscBel, '')
    .replace(_RE.oscSt, '')
    .replace(_RE.pasteStart, '')
    .replace(_RE.pasteEnd, '')
    .replace(_RE.c1, '')
    .replace(_RE.c0, '');
}

/**
 * Strip ANSI and normalize whitespace for display output.
 * - Strips all ANSI escape sequences
 * - Collapses multiple consecutive newlines (default max 2)
 *
 * Used for tool/AI output rendering and scrollback buffer.
 */
export function ansiClean(
  text: string,
  options?: { maxConsecutiveNewlines?: number }
): string {
  const maxNL = options?.maxConsecutiveNewlines ?? 2;

  let result = ansiStrip(text);

  const newlineChain = '\n'.repeat(maxNL + 1);
  const replacement = '\n'.repeat(maxNL);
  while (result.includes(newlineChain)) {
    result = result.replace(newlineChain, replacement);
  }

  return result;
}
