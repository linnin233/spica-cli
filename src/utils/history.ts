import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ChatMessage } from '../llm/providers/BaseProvider';

const HISTORY_FILE = path.join(os.homedir(), '.spica', 'history.json');
const MAX_HISTORY = 50;

export function ensureHistoryDir() {
  const dir = path.dirname(HISTORY_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadHistory(): ChatMessage[] {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = fs.readFileSync(HISTORY_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch {
    // Failed to load history - returning empty array
  }
  return [];
}

export function saveHistory(history: ChatMessage[]): void {
  try {
    ensureHistoryDir();
    const trimmed = history.slice(-MAX_HISTORY);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2), { mode: 0o600 });
    fs.chmodSync(HISTORY_FILE, 0o600);
  } catch {
    // Failed to save history - non-critical
  }
}

export function clearHistory(): void {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      fs.unlinkSync(HISTORY_FILE);
    }
  } catch {
    // Failed to clear history - non-critical
  }
}
