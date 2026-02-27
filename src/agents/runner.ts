import Anthropic from '@anthropic-ai/sdk';
import { getAgent, getDefaultAgent } from './registry.js';
import {
  createSession,
  findSession,
  updateSession,
} from '../memory/sessions.js';
import { getQuickContext } from '../memory/search.js';
import { addMessage, getMessages } from '../memory/messages.js';
import { getToolsForProfile, executeTool } from './tool-registry.js';
import type { ToolContext } from './tool-registry.js';
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
  extras?: { name: string; content: string }[],
): string {
  const parts: string[] = [];

  parts.push(persona);
  parts.push(instructions);

  if (extras && extras.length > 0) {
    for (const extra of extras) {
      parts.push(extra.content);
    }
  }

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

// ---------------------------------------------------------------------------
// Simple path (no tools) — existing behavior, zero regression risk
// ---------------------------------------------------------------------------

async function runSimple(
  apiClient: Anthropic,
  model: string,
  systemPrompt: string,
  messages: Anthropic.MessageParam[],
  onText?: (text: string) => void,
): Promise<{ responseText: string; usage: TokenUsage }> {
  let responseText = '';

  const stream = apiClient.messages.stream({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages,
  });

  stream.on('text', (text) => {
    responseText += text;
    onText?.(text);
  });

  const finalMessage = await stream.finalMessage();

  return {
    responseText,
    usage: {
      input: finalMessage.usage.input_tokens,
      output: finalMessage.usage.output_tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Tool-use agentic loop
// ---------------------------------------------------------------------------

async function runWithTools(
  apiClient: Anthropic,
  model: string,
  systemPrompt: string,
  initialMessages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[],
  toolContext: ToolContext,
  maxTurns: number,
  onText?: (text: string) => void,
): Promise<{ responseText: string; turns: number; usage: TokenUsage }> {
  const messages: Anthropic.MessageParam[] = [...initialMessages];
  let responseText = '';
  let totalInput = 0;
  let totalOutput = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    const stream = apiClient.messages.stream({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
      tools,
    });

    // Stream text blocks to the callback
    stream.on('text', (text) => {
      responseText += text;
      onText?.(text);
    });

    const msg = await stream.finalMessage();
    totalInput += msg.usage.input_tokens;
    totalOutput += msg.usage.output_tokens;

    // If the model finished without requesting tools, we're done
    if (msg.stop_reason !== 'tool_use') {
      return {
        responseText,
        turns: turn + 1,
        usage: { input: totalInput, output: totalOutput },
      };
    }

    // Append the full assistant message (text + tool_use blocks)
    messages.push({ role: 'assistant', content: msg.content });

    // Execute each tool call
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        logger.debug(
          { toolName: block.name, toolId: block.id },
          'Executing tool call',
        );

        const { result, isError } = await executeTool(
          block.name,
          block.input as Record<string, unknown>,
          toolContext,
        );

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
          is_error: isError,
        });
      }
    }

    // Send tool results back as a user message
    messages.push({ role: 'user', content: toolResults });
  }

  // Max turns reached
  logger.warn(
    { maxTurns, agentId: toolContext.agentId },
    'Tool-use loop hit max turns',
  );

  return {
    responseText,
    turns: maxTurns,
    usage: { input: totalInput, output: totalOutput },
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

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
    agent.extras,
  );

  // Load prior conversation history from this session (last 20 messages)
  const priorMessages = getMessages(session.id, 20);
  const conversationMessages: Anthropic.MessageParam[] =
    priorMessages.map((msg: ChatMessage) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    }));

  // Append the new user message
  conversationMessages.push({ role: 'user', content: userMessage });

  logger.debug(
    { sessionId: session.id, historyLength: priorMessages.length },
    'Loaded conversation history',
  );

  try {
    // Resolve tools for this agent's profile
    const { definitions: toolDefs } = getToolsForProfile(agent.config.profile);

    let result: { responseText: string; turns: number; usage: TokenUsage };

    if (toolDefs.length === 0) {
      // No tools registered for this profile — use simple streaming path
      const simple = await runSimple(
        getClient(),
        agent.config.model,
        systemPrompt,
        conversationMessages,
        onText,
      );
      result = { ...simple, turns: 1 };
    } else {
      // Tool-use agentic loop
      const toolContext: ToolContext = {
        agentId: agent.config.id,
        channelId,
        userId,
        threadTs,
      };

      result = await runWithTools(
        getClient(),
        agent.config.model,
        systemPrompt,
        conversationMessages,
        toolDefs,
        toolContext,
        agent.config.max_turns,
        onText,
      );
    }

    // Persist the user message and assistant response (text only)
    addMessage({ session_id: session.id, role: 'user', content: userMessage });
    addMessage({
      session_id: session.id,
      role: 'assistant',
      content: result.responseText,
    });

    // Update session in the database
    updateSession(session.id, {
      total_turns: session.total_turns + result.turns,
    });

    logger.info(
      {
        agentId: agent.config.id,
        sessionId: session.id,
        responseLength: result.responseText.length,
        historyLength: priorMessages.length,
        turns: result.turns,
        inputTokens: result.usage.input,
        outputTokens: result.usage.output,
        hasTools: toolDefs.length > 0,
      },
      `Agent ${agentLabel} completed`,
    );

    return {
      sessionId: session.id,
      response: result.responseText,
      turns: result.turns,
      usage: result.usage,
    };
  } catch (err) {
    logger.error(
      { err, agentId: agent.config.id, sessionId: session.id },
      `Agent ${agentLabel} run failed`,
    );
    throw err;
  }
}
