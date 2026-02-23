import { logger } from "../../utils/logger.js";
import { analyzeBufferedMessages } from "../../monitoring/analyzer.js";
import { getRecentMessages } from "../../monitoring/buffer.js";
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
