import { getDaiSupabase } from "../integrations/dai-supabase.js";
import { getObservations } from "./observations.js";
import { getTopLearnings } from "./learnings.js";
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
export async function getQuickContext(agentId: string, userId: string): Promise<QuickContext> {
  const supabase = getDaiSupabase();

  // Last session summary for this agent + user
  const { data: lastSession } = await supabase
    .from("sessions")
    .select("summary")
    .eq("agent_id", agentId)
    .eq("user_id", userId)
    .not("summary", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Top 5 learnings by score (confidence * applied_count)
  const topLearnings = await getTopLearnings(agentId, 5);

  // User-specific learnings (from sessions with this user)
  const { data: userLearningsData } = await supabase
    .from("learnings")
    .select("*, sessions!inner(user_id)")
    .eq("agent_id", agentId)
    .eq("sessions.user_id", userId)
    .eq("category", "user_preference")
    .order("confidence", { ascending: false })
    .limit(5);

  return {
    lastSessionSummary: (lastSession as { summary: string } | null)?.summary ?? null,
    topLearnings,
    userLearnings: (userLearningsData ?? []) as Learning[],
  };
}

/**
 * Layer 2: Full-text recall search across observations and learnings.
 * Used when the agent needs to remember something specific.
 * When clientCode is provided, client-specific learnings are boosted.
 *
 * PostgreSQL TS_RANK_CD returns higher=better (opposite of SQLite FTS5 lower=better).
 * We use higher=better throughout and sort descending.
 */
export async function recall(query: string, agentId?: string, clientCode?: string): Promise<RecallResult[]> {
  const supabase = getDaiSupabase();
  const results: RecallResult[] = [];

  // Search observations
  const { data: obsRows } = await supabase.rpc("search_observations", {
    query_text: query,
    agent_id_filter: agentId ?? null,
    result_limit: 10,
  });

  if (obsRows) {
    for (const row of obsRows as Array<{
      id: string;
      input_summary: string | null;
      output_summary: string | null;
      rank: number;
    }>) {
      results.push({
        source: "observation",
        id: row.id,
        content: [row.input_summary, row.output_summary].filter(Boolean).join(" -> "),
        rank: row.rank,
      });
    }
  }

  // Search learnings with optional client boosting
  const { data: learnRows } = await supabase.rpc("search_learnings", {
    query_text: query,
    agent_id_filter: agentId ?? null,
    client_code_filter: clientCode ?? null,
    result_limit: 20,
  });

  if (learnRows) {
    for (const row of learnRows as Array<{
      id: string;
      content: string;
      rank: number;
    }>) {
      results.push({
        source: "learning",
        id: row.id,
        content: row.content,
        rank: row.rank,
      });
    }
  }

  // Sort combined results by rank (higher = better match in PostgreSQL)
  results.sort((a, b) => b.rank - a.rank);

  return results;
}

/**
 * Layer 3: Deep context for a specific session.
 * Returns full session details with all observations and feedback.
 */
export async function getDeepContext(sessionId: string): Promise<DeepContext | undefined> {
  const session = await getSession(sessionId);
  if (!session) {
    return undefined;
  }

  const observations = await getObservations(sessionId);
  const feedback = await getFeedbackForSession(sessionId);

  return {
    session,
    observations,
    feedback,
  };
}
