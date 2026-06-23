/**
 * Tool usage analytics — track which tools are actually used.
 *
 * Feeds into lazy tool loading: frequently-used tools are promoted to core,
 * unused tools remain in the lazy set. Data persisted to .spica/tool-usage.json.
 */

import fs from 'fs-extra';
import { join } from 'path';

export interface ToolUsageStats {
  /** tool name → call count */
  counts: Record<string, number>;
  /** Total sessions tracked */
  sessions: number;
  /** Last updated ISO timestamp */
  lastUpdated: string;
}

const USAGE_FILE = 'tool-usage.json';

/** Load existing usage stats from project directory. */
function loadUsageStats(workspacePath: string): ToolUsageStats {
  const filePath = join(workspacePath, '.spica', USAGE_FILE);
  try {
    if (fs.existsSync(filePath)) {
      return fs.readJsonSync(filePath);
    }
  } catch {}
  return { counts: {}, sessions: 0, lastUpdated: new Date().toISOString() };
}

/** Save usage stats to project directory. */
function saveUsageStats(workspacePath: string, stats: ToolUsageStats): void {
  const spicaDir = join(workspacePath, '.spica');
  try {
    fs.ensureDirSync(spicaDir);
    stats.lastUpdated = new Date().toISOString();
    fs.writeJsonSync(join(spicaDir, USAGE_FILE), stats, { spaces: 2 });
  } catch {}
}

/** Record that a tool was used. */
export function recordToolUsage(workspacePath: string, toolName: string): void {
  const stats = loadUsageStats(workspacePath);
  stats.counts[toolName] = (stats.counts[toolName] || 0) + 1;
  saveUsageStats(workspacePath, stats);
}

/** Record a session start (increments session counter). */
export function recordSessionStart(workspacePath: string): void {
  const stats = loadUsageStats(workspacePath);
  stats.sessions += 1;
  saveUsageStats(workspacePath, stats);
}

/** Get tools ranked by usage count (most used first). */
export function getTopTools(workspacePath: string, topN = 10): Array<[string, number]> {
  const stats = loadUsageStats(workspacePath);
  return Object.entries(stats.counts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, topN);
}

/** Get tools that have never been used. */
export function getUnusedTools(workspacePath: string, allTools: string[]): string[] {
  const stats = loadUsageStats(workspacePath);
  return allTools.filter(t => !stats.counts[t] || stats.counts[t] === 0);
}

/** Get full usage report for display. */
export function getUsageReport(workspacePath: string): ToolUsageStats {
  return loadUsageStats(workspacePath);
}
