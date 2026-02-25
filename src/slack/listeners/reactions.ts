import type { App } from "@slack/bolt";
import { logger } from "../../utils/logger.js";
import { addFeedback } from "../../memory/feedback.js";
import { findRecentSessionForChannel } from "../../memory/sessions.js";

/**
 * Map of Slack reaction names to feedback sentiment.
 * Positive reactions reinforce behavior; negative signal problems.
 */
const REACTION_SENTIMENT_MAP: Readonly<Record<string, string>> = {
  "+1": "positive",
  thumbsup: "positive",
  white_check_mark: "positive",
  heavy_check_mark: "positive",
  "-1": "negative",
  thumbsdown: "negative",
  x: "negative",
  thinking_face: "neutral",
};

/**
 * Register the reaction_added and reaction_removed event listeners.
 *
 * When a user reacts to a bot message with a recognized emoji, a feedback
 * record is created in the database. Un-reactions are logged but do not
 * remove existing feedback (feedback is append-only).
 */
export function registerReactionListener(app: App): void {
  app.event("reaction_added", async ({ event, client }) => {
    try {
      const reaction = event.reaction;
      const sentiment = REACTION_SENTIMENT_MAP[reaction];

      // Ignore reactions we don't track
      if (!sentiment) {
        return;
      }

      const userId = event.user;
      const itemTs = event.item.type === "message" ? event.item.ts : undefined;
      const channel = event.item.type === "message" ? event.item.channel : undefined;

      if (!itemTs || !channel) {
        return;
      }

      // Fetch the reacted-to message to confirm it's a bot message
      let isBotMsg = false;
      let messageThreadTs: string | undefined;
      try {
        const result = await client.conversations.history({
          channel,
          latest: itemTs,
          inclusive: true,
          limit: 1,
        });

        const msg = result.messages?.[0];
        if (msg && ("bot_id" in msg || msg.subtype === "bot_message")) {
          isBotMsg = true;
        }
        if (msg && "thread_ts" in msg) {
          messageThreadTs = msg.thread_ts as string;
        }
      } catch (fetchErr) {
        logger.warn(
          { err: fetchErr, channel, ts: itemTs },
          "Could not fetch reacted message; recording feedback anyway",
        );
        // If we can't verify, still record — better to have extra feedback
        isBotMsg = true;
      }

      if (!isBotMsg) {
        return;
      }

      // Resolve agent_id from the session that produced this message
      const session = findRecentSessionForChannel(channel, messageThreadTs ?? itemTs);
      const agentId = session?.agent_id ?? "unknown";

      addFeedback({
        agent_id: agentId,
        session_id: session?.id ?? undefined,
        user_id: userId,
        type: "reaction",
        sentiment,
        content: `:${reaction}:`,
        message_ts: itemTs,
      });

      logger.info(
        { user: userId, reaction, sentiment, channel, messageTs: itemTs },
        "Recorded reaction feedback",
      );
    } catch (err) {
      logger.error({ err, event }, "Error handling reaction_added event");
    }
  });

  app.event("reaction_removed", async ({ event }) => {
    try {
      const reaction = event.reaction;
      const sentiment = REACTION_SENTIMENT_MAP[reaction];

      if (!sentiment) {
        return;
      }

      const userId = event.user;
      const itemTs = event.item.type === "message" ? event.item.ts : undefined;

      logger.info(
        { user: userId, reaction, sentiment, messageTs: itemTs },
        "Reaction removed (feedback not deleted — append-only)",
      );
    } catch (err) {
      logger.error({ err, event }, "Error handling reaction_removed event");
    }
  });
}
