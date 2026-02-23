import { logger } from "../../utils/logger.js";
import { analyzeBufferedMessages } from "../../monitoring/analyzer.js";
import { getRecentMessages } from "../../monitoring/buffer.js";
import { getDaiSupabase } from "../../integrations/dai-supabase.js";
import { env } from "../../env.js";

export async function getChannelInsights(): Promise<{
  analysis: {
    blockers: string[];
    urgent: string[];
    notable: string[];
    suggestedActions: string[];
    messageCount: number;
  } | null;
  message: string;
}> {
  try {
    const result = await analyzeBufferedMessages();

    if (!result) {
      return {
        analysis: null,
        message: "No unanalyzed messages in the monitoring buffer.",
      };
    }

    logger.debug(
      { messageCount: result.messageCount },
      "On-demand channel insights generated",
    );

    return {
      analysis: result,
      message: `Analyzed ${result.messageCount} messages. Found ${result.blockers.length} blockers, ${result.urgent.length} urgent items, ${result.notable.length} notable updates.`,
    };
  } catch (error) {
    logger.error({ error }, "Failed to get channel insights");
    return {
      analysis: null,
      message: "Failed to analyze buffered messages.",
    };
  }
}

export async function getRecentMentions(params?: {
  hours?: number;
}): Promise<{
  mentions: Array<{
    channel_id: string;
    user_id: string;
    text: string;
    matched_keywords: string | null;
    priority: string;
    created_at: string;
  }>;
  count: number;
}> {
  try {
    const hours = params?.hours ?? 24;
    const messages = getRecentMessages(hours);

    // Filter to only messages that mention Daniel or are high priority
    const ownerMentionPattern = `<@${env.SLACK_OWNER_USER_ID}>`;
    const relevant = messages.filter(
      (m) =>
        m.priority === "high" ||
        m.text.includes(ownerMentionPattern) ||
        (m.matched_keywords?.includes("@owner-mention") ?? false),
    );

    const mentions = relevant.map((m) => ({
      channel_id: m.channel_id,
      user_id: m.user_id,
      text: m.text,
      matched_keywords: m.matched_keywords,
      priority: m.priority,
      created_at: m.created_at,
    }));

    logger.debug(
      { hours, total: messages.length, relevant: mentions.length },
      "Retrieved recent mentions",
    );

    return {
      mentions,
      count: mentions.length,
    };
  } catch (error) {
    logger.error({ error }, "Failed to get recent mentions");
    return { mentions: [], count: 0 };
  }
}

export async function getMonitoringHistory(params?: {
  hours?: number;
  highPriorityOnly?: boolean;
  limit?: number;
}): Promise<string> {
  try {
    const hours = params?.hours ?? 24;
    const highPriorityOnly = params?.highPriorityOnly ?? false;
    const limit = params?.limit ?? 10;

    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    logger.debug(
      { hours, highPriorityOnly, limit },
      "Querying monitoring history from Supabase",
    );

    const supabase = getDaiSupabase();

    let query = supabase
      .from("monitoring_insights")
      .select(
        "id, analyzed_at, message_count, blockers, urgent, notable, suggested_actions, has_high_priority",
      )
      .gte("analyzed_at", since)
      .order("analyzed_at", { ascending: false })
      .limit(limit);

    if (highPriorityOnly) {
      query = query.eq("has_high_priority", true);
    }

    const { data, error } = await query;

    if (error) {
      logger.error({ error }, "Failed to query monitoring history");
      return JSON.stringify({ error: error.message });
    }

    logger.debug({ count: data?.length }, "Got monitoring history");
    return JSON.stringify(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "getMonitoringHistory failed");
    return JSON.stringify({ error: msg });
  }
}

export async function generateBriefing(params?: {
  type?: "morning" | "eod";
}): Promise<string> {
  try {
    const type = params?.type ?? "morning";
    logger.info({ type }, "Generating on-demand briefing");

    const { generateMorningBriefing, generateEodBriefing } = await import(
      "../../scheduler/briefings.js"
    );

    if (type === "eod") {
      return await generateEodBriefing();
    }
    return await generateMorningBriefing();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "Failed to generate on-demand briefing");
    return `Failed to generate briefing: ${msg}`;
  }
}
