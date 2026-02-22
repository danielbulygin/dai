import { getDb } from "./db.js";
import { getObservations } from "./observations.js";
import { getTopLearnings, searchLearnings } from "./learnings.js";
import { getSession } from "./sessions.js";
import { getFeedbackForSession } from "./feedback.js";
import type { Session } from "./sessions.js";
import type { Learning } from "./learnings.js";
import type { Observation } from "./observations.js";
import type { Feedback } from "./feedback.js";

export interface QuickContext {
  lastSessionSummary: string | null;
  topLearnings: Learning[];
  userLearnings: Learning[];
}

export interface RecallResult {
  source: "observation" | "learning";
  id: string;
  content: string;
  rank: number;
}

export interface DeepContext {
  session: Session;
  observations: Observation[];
  feedback: Feedback[];
}

/**
 * Layer 1: Quick context for injecting into agent system prompts.
 * Returns last session summary, top learnings, and user-specific learnings.
 * Target: ~200 tokens.
 */
export function getQuickContext(agentId: string, userId: string): QuickContext {
  const db = getDb();

  // Last session summary for this agent + user
  const lastSession = db
    .prepare(
      "SELECT summary FROM sessions WHERE agent_id = ? AND user_id = ? AND summary IS NOT NULL ORDER BY created_at DESC LIMIT 1",
    )
    .get(agentId, userId) as { summary: string } | undefined;

  // Top 5 learnings by confidence * applied_count
  const topLearnings = getTopLearnings(agentId, 5);

  // User-specific learnings (from sessions with this user)
  const userLearnings = db
    .prepare(
      `SELECT l.* FROM learnings l
       JOIN sessions s ON l.source_session_id = s.id
       WHERE l.agent_id = ? AND s.user_id = ? AND l.category = 'user_preference'
       ORDER BY l.confidence DESC
       LIMIT 5`,
    )
    .all(agentId, userId) as Learning[];

  return {
    lastSessionSummary: lastSession?.summary ?? null,
    topLearnings,
    userLearnings,
  };
}

/**
 * Layer 2: FTS5 recall search across observations and learnings.
 * Used when the agent needs to remember something specific.
 */
export function recall(query: string, agentId?: string): RecallResult[] {
  const db = getDb();
  const results: RecallResult[] = [];

  // Search observations
  const obsStmt = agentId
    ? db.prepare(`
        SELECT o.id, o.input_summary, o.output_summary, fts.rank
        FROM observations_fts fts
        JOIN observations o ON o.rowid = fts.rowid
        JOIN sessions s ON o.session_id = s.id
        WHERE observations_fts MATCH ? AND s.agent_id = ?
        ORDER BY fts.rank
        LIMIT 10
      `)
    : db.prepare(`
        SELECT o.id, o.input_summary, o.output_summary, fts.rank
        FROM observations_fts fts
        JOIN observations o ON o.rowid = fts.rowid
        WHERE observations_fts MATCH ?
        ORDER BY fts.rank
        LIMIT 10
      `);

  const obsRows = (agentId ? obsStmt.all(query, agentId) : obsStmt.all(query)) as Array<{
    id: string;
    input_summary: string | null;
    output_summary: string | null;
    rank: number;
  }>;

  for (const row of obsRows) {
    results.push({
      source: "observation",
      id: row.id,
      content: [row.input_summary, row.output_summary].filter(Boolean).join(" -> "),
      rank: row.rank,
    });
  }

  // Search learnings
  const learnStmt = agentId
    ? db.prepare(`
        SELECT l.id, l.content, fts.rank
        FROM learnings_fts fts
        JOIN learnings l ON l.rowid = fts.rowid
        WHERE learnings_fts MATCH ? AND l.agent_id = ?
        ORDER BY fts.rank
        LIMIT 10
      `)
    : db.prepare(`
        SELECT l.id, l.content, fts.rank
        FROM learnings_fts fts
        JOIN learnings l ON l.rowid = fts.rowid
        WHERE learnings_fts MATCH ?
        ORDER BY fts.rank
        LIMIT 10
      `);

  const learnRows = (agentId ? learnStmt.all(query, agentId) : learnStmt.all(query)) as Array<{
    id: string;
    content: string;
    rank: number;
  }>;

  for (const row of learnRows) {
    results.push({
      source: "learning",
      id: row.id,
      content: row.content,
      rank: row.rank,
    });
  }

  // Sort combined results by FTS rank (lower = better match)
  results.sort((a, b) => a.rank - b.rank);

  return results;
}

/**
 * Layer 3: Deep context for a specific session.
 * Returns full session details with all observations and feedback.
 */
export function getDeepContext(sessionId: string): DeepContext | undefined {
  const session = getSession(sessionId);
  if (!session) {
    return undefined;
  }

  const observations = getObservations(sessionId);
  const feedback = getFeedbackForSession(sessionId);

  return {
    session,
    observations,
    feedback,
  };
}
