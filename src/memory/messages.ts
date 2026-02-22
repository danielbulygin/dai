import { nanoid } from 'nanoid';
import { getDb } from './db.js';

export interface ChatMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export interface AddMessageParams {
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
}

export function addMessage(params: AddMessageParams): ChatMessage {
  const db = getDb();
  const id = nanoid();

  const stmt = db.prepare(`
    INSERT INTO messages (id, session_id, role, content)
    VALUES (?, ?, ?, ?)
  `);

  stmt.run(id, params.session_id, params.role, params.content);

  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as ChatMessage;
}

export function getMessages(sessionId: string, limit = 20): ChatMessage[] {
  const db = getDb();

  // Fetch the most recent N messages, then return them in chronological order
  const stmt = db.prepare(`
    SELECT * FROM (
      SELECT * FROM messages
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    ) sub
    ORDER BY created_at ASC
  `);

  return stmt.all(sessionId, limit) as ChatMessage[];
}
