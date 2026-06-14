// spica System Prompt
import fs from 'fs-extra';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import type { ProjectConfig } from '../utils/projectConfig';

// Get __dirname in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Builtin skills dir — supports dev mode (src/) and compiled mode (dist/)
function getBuiltinSkillsDir(): string {
  // Dev mode: src/prompts/system.ts -> src/builtin-skills
  const devPath = path.join(__dirname, '..', 'builtin-skills');
  if (fs.existsSync(devPath)) {
    return devPath;
  }
  // Compiled mode: dist/prompts/system.js -> ../../src/builtin-skills
  const distPath = path.join(__dirname, '..', '..', 'src', 'builtin-skills');
  if (fs.existsSync(distPath)) {
    return distPath;
  }
  // Fallback to dev path
  return devPath;
}

const BUILTIN_SKILLS_DIR = getBuiltinSkillsDir();

export const SYSTEM_PROMPT = `You are spica, a coding agent CLI. You edit files, run commands, and help developers.

## Tool Usage
- Use read before editing files. Use glob to find files, grep to search content.
- Run independent tools in parallel. Conflicting tools (same file) are sequenced automatically.
- Use the task tool to dispatch sub-agents for isolated sub-tasks. Prefer sub-agents over inline execution when approaching context limits.
- Prefer file-scoped commands over project-wide: \`npx tsc --noEmit <file>\` not \`npm run build\`.

## Tool Batching (Save Context Window)
- Plan your reads BEFORE making any calls. When you need to read multiple files, request ALL of them in a single response — not one at a time. Each round-trip resends your entire message history, so interleaving reads with LLM calls wastes massive tokens.
- Batch all independent reads together: [read(A), read(B), glob(...), grep(...)] in one response. Then process all results at once.
- Batch all independent writes together similarly. Only interleave when a write genuinely depends on a prior read.
- Only serialize reads when the second read's path or pattern depends on the first read's output. If you know both paths upfront, batch them.

## Safety
- Ask before: rm -rf, sudo, git push --force, git reset --hard.
- An auto-checkpoint runs before each request. Use /checkpoint restore <id> to roll back.

## Session Management
- Sessions are archived in .spica/sessions/ as JSON files, one per session.
- User can browse archived sessions with /history and view them with /view <id>.
- If the user asks about a past session or conversation history, use the read tool on .spica/sessions/ to find session files.
- These are slash commands (require / prefix). Do not execute "view", "history", "archive", "rename", "delete" as tasks — remind the user to use / prefix.

## Error Recovery
- When a tool fails: analyze the error, try an alternative approach. Don't repeat the same failing command.
- If blocked after multiple attempts, report what you tried and ask for guidance.

## Output Format
- Use markdown for structure. Code blocks with language tags. File references as \`path:line\`.
- Be concise. No fluff, no trailing summaries, no "Great!" without verification evidence.

## Completion
- Never claim completion without running verification (tests, lint, build).
- Continue working until the task is done or the user explicitly stops you.
`;

// Load using-superpowers bootstrap skill
function loadBootstrapSkill(): string {
  try {
    const bootstrapPath = path.join(
      BUILTIN_SKILLS_DIR,
      'superpowers',
      'using-superpowers',
      'SKILL.md'
    );
    if (fs.existsSync(bootstrapPath)) {
      const content = fs.readFileSync(bootstrapPath, 'utf-8');
      // Remove YAML frontmatter
      let body = content;
      if (content.startsWith('---')) {
        const endIdx = content.indexOf('---', 3);
        if (endIdx !== -1) {
          body = content.slice(endIdx + 3).trim();
        }
      }
      return body;
    }
  } catch {
    // Ignore errors loading bootstrap skill
  }
  return '';
}

// Build skills section for system prompt
export function buildSkillsSection(skillsMetadata: string): string {
  if (!skillsMetadata) return '';

  return `
## Available Skills
${skillsMetadata}
`;
}

// Read .spica/learnings/*.md and return concatenated content
function loadLearnings(workspacePath: string): string {
  try {
    const learningsDir = path.join(workspacePath, '.spica', 'learnings');
    if (!fs.existsSync(learningsDir)) return '';

    const files = fs
      .readdirSync(learningsDir)
      .filter(f => f.endsWith('.md'))
      .sort(); // chronological by filename (YYYY-MM-DD prefix)

    if (files.length === 0) return '';

    const contents = files
      .map(f => fs.readFileSync(path.join(learningsDir, f), 'utf-8'))
      .join('\n\n');

    return `\n\n## Project Learnings (from .spica/learnings/)\n${contents}`;
  } catch {
    return ''; // never break system prompt for learnings issues
  }
}

/**
 * Build the stable prefix of the system prompt.
 * This content NEVER changes across sessions — it's the highest-value cache target.
 * Keeping it as a separate message from variable content (skills, learnings)
 * means OpenAI's prefix cache hits this message even when skills change.
 */
