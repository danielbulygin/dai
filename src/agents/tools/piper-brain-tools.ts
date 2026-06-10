// Piper brain tools (master plan 2026-06-09 §2.1) — read the derived SQL brain,
// never recompute pipeline state from the raw Notion mirror.
//
// get_pipeline_summary — piper_pipeline_summary() + piper_bucket_rollup():
//                        per-client working/sitting/external/data-gap counts,
//                        real overdue, gate-done-7d, coverage, freshness.
// get_adset_case       — piper_adset_case(p_code): the ONE-call deep dive for
//                        "what's going on with TLx4101", incl. a prewritten ping.
// query_piper_state    — forensic filtered select over piper_task_state joined
//                        (in TS) to piper_ad_set_state.
//
// All three live in the bmad Supabase (service-role), same client as the
// my-moves brain reads (src/digest/piper-my-moves.ts).

import { getSupabase } from '../../integrations/supabase.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Normalize an ad-set code: "tlx4101" / "TLX4101" / "meow3880" → "TLx4101" /
 * "MEOWx3880". Uppercase the letter prefix, keep the x separator lowercase.
 * Lazy prefix match so the separator x isn't swallowed by the prefix
 * (a greedy ([A-Za-z]+) would turn TLx4101 into prefix "TLx").
 * Non-matching input is returned trimmed, untouched.
 */
