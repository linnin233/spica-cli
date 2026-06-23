import fs from 'fs-extra';
import { resolvePath } from '../helpers';
import type { ToolResult } from '../helpers';

export async function executeFileExists(args: Record<string, unknown>): Promise<ToolResult> {
  const existsPath = resolvePath(args.path as string);
  const exists = await fs.pathExists(existsPath);
  return { success: true, output: exists ? 'exists' : 'not found' };
}

export async function executeFileDelete(args: Record<string, unknown>): Promise<ToolResult> {
  const deletePath = resolvePath(args.path as string);
  await fs.remove(deletePath);
  return { success: true, output: `Deleted ${deletePath}` };
}

export async function executeFileCopy(args: Record<string, unknown>): Promise<ToolResult> {
  const srcPath = resolvePath(args.source as string);
  const dstPath = resolvePath(args.destination as string);
  await fs.copy(srcPath, dstPath);
  return { success: true, output: `Copied ${srcPath} → ${dstPath}` };
}

export async function executeFileMove(args: Record<string, unknown>): Promise<ToolResult> {
  const moveSrc = resolvePath(args.source as string);
  const moveDst = resolvePath(args.destination as string);
  await fs.move(moveSrc, moveDst);
  return { success: true, output: `Moved ${moveSrc} → ${moveDst}` };
}
