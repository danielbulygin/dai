import { nanoid } from "nanoid";
import { getDaiSupabase } from "../integrations/dai-supabase.js";
import { env } from "../env.js";
import { logger } from "../utils/logger.js";

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

export async function addLearning(params: AddLearningParams): Promise<Learning> {
  const supabase = getDaiSupabase();
  const id = nanoid();

  const { data, error } = await supabase
    .from("learnings")
    .insert({
      id,
      agent_id: params.agent_id,
      category: params.category,
      content: params.content,
      confidence: params.confidence ?? 0.5,
      source_session_id: params.source_session_id ?? null,
      client_code: params.client_code ?? null,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to add learning: ${error.message}`);

  // Stage B dual-write (AOT Memory §8.2, D1: the store is the PERMANENT home
  // of Ada's learnings): mirror the committed row into the memory store, in
  // the backfill's exact file shape so live writes and the 3,548 backfilled
  // rows form one corpus. Flag-gated (MEMORY_STORE_DUAL_WRITE=1) and strictly
  // best-effort — the store must never be able to break remember(); the
  // nightly re-run of backfill-learnings.ts catches anything missed here.
  if ((env as unknown as Record<string, string | undefined>).MEMORY_STORE_DUAL_WRITE === '1') {
    try {
      const { storeWriteLearning } = await import('../memory-store/store-client.js');
      // Spread: Learning (fixed props) -> LearningRowForStore (indexed shape).
      const res = await storeWriteLearning({ ...(data as Learning) });
      logger.info({ path: res.path, status: res.status }, 'learning dual-written to memory store');
    } catch (err) {
      logger.warn({ err, learningId: (data as Learning).id }, 'memory-store dual-write failed (learnings row is committed; backfill re-run will catch up)');
    }
  }

  return data as Learning;
}

export async function getLearnings(
  agentId: string,
  category?: string,
  limit = 20,
  /** A single value, or a candidate SET — learnings.client_code is freeform
   *  mixed-convention data ('jva', 'brain_fm', 'brainfm', 'bfm', 'press_london'
   *  all coexist), so callers pass every plausible spelling. */
  clientCode?: string | string[] | null,
): Promise<Learning[]> {
  const supabase = getDaiSupabase();

  let query = supabase
    .from("learnings")
    .select()
    .eq("agent_id", agentId)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (category) {
    query = query.eq("category", category);
  }

  if (Array.isArray(clientCode)) {
    query = query.in("client_code", clientCode);
  } else if (clientCode) {
    query = query.eq("client_code", clientCode);
  }

  const { data, error } = await query;

  if (error) throw new Error(`Failed to get learnings: ${error.message}`);
  return (data ?? []) as Learning[];
}

export interface SearchLearningsScope {
  /** Restrict to one agent's learnings (client-scoped runs pass `ada_client_<CODE>`). */
  agentId?: string;
  /**
   * Turn `clientCode` from a rank boost into a hard row filter. Set ONLY on
   * client-scoped (customer) runs — this is the cross-tenant boundary. Internal
   * agency callers omit it and keep cross-client search.
   */
  strictClientCode?: boolean;
}

export async function searchLearnings(
  query: string,
  clientCode?: string,
  scope?: SearchLearningsScope,
): Promise<Learning[]> {
  const supabase = getDaiSupabase();

  const { data, error } = await supabase.rpc("search_learnings", {
    query_text: query,
    agent_id_filter: scope?.agentId ?? null,
    client_code_filter: clientCode ?? null,
    client_code_strict: scope?.strictClientCode ?? false,
    result_limit: 20,
  });

  if (error) throw new Error(`Failed to search learnings: ${error.message}`);
  return (data ?? []) as Learning[];
}

export async function findDuplicateLearning(
  agentId: string,
  category: string,
  content: string,
  clientCode: string | null,
): Promise<Learning | undefined> {
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
    const supabase = getDaiSupabase();

    const { data } = await supabase.rpc("find_similar_learnings", {
      query_text: keywords,
      agent_id_filter: agentId,
      category_filter: category,
      result_limit: 5,
    });

    if (!data || data.length === 0) return undefined;

    // Check if any result is for the same client_code
    for (const row of data as Learning[]) {
      if ((row.client_code ?? null) === clientCode) {
        return row;
      }
    }
  } catch {
    // FTS query can fail on certain inputs — not critical
  }

  return undefined;
}

export async function incrementApplied(id: string): Promise<void> {
  const supabase = getDaiSupabase();

  const { error } = await supabase.rpc("increment_applied", {
    learning_id: id,
  });

  if (error) throw new Error(`Failed to increment applied: ${error.message}`);
}

export async function updateLearningConfidence(id: string, confidence: number): Promise<void> {
  const supabase = getDaiSupabase();

  const { error } = await supabase
    .from("learnings")
    .update({ confidence })
    .eq("id", id);

  if (error) throw new Error(`Failed to update learning confidence: ${error.message}`);
}

export async function deleteLearning(id: string): Promise<void> {
  const supabase = getDaiSupabase();

  const { error } = await supabase
    .from("learnings")
    .delete()
    .eq("id", id);

  if (error) throw new Error(`Failed to delete learning: ${error.message}`);
}

export async function getTopLearnings(agentId: string, limit = 10): Promise<Learning[]> {
  const supabase = getDaiSupabase();

  const { data, error } = await supabase
    .from("learnings")
    .select()
    .eq("agent_id", agentId)
    .order("score", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) throw new Error(`Failed to get top learnings: ${error.message}`);
  return (data ?? []) as Learning[];
}