export function normalizeAdSetCode(raw: string): string {
  const trimmed = raw.trim();
  const m = trimmed.match(/^([A-Za-z]+?)[xX]?(\d+)$/);
  if (!m || !m[1] || !m[2]) return trimmed;
  return `${m[1].toUpperCase()}x${m[2]}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "derived state as of 14:42 UTC" — the freshness phrase every answer must cite. */
function freshnessNote(iso: string | null | undefined): string {
  if (!iso) return 'derived-state freshness unknown';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return `derived state as of ${iso}`;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `derived state as of ${hh}:${mm} UTC`;
}

// ---------------------------------------------------------------------------
// get_pipeline_summary
// ---------------------------------------------------------------------------

interface PipelineSummaryRow {
  client_code: string;
  live_sets: number;
  working_sets: number;
  sitting_sets: number;
  external_sets: number;
  data_gap_sets: number;
  real_overdue_tasks: number;
  gate_done_7d: number;
  avg_coverage_pct: number | null;
  freshness: string | null;
}

interface BucketRollupRow {
  client_code: string;
  bucket: string | null;
  sub_lane: string | null;
  sets: number;
  working: number;
  sitting: number;
}

export async function getPipelineSummary(input: { client?: string }): Promise<string> {
  const sb = getSupabase();
  const [summaryRes, rollupRes] = await Promise.all([
    sb.rpc('piper_pipeline_summary'),
    sb.rpc('piper_bucket_rollup'),
  ]);
  if (summaryRes.error) throw new Error(`piper_pipeline_summary failed: ${summaryRes.error.message}`);
  if (rollupRes.error) throw new Error(`piper_bucket_rollup failed: ${rollupRes.error.message}`);

  let summary = (summaryRes.data ?? []) as PipelineSummaryRow[];
  let rollup = (rollupRes.data ?? []) as BucketRollupRow[];

  const filter = input.client?.trim().toLowerCase();
  if (filter) {
    const allCodes = summary.map((r) => r.client_code);
    summary = summary.filter((r) => r.client_code.toLowerCase() === filter);
    rollup = rollup.filter((r) => r.client_code.toLowerCase() === filter);
    if (summary.length === 0) {
      return JSON.stringify({
        ok: false,
        error: `No brain coverage for client "${input.client}". Covered clients: ${allCodes.sort().join(', ')}. For uncovered clients fall back to query_aot_adsets / query_aot_tasks (live Notion).`,
      });
    }
  }

  const freshness = summary[0]?.freshness ?? null;

  // Group the bucket rollup per client so each client reads as one block.
  const bucketsByClient: Record<string, Omit<BucketRollupRow, 'client_code'>[]> = {};
  for (const row of rollup) {
    (bucketsByClient[row.client_code] ??= []).push({
      bucket: row.bucket,
      sub_lane: row.sub_lane,
      sets: row.sets,
      working: row.working,
      sitting: row.sitting,
    });
  }

  return JSON.stringify({
    ok: true,
    freshness,
    freshness_note: freshnessNote(freshness),
    client_filter: filter ? summary[0]?.client_code : null,
    clients: summary,
    buckets_by_client: bucketsByClient,
    note: 'Precomputed by the SQL brain, sorted worst-first. Render these numbers verbatim and cite the freshness note. Do NOT recompute from query_aot_* — for a single set deep-dive use get_adset_case.',
  });
}

// ---------------------------------------------------------------------------
// get_adset_case
// ---------------------------------------------------------------------------

interface CaseFrontier {
  notion_task_id?: string;
  task_name?: string | null;
  task_url?: string | null;
  owner_person_id?: string | null;
  owner_display?: string | null;
  owner_slack_id?: string | null;
  derived_status?: string | null;
  due_derived?: string | null;
  days_overdue?: number | null;
  days_in_status?: number | null;
  is_external?: boolean | null;
}

interface CasePing {
  kind?: 'client_chase' | 'pickup' | 'overdue_nudge' | 'none';
  target_person_id?: string | null;
  target_display?: string | null;
  target_slack_id?: string | null;
  reason?: string | null;
}

interface CasePayload {
  found?: boolean;
  note?: string;
  ad_set_code?: string;
  client_code?: string | null;
  derived_at?: string | null;
  data_confidence?: string | null;
  frontier?: CaseFrontier | null;
  ping?: CasePing | null;
  [key: string]: unknown;
}

/** Compose the prewritten one-line ping for a case payload. Exported for tests. */
export function composeSuggestedPing(
  code: string,
  payload: CasePayload,
): { kind: string; to: string; slack_id: string | null; message: string } | null {
  const ping = payload.ping;
  if (!ping?.kind || ping.kind === 'none') return null;

  const frontier = payload.frontier ?? {};
  const taskName = frontier.task_name ?? 'the frontier task';
  const due = shortDate(frontier.due_derived);
  const duePart = due ? `, due ${due}` : '';
  const sittingDays = frontier.days_in_status ?? null;
  const overdueDays = frontier.days_overdue ?? null;
  const to = ping.target_display ?? ping.target_person_id ?? 'owner';

  let message: string;
  switch (ping.kind) {
    case 'pickup':
      message =
        `${code} ${taskName} is ready for pickup` +
        (sittingDays !== null ? ` - frontier sitting ${sittingDays}d` : '') +
        `${duePart}. Can you grab it today?`;
      break;
    case 'client_chase':
      message =
        `${code} ${taskName} is with the client` +
        (overdueDays !== null && overdueDays > 0 ? ` - ${overdueDays}d past due` : duePart) +
        `. Worth a chase in the client channel?`;
      break;
    case 'overdue_nudge':
    default:
      message =
        `${code} ${taskName} is ` +
        (overdueDays !== null && overdueDays > 0 ? `${overdueDays}d past due` : `overdue${duePart}`) +
        ` - can you move it today?`;
      break;
  }

  return { kind: ping.kind, to, slack_id: ping.target_slack_id ?? null, message };
}

export async function getAdsetCase(input: { ad_set_code: string }): Promise<string> {
  const code = normalizeAdSetCode(input.ad_set_code ?? '');
  if (!code) {
    return JSON.stringify({ ok: false, error: 'ad_set_code is required (e.g. "TLx4101").' });
  }

  const { data, error } = await getSupabase().rpc('piper_adset_case', { p_code: code });
  if (error) throw new Error(`piper_adset_case failed: ${error.message}`);

  const payload = data as CasePayload | null;
  if (!payload || payload.found === false) {
    return JSON.stringify({
      ok: false,
      normalized_code: code,
      found: false,
      note:
        payload?.note ??
        `No brain case file for ${code} — the set is outside the derived working set (or the code is wrong). For forensic detail fall back to query_aot_adsets({ ad_id_code: '${code}' }) against live Notion.`,
    });
  }

  const suggestedPing = composeSuggestedPing(payload.ad_set_code ?? code, payload);

  return JSON.stringify({
    ok: true,
    normalized_code: code,
    freshness_note: freshnessNote(payload.derived_at),
    confidence: payload.data_confidence ?? null,
    case: payload,
    suggested_ping: suggestedPing,
    note: 'Render this case file directly — bucket, frontier task + holder, blocker, open tasks, recent events. Always include the suggested ping (when present), the confidence, and the freshness note. Do NOT re-derive any of this with query_aot_tasks.',
  });
}

// ---------------------------------------------------------------------------
// query_piper_state
// ---------------------------------------------------------------------------

interface TaskStateRow {
  notion_task_id: string;
  ad_set_code: string | null;
  canonical_type: string | null;
  raw_status: string | null;
  derived_status: string | null;
  owner_person_id: string | null;
  due_derived: string | null;
  revision_round: number | null;
  updated_at: string | null;
}

interface AdSetStateRow {
  ad_set_code: string;
  client_code: string | null;
  bucket: string | null;
  motion: string | null;
  data_confidence: string | null;
  coverage_pct: number | null;
  gate_done: boolean | null;
  predicted_ship: string | null;
  updated_at: string | null;
}

const QUERY_LIMIT = 200;

export async function queryPiperState(input: {
  client?: string;
  person?: string;
  ad_set_code?: string;
  status?: string;
}): Promise<string> {
  const sb = getSupabase();

  // Client filter lives on the ad-set table — resolve it to a code list first.
  let clientCodes: string[] | null = null;
  if (input.client?.trim()) {
    const { data, error } = await sb
      .from('piper_ad_set_state')
      .select('ad_set_code')
      .ilike('client_code', input.client.trim());
    if (error) throw new Error(`piper_ad_set_state read failed: ${error.message}`);
    clientCodes = (data ?? []).map((r) => r.ad_set_code as string);
    if (clientCodes.length === 0) {
      return JSON.stringify({
        ok: false,
        error: `No ad sets in the brain for client "${input.client}" (case-insensitive client_code match). Use get_pipeline_summary() for the covered-client list.`,
      });
    }
  }

  let q = sb.from('piper_task_state').select('*');
  if (input.ad_set_code?.trim()) q = q.eq('ad_set_code', normalizeAdSetCode(input.ad_set_code));
  if (input.person?.trim()) q = q.eq('owner_person_id', input.person.trim().toLowerCase());
  if (input.status?.trim()) q = q.eq('derived_status', input.status.trim().toLowerCase());
  if (clientCodes) q = q.in('ad_set_code', clientCodes);
  const { data, error } = await q
    .order('due_derived', { ascending: true, nullsFirst: false })
    .limit(QUERY_LIMIT);
  if (error) throw new Error(`piper_task_state read failed: ${error.message}`);
  const tasks = (data ?? []) as TaskStateRow[];

  // Join the ad-set rows for the codes we actually returned (chunked .in()).
  const codes = [...new Set(tasks.map((t) => t.ad_set_code).filter((c): c is string => !!c))];
  const adSets = new Map<string, AdSetStateRow>();
  for (let i = 0; i < codes.length; i += 100) {
    const chunk = codes.slice(i, i + 100);
    const { data: rows, error: err } = await sb
      .from('piper_ad_set_state')
      .select('ad_set_code, client_code, bucket, motion, data_confidence, coverage_pct, gate_done, predicted_ship, updated_at')
      .in('ad_set_code', chunk);
    if (err) throw new Error(`piper_ad_set_state join failed: ${err.message}`);
    for (const row of (rows ?? []) as AdSetStateRow[]) adSets.set(row.ad_set_code, row);
  }

  let freshness: string | null = null;
  const bump = (iso: string | null | undefined): void => {
    if (iso && (!freshness || iso > freshness)) freshness = iso;
  };

  const rows = tasks.map((t) => {
    const adSet = t.ad_set_code ? adSets.get(t.ad_set_code) : undefined;
    bump(t.updated_at);
    bump(adSet?.updated_at);
    return {
      notion_task_id: t.notion_task_id,
      ad_set_code: t.ad_set_code,
      canonical_type: t.canonical_type,
      derived_status: t.derived_status,
      raw_status: t.raw_status,
      owner_person_id: t.owner_person_id,
      due_derived: t.due_derived,
      revision_round: t.revision_round,
      client_code: adSet?.client_code ?? null,
      bucket: adSet?.bucket ?? null,
      motion: adSet?.motion ?? null,
      data_confidence: adSet?.data_confidence ?? null,
      gate_done: adSet?.gate_done ?? null,
    };
  });

  return JSON.stringify({
    ok: true,
    count: rows.length,
    truncated: rows.length === QUERY_LIMIT,
    freshness,
    freshness_note: freshnessNote(freshness),
    rows,
    note: 'Forensic filtered read over the derived state (piper_task_state ⋈ piper_ad_set_state). For "state of X" use get_pipeline_summary; for one set use get_adset_case. Cite the freshness note.',
  });
}
