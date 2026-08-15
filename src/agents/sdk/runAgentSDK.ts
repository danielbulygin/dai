/**
 * runAgentSDK — a drop-in alternative to `runAgent()` (src/agents/runner.ts)
 * that drives Ada on the **Claude Agent SDK** instead of the hand-rolled
 * `runWithTools` loop.
 *
 * It implements the SAME external contract — `runAgent(RunOptions): RunResult` —
 * so the Slack adapter (`mentions.ts`) could call it without knowing the
 * difference. It is GATED OFF by default (`shouldUseSdkRunner`), Ada-only, and
 * NOT wired into the live listener tonight. Drive it via the same RunOptions
 * the adapter builds (that is exactly what the QC scripts do).
 *
 * What it reuses from dai (so the A/B is fair):
 *   - getAgent('ada') → persona + INSTRUCTIONS + static skill/knowledge extras
 *   - the same per-thread context injection (date, slack-context, client files,
 *     methodology pre-step, launch-state ground truth, learnings)
 *   - the same tool registry (via the in-process MCP bridge → executeTool)
 *   - the session row + `sessions.claude_session_id` as the SDK session bridge
 *
 * What changes: the loop, streaming, tool-turn parsing, context compaction, and
 * cache breakpoints are all SDK-managed; write-gating is a declarative
 * PreToolUse hook instead of post-hoc fabricated-write guards.
 */
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getAgent } from '../registry.js';
import { getConstitution } from '../constitution.js';
import type { RunOptions, RunResult, TokenUsage } from '../runner.js';
import type { ToolContext } from '../tool-registry.js';
import type { ToolProfile } from '../profiles/index.js';
import { findSession, createSession, updateSession } from '../../memory/sessions.js';
import { addMessage } from '../../memory/messages.js';
import { getQuickContext, getClientQuickContext } from '../../memory/search.js';
import { detectClientCodes, loadClientContextExtras, loadMethodologyExtra, loadClientTargetsExtra, loadClientLearningsExtra } from '../client-context.js';
import { extractBatchIds, getBatchStates, buildLaunchStateSection } from '../launch-state.js';
import { buildAgentDirectorySection } from '../agent-directory.js';
import { logger } from '../../utils/logger.js';
import { buildAdaToolBridge } from './tool-bridge.js';
import { makePreToolUseHook, makeCanUseTool, defaultPolicy, bareToolName, isWriteTool, type GuardPolicy, type GuardDecision } from './guard.js';
import { emitErrorEvent, type ErrorSurface } from '../../observability/error-events.js';
import { startTrace } from '../../observability/langsmith.js';
import {
  newRunState, governWrite, noteToolOutcome, lookupDeadEnd, renderDeadEndNote, failureText,
  type DeadEndMatchEvent,
} from './loop-wiring.js';
import type { GovernorVerdict } from './governor.js';

/** Where the project skills dir lives (contains `.claude/skills/ada-*`). Spike default. */
const DEFAULT_SKILLS_CWD = process.env.ADA_SDK_SKILLS_CWD ?? '/root/ada-sdk-spike/skills-root';

/** OFF-by-default, Ada-only flag. NOT called from the live listener tonight. */
export function shouldUseSdkRunner(agentId: string): boolean {
  return process.env.ADA_SDK_RUNNER === '1' && agentId === 'ada';
}

