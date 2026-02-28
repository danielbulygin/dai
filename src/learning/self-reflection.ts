import { logger } from "../utils/logger.js";
import { getSession } from "../memory/sessions.js";
import { getObservations } from "../memory/observations.js";
import { getFeedbackForSession } from "../memory/feedback.js";
import { addLearning } from "../memory/learnings.js";
import type { Observation } from "../memory/observations.js";
import type { Feedback } from "../memory/feedback.js";

/**
 * Generate a self-reflection for a completed session by analyzing patterns
 * in observations and feedback. This is a simplified version that does NOT
 * call Claude -- it uses heuristic pattern matching.
 *
 * Returns the reflection text, or null if nothing notable was found.
 */
export async function generateSelfReflection(
  sessionId: string,
): Promise<string | null> {
  const session = await getSession(sessionId);
  if (!session) {
    logger.warn({ sessionId }, "Session not found for self-reflection");
    return null;
  }

  const observations = await getObservations(sessionId);
  const feedback = await getFeedbackForSession(sessionId);

  const issues = detectIssues(observations, feedback, session.total_turns);

  if (issues.length === 0) {
    logger.debug(
      { sessionId },
      "No notable issues found for self-reflection",
    );
    return null;
  }

  const reflection = buildReflection(session.agent_id, sessionId, issues);

  // Persist the reflection as a learning
  await addLearning({
    agent_id: session.agent_id,
    category: "self_reflection",
    content: reflection,
    confidence: 0.4,
    source_session_id: sessionId,
  });

  logger.info(
    { sessionId, issueCount: issues.length },
    "Generated self-reflection for session",
  );

  return reflection;
}

// ---------------------------------------------------------------------------
// Pattern detection
// ---------------------------------------------------------------------------

interface Issue {
  type: string;
  detail: string;
}

function detectIssues(
  observations: Observation[],
  feedback: Feedback[],
  totalTurns: number,
): Issue[] {
  const issues: Issue[] = [];

  // High turn count may indicate difficulty or confusion
  if (totalTurns > 10) {
    issues.push({
      type: "high_turns",
      detail: `Session took ${totalTurns} turns, which may indicate difficulty completing the task.`,
    });
  }

  // Repeated tool calls of the same type may indicate retries
  const toolCounts = new Map<string, number>();
  for (const obs of observations) {
    const current = toolCounts.get(obs.tool_name) ?? 0;
    toolCounts.set(obs.tool_name, current + 1);
  }

  for (const [tool, count] of toolCounts) {
    if (count >= 5) {
      issues.push({
        type: "tool_retry",
        detail: `Tool "${tool}" was called ${count} times, suggesting possible retries or difficulty.`,
      });
    }
  }

  // Error patterns in observations
  const errorObservations = observations.filter(
    (o) =>
      o.output_summary?.toLowerCase().includes("error") ||
      o.output_summary?.toLowerCase().includes("failed") ||
      o.output_summary?.toLowerCase().includes("exception"),
  );

  if (errorObservations.length > 0) {
    issues.push({
      type: "errors",
      detail: `${errorObservations.length} observation(s) contained error indicators.`,
    });
  }

  // Negative feedback
  const negativeFeedback = feedback.filter((f) =>
    ["negative", "confused", "frustrated"].includes(f.sentiment),
  );

  if (negativeFeedback.length > 0) {
    issues.push({
      type: "negative_feedback",
      detail: `Received ${negativeFeedback.length} negative feedback signal(s) during the session.`,
    });
  }

  // Low-importance observations dominating (possible noise)
  const lowImportance = observations.filter((o) => o.importance <= 2);
  if (
    observations.length > 5 &&
    lowImportance.length > observations.length * 0.7
  ) {
    issues.push({
      type: "low_signal",
      detail: "Most observations were low-importance, suggesting the session may have lacked focus.",
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Reflection builder
// ---------------------------------------------------------------------------

function buildReflection(
  agentId: string,
  sessionId: string,
  issues: Issue[],
): string {
  const lines: string[] = [];

  lines.push(
    `Self-reflection for agent "${agentId}" after session ${sessionId}:`,
  );

  for (const issue of issues) {
    lines.push(`- [${issue.type}] ${issue.detail}`);
  }

  if (issues.some((i) => i.type === "high_turns" || i.type === "tool_retry")) {
    lines.push(
      "Action: Consider breaking complex tasks into smaller steps or asking clarifying questions earlier.",
    );
  }

  if (issues.some((i) => i.type === "errors")) {
    lines.push(
      "Action: Review error handling and consider validating inputs before tool calls.",
    );
  }

  if (issues.some((i) => i.type === "negative_feedback")) {
    lines.push(
      "Action: Review the interaction style and ensure responses match user expectations.",
    );
  }

  return lines.join("\n");
}
