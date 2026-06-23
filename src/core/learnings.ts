import fs from 'fs-extra';
import { join } from 'path';

/**
 * Auto-extract project learnings from user corrections and repeated failures.
 *
 * Conservative extraction — only saves when patterns are unambiguous.
 * Learnings are written to .spica/learnings/YYYY-MM-DD-topic.md and
 * automatically loaded into the system prompt on next session.
 */

// Patterns that indicate a user correction
const CORRECTION_PATTERNS = [
  /^(no,?\s+)?use\s+\S+/i,
  /^(no,?\s+)?don'?t\s+use\s+\S+/i,
  /^instead[,;]?\s+use\s+\S+/i,
  /^(no,?\s+)?the\s+correct\s+(command|way|approach)\s+is/i,
  /^actually[,;]?\s+/i,
  /^that'?s\s+wrong[,;]?\s+/i,
];

/** Check if a user message looks like a correction. */
export function isCorrection(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length < 10 || trimmed.length > 500) return false;
  return CORRECTION_PATTERNS.some(p => p.test(trimmed));
}

export interface FailureRecord {
  toolName: string;
  error: string;
  count: number;
}

/**
 * Analyze tool execution history for repeated failures.
 * Returns learnings for tools that failed 3+ times with similar errors.
 */
export function extractFailureLearnings(
  failures: FailureRecord[]
): string[] {
  const learnings: string[] = [];

  for (const f of failures) {
    if (f.count >= 3) {
      learnings.push(
        `Tool "${f.toolName}" failed ${f.count} times with: ${f.error.slice(0, 200)}. ` +
        `Avoid using ${f.toolName} this way or check configuration.`
      );
    }
  }

  return learnings;
}

/**
 * Extract a topic slug from a learning text.
 */
function topicFromText(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 5);
  return words.join('-') || 'general';
}

/**
 * Save a learning to .spica/learnings/.
 *
 * Each learning is one file: YYYY-MM-DD-topic.md.
 * If a file for today with the same topic exists, it's NOT overwritten.
 */
export async function saveLearning(
  workspacePath: string,
  text: string
): Promise<boolean> {
  try {
    const learningsDir = join(workspacePath, '.spica', 'learnings');
    await fs.ensureDir(learningsDir);

    const today = new Date().toISOString().slice(0, 10);
    const topic = topicFromText(text);
    const filename = `${today}-${topic}.md`;
    const filepath = join(learningsDir, filename);

    // Don't overwrite existing learnings for the same day+topic
    if (fs.existsSync(filepath)) return false;

    const content = `# ${topic.replace(/-/g, ' ')}\n\n${text}\n`;
    await fs.writeFile(filepath, content, 'utf-8');
    return true;
  } catch {
    return false;
  }
}
