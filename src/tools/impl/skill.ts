import { WORKSPACE } from '../helpers';
import type { ToolResult } from '../helpers';

interface LoadedSkill {
  name: string;
  description: string;
  content: string;
  packageName?: string;
  requires: string[];
  suggests: string[];
}

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
 * Parse YAML frontmatter dependencies from skill content.
 * Looks for `requires:` and `suggests:` lists.
 */
function parseFrontmatterDeps(content: string): { requires: string[]; suggests: string[] } {
  const requires: string[] = [];
  const suggests: string[] = [];

  if (!content.startsWith('---')) return { requires, suggests };

  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) return { requires, suggests };

  const frontmatter = content.slice(3, endIdx).trim();

  // Parse requires: list
  const reqMatch = frontmatter.match(/requires:\s*\n((?:\s+-\s+.+\n?)*)/);
  if (reqMatch) {
    const items = reqMatch[1].match(/-\s*(\S+)/g);
    if (items) {
      requires.push(...items.map(i => i.replace(/^-\s*/, '').trim()));
    }
  }

  // Parse suggests: list
  const sugMatch = frontmatter.match(/suggests:\s*\n((?:\s+-\s+.+\n?)*)/);
  if (sugMatch) {
    const items = sugMatch[1].match(/-\s*(\S+)/g);
    if (items) {
      suggests.push(...items.map(i => i.replace(/^-\s*/, '').trim()));
    }
  }

  return { requires, suggests };
}

/**
 * Resolve a single skill by name. Returns null if not found.
 * Strips YAML frontmatter from the returned content.
 */
async function loadOneSkill(
  skillName: string,
  skillMap: Map<string, any>,
  visited: Set<string>
): Promise<LoadedSkill | null> {
  if (visited.has(skillName)) return null; // cycle detection
  visited.add(skillName);

  const skill = skillMap.get(skillName);
  if (!skill) return null;

  const rawContent = skill.promptTemplate || '';
  const { requires, suggests } = parseFrontmatterDeps(rawContent);

  // Strip YAML frontmatter to get body
  let body = rawContent;
  if (rawContent.startsWith('---')) {
    const endIdx = rawContent.indexOf('---', 3);
    if (endIdx !== -1) {
      body = rawContent.slice(endIdx + 3).trim();
    }
  }

  return {
    name: skill.name || skillName,
    description: skill.description || '',
    content: body,
    requires,
    suggests,
  };
}

/**
 * Recursively resolve a skill and all its dependencies.
 * Returns the list in dependency order (deps first, then the requested skill).
 */
async function resolveWithDeps(
  skillNames: string[],
  skillMap: Map<string, any>,
  visited: Set<string>
): Promise<LoadedSkill[]> {
  const resolved: LoadedSkill[] = [];
  const seen = new Set<string>();

  async function resolve(name: string): Promise<void> {
    if (seen.has(name)) return;
    seen.add(name);

    const skill = await loadOneSkill(name, skillMap, visited);
    if (!skill) return;

    // Resolve requires first (they come before the dependent)
    for (const dep of skill.requires) {
      await resolve(dep);
    }

    resolved.push(skill);

    // Resolve suggests (they come after)
    for (const sug of skill.suggests) {
      await resolve(sug);
    }
  }

  for (const name of skillNames) {
    await resolve(name);
  }

  return resolved;
}

/**
 * Detect skill references in loaded skill content.
 * Finds patterns like: use the `skill-name` skill, invoke skill-name, superpowers:name
 */
function detectReferences(content: string, allSkillNames: string[]): string[] {
  const refs = new Set<string>();
  const lowerContent = content.toLowerCase();

  for (const name of allSkillNames) {
    if (
      lowerContent.includes(`superpowers:${name}`) ||
      lowerContent.includes(`skill(name="${name}")`) ||
      lowerContent.includes(`skill(name='${name}')`) ||
      lowerContent.includes(`use the \`${name}\` skill`) ||
      lowerContent.includes(`use ${name}`) ||
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

  // Parse multiple names
  const requestedNames = parseSkillNames(rawName);
  const notFound = requestedNames.filter(n => !skills.has(n));
  if (notFound.length > 0) {
    return {
      success: false,
      error: `Skill(s) not found: ${notFound.join(', ')}. Available: ${allSkillNames.join(', ')}`,
    };
  }

  // Resolve all skills with dependencies
  const visited = new Set<string>();
  const loaded = await resolveWithDeps(requestedNames, skills, visited);

  if (loaded.length === 0) {
    return {
      success: false,
      error: `No skills loaded. Available: ${allSkillNames.join(', ')}`,
    };
  }

  // Build combined output
  const sections: string[] = [];
  const allLoadedNames = new Set(loaded.map(s => s.name));
  const autoLoaded = loaded.filter(s => !requestedNames.includes(s.name));

  // Header
  const requestedList = loaded.filter(s => requestedNames.includes(s.name));
  sections.push(`## Loaded Skills (${loaded.length} total)`);

  if (autoLoaded.length > 0) {
    sections.push(
      `_Auto-loaded dependencies/suggestions: ${autoLoaded.map(s => s.name).join(', ')}_\n`
    );
  }

  // Each skill's content
  for (const skill of loaded) {
    const tag = requestedNames.includes(skill.name) ? '' : ' [auto-loaded]';
    sections.push(
      `### ${skill.name}${tag}\n> ${skill.description}\n\n${skill.content}`
    );
  }

  // Cross-reference detection across all loaded content
  const allContent = loaded.map(s => s.content).join('\n');
  const crossRefs = detectReferences(allContent, allSkillNames).filter(
    ref => !allLoadedNames.has(ref) && !requestedNames.includes(ref)
  );

  if (crossRefs.length > 0) {
    sections.push(
      `\n---\n💡 **Related skills not yet loaded:** ${crossRefs.map(r => `\`${r}\``).join(', ')}`
    );
  }

  // Dependency summary
  if (autoLoaded.length > 0) {
    const deps = autoLoaded.filter(s =>
      loaded.some(l => l.requires.includes(s.name))
    );
    const sugs = autoLoaded.filter(s =>
      loaded.some(l => l.suggests.includes(s.name)) && !deps.includes(s)
    );
    if (deps.length > 0) {
      sections.push(
        `\n🔗 **Required:** ${deps.map(s => s.name).join(', ')}`
      );
    }
    if (sugs.length > 0) {
      sections.push(
        `💡 **Suggested:** ${sugs.map(s => s.name).join(', ')}`
      );
    }
  }

  return {
    success: true,
    output: sections.join('\n\n'),
    referencedSkills: crossRefs,
  };
}
