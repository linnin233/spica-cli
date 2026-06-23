import fs from 'fs-extra';
import { resolve as pathResolve } from 'path';
import { setWorkspace, getWorkspace } from '../helpers';
import type { ToolResult } from '../helpers';

export async function executeWorkspace(args: Record<string, unknown>): Promise<ToolResult> {
  if (args.path) {
    const newPath = pathResolve(args.path as string);
    if (!(await fs.pathExists(newPath))) {
      return { success: false, error: `Path does not exist: ${newPath}` };
    }
    setWorkspace(newPath);
    return { success: true, output: `Workspace: ${getWorkspace()}` };
  }
  return { success: true, output: `Workspace: ${getWorkspace()}` };
}