export function getSystemPromptStable(projectConfig?: ProjectConfig): string {
  let prompt = '';

  // Core identity — most stable
  prompt += SYSTEM_PROMPT;

  // Bootstrap skill — very stable
  const bootstrapContent = loadBootstrapSkill();
  if (bootstrapContent) {
    prompt += '\n\n## How to Use Skills\n' + bootstrapContent;
  }

  // File-Scoped Commands — stable
  prompt += `
## File-Scoped Commands (Preferred - Fast)

Always prefer file-scoped commands over project-wide. Token savings: 97%.

| Operation | File-Scoped (Fast) | Project-Wide (Slow) |
|-----------|-------------------|--------------------|
| Type check | \`npx tsc --noEmit <file>\` (3s) | \`npm run typecheck\` (2min) |
| Lint | \`npx eslint <file>\` (1s) | \`npm run lint\` (30s) |
| Test | \`npm run test -- <file>\` (2s) | \`npm run test\` (4min) |

**Project-Wide Commands (Ask First)**:
- \`npm run build\` - ASK BEFORE RUNNING
- Full test suite - ASK BEFORE RUNNING
`;

  // Project Guidelines — stable per project
  if (projectConfig) {
    if (projectConfig.rawContent) {
      prompt +=
        '\n\n## Project Guidelines (from AGENTS.md) - Highest Priority\n' +
        projectConfig.rawContent;
    } else {
      const parts = [projectConfig.type];
      if (projectConfig.language) parts.push(projectConfig.language);
      if (projectConfig.framework) parts.push(projectConfig.framework);
      prompt += `\n\n## Project Guidelines\nProject: ${parts.join(' | ')}`;

      if (projectConfig.commands?.build || projectConfig.commands?.test) {
        prompt += `\nCommands: build=${projectConfig.commands.build || 'N/A'}, test=${projectConfig.commands.test || 'N/A'}`;
      }

      if (projectConfig.constraints && projectConfig.constraints.length > 0) {
        prompt += `\nConstraints: ${projectConfig.constraints.slice(0, 3).join(', ')}`;
      }
    }

    if (projectConfig.ruleLayers) {
      const { critical, important, preferences } = projectConfig.ruleLayers;
      if (critical.length > 0 || important.length > 0 || preferences.length > 0) {
        prompt += '\n\n## Rule Layers (from AGENTS.md)\n';

        if (critical.length > 0) {
          prompt += '\n### CRITICAL Rules (Must Follow)\n';
          critical.forEach(rule => (prompt += `- ${rule}\n`));
        }

        if (important.length > 0) {
          prompt += '\n### IMPORTANT Rules (Should Follow)\n';
          important.forEach(rule => (prompt += `- ${rule}\n`));
        }

        if (preferences.length > 0) {
          prompt += '\n### Preferences (Nice to Have)\n';
          preferences.forEach(rule => (prompt += `- ${rule}\n`));
        }
      }
    }
  }

  return prompt;
}

/**
 * Build the variable suffix of the system prompt.
 * Skills metadata and learnings change across sessions — by isolating them
 * in a separate message, the stable prefix (above) stays cache-hot.
 */
export function getSystemPromptVariable(skillsMetadata?: string, workspacePath?: string): string {
  let prompt = '';

  // Skills metadata — changes when skills are installed/removed
  if (skillsMetadata) {
    prompt += buildSkillsSection(skillsMetadata);
  }

  // Learnings — changes when new learnings are added
  if (workspacePath) {
    prompt += loadLearnings(workspacePath);
  }

  return prompt;
}

/**
 * Legacy: single-string system prompt for backward compatibility.
 * Prefer getSystemPromptStable + getSystemPromptVariable for cache-optimized split.
 */
export function getSystemPrompt(
  projectConfig?: ProjectConfig,
  skillsMetadata?: string,
  workspacePath?: string
): string {
  return (
    getSystemPromptStable(projectConfig) + getSystemPromptVariable(skillsMetadata, workspacePath)
  );
}
export function getCompactPrompt(messagesText: string): string {
  return `You are summarizing conversation history for YOUR OWN future reference. You will read this summary later to continue working.

CRITICAL: The conversation being summarized represents IN-PROGRESS WORK. The tasks described are NOT complete. You must accurately record what remains to be done so your future self can continue immediately without re-investigating.

## Must Preserve
1. User's explicit requirements and constraints (verbatim if short)
2. What files were modified/created and why
3. Current task status — exactly what is in progress and what's next
4. Errors hit and their solutions (so you don't repeat mistakes)
5. Key technical decisions (e.g., "used SQLite not Postgres because…")

## Can Omit
- Tool outputs (full diffs, file contents, command stdout)
- Failed intermediate attempts that were abandoned
- Boilerplate conversation ("how can I help?", acknowledgments)

## Format — Use this exact structure:

## Active Task
[One sentence: what the user asked you to do. This is the OVERARCHING GOAL — it is NOT yet complete.]

## Completed
- ...

## In Progress
- [What you were doing when context ran out]

## Pending (NOT YET DONE)
- [List every task/todo that is NOT yet completed]

## Decisions
- ...

## Next Action
[The EXACT next step to take when you resume. Be specific: which file, what change.]

## Continue Working
IMPORTANT: After reading this summary, call tools immediately to continue working. Do NOT produce a text response — just pick up where you left off.

History messages:
${messagesText}`;
}
