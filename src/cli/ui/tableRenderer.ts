// Markdown table → ANSI-aligned column rendering
// Detects |---| separator pattern and renders tables with aligned columns.
// Uses box-drawing chars (─) for continuous separator line.
// Header in primary color, separator in muted, data rows plain text.
// Column widths computed via getStringWidth (CJK = 2, ASCII = 1).

import { getStringWidth, padRight } from './stringWidth';
import { COLORS } from './colors';
import { ansiStrip } from './ansiFilter';

interface ParsedTable {
  header: string[];
  alignments: ('left' | 'right' | 'center')[];
  rows: string[][];
}

function parseAlignment(cell: string): 'left' | 'right' | 'center' {
  const trimmed = cell.trim();
  const startsWith = trimmed.startsWith(':');
  const endsWith = trimmed.endsWith(':');
  if (startsWith && endsWith) return 'center';
  if (endsWith) return 'right';
  return 'left';
}

function detectAndParseTable(lines: string[], startIdx: number): ParsedTable | null {
  // Need at least 3 lines: header, separator, one data row
  if (startIdx + 2 >= lines.length) return null;

  // Check line 0 (header): must contain at least one |
  const headerLine = lines[startIdx];
  if (!headerLine.includes('|')) return null;

  // Check line 1 (separator): must match |---| pattern
  const sepLine = lines[startIdx + 1];
  if (!/^\|?[\s:]*-{3,}[\s:]*\|/.test(sepLine) && !/\|[\s:]*-{3,}[\s:]*\|/.test(sepLine)) {
    return null;
  }

  // Parse header cells
  const headerCells = headerLine.split('|').map(c => c.trim());
  // Remove leading empty cell (before first |) and trailing empty cell (after last |)
  const cleanHeader = headerCells.filter((_, i, arr) => {
    if (i === 0 && headerLine.trimStart().startsWith('|') && arr[0] === '') return false;
    if (i === arr.length - 1 && headerLine.trimEnd().endsWith('|') && arr[arr.length - 1] === '')
      return false;
    return true;
  });

  // Parse alignment from separator
  const sepCells = sepLine.split('|').filter((c, i, arr) => {
    if (i === 0 && !sepLine.trimStart().startsWith('|')) return false;
    if (i === arr.length - 1 && !sepLine.trimEnd().endsWith('|')) return false;
    if (i === 0 && sepLine.trimStart().startsWith('|') && c.trim() === '') return false;
    if (i === arr.length - 1 && sepLine.trimEnd().endsWith('|') && c.trim() === '') return false;
    return true;
  });

  const alignments = sepCells.map(parseAlignment);

  // Collect data rows until a non-table line
  const rows: string[][] = [];
  let idx = startIdx + 2;
  while (idx < lines.length) {
    const rowLine = lines[idx];
    if (!rowLine.includes('|') || rowLine.trim() === '') {
      break;
    }
    const rowCells = rowLine.split('|').map(c => c.trim());
    // Trim leading/trailing empty cells like header
    const cleanRow = rowCells.filter((_, i, arr) => {
      if (i === 0 && rowLine.trimStart().startsWith('|') && arr[0] === '') return false;
      if (i === arr.length - 1 && rowLine.trimEnd().endsWith('|') && arr[arr.length - 1] === '')
        return false;
      return true;
    });
    rows.push(cleanRow);
    idx++;
  }

  if (rows.length === 0) return null;

  // Normalize column count: pad short rows, truncate long rows
  const colCount = cleanHeader.length;
  const normalizedRows = rows.map(row => {
    const padded = [...row];
    while (padded.length < colCount) padded.push('');
    return padded.slice(0, colCount);
  });

  return {
    header: cleanHeader,
    alignments: alignments.slice(0, colCount),
    rows: normalizedRows,
  };
}

function padCell(content: string, width: number, alignment: 'left' | 'right' | 'center'): string {
  const contentWidth = getStringWidth(content);
  if (contentWidth >= width) return content;

  switch (alignment) {
    case 'right':
      return ' '.repeat(width - contentWidth) + content;
    case 'center': {
      const left = Math.floor((width - contentWidth) / 2);
      const right = width - contentWidth - left;
      return ' '.repeat(left) + content + ' '.repeat(right);
    }
    case 'left':
    default:
      return padRight(content, width);
  }
}

function renderTable(table: ParsedTable): string {
  const MIN_COL_WIDTH = 3;
  const COL_GAP = 2; // spaces between columns
  const SEP = ' '.repeat(COL_GAP);
  // Box-drawing horizontal line: continuous visual appearance
  // unlike '-' which looks choppy/dotted in many terminal fonts.
  const H = '─'; // U+2500 BOX DRAWINGS LIGHT HORIZONTAL

  // Calculate column widths
  const colCount = table.header.length;
  const colWidths: number[] = new Array(colCount).fill(MIN_COL_WIDTH);

  for (let i = 0; i < colCount; i++) {
    colWidths[i] = Math.max(colWidths[i], getStringWidth(table.header[i]));
    for (const row of table.rows) {
      const cell = row[i] || '';
      colWidths[i] = Math.max(colWidths[i], getStringWidth(cell));
    }
  }

  // Render
  const lines: string[] = [];

  // Header row — primary color, left-aligned
  const headerCells = table.header.map((cell, i) =>
    COLORS.primary(padCell(cell, colWidths[i], table.alignments[i] || 'left'))
  );
  lines.push(headerCells.join(COLORS.muted(SEP)));

  // Separator — single continuous muted line using box-drawing chars
  // Each column: H repeated to width, gaps filled with spaces (also muted).
  const sepLine = COLORS.muted(
    colWidths.map(w => H.repeat(w)).join(SEP)
  );
  lines.push(sepLine);

  // Data rows — all plain text, no zebra striping
  for (let i = 0; i < table.rows.length; i++) {
    const row = table.rows[i];
    const cells = row.map((cell, j) => padCell(cell, colWidths[j], table.alignments[j] || 'left'));
    lines.push(cells.join(COLORS.muted(SEP)));
  }

  return lines.join('\n');
}

/**
 * Process text and render any markdown tables found.
 * Returns the text with tables rendered as ANSI-aligned columns.
 * Non-table lines pass through unchanged.
 */
export function renderMarkdownTables(text: string): string {
  const lines = text.split('\n');
  // Strip ANSI for table detection — ANSI color codes (e.g. COLORS.primary)
  // prefix lines with ESC sequences which break | detection regexes.
  const strippedLines = lines.map(l => ansiStrip(l));
  const result: string[] = [];
  let i = 0;
  let tableCount = 0;

  while (i < lines.length) {
    const table = detectAndParseTable(strippedLines, i);
    if (table) {
      result.push(renderTable(table));
      i += 2 + table.rows.length; // header + separator + data rows
      tableCount++;
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  // Only return modified text if tables were found
  if (tableCount === 0) return text;
  return result.join('\n');
}
