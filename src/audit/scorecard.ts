/**
 * "Where you stand" scorecard — the audit's spine (Ada 2.0 Phase C).
 *
 * WHY: the validated WOW mechanic (design spec 2026-06-25) is diagnostic
 * benchmarking — `percentile + decompose + name the lever + quantify the gap`.
 * An ecom pro's "holy shit" moment was exactly this shape. The scorecard puts
 * it at the TOP of the audit: 5 benchmarked dimensions, worst-first, each
 * naming its lever and linking to its section — ending on the one strength.
 *
 * HONESTY RULES (persona-test fixes, binding):
 * - The peer cohort is NAMED and REAL: "the N accounts on our desk, last 7
 *   days" — never a vague "industry benchmark" (fix #3: benchmark undefended).
 * - Rates only cross accounts (hook/hold %); money metrics (CPM) never cross
 *   currencies — those bands come from the account's OWN trajectory.
 * - No single 0-100 vanity score — the pro responded to the honest
 *   decomposition, so we stay decomposed (design spec, open-ideas note).
 * - Dimension name BEFORE the band (Francis: "Tracking — Bottom 10", never
 *   "Bottom 10 — Tracking").
 *
 * Pure module: corpus numbers come in as arguments; unit-tested.
 */

export interface CohortBand {
  /** Honest label, e.g. "16 accounts on our desk, last 7 days". */
  label: string;
  n: number;
  median: number;
  p25: number;
  p75: number;
}

export interface ScorecardEntry {
  key: string;
  /** Dimension name first (Francis rule). */
  dimension: string;
  value: number;
  unit: string;
  /** 'strong' | 'middle' | 'weak' — worst-first sort key. */
  band: 'strong' | 'middle' | 'weak';
  /** Position sentence, e.g. "top quartile of the 16 accounts on our desk". */
  position: string;
  /** The single lever (decomposition kills overwhelm). */
  lever: string;
  next_step: string;
  /** Which audit section carries the detail. */
  section_key: string;
  cohort: CohortBand | null;
  /** "How we got this" (pro-trust layer) — rendered behind an expandable. */
  derivation?: string;
  /**
   * The gap made concrete in the metric's OWN units (people, not invented
   * currency) — persona fix #1: quantify each gap separately, never sum.
   */
  quantified?: string;
  /**
   * "We corrected your own metric down" (rewarded-video forced views) — the
   * counter-vendor honesty beat. Set by the orchestrator when material.
   */
  correction?: { corrected_value: number; note: string };
}

const r1 = (v: number): number => Math.round(v * 10) / 10;

/** Percentile position of value within a small cohort (higher = better assumed by caller). */
export function cohortPosition(value: number, cohort: number[]): { pctile: number; median: number; p25: number; p75: number } {
  const xs = [...cohort].sort((a, b) => a - b);
  const at = (q: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.round(q * (xs.length - 1))))]!;
  const below = xs.filter((x) => x < value).length;
  return { pctile: Math.round((below / Math.max(1, xs.length - 1)) * 100), median: at(0.5), p25: at(0.25), p75: at(0.75) };
}

/**
 * Every dimension is OPTIONAL and nothing is defaulted: an omitted dimension
 * produces no entry and therefore no grading. That is the only way a caller can
 * refuse to grade something it cannot stand behind (a launch-cohort read on a
 * window shorter than it needs forces freshness to ~100% by construction, so
 * the caller omits `freshness` rather than passing a number it invented).
 */
export interface ScorecardInputs {
  /** Spend-weighted hook rate %, and the per-account cohort values (rates cross accounts safely). */
  hooks?: { value: number; cohortValues: number[]; cohortLabel: string; impressions30?: number };
  hold?: { value: number; cohortValues: number[]; cohortLabel: string };
  /**
   * From the cohort report: % of this month's spend on creatives launched in
   * the last ~2 months. Omit on a short window.
   *
   * `capBand: 'middle'` is a CEILING, not an override: freshness measures how
   * recently creative launched, so a portfolio whose recent launches are
   * already getting more expensive scores high on the very number that must
   * not be handed to a reader as something working. With the cap set the entry
   * can never grade strong, and its wording follows from the cap rather than
   * from the value. `capReason` is the caller's own citable clause (it has the
   * rows); without one the entry states the cap without naming a cause.
   */
  freshness?: { value: number; capBand?: 'middle'; capReason?: string };
  /** From concentration: top-3 spend share %. */
  concentration?: { value: number };
  /** From cost trend: CPM delta % over the window, exactly as that section computed it. Never re-derived here. */
  cpmTrend?: { value: number };
}

