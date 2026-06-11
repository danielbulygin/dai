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
import { buildAgentDirectorySection } from './agent-directory.js';
import type { ToolProfile } from './profiles/index.js';
import { runLaunchClaimGuard } from './hooks/launch-claim-guard.js';
import type { ExecutedToolCall } from './hooks/launch-claim-guard.js';
import { extractBatchIds, getBatchStates, buildLaunchStateSection } from './launch-state.js';
import { detectClientCodes, loadClientContextExtras, loadMethodologyExtra } from './client-context.js';
import { detectLaunchShaped, loadLaunchWorkflowExtra } from './workflow-context.js';

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
  /** Where this run originated (interactive | monday-prep | delegation | api-* | eval | orchestrator). Telemetry only. */
  source?: string;
  onText?: (text: string) => void;
  /** Called between tool-use turns to reset streamed text and prevent repetition. */
  onTurnReset?: () => void;
  /** Called when a tool starts executing, for progress indicators. */
  onToolUse?: (toolName: string) => void;
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

// ---------------------------------------------------------------------------
// Cost estimation (USD per 1M tokens; cw = 5-min cache write, cr = cache read)
// ---------------------------------------------------------------------------

const MODEL_PRICES: Array<{ match: string; in: number; cw: number; cr: number; out: number }> = [
  { match: 'opus', in: 5, cw: 6.25, cr: 0.5, out: 25 },
  { match: 'sonnet', in: 3, cw: 3.75, cr: 0.3, out: 15 },
  { match: 'haiku', in: 1, cw: 1.25, cr: 0.1, out: 5 },
];

export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const p = MODEL_PRICES.find((e) => model.includes(e.match)) ?? MODEL_PRICES[0]!;
  return (
    (usage.input * p.in +
      (usage.cacheCreation ?? 0) * p.cw +
      (usage.cacheRead ?? 0) * p.cr +
      usage.output * p.out) /
    1_000_000
  );
}

// ---------------------------------------------------------------------------
// System prompt assembly — cache-aware two-block structure.
//
// Prompt caching is a PREFIX match: any byte change invalidates everything
// after it. Render order is tools → system → messages. So the system prompt
// is split into two blocks, each with its own cache breakpoint:
//
//   Block 1 (STABLE, ~45K tokens): persona + instructions + registry extras
//     (METRICS/skills/knowledge) + agent directory. Identical for every run
//     of an agent within a process — caches once, read forever.
//   Block 2 (VOLATILE): per-thread context (slack-context, client files,
//     methodology, launch workflow, launch-state), session summary,
//     learnings, prefs, and the current DATE — at DAY precision, LAST.
//     A change here rewrites only this block; block 1 still cache-hits.
//
// The old layout put a MINUTE-precision datetime as the FIRST part of one
// monolithic block, so the entire prefix invalidated every minute and
// cross-turn cache reads almost never hit (cache writes were ~55% of the
// dai key's spend, 2026-06-04..10 admin-API data).
// ---------------------------------------------------------------------------

