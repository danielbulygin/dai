/**
 * Phase 2 cadence intelligence — Piper's headline read.
 *
 * Joins the Phase 1 data layer (aot_*_current views, client_cadence_targets)
 * to compute "tracking X% of target", concept-queue gap, and in-flight depth.
 *
 * "Shipped" is task-side per feedback_piper_task_stage_is_truth: an ad set
 * counted as shipped when ALL its tasks are terminal and max(task last_edited)
 * is within the window. Computed server-side by the
 * piper_count_shipped_adsets() Postgres RPC.
 */

import { getSupabase } from '../../integrations/supabase.js'
import { logger } from '../../utils/logger.js'

interface CadenceTargetRow {
  client_code: string
  ads_per_week: number | null
  concept_queue_target: number | null
  max_cycle_days: number | null
  notes: string | null
}

export async function getCadenceRead(params: {
  client_code: string
  window_days?: number
}): Promise<string> {
  try {
    const supabase = getSupabase()
    const code = params.client_code.trim().toUpperCase()
    const windowDays = params.window_days ?? 28
    const since = new Date(Date.now() - windowDays * 86400_000).toISOString()

    // Target (may not exist if not yet set)
    const { data: targetRow } = await supabase
      .from('client_cadence_targets')
      .select('client_code, ads_per_week, concept_queue_target, max_cycle_days, notes')
      .eq('client_code', code)
      .maybeSingle()
    const target = targetRow as CadenceTargetRow | null

    // Shipped count in window via RPC
    const { data: shippedRaw, error: rpcErr } = await supabase.rpc(
      'piper_count_shipped_adsets',
      { p_client_code: code, p_since: since },
    )
    if (rpcErr) {
      return JSON.stringify({ error: `shipped RPC failed: ${rpcErr.message}` })
    }
    const shipped = (shippedRaw as number | null) ?? 0

    // Concept queue depth (current non-dead Concept-stage ad sets)
    const { count: conceptQueue } = await supabase
      .from('aot_adsets_current')
      .select('notion_id', { count: 'exact', head: true })
      .eq('client_code', code)
      .eq('stage', 'Concept')

    // In-flight = active production work (Production / Revision / Launch)
    const { count: inFlight } = await supabase
      .from('aot_adsets_current')
      .select('notion_id', { count: 'exact', head: true })
      .eq('client_code', code)
      .in('stage', ['Production', 'Revision', 'Launch'])

    // Math
    const weeks = windowDays / 7
    const actualPerWeek = shipped / weeks
    const trackingPct = target?.ads_per_week
      ? Math.round((actualPerWeek / target.ads_per_week) * 100)
      : null
    const queueGap =
      target?.concept_queue_target != null
        ? target.concept_queue_target - (conceptQueue ?? 0)
        : null

    return JSON.stringify({
      client_code: code,
      window_days: windowDays,
      target: {
        ads_per_week: target?.ads_per_week ?? null,
        concept_queue_target: target?.concept_queue_target ?? null,
        max_cycle_days: target?.max_cycle_days ?? null,
        notes: target?.notes ?? null,
      },
      throughput: {
        shipped_in_window: shipped,
        actual_per_week: Math.round(actualPerWeek * 10) / 10,
        tracking_pct: trackingPct,
      },
      concept_queue: {
        depth: conceptQueue ?? 0,
        target: target?.concept_queue_target ?? null,
        gap: queueGap,
      },
      in_flight: inFlight ?? 0,
      note: target
        ? null
        : `No cadence target set for ${code}. Use remember_cadence_target to capture contracted numbers.`,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ error: msg }, 'getCadenceRead failed')
    return JSON.stringify({ error: msg })
  }
}

export async function getCadenceReadAll(params: {
  window_days?: number
}): Promise<string> {
  try {
    const supabase = getSupabase()
    const windowDays = params.window_days ?? 28
    const since = new Date(Date.now() - windowDays * 86400_000).toISOString()

    // Pull all targets
    const { data: targetsRaw } = await supabase
      .from('client_cadence_targets')
      .select('client_code, ads_per_week, concept_queue_target, max_cycle_days')
      .order('client_code')
    const targets = (targetsRaw ?? []) as CadenceTargetRow[]

    // One pipeline-wide RPC call returns shipped per client_code
    const { data: shippedRows, error: rpcErr } = await supabase.rpc(
      'piper_count_shipped_adsets_all',
      { p_since: since },
    )
    if (rpcErr) {
      return JSON.stringify({ error: `shipped-all RPC failed: ${rpcErr.message}` })
    }
    const shippedByClient = new Map<string, number>()
    for (const row of (shippedRows ?? []) as Array<{ client_code: string; shipped: number }>) {
      shippedByClient.set(row.client_code, (shippedByClient.get(row.client_code) ?? 0) + row.shipped)
    }

    const weeks = windowDays / 7
    const reads = targets.map((t) => {
      const shipped = shippedByClient.get(t.client_code) ?? 0
      const actualPerWeek = shipped / weeks
      const trackingPct = t.ads_per_week
        ? Math.round((actualPerWeek / t.ads_per_week) * 100)
        : null
      return {
        client_code: t.client_code,
        target_per_week: t.ads_per_week,
        shipped_in_window: shipped,
        actual_per_week: Math.round(actualPerWeek * 10) / 10,
        tracking_pct: trackingPct,
      }
    })

    return JSON.stringify({
      window_days: windowDays,
      clients_with_targets: targets.length,
      reads: reads.sort((a, b) => (a.tracking_pct ?? 999) - (b.tracking_pct ?? 999)),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ error: msg }, 'getCadenceReadAll failed')
    return JSON.stringify({ error: msg })
  }
}