export function buildScorecard(inp: ScorecardInputs): ScorecardEntry[] {
  const entries: ScorecardEntry[] = [];

  const benchmarked = (
    key: string,
    dimension: string,
    unit: string,
    d: { value: number; cohortValues: number[]; cohortLabel: string },
    lever: string,
    nextStepWeak: string,
    sectionKey: string,
  ): void => {
    if (d.cohortValues.length < 5) return; // an undefended benchmark is worse than none
    const pos = cohortPosition(d.value, d.cohortValues);
    const band: ScorecardEntry['band'] = pos.pctile >= 60 ? 'strong' : pos.pctile >= 35 ? 'middle' : 'weak';
    const gapToMedian = pos.median > 0 ? r1(((pos.median - d.value) / pos.median) * 100) : 0;
    entries.push({
      key,
      dimension,
      value: r1(d.value),
      unit,
      band,
      position:
        band === 'strong'
          ? `${dimension} — top of ${d.cohortLabel} (better than ~${pos.pctile}% of them)`
          : band === 'middle'
            ? `${dimension} — middle of ${d.cohortLabel}`
            : `${dimension} — bottom of ${d.cohortLabel}, ${r1(gapToMedian)}% below their median`,
      lever,
      next_step:
        band === 'weak'
          ? nextStepWeak
          : band === 'middle'
            ? `Room to climb: closing the gap to the cohort's top quartile is the upside here.`
            : `A genuine strength — protect what's producing it.`,
      section_key: sectionKey,
      cohort: { label: d.cohortLabel, n: d.cohortValues.length, median: r1(pos.median), p25: r1(pos.p25), p75: r1(pos.p75) },
      derivation:
        `Your number is spend-weighted across every ad with video delivery in the last 30 days — big spenders count for more, ` +
        `exactly as your budget experiences it. The cohort is ${d.cohortLabel}, each account computed the same way. ` +
        `Bands: top 40% of the cohort reads strong, bottom 35% weak.`,
    });
  };

  if (inp.hooks) {
    benchmarked(
      'hooks', 'Hooks (3s view rate)', '%', inp.hooks,
      'The first 3 seconds of your videos — the opening, not the content.',
      `Closing the hook gap to the cohort median means meaningfully more people past 3 seconds on the SAME spend — new openings on your top spenders is the single lever.`,
      'creative_analysis',
    );
    // Make the gap concrete in PEOPLE on the same spend (never invented
    // currency — the persona test killed speculative € conversions).
    const entry = entries.find((e) => e.key === 'hooks');
    const imps = inp.hooks.impressions30;
    if (entry && entry.band !== 'strong' && entry.cohort && imps && imps > 0 && entry.cohort.median > entry.value) {
      const extraViewers = Math.round(((entry.cohort.median - entry.value) / 100) * imps);
      if (extraViewers >= 100) {
        entry.quantified =
          `At your last-30-day volume, closing the gap to the cohort median is ≈${extraViewers.toLocaleString('en-US')} more people ` +
          `past 3 seconds every month — same budget, different openings.`;
      }
    }
  }
  if (inp.hold) {
    benchmarked(
      'hold', 'Hold (15s of watchers)', '%', inp.hold,
      'Whether the video keeps the people the hook won.',
      `The hooks are winning attention your middles lose — tighten the 3-15s stretch of the top spenders before briefing anything new.`,
      'creative_analysis',
    );
  }
  if (inp.freshness) {
    const v = inp.freshness.value;
    const valueBand: ScorecardEntry['band'] = v >= 40 ? 'strong' : v >= 15 ? 'middle' : 'weak';
    // The cap is a ceiling: a value that would grade weak stays weak, and only
    // the entry sitting AT the ceiling explains itself from the cap.
    const capped = inp.freshness.capBand === 'middle' && valueBand !== 'weak';
    const band: ScorecardEntry['band'] = capped ? 'middle' : valueBand;
    const capReason = inp.freshness.capReason?.trim();
    const capClause = capReason && capReason.length > 0 ? capReason : 'the performance behind that spend does not support a higher grade';
    const baseDerivation = `The share of this month's spend on creatives that first spent in the last ~2 months — full method in the launch-cohorts report below.`;
    entries.push({
      key: 'freshness', dimension: 'Creative freshness', value: r1(v), unit: '% of spend on recent launches',
      band,
      position: capped
        ? `Creative freshness — recent launches carry ${r1(v)}% of this month's spend, graded middle and no higher: ${capClause}.`
        : band === 'strong' ? `Creative freshness — healthy refresh rhythm (${r1(v)}% of this month's spend on recent launches)`
        : band === 'middle' ? `Creative freshness — modest refresh rhythm (${r1(v)}%)`
        : `Creative freshness — the account is living off old creative (${r1(v)}% of spend on recent launches)`,
      lever: capped
        ? 'How quickly new creative earns budget, and whether it holds its cost once it does.'
        : 'How quickly new creative earns budget.',
      next_step: capped
        ? `Fix the cost on the launches already carrying the spend before briefing more of them.`
        : band === 'weak' ? `Set a monthly launch quota — the fatigue cliff builds exactly here.` : band === 'middle' ? `Nudge the launch cadence up; watch the cohort chart month over month.` : `Keep the cadence.`,
      section_key: 'creative_cohorts',
      cohort: null,
      derivation: capped
        ? `${baseDerivation} Held at middle whatever the share is: ${capClause}.`
        : baseDerivation,
    });
  }
  if (inp.concentration) {
    const v = inp.concentration.value;
    const band: ScorecardEntry['band'] = v < 40 ? 'strong' : v < 60 ? 'middle' : 'weak';
    entries.push({
      key: 'concentration', dimension: 'Budget concentration', value: r1(v), unit: '% of spend in top 3 ads',
      band,
      position:
        band === 'weak' ? `Budget concentration — one ad carries the account (top 3 ads = ${r1(v)}% of spend)`
        : band === 'middle' ? `Budget concentration — elevated (${r1(v)}% in the top 3)`
        : `Budget concentration — healthy spread (${r1(v)}% in the top 3)`,
      lever: 'How much of the account dies if the hero ad fatigues.',
      next_step: band === 'weak' ? `Get 2-3 genuinely different concepts live this month.` : band === 'middle' ? `Keep one new concept entering test every other week.` : `Keep the testing cadence.`,
      section_key: 'spend_concentration',
      cohort: null,
      derivation: `Your top 3 ads' share of the last 30 days' spend — full ranking in the concentration report below.`,
    });
  }
  if (inp.cpmTrend) {
    // The cost-trend section owns this figure. It is stated exactly as given
    // (no second rounding) and banded on the SAME plus/minus 10% threshold that
    // section's own verdict uses, so "flat" cannot mean one thing on the
    // scorecard and another in the report it links to.
    const v = inp.cpmTrend.value;
    const band: ScorecardEntry['band'] = v > 10 ? 'weak' : v < -10 ? 'strong' : 'middle';
    entries.push({
      key: 'cpm_trend', dimension: 'Cost trajectory (CPM, your own trend)', value: v, unit: '% vs start of window',
      band,
      position:
        band === 'weak' ? `Cost trajectory — CPM up ${v}% over the window`
        : band === 'strong' ? `Cost trajectory — CPM down ${Math.abs(v)}% over the window`
        : `Cost trajectory — CPM flat within 10% (${v}%) over the window`,
      lever: 'Whether rising costs are the market or your creative earning worse auctions (see the decomposition).',
      next_step: band === 'weak' ? `Read the CPM section: if CTR fell with it, it's a creative problem first.` : `Baseline for the next audit.`,
      section_key: 'cost_trends',
      cohort: null,
      derivation:
        `The CPM change the cost report measured, carried here unchanged: your own weekly CPM, the first third of the window ` +
        `against the last third, never another account's prices. Up more than 10% reads weak, down more than 10% reads strong, ` +
        `anything in between is flat. The decomposition is in that report.`,
    });
  }

  // Worst-first; keep one strength LAST (the design's "end on the one strength").
  const order = { weak: 0, middle: 1, strong: 2 } as const;
  entries.sort((a, b) => order[a.band] - order[b.band]);
  return entries;
}