function buildDateSection(): string {
  const berlinDay = new Date().toLocaleDateString('en-GB', {
    timeZone: 'Europe/Berlin',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const isoDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' }); // YYYY-MM-DD
  return `## Current Date\nToday is: ${berlinDay} (Europe/Berlin)\nISO date: ${isoDate}\nIMPORTANT: The current year is ${isoDate.slice(0, 4)}. Always use this date as your reference when answering questions about days of the week, time periods, or relative dates like "yesterday", "last week", etc. For precise time-of-day, rely on timestamps in tool results — you only know the date, not the clock time.`;
}

function buildSystemBlocks(
  persona: string,
  instructions: string,
  context: QuickContext,
  stableExtras: { name: string; content: string }[],
  volatileExtras: { name: string; content: string }[],
): Anthropic.TextBlockParam[] {
  const stableParts: string[] = [persona, instructions];
  for (const extra of stableExtras) {
    stableParts.push(extra.content);
  }

  const volatileParts: string[] = [];
  for (const extra of volatileExtras) {
    volatileParts.push(extra.content);
  }

  if (context.lastSessionSummary) {
    volatileParts.push(`## Previous Session\n${context.lastSessionSummary}`);
  }

  if (context.topLearnings.length > 0) {
    const items = context.topLearnings
      .map((l) => `- ${l.content}`)
      .join('\n');
    volatileParts.push(`## Key Learnings\n${items}`);
  }

  if (context.userLearnings.length > 0) {
    const items = context.userLearnings
      .map((l) => `- ${l.content}`)
      .join('\n');
    volatileParts.push(`## User Preferences\n${items}`);
  }

  // Date goes LAST so the daily flip invalidates as little as possible.
  volatileParts.push(buildDateSection());

  return [
    {
      type: 'text' as const,
      text: stableParts.join('\n\n'),
      cache_control: { type: 'ephemeral' as const },
    },
    {
      type: 'text' as const,
      text: volatileParts.join('\n\n'),
      cache_control: { type: 'ephemeral' as const },
    },
  ];
}

// ---------------------------------------------------------------------------
// Moving message-cache breakpoint — caches the growing conversation
// incrementally across turns of the tool loop (and across runs in a thread).
// Budget: tools(1) + system(2) + messages(1) = the 4-breakpoint maximum.
// ---------------------------------------------------------------------------

function applyMovingCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
  // Strip any marker placed on a previous turn…
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        delete (block as { cache_control?: unknown }).cache_control;
      }
    }
  }
  // …then mark the last block of the last message. The last message before an
  // API call is always a user message (initial text or tool_results), so the
  // marked block is a text/tool_result block — both accept cache_control.
  const last = messages[messages.length - 1];
  if (!last) return;
  if (typeof last.content === 'string') {
    last.content = [{ type: 'text' as const, text: last.content }];
  }
  if (Array.isArray(last.content) && last.content.length > 0) {
    const lastBlock = last.content[last.content.length - 1] as { cache_control?: unknown };
    lastBlock.cache_control = { type: 'ephemeral' };
  }
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
  systemBlocks: Anthropic.TextBlockParam[],
  messages: Anthropic.MessageParam[],
  onText?: (text: string) => void,
): Promise<{ responseText: string; usage: TokenUsage }> {
  applyMovingCacheBreakpoint(messages);
  return withRetry(async () => {
    let responseText = '';

    const stream = apiClient.messages.stream({
      model,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: systemBlocks,
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
  systemBlocks: Anthropic.TextBlockParam[],
  initialMessages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[],
  toolContext: ToolContext,
  maxTurns: number,
  onText?: (text: string) => void,
  onTurnReset?: () => void,
  onToolUse?: (toolName: string) => void,
): Promise<{ responseText: string; turns: number; usage: TokenUsage; executedTools: ExecutedToolCall[]; toolDigest: string }> {
  const messages: Anthropic.MessageParam[] = [...initialMessages];
  // Every tool call executed this run, for post-response claim guards
  // (launch-claim-guard cross-checks "launched ✅" replies against these).
  const executedTools: ExecutedToolCall[] = [];
  // Compact record of data pulled this run. Appended to the STORED assistant
  // message (not the Slack reply) so follow-up turns in the thread aren't
  // data-blind — only user/assistant text survives between turns otherwise.
  const toolDigests: string[] = [];
  const DIGEST_SKIP = new Set(['post_message', 'reply_in_thread', 'remember', 'recall']);
  const MAX_DIGEST_CHARS = 6_000;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;

  // Add cache breakpoint to the last tool so tool definitions are cached too
  const cachedTools: Anthropic.Tool[] = tools.map((tool, i) =>
    i === tools.length - 1
      ? { ...tool, cache_control: { type: 'ephemeral' as const } }
      : tool,
  );

  // ---------------------------------------------------------------------------
  // Context budget — prevent exceeding Claude's 200K token window
  // Reserve tokens for: system prompt, tool defs, output, overhead
  // ---------------------------------------------------------------------------
  const MAX_CONTEXT_TOKENS = 190_000; // leave 10K headroom below 200K limit
  const CHARS_PER_TOKEN = 4; // conservative estimate
  const MAX_CONTEXT_CHARS = MAX_CONTEXT_TOKENS * CHARS_PER_TOKEN; // ~760K chars

  // Estimate static context size (system prompt + tool defs + initial messages)
  const staticChars = systemBlocks.reduce((s, b) => s + b.text.length, 0)
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

  // Accumulate text from ALL turns so the final message contains the full
  // analysis, not just the last turn's concluding remark.
  let fullResponseText = '';
  let lastTurnText = '';

  for (let turn = 0; turn < maxTurns; turn++) {
    // Reset streamed text between tool-use turns so the user only sees
    // the latest turn's output, preventing duplicate/overlapping analyses.
    if (turn > 0) {
      onTurnReset?.();
    }

    let turnText = '';

    // Move the message-cache breakpoint to the newest message so the growing
    // conversation (incl. tool results) caches incrementally turn over turn.
    applyMovingCacheBreakpoint(messages);

    const msg = await withRetry(async () => {
      turnText = ''; // Reset on retry
      const stream = apiClient.messages.stream({
        model,
        max_tokens: 32000,
        // Adaptive thinking: the model decides when/how deeply to reason, and
        // interleaves thinking between tool calls. Thinking blocks ride along
        // in msg.content and are echoed back on the next turn automatically.
        thinking: { type: 'adaptive' },
        system: systemBlocks,
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

    lastTurnText = turnText;
    if (turnText.trim()) {
      fullResponseText += (fullResponseText ? '\n\n' : '') + turnText;
    }

    if (msg.stop_reason !== 'tool_use') {
      // Final turn — return accumulated text from ALL turns so the full
      // analysis is preserved, not just the last turn's concluding remark.
      return {
        responseText: fullResponseText.trim() || turnText,
        turns: turn + 1,
        usage: { input: totalInput, output: totalOutput, cacheRead: totalCacheRead, cacheCreation: totalCacheCreation },
        executedTools,
        toolDigest: toolDigests.join('\n'),
      };
    }

    // Intermediate tool-use turn — text was streamed to Slack for live feedback
    // and will be reset at the start of the next turn.  Text is accumulated
    // into fullResponseText so the final message contains the full analysis.

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
        onToolUse?.(block.name);

        let { result, isError } = await executeTool(
          block.name,
          block.input as Record<string, unknown>,
          toolContext,
        );
        executedTools.push({ name: block.name, isError });

        if (!isError && !DIGEST_SKIP.has(block.name)) {
          const usedChars = toolDigests.reduce((s, d) => s + d.length, 0);
          if (usedChars < MAX_DIGEST_CHARS) {
            const inputStr = JSON.stringify(block.input ?? {}).slice(0, 150);
            const resultStr = result.replace(/\s+/g, ' ').slice(0, 600);
            toolDigests.push(`${block.name}(${inputStr}) → ${resultStr}`);
          }
        }

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

  // Max turns reached — use the last turn's text as the response
  logger.warn(
    { maxTurns, agentId: toolContext.agentId },
    'Tool-use loop hit max turns',
  );

  return {
    responseText: fullResponseText.trim() || lastTurnText || 'I ran out of processing turns. Please try a more specific question.',
    turns: maxTurns,
    usage: { input: totalInput, output: totalOutput, cacheRead: totalCacheRead, cacheCreation: totalCacheCreation },
    executedTools,
    toolDigest: toolDigests.join('\n'),
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
    onTurnReset,
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

  // STABLE extras — identical for every run of this agent within a process.
  // These join persona+instructions in cache block 1 (see buildSystemBlocks).
  // Agent directory is static config, so it lives here — agents can emit REAL
  // <@U...> mentions (plain-text "@Ace" triggers nothing — 2026-06-03 demo).
  const stableExtras = agent.extras ? [...agent.extras] : [];
  stableExtras.push({ name: 'agent-directory', content: buildAgentDirectorySection(agent.config.display_name) });

  // VOLATILE extras — per-thread/per-run context; cache block 2.
  const extras: { name: string; content: string }[] = [];
  if (channelId && !channelId.startsWith('internal-')) {
    extras.push({
      name: 'slack-context',
      content: `## Live Slack Context\nYou are responding in channel \`${channelId}\`${threadTs ? `, thread \`${threadTs}\`` : ''}. When a tool needs a channel ID for THIS conversation, use these literal values — never invent or guess a channel ID.`,
    });
  }
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
    let clientContext: string | undefined;
    try {
      const { readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const contextPath = join(process.cwd(), 'agents', 'ada', 'clients', `${clientScope.clientCode}.md`);
      clientContext = readFileSync(contextPath, 'utf-8');
    } catch {
      // No client context file — that's fine
    }
    extras.push({
      name: 'client-context',
      content: buildClientOverlay({ ...clientScope, clientContext }),
    });
  }

  // Load prior conversation history from this session (last 20 messages).
  // Loaded BEFORE the system prompt is built so launch-state injection below
  // can scan it for batch references.
  const priorMessages = await getMessages(session.id, 20);

  // Conditional launch workflow (A10): the full upload/launch playbook loads
  // only when the conversation looks launch-shaped. Internal runs only —
  // client-scoped profiles have no launch tools.
  if (!clientScope) {
    try {
      const texts = [...priorMessages.map((m: ChatMessage) => m.content), userMessage];
      if (detectLaunchShaped(texts)) {
        const wf = loadLaunchWorkflowExtra(agent.manifest.path);
        if (wf) {
          extras.push(wf);
          logger.info({ sessionId: session.id }, 'Injected launch workflow (launch-shaped conversation)');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'launch-workflow injection failed (continuing without it)');
    }
  }

  // Internal runs: inject per-client intelligence files when the conversation
  // references a client. Client-scoped runs already get theirs via the overlay.
  if (!clientScope) {
    try {
      const detected = detectClientCodes([
        ...priorMessages.map((m: ChatMessage) => m.content),
        userMessage,
      ]);
      if (detected.length > 0) {
        const clientExtras = loadClientContextExtras(detected);
        extras.push(...clientExtras);
        // Methodology pre-step: top extracted rules/insights for the primary
        // detected client, so the 7K-item corpus shapes the analysis without
        // relying on the model remembering to call search_methodology.
        const methodologyExtra = await loadMethodologyExtra(detected[0]!);
        if (methodologyExtra) extras.push(methodologyExtra);
        if (clientExtras.length > 0 || methodologyExtra) {
          logger.info({ sessionId: session.id, clients: detected }, 'Injected client context files');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'client-context injection failed (continuing without it)');
    }
  }

  // Launch-state ground truth: if this thread references launch batches, inject
  // their LIVE launch_batches status into the system prompt. Even a context-
  // starved turn then knows what is pending vs launched — the model can no
  // longer pattern-complete a launch from stale conversation text. See
  // launch-state.ts and the 2026-06-05 fabricated-launch incident.
  try {
    const batchIds = extractBatchIds([
      ...priorMessages.map((m: ChatMessage) => m.content),
      userMessage,
    ]);
    if (batchIds.length > 0) {
      const states = await getBatchStates(batchIds);
      if (states.length > 0) {
        extras.push({ name: 'launch-state', content: buildLaunchStateSection(states) });
        logger.info(
          { sessionId: session.id, batches: states.map((s) => `${s.batch_id.slice(0, 8)}:${s.status}`) },
          'Injected launch-state ground truth into prompt',
        );
      }
    }
  } catch (err) {
    logger.warn({ err }, 'launch-state injection failed (continuing without it)');
  }

  const systemBlocks = buildSystemBlocks(
    agent.persona,
    agent.instructions,
    context,
    stableExtras,
    extras,
  );
  const systemPromptChars = systemBlocks.reduce((s, b) => s + b.text.length, 0);

  // Fire-and-forget: increment applied_count for all injected learnings
  const allInjected = [...context.topLearnings, ...context.userLearnings];
  if (allInjected.length > 0) {
    Promise.all(allInjected.map((l) => incrementApplied(l.id))).catch((err) =>
      logger.warn({ err }, 'Failed to increment applied_count for learnings'),
    );
  }
  const conversationMessages: Anthropic.MessageParam[] =
    priorMessages.map((msg: ChatMessage) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    }));

  // Thread-context fallback: a fresh session on an existing thread (e.g. a reply to an
  // out-of-band post like the scheduled Ready-to-Upload nudge, which is posted via a raw
  // bot client and never stored in Ada's message history) would otherwise start blind.
  // Pull the live Slack thread so the agent can see what it's replying to. Empty-history
  // only — normal multi-turn sessions already have their context and are untouched.
  let threadContextPrefix = '';
  if (priorMessages.length === 0 && threadTs && channelId) {
    try {
      const { getDedicatedBotClient } = await import('../slack/dedicated-bots.js');
      const replies = await getDedicatedBotClient(effectiveAgentId).conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 30,
      });
      const msgs = (replies.messages ?? []).filter(
        (m) => typeof (m as { text?: string }).text === 'string' && (m as { text?: string }).text!.trim().length > 0,
      );
      if (msgs.length > 0) {
        const transcript = msgs
          .map((m) => {
            const mm = m as { text?: string; bot_id?: string; user?: string };
            const who = mm.bot_id ? 'You (earlier, posted by you)' : mm.user ? `<@${mm.user}>` : 'someone';
            return `${who}: ${mm.text}`;
          })
          .join('\n\n');
        threadContextPrefix =
          `[Context — the Slack thread you are replying in, for reference. ` +
          `You may have posted earlier messages here out-of-band (e.g. a scheduled nudge):]\n\n${transcript}\n\n---\n\n`;
      }
    } catch (err) {
      logger.warn({ err, threadTs }, 'thread-context fallback fetch failed (continuing without it)');
    }
  }

  // Append the new user message (with thread context prefixed when we recovered it).
  conversationMessages.push({ role: 'user', content: threadContextPrefix + userMessage });

  // Resolve tools for this agent's profile
  const { definitions: toolDefs } = getToolsForProfile(profile);

  // Estimate prompt size for debugging (chars ≈ tokens * 4)
  const historyChars = priorMessages.reduce((s, m) => s + m.content.length, 0);
  logger.info(
    {
      sessionId: session.id,
      historyLength: priorMessages.length,
      historyChars,
      systemPromptChars,
      stableBlockChars: systemBlocks[0]?.text.length ?? 0,
      volatileBlockChars: systemBlocks[1]?.text.length ?? 0,
      toolCount: toolDefs.length,
      userMessageChars: userMessage.length,
    },
    'Prompt context loaded',
  );

  try {

    let result: { responseText: string; turns: number; usage: TokenUsage; executedTools?: ExecutedToolCall[]; toolDigest?: string };

    if (toolDefs.length === 0) {
      // No tools registered for this profile — use simple streaming path
      const simple = await runSimple(
        getClient(),
        agent.config.model,
        systemBlocks,
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
        systemBlocks,
        conversationMessages,
        toolDefs,
        toolContext,
        agent.config.max_turns,
        onText,
        onTurnReset,
        options.onToolUse,
      );
    }

    // Post-response QC: a reply that CLAIMS a completed launch must be backed by a
    // real launch/verify tool call (or a recently-launched batch in the DB). Appends
    // a loud UNCONFIRMED banner otherwise — see hooks/launch-claim-guard.ts and the
    // 2026-06-05 Sweetspot fabricated-launch incident.
    try {
      const guard = await runLaunchClaimGuard({
        responseText: result.responseText,
        executedTools: result.executedTools ?? [],
        agentId: effectiveAgentId,
        sessionId: session.id,
      });
      if (guard.flagged && guard.warning) {
        result.responseText += guard.warning;
      }
    } catch (guardErr) {
      logger.warn({ err: guardErr }, 'launch-claim-guard failed (continuing without it)');
    }

    // Persist the user message and assistant response. The stored assistant
    // message carries a compact digest of tool data pulled this turn so that
    // follow-up turns in the same thread aren't data-blind (the digest is in
    // history only — never shown in Slack).
    await addMessage({ session_id: session.id, role: 'user', content: userMessage });
    const storedContent = result.toolDigest
      ? `${result.responseText}\n\n[internal — data I pulled this turn, for my own future reference; the user did not see this block:]\n${result.toolDigest}`
      : result.responseText;
    await addMessage({
      session_id: session.id,
      role: 'assistant',
      content: storedContent,
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
        source: options.source ?? 'untagged',
        model: agent.config.model,
        responseLength: result.responseText.length,
        historyLength: priorMessages.length,
        turns: result.turns,
        inputTokens: result.usage.input,
        outputTokens: result.usage.output,
        cacheReadTokens: result.usage.cacheRead ?? 0,
        cacheCreationTokens: result.usage.cacheCreation ?? 0,
        estCostUsd: Math.round(estimateCostUsd(agent.config.model, result.usage) * 10000) / 10000,
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
