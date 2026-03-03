import Anthropic from '@anthropic-ai/sdk';
import { getAgent, getDefaultAgent } from './registry.js';
import {
  createSession,
  findSession,
  updateSession,
} from '../memory/sessions.js';
import { getQuickContext, getClientQuickContext } from '../memory/search.js';
import { addMessage, getMessages } from '../memory/messages.js';
import { getToolsForProfile, executeTool } from './tool-registry.js';
import type { ToolContext } from './tool-registry.js';
import { logger } from '../utils/logger.js';
import { env } from '../env.js';
import { buildJasminPreferenceContext } from './hooks/session-lifecycle.js';
import { incrementApplied } from '../memory/learnings.js';
import type { Session } from '../memory/sessions.js';
import type { QuickContext } from '../memory/search.js';
import type { ChatMessage } from '../memory/messages.js';
import { buildClientOverlay } from '../client-agents/prompt-builder.js';
import type { ToolProfile } from './profiles/index.js';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return client;
}

// ---------------------------------------------------------------------------
// Retry helpers for transient API errors (529 overloaded, 5xx, connection)
// ---------------------------------------------------------------------------

function isRetryableError(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    if (err.status === 529 || (err.status !== undefined && err.status >= 500)) return true;
    // Streaming errors sometimes have undefined status — check the message body
    if (err.status === undefined && /overloaded_error|529/.test(err.message)) return true;
  }
  if (err instanceof Anthropic.APIConnectionError) return true;
  return false;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 3,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableError(err) || attempt === maxAttempts) throw err;
      const delay = 2000 * Math.pow(2, attempt - 1); // 2s, 4s, 8s
      logger.warn({ err, attempt, delay, label }, 'Retryable API error, backing off');
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error('Unreachable');
}

export interface RunOptions {
  agentId: string;
  userMessage: string;
  userId: string;
  channelId: string;
  threadTs?: string;
  sessionId?: string;
  onText?: (text: string) => void;
  clientScope?: {
    clientCode: string;
    displayName: string;
  };
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreation?: number;
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

