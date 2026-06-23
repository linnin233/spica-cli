import fs from 'fs-extra';
import { resolvePath } from '../helpers';
import type { ToolResult } from '../helpers';

export async function executeFileRead(args: Record<string, unknown>): Promise<ToolResult> {
  const readPath = resolvePath(args.path as string);
  const content = await fs.readFile(readPath, 'utf-8');
  const lines = content.split('\n');
  const lineCount = lines.length;

  if (args.offset) {
    const start = (args.offset as number) - 1;
    const selectedLines = lines.slice(start);
    return {
      success: true,
      output: `[${readPath}:${start + 1}-${lines.length}] (${selectedLines.length} lines)`,
      content: selectedLines.join('\n'),
    };
  }

  return {
    success: true,
    output: `[${readPath}] (${lineCount} lines)`,
    content,
  };
}
