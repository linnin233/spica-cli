import type { SlashContext, SlashHandler } from './types';
import { queueHandler } from './queue';
import { sessionHandler } from './session';
import { skillManageHandler, skillInvokeHandler } from './skill';
import { mcpHandler } from './mcp';
import { compactHandler, summaryHandler } from './compact';
import { statusHandler } from './status';
import { helpHandler, initHandler, historyMsgHandler } from './help';
import { subagentsHandler } from './subagents';
import { ideaHandler } from './idea';
import { getSkill } from '../../skills';

/**
 * Dispatch slash commands to their handlers.
 * Returns true if a handler was found and executed.
 */
export async function dispatchSlash(trimmed: string, ctx: SlashContext): Promise<boolean> {
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].replace(/^\//, '');

  // quit/exit handled by caller

  // /queue /q
  if (cmd === 'queue' || cmd === 'q') {
    await queueHandler(parts.slice(1).join(' '), ctx);
    return true;
  }

  // /undo
  if (cmd === 'undo') {
    await queueHandler('undo', ctx);
    return true;
  }

  // /history /sessions (archive list)
  if (cmd === 'history' || cmd === 'sessions') {
    await sessionHandler('', ctx);
    return true;
  }

  // /view <id>
  if (cmd === 'view') {
    await sessionHandler('view ' + parts.slice(1).join(' '), ctx);
    return true;
  }

  // /rename <id> <name>
  if (cmd === 'rename') {
    await sessionHandler('rename ' + parts.slice(1).join(' '), ctx);
    return true;
  }

  // /delete <id>
  if (cmd === 'delete') {
    await sessionHandler('delete ' + parts.slice(1).join(' '), ctx);
    return true;
  }

  // /archive /clear /reset /new
  if (cmd === 'archive' || cmd === 'clear' || cmd === 'reset' || cmd === 'new') {
    await sessionHandler(cmd, ctx);
    return true;
  }

  // /status
  if (cmd === 'status') {
    await statusHandler('', ctx);
    return true;
  }

  // /skill
  if (cmd === 'skill') {
    await skillManageHandler(parts.slice(1).join(' '), ctx);
    return true;
  }

  // /mcp
  if (cmd === 'mcp') {
    await mcpHandler(parts.slice(1).join(' '), ctx);
    return true;
  }

  // /summary /sum
  if (cmd === 'summary' || cmd === 'sum') {
    await summaryHandler('', ctx);
    return true;
  }

  // /compact
  if (cmd === 'compact') {
    await compactHandler('', ctx);
    return true;
  }

  // /init
  if (cmd === 'init') {
    await initHandler(parts.slice(1).join(' '), ctx);
    return true;
  }

  // /h /help
  if (cmd === 'help' || cmd === 'h') {
    await helpHandler('', ctx);
    return true;
  }

  // /subagents
  if (cmd === 'subagents') {
    await subagentsHandler('', ctx);
    return true;
  }

  // /idea, /ideas, /idea-done, /idea-delete, /idea-open
  if (cmd === 'idea' || cmd === 'ideas' || cmd === 'idea-done' || cmd === 'idea-delete' || cmd === 'idea-open') {
    await ideaHandler(parts.slice(1).join(' '), ctx);
    return true;
  }

  // /skill_name invocation — only if skill exists
  if (parts[0].startsWith('/')) {
    const skillName = parts[0].replace(/^\//, '');
    // Check skill exists before invoking (prevents silent failure for unknown commands)
    const skill = getSkill(skillName, ctx.agent.getWorkspacePath());
    if (!skill) return false;
    await skillInvokeHandler(skillName + (parts.length > 1 ? ' ' + parts.slice(1).join(' ') : ''), ctx);
    return true;
  }

  return false;
}
