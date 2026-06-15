import { WORKSPACE } from '../helpers';
import type { ToolResult } from '../helpers';

/**
 * Parse comma-separated or single skill name into an array.
 * Handles: "tdd", "tdd, frontend-design", "tdd,frontend-design"
 */
function parseSkillNames(raw: string): string[] {
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/**
 * Detect skill references in skill content.
 * Based on ACTUAL patterns found in existing superpowers skills:
 *   - superpowers:skill-name (primary cross-reference format)
 *   - use superpowers:skill-name
 *   - use the `skill-name` skill
 *   - invoke skill-name
 *   - /skill-name reference
 */
function detectReferences(content: string, allSkillNames: string[]): string[] {
  const refs = new Set<string>();
  const lowerContent = content.toLowerCase();

  for (const name of allSkillNames) {
    if (
      lowerContent.includes(`superpowers:${name}`) ||
      lowerContent.includes(`use superpowers:${name}`) ||
      lowerContent.includes(`use the \`${name}\` skill`) ||
      lowerContent.includes(`invoke ${name} skill`) ||
      lowerContent.includes(`invoke ${name}`) ||
      lowerContent.includes(`/${name}`)
    ) {
      refs.add(name);
    }
  }

  return [...refs];
}

export async function executeSkill(args: Record<string, unknown>): Promise<ToolResult> {
  const { loadSkills } = await import('../../skills/index');
  const skills = loadSkills(WORKSPACE);
  const allSkillNames = Array.from(skills.keys());

  const rawName = String(args.name || '');
  if (!rawName) {
    return {
      success: false,
      error: `Skill name required. Available: ${allSkillNames.join(', ')}`,
    };
  }

  // Parse multiple names (comma-separated)
  const requestedNames = parseSkillNames(rawName);
  const notFound = requestedNames.filter(n => !skills.has(n));
  if (notFound.length > 0) {
    return {
      success: false,
      error: `Skill(s) not found: ${notFound.join(', ')}. Available: ${allSkillNames.join(', ')}`,
    };
  }

  // Load all requested skills
  const loaded: Array<{ name: string; description: string; content: string }> = [];
  for (const skillName of requestedNames) {
    const skill = skills.get(skillName)!;
    const rawContent = skill.promptTemplate || '';

    // Strip YAML frontmatter
    let body = rawContent;
    if (rawContent.startsWith('---')) {
      const endIdx = rawContent.indexOf('---', 3);
      if (endIdx !== -1) {
        body = rawContent.slice(endIdx + 3).trim();
      }
    }

    loaded.push({
      name: skill.name || skillName,
      description: skill.description || '',
      content: body,
    });
  }

  // Build combined output
  const sections: string[] = [];

  if (loaded.length === 1) {
    // Single skill — simple output
    const s = loaded[0];
    sections.push(`## ${s.name}\n> ${s.description}\n\n${s.content}`);
  } else {
    // Multiple skills — combined with section headers
    sections.push(`## Loaded Skills (${loaded.length})\n`);
    for (const s of loaded) {
      sections.push(`### ${s.name}\n> ${s.description}\n\n${s.content}`);
    }
  }

  // Cross-reference detection across all loaded content
  const allContent = loaded.map(s => s.content).join('\n');
  const loadedNames = new Set(loaded.map(s => s.name));
  const crossRefs = detectReferences(allContent, allSkillNames).filter(
    ref => !loadedNames.has(ref) && !requestedNames.includes(ref)
  );

  if (crossRefs.length > 0) {
    sections.push(
      `\n---\n💡 **Related skills mentioned in content:** ${crossRefs.map(r => `\`${r}\``).join(', ')}`
    );
  }

  return {
    success: true,
    output: sections.join('\n\n'),
    referencedSkills: [...new Set(crossRefs)],
  };
}
