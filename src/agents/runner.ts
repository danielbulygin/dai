import { query, type Message } from "@anthropic-ai/claude-code";
import { getAgent, getDefaultAgent } from "./registry.js";
import { toolProfiles } from "./profiles/index.js";
import {
  createSession,
  findSession,
  updateSession,
} from "../memory/sessions.js";
import { getQuickContext } from "../memory/search.js";
import { logger } from "../utils/logger.js";
import type { Session } from "../memory/sessions.js";
import type { QuickContext } from "../memory/search.js";

export interface RunOptions {
  agentId: string;
  userMessage: string;
  userId: string;
  channelId: string;
  threadTs?: string;
  sessionId?: string;
  onText?: (text: string) => void;
}

export interface RunResult {
  sessionId: string;
  response: string;
  turns: number;
}

/**
 * Build a system prompt from the agent's persona, instructions, and
 * memory context.  Keeps it compact so we stay within token budgets.
 */
function buildSystemPrompt(
  persona: string,
  instructions: string,
  context: QuickContext,
): string {
  const parts: string[] = [];

  parts.push(persona);
  parts.push(instructions);

  // Layer 1 quick-context injection
  if (context.lastSessionSummary) {
    parts.push(`## Previous Session\n${context.lastSessionSummary}`);
  }

  if (context.topLearnings.length > 0) {
    const items = context.topLearnings
      .map((l) => `- ${l.content}`)
      .join("\n");
    parts.push(`## Key Learnings\n${items}`);
  }

  if (context.userLearnings.length > 0) {
    const items = context.userLearnings
      .map((l) => `- ${l.content}`)
      .join("\n");
    parts.push(`## User Preferences\n${items}`);
  }

  return parts.join("\n\n");
}

/**
 * Resolve or create the session that this run should use.
 */
function resolveSession(
  agentId: string,
  channelId: string,
  userId: string,
  threadTs?: string,
  existingSessionId?: string,
): Session {
  // If a specific sessionId was provided, look it up first
  if (existingSessionId) {
    const existing = findSession(channelId, threadTs ?? null, agentId);
    if (existing && existing.id === existingSessionId) {
      return existing;
    }
  }

  // Try to find an active session for the same channel+thread+agent
  const found = findSession(channelId, threadTs ?? null, agentId);
  if (found) {
    return found;
  }

  // Create a new session
  return createSession({
    agent_id: agentId,
    channel_id: channelId,
    thread_ts: threadTs ?? null,
    user_id: userId,
  });
}

/**
 * Extract text content from a message's content field.
 * The content can be either a plain string or an array of content blocks.
 */
function extractText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text!)
    .join("");
}

/**
 * Execute an agent using the Claude Code SDK.
 *
 * Looks up the agent definition, builds a system prompt with memory context,
 * calls `query()`, streams text chunks via the optional callback, and
 * persists the session in the database.
 */
export async function runAgent(options: RunOptions): Promise<RunResult> {
  const {
    agentId,
    userMessage,
    userId,
    channelId,
    threadTs,
    sessionId,
    onText,
  } = options;

  // Resolve agent definition
  const agent = getAgent(agentId) ?? getDefaultAgent();
  const agentLabel = agent.config.display_name;

  logger.info(
    { agentId: agent.config.id, channelId, threadTs, userId },
    `Running agent ${agentLabel}`,
  );

  // Resolve or create session
  const session = resolveSession(
    agent.config.id,
    channelId,
    userId,
    threadTs,
    sessionId,
  );

  // Build system prompt with memory context
  const context = getQuickContext(agent.config.id, userId);
  const systemPrompt = buildSystemPrompt(
    agent.persona,
    agent.instructions,
    context,
  );

  // Determine allowed tools from the agent's profile
  const allowedTools: string[] = [
    ...toolProfiles[agent.config.profile],
  ];

  // Prepare messages
  const messages: Message[] = [
    { role: "user", content: userMessage },
  ];

  // Run the agent
  const abortController = new AbortController();
  let responseText = "";
  let turns = 0;

  try {
    const stream = query({
      prompt: messages,
      systemPrompt,
      options: {
        maxTurns: agent.config.max_turns,
        allowedTools,
      },
      abortController,
    });

    for await (const message of stream) {
      if (message.role === "assistant") {
        const text = extractText(message.content);
        if (text) {
          responseText += text;
          onText?.(text);
        }
        turns++;
      }
    }
  } catch (err) {
    logger.error(
      { err, agentId: agent.config.id, sessionId: session.id },
      `Agent ${agentLabel} run failed`,
    );
    throw err;
  }

  // Update session in the database
  updateSession(session.id, {
    total_turns: session.total_turns + turns,
  });

  logger.info(
    {
      agentId: agent.config.id,
      sessionId: session.id,
      turns,
      responseLength: responseText.length,
    },
    `Agent ${agentLabel} completed`,
  );

  return {
    sessionId: session.id,
    response: responseText,
    turns,
  };
}
