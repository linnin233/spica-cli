import fs from 'fs-extra';
import fastGlob from 'fast-glob';
import { WORKSPACE, resolvePath } from '../helpers';
import type { ToolResult } from '../helpers';

export async function executeGrep(args: Record<string, unknown>): Promise<ToolResult> {
  const grepPath = args.path ? resolvePath(args.path as string) : WORKSPACE;
  const includePattern = (args.include as string) || '*';
  const maxLines = (args.maxLines as number) || 100;

  try {
    const files = await fastGlob(includePattern as string, {
      cwd: grepPath,
      absolute: true,
      ignore: ['node_modules', '.git', 'dist', 'build', '*.lock'],
    });

    const regex = new RegExp(args.pattern as string, 'g');
    const matches: string[] = [];

    for (const file of files) {
      if (matches.length >= maxLines) break;

      try {
        const content = await fs.readFile(file, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= maxLines) break;

          if (regex.test(lines[i])) {
            const relativePath = file.replace(WORKSPACE, '').replace(/^\//, '');
            matches.push(`${relativePath}:${i + 1}: ${lines[i].trim()}`);
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    return {
      success: true,
      output:
        matches.length > 0
          ? `Found ${matches.length} matches:\n${matches.join('\n')}`
          : 'No matches found',
      content: matches.join('\n'),
    };
  } catch (error: any) {
    return {
      success: false,
      error: `Grep failed: ${error.message || error}`,
    };
  }
}
