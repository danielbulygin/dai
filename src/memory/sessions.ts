import { nanoid } from "nanoid";
import { getDaiSupabase } from "../integrations/dai-supabase.js";

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

export async function createSession(params: CreateSessionParams): Promise<Session> {
  const supabase = getDaiSupabase();
  const id = nanoid();

  const { data, error } = await supabase
    .from("sessions")
    .insert({
      id,
      agent_id: params.agent_id,
      channel_id: params.channel_id,
      thread_ts: params.thread_ts ?? null,
      user_id: params.user_id,
      claude_session_id: params.claude_session_id ?? null,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create session: ${error.message}`);
  return data as Session;
}

export async function getSession(id: string): Promise<Session | undefined> {
  const supabase = getDaiSupabase();

  const { data, error } = await supabase
    .from("sessions")
    .select()
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`Failed to get session: ${error.message}`);
  return (data as Session) ?? undefined;
}

export async function findSession(
  channelId: string,
  threadTs: string | null,
  agentId: string,
): Promise<Session | undefined> {
  const supabase = getDaiSupabase();

  let query = supabase
    .from("sessions")
    .select()
    .eq("channel_id", channelId)
    .eq("agent_id", agentId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1);

  if (threadTs) {
    query = query.eq("thread_ts", threadTs);
  } else {
    query = query.is("thread_ts", null);
  }

  const { data, error } = await query.maybeSingle();

  if (error) throw new Error(`Failed to find session: ${error.message}`);
  return (data as Session) ?? undefined;
}

export async function updateSession(id: string, updates: UpdateSessionParams): Promise<void> {
  const fields: Record<string, unknown> = {};

  if (updates.claude_session_id !== undefined) fields.claude_session_id = updates.claude_session_id;
  if (updates.summary !== undefined) fields.summary = updates.summary;
  if (updates.total_cost !== undefined) fields.total_cost = updates.total_cost;
  if (updates.total_turns !== undefined) fields.total_turns = updates.total_turns;
  if (updates.status !== undefined) fields.status = updates.status;

  if (Object.keys(fields).length === 0) return;

  const supabase = getDaiSupabase();
  const { error } = await supabase
    .from("sessions")
    .update(fields)
    .eq("id", id);

  if (error) throw new Error(`Failed to update session: ${error.message}`);
}

export async function endSession(id: string, summary?: string): Promise<void> {
  const supabase = getDaiSupabase();
  const fields: Record<string, unknown> = { status: "ended" };
  if (summary) fields.summary = summary;

  const { error } = await supabase
    .from("sessions")
    .update(fields)
    .eq("id", id);

  if (error) throw new Error(`Failed to end session: ${error.message}`);
}

export async function findRecentSessionForChannel(
  channelId: string,
  threadTs?: string | null,
): Promise<Session | undefined> {
  const supabase = getDaiSupabase();

  if (threadTs) {
    const { data } = await supabase
      .from("sessions")
      .select()
      .eq("channel_id", channelId)
      .eq("thread_ts", threadTs)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data) return data as Session;
  }

  const { data } = await supabase
    .from("sessions")
    .select()
    .eq("channel_id", channelId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (data as Session) ?? undefined;
}

export async function findThreadOwner(
  channelId: string,
  threadTs: string,
): Promise<string | undefined> {
  const supabase = getDaiSupabase();

  const { data } = await supabase
    .from("sessions")
    .select("agent_id")
    .eq("channel_id", channelId)
    .eq("thread_ts", threadTs)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (data as { agent_id: string } | null)?.agent_id ?? undefined;
}

export async function getRecentSessions(agentId: string, limit = 10): Promise<Session[]> {
  const supabase = getDaiSupabase();

  const { data, error } = await supabase
    .from("sessions")
    .select()
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to get recent sessions: ${error.message}`);
  return (data ?? []) as Session[];
}
