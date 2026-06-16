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
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getAgent } from '../registry.js';
import type { RunOptions, RunResult, TokenUsage } from '../runner.js';
import type { ToolContext } from '../tool-registry.js';
import type { ToolProfile } from '../profiles/index.js';
import { findSession, createSession, updateSession } from '../../memory/sessions.js';
import { addMessage } from '../../memory/messages.js';
import { getQuickContext, getClientQuickContext } from '../../memory/search.js';
import { detectClientCodes, loadClientContextExtras, loadMethodologyExtra } from '../client-context.js';
import { extractBatchIds, getBatchStates, buildLaunchStateSection } from '../launch-state.js';
import { buildAgentDirectorySection } from '../agent-directory.js';
import { logger } from '../../utils/logger.js';
import { buildAdaToolBridge } from './tool-bridge.js';
import { makePreToolUseHook, makeCanUseTool, defaultPolicy, type GuardPolicy, type GuardDecision } from './guard.js';

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
  /** Collect every guard decision (for QC evidence). */
  onDecision?: (d: GuardDecision) => void;
  /** Reports the SDK's authoritative cost + result subtype + tool names used. */
  onResult?: (r: { costUsd: number; subtype: string; toolsUsed: string[] }) => void;
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
async function buildSystemPrompt(opts: RunOptions): Promise<string> {
  const agent = getAgent('ada')!;
  const parts: string[] = [agent.persona, agent.instructions];
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

  const systemPrompt = await buildSystemPrompt(options);

  const toolContext: ToolContext = {
    agentId: effectiveAgentId,
    channelId: options.channelId,
    userId: options.userId,
    threadTs: options.threadTs,
    clientScope: options.clientScope ? { clientCode: options.clientScope.clientCode } : undefined,
  };

  const policy: GuardPolicy = defaultPolicy({ ...extras.policy, onDecision: extras.onDecision });
  const bridge = buildAdaToolBridge(profile, {
    getContext: () => toolContext,
    onToolExec: (name) => options.onToolUse?.(name),
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
      ...(session.claude_session_id ? { resume: session.claude_session_id } : {}),
    },
  });

  let usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let turns = 0;
  let claudeSessionId: string | undefined;
  const toolsUsed: string[] = [];

  for await (const msg of q) {
    if (msg.type === 'assistant') {
      // A new assistant turn after a tool turn → reset streamed text (Slack parity).
      if (lastTurnHadToolUse) { options.onTurnReset?.(); lastTurnHadToolUse = false; }
      const content = (msg as { message?: { content?: unknown[] } }).message?.content ?? [];
      for (const b of content) {
        const blk = b as { type?: string; text?: string; name?: string };
        if (blk.type === 'text' && blk.text) { responseText += blk.text; options.onText?.(blk.text); }
        if (blk.type === 'tool_use') { lastTurnHadToolUse = true; if (blk.name) { toolsUsed.push(blk.name); options.onToolUse?.(blk.name); } }
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
      }
    }
  }

  // Persist the SDK session id (the bridge) + bookkeeping.
  try {
    if (claudeSessionId && claudeSessionId !== session.claude_session_id) {
      await updateSession(session.id, { claude_session_id: claudeSessionId });
    }
    await updateSession(session.id, { total_turns: session.total_turns + turns });
    await addMessage({ session_id: session.id, role: 'user', content: options.userMessage });
    await addMessage({ session_id: session.id, role: 'assistant', content: responseText });
  } catch (err) { logger.warn({ err }, 'runAgentSDK persistence failed (continuing)'); }

  logger.info(
    { sessionId: session.id, claudeSessionId, turns, inputTokens: usage.input, outputTokens: usage.output, source: options.source ?? 'untagged' },
    'runAgentSDK completed',
  );

  return { sessionId: session.id, response: responseText, turns, usage };
}
