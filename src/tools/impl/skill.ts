import { WORKSPACE } from '../helpers';
import type { ToolResult } from '../helpers';

export async function executeSkill(args: Record<string, unknown>): Promise<ToolResult> {
  const { loadSkills } = await import('../../skills/index');
  const skills = loadSkills(WORKSPACE);
  const skillName = String(args.name || '');

  if (!skillName) {
    return {
      success: false,
      error: `Skill name required. Available skills: ${Array.from(skills.keys()).join(', ')}`,
    };
  }

  const skill = skills.get(skillName);
  if (!skill) {
    return {
      success: false,
      error: `Skill "${skillName}" not found. Available skills: ${Array.from(skills.keys()).join(', ')}`,
    };
  }

  const skillContent = skill.promptTemplate || '';

  // Find skill references in loaded skill content
  const allSkillNames = Array.from(skills.keys());
  const referencedSkills: string[] = [];
  const lowerContent = skillContent.toLowerCase();

  for (const name of allSkillNames) {
    if (name === skillName) continue;
    if (
      lowerContent.includes(`superpowers:${name}`) ||
      lowerContent.includes(`skill(name="${name}")`) ||
      lowerContent.includes(`skill(name='${name}')`) ||
      lowerContent.includes(`use the \`${name}\` skill`) ||
      lowerContent.includes(`use ${name}`) ||
      lowerContent.includes(`invoke ${name}`)
    ) {
      referencedSkills.push(name);
    }
  }

  return {
    success: true,
    output: `Skill: ${skill.name}\nDescription: ${skill.description}\n\n${skillContent}`,
    referencedSkills: [...new Set(referencedSkills)],
  };
}
