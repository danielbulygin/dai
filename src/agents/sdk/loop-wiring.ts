/**
 * Loop wiring (Ada 2.0 Phase 1 integration) — connects the pure Phase-1 organs
 * (observe-after · matchDeadEnd · govern) to the LIVE tool bridge, so the loop
 * that serves real traffic actually observes its writes, looks itself up in the
 * failure organ, and is governed.
 *
 * WHY this exists as its own module: the organs are pure and unit-tested in
 * isolation (governor.ts, dead-end-match.ts, observe-after.ts); the bridge
 * (tool-bridge.ts) must stay a dumb adapter. Everything stateful about a RUN —
 * per-run confidence, failure history, which probes succeeded — lives here, in
 * one deterministic, unit-testable place (tests/loop-wiring.test.ts). The
 * composition mirrors tests/phase1-recovery.e2e.test.ts exactly; this module is
 * that proof made live.
 *
 * Confidence model (deterministic, no self-grading):
 *   0.9  retry after a KB-matched failure — the documented fix (auto-heal)
 *   0.9  launch_ads after a successful preview_ad_launch this run (probe→act)
 *   0.55 retry after ONE unmatched failure (medium → try-then-show: the fix is
 *        the model's own hypothesis, so show the work)
 *   0.4  after TWO+ unmatched failures of the same tool (low → options: stop
 *        hammering; present options to the operator instead)
 *   0.7  any other first-attempt write (medium → try-then-show; in the chat the
 *        operator's explicit "go" IS the confirm, so these still execute)
 */
import { govern, type GovernorVerdict } from './governor.js';
import { matchDeadEnd, type DeadEndMatch, type DeadEndRow } from './dead-end-match.js';
import { bareToolName, isReadTool } from './guard.js';
import { detectSoftError } from './observe-after.js';
import { getSupabase } from '../../integrations/supabase.js';
import { logger } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Failure organ — read side (Supabase ada_dead_ends), cached + fail-soft
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000;
let cache: { rows: DeadEndRow[]; at: number } | null = null;

/** Non-dismissed ada_dead_ends rows with a signal to match on. Fail-soft: []. */
export async function fetchDeadEndRows(): Promise<DeadEndRow[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;
  try {
    const { data, error } = await getSupabase()
      .from('ada_dead_ends')
      .select('id, kind, signal, resolution, status, client_code')
      .neq('status', 'dismissed')
      .not('signal', 'is', null)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    cache = { rows: (data ?? []) as DeadEndRow[], at: Date.now() };
    return cache.rows;
  } catch (err) {
    // Even logging is best-effort here — the logger lazily validates env, and a
    // fail-soft path must never be able to crash the run (caught by the tests).
    try { logger.warn({ err }, 'dead-end lookup: fetch failed (fail-soft)'); } catch { /* noop */ }
    return cache?.rows ?? [];
  }
}

/** For tests: reset the KB cache. */
export function resetDeadEndCache(): void {
  cache = null;
}

/** Look an error string up in the failure organ. Null when nothing matches. */
export async function lookupDeadEnd(errorText: string): Promise<DeadEndMatch | null> {
  if (!errorText) return null;
  const rows = await fetchDeadEndRows();
  return matchDeadEnd(errorText, rows);
}

/** The model-facing note appended to a failed write when the KB knows this failure. */
export function renderDeadEndNote(m: DeadEndMatch): string {
  const fix = (m.row.resolution ?? '').trim();
  const head = `[FAILURE-ORGAN MATCH] This failure is a KNOWN dead-end (${m.row.kind}${m.row.client_code ? `, client ${m.row.client_code}` : ''}; ${m.reason}).`;
  const body = fix
    ? `Documented fix: ${fix}\nApply the documented fix and retry the SAME write once. If the retry still fails, STOP and report the failure honestly — never claim success.`
    : `No documented fix yet (status: ${m.row.status ?? 'open'}). Reason from scratch; if you cannot recover, STOP and report the failure honestly — never claim success.`;
  return `${head}\n${body}`;
}

