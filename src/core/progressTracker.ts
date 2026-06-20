/**
 * Structured progress tracker — survives compression.
 *
 * Problem: Agent progress is tracked implicitly via message history,
 * which compression truncates. After compression, the LLM loses awareness
 * of what files were changed, what was accomplished, and what remains.
 *
 * Solution: A compact, structured record of completed work that is:
 *   1. Stored outside message history (separate file)
 *   2. Injected into LLM context as a progress block after system messages
 *   3. Compact enough that it adds minimal tokens (~200-500 tokens)
 *   4. Never truncated by compression (always prepended fresh)
 */

export interface ProgressEntry {
  /** What happened: 'file_written', 'file_edited', 'decision_made', 'error_hit', 'milestone' */
  type: 'file_written' | 'file_edited' | 'decision_made' | 'error_hit' | 'milestone';
  /** Human-readable description, max 120 chars */
  description: string;
  /** ISO timestamp */
  at: string;
}

export interface ProgressSnapshot {
  entries: ProgressEntry[];
  /** Max entries to keep (oldest removed when exceeded) */
  maxEntries: number;
}

const DEFAULT_MAX_ENTRIES = 20;

export class ProgressTracker {
  private entries: ProgressEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  /** Record a file write/edit. */
  recordFileChange(type: 'file_written' | 'file_edited', path: string): void {
    this.add({
      type,
      description: `${type === 'file_written' ? 'Wrote' : 'Edited'} ${path.replace(/.*\//, '')}`,
      at: new Date().toISOString(),
    });
  }

  /** Record a decision made by the LLM. */
  recordDecision(decision: string): void {
    this.add({
      type: 'decision_made',
      description: decision.slice(0, 120),
      at: new Date().toISOString(),
    });
  }

  /** Record an error encountered. */
  recordError(error: string): void {
    this.add({
      type: 'error_hit',
      description: `Error: ${error.slice(0, 110)}`,
      at: new Date().toISOString(),
    });
  }

  /** Record a milestone (e.g., "Tests passing", "Build succeeded"). */
  recordMilestone(milestone: string): void {
    this.add({
      type: 'milestone',
      description: milestone.slice(0, 120),
      at: new Date().toISOString(),
    });
  }

  /** Build a compact context block for injection into LLM messages. */
  toContextBlock(): string {
    if (this.entries.length === 0) return '';

    const recent = this.entries.slice(-8); // last 8 entries, most relevant
    const lines = recent.map(e => {
      const icon =
        e.type === 'file_written' ? '📝' :
        e.type === 'file_edited' ? '[edit]' :
        e.type === 'decision_made' ? '[decide]' :
        e.type === 'error_hit' ? '[ERR]' :
        '[OK]'; // milestone
      return `${icon} ${e.description}`;
    });

    return `[PROGRESS — Recent work (survives compression):\n${lines.join('\n')}\n]`;
  }

  /** Serialize for persistence. */
  toJSON(): ProgressSnapshot {
    return { entries: this.entries, maxEntries: this.maxEntries };
  }

  /** Restore from persisted state. */
  static fromJSON(snapshot: ProgressSnapshot): ProgressTracker {
    const tracker = new ProgressTracker(snapshot.maxEntries);
    tracker.entries = snapshot.entries;
    return tracker;
  }

  /** Number of entries. */
  get count(): number {
    return this.entries.length;
  }

  /** Clear all entries. */
  clear(): void {
    this.entries = [];
  }

  private add(entry: ProgressEntry): void {
    this.entries.push(entry);
    while (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }
}
