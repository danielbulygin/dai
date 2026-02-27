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
  client_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface AddLearningParams {
  agent_id: string;
  category: string;
  content: string;
  confidence?: number;
  source_session_id?: string | null;
  client_code?: string | null;
}

export function addLearning(params: AddLearningParams): Learning {
  const db = getDb();
  const id = nanoid();

  const stmt = db.prepare(`
    INSERT INTO learnings (id, agent_id, category, content, confidence, source_session_id, client_code)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    params.agent_id,
    params.category,
    params.content,
    params.confidence ?? 0.5,
    params.source_session_id ?? null,
    params.client_code ?? null,
  );

  return db.prepare("SELECT * FROM learnings WHERE id = ?").get(id) as Learning;
}

export function getLearnings(
  agentId: string,
  category?: string,
  limit = 20,
  clientCode?: string | null,
): Learning[] {
  const db = getDb();

  const conditions = ["agent_id = ?"];
  const params: unknown[] = [agentId];

  if (category) {
    conditions.push("category = ?");
    params.push(category);
  }

  if (clientCode) {
    conditions.push("client_code = ?");
    params.push(clientCode);
  }

  params.push(limit);
  const stmt = db.prepare(
    `SELECT * FROM learnings WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`,
  );
  return stmt.all(...params) as Learning[];
}

export function searchLearnings(query: string, clientCode?: string): Learning[] {
  const db = getDb();

  if (clientCode) {
    // Sort client-specific results first via CASE expression
    const stmt = db.prepare(`
      SELECT l.*
      FROM learnings_fts fts
      JOIN learnings l ON l.rowid = fts.rowid
      WHERE learnings_fts MATCH ?
      ORDER BY CASE WHEN l.client_code = ? THEN 0 ELSE 1 END, rank
    `);
    return stmt.all(query, clientCode) as Learning[];
  }

  const stmt = db.prepare(`
    SELECT l.*
    FROM learnings_fts fts
    JOIN learnings l ON l.rowid = fts.rowid
    WHERE learnings_fts MATCH ?
    ORDER BY rank
  `);
  return stmt.all(query) as Learning[];
}

/**
 * Check for an existing learning that is substantially similar.
 * Uses FTS to find content matches within the same agent/category/client_code scope.
 * Returns the first match if found, or undefined.
 */
export function findDuplicateLearning(
  agentId: string,
  category: string,
  content: string,
  clientCode: string | null,
): Learning | undefined {
  const db = getDb();

  // Extract significant keywords for FTS matching (skip short/common words)
  const keywords = content
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 8)
    .join(" ");

  if (!keywords) return undefined;

  try {
    const rows = db
      .prepare(
        `SELECT l.*
         FROM learnings_fts fts
         JOIN learnings l ON l.rowid = fts.rowid
         WHERE learnings_fts MATCH ?
           AND l.agent_id = ?
           AND l.category = ?
         ORDER BY rank
         LIMIT 5`,
      )
      .all(keywords, agentId, category) as Learning[];

    // Check if any result is for the same client_code
    for (const row of rows) {
      if ((row.client_code ?? null) === clientCode) {
        return row;
      }
    }
  } catch {
    // FTS query can fail on certain inputs — not critical
  }

  return undefined;
}

export function incrementApplied(id: string): void {
  const db = getDb();
  const stmt = db.prepare(
    "UPDATE learnings SET applied_count = applied_count + 1, updated_at = datetime('now') WHERE id = ?",
  );
  stmt.run(id);
}

export function updateLearningConfidence(id: string, confidence: number): void {
  const db = getDb();
  db.prepare(
    "UPDATE learnings SET confidence = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(confidence, id);
}

export function deleteLearning(id: string): void {
  const db = getDb();
  db.prepare("DELETE FROM learnings WHERE id = ?").run(id);
}

export function getTopLearnings(agentId: string, limit = 10): Learning[] {
  const db = getDb();
  const stmt = db.prepare(
    "SELECT * FROM learnings WHERE agent_id = ? ORDER BY (confidence * applied_count) DESC LIMIT ?",
  );
  return stmt.all(agentId, limit) as Learning[];
}
