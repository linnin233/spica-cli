// 会话持久化 - 保存和恢复对话状态

import fs from 'fs-extra';
import { join } from 'path';
import type { ChatMessage } from '../llm/providers/BaseProvider';
import { cleanMessages } from './messageCleaner';

const SESSIONS_DIR = '.spica/sessions';

export interface SessionMeta {
  id: string;
  name: string;
  workspacePath: string;
  messageCount: number;
  lastActivity: string;
  createdAt: string;
  summary?: string;
}

export interface SessionState {
  workspacePath: string;
  messages: ChatMessage[];
  lastActivity: string;
  id: string;
  name: string;
  createdAt: string;
  summary?: string;  // 归档时的摘要
}

// Generate unique session ID
function generateSessionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 6);
  return `sess_${timestamp}_${random}`;
}

// Load current session (session.json in .spica/)
export function loadSession(workspacePath: string): SessionState | null {
  const sessionPath = join(workspacePath, '.spica', 'session.json');

  try {
    if (fs.existsSync(sessionPath)) {
      const session = fs.readJsonSync(sessionPath);
      if (session.messages) {
        session.messages = cleanMessages(session.messages);
      }
      return session;
    }
  } catch {
    // 忽略读取错误
  }

  return null;
}

// Save current session — preserves full history (no truncation)
export function saveSession(workspacePath: string, messages: ChatMessage[], sessionName?: string): void {
  const spicaDir = join(workspacePath, '.spica');

  try {
    fs.ensureDirSync(spicaDir);

    const existingSession = loadSession(workspacePath);
    const cleaned = cleanMessages(messages);

    const session: SessionState = {
      workspacePath,
      messages: cleaned,
      lastActivity: new Date().toISOString(),
      id: existingSession?.id || generateSessionId(),
      name: sessionName || existingSession?.name || `Session ${new Date().toLocaleDateString()}`,
      createdAt: existingSession?.createdAt || new Date().toISOString(),
    };

    fs.writeJsonSync(join(spicaDir, 'session.json'), session, { spaces: 2 });

    // Also save to sessions history (archive)
    archiveSession(workspacePath, session);
  } catch {
    // 忽略保存错误
  }
}

