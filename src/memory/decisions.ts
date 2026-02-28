import { nanoid } from "nanoid";
import { getDaiSupabase } from "../integrations/dai-supabase.js";

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

export async function logDecision(params: LogDecisionParams): Promise<Decision> {
  const supabase = getDaiSupabase();
  const id = nanoid();

  const { data, error } = await supabase
    .from("decisions")
    .insert({
      id,
      agent_id: params.agent_id,
      account_code: params.account_code,
      decision_type: params.decision_type,
      target: params.target,
      rationale: params.rationale,
      metrics_snapshot: params.metrics_snapshot ? JSON.stringify(params.metrics_snapshot) : null,
      session_id: params.session_id ?? null,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to log decision: ${error.message}`);
  return data as Decision;
}

export async function getPendingDecisions(minAgeDays = 3): Promise<Decision[]> {
  const supabase = getDaiSupabase();
  const cutoff = new Date(Date.now() - minAgeDays * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("decisions")
    .select()
    .is("outcome", null)
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Failed to get pending decisions: ${error.message}`);
  return (data ?? []) as Decision[];
}

export async function recordOutcome(
  id: string,
  outcome: string,
  outcomeMetrics?: Record<string, unknown>,
): Promise<void> {
  const supabase = getDaiSupabase();

  const { error } = await supabase
    .from("decisions")
    .update({
      outcome,
      outcome_metrics: outcomeMetrics ? JSON.stringify(outcomeMetrics) : null,
      evaluated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) throw new Error(`Failed to record outcome: ${error.message}`);
}

export async function getRecentDecisions(agentId: string, days = 7): Promise<Decision[]> {
  const supabase = getDaiSupabase();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("decisions")
    .select()
    .eq("agent_id", agentId)
    .gt("created_at", cutoff)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Failed to get recent decisions: ${error.message}`);
  return (data ?? []) as Decision[];
}