  // Current date/time so the agent always knows "now"
  const now = new Date().toLocaleString('en-GB', {
    timeZone: 'Europe/Berlin',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  parts.push(`## Current Date & Time\n${now} (Europe/Berlin)`);

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

async function resolveSession(
  agentId: string,
  channelId: string,
  userId: string,
  threadTs?: string,
  existingSessionId?: string,
): Promise<Session> {
  if (existingSessionId) {
    const existing = await findSession(channelId, threadTs ?? null, agentId);
    if (existing && existing.id === existingSessionId) {
      return existing;
    }
  }

  const found = await findSession(channelId, threadTs ?? null, agentId);
  if (found) {
    return found;
  }

  return await createSession({
    agent_id: agentId,
    channel_id: channelId,
    thread_ts: threadTs ?? null,
    user_id: userId,
  });
}

// ---------------------------------------------------------------------------
// Session summary generation (Jasmin-only, fire-and-forget)
// ---------------------------------------------------------------------------

const SUMMARY_MODEL = 'claude-haiku-4-5-20251001';

async function generateSessionSummary(sessionId: string): Promise<void> {
  try {
    const messages = await getMessages(sessionId, 10);
    if (messages.length < 2) return;

    const transcript = messages
      .map((m) => `${m.role === 'user' ? 'Daniel' : 'Jasmin'}: ${m.content.slice(0, 300)}`)
      .join('\n');

    const apiClient = getClient();
    const response = await apiClient.messages.create({
      model: SUMMARY_MODEL,
      max_tokens: 150,
      system: 'Summarize this conversation in 1-2 sentences. Focus on what was discussed and any decisions or actions taken. Be concise.',
      messages: [{ role: 'user', content: transcript }],
    });

    const summary = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    if (summary) {
      await updateSession(sessionId, { summary });
    }
  } catch (err) {
    logger.warn({ err, sessionId }, 'Failed to generate session summary');
  }
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
  return withRetry(async () => {
    let responseText = '';

    const stream = apiClient.messages.stream({
      model,
      max_tokens: 4096,
      system: [
        {
          type: 'text' as const,
          text: systemPrompt,
          cache_control: { type: 'ephemeral' as const },
        },
      ],
      messages,
    });

    stream.on('text', (text) => {
      responseText += text;
      onText?.(text);
    });

    const finalMessage = await stream.finalMessage();
    const cacheUsage = finalMessage.usage as unknown as Record<string, number>;

    return {
      responseText,
      usage: {
        input: finalMessage.usage.input_tokens,
        output: finalMessage.usage.output_tokens,
        cacheRead: cacheUsage.cache_read_input_tokens ?? 0,
        cacheCreation: cacheUsage.cache_creation_input_tokens ?? 0,
      },
    };
  }, 'runSimple');
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
  let totalCacheRead = 0;
  let totalCacheCreation = 0;

  // Prepare cached system prompt and tools — static across all turns
  const cachedSystem: Anthropic.TextBlockParam[] = [
    {
      type: 'text' as const,
      text: systemPrompt,
      cache_control: { type: 'ephemeral' as const },
    },
  ];

  // Add cache breakpoint to the last tool so tool definitions are cached too
  const cachedTools: Anthropic.Tool[] = tools.map((tool, i) =>
    i === tools.length - 1
      ? { ...tool, cache_control: { type: 'ephemeral' as const } }
      : tool,
  );

  /** Threshold: intermediate turn text shorter than this is "reasoning" and gets skipped */
  const REASONING_THRESHOLD = 200;

  // ---------------------------------------------------------------------------
  // Context budget — prevent exceeding Claude's 200K token window
  // Reserve tokens for: system prompt, tool defs, output, overhead
  // ---------------------------------------------------------------------------
  const MAX_CONTEXT_TOKENS = 190_000; // leave 10K headroom below 200K limit
  const CHARS_PER_TOKEN = 4; // conservative estimate
  const MAX_CONTEXT_CHARS = MAX_CONTEXT_TOKENS * CHARS_PER_TOKEN; // ~760K chars

  // Estimate static context size (system prompt + tool defs + initial messages)
  const staticChars = systemPrompt.length
    + JSON.stringify(tools).length
    + initialMessages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);

  // Track accumulated tool result chars across all turns
  let accumulatedToolChars = 0;

  /** Dynamic per-tool limit based on remaining budget */
  function getToolResultLimit(): number {
    const usedChars = staticChars + accumulatedToolChars;
    const remaining = MAX_CONTEXT_CHARS - usedChars;
    // Per-tool limit: at most 60K, and scale down as context fills
    return Math.max(10_000, Math.min(60_000, Math.floor(remaining * 0.4)));
  }

  /** Max total tool result chars per single turn (prevents parallel tool call blowup) */
  const MAX_TURN_TOOL_CHARS = 120_000;

  for (let turn = 0; turn < maxTurns; turn++) {
    let turnText = '';

    const msg = await withRetry(async () => {
      turnText = ''; // Reset on retry
      const stream = apiClient.messages.stream({
        model,
        max_tokens: 4096,
        system: cachedSystem,
        messages,
        tools: cachedTools,
      });

      // Stream text to Slack in real-time so the user sees progress immediately
      stream.on('text', (text) => {
        turnText += text;
        onText?.(text);
      });

      return stream.finalMessage();
    }, `runWithTools turn ${turn + 1}`);
    totalInput += msg.usage.input_tokens;
    totalOutput += msg.usage.output_tokens;
    const cacheUsage = msg.usage as unknown as Record<string, number>;
    totalCacheRead += cacheUsage.cache_read_input_tokens ?? 0;
    totalCacheCreation += cacheUsage.cache_creation_input_tokens ?? 0;

    if (msg.stop_reason !== 'tool_use') {
      // Final turn — text already streamed via onText
      if (turnText.trim()) {
        responseText += (responseText ? '\n\n' : '') + turnText;
      }
      return {
        responseText,
        turns: turn + 1,
        usage: { input: totalInput, output: totalOutput, cacheRead: totalCacheRead, cacheCreation: totalCacheCreation },
      };
    }

    // Intermediate tool-use turn — accumulate substantial text for final response
    // (text was already streamed to Slack progressively)
    if (turnText.trim().length >= REASONING_THRESHOLD) {
      responseText += (responseText ? '\n\n' : '') + turnText;
    }

    // Append the full assistant message (text + tool_use blocks)
    messages.push({ role: 'assistant', content: msg.content });

    // Execute each tool call
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let turnToolChars = 0;

    for (const block of msg.content) {
      if (block.type === 'tool_use') {
        logger.debug(
          { toolName: block.name, toolId: block.id },
          'Executing tool call',
        );

        let { result, isError } = await executeTool(
          block.name,
          block.input as Record<string, unknown>,
          toolContext,
        );

        // Dynamic truncation: per-tool limit shrinks as context fills
        const perToolLimit = getToolResultLimit();
        const turnBudgetLeft = MAX_TURN_TOOL_CHARS - turnToolChars;
        const effectiveLimit = Math.max(5_000, Math.min(perToolLimit, turnBudgetLeft));

        if (!isError && result.length > effectiveLimit) {
          const originalLen = result.length;
          result = result.slice(0, effectiveLimit) +
            `\n\n[TRUNCATED — result was ${originalLen.toLocaleString()} chars, limited to ${effectiveLimit.toLocaleString()}. Use narrower filters (campaignId, adsetId, fewer days) for complete data.]`;
          logger.warn(
            { toolName: block.name, originalLen, truncatedTo: effectiveLimit, perToolLimit, turnBudgetLeft },
            'Tool result truncated',
          );
        }

        turnToolChars += result.length;

        // Check for multimodal screenshot content
        let content: string | Anthropic.ToolResultBlockParam['content'] = result;
        if (!isError) {
          try {
            const parsed = JSON.parse(result);
            if (parsed?.screenshot?.type === 'base64') {
              content = [
                {
                  type: 'text' as const,
                  text: `Screenshot of ${parsed.url || 'page'} (${parsed.title || 'untitled'})`,
                },
                {
                  type: 'image' as const,
                  source: {
                    type: 'base64' as const,
                    media_type: parsed.screenshot.media_type,
                    data: parsed.screenshot.data,
                  },
                },
              ];
            }
          } catch {
            // Not JSON or no screenshot — use raw string
          }
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content,
          is_error: isError,
        });
      }
    }

    accumulatedToolChars += turnToolChars;

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
    usage: { input: totalInput, output: totalOutput, cacheRead: totalCacheRead, cacheCreation: totalCacheCreation },
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
    clientScope,
  } = options;

  // For client-scoped runs, always use Ada's definition
  const agent = clientScope
    ? getAgent('ada')!
    : (getAgent(agentId) ?? getDefaultAgent());
  const agentLabel = agent.config.display_name;

  // Effective agent ID for sessions/learnings/memory
  const effectiveAgentId = clientScope
    ? `ada_client_${clientScope.clientCode}`
    : agent.config.id;

  // Use client profile for client-scoped runs
  const profile: ToolProfile = clientScope
    ? 'client_media_buyer'
    : agent.config.profile;

  logger.info(
    { agentId: effectiveAgentId, channelId, threadTs, userId, clientScope: !!clientScope },
    `Running agent ${agentLabel}`,
  );

  const session = await resolveSession(
    effectiveAgentId,
    channelId,
    userId,
    threadTs,
    sessionId,
  );

  // Two-tier learnings for client agents, standard for internal
  const context = clientScope
    ? await getClientQuickContext(effectiveAgentId, clientScope.clientCode, userId)
    : await getQuickContext(agent.config.id, userId);

  // Jasmin: inject preference context and fetch more learnings
  const extras = agent.extras ? [...agent.extras] : [];
  if (agent.config.id === 'jasmin' && !clientScope) {
    const prefContext = await buildJasminPreferenceContext();
    if (prefContext) {
      extras.push({ name: 'preferences', content: prefContext });
    }
    // Override topLearnings with 15 instead of default 5
    const { getTopLearnings } = await import('../memory/learnings.js');
    context.topLearnings = await getTopLearnings('jasmin', 15);
  }

  // Client agent overlay
  if (clientScope) {
    extras.push({
      name: 'client-context',
      content: buildClientOverlay(clientScope),
    });
  }

  const systemPrompt = buildSystemPrompt(
    agent.persona,
    agent.instructions,
    context,
    extras,
  );

  // Fire-and-forget: increment applied_count for all injected learnings
  const allInjected = [...context.topLearnings, ...context.userLearnings];
  if (allInjected.length > 0) {
    Promise.all(allInjected.map((l) => incrementApplied(l.id))).catch((err) =>
      logger.warn({ err }, 'Failed to increment applied_count for learnings'),
    );
  }

  // Load prior conversation history from this session (last 20 messages)
  const priorMessages = await getMessages(session.id, 20);
  const conversationMessages: Anthropic.MessageParam[] =
    priorMessages.map((msg: ChatMessage) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    }));

  // Append the new user message
  conversationMessages.push({ role: 'user', content: userMessage });

  // Resolve tools for this agent's profile
  const { definitions: toolDefs } = getToolsForProfile(profile);

  // Estimate prompt size for debugging (chars ≈ tokens * 4)
  const historyChars = priorMessages.reduce((s, m) => s + m.content.length, 0);
  logger.info(
    {
      sessionId: session.id,
      historyLength: priorMessages.length,
      historyChars,
      systemPromptChars: systemPrompt.length,
      toolCount: toolDefs.length,
      userMessageChars: userMessage.length,
    },
    'Prompt context loaded',
  );

  try {

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
        agentId: effectiveAgentId,
        channelId,
        userId,
        threadTs,
        clientScope: clientScope
          ? { clientCode: clientScope.clientCode }
          : undefined,
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
    await addMessage({ session_id: session.id, role: 'user', content: userMessage });
    await addMessage({
      session_id: session.id,
      role: 'assistant',
      content: result.responseText,
    });

    // Update session in the database
    await updateSession(session.id, {
      total_turns: session.total_turns + result.turns,
    });

    // Session summary + realtime learning (fire-and-forget)
    if (agent.config.id === 'jasmin' || clientScope) {
      generateSessionSummary(session.id).catch((err) =>
        logger.warn({ err }, 'Session summary generation failed'),
      );

      const learnAgentId = clientScope
        ? `ada_client_${clientScope.clientCode}`
        : 'jasmin';
      const learnClientCode = clientScope?.clientCode;

      import('../learning/realtime-learning.js').then(({ detectAndLearn }) =>
        detectAndLearn(userMessage, result.responseText, learnAgentId, learnClientCode),
      ).catch((err) =>
        logger.warn({ err }, 'Realtime learning failed'),
      );
    }

    logger.info(
      {
        agentId: effectiveAgentId,
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
      { err, agentId: effectiveAgentId, sessionId: session.id },
      `Agent ${agentLabel} run failed`,
    );
    throw err;
  }
}
