/**
 * Loop 2 — the launch watch's verdict half (board card 82).
 *
 * The detection half already ships inside the morning brief: an ad's first
 * spending day is announced and opens a `launch-watch` row on the ledger.
 * This module decides what to SAY about that watch on every following morning.
 *
 * The design rule Daniel reshaped the card around (2026-08-07, "I sometimes
 * also check earlier to get an early indicator"): verdicts are EVIDENCE-BASED,
 * not calendar-based. Each verdict type fires the moment there is enough
 * evidence for THAT type — starvation is knowable in 24-48h, money-out-nothing-
 * back the moment spend passes ~2x the expected cost per result, a real CPA
 * verdict only at >=3 results (the small-numbers rule). The day 1/3/7
 * checkpoints survive only as a floor: if nothing fired, those mornings still
 * carry an honest status instead of silence.
 *
 * Two honesty rules are load-bearing here:
 *   - A floored ad set's spend is not a vote. If a minimum-spend floor is
 *     forcing delivery, the line says so instead of crediting the auction; if
 *     floors are simply unknown, the line makes no claim about them at all.
 *   - Early good news is a feature (that is half the point of the early peek),
 *     but a 1-2 purchase CPA is always labelled "early, not a verdict".
 *
 * House rules applied to every line: the currency amount leads and the
 * percentage is only its meaning, days are named ("day 3", or the caller's
 * dayLabel) and never "yesterday"/"today", and every number arrives with what
 * it means.
 *
 * Pure math + composition; all I/O stays in the caller (agency-morning-brief).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WatchInput {
  insightId: string; // the ada_insights row id for this watch
  adId: string;
  adName: string;
  firstSpendDate: string; // YYYY-MM-DD
}

export interface LaunchAdDay {
  date: string;
  ad_id: string;
  adset_id: string | null;
  spend: number;
  impressions: number;
  link_clicks: number;
  hook_rate: number | null;
  purchases: number;
}

export interface LaunchVerdict {
  insightId: string;
  adId: string;
  adName: string;
  kind:
    | 'meta_picked_up' // day 1-2 positive: auction chose it
    | 'starved' // age >= 2 days, trivial delivery
    | 'first_conversion' // cumulative purchases crossed 0 -> >=1
    | 'early_cpa' // 1-2 purchases: show CPA, labelled early
    | 'money_out_nothing_back' // cumulative spend >= 2x expected CPA, 0 purchases
    | 'taking_off' // >=3 purchases, CPA at/under reference
    | 'flat' // >=3 purchases, CPA above reference
    | 'checkpoint'; // day 1/3/7 floor when nothing else fired
  line: string; // one user-facing line, no leading bullet
  next: string; // one advisory move ("no action — …" counts)
  isFinal: boolean; // true closes the watch
  ageDays: number;
  evidence: Record<string, unknown>;
}

export interface EvaluateArgs {
  watches: WatchInput[];
  ads: LaunchAdDay[]; // ALL the account's ad rows in the window, ascending by date
  yesterday: string; // the account-local reporting day (YYYY-MM-DD)
  accountSpendYesterday: number;
  trailingAvgDailySpend: number; // account level
  accountTrailingCpa: number | null; // pooled trailing 7d CPA, null if <3 purchases
  expectedCpa: number | null; // bands.happy ?? config target ?? null
  /** How to NAME expectedCpa in lines — 'your happy band' only when it truly
   *  is a band; a single config target should say 'your target'. */
  expectedCpaLabel?: string;
  currency: string;
  flooredAdsetIds?: Set<string>; // ad sets with min-spend floors, when known
  dayLabel: (d: string) => string; // '2026-08-05' -> 'Wed, Aug 5'
}

// ---------------------------------------------------------------------------
// Money + number helpers (same shape as agency-morning-brief.ts)
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

/** Spend figures: cents matter on the tiny numbers a starved launch produces,
 *  and never on a four-figure one. */
