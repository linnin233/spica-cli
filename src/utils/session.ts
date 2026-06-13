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
  summary?: string; // 归档时的摘要
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

// Save current session
export function saveSession(
  workspacePath: string,
  messages: ChatMessage[],
  sessionName?: string
): void {
  const spicaDir = join(workspacePath, '.spica');

  try {
    fs.ensureDirSync(spicaDir);

    // Full history is preserved — context decoupling means LLM compression
    // never affects session persistence. cleanMessages() still runs to remove
    // invalid/duplicate messages, but no length/content truncation is applied.
    const cleaned = cleanMessages(messages);
    const existingSession = loadSession(workspacePath);

    const session: SessionState = {
      workspacePath,
      messages: cleaned,
      lastActivity: new Date().toISOString(),
      id: existingSession?.id || generateSessionId(),
      name: sessionName || existingSession?.name || `Session ${new Date().toLocaleDateString()}`,
      createdAt: existingSession?.createdAt || new Date().toISOString(),
    };

    fs.writeJsonSync(join(spicaDir, 'session.json'), session, { spaces: 2 });
  } catch {
    // 忽略保存错误
  }
}

// Generate simple summary from messages — natural language, no template prefixes
export function generateSessionSummary(messages: ChatMessage[]): string {
  if (messages.length === 0) return '';

  // Extract actual user requests — skip skill prompts, system injections, emotional outbursts
  const userMessages = messages
    .filter(m => m.role === 'user')
    .map(m => (m.content || '').replace(/\n/g, ' ').trim())
    .filter(m => {
      if (m.length === 0) return false;
      // Skip injected skill prompts (long templates > 500 chars)
      if (m.length > 500) return false;
      // Skip messages starting with markdown headings or template markers
      if (m.startsWith('#') || m.startsWith('##') || m.startsWith('<')) return false;
      // Skip messages containing template section headers
      if (/\b(Overview|Instructions|Guidelines|Prerequisites|Workflow)\b/i.test(m.slice(0, 100))) return false;
      // Skip system injections
      if (m.startsWith('[QUEUED') || m.startsWith('[SYSTEM]')) return false;
      // Skip pure symbols / emotional outbursts with no technical content
      if (/^[？?！!。.…，,、\s]+$/.test(m)) return false;
      // Skip emotional venting with no actionable content (short, question-heavy)
      if (m.length < 80 && (m.includes('为什么') || m.includes('到底') || m.includes('怎么回事')) && !/[a-zA-Z_/.]+/.test(m)) return false;
      return true;
    })
    .slice(0, 5);

  // Build a natural-language summary
  const parts: string[] = [];

  if (userMessages.length > 0) {
    const cleaned = userMessages.map(m => m.slice(0, 120));
    parts.push(cleaned.join('; '));
  }

  // Collect files modified
  const filePaths = new Set<string>();
  for (const m of messages) {
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        const args = tc.arguments || {};
        if (['write', 'edit', 'file_multi_edit'].includes(tc.name)) {
          if (args.path) filePaths.add(args.path as string);
        }
      }
    }
  }

  // Try to extract the assistant's final conclusion (always last assistant message without tool calls)
  const finalAssistantMsg = [...messages].reverse().find(
    m => m.role === 'assistant' && !m.toolCalls && (m.content || '').trim().length > 0
  );
  if (finalAssistantMsg && parts.length === 0) {
    // Use the first sentence of the final response as fallback summary
    const firstSentence = (finalAssistantMsg.content || '').split(/[.。\n]/)[0].trim();
    if (firstSentence.length > 10 && firstSentence.length < 200) {
      parts.push(firstSentence);
    }
  }

  if (parts.length === 0 && filePaths.size === 0) {
    return `${messages.length} messages`;
  }

  if (filePaths.size > 0) {
    const files = Array.from(filePaths)
      .slice(0, 5)
      .map(f => f.replace(/.*\//, ''));
    if (parts.length > 0) {
      parts[0] += ` — modified ${files.join(', ')}`;
    } else {
      parts.push(`Modified ${files.join(', ')}`);
    }
  }

  return parts.join('. ').slice(0, 300);
}

// Archive session — moves active session to historical, generating a summary.
// Uses LLM summary when an agent is provided; falls back to local extraction.
export async function archiveSession(
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
        // Build a rich but compact prompt: user intents + key actions + files changed
        const parts: string[] = [];

        // User messages (the actual requests, filtered)
        const userMsgs = session.messages
          .filter(m => m.role === 'user')
          .map(m => (m.content || '').replace(/\n/g, ' ').trim())
          .filter(m => m.length > 0 && m.length < 500)
          .slice(0, 3);
        if (userMsgs.length > 0) {
          parts.push(`User requests: ${userMsgs.map(m => m.slice(0, 200)).join(' | ')}`);
        }

        // Key tool actions (write/edit/bash with file paths or commands)
        const toolActions: string[] = [];
        for (const m of session.messages) {
          if (m.toolCalls) {
            for (const tc of m.toolCalls) {
              const args = tc.arguments || {};
              if (['write', 'edit', 'file_multi_edit'].includes(tc.name) && args.path) {
                toolActions.push(`${tc.name} ${(args.path as string).replace(/.*\//, '')}`);
              } else if (tc.name === 'bash' && args.command) {
                const cmd = (args.command as string).slice(0, 60);
                toolActions.push(`bash ${cmd}`);
              }
            }
          }
        }
        // Deduplicate and limit
        const uniqueActions = [...new Set(toolActions)].slice(0, 8);
        if (uniqueActions.length > 0) {
          parts.push(`Key actions: ${uniqueActions.join(', ')}`);
        }

        // Final outcome — last assistant message without tool calls
        const finalMsg = [...session.messages].reverse().find(
          m => m.role === 'assistant' && !m.toolCalls && (m.content || '').trim().length > 10
        );
        if (finalMsg) {
          const firstLine = (finalMsg.content || '').split('\n')[0].slice(0, 200);
          parts.push(`Outcome: ${firstLine}`);
        }

        const prompt = `Summarize this coding session in 1-2 sentences (max 100 words). What was the user trying to accomplish, what was done, and what was the result?

${parts.join('\n')}`;

        const response = await agent.generateDirect(prompt);
        if (response.content && response.content.trim() && response.content.length > 10) {
          // Filter out useless LLM responses
          const text = response.content.trim();
          if (!text.includes("don't have") && !text.includes('no information') && !text.includes('Could you please')) {
            summary = text.slice(0, 300);
          }
        }
      } catch {
        // Fallback to local summary
        summary = generateSessionSummary(session.messages);
      }

      // If LLM produced nothing useful, use local fallback
      if (!summary || summary.length < 15) {
        summary = generateSessionSummary(session.messages);
      }
    } else {
      summary = generateSessionSummary(session.messages);
    }

    session.summary = summary;

    // Save with session ID as filename
    const sessionPath = join(sessionsDir, `${session.id}.json`);
    fs.writeJsonSync(sessionPath, session, { spaces: 2 });

    return summary;
  } catch {
    return '';
  }
}

