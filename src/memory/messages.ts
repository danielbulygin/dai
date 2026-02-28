import { nanoid } from "nanoid";
import { getDaiSupabase } from "../integrations/dai-supabase.js";

export interface ChatMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface AddMessageParams {
  session_id: string;
  role: "user" | "assistant";
  content: string;
}

export async function addMessage(params: AddMessageParams): Promise<ChatMessage> {
  const supabase = getDaiSupabase();
  const id = nanoid();

  const { data, error } = await supabase
    .from("messages")
    .insert({
      id,
      session_id: params.session_id,
      role: params.role,
      content: params.content,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to add message: ${error.message}`);
  return data as ChatMessage;
}

export async function getMessages(sessionId: string, limit = 20): Promise<ChatMessage[]> {
  const supabase = getDaiSupabase();

  // Fetch the most recent N messages, then return them in chronological order
  const { data, error } = await supabase
    .from("messages")
    .select()
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to get messages: ${error.message}`);

  // Reverse to get chronological order (oldest first)
  return ((data ?? []) as ChatMessage[]).reverse();
}
