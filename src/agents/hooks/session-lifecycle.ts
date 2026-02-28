import { logger } from "../../utils/logger.js";
import { getQuickContext } from "../../memory/search.js";
import { endSession } from "../../memory/sessions.js";
import type { QuickContext } from "../../memory/search.js";

/**
 * Called when a new agent session starts.
 *
 * Retrieves quick context from memory (last session summary, top learnings,
 * user-specific learnings) and formats it as a context block that can be
 * prepended to the agent's system prompt.
 */
export async function onSessionStart(params: {
  sessionId: string;
  agentId: string;
  userId: string;
}): Promise<string> {
  try {
    const ctx: QuickContext = await getQuickContext(params.agentId, params.userId);

    const lines: string[] = [];
    lines.push("<memory_context>");

    // Last session summary
    if (ctx.lastSessionSummary) {
      lines.push(`<last_session_summary>${ctx.lastSessionSummary}</last_session_summary>`);
    }

    // Top learnings for this agent
    if (ctx.topLearnings.length > 0) {
      lines.push("<top_learnings>");
      for (const learning of ctx.topLearnings) {
        lines.push(`- ${learning.content}`);
      }
      lines.push("</top_learnings>");
    }

    // User-specific learnings
    if (ctx.userLearnings.length > 0) {
      lines.push("<user_preferences>");
      for (const learning of ctx.userLearnings) {
        lines.push(`- ${learning.content}`);
      }
      lines.push("</user_preferences>");
    }

    lines.push("</memory_context>");

    const contextBlock = lines.join("\n");

    logger.info(
      {
        sessionId: params.sessionId,
        agentId: params.agentId,
        userId: params.userId,
        learningsCount: ctx.topLearnings.length,
        userLearningsCount: ctx.userLearnings.length,
        hasLastSummary: ctx.lastSessionSummary !== null,
      },
      "Session started with memory context",
    );

    return contextBlock;
  } catch (err) {
    logger.error(
      { err, sessionId: params.sessionId, agentId: params.agentId },
      "Failed to build session start context",
    );
    return "";
  }
}

/**
 * Called when an agent session ends.
 *
 * Ends the session in the database and logs the event.
 * AI-generated summary will be added in a future iteration.
 */
export async function onSessionEnd(params: {
  sessionId: string;
  agentId: string;
}): Promise<void> {
  try {
    // TODO: Generate an AI-powered summary of the session.
    // For now, use a placeholder summary.
    const summary = "Session ended";

    await endSession(params.sessionId, summary);

    logger.info(
      { sessionId: params.sessionId, agentId: params.agentId },
      "Session ended",
    );
  } catch (err) {
    logger.error(
      { err, sessionId: params.sessionId, agentId: params.agentId },
      "Failed to end session",
    );
  }
}
