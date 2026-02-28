import { nanoid } from "nanoid";
import { getDaiSupabase } from "../integrations/dai-supabase.js";

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

export async function addObservation(params: AddObservationParams): Promise<Observation> {
  const supabase = getDaiSupabase();
  const id = nanoid();

  const { data, error } = await supabase
    .from("observations")
    .insert({
      id,
      session_id: params.session_id,
      tool_name: params.tool_name,
      input_summary: params.input_summary ?? null,
      output_summary: params.output_summary ?? null,
      importance: params.importance ?? 5,
      tags: params.tags ? JSON.stringify(params.tags) : null,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to add observation: ${error.message}`);
  return data as Observation;
}

export async function getObservations(sessionId: string): Promise<Observation[]> {
  const supabase = getDaiSupabase();

  const { data, error } = await supabase
    .from("observations")
    .select()
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Failed to get observations: ${error.message}`);
  return (data ?? []) as Observation[];
}

export async function searchObservations(query: string): Promise<Observation[]> {
  const supabase = getDaiSupabase();

  const { data, error } = await supabase.rpc("search_observations", {
    query_text: query,
    agent_id_filter: null,
    result_limit: 10,
  });

  if (error) throw new Error(`Failed to search observations: ${error.message}`);
  return (data ?? []) as Observation[];
}
