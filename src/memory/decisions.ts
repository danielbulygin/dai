import { nanoid } from "nanoid";
import { getDb } from "./db.js";

export interface Decision {
  id: string;
  agent_id: string;
  account_code: string;
  decision_type: string;
  target: string;
  rationale: string;
  metrics_snapshot: string | null;
  outcome: string | null;
  outcome_metrics: string | null;
  evaluated_at: string | null;
  session_id: string | null;
  created_at: string;
}

export interface LogDecisionParams {
  agent_id: string;
  account_code: string;
  decision_type: string;
  target: string;
  rationale: string;
  metrics_snapshot?: Record<string, unknown>;
  session_id?: string;
}

export function logDecision(params: LogDecisionParams): Decision {
  const db = getDb();
  const id = nanoid();

  const stmt = db.prepare(`
    INSERT INTO decisions (id, agent_id, account_code, decision_type, target, rationale, metrics_snapshot, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    params.agent_id,
    params.account_code,
    params.decision_type,
    params.target,
    params.rationale,
    params.metrics_snapshot ? JSON.stringify(params.metrics_snapshot) : null,
    params.session_id ?? null,
  );

  return db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as Decision;
}

export function getPendingDecisions(minAgeDays = 3): Decision[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM decisions
    WHERE outcome IS NULL
      AND created_at < datetime('now', ? || ' days')
    ORDER BY created_at ASC
  `);
  return stmt.all(`-${minAgeDays}`) as Decision[];
}

export function recordOutcome(
  id: string,
  outcome: string,
  outcomeMetrics?: Record<string, unknown>,
): void {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE decisions
    SET outcome = ?, outcome_metrics = ?, evaluated_at = datetime('now')
    WHERE id = ?
  `);
  stmt.run(
    outcome,
    outcomeMetrics ? JSON.stringify(outcomeMetrics) : null,
    id,
  );
}

export function getRecentDecisions(agentId: string, days = 7): Decision[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM decisions
    WHERE agent_id = ?
      AND created_at > datetime('now', ? || ' days')
    ORDER BY created_at DESC
  `);
  return stmt.all(agentId, `-${days}`) as Decision[];
}