// Clean up old sessions
function cleanupOldSessions(sessionsDir: string, maxKeep: number): void {
  try {
    const files = fs
      .readdirSync(sessionsDir)
      .filter(f => f.endsWith('.json') && f.startsWith('sess_'))
      .map(f => ({
        name: f,
        path: join(sessionsDir, f),
        time: fs.statSync(join(sessionsDir, f)).mtime.getTime(),
      }))
      .sort((a, b) => b.time - a.time);

    // Remove oldest sessions beyond maxKeep
    if (files.length > maxKeep) {
      files.slice(maxKeep).forEach(f => {
        try {
          fs.removeSync(f.path);
        } catch {}
      });
    }
  } catch {
    // 忽略清理错误
  }
}

// List all archived sessions
export function listSessions(workspacePath: string): SessionMeta[] {
  const sessionsDir = join(workspacePath, SESSIONS_DIR);

  try {
    if (!fs.existsSync(sessionsDir)) {
      return [];
    }

    const files = fs
      .readdirSync(sessionsDir)
      .filter(f => f.endsWith('.json') && f.startsWith('sess_'))
      .map(f => {
        const session = fs.readJsonSync(join(sessionsDir, f));
        let summary = session.summary;
        // Regenerate if missing or old template format ("Tasks:", "Key outputs:")
        const isOldFormat = summary && /^(Tasks|Key outputs|Files|Tools):/.test(summary);
        if ((!summary || isOldFormat) && session.messages?.length > 0) {
          summary = generateSessionSummary(session.messages);
          // Persist the generated summary so we don't regenerate every time
          if (summary) {
            session.summary = summary;
            try {
              fs.writeJsonSync(join(sessionsDir, f), session, { spaces: 2 });
            } catch {}
          }
        }
        return {
          id: session.id,
          name: session.name,
          workspacePath: session.workspacePath,
          messageCount: session.messages?.length || 0,
          lastActivity: session.lastActivity,
          createdAt: session.createdAt,
          summary,
        };
      })
      .sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());

    return files;
  } catch {
    return [];
  }
}

