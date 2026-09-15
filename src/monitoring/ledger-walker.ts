/**
 * Loop 3 — the insight ledger's re-check walker (the "patient chart" half).
 *
 * The morning brief stores every mover as an `ada_insights` row: a claim, its
 * evidence, and a cheap re-check. Without a walker those rows are a write-only
 * diary — yesterday's CPA problem simply stops being mentioned, and the reader
 * never learns whether it was fixed, forgotten, or still burning money.
 *
 * So every morning, for each ACTIVE ad-level `daily-observation` from a PRIOR
 * data day, this module re-runs that one insight's own signal against the new
 * reporting window — one day on weekdays, the verified weekend on Monday — and
 * answers exactly one question: does the claim still hold?
 *   confirmed → the signal is still there (row stays `active`)
 *   resolved  → the signal is gone (row closes, `resolved_at` set)
 *   stale     → there is no longer enough delivery to judge it (row goes
 *               `stale` on a single-day walk; a rollup's un-judgeable outcome
 *               parks the row `active` instead — a thin weekend is not
 *               evidence a story ended)
 * The outcome is appended to the row's `trajectory` and reported to the reader
 * as a short "Follow-ups:" line. NEVER a delete — "what we used to believe and
 * why we stopped" is the never-repeat-mistakes memory.
 *
 * Mornings re-VERIFY, they don't re-derive: this is one ad against its own
 * trailing window, not `detectMovers` run again. The arithmetic mirrors the
 * detector's thresholds (>25% CPA move, 3-purchase floor, 8-point share shift)
 * on purpose — a signal that would no longer fire as a mover is a signal that
 * no longer holds.
 *
 * House rules the lines obey (Daniel, 2026-08-07): the currency amount leads
 * and a percentage is only its meaning · days are NAMED via the caller's
 * dayLabel, never "yesterday"/"today" · an ad already in today's Movers section
 * gets no follow-up line at all, because that story is being told once already.
 *
 * `walkAdInsights` is pure math + composition. All ledger I/O lives in
 * `applyWalkOutcomes`, which the brief calls in its writeToLedger block.
 */

import { getDaiSupabase } from '../integrations/dai-supabase.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Structural subset of the brief's AdDay — only what a re-check reads. */
export interface WalkAdDay {
  date: string;
  ad_id: string;
  spend: number;
  purchases: number;
  impressions: number;
  link_clicks: number;
}

/** An `ada_insights` row, as far as the walker cares. */
export interface LedgerInsight {
  id: string;
  entity_id: string;
  entity_name: string | null;
  evidence: Record<string, unknown>;
  derived_at: string;
}

export interface WalkedInsight {
  insightId: string;
  adId: string;
  adName: string;
  signalKind: string; // from evidence.kind
  outcome: 'confirmed' | 'resolved' | 'stale';
  /** A rollup's `stale` keeps the ledger row active — set only on rollups. */
  keepActive?: boolean;
  line: string | null; // user-facing follow-up line, null = not worth a line
  value: number | null; // the re-checked metric value, null when n/a
  evidence: Record<string, unknown>;
}

export interface WalkArgs {
  insights: LedgerInsight[];
  /** ALL of the account's ad rows in the window, any order. */
  ads: WalkAdDay[];
  yesterday: string; // the account-local reporting day (YYYY-MM-DD)
  /** The verified reporting-window days, ascending, `yesterday` last. Absent
   *  or single means the normal single-day walk; Monday's caller passes the
   *  weekend rollup's verified days so a story is judged on the whole window. */
  windowDates?: string[];
  accountSpendYesterday: number;
  /** Pooled account spend over `windowDates`; defaults to accountSpendYesterday. */
  accountSpendWindow?: number;
  trailingAvgDailySpend: number; // account level
  currency: string;
  /** Ads already covered by today's Movers section — no duplicate lines. */
  todaysMoverAdIds: Set<string>;
  dayLabel: (d: string) => string; // '2026-08-05' -> 'Wed, Aug 5'
}

// ---------------------------------------------------------------------------
// Thresholds — mirrored from detectMovers (agency-morning-brief.ts) on purpose
// ---------------------------------------------------------------------------