export interface SdkRunExtras {
  /** Guard policy overrides (default: deny all writes — safe for the spike). */
  policy?: Partial<GuardPolicy>;
  /** Skills to enable (default: all ada-* skills). */
  skills?: string[];
  /** Override the model (default: agent config). */
  model?: string;
  /** Project cwd for skill resolution. */
  skillsCwd?: string;
  /** maxBudgetUsd cap (default 3). */
  maxBudgetUsd?: number;
  /** maxTurns cap (default min(config.max_turns, 20)). Production raises this — multi-tool
   *  launch chains (ready-to-upload) need more than 20 agent turns to complete reliably. */
  maxTurns?: number;
  /** Enable extended thinking (adaptive) and surface thinking via options.onThinking. Default off. */
  thinking?: boolean;
  /** Emit token-level deltas (text + thinking) via includePartialMessages. Default off (block-level). */
  streamPartial?: boolean;
  /** Collect every guard decision (for QC evidence). */
  onDecision?: (d: GuardDecision) => void;
  /** Reports the SDK's authoritative cost + result subtype + tool names used. */
  onResult?: (r: { costUsd: number; subtype: string; toolsUsed: string[] }) => void;
  /** Ada 2.0: fired on every Governor verdict over a write (decision cards / audit). */
  onGovernorVerdict?: (v: GovernorVerdict) => void;
  /** Ada 2.0: fired when a failed write matches a known ada_dead_ends row. */
  onDeadEndMatch?: (m: DeadEndMatchEvent) => void;
  /**
   * Correlation id for this run — the SAME id in the log line, every error event
   * and the LangSmith trace, so "what happened in that conversation?" is one
   * grep. Callers that expose it to the client (the SSE `meta`/`done` frames)
   * pass their own; otherwise one is minted here.
   */
  runId?: string;
  /** Which customer-facing surface this run came in on. Defaults from clientScope. */
  surface?: ErrorSurface;
}

const DEFAULT_ADA_SKILLS = [
  'ada-media-library', 'ada-sweetspot-namer', 'ada-ready-to-upload',
  'ada-website-walk', 'ada-call-insights', 'ada-client-change-alerts',
];

