import { nanoid } from "nanoid";
import { getDaiSupabase } from "../integrations/dai-supabase.js";

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
  return data as Learning;
}

export async function getLearnings(
  agentId: string,
  category?: string,
  limit = 20,
  clientCode?: string | null,
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

  if (clientCode) {
    query = query.eq("client_code", clientCode);
  }

  const { data, error } = await query;

  if (error) throw new Error(`Failed to get learnings: ${error.message}`);
  return (data ?? []) as Learning[];
}

export async function searchLearnings(query: string, clientCode?: string): Promise<Learning[]> {
  const supabase = getDaiSupabase();

  const { data, error } = await supabase.rpc("search_learnings", {
    query_text: query,
    agent_id_filter: null,
    client_code_filter: clientCode ?? null,
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
