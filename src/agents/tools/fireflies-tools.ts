import { getDaiSupabase } from "../../integrations/dai-supabase.js";
import { logger } from "../../utils/logger.js";

export async function searchMeetings(params: {
  query: string;
  fromDate?: string;
  toDate?: string;
  speaker?: string;
  limit?: number;
}): Promise<string> {
  try {
    const limit = params.limit ?? 20;
    logger.debug({ query: params.query, limit }, "Searching meetings");
    const supabase = getDaiSupabase();

    const { data, error } = await supabase.rpc("search_meetings", {
      search_query: params.query,
      from_date: params.fromDate ?? null,
      to_date: params.toDate ?? null,
      speaker_filter: params.speaker ?? null,
      result_limit: limit,
    });

    if (error) {
      logger.error({ error }, "Failed to search meetings");
      return JSON.stringify({ error: error.message });
    }

    logger.debug({ count: data?.length }, "Meeting search results");
    return JSON.stringify(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "searchMeetings failed");
    return JSON.stringify({ error: msg });
  }
}

export async function getMeetingSummary(params: {
  meetingId: string;
}): Promise<string> {
  try {
    logger.debug({ meetingId: params.meetingId }, "Getting meeting summary");
    const supabase = getDaiSupabase();

    const { data, error } = await supabase
      .from("meetings")
      .select(
        "id, title, date, duration, organizer_email, speakers, participant_emails, short_summary, keywords, action_items, overview, notes, gist",
      )
      .eq("id", params.meetingId)
      .single();

    if (error) {
      logger.error({ error }, "Failed to get meeting summary");
      return JSON.stringify({ error: error.message });
    }

    logger.debug({ meetingId: params.meetingId }, "Got meeting summary");
    return JSON.stringify(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "getMeetingSummary failed");
    return JSON.stringify({ error: msg });
  }
}

export async function getMeetingTranscript(params: {
  meetingId: string;
  speaker?: string;
}): Promise<string> {
  try {
    logger.debug(
      { meetingId: params.meetingId, speaker: params.speaker },
      "Getting meeting transcript",
    );
    const supabase = getDaiSupabase();

    let query = supabase
      .from("meeting_sentences")
      .select("sentence_index, speaker_name, text, start_time, end_time")
      .eq("meeting_id", params.meetingId)
      .order("sentence_index", { ascending: true });

    if (params.speaker) {
      query = query.ilike("speaker_name", `%${params.speaker}%`);
    }

    const { data, error } = await query;

    if (error) {
      logger.error({ error }, "Failed to get meeting transcript");
      return JSON.stringify({ error: error.message });
    }

    logger.debug(
      { meetingId: params.meetingId, sentences: data?.length },
      "Got meeting transcript",
    );
    return JSON.stringify(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "getMeetingTranscript failed");
    return JSON.stringify({ error: msg });
  }
}

export async function listRecentMeetings(params: {
  days?: number;
  limit?: number;
  speaker?: string;
}): Promise<string> {
  try {
    const days = params.days ?? 7;
    const limit = params.limit ?? 20;
    const since = new Date();
    since.setDate(since.getDate() - days);

    logger.debug({ days, limit, speaker: params.speaker }, "Listing recent meetings");
    const supabase = getDaiSupabase();

    let query = supabase
      .from("meetings")
      .select(
        "id, title, date, duration, organizer_email, speakers, short_summary, keywords",
      )
      .gte("date", since.toISOString())
      .order("date", { ascending: false })
      .limit(limit);

    const { data, error } = await query;

    if (error) {
      logger.error({ error }, "Failed to list recent meetings");
      return JSON.stringify({ error: error.message });
    }

    // Filter by speaker client-side for case-insensitive partial matching
    // e.g. "Kousha" matches "Kousha Torabi"
    let results = data ?? [];
    if (params.speaker) {
      const needle = params.speaker.toLowerCase();
      results = results.filter((m: { speakers?: string[] }) =>
        m.speakers?.some((s) => s.toLowerCase().includes(needle)),
      );
    }

    logger.debug({ count: results.length }, "Listed recent meetings");
    return JSON.stringify(results);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "listRecentMeetings failed");
    return JSON.stringify({ error: msg });
  }
}