function dateSection(): string {
  const day = new Date().toLocaleDateString('en-GB', {
    timeZone: 'Europe/Berlin', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const iso = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
  return `## Current Date\nToday is: ${day} (Europe/Berlin)\nISO date: ${iso}\nThe current year is ${iso.slice(0, 4)}. Use this as your reference for relative dates.`;
}

/** Resolve (or create) the dai session row for this (channel, thread, agent). */
async function resolveSdkSession(agentId: string, channelId: string, userId: string, threadTs?: string) {
  const found = await findSession(channelId, threadTs ?? null, agentId);
  if (found) return found;
  return createSession({ agent_id: agentId, channel_id: channelId, thread_ts: threadTs ?? null, user_id: userId });
}

/**
 * Build Ada's system prompt as a single string, mirroring the stable+volatile
 * structure of runner.ts buildSystemBlocks (the SDK handles caching internally).
 */
export async function buildSystemPrompt(opts: RunOptions): Promise<string> {
  const agent = getAgent('ada')!;
  const parts: string[] = [];
  // The constitution loads FIRST for every agent (per-agent opt-out via
  // agent.yaml `constitution: false`). Ada does NOT pass through the runner's
  // buildSystemBlocks — this is the second of the two prompt paths that must
  // both carry it (verify gate: a real run's prompt contains "Ask, don't assume").
  if (agent.config.constitution) {
    const constitution = getConstitution();
    if (constitution) parts.push(constitution);
  }
  parts.push(agent.persona, agent.instructions);
  for (const e of agent.extras) parts.push(e.content);
  parts.push(buildAgentDirectorySection(agent.config.display_name));

  // --- volatile / per-thread context (best-effort, mirrors runner) ---
  if (opts.channelId && !opts.channelId.startsWith('internal-')) {
    parts.push(`## Live Slack Context\nYou are responding in channel \`${opts.channelId}\`${opts.threadTs ? `, thread \`${opts.threadTs}\`` : ''}. Use these literal IDs when a tool needs this conversation's channel — never invent one.`);
  }

  try {
    const ctx = opts.clientScope
      ? await getClientQuickContext(`ada_client_${opts.clientScope.clientCode}`, opts.clientScope.clientCode, opts.userId)
      : await getQuickContext('ada', opts.userId);
    if (ctx.lastSessionSummary) parts.push(`## Previous Session\n${ctx.lastSessionSummary}`);
    if (ctx.topLearnings.length) parts.push(`## Key Learnings\n${ctx.topLearnings.map((l) => `- ${l.content}`).join('\n')}`);
    if (ctx.userLearnings.length) parts.push(`## User Preferences\n${ctx.userLearnings.map((l) => `- ${l.content}`).join('\n')}`);
  } catch (err) { logger.warn({ err }, 'sdk: quick-context injection failed'); }

  try {
    const detected = detectClientCodes([opts.userMessage]);
    if (detected.length) {
      parts.push(...loadClientContextExtras(detected).map((e) => e.content));
      const meth = await loadMethodologyExtra(detected[0]!);
      if (meth) parts.push(meth.content);
      // Phase B (context layer): KPI targets + client-scoped learnings for the
      // primary detected client. The global top-5 learnings (below) can never
      // carry a fresh client-specific correction — this section can (newest
      // first). This is the fix for the JVA golden-case eval fail (2026-07-02).
      const [targetsExtra, learningsExtra] = await Promise.all([
        loadClientTargetsExtra(detected[0]!),
        loadClientLearningsExtra(detected[0]!),
      ]);
      if (targetsExtra) parts.push(targetsExtra.content);
      if (learningsExtra) parts.push(learningsExtra.content);
    }
  } catch (err) { logger.warn({ err }, 'sdk: client-context injection failed'); }

  try {
    const batchIds = extractBatchIds([opts.userMessage]);
    if (batchIds.length) {
      const states = await getBatchStates(batchIds);
      if (states.length) parts.push(buildLaunchStateSection(states));
    }
  } catch (err) { logger.warn({ err }, 'sdk: launch-state injection failed'); }

  parts.push(dateSection());
  return parts.join('\n\n');
}

export async function runAgentSDK(options: RunOptions, extras: SdkRunExtras = {}): Promise<RunResult> {
  // Ada-only. Hard guard so Piper/Ace can never be routed through the SDK runner.
  if (options.agentId !== 'ada' && !options.clientScope) {
    throw new Error(`runAgentSDK is Ada-only; refusing agentId=${options.agentId}`);
  }

  const agent = getAgent('ada')!;
  const profile: ToolProfile = options.clientScope ? 'client_media_buyer' : (agent.config.profile as ToolProfile);
  const effectiveAgentId = options.clientScope ? `ada_client_${options.clientScope.clientCode}` : 'ada';

  const session = await resolveSdkSession(effectiveAgentId, options.channelId, options.userId, options.threadTs);

  // Observability identity for this run. `clientCode` is read from the SERVER-derived
  // scope, never from the model or the request body — an event that misattributes a
  // failure to the wrong customer is worse than no event.
  const runId = extras.runId ?? randomUUID();
  const surface: ErrorSurface = extras.surface ?? (options.clientScope ? 'chat-scoped' : 'chat');
  const clientCode = options.clientScope?.clientCode ?? null;
  const runRef = { runId, surface, clientCode, sessionId: session.id, userId: options.userId };

  const trace = startTrace({
    name: `ada:${surface}`,
    runId,
    clientCode,
    surface,
    sessionId: session.id,
    userId: options.userId,
    inputs: { message: options.userMessage },
    metadata: { profile, agent_id: effectiveAgentId, model: extras.model ?? agent.config.model },
  });

  const systemPrompt = await buildSystemPrompt(options);

  const toolContext: ToolContext = {
    agentId: effectiveAgentId,
    channelId: options.channelId,
    userId: options.userId,
    threadTs: options.threadTs,
    clientScope: options.clientScope ? { clientCode: options.clientScope.clientCode } : undefined,
  };

  // Default the guard's decision callback to a logger so every allow/deny is
  // visible in `journalctl -u dai` during testing (denies at warn, allows at debug).
  const onDecision = extras.onDecision ?? ((d: GuardDecision) => {
    if (d.decision === 'deny') logger.warn({ tool: d.bareName, clientCode: d.clientCode, reason: d.reason }, `guard DENY: ${d.bareName}`);
    else logger.debug({ tool: d.bareName }, `guard allow: ${d.bareName}`);
  });
  const policy: GuardPolicy = defaultPolicy({ ...extras.policy, onDecision });

  // Ada 2.0 loop wiring: per-run Governor state + failure-organ read. The bridge
  // stays a dumb adapter; all judgment lives in loop-wiring (deterministic,
  // unit-tested). This is where the live loop stops being blind and ungoverned.
  const runState = newRunState();
  const bridge = buildAdaToolBridge(profile, {
    getContext: () => toolContext,
    onToolExec: (name) => options.onToolUse?.(name),
    govern: (name) => {
      const gate = governWrite(runState, name);
      if (gate) {
        logger.info(
          { tool: gate.verdict.bareName, tier: gate.verdict.tier, blast: gate.verdict.blast, reversibility: gate.verdict.reversibility, confidence: gate.verdict.confidence, refused: !!gate.refusal, sessionId: session.id },
          `governor: ${gate.verdict.tier} ${gate.verdict.bareName}`,
        );
        extras.onGovernorVerdict?.(gate.verdict);
      }
      return gate;
    },
    onToolFailure: async (name, resultText) => {
      const match = await lookupDeadEnd(failureText(resultText));
      noteToolOutcome(runState, name, true, match);
      if (!match) return undefined;
      const event = runState.deadEndMatches[runState.deadEndMatches.length - 1]!;
      logger.info({ tool: bareToolName(name), matchedOn: event.matchedOn, deadEndId: event.deadEndId, sessionId: session.id }, 'failure-organ match');
      extras.onDeadEndMatch?.(event);
      return renderDeadEndNote(match);
    },
    onToolOutcome: (name, failed) => {
      // Failures are recorded in onToolFailure (with the match); only successes here.
      if (!failed) noteToolOutcome(runState, name, false);
    },
    observe: (name, args) => {
      const span = trace.child(name, 'tool', { args });
      return ({ status, text, softError }) => {
        span.end(status === 'ok' ? { outputs: { result: text } } : { error: text });
        if (status === 'refused') {
          emitErrorEvent({ ...runRef, kind: 'refusal', toolName: name, error: text, errorClass: 'governor_refusal' });
          return;
        }
        if (status === 'failed') {
          emitErrorEvent({ ...runRef, kind: 'tool_failure', toolName: name, error: text });
          return;
        }
        // Reported success to the model, but the result carries an error inside:
        // the write did not happen and the model does not know. This is the one
        // event that says "Ada is about to narrate something untrue".
        if (softError) {
          emitErrorEvent({
            ...runRef,
            kind: isWriteTool(name) ? 'silent_write_failure' : 'tool_failure',
            toolName: name,
            error: softError,
            detail: { surfaced_to_model: false, is_write: isWriteTool(name) },
          });
        }
      };
    },
  });

  const model = extras.model ?? agent.config.model;
  const maxTurns = extras.maxTurns ?? Math.min(agent.config.max_turns ?? 25, 20);

  logger.info(
    { sessionId: session.id, claudeSessionId: session.claude_session_id, profile, model, tools: bridge.toolNames.length },
    'runAgentSDK starting',
  );

  let responseText = '';
  let lastTurnHadToolUse = false;
  const q = query({
    prompt: options.userMessage,
    options: {
      model,
      systemPrompt,
      cwd: extras.skillsCwd ?? DEFAULT_SKILLS_CWD,
      settingSources: ['project'],
      skills: extras.skills ?? DEFAULT_ADA_SKILLS,
      mcpServers: { [bridge.serverName]: bridge.server },
      hooks: { PreToolUse: [{ hooks: [makePreToolUseHook(policy)] }] },
      canUseTool: makeCanUseTool(policy),
      permissionMode: 'default',
      maxTurns,
      maxBudgetUsd: extras.maxBudgetUsd ?? 3,
      ...(extras.thinking ? { thinking: { type: 'adaptive' as const } } : {}),
      ...(extras.streamPartial ? { includePartialMessages: true } : {}),
      ...(session.claude_session_id ? { resume: session.claude_session_id } : {}),
    },
  });

  let usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let turns = 0;
  let claudeSessionId: string | undefined;
  const toolsUsed: string[] = [];

  try {
    for await (const msg of q) {
      // Token-level streaming (chat): handle raw partial events; the full `assistant`
      // message that follows each turn is skipped to avoid double-emitting.
      if (extras.streamPartial && msg.type === 'stream_event') {
        const ev = (msg as { event?: { type?: string; content_block?: { type?: string; name?: string }; delta?: { type?: string; text?: string; thinking?: string } } }).event;
        if (ev?.type === 'content_block_start') {
          const cb = ev.content_block;
          if (cb?.type === 'tool_use') {
            lastTurnHadToolUse = true;
            if (cb.name) { toolsUsed.push(cb.name); options.onToolUse?.(cb.name); }
          } else if (cb?.type === 'text' && lastTurnHadToolUse) {
            options.onTurnReset?.(); lastTurnHadToolUse = false;
          }
        } else if (ev?.type === 'content_block_delta') {
          const d = ev.delta;
          if (d?.type === 'text_delta' && d.text) { responseText += d.text; options.onText?.(d.text); }
          else if (d?.type === 'thinking_delta' && d.thinking) { options.onThinking?.(d.thinking); }
        }
        continue;
      }
      if (msg.type === 'assistant') {
        if (extras.streamPartial) continue; // already streamed via stream_event
        // A new assistant turn after a tool turn → reset streamed text (Slack parity).
        if (lastTurnHadToolUse) { options.onTurnReset?.(); lastTurnHadToolUse = false; }
        const content = (msg as { message?: { content?: unknown[] } }).message?.content ?? [];
        for (const b of content) {
          const blk = b as { type?: string; text?: string; thinking?: string; name?: string };
          if (blk.type === 'text' && blk.text) { responseText += blk.text; options.onText?.(blk.text); }
          if (blk.type === 'thinking' && blk.thinking) { options.onThinking?.(blk.thinking); }
          if (blk.type === 'tool_use') { lastTurnHadToolUse = true; if (blk.name) { toolsUsed.push(blk.name); logger.info({ tool: blk.name, sessionId: session.id }, `tool_use: ${blk.name}`); options.onToolUse?.(blk.name); } }
        }
      } else if (msg.type === 'result') {
        const r = msg as Record<string, unknown>;
        claudeSessionId = r.session_id as string;
        turns = (r.num_turns as number) ?? 0;
        const u = (r.usage as Record<string, number>) ?? {};
        usage = {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheCreation: u.cache_creation_input_tokens ?? 0,
        };
        if (typeof r.result === 'string' && r.result && !responseText) responseText = r.result as string;
        extras.onResult?.({ costUsd: (r.total_cost_usd as number) ?? 0, subtype: (r.subtype as string) ?? 'unknown', toolsUsed });
        if (r.subtype !== 'success') {
          logger.warn({ subtype: r.subtype, sessionId: session.id }, 'runAgentSDK non-success result');
          emitErrorEvent({
            ...runRef,
            kind: 'run_failed',
            error: `runner subtype=${r.subtype}`,
            errorClass: `subtype_${r.subtype}`,
            detail: { turns, cost_usd: r.total_cost_usd ?? null, tools_used: toolsUsed },
          });
        }
      }
    }
  } catch (err) {
    // The stream died mid-run: a torn answer the customer sees as Ada going
    // quiet. Nothing downstream reports it, so this is its only record.
    emitErrorEvent({ ...runRef, kind: 'handler_exception', error: err, detail: { tools_used: toolsUsed } });
    trace.end({ error: err });
    throw err;
  }

  // Persist the SDK session id (the bridge) + bookkeeping.
  try {
    if (claudeSessionId && claudeSessionId !== session.claude_session_id) {
      await updateSession(session.id, { claude_session_id: claudeSessionId });
    }
    await updateSession(session.id, { total_turns: session.total_turns + turns });
    await addMessage({ session_id: session.id, role: 'user', content: options.userMessage });
    await addMessage({ session_id: session.id, role: 'assistant', content: responseText });
  } catch (err) {
    logger.warn({ err }, 'runAgentSDK persistence failed (continuing)');
    // A lost session row means the next turn silently starts a new conversation.
    emitErrorEvent({ ...runRef, kind: 'handler_exception', error: err, errorClass: 'persistence' });
  }

  logger.info(
    { sessionId: session.id, claudeSessionId, turns, inputTokens: usage.input, outputTokens: usage.output, source: options.source ?? 'untagged' },
    'runAgentSDK completed',
  );

  trace.end({ outputs: { answer: responseText, turns, tools_used: toolsUsed } });

  return { sessionId: session.id, response: responseText, turns, usage };
}
