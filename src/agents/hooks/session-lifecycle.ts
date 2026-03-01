import { logger } from "../../utils/logger.js";
import { getQuickContext } from "../../memory/search.js";
import { getLearnings, getTopLearnings } from "../../memory/learnings.js";
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

    // Jasmin-specific: inject preference summary and extra preferences
    if (params.agentId === "jasmin") {
      const jasminContext = await buildJasminPreferenceContext();
      if (jasminContext) {
        lines.push(jasminContext);
      }
    }

    // Last session summary
    if (ctx.lastSessionSummary) {
      lines.push(`<last_session_summary>${ctx.lastSessionSummary}</last_session_summary>`);
    }

    // Top learnings for this agent (15 for Jasmin, default 5 for others)
    const topCount = params.agentId === "jasmin" ? 15 : 5;
    const topLearnings =
      topCount !== 5
        ? await getTopLearnings(params.agentId, topCount)
        : ctx.topLearnings;

    if (topLearnings.length > 0) {
      lines.push("<top_learnings>");
      for (const learning of topLearnings) {
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
        learningsCount: topLearnings.length,
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

/**
 * Build Jasmin's preference context block from learned preferences.
 * Returns the <daniels_preferences> XML block, or null if no preferences exist.
 */
export async function buildJasminPreferenceContext(): Promise<string | null> {
  try {
    // Fetch the preference summary (synthesized weekly)
    const summaries = await getLearnings("jasmin", "preference_summary", 1);
    const summary = summaries[0]?.content;

    // Fetch confirmed preferences (confidence >= 0.7) across all preference categories
    const allPrefs = await getLearnings("jasmin", undefined, 50);
    const confirmed = allPrefs.filter(
      (l) =>
        l.category.startsWith("preference_") &&
        l.category !== "preference_summary" &&
        l.confidence >= 0.7,
    );

    if (!summary && confirmed.length === 0) return null;

    const parts: string[] = ["<daniels_preferences>"];

    if (summary) {
      parts.push(summary);
    }

    if (confirmed.length > 0) {
      parts.push("");
      parts.push("Confirmed preferences:");
      for (const pref of confirmed) {
        parts.push(`- ${pref.content} (${pref.category.replace("preference_", "")})`);
      }
    }

    parts.push("</daniels_preferences>");
    return parts.join("\n");
  } catch (err) {
    logger.error({ err }, "Failed to build Jasmin preference context");
    return null;
  }
}
