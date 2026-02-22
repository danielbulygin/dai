import { nanoid } from "nanoid";
import { getDb } from "./db.js";

export interface Learning {
  id: string;
  agent_id: string;
  category: string;
  content: string;
  confidence: number;
  applied_count: number;
  source_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AddLearningParams {
  agent_id: string;
  category: string;
  content: string;
  confidence?: number;
  source_session_id?: string | null;
}

export function addLearning(params: AddLearningParams): Learning {
  const db = getDb();
  const id = nanoid();

  const stmt = db.prepare(`
    INSERT INTO learnings (id, agent_id, category, content, confidence, source_session_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    params.agent_id,
    params.category,
    params.content,
    params.confidence ?? 0.5,
    params.source_session_id ?? null,
  );

  return db.prepare("SELECT * FROM learnings WHERE id = ?").get(id) as Learning;
}

export function getLearnings(
  agentId: string,
  category?: string,
  limit = 20,
): Learning[] {
  const db = getDb();

  if (category) {
    const stmt = db.prepare(
      "SELECT * FROM learnings WHERE agent_id = ? AND category = ? ORDER BY updated_at DESC LIMIT ?",
    );
    return stmt.all(agentId, category, limit) as Learning[];
  }

  const stmt = db.prepare(
    "SELECT * FROM learnings WHERE agent_id = ? ORDER BY updated_at DESC LIMIT ?",
  );
  return stmt.all(agentId, limit) as Learning[];
}

export function searchLearnings(query: string): Learning[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT l.*
    FROM learnings_fts fts
    JOIN learnings l ON l.rowid = fts.rowid
    WHERE learnings_fts MATCH ?
    ORDER BY rank
  `);
  return stmt.all(query) as Learning[];
}

export function incrementApplied(id: string): void {
  const db = getDb();
  const stmt = db.prepare(
    "UPDATE learnings SET applied_count = applied_count + 1, updated_at = datetime('now') WHERE id = ?",
  );
  stmt.run(id);
}

export function getTopLearnings(agentId: string, limit = 10): Learning[] {
  const db = getDb();
  const stmt = db.prepare(
    "SELECT * FROM learnings WHERE agent_id = ? ORDER BY (confidence * applied_count) DESC LIMIT ?",
  );
  return stmt.all(agentId, limit) as Learning[];
}
