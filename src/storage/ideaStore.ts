// Idea persistence — lightweight JSON storage for fleeting thoughts captured
// during coding sessions. Each project has its own .spica/ideas.json.

import fs from 'fs';
import path from 'path';

export interface Idea {
  id: number;
  text: string;
  status: 'open' | 'done';
  createdAt: string;
}

export interface IdeaStore {
  ideas: Idea[];
  nextId: number;
}

const IDEAS_FILE = '.spica/ideas.json';

function ensureDir(workspacePath: string): void {
  const spicaDir = path.join(workspacePath, '.spica');
  if (!fs.existsSync(spicaDir)) {
    fs.mkdirSync(spicaDir, { recursive: true });
  }
}

/** Load the idea store for a project. Returns empty store if none exists. */
export function loadIdeas(workspacePath: string): IdeaStore {
  try {
    const ideasPath = path.join(workspacePath, IDEAS_FILE);
    if (fs.existsSync(ideasPath)) {
      const data = fs.readFileSync(ideasPath, 'utf-8');
      return JSON.parse(data);
    }
  } catch {
    // Corrupted or missing — return fresh store
  }
  return { ideas: [], nextId: 1 };
}

function saveIdeas(workspacePath: string, store: IdeaStore): void {
  try {
    ensureDir(workspacePath);
    const ideasPath = path.join(workspacePath, IDEAS_FILE);
    fs.writeFileSync(ideasPath, JSON.stringify(store, null, 2));
  } catch {
    // Non-critical — ideas are ephemeral
  }
}

/** Add a new idea. Returns the created Idea. */
export function addIdea(workspacePath: string, text: string): Idea | null {
  if (!text.trim()) return null;
  const store = loadIdeas(workspacePath);
  const idea: Idea = {
    id: store.nextId,
    text: text.trim(),
    status: 'open',
    createdAt: new Date().toISOString(),
  };
  store.ideas.push(idea);
  store.nextId++;
  saveIdeas(workspacePath, store);
  return idea;
}

/** Mark idea as done. Returns true if found and updated. */
export function markDone(workspacePath: string, id: number): boolean {
  const store = loadIdeas(workspacePath);
  const idea = store.ideas.find(i => i.id === id);
  if (!idea) return false;
  idea.status = 'done';
  saveIdeas(workspacePath, store);
  return true;
}

/** Toggle idea back to open. */
export function markOpen(workspacePath: string, id: number): boolean {
  const store = loadIdeas(workspacePath);
  const idea = store.ideas.find(i => i.id === id);
  if (!idea) return false;
  idea.status = 'open';
  saveIdeas(workspacePath, store);
  return true;
}

/** Delete an idea. Returns true if found and removed. */
export function deleteIdea(workspacePath: string, id: number): boolean {
  const store = loadIdeas(workspacePath);
  const idx = store.ideas.findIndex(i => i.id === id);
  if (idx === -1) return false;
  store.ideas.splice(idx, 1);
  saveIdeas(workspacePath, store);
  return true;
}

/** Get all open ideas (most recent last). */
export function getOpenIdeas(workspacePath: string): Idea[] {
  const store = loadIdeas(workspacePath);
  return store.ideas.filter(i => i.status === 'open');
}

/** Get all ideas (most recent last). */
export function getAllIdeas(workspacePath: string): Idea[] {
  const store = loadIdeas(workspacePath);
  return store.ideas;
}
