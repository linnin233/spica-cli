import type { ToolResult } from '../helpers';

export async function executeQuestion(args: Record<string, unknown>): Promise<ToolResult> {
  return {
    success: true,
    output: `QUESTION: ${args.text}\nWaiting for user response...`,
  };
}
