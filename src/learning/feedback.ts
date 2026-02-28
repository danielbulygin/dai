import { logger } from "../utils/logger.js";
import {
  getUnprocessedFeedback,
  markProcessed,
} from "../memory/feedback.js";
import { getSession } from "../memory/sessions.js";
import { addLearning } from "../memory/learnings.js";
import type { Feedback } from "../memory/feedback.js";

/**
 * Process a single feedback record into a learning.
 *
 * For negative feedback: creates a self_reflection learning describing what
 * may have gone wrong.
 * For positive feedback: creates a learning noting what worked well.
 */
export async function processFeedback(feedbackId: string): Promise<void> {
  const allFeedback = await getUnprocessedFeedback(1000);
  const feedback = allFeedback.find((f) => f.id === feedbackId);

  if (!feedback) {
    logger.warn({ feedbackId }, "Feedback not found or already processed");
    return;
  }

  const session = feedback.session_id
    ? await getSession(feedback.session_id)
    : undefined;

  const sessionContext = session
    ? `during session ${session.id} (agent: ${session.agent_id}, channel: ${session.channel_id})`
    : "outside of a tracked session";

  try {
    if (isNegativeSentiment(feedback)) {
      const content = buildNegativeLearning(feedback, sessionContext);

      await addLearning({
        agent_id: feedback.agent_id,
        category: "self_reflection",
        content,
        confidence: 0.3,
        source_session_id: feedback.session_id ?? undefined,
      });

      logger.info(
        { feedbackId, agent_id: feedback.agent_id },
        "Created self-reflection learning from negative feedback",
      );
    } else {
      const content = buildPositiveLearning(feedback, sessionContext);

      await addLearning({
        agent_id: feedback.agent_id,
        category: "positive_signal",
        content,
        confidence: 0.6,
        source_session_id: feedback.session_id ?? undefined,
      });

      logger.info(
        { feedbackId, agent_id: feedback.agent_id },
        "Created positive learning from feedback",
      );
    }

    await markProcessed(feedbackId);
  } catch (error) {
    logger.error(
      { error, feedbackId },
      "Failed to process feedback into learning",
    );
    throw error;
  }
}

/**
 * Process all pending feedback records.
 * Returns the count of successfully processed items.
 */
export async function processAllPendingFeedback(): Promise<number> {
  const pending = await getUnprocessedFeedback();
  let processed = 0;

  for (const feedback of pending) {
    try {
      await processFeedback(feedback.id);
      processed++;
    } catch (error) {
      logger.error(
        { error, feedbackId: feedback.id },
        "Failed to process feedback, continuing with next",
      );
    }
  }

  if (processed > 0) {
    logger.info({ processed, total: pending.length }, "Feedback processing complete");
  }

  return processed;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isNegativeSentiment(feedback: Feedback): boolean {
  return ["negative", "confused", "frustrated"].includes(feedback.sentiment);
}

function buildNegativeLearning(
  feedback: Feedback,
  sessionContext: string,
): string {
  const parts: string[] = [];

  parts.push(
    `Received negative feedback (${feedback.sentiment}) ${sessionContext}.`,
  );

  if (feedback.content) {
    parts.push(`User feedback: "${feedback.content}"`);
  }

  parts.push(`Feedback type: ${feedback.type}.`);
  parts.push(
    "Consider: Was the response too long/short? " +
      "Did it misunderstand the request? Was the tone appropriate?",
  );

  return parts.join(" ");
}

function buildPositiveLearning(
  feedback: Feedback,
  sessionContext: string,
): string {
  const parts: string[] = [];

  parts.push(
    `Received positive feedback (${feedback.sentiment}) ${sessionContext}.`,
  );

  if (feedback.content) {
    parts.push(`User feedback: "${feedback.content}"`);
  }

  parts.push(`Feedback type: ${feedback.type}.`);
  parts.push("This approach or response style worked well.");

  return parts.join(" ");
}
