import { COLORS } from '../../cli/ui/colors';
import { rebuildSystemPrompt } from '../../core/init';
import {
  parseSkillInput,
  getSkill,
  buildSkillPrompt,
  listSkills,
  installSkill,
  uninstallSkill,
  saveSkill,
  deleteSkill,
} from '../../skills';
import { playBell } from '../../utils/bell';
import { saveSession } from '../../utils/session';
import { getInputQueue } from '../../cli/ui/queue';
import { autoDrainQueue } from '../../cli/queueDrain';
import type { SlashHandler } from './types';

export const skillManageHandler: SlashHandler = async (args, ctx) => {
  const parts = args.trim().split(/\s+/);
  const action = parts[0];

  if (!action || action === 'list') {
    const skills = listSkills(ctx.agent.getWorkspacePath());
    ctx.screen.appendScroll(COLORS.primary.bold('\nSkills\n'));
    ctx.screen.appendScroll(COLORS.muted('─'.repeat(60) + '\n'));
    if (skills.length === 0) {
      ctx.screen.appendScroll(COLORS.muted('  No skills installed.\n'));
    } else {
      skills.forEach(s => {
        ctx.screen.appendScroll(
          `${COLORS.primary(`  /${s.name}`)} — ${COLORS.muted(s.description || '')}\n`,
        );
      });
    }
    ctx.screen.appendScroll('\n');
  } else if (action === 'install') {
    const url = parts[1];
    if (!url) {
      ctx.screen.appendScroll(COLORS.warning('\nUsage: /skill install <github-url>\n'));
    } else {
      try {
        await installSkill(url);
        rebuildSystemPrompt(ctx.agent);
        ctx.screen.appendScroll(COLORS.success(`\n[OK] Skill installed from: ${url}\n`));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.screen.appendScroll(COLORS.error(`\n[ERR] ${msg}\n`));
      }
    }
  } else if (action === 'uninstall') {
    const name = parts[1];
    if (!name) {
      ctx.screen.appendScroll(COLORS.warning('\nUsage: /skill uninstall <name>\n'));
    } else {
      await uninstallSkill(name);
      rebuildSystemPrompt(ctx.agent);
      ctx.screen.appendScroll(COLORS.success(`\n[OK] Skill uninstalled: ${name}\n`));
    }
  } else if (action === 'add') {
    const skillName = parts[1];
    const promptTemplate = parts.slice(2).join(' ');
    if (!skillName || !promptTemplate) {
      ctx.screen.appendScroll(COLORS.warning('\nUsage: /skill add <name> <promptTemplate>\n'));
    } else {
      await saveSkill(skillName, { name: skillName, description: '', promptTemplate });
      rebuildSystemPrompt(ctx.agent);
      ctx.screen.appendScroll(COLORS.success(`\n[OK] Skill added: ${skillName}\n`));
    }
  } else if (action === 'remove') {
    const skillName = parts[1];
    if (!skillName) {
      ctx.screen.appendScroll(COLORS.warning('\nUsage: /skill remove <name>\n'));
    } else {
      const result = await deleteSkill(skillName);
      if (result) {
        rebuildSystemPrompt(ctx.agent);
        ctx.screen.appendScroll(COLORS.success(`\n[OK] Skill removed: ${skillName}\n`));
      } else {
        ctx.screen.appendScroll(COLORS.warning(`\n[WARN] Skill not found: ${skillName}\n`));
      }
    }
  } else if (action === 'edit') {
    const skillName = parts[1];
    const promptTemplate = parts.slice(2).join(' ');
    if (!skillName || !promptTemplate) {
      ctx.screen.appendScroll(COLORS.warning('\nUsage: /skill edit <name> <promptTemplate>\n'));
    } else {
      const existing = getSkill(skillName, ctx.agent.getWorkspacePath());
      if (!existing) {
        ctx.screen.appendScroll(COLORS.warning(`\n[WARN] Skill not found: ${skillName}\n`));
      } else {
        await saveSkill(skillName, { ...existing, promptTemplate });
        rebuildSystemPrompt(ctx.agent);
        ctx.screen.appendScroll(COLORS.success(`\n[OK] Skill updated: ${skillName}\n`));
      }
    }
  } else {
    ctx.screen.appendScroll(COLORS.warning('\nUsage: /skill [list|install|uninstall|add|remove|edit]\n'));
  }
  ctx.screen.restoreCursor();
};

export const skillInvokeHandler: SlashHandler = async (args, ctx) => {
  const skillInput = parseSkillInput('/' + args, ctx.agent.getWorkspacePath());
  if (!skillInput) return;

  const skill = getSkill(skillInput.skillName, ctx.agent.getWorkspacePath());
  if (!skill) return;

  const prompt = buildSkillPrompt(skill, skillInput.args);

  ctx.screen.appendScroll(
    COLORS.muted(`\n[${skill.name}] ${skill.description}\n`),
  );
  ctx.setProcessing(true);
  ctx.state.setProcessing(true);
  ctx.updateStatusBar();
  try {
    await ctx.agent.runLoop(prompt);
    ctx.screen.clearThinkingAnimation();
    ctx.screen.setStreaming(false);
    ctx.screen.appendScroll(COLORS.success('\n[OK] Done\n'));
    playBell('done');
  } catch (error: unknown) {
    ctx.screen.clearThinkingAnimation();
    ctx.screen.setStreaming(false);
    const errorMsg = error instanceof Error ? error.message : String(error);
    ctx.screen.appendScroll(COLORS.error(`\n[ERR] ${errorMsg}\n`));
    playBell('error');
  }
  ctx.screen.restoreCursor();
  ctx.screen.refreshInput();
  ctx.setProcessing(false);
  ctx.state.setProcessing(false);
  ctx.updateStatusBar();
  saveSession(ctx.agent.getWorkspacePath(), ctx.agent.getSessionState(), undefined, ctx.agent.getProgressSnapshot());

  await autoDrainQueue(getInputQueue(), async merged => {
    await ctx.handleInput(merged);
  });
};
