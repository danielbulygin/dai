// Universal dai-agent audit log writer — EVERY agent's tool calls go through
// here (Ada, Piper, Maya, client-scoped agents — see the agent_id column), not
// just Piper's. The underlying table keeps its legacy name `piper_actions`
// (born in Piper EVOLUTION.md Phase 1.5); query it via the `agent_actions`
// view (migration 20260605160000) so "did agent X actually do Y?" is one
// SELECT. Fire-and-forget by design: logging is best-effort and must never
// block or fail a tool execution.

import { getDaiSupabase } from '../integrations/dai-supabase.js';
import { logger } from '../utils/logger.js';
import { emitPiperEvent, type PiperEventTargetType } from './piper-event-log.js';
import type { ToolContext } from './tool-registry.js';

// Cap row payload sizes so a single row stays well under 1MB.
const MAX_PARAMS_BYTES = 8_000;
const MAX_RESULT_SUMMARY_CHARS = 800;
const MAX_ERROR_CHARS = 2_000;

function truncateParams(params: Record<string, unknown>): Record<string, unknown> {
  try {
    const json = JSON.stringify(params);
    if (json.length <= MAX_PARAMS_BYTES) return params;
    return { __truncated: true, __original_bytes: json.length, preview: json.slice(0, MAX_PARAMS_BYTES) };
  } catch {
    return { __unserializable: true };
  }
}

function summarizeResult(result: string): string {
  if (result.length <= MAX_RESULT_SUMMARY_CHARS) return result;
  return result.slice(0, MAX_RESULT_SUMMARY_CHARS) + `…[truncated, ${result.length} chars total]`;
}

export interface ToolCallLogInput {
  toolName: string;
  context: ToolContext;
  params: Record<string, unknown>;
  result: string;
  status: 'success' | 'failed';
  durationMs: number;
  error?: string;
}

export function logToolCall(input: ToolCallLogInput): void {
  // Fire-and-forget. We deliberately do not await this — the latency budget on
  // tool calls is too tight to add a Supabase round-trip per call, and we
  // accept the risk of losing rows on a crash before the insert resolves.
  void writeToolCallRow(input).catch((err) => {
    logger.warn(
      { toolName: input.toolName, err: (err as Error).message },
      'piper_actions audit log write failed (non-fatal)',
    );
  });
}

async function writeToolCallRow(input: ToolCallLogInput): Promise<void> {
  const supabase = getDaiSupabase();
  const row = {
    agent_id: input.context.agentId,
    session_id: input.context.threadTs ?? null,
    channel_id: input.context.channelId ?? null,
    user_id: input.context.userId ?? null,
    action_type: 'tool_call',
    tool_name: input.toolName,
    initiator: input.context.userId ?? null,
    params: truncateParams(input.params),
    result_summary: summarizeResult(input.result),
    status: input.status,
    duration_ms: input.durationMs,
    error: input.error ? input.error.slice(0, MAX_ERROR_CHARS) : null,
  };
  const { error } = await supabase.from('piper_actions').insert(row);
  if (error) throw new Error(error.message);
}

export interface WriteLogInput {
  context: ToolContext;
  toolName: string;
  targetSystem: 'notion' | 'meta' | 'slack' | 'frameio' | 'supabase' | 'drive';
  targetId: string;
  before: unknown;
  after: unknown;
  reverse: unknown;
  summary: string;
  status?: 'success' | 'failed' | 'partial';
}

// Dual-emit rule (master plan 2026-06-09 §1.5): scoped Notion writes that
// target a task or ad set ALSO land in piper_event_log (bmad Supabase), the
// one narrative log per target. piper_actions stays unchanged — raw tool-call
// telemetry. Only tools in this map emit; everything else is telemetry-only.
const EVENT_LOG_TARGET_TYPES: Record<string, PiperEventTargetType> = {
  update_aot_task_status: 'task',
  update_aot_task_due_date: 'task',
  update_aot_ad_set_stage: 'ad_set',
};

/**
 * Log a state-changing write (action_type='write') with the before/after and a
 * machine-readable reverse_action, so every Piper mutation is auditable AND
 * undoable. Mirrors the piper-hygiene-sweep pattern. Fire-and-forget.
 *
 * Scoped Notion writes (see EVENT_LOG_TARGET_TYPES) additionally emit a
 * piper_event_log row so each task/ad set has one filterable narrative.
 */
export function logWrite(input: WriteLogInput): void {
  void writeWriteRow(input).catch((err) => {
    logger.warn(
      { toolName: input.toolName, err: (err as Error).message },
      'piper_actions write-log failed (non-fatal)',
    );
  });

  const targetType = EVENT_LOG_TARGET_TYPES[input.toolName];
  if (targetType) {
    emitPiperEvent({
      actor: input.context.agentId,
      action: input.toolName,
      targetType,
      targetId: input.targetId,
      before: input.before,
      after: input.after,
      why: input.summary,
      channel: input.context.channelId ?? 'slack',
      result: input.status ?? 'success',
    });
  }
}

async function writeWriteRow(input: WriteLogInput): Promise<void> {
  const supabase = getDaiSupabase();
  const { error } = await supabase.from('piper_actions').insert({
    agent_id: input.context.agentId,
    session_id: input.context.threadTs ?? null,
    channel_id: input.context.channelId ?? null,
    user_id: input.context.userId ?? null,
    initiator: input.context.userId ?? null,
    action_type: 'write',
    tool_name: input.toolName,
    target_system: input.targetSystem,
    target_id: input.targetId,
    before_state: input.before as object,
    after_state: input.after as object,
    reverse_action: input.reverse as object,
    result_summary: input.summary.slice(0, MAX_RESULT_SUMMARY_CHARS),
    status: input.status ?? 'success',
  });
  if (error) throw new Error(error.message);
}

export interface RecentActionsFilter {
  hoursBack?: number;
  agentId?: string;
  toolName?: string;
  status?: 'success' | 'failed';
  limit?: number;
}

export interface PiperActionRow {
  id: number;
  timestamp: string;
  agent_id: string;
  session_id: string | null;
  tool_name: string | null;
  params: unknown;
  result_summary: string | null;
  status: string;
  duration_ms: number | null;
  error: string | null;
}

export async function fetchRecentActions(filter: RecentActionsFilter): Promise<PiperActionRow[]> {
  const supabase = getDaiSupabase();
  const hoursBack = filter.hoursBack ?? 24;
  const limit = Math.min(filter.limit ?? 50, 500);
  const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

  let q = supabase
    .from('piper_actions')
    .select('id, timestamp, agent_id, session_id, tool_name, params, result_summary, status, duration_ms, error')
    .gte('timestamp', since)
    .order('timestamp', { ascending: false })
    .limit(limit);

  if (filter.agentId) q = q.eq('agent_id', filter.agentId);
  if (filter.toolName) q = q.eq('tool_name', filter.toolName);
  if (filter.status) q = q.eq('status', filter.status);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as PiperActionRow[];
}
