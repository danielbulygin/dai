/**
 * Channel monitoring listener for passive message tracking.
 *
 * Requires Slack app scopes: channels:history
 * Requires event subscription: message.channels
 *
 * This listener watches public channels for messages relevant to Daniel
 * (the owner) — direct mentions, blocker keywords, urgency signals — and
 * buffers them in SQLite for periodic batch analysis by Jasmin.
 */

import type { App } from "@slack/bolt";
import { bufferMessage } from "../../monitoring/buffer.js";
import { env } from "../../env.js";
import { logger } from "../../utils/logger.js";

const RELEVANCE_KEYWORDS = [
  "blocked",
  "waiting on",
  "waiting for",
  "need from",
  "urgent",
  "asap",
  "priority",
  "deadline",
  "overdue",
  "help",
  "stuck",
  "blocker",
  "critical",
  "escalate",
];

const HIGH_PRIORITY_KEYWORDS = ["urgent", "critical", "asap", "blocker"];

function extractMatchedKeywords(text: string, ownerUserId: string): string[] {
  const lower = text.toLowerCase();
  const matched: string[] = [];

  // Check for direct mention of the owner
  if (text.includes(`<@${ownerUserId}>`)) {
    matched.push("@owner-mention");
  }

  // Check for @here and @channel
  if (text.includes("<!here>") || text.includes("<!here|here>")) {
    matched.push("@here");
  }
  if (text.includes("<!channel>") || text.includes("<!channel|channel>")) {
    matched.push("@channel");
  }

  // Check relevance keywords
  for (const keyword of RELEVANCE_KEYWORDS) {
    if (lower.includes(keyword)) {
      matched.push(keyword);
    }
  }

  return matched;
}

function determinePriority(
  matchedKeywords: string[],
): "high" | "normal" {
  // High priority if owner is directly mentioned
  if (matchedKeywords.includes("@owner-mention")) {
    return "high";
  }

  // High priority if any high-priority keyword is matched
  for (const keyword of HIGH_PRIORITY_KEYWORDS) {
    if (matchedKeywords.includes(keyword)) {
      return "high";
    }
  }

  return "normal";
}

export function registerChannelMonitor(app: App): void {
  // Listen to all messages in public channels
  // The app must be added to channels it should monitor
  app.message(async ({ message }) => {
    // Cast to a loose record to access dynamic properties safely.
    // Slack Bolt's message union types are very complex and checking
    // subtype narrows the type to never, so we use an escape hatch here
    // (same pattern as the existing messages.ts listener).
    const msg = message as unknown as Record<string, unknown>;

    // Only process messages from public channels
    if (msg.channel_type !== "channel") return;

    // Skip bot messages to avoid monitoring our own output
    if (msg.bot_id) return;
    if (msg.subtype) return;

    const text = typeof msg.text === "string" ? msg.text : undefined;
    const userId = typeof msg.user === "string" ? msg.user : undefined;
    const messageTs = typeof msg.ts === "string" ? msg.ts : undefined;
    const threadTs = typeof msg.thread_ts === "string" ? msg.thread_ts : undefined;
    const channel = typeof msg.channel === "string" ? msg.channel : undefined;

    if (!text || !userId || !messageTs || !channel) return;

    // Skip messages from the owner themselves — we only care about what
    // others say that might affect or reference the owner
    if (userId === env.SLACK_OWNER_USER_ID) return;

    // Keyword pre-filter: only buffer relevant messages
    const matchedKeywords = extractMatchedKeywords(text, env.SLACK_OWNER_USER_ID);
    if (matchedKeywords.length === 0) return;

    const priority = determinePriority(matchedKeywords);

    try {
      bufferMessage({
        channel_id: channel,
        user_id: userId,
        message_ts: messageTs,
        thread_ts: threadTs ?? null,
        text,
        matched_keywords: matchedKeywords.join(", "),
        priority,
      });

      logger.debug(
        {
          channel,
          user: userId,
          keywords: matchedKeywords,
          priority,
        },
        "Channel monitor buffered message",
      );
    } catch (err) {
      logger.error(
        { err, channel, message_ts: messageTs },
        "Failed to buffer monitored message",
      );
    }
  });

  logger.info("Channel monitor listener registered");
}