// ---------------------------------------------------------------------------
// "How you compare" — the dedicated percentile-band chapter (Lumira §09).
//
// The validated WOW: hook/hold percentile bands against the NAMED desk cohort,
// with the gap made concrete. Reuses the scorecard's already-benchmarked rate
// dimensions (rates cross accounts safely — the binding integrity rule), so it
// invents no new cohort. Renders whichever rate bands the cohort supports
// (hooks always; hold when the warehouse has the coverage). Posts a STAT.
// ---------------------------------------------------------------------------

export interface ComparisonBand {
  key: string;
  dimension: string;
  you: number;
  median: number;
  p25: number;
  p75: number;
  band: 'strong' | 'middle' | 'weak';
  cohortLabel: string;
  n: number;
  /** median/you − 1, as a %: "≈X% more people past 3s on the same budget". */
  gap_pct: number | null;
  /** The absolute people framing carried from the scorecard, when present. */
  people_note?: string;
}

export interface ComparisonSection {
  summary: string;
  next_step: string;
  data: { bands: ComparisonBand[]; cohort_label: string | null } & Record<string, unknown>;
  derivation?: string;
}

/** Build the comparison chapter from the already-computed scorecard. Pure. */
export function buildComparisonSection(scorecard: ScorecardEntry[]): ComparisonSection {
  // Only rate dimensions cross accounts (unit '%', a real cohort). That is
  // hooks and hold — never money metrics (CPM never crosses currencies).
  const RATE_KEYS = new Set(['hooks', 'hold']);
  const bands: ComparisonBand[] = scorecard
    .filter((e) => RATE_KEYS.has(e.key) && e.cohort && e.unit === '%')
    .map((e) => {
      const c = e.cohort!;
      const gap = e.band !== 'strong' && c.median > e.value && e.value > 0 ? r1((c.median / e.value - 1) * 100) : null;
      return {
        key: e.key,
        dimension: e.dimension,
        you: e.value,
        median: c.median,
        p25: c.p25,
        p75: c.p75,
        band: e.band,
        cohortLabel: c.label,
        n: c.n,
        gap_pct: gap,
        people_note: e.quantified,
      };
    });

  const cohortLabel = bands[0]?.cohortLabel ?? null;
  const hook = bands.find((b) => b.key === 'hooks');
  const hold = bands.find((b) => b.key === 'hold');

  // Decompose when we have both signals (the pro's "content works, people
  // aren't getting to it" read); otherwise speak to the one band we can defend.
  const parts: string[] = [];
  if (hook && hold) {
    if (hook.band === 'weak' && hold.band !== 'weak') {
      parts.push(
        `Your hooks land below ${cohortLabel} while your hold rate keeps pace — the content itself is working, people just aren't getting into it. The opening is the lever.`,
      );
    } else if (hold.band === 'weak' && hook.band !== 'weak') {
      parts.push(
        `Your hooks win attention at or above ${cohortLabel}, but your hold rate lags — the openings pull people in and the middle loses them. Tighten the 3–15s stretch, not the hook.`,
      );
    } else if (hook.band === 'weak' && hold.band === 'weak') {
      parts.push(`Both your hook and hold rates sit below ${cohortLabel} — the openings and the middles are each leaving people behind.`);
    } else {
      parts.push(`Your hook and hold rates both hold their own against ${cohortLabel} — a genuine creative strength.`);
    }
  } else if (hook) {
    parts.push(
      hook.band === 'weak'
        ? `Your hook rate sits below ${cohortLabel} — the first three seconds are where you're losing people.`
        : hook.band === 'middle'
          ? `Your hook rate sits mid-pack against ${cohortLabel} — room to climb.`
          : `Your hook rate is a genuine strength against ${cohortLabel}.`,
    );
  }
  // The quantified gap (pure arithmetic) on the weakest rate band.
  const weakest = bands.filter((b) => b.gap_pct != null).sort((a, b) => (b.gap_pct ?? 0) - (a.gap_pct ?? 0))[0];
  if (weakest) {
    const dim = weakest.key === 'hooks' ? 'past 3 seconds' : 'through the middle of the video';
    parts.push(
      `Closing your ${weakest.key === 'hooks' ? 'hook' : 'hold'} gap to their median is roughly ${weakest.gap_pct}% more people ${dim} on the same budget.`,
    );
    if (weakest.people_note) parts.push(weakest.people_note);
  }

  // End on the strength (scorecard rule).
  const strength = bands.find((b) => b.band === 'strong');
  const next_step = weakest
    ? weakest.key === 'hooks'
      ? `Brief new openings for your top spenders — the content already holds, so more people past the first three seconds converts on the budget you're already spending.`
      : `Tighten the 3–15s stretch of your top spenders — the hooks are already winning the click.`
    : strength
      ? `Protect what's producing this — it's the edge to build the next tests around.`
      : `Baseline for the next audit — watch these bands move in 30 days.`;

  return {
    summary: parts.join(' '),
    next_step,
    data: { bands, cohort_label: cohortLabel },
    derivation:
      `Each band is the middle half (25th–75th percentile) of ${cohortLabel ?? 'the comparison accounts'}, with the median marked and your number plotted on it. ` +
      `Every account is spend-weighted the same way — big spenders count for more, exactly as your budget experiences it. ` +
      `The gap is pure arithmetic: their median ÷ your rate − 1. Rates only — we never compare another account's spend or revenue, only how their creative performs.`,
  };
}
