import { nanoid } from "nanoid";
import { getDb } from "./db.js";

export interface Feedback {
  id: string;
  session_id: string | null;
  agent_id: string;
  user_id: string;
  type: string;
  sentiment: string;
  content: string | null;
  message_ts: string | null;
  processed: number;
  created_at: string;
}

export interface AddFeedbackParams {
  session_id?: string | null;
  agent_id: string;
  user_id: string;
  type: string;
  sentiment: string;
  content?: string | null;
  message_ts?: string | null;
}

export function addFeedback(params: AddFeedbackParams): Feedback {
  const db = getDb();
  const id = nanoid();

  const stmt = db.prepare(`
    INSERT INTO feedback (id, session_id, agent_id, user_id, type, sentiment, content, message_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    params.session_id ?? null,
    params.agent_id,
    params.user_id,
    params.type,
    params.sentiment,
    params.content ?? null,
    params.message_ts ?? null,
  );

  return db.prepare("SELECT * FROM feedback WHERE id = ?").get(id) as Feedback;
}

export function getUnprocessedFeedback(limit = 50): Feedback[] {
  const db = getDb();
  const stmt = db.prepare(
    "SELECT * FROM feedback WHERE processed = 0 ORDER BY created_at ASC LIMIT ?",
  );
  return stmt.all(limit) as Feedback[];
}

export function markProcessed(id: string): void {
  const db = getDb();
  const stmt = db.prepare("UPDATE feedback SET processed = 1 WHERE id = ?");
  stmt.run(id);
}

export function getFeedbackForSession(sessionId: string): Feedback[] {
  const db = getDb();
  const stmt = db.prepare(
    "SELECT * FROM feedback WHERE session_id = ? ORDER BY created_at ASC",
  );
  return stmt.all(sessionId) as Feedback[];
}
