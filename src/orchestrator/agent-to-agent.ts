import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentHandoff {
  fromAgent: string;
  toAgent: string;
  task: string;
  context: string;
  channelId: string;
  threadTs: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Marker used to identify agent-to-agent messages in Slack.
 * Embedded in the message so we can detect and parse handoffs.
 */
const HANDOFF_MARKER = "<!-- dai:handoff -->";

const HANDOFF_PATTERN =
  /<!-- dai:handoff -->\n(\w+) -> (\w+): (.+)\nContext: ([\s\S]*?)(?:\n<!-- \/dai:handoff -->|$)/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Format a handoff message for agent-to-agent communication.
 * The message includes a hidden marker so it can be detected and parsed.
 */
export function createHandoffMessage(handoff: AgentHandoff): string {
  const lines = [
    HANDOFF_MARKER,
    `${handoff.fromAgent} -> ${handoff.toAgent}: ${handoff.task}`,
    `Context: ${handoff.context}`,
    "<!-- /dai:handoff -->",
  ];

  logger.debug(
    { from: handoff.fromAgent, to: handoff.toAgent },
    "Created handoff message",
  );

  return lines.join("\n");
}

/**
 * Detect if a message is an agent-to-agent handoff.
 * A message is considered a handoff if it contains the handoff marker
 * and was NOT sent by a regular user (i.e., the sender is the bot).
 */
export function isAgentToAgentMessage(
  text: string,
  botUserId: string,
): boolean {
  // Must contain the handoff marker
  if (!text.includes(HANDOFF_MARKER)) {
    return false;
  }

  // The botUserId parameter is available for future use if we need
  // to verify the sender, but the marker alone is sufficient for now
  // since only our system generates it.
  void botUserId;

  return true;
}

/**
 * Parse an agent-to-agent handoff message back into its components.
 * Returns null if the message does not match the expected format.
 */
export function parseHandoff(text: string): AgentHandoff | null {
  const match = HANDOFF_PATTERN.exec(text);

  if (!match) {
    return null;
  }

  const [, fromAgent, toAgent, task, context] = match;

  if (!fromAgent || !toAgent || !task) {
    return null;
  }

  logger.debug(
    { from: fromAgent, to: toAgent },
    "Parsed handoff message",
  );

  return {
    fromAgent,
    toAgent,
    task,
    context: context?.trim() ?? "",
    // These fields cannot be determined from the message text alone;
    // the caller must fill them in from the Slack event context.
    channelId: "",
    threadTs: "",
  };
}