// Generate simple summary from messages — natural language, no template prefixes
export function generateSessionSummary(messages: ChatMessage[]): string {
  if (messages.length === 0) return '';

  // Extract actual user requests — skip skill prompts and system injections
  const userMessages = messages
    .filter(m => m.role === 'user')
    .map(m => (m.content || '').replace(/\n/g, ' ').trim())
    .filter(m => {
      if (m.length === 0) return false;
      // Skip skill prompts (long markdown templates)
      if (m.startsWith('#') || m.includes('## Overview')) return false;
      // Skip system injections
      if (m.startsWith('[QUEUED') || m.startsWith('[SYSTEM]')) return false;
      // Skip pure symbols like ？？？
      if (/^[？?！!。.…]+$/.test(m)) return false;
      return true;
    })
    .slice(0, 3);

  // Build a natural-language summary
  const parts: string[] = [];

  if (userMessages.length > 0) {
    const cleaned = userMessages.map(m => m.slice(0, 120));
    parts.push(cleaned.join('; '));
  }

  // Add files modified
  const filePaths = new Set<string>();
  for (const m of messages) {
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        const args = tc.arguments || {};
        if (['file_write', 'file_edit', 'file_multi_edit'].includes(tc.name)) {
          if (args.path) filePaths.add(args.path as string);
        }
      }
    }
  }

  if (parts.length === 0 && filePaths.size === 0) {
    // Nothing meaningful to summarize
    return `${messages.length} messages`;
  }

  if (filePaths.size > 0) {
    const files = Array.from(filePaths).slice(0, 5).map(f => f.replace(/.*\//, ''));
    if (parts.length > 0) {
      parts[0] += ` — modified ${files.join(', ')}`;
    } else {
      parts.push(`Modified ${files.join(', ')}`);
    }
  }

  return parts.join('. ').slice(0, 300);
}

// Archive session to sessions directory
export async function archiveSessionWithSummary(
  workspacePath: string,
  session: SessionState,
  agent?: { generateDirect: (prompt: string) => Promise<{ content?: string }> }
): Promise<string> {
  try {
    const sessionsDir = join(workspacePath, SESSIONS_DIR);
    fs.ensureDirSync(sessionsDir);

    // Generate summary
    let summary = '';

    if (agent && session.messages.length > 0) {
      // Try LLM summary first
      try {
        const userMessages = session.messages
          .filter(m => m.role === 'user')
          .map(m => m.content || '')
          .slice(0, 5);

        const prompt = `Summarize this coding session in 50-100 words. Focus on the main tasks, files modified, and outcomes:\n\n${userMessages.join('\n')}`;

        const response = await agent.generateDirect(prompt);
        if (response.content) {
          summary = response.content.slice(0, 300);
        }
      } catch {
        // Fallback to simple summary
        summary = generateSessionSummary(session.messages);
      }
    } else {
      summary = generateSessionSummary(session.messages);
    }

    session.summary = summary;

    // Save with session ID as filename
    const sessionPath = join(sessionsDir, `${session.id}.json`);
    fs.writeJsonSync(sessionPath, session, { spaces: 2 });

    // Update sessions index
    updateSessionsIndex(workspacePath, session);

    return summary;
  } catch (err) {
    // Fallback: just do simple summary without LLM
    const summary = generateSessionSummary(session.messages);
    session.summary = summary;
    return summary;
  }
}

// Simple archive (synchronous, used as fallback)
export function archiveSession(workspacePath: string, session: SessionState): void {
  try {
    const sessionsDir = join(workspacePath, SESSIONS_DIR);
    fs.ensureDirSync(sessionsDir);

    const sessionPath = join(sessionsDir, `${session.id}.json`);
    fs.writeJsonSync(sessionPath, session, { spaces: 2 });
    updateSessionsIndex(workspacePath, session);
  } catch {
    // 忽略保存错误
  }
}

// Update sessions index file
function updateSessionsIndex(workspacePath: string, session: SessionState): void {
  try {
    const indexPath = join(workspacePath, SESSIONS_DIR, '_index.json');
    let index: SessionMeta[] = [];

    if (fs.existsSync(indexPath)) {
      index = fs.readJsonSync(indexPath);
    }

    // Update or add entry
    const existing = index.findIndex((s: SessionMeta) => s.id === session.id);
    const entry: SessionMeta = {
      id: session.id,
      name: session.name,
      workspacePath: session.workspacePath,
      messageCount: session.messages.length,
      lastActivity: session.lastActivity,
      createdAt: session.createdAt,
      summary: session.summary,
    };

    if (existing >= 0) {
      index[existing] = entry;
    } else {
      index.push(entry);
    }

    fs.writeJsonSync(indexPath, index, { spaces: 2 });
  } catch {
    // 忽略保存错误
  }
}

// List all archived sessions
export function listSessions(workspacePath: string): SessionMeta[] {
  try {
    const indexPath = join(workspacePath, SESSIONS_DIR, '_index.json');
    if (fs.existsSync(indexPath)) {
      return fs.readJsonSync(indexPath);
    }
  } catch {
    // 忽略读取错误
  }
  return [];
}

// Get a specific session by ID
export function getSession(workspacePath: string, sessionId: string): SessionState | null {
  try {
    const sessionPath = join(workspacePath, SESSIONS_DIR, `${sessionId}.json`);
    if (fs.existsSync(sessionPath)) {
      const session = fs.readJsonSync(sessionPath);
      if (session.messages) {
        session.messages = cleanMessages(session.messages);
      }
      return session;
    }
  } catch {
    // 忽略读取错误
  }
  return null;
}
