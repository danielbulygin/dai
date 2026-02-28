import { nanoid } from "nanoid";
import { getDaiSupabase } from "../integrations/dai-supabase.js";

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

export async function addFeedback(params: AddFeedbackParams): Promise<Feedback> {
  const supabase = getDaiSupabase();
  const id = nanoid();

  const { data, error } = await supabase
    .from("feedback")
    .insert({
      id,
      session_id: params.session_id ?? null,
      agent_id: params.agent_id,
      user_id: params.user_id,
      type: params.type,
      sentiment: params.sentiment,
      content: params.content ?? null,
      message_ts: params.message_ts ?? null,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to add feedback: ${error.message}`);
  return data as Feedback;
}

export async function getUnprocessedFeedback(limit = 50): Promise<Feedback[]> {
  const supabase = getDaiSupabase();

  const { data, error } = await supabase
    .from("feedback")
    .select()
    .eq("processed", 0)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(`Failed to get unprocessed feedback: ${error.message}`);
  return (data ?? []) as Feedback[];
}

export async function markProcessed(id: string): Promise<void> {
  const supabase = getDaiSupabase();

  const { error } = await supabase
    .from("feedback")
    .update({ processed: 1 })
    .eq("id", id);

  if (error) throw new Error(`Failed to mark feedback processed: ${error.message}`);
}

export async function getFeedbackForSession(sessionId: string): Promise<Feedback[]> {
  const supabase = getDaiSupabase();

  const { data, error } = await supabase
    .from("feedback")
    .select()
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`Failed to get feedback for session: ${error.message}`);
  return (data ?? []) as Feedback[];
}
