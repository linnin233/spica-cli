import fs from 'fs-extra';
import { WORKSPACE, resolvePath } from '../helpers';
import type { ToolResult } from '../helpers';

export async function executeDirectoryCreate(args: Record<string, unknown>): Promise<ToolResult> {
  const dirPath = resolvePath(args.path as string);
  await fs.ensureDir(dirPath);
  return { success: true, output: `Created directory ${dirPath}` };
}

export async function executeDirectoryList(args: Record<string, unknown>): Promise<ToolResult> {
  const listPath = args.path ? resolvePath(args.path as string) : WORKSPACE;
  const items = await fs.readdir(listPath);
  return { success: true, output: items.join('\n') };
}
