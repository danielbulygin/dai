/**
 * Per-client cadence target tools — read/write client_cadence_targets in
 * bmad Supabase. Piper reads these to compute "tracking X% of target",
 * the headline Phase 2 cadence intelligence read.
 *
 * Cadence targets are typed contracted numbers, not preferences:
 *   ads_per_week         — how many ad sets the client expects shipped per week
 *   concept_queue_target — minimum concept-stage depth before brief-writing slips
 *   max_cycle_days       — concept → done end-to-end SLA
 *
 * Setting a target is a high-touch decision (we contracted X with the client) —
 * the writer is intentionally narrow, no defaults, only the fields the user
 * passes are updated. updated_by carries the Slack user id (or terminal
 * sessionId) so we can audit who set what.
 */

import { getSupabase } from '../../integrations/supabase.js'
import { logger } from '../../utils/logger.js'

export interface CadenceTarget {
  client_code: string
  ads_per_week: number | null
  concept_queue_target: number | null
  max_cycle_days: number | null
  notes: string | null
  updated_at: string
  updated_by: string | null
}

export async function rememberCadenceTarget(params: {
  client_code: string
  ads_per_week?: number
  concept_queue_target?: number
  max_cycle_days?: number
  notes?: string
  updated_by?: string
}): Promise<string> {
  try {
    const supabase = getSupabase()
    const code = params.client_code.trim().toUpperCase()

    // Pull current row so partial updates preserve untouched fields.
    const { data: existing } = await supabase
      .from('client_cadence_targets')
      .select('*')
      .eq('client_code', code)
      .maybeSingle()

    const merged = {
      client_code: code,
      ads_per_week: params.ads_per_week ?? (existing as CadenceTarget | null)?.ads_per_week ?? null,
      concept_queue_target:
        params.concept_queue_target ?? (existing as CadenceTarget | null)?.concept_queue_target ?? null,
      max_cycle_days:
        params.max_cycle_days ?? (existing as CadenceTarget | null)?.max_cycle_days ?? null,
      notes: params.notes ?? (existing as CadenceTarget | null)?.notes ?? null,
      updated_at: new Date().toISOString(),
      updated_by: params.updated_by ?? null,
    }

    const { error } = await supabase.from('client_cadence_targets').upsert(merged)
    if (error) {
      return JSON.stringify({ error: error.message })
    }
    return JSON.stringify({ ok: true, target: merged })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ error: msg }, 'rememberCadenceTarget failed')
    return JSON.stringify({ error: msg })
  }
}

export async function getCadenceTargets(params: { client_code?: string }): Promise<string> {
  try {
    const supabase = getSupabase()
    let q = supabase
      .from('client_cadence_targets')
      .select('client_code, ads_per_week, concept_queue_target, max_cycle_days, notes, updated_at, updated_by')
      .order('client_code', { ascending: true })
    if (params.client_code) {
      q = q.eq('client_code', params.client_code.trim().toUpperCase())
    }
    const { data, error } = await q
    if (error) {
      return JSON.stringify({ error: error.message })
    }
    const rows = (data ?? []) as CadenceTarget[]
    return JSON.stringify({ count: rows.length, targets: rows })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ error: msg }, 'getCadenceTargets failed')
    return JSON.stringify({ error: msg })
  }
}
