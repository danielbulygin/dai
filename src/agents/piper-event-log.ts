// piper_event_log writer — THE one narrative log for the production pipeline
// (bmad Supabase, migration 20260604000000_piper_brain.sql). Per the dual-emit
// rule (master plan 2026-06-09 §1.5): any action that targets a task or ad set
// (scoped Notion writes, human corrections from the My Real Moves loop, later
// nudges) also emits a row here, so `WHERE target_type/target_id` yields the
// full story of any set. `piper_actions` (DAI Supabase) stays what it is —
// raw agent tool-call telemetry; this table is the pipeline narrative.
//
// Fire-and-forget by design (same contract as action-log.ts): emitting an
// event must never block or fail the action that produced it.

import { getSupabase } from '../integrations/supabase.js';
import { logger } from '../utils/logger.js';

export type PiperEventTargetType = 'task' | 'ad_set';

export interface PiperEventInput {
  /** Who acted: an agent id ('piper', 'ada') or 'human-correction'. */
  actor: string;
  /** What happened: a tool name ('update_aot_task_status') or 'correction:<kind>'. */
  action: string;
  targetType: PiperEventTargetType | null;
  /** Notion task page id for tasks; ad-set code (e.g. "TLx4101") for ad sets. */
  targetId: string | null;
  before?: unknown;
  after?: unknown;
  /** Human-readable reason / note. */
  why?: string;
  /** Where it came from (e.g. 'slack', a channel id). */
  channel?: string;
  result?: string;
}

export async function insertPiperEvent(input: PiperEventInput): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('piper_event_log').insert({
    actor: input.actor,
    action: input.action,
    target_type: input.targetType,
    target_id: input.targetId,
    before: (input.before ?? null) as object | null,
    after: (input.after ?? null) as object | null,
    why: input.why ?? null,
    channel: input.channel ?? null,
    result: input.result ?? null,
  });
  if (error) throw new Error(error.message);
}

/** Fire-and-forget wrapper — logs a warning on failure, never throws. */
export function emitPiperEvent(input: PiperEventInput): void {
  void insertPiperEvent(input).catch((err) => {
    logger.warn(
      { action: input.action, targetId: input.targetId, err: (err as Error).message },
      'piper_event_log write failed (non-fatal)',
    );
  });
}