/** A CPA move smaller than this is inside normal noise for the detector too. */
const CPA_REL_THRESHOLD = 0.25;
/** The small-numbers rule: no CPA verdict under 3 purchases, either side. */
const MIN_PURCHASES_FOR_CPA = 3;
/** Share moves are judged in percentage POINTS of the account's day. */
const SHARE_SHIFT_THRESHOLD = 0.08;
/** "Still spending enough to be the same story" for a zero-results re-check. */
const SPEND_PERSISTENCE_FRACTION = 0.5;
/** Follow-ups are the brief's shortest section by design. */
const MAX_FOLLOW_UP_LINES = 3;
/** Older than this and the claim is history, not a live thread. */
const MAX_INSIGHT_AGE_DAYS = 10;

/** Closure first (that is the trust-building half), live signals next, and the
 *  un-judgeable last — it is the least useful thing a follow-up can say. */
const OUTCOME_RANK: Record<WalkedInsight['outcome'], number> = {
  resolved: 0,
  confirmed: 1,
  stale: 2,
};

// ---------------------------------------------------------------------------
// Helpers (same shapes as agency-morning-brief.ts / launch-verdicts.ts)
// ---------------------------------------------------------------------------

function money(value: number, currency: string, decimals = 0): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  } catch {
    return `${value.toFixed(decimals)} ${currency}`;
  }
}

