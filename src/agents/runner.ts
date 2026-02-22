import Anthropic from '@anthropic-ai/sdk';
import { getAgent, getDefaultAgent } from './registry.js';
import {
  createSession,
  findSession,
  updateSession,
} from '../memory/sessions.js';
import { getQuickContext } from '../memory/search.js';
import { addMessage, getMessages } from '../memory/messages.js';
import { logger } from '../utils/logger.js';
import { env } from '../env.js';
import type { Session } from '../memory/sessions.js';
import type { QuickContext } from '../memory/search.js';
import type { ChatMessage } from '../memory/messages.js';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return client;
}

export interface RunOptions {
  agentId: string;
  userMessage: string;
  userId: string;
  channelId: string;
  threadTs?: string;
  sessionId?: string;
  onText?: (text: string) => void;
}

export interface TokenUsage {
  input: number;
  output: number;
}

export interface RunResult {
  sessionId: string;
  response: string;
  turns: number;
  usage: TokenUsage;
}

function buildSystemPrompt(
  persona: string,
  instructions: string,
  context: QuickContext,
): string {
  const parts: string[] = [];

  parts.push(persona);
  parts.push(instructions);

  if (context.lastSessionSummary) {
    parts.push(`## Previous Session\n${context.lastSessionSummary}`);
  }

  if (context.topLearnings.length > 0) {
    const items = context.topLearnings
      .map((l) => `- ${l.content}`)
      .join('\n');
    parts.push(`## Key Learnings\n${items}`);
  }

  if (context.userLearnings.length > 0) {
    const items = context.userLearnings
      .map((l) => `- ${l.content}`)
      .join('\n');
    parts.push(`## User Preferences\n${items}`);
  }

  return parts.join('\n\n');
}

function resolveSession(
  agentId: string,
  channelId: string,
  userId: string,
  threadTs?: string,
  existingSessionId?: string,
): Session {
  if (existingSessionId) {
    const existing = findSession(channelId, threadTs ?? null, agentId);
    if (existing && existing.id === existingSessionId) {
      return existing;
    }
  }

  const found = findSession(channelId, threadTs ?? null, agentId);
  if (found) {
    return found;
  }

  return createSession({
    agent_id: agentId,
    channel_id: channelId,
    thread_ts: threadTs ?? null,
    user_id: userId,
  });
}

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

  const agent = getAgent(agentId) ?? getDefaultAgent();
  const agentLabel = agent.config.display_name;

  logger.info(
    { agentId: agent.config.id, channelId, threadTs, userId },
    `Running agent ${agentLabel}`,
  );

  const session = resolveSession(
    agent.config.id,
    channelId,
    userId,
    threadTs,
    sessionId,
  );

  const context = getQuickContext(agent.config.id, userId);
  const systemPrompt = buildSystemPrompt(
    agent.persona,
    agent.instructions,
    context,
  );

  // Load prior conversation history from this session (last 20 messages)
  const priorMessages = getMessages(session.id, 20);
  const conversationMessages: Array<{ role: 'user' | 'assistant'; content: string }> =
    priorMessages.map((msg: ChatMessage) => ({
      role: msg.role,
      content: msg.content,
    }));

  // Append the new user message
  conversationMessages.push({ role: 'user', content: userMessage });

  logger.debug(
    { sessionId: session.id, historyLength: priorMessages.length },
    'Loaded conversation history',
  );

  let responseText = '';

  try {
    const stream = getClient().messages.stream({
      model: agent.config.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: conversationMessages,
    });

    stream.on('text', (text) => {
      responseText += text;
      onText?.(text);
    });

    const finalMessage = await stream.finalMessage();

    // Persist the user message and assistant response
    addMessage({ session_id: session.id, role: 'user', content: userMessage });
    addMessage({ session_id: session.id, role: 'assistant', content: responseText });

    // Update session in the database
    updateSession(session.id, {
      total_turns: session.total_turns + 1,
    });

    logger.info(
      {
        agentId: agent.config.id,
        sessionId: session.id,
        responseLength: responseText.length,
        historyLength: priorMessages.length,
        inputTokens: finalMessage.usage.input_tokens,
        outputTokens: finalMessage.usage.output_tokens,
      },
      `Agent ${agentLabel} completed`,
    );

    return {
      sessionId: session.id,
      response: responseText,
      turns: 1,
      usage: {
        input: finalMessage.usage.input_tokens,
        output: finalMessage.usage.output_tokens,
      },
    };
  } catch (err) {
    logger.error(
      { err, agentId: agent.config.id, sessionId: session.id },
      `Agent ${agentLabel} run failed`,
    );
    throw err;
  }
}
