import { getDaiSupabase } from "../integrations/dai-supabase.js";
import { logger } from "../utils/logger.js";

export interface MonitoredMessage {
  id: number;
  channel_id: string;
  channel_name: string | null;
  user_id: string;
  user_name: string | null;
  message_ts: string;
  thread_ts: string | null;
  text: string;
  matched_keywords: string | null;
  priority: string;
  analyzed: number;
  created_at: string;
}

export interface BufferMessageParams {
  channel_id: string;
  channel_name?: string | null;
  user_id: string;
  user_name?: string | null;
  message_ts: string;
  thread_ts?: string | null;
  text: string;
  matched_keywords?: string | null;
  priority?: string;
}

export async function bufferMessage(params: BufferMessageParams): Promise<void> {
  const supabase = getDaiSupabase();

  const { error } = await supabase
    .from("channel_monitor")
    .upsert(
      {
        channel_id: params.channel_id,
        channel_name: params.channel_name ?? null,
        user_id: params.user_id,
        user_name: params.user_name ?? null,
        message_ts: params.message_ts,
        thread_ts: params.thread_ts ?? null,
        text: params.text,
        matched_keywords: params.matched_keywords ?? null,
        priority: params.priority ?? "normal",
      },
      { onConflict: "message_ts", ignoreDuplicates: true },
    );

  if (error) {
    logger.warn({ error, message_ts: params.message_ts }, "Failed to buffer message");
    return;
  }

  logger.debug(
    { channel_id: params.channel_id, message_ts: params.message_ts, priority: params.priority },
    "Buffered monitored message",
  );
}

export async function getUnanalyzedMessages(limit = 100): Promise<MonitoredMessage[]> {
  const supabase = getDaiSupabase();

  const { data, error } = await supabase
    .from("channel_monitor")
    .select()
    .eq("analyzed", 0)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(`Failed to get unanalyzed messages: ${error.message}`);
  return (data ?? []) as MonitoredMessage[];
}

export async function markAnalyzed(ids: number[]): Promise<void> {
  if (ids.length === 0) return;

  const supabase = getDaiSupabase();

  const { error } = await supabase
    .from("channel_monitor")
    .update({ analyzed: 1 })
    .in("id", ids);

  if (error) throw new Error(`Failed to mark messages as analyzed: ${error.message}`);

  logger.debug({ count: ids.length }, "Marked messages as analyzed");
}

export async function getRecentMessages(
  hours = 24,
  channelId?: string,
): Promise<MonitoredMessage[]> {
  const supabase = getDaiSupabase();
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  let query = supabase
    .from("channel_monitor")
    .select()
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false });

  if (channelId) {
    query = query.eq("channel_id", channelId);
  }

  const { data, error } = await query;

  if (error) throw new Error(`Failed to get recent messages: ${error.message}`);
  return (data ?? []) as MonitoredMessage[];
}

export async function cleanOldMessages(daysToKeep = 7): Promise<number> {
  const supabase = getDaiSupabase();
  const cutoff = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("channel_monitor")
    .delete()
    .lt("created_at", cutoff)
    .select("id");

  if (error) throw new Error(`Failed to clean old messages: ${error.message}`);

  const deleted = data?.length ?? 0;
  if (deleted > 0) {
    logger.info({ deleted, daysToKeep }, "Cleaned old monitored messages");
  }

  return deleted;
}
