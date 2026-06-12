import type { SlashContext, SlashHandler } from './types';
import { queueHandler } from './queue';
import { sessionHandler } from './session';
import { checkpointHandler } from './checkpoint';
import { skillManageHandler, skillInvokeHandler } from './skill';
import { mcpHandler } from './mcp';
import { compactHandler, summaryHandler } from './compact';
import { statusHandler } from './status';
import { helpHandler, initHandler, historyMsgHandler } from './help';

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

  // /history /sessions /h (archive list)
  if (cmd === 'history' || cmd === 'sessions' || cmd === 'h') {
    await sessionHandler('', ctx);
    return true;
  }

  // /view <id>
  if (cmd === 'view') {
    await sessionHandler(parts.slice(1).join(' '), ctx);
    return true;
  }

  // /rename <id> <name>
  if (cmd === 'rename') {
    await sessionHandler(parts.slice(1).join(' '), ctx);
    return true;
  }

  // /delete <id>
  if (cmd === 'delete') {
    await sessionHandler(parts.slice(1).join(' '), ctx);
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

  // /checkpoint
  if (cmd === 'checkpoint') {
    await checkpointHandler(parts.slice(1).join(' '), ctx);
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

  // /summary
  if (cmd === 'summary') {
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
  if (cmd === 'help') {
    await helpHandler('', ctx);
    return true;
  }

  // /skill_name invocation
  if (parts[0].startsWith('/')) {
    const skillName = parts[0].replace(/^\//, '');
    await skillInvokeHandler(skillName + (parts.length > 1 ? ' ' + parts.slice(1).join(' ') : ''), ctx);
    return true;
  }

  return false;
}
