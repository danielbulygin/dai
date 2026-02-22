import { nanoid } from "nanoid";
import { getDb } from "./db.js";

export interface Observation {
  id: string;
  session_id: string;
  tool_name: string;
  input_summary: string | null;
  output_summary: string | null;
  importance: number;
  tags: string | null;
  created_at: string;
}

export interface AddObservationParams {
  session_id: string;
  tool_name: string;
  input_summary?: string | null;
  output_summary?: string | null;
  importance?: number;
  tags?: string[];
}

export function addObservation(params: AddObservationParams): Observation {
  const db = getDb();
  const id = nanoid();

  const stmt = db.prepare(`
    INSERT INTO observations (id, session_id, tool_name, input_summary, output_summary, importance, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    params.session_id,
    params.tool_name,
    params.input_summary ?? null,
    params.output_summary ?? null,
    params.importance ?? 5,
    params.tags ? JSON.stringify(params.tags) : null,
  );

  return db.prepare("SELECT * FROM observations WHERE id = ?").get(id) as Observation;
}

export function getObservations(sessionId: string): Observation[] {
  const db = getDb();
  const stmt = db.prepare(
    "SELECT * FROM observations WHERE session_id = ? ORDER BY created_at ASC",
  );
  return stmt.all(sessionId) as Observation[];
}

export function searchObservations(query: string): Observation[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT o.*
    FROM observations_fts fts
    JOIN observations o ON o.rowid = fts.rowid
    WHERE observations_fts MATCH ?
    ORDER BY rank
  `);
  return stmt.all(query) as Observation[];
}
