import { nanoid } from "nanoid";
import { getDb } from "./db.js";

export interface Session {
  id: string;
  agent_id: string;
  channel_id: string;
  thread_ts: string | null;
  user_id: string;
  claude_session_id: string | null;
  summary: string | null;
  total_cost: number;
  total_turns: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface CreateSessionParams {
  agent_id: string;
  channel_id: string;
  thread_ts?: string | null;
  user_id: string;
  claude_session_id?: string | null;
}

export interface UpdateSessionParams {
  claude_session_id?: string;
  summary?: string;
  total_cost?: number;
  total_turns?: number;
  status?: string;
}

export function createSession(params: CreateSessionParams): Session {
  const db = getDb();
  const id = nanoid();

  const stmt = db.prepare(`
    INSERT INTO sessions (id, agent_id, channel_id, thread_ts, user_id, claude_session_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    params.agent_id,
    params.channel_id,
    params.thread_ts ?? null,
    params.user_id,
    params.claude_session_id ?? null,
  );

  return getSession(id)!;
}

export function getSession(id: string): Session | undefined {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM sessions WHERE id = ?");
  return stmt.get(id) as Session | undefined;
}

export function findSession(
  channelId: string,
  threadTs: string | null,
  agentId: string,
): Session | undefined {
  const db = getDb();

  if (threadTs) {
    const stmt = db.prepare(
      "SELECT * FROM sessions WHERE channel_id = ? AND thread_ts = ? AND agent_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
    );
    return stmt.get(channelId, threadTs, agentId) as Session | undefined;
  }

  const stmt = db.prepare(
    "SELECT * FROM sessions WHERE channel_id = ? AND thread_ts IS NULL AND agent_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1",
  );
  return stmt.get(channelId, agentId) as Session | undefined;
}

export function updateSession(id: string, updates: UpdateSessionParams): void {
  const db = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.claude_session_id !== undefined) {
    fields.push("claude_session_id = ?");
    values.push(updates.claude_session_id);
  }
  if (updates.summary !== undefined) {
    fields.push("summary = ?");
    values.push(updates.summary);
  }
  if (updates.total_cost !== undefined) {
    fields.push("total_cost = ?");
    values.push(updates.total_cost);
  }
  if (updates.total_turns !== undefined) {
    fields.push("total_turns = ?");
    values.push(updates.total_turns);
  }
  if (updates.status !== undefined) {
    fields.push("status = ?");
    values.push(updates.status);
  }

  if (fields.length === 0) {
    return;
  }

  fields.push("updated_at = datetime('now')");
  values.push(id);

  const sql = `UPDATE sessions SET ${fields.join(", ")} WHERE id = ?`;
  db.prepare(sql).run(...values);
}

export function endSession(id: string, summary?: string): void {
  const db = getDb();
  const stmt = db.prepare(
    "UPDATE sessions SET status = 'ended', summary = COALESCE(?, summary), updated_at = datetime('now') WHERE id = ?",
  );
  stmt.run(summary ?? null, id);
}

/**
 * Find the most recent session for a channel, optionally matching a thread_ts.
 * Used by the reaction listener to resolve which agent wrote a message.
 */
export function findRecentSessionForChannel(
  channelId: string,
  threadTs?: string | null,
): Session | undefined {
  const db = getDb();

  // If we have a thread_ts, try exact match first
  if (threadTs) {
    const stmt = db.prepare(
      "SELECT * FROM sessions WHERE channel_id = ? AND thread_ts = ? ORDER BY created_at DESC LIMIT 1",
    );
    const session = stmt.get(channelId, threadTs) as Session | undefined;
    if (session) return session;
  }

  // Fall back to most recent session in this channel
  const stmt = db.prepare(
    "SELECT * FROM sessions WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1",
  );
  return stmt.get(channelId) as Session | undefined;
}

/**
 * Find the agent that owns a thread (most recent active session).
 * Used for thread continuity — follow-up messages go to the same agent.
 */
export function findThreadOwner(
  channelId: string,
  threadTs: string,
): string | undefined {
  const db = getDb();
  const stmt = db.prepare(
    "SELECT agent_id FROM sessions WHERE channel_id = ? AND thread_ts = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1",
  );
  const row = stmt.get(channelId, threadTs) as { agent_id: string } | undefined;
  return row?.agent_id;
}

export function getRecentSessions(agentId: string, limit = 10): Session[] {
  const db = getDb();
  const stmt = db.prepare(
    "SELECT * FROM sessions WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?",
  );
  return stmt.all(agentId, limit) as Session[];
}