/** Cost-per-result always carries cents — it is compared against a band. */
function cpaStr(value: number, currency: string): string {
  return money(value, currency, 2);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** A sub-1% share rounds to "0%", which reads as a bug. Say it honestly. */
function shareStr(share: number): string {
  const pct = share * 100;
  if (pct < 0.1) return 'under 0.1%';
  if (pct < 1) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

/** Whole days between two YYYY-MM-DD dates (UTC noon anchors dodge DST). */
function dayDiff(from: string, to: string): number {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

interface Recheck {
  outcome: WalkedInsight['outcome'];
  value: number | null;
  line: string;
  evidence: Record<string, unknown>;
}

/**
 * One WalkedInsight per re-checkable row. Every walked row carries an outcome
 * (so the ledger update is complete); only some carry a LINE — lines are the
 * scarce thing, rows are not.
 */
export function walkAdInsights(args: WalkArgs): WalkedInsight[] {
  const { insights, ads, yesterday, currency, todaysMoverAdIds, dayLabel } = args;
  const isRollup = (args.windowDates?.length ?? 0) > 1;

  // Per-ad series, ascending — the caller's ordering is not a contract.
  const byAd = new Map<string, WalkAdDay[]>();
  for (const row of ads) {
    const list = byAd.get(row.ad_id);
    if (list) list.push(row);
    else byAd.set(row.ad_id, [row]);
  }
  for (const list of byAd.values()) list.sort((a, b) => a.date.localeCompare(b.date));

  // The age floor is anchored on the REPORTING day, not the wall clock: a brief
  // replayed for an old date must walk the same rows it would have walked then.
  const oldestDerivedAt =
    Date.parse(`${yesterday}T12:00:00Z`) - MAX_INSIGHT_AGE_DAYS * 86_400_000;

  interface Candidate {
    insight: LedgerInsight;
    signalKind: string;
    originDate: string;
    recheck: Recheck;
  }

  const candidates: Candidate[] = [];
  for (const insight of insights) {
    const signalKind = strOrNull(insight.evidence?.kind);
    const originDate = strOrNull(insight.evidence?.date);
    // Only PRIOR data days: a stored claim about this same reporting day is
    // this morning's own signal, not a thread to re-check.
    if (!signalKind || !originDate || originDate >= yesterday) continue;
    const derivedMs = Date.parse(insight.derived_at ?? '');
    if (Number.isFinite(derivedMs) && derivedMs < oldestDerivedAt) continue;

    const recheck = recheckOne(
      signalKind,
      originDate,
      insight,
      byAd.get(insight.entity_id) ?? [],
      args,
    );
    if (!recheck) continue; // a kind this walker has no cheap re-check for
    candidates.push({ insight, signalKind, originDate, recheck });
  }

  // Oldest story first — it is the one that has earned the line, and it keeps
  // the dedupe below deterministic.
  candidates.sort((a, b) =>
    a.originDate === b.originDate
      ? a.insight.id.localeCompare(b.insight.id)
      : a.originDate.localeCompare(b.originDate),
  );

  /** A candidate with its sentence composed but not yet awarded a slot. */
  interface Staged {
    rank: number;
    originDate: string;
    wantsLine: boolean;
    composed: string;
    walked: WalkedInsight;
  }

  const staged: Staged[] = [];
  const seenThread = new Set<string>();
  for (const c of candidates) {
    const adId = c.insight.entity_id;
    const thread = `${adId}|${c.signalKind}`;
    // Two rules that silence a line but never an outcome:
    //   1. the Movers section already tells this ad's story today,
    //   2. the same ad+signal was flagged on several days — one thread, one line.
    const suppressed = todaysMoverAdIds.has(adId) || seenThread.has(thread);
    seenThread.add(thread);
    staged.push({
      rank: OUTCOME_RANK[c.recheck.outcome],
      originDate: c.originDate,
      wantsLine: !suppressed,
      composed: c.recheck.line,
      walked: {
        insightId: c.insight.id,
        adId,
        adName: c.insight.entity_name ?? adId,
        signalKind: c.signalKind,
        outcome: c.recheck.outcome,
        // A thin weekend is not evidence a story ended: a rollup's un-judgeable
        // thread survives to be re-judged on the next single day (the age
        // ceiling still bounds how long it can wait).
        ...(c.recheck.outcome === 'stale' && isRollup ? { keepActive: true } : {}),
        line: null, // awarded below, if a slot survives the cap
        value: c.recheck.value,
        evidence: c.recheck.evidence,
      },
    });
  }

  // Closures first, then still-live signals, then the un-judgeable; ties go to
  // the longest-running story.
  staged.sort((a, b) =>
    a.rank === b.rank ? a.originDate.localeCompare(b.originDate) : a.rank - b.rank,
  );

  let slots = MAX_FOLLOW_UP_LINES;
  for (const s of staged) {
    if (!s.wantsLine || slots <= 0) continue;
    s.walked.line = s.composed;
    slots -= 1;
  }
  return staged.map((s) => s.walked);
}

// ---------------------------------------------------------------------------
// Per-signal re-checks — the detector's arithmetic, one ad at a time
// ---------------------------------------------------------------------------

function recheckOne(
  signalKind: string,
  originDate: string,
  insight: LedgerInsight,
  rows: WalkAdDay[],
  args: WalkArgs,
): Recheck | null {
  const { yesterday, currency, dayLabel } = args;

  const windowDates = args.windowDates?.length ? args.windowDates : [yesterday];
  const windowStart = windowDates[0]!;
  const isRollup = windowDates.length > 1;
  const inWindow = new Set(windowDates);

  const todayRow = rows.find((r) => r.date === yesterday) ?? null;
  const daySpend = todayRow?.spend ?? 0;
  const dayPurchases = todayRow?.purchases ?? 0;

  const windowRows = rows.filter((r) => inWindow.has(r.date));
  const windowSpend = windowRows.reduce((s, r) => s + r.spend, 0);
  const windowPurchases = windowRows.reduce((s, r) => s + r.purchases, 0);
  const avgWindowSpend = windowSpend / windowDates.length;

  // The trail ends where the WINDOW starts — a weekend is never its own comparison.
  const trail = rows.filter((r) => r.date < windowStart && r.spend > 0).slice(-7);
  const trailSpend = trail.reduce((s, r) => s + r.spend, 0);
  const trailPurchases = trail.reduce((s, r) => s + r.purchases, 0);
  const trailAvgSpend = trail.length ? trailSpend / trail.length : 0;

  const name = truncate(insight.entity_name ?? insight.entity_id, 48);
  const when = dayLabel(originDate);
  const dayOfStory = dayDiff(originDate, yesterday) + 1;
  /** Names the pooled window in a line; empty on a single-day walk so those
   *  sentences stay word-for-word what they always were. */
  const overWindow = isRollup ? ` over ${dayLabel(windowStart)}–${dayLabel(yesterday)}` : '';

  const base: Record<string, unknown> = {
    recheck_of: signalKind,
    origin_date: originDate,
    as_of_date: yesterday,
    day_of_story: dayOfStory,
    day_spend: round2(daySpend),
    day_purchases: dayPurchases,
    ...(isRollup
      ? {
          window_dates: windowDates,
          window_spend: round2(windowSpend),
          window_purchases: windowPurchases,
        }
      : {}),
    trailing_avg_spend: round2(trailAvgSpend),
    trailing_days: trail.length,
  };

  if (signalKind === 'cpa_shift') {
    const head = `"${name}" — the CPA shift flagged ${when}`;
    if (
      windowSpend <= 0 ||
      windowPurchases < MIN_PURCHASES_FOR_CPA ||
      trailPurchases < MIN_PURCHASES_FOR_CPA
    ) {
      return {
        outcome: 'stale',
        value: null,
        line: `${head}: no longer enough delivery to judge${overWindow} (${money(windowSpend, currency)} spent, ${plural(windowPurchases, 'purchase')})`,
        evidence: { ...base, trailing_purchases: trailPurchases, judgeable: false },
      };
    }
    const windowCpa = windowSpend / windowPurchases;
    const trailCpa = trailSpend / trailPurchases;
    const rel = (windowCpa - trailCpa) / trailCpa;
    const originalRel = numOrNull(insight.evidence.rel_change);
    // Direction matters: an ad that swung from expensive to cheap has NOT
    // confirmed the expensive claim, however big the new move is.
    const sameDirection = originalRel === null || (rel >= 0) === (originalRel >= 0);
    const ev = {
      ...base,
      day_cpa: dayPurchases > 0 ? round2(daySpend / dayPurchases) : null,
      ...(isRollup ? { window_cpa: round2(windowCpa) } : {}),
      trailing_cpa: round2(trailCpa),
      rel_change: round2(rel),
      original_rel_change: originalRel,
      same_direction: sameDirection,
    };
    if (Math.abs(rel) > CPA_REL_THRESHOLD && sameDirection) {
      const word = rel > 0 ? 'still elevated' : 'still cheaper';
      return {
        outcome: 'confirmed',
        value: round2(windowCpa),
        line: `${head}: ${word} at ${cpaStr(windowCpa, currency)} vs ${cpaStr(trailCpa, currency)} usual${overWindow} — day ${dayOfStory} of the story`,
        evidence: ev,
      };
    }
    return {
      outcome: 'resolved',
      value: round2(windowCpa),
      line: `${head}: back in range at ${cpaStr(windowCpa, currency)} vs ${cpaStr(trailCpa, currency)} usual${overWindow}`,
      evidence: ev,
    };
  }

  if (signalKind === 'zero_results_on_spend') {
    const head = `"${name}" — the zero-purchase day flagged ${when}`;
    const originSpend = numOrNull(insight.evidence.yesterday_spend) ?? 0;
    const ev = { ...base, origin_spend: round2(originSpend) };
    // Persistence is judged per DAY (window average), so a pooled weekend does
    // not triple-count itself past the origin day's spend.
    if (
      windowSpend > 0 &&
      avgWindowSpend >= SPEND_PERSISTENCE_FRACTION * originSpend &&
      windowPurchases === 0
    ) {
      return {
        outcome: 'confirmed',
        value: 0,
        line: `${head}: still nothing back on ${money(windowSpend, currency)}${overWindow} — day ${dayOfStory} of the story`,
        evidence: ev,
      };
    }
    if (windowPurchases >= 1) {
      const purchaseDays = windowRows.filter((r) => r.purchases > 0);
      const landed =
        isRollup && purchaseDays.length === 1
          ? ` (landed ${dayLabel(purchaseDays[0]!.date)})`
          : '';
      return {
        outcome: 'resolved',
        value: windowPurchases,
        line: `${head}: converting again, ${plural(windowPurchases, 'purchase')} on ${money(windowSpend, currency)}${overWindow}${landed}`,
        evidence: ev,
      };
    }
    const collapsedTo = isRollup
      ? `${money(avgWindowSpend, currency)}/day${overWindow}`
      : money(windowSpend, currency);
    return {
      outcome: 'stale',
      value: null,
      line: `${head}: spend collapsed to ${collapsedTo} from ${money(originSpend, currency)} — nothing left to judge`,
      evidence: ev,
    };
  }

  if (signalKind === 'spend_share_shift') {
    const head = `"${name}" — the delivery shift flagged ${when}`;
    // Rows written before 2026-08-07 lack yesterday_spend in their evidence —
    // an unknown prior spend is omitted, never rendered as a zero.
    const originSpend = numOrNull(insight.evidence.yesterday_spend);
    // An ad at zero has not "returned to its usual share" — it stopped. Say so.
    if (windowSpend <= 0) {
      const was = originSpend !== null && originSpend > 0
        ? ` (was ${money(originSpend, currency)})`
        : '';
      return {
        outcome: 'stale',
        value: null,
        line: `${head}: not spending at all now${was}`,
        evidence: { ...base, origin_spend: originSpend !== null ? round2(originSpend) : null },
      };
    }
    const accountSpendWindow = args.accountSpendWindow ?? args.accountSpendYesterday;
    if (accountSpendWindow <= 0 || args.trailingAvgDailySpend <= 0 || !trail.length) {
      return {
        outcome: 'stale',
        value: null,
        line: `${head}: not enough account history to judge its share (${money(windowSpend, currency)} spent)`,
        evidence: { ...base, origin_spend: originSpend !== null ? round2(originSpend) : null },
      };
    }
    const windowShare = windowSpend / accountSpendWindow;
    const trailShare = trailAvgSpend / args.trailingAvgDailySpend;
    const shift = windowShare - trailShare;
    const originYShare = numOrNull(insight.evidence.yesterday_share);
    const originTShare = numOrNull(insight.evidence.trailing_share);
    const originShift =
      originYShare !== null && originTShare !== null ? originYShare - originTShare : null;
    const sameDirection = originShift === null || (shift >= 0) === (originShift >= 0);
    const ev = {
      ...base,
      origin_spend: originSpend !== null ? round2(originSpend) : null,
      day_share:
        args.accountSpendYesterday > 0 ? round2(daySpend / args.accountSpendYesterday) : null,
      ...(isRollup
        ? { window_share: round2(windowShare), account_spend_window: round2(accountSpendWindow) }
        : {}),
      trailing_share: round2(trailShare),
      share_shift: round2(shift),
      original_share_shift: originShift === null ? null : round2(originShift),
      same_direction: sameDirection,
    };
    const spendPhrase = isRollup
      ? `${money(avgWindowSpend, currency)}/day${overWindow}`
      : money(windowSpend, currency);
    if (Math.abs(shift) > SHARE_SHIFT_THRESHOLD && sameDirection) {
      return {
        outcome: 'confirmed',
        value: round2(windowShare),
        line: `${head}: still shifted, ${spendPhrase} vs ${money(trailAvgSpend, currency)}/day usual (${shareStr(trailShare)} → ${shareStr(windowShare)} of the account) — day ${dayOfStory} of the story`,
        evidence: ev,
      };
    }
    return {
      outcome: 'resolved',
      value: round2(windowShare),
      line: `${head}: back to its usual share, ${spendPhrase} vs ${money(trailAvgSpend, currency)}/day usual`,
      evidence: ev,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Ledger writes (DAI Supabase) — append to the chart, never delete from it
// ---------------------------------------------------------------------------

/**
 * Every walked row gets a trajectory entry and a last_checked_at, whether or
 * not it earned a line: the chart records the check, the brief reports the
 * interesting ones. `confirmed` deliberately stays `active` — the thread is
 * still live and must come back tomorrow.
 */
export async function applyWalkOutcomes(
  walked: WalkedInsight[],
  yesterday: string,
): Promise<number> {
  if (!walked.length) return 0;
  const dai = getDaiSupabase();
  const now = new Date().toISOString();
  let updated = 0;
  for (const w of walked) {
    const { data, error: readError } = await dai
      .from('ada_insights')
      .select('trajectory')
      .eq('id', w.insightId)
      .maybeSingle();
    if (readError) {
      logger.error({ err: readError.message, id: w.insightId }, 'ledger walk read failed');
      continue;
    }
    const trajectory = Array.isArray(data?.trajectory) ? (data!.trajectory as unknown[]) : [];
    trajectory.push({ date: yesterday, value: w.value, verdict: w.outcome });
    const { error } = await dai
      .from('ada_insights')
      .update({
        trajectory,
        last_checked_at: now,
        // keepActive parks a rollup's `stale` thread instead of closing it —
        // a thin weekend is not evidence a story ended. The trajectory still
        // records the stale verdict.
        status: w.outcome === 'confirmed' || w.keepActive ? 'active' : w.outcome,
        ...(w.outcome === 'resolved' ? { resolved_at: now } : {}),
      })
      .eq('id', w.insightId);
    if (error) logger.error({ err: error.message, id: w.insightId }, 'ledger walk update failed');
    else updated += 1;
  }
  return updated;
}