// Load specific session by ID (supports partial ID matching)
export function loadSessionById(workspacePath: string, sessionId: string): SessionState | null {
  const sessionsDir = join(workspacePath, SESSIONS_DIR);

  try {
    // Exact match first
    const exactPath = join(sessionsDir, `${sessionId}.json`);
    if (fs.existsSync(exactPath)) {
      const session = fs.readJsonSync(exactPath);
      if (session.messages) {
        session.messages = cleanMessages(session.messages);
      }
      return session;
    }

    // Partial match: find file ending with the given ID
    if (fs.existsSync(sessionsDir)) {
      const files = fs
        .readdirSync(sessionsDir)
        .filter(f => f.endsWith('.json') && f.startsWith('sess_'));
      const match = files.find(f => f.replace('.json', '').endsWith(sessionId));
      if (match) {
        const session = fs.readJsonSync(join(sessionsDir, match));
        if (session.messages) {
          session.messages = cleanMessages(session.messages);
        }
        return session;
      }
    }
  } catch {}

  return null;
}

// Switch to a specific session
export function switchSession(workspacePath: string, sessionId: string): boolean {
  const session = loadSessionById(workspacePath, sessionId);
  if (!session) return false;

  try {
    const spicaDir = join(workspacePath, '.spica');
    fs.writeJsonSync(join(spicaDir, 'session.json'), session, { spaces: 2 });
    return true;
  } catch {
    return false;
  }
}

// Clear current session
export function clearSession(workspacePath: string): void {
  const sessionPath = join(workspacePath, '.spica', 'session.json');

  try {
    if (fs.existsSync(sessionPath)) {
      fs.removeSync(sessionPath);
    }
  } catch {
    // 忽略清除错误
  }
}

// Delete a specific archived session
export function deleteSession(workspacePath: string, sessionId: string): boolean {
  const sessionPath = join(workspacePath, SESSIONS_DIR, `${sessionId}.json`);

  try {
    if (fs.existsSync(sessionPath)) {
      fs.removeSync(sessionPath);
      return true;
    }
  } catch {}

  return false;
}

// Rename a session
export function renameSession(workspacePath: string, sessionId: string, newName: string): boolean {
  try {
    // Check if it's current session
    const currentSession = loadSession(workspacePath);
    if (currentSession?.id === sessionId) {
      currentSession.name = newName;
      fs.writeJsonSync(join(workspacePath, '.spica', 'session.json'), currentSession, {
        spaces: 2,
      });
    }

    // Update archived session
    const session = loadSessionById(workspacePath, sessionId);
    if (session) {
      session.name = newName;
      fs.writeJsonSync(join(workspacePath, SESSIONS_DIR, `${sessionId}.json`), session, {
        spaces: 2,
      });
      return true;
    }
  } catch {}

  return false;
}