// ---------------------------------------------------------------------------
// Per-run state + the Governor gate for the bridge
// ---------------------------------------------------------------------------

export interface DeadEndMatchEvent {
  tool: string;
  kind: string;
  matchedOn: string[];
  resolution: string | null;
  deadEndId?: string;
}

export interface LoopRunState {
  /** preview_ad_launch completed cleanly this run (probe-then-act evidence). */
  previewSucceeded: boolean;
  /** Per bare tool: consecutive failures + whether the KB knew the failure. */
  failures: Map<string, { count: number; matchedDeadEnd: boolean }>;
  /** Every Governor verdict issued this run (audit / decision cards). */
  verdicts: GovernorVerdict[];
  /** Every failure-organ match this run (audit / decision cards). */
  deadEndMatches: DeadEndMatchEvent[];
}

export function newRunState(): LoopRunState {
  return { previewSucceeded: false, failures: new Map(), verdicts: [], deadEndMatches: [] };
}

/** Deterministic per-decision confidence — see the model in the header. */
export function assessConfidence(state: LoopRunState, bare: string): number {
  const f = state.failures.get(bare);
  if (f?.matchedDeadEnd) return 0.9;
  if (f && f.count >= 2) return 0.4;
  if (f) return 0.55;
  if (bare === 'launch_ads' && state.previewSucceeded) return 0.9;
  return 0.7;
}

export interface GovernGateResult {
  verdict: GovernorVerdict;
  /** Present ⇒ the bridge must NOT execute; return this as an isError result. */
  refusal?: string;
}

/**
 * Governor gate for the bridge: score a WRITE before it executes. Reads pass
 * untouched (undefined). 'blocked' (forbidden) and 'options' (irreversible /
 * high blast / low confidence) refuse execution with model-facing guidance.
 */
export function governWrite(state: LoopRunState, toolName: string): GovernGateResult | undefined {
  const bare = bareToolName(toolName);
  if (isReadTool(bare)) return undefined;
  const verdict = govern({ toolName, confidence: assessConfidence(state, bare) });
  state.verdicts.push(verdict);
  if (verdict.tier === 'blocked' || verdict.tier === 'options') {
    return { verdict, refusal: renderRefusal(verdict) };
  }
  return { verdict };
}

/** Model-facing refusal payload (soft-failure convention, so it's observable). */
export function renderRefusal(v: GovernorVerdict): string {
  return JSON.stringify({
    error: `Governor refused ${v.bareName} (${v.tier}): ${v.rationale}`,
    governor: {
      tier: v.tier,
      blast: v.blast,
      reversibility: v.reversibility,
      confidence: v.confidence,
    },
    guidance:
      v.tier === 'options'
        ? 'Do NOT retry this write autonomously. Present 2-3 concrete options to the operator (your recommendation first) and wait for their decision.'
        : 'This action is forbidden and can never run autonomously.',
  });
}

/**
 * Record a tool outcome into the run state. On failure, the caller passes the
 * failure-organ match (if any) so retry confidence escalates only when the fix
 * is documented. On success, failure history for that tool clears.
 */
export function noteToolOutcome(
  state: LoopRunState,
  toolName: string,
  failed: boolean,
  match: DeadEndMatch | null = null,
): void {
  const bare = bareToolName(toolName);
  if (!failed) {
    if (bare === 'preview_ad_launch') state.previewSucceeded = true;
    state.failures.delete(bare);
    return;
  }
  const prev = state.failures.get(bare);
  state.failures.set(bare, {
    count: (prev?.count ?? 0) + 1,
    matchedDeadEnd: !!match || (prev?.matchedDeadEnd ?? false),
  });
  if (match) {
    state.deadEndMatches.push({
      tool: bare,
      kind: match.row.kind,
      matchedOn: match.matchedOn,
      resolution: match.row.resolution ?? null,
      deadEndId: match.row.id,
    });
  }
}

/** Extract the best error text from a failed tool result for KB matching. */
export function failureText(result: string): string {
  return detectSoftError(result) ?? result;
}