function spendStr(value: number, currency: string): string {
  return money(value, currency, Math.abs(value) < 100 ? 2 : 0);
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

/** Whole days between two YYYY-MM-DD dates (UTC noon anchors dodge DST). */
function dayDiff(from: string, to: string): number {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** The CPA's meaning against its reference: percentages only ever as meaning. */
function vsReference(cpa: number, reference: number): string {
  if (reference <= 0) return 'vs';
  const rel = (cpa - reference) / reference;
  if (Math.abs(rel) <= 0.05) return 'right on';
  return rel > 0
    ? `${Math.round(rel * 100)}% over`
    : `${Math.round(-rel * 100)}% under`;
}

/** A sub-1% share rounds to "0%", which reads as a bug. Say it honestly. */
function shareStr(share: number): string {
  const pct = share * 100;
  if (pct < 0.1) return 'under 0.1%';
  if (pct < 1) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * One verdict per watched ad at most — the highest-priority one that fires.
 * A quiet ad on a non-checkpoint day gets no entry at all: silence beats a
 * line that says nothing.
 */
export function evaluateLaunches(args: EvaluateArgs): LaunchVerdict[] {
  const byAd = new Map<string, LaunchAdDay[]>();
  for (const row of args.ads) {
    const list = byAd.get(row.ad_id);
    if (list) list.push(row);
    else byAd.set(row.ad_id, [row]);
  }

  const out: LaunchVerdict[] = [];
  for (const watch of args.watches) {
    const verdict = evaluateWatch(watch, byAd.get(watch.adId) ?? [], args);
    if (verdict) out.push(verdict);
  }
  return out;
}

function evaluateWatch(
  watch: WatchInput,
  adRows: LaunchAdDay[],
  args: EvaluateArgs,
): LaunchVerdict | null {
  const { yesterday, currency, dayLabel } = args;

  const ageDays = dayDiff(watch.firstSpendDate, yesterday) + 1;
  // A watch whose first spend is in the future (clock skew, bad row) is not
  // evidence of anything.
  if (ageDays < 1) return null;

  const rows = adRows.filter(
    (r) => r.date >= watch.firstSpendDate && r.date <= yesterday,
  );
  const cumSpend = rows.reduce((s, r) => s + r.spend, 0);
  const cumPurchases = rows.reduce((s, r) => s + r.purchases, 0);
  const cumImpressions = rows.reduce((s, r) => s + r.impressions, 0);
  const cumClicks = rows.reduce((s, r) => s + r.link_clicks, 0);

  const yRow = rows.find((r) => r.date === yesterday) ?? null;
  const ySpend = yRow?.spend ?? 0;
  const yPurchases = yRow?.purchases ?? 0;
  const priorPurchases = cumPurchases - yPurchases;

  // The reference the verdict is judged against, and where it came from —
  // a line that quotes a number must be able to name its source.
  const reference = args.expectedCpa ?? args.accountTrailingCpa ?? null;
  const refFromBand = args.expectedCpa !== null && args.expectedCpa !== undefined;
  const refLabel = refFromBand
    ? (args.expectedCpaLabel ?? 'your happy band')
    : "the account's own 7d CPA";
  const refSource = refFromBand
    ? 'expected_cpa'
    : args.accountTrailingCpa !== null
      ? 'account_trailing_cpa'
      : 'none';

  const name = truncate(watch.adName, 48);
  const cpa = cumPurchases > 0 ? cumSpend / cumPurchases : null;

  const evidence: Record<string, unknown> = {
    first_spend_date: watch.firstSpendDate,
    as_of_date: yesterday,
    age_days: ageDays,
    cum_spend: round2(cumSpend),
    cum_purchases: cumPurchases,
    cum_impressions: cumImpressions,
    cum_link_clicks: cumClicks,
    cum_cpa: cpa === null ? null : round2(cpa),
    day_spend: round2(ySpend),
    day_purchases: yPurchases,
    day_hook_rate: yRow?.hook_rate ?? null,
    reference_cpa: reference,
    reference_source: refSource,
  };

  const mk = (
    kind: LaunchVerdict['kind'],
    line: string,
    next: string,
    isFinal: boolean,
    extra: Record<string, unknown> = {},
  ): LaunchVerdict => ({
    insightId: watch.insightId,
    adId: watch.adId,
    adName: watch.adName,
    kind,
    line,
    next,
    isFinal,
    ageDays,
    evidence: { ...evidence, ...extra },
  });

  // 1. Money out, nothing back — the loudest thing a launch can do.
  //    Day-1 grace: conversions lag spend by hours, so a single day at 2x the
  //    reference is "too early", not an alarm — unless it is already at 4x.
  if (
    reference !== null &&
    cumPurchases === 0 &&
    cumSpend >= 2 * reference &&
    (ageDays >= 2 || cumSpend >= 4 * reference)
  ) {
    const refPhrase = refFromBand
      ? `${args.expectedCpaLabel ?? 'your happy band'} is ${cpaStr(reference, currency)}`
      : `the account's own 7d CPA is ${cpaStr(reference, currency)}`;
    const span = ageDays === 1 ? 'spent on day 1' : `in over ${plural(ageDays, 'day')}`;
    return mk(
      'money_out_nothing_back',
      `"${name}" — ${spendStr(cumSpend, currency)} ${span}, 0 purchases (${refPhrase})`,
      'worth a look now — creative or destination, before more money follows',
      false,
      { multiple_of_reference: round2(cumSpend / reference) },
    );
  }

  // 2. A real CPA verdict — only at >=3 purchases (the small-numbers rule).
  if (cumPurchases >= 3 && cpa !== null) {
    if (reference === null) {
      // No band, and the account itself has too few purchases to be a yardstick.
      // The number is real; the judgement isn't, and the line says so.
      return mk(
        'checkpoint',
        `"${name}" — ${cpaStr(cpa, currency)} per purchase on ${plural(cumPurchases, 'purchase')} by day ${ageDays}, ${spendStr(cumSpend, currency)} in — no reference to judge against`,
        'set a cost-per-result target and this becomes a verdict — the number is real, the judgement is not',
        ageDays >= 7,
      );
    }
    const takingOff = cpa <= reference * 1.1;
    const meaning = `${vsReference(cpa, reference)} ${refLabel} of ${cpaStr(reference, currency)}`;
    if (takingOff) {
      return mk(
        'taking_off',
        `"${name}" — ${cpaStr(cpa, currency)} CPA on ${plural(cumPurchases, 'purchase')} by day ${ageDays}, ${meaning} — taking off`,
        'earning its budget — a scale test is the natural next step',
        ageDays >= 3,
      );
    }
    return mk(
      'flat',
      `"${name}" — ${cpaStr(cpa, currency)} CPA on ${plural(cumPurchases, 'purchase')} by day ${ageDays}, ${meaning} — flat, not a winner yet`,
      'let it finish the week unless it worsens — re-checked daily',
      ageDays >= 3,
    );
  }

  // 3. Starved — Meta is not choosing it, whatever the creative is worth.
  const expectedStretchSpend = args.trailingAvgDailySpend * ageDays;
  if (ageDays >= 2 && cumSpend < 0.005 * expectedStretchSpend) {
    const share = expectedStretchSpend > 0 ? cumSpend / expectedStretchSpend : 0;
    return mk(
      'starved',
      `"${name}" — ${spendStr(cumSpend, currency)} in ${plural(ageDays, 'day')} since ${dayLabel(watch.firstSpendDate)}, ${shareStr(share)} of the account's ${spendStr(expectedStretchSpend, currency)} over that stretch — starved`,
      "Meta isn't choosing it — check placement/audience overlap or give it its own room",
      ageDays >= 3,
      { share_of_account_stretch: round2(share), stretch_spend: round2(expectedStretchSpend) },
    );
  }

  // 4. The first conversion — an announceable event on its own.
  if (priorPurchases === 0 && yPurchases >= 1 && cumPurchases < 3) {
    const early =
      cpa !== null
        ? ` · ${cpaStr(cpa, currency)} per purchase (early, not a verdict)`
        : '';
    return mk(
      'first_conversion',
      `"${name}" — first purchase on ${dayLabel(yesterday)}, day ${ageDays} — ${spendStr(cumSpend, currency)} in so far${early}`,
      'a good early sign — verdict when it reaches 3',
      false,
    );
  }

  // 5. Meta picked it up — delivery as an auction vote, but only when no
  //    minimum-spend floor is forcing that delivery.
  if (
    ageDays <= 2 &&
    args.accountSpendYesterday > 0 &&
    ySpend > 0 &&
    ySpend >= 0.02 * args.accountSpendYesterday
  ) {
    const share = ySpend / args.accountSpendYesterday;
    const floors = args.flooredAdsetIds;
    // An ABSENT set means floors are unknown — the line then makes no claim
    // about the auction either way. A PROVIDED set (even empty) means the
    // caller checked: "no floors" is knowledge and earns the vote claim.
    const floorsKnown = floors !== undefined;
    const adsetId = yRow?.adset_id ?? null;
    const floored = floorsKnown && adsetId !== null && floors.has(adsetId);
    let line: string;
    if (floored) {
      line = `"${name}" — ${spendStr(ySpend, currency)} on day ${ageDays} (${shareStr(share)} of the account's day), but its ad set carries a minimum-spend floor — that delivery is forced, so it is not the auction voting for the ad`;
    } else if (floorsKnown) {
      line = `"${name}" — Meta gave it ${spendStr(ySpend, currency)} (${shareStr(share)} of the account's day) on day ${ageDays}, with no spend floor forcing it — the auction chose it`;
    } else {
      line = `"${name}" — Meta gave it ${spendStr(ySpend, currency)} (${shareStr(share)} of the account's day) on day ${ageDays}`;
    }
    return mk(
      'meta_picked_up',
      line,
      'delivery is there — watching response next',
      false,
      {
        day_share_of_account: round2(share),
        adset_id: yRow?.adset_id ?? null,
        floors_known: floorsKnown,
        adset_floored: floored,
      },
    );
  }

  // 6. Early CPA — shown because early good news is the point, labelled
  //    because 1-2 purchases is not a verdict.
  if (cumPurchases >= 1 && cumPurchases <= 2 && cpa !== null) {
    const nextMove =
      reference !== null
        ? cpa <= reference * 1.1
          ? 'looking good so far — verdict at 3 purchases'
          : 'looking expensive so far — verdict at 3 purchases'
        : 'no reference on file to judge it against — verdict at 3 purchases';
    return mk(
      'early_cpa',
      `"${name}" — ${cpaStr(cpa, currency)} CPA on ${plural(cumPurchases, 'purchase')} by day ${ageDays} — early, not a verdict`,
      nextMove,
      false,
    );
  }

  // 7. The calendar floor. Nothing fired, so the checkpoint mornings carry an
  //    honest status rather than silence — and day 7 closes the watch.
  if (ageDays === 1 || ageDays === 3 || ageDays === 7) {
    const next =
      ageDays >= 7
        ? 'closing the watch — a week in without enough evidence to judge; it rides the daily movers check from here'
        : 'no action — watching for delivery and the first purchases';
    return mk(
      'checkpoint',
      `"${name}" — day ${ageDays}: ${spendStr(cumSpend, currency)} in, ${plural(cumPurchases, 'purchase')} — too early to judge`,
      next,
      ageDays >= 7,
    );
  }

  return null;
}
