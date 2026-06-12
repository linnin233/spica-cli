import fastGlob from 'fast-glob';
import { WORKSPACE } from '../helpers';
import type { ToolResult } from '../helpers';

export async function executeGlob(args: Record<string, unknown>): Promise<ToolResult> {
  const ignorePatterns = (args.ignore as string[]) || [
    'node_modules',
    '.git',
    'dist',
    'build',
    '*.lock',
  ];
  const maxFiles = (args.maxFiles as number) || 100;

  const files = await fastGlob(args.pattern as string, {
    cwd: WORKSPACE,
    absolute: true,
    ignore: ignorePatterns,
  });

  const truncated = files.slice(0, maxFiles);
  return {
    success: true,
    output:
      files.length > 0
        ? `Found ${files.length} files (showing ${truncated.length}):\n${truncated.join('\n')}`
        : 'No files found',
    content: truncated.join('\n'),
  };
}
