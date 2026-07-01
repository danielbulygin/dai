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
}

const r1 = (v: number): number => Math.round(v * 10) / 10;

/** Percentile position of value within a small cohort (higher = better assumed by caller). */
export function cohortPosition(value: number, cohort: number[]): { pctile: number; median: number; p25: number; p75: number } {
  const xs = [...cohort].sort((a, b) => a - b);
  const at = (q: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.round(q * (xs.length - 1))))]!;
  const below = xs.filter((x) => x < value).length;
  return { pctile: Math.round((below / Math.max(1, xs.length - 1)) * 100), median: at(0.5), p25: at(0.25), p75: at(0.75) };
}

export interface ScorecardInputs {
  /** Spend-weighted hook rate %, and the per-account cohort values (rates cross accounts safely). */
  hooks?: { value: number; cohortValues: number[]; cohortLabel: string };
  hold?: { value: number; cohortValues: number[]; cohortLabel: string };
  /** From the cohort report: % of this month's spend on creatives launched in the last ~2 months. */
  freshness?: { value: number };
  /** From concentration: top-3 spend share %. */
  concentration?: { value: number };
  /** From cost trend: CPM delta % over the window (own trajectory — never cross-currency). */
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
    });
  };

  if (inp.hooks) {
    benchmarked(
      'hooks', 'Hooks (3s view rate)', '%', inp.hooks,
      'The first 3 seconds of your videos — the opening, not the content.',
      `Closing the hook gap to the cohort median means meaningfully more people past 3 seconds on the SAME spend — new openings on your top spenders is the single lever.`,
      'creative_analysis',
    );
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
    const band: ScorecardEntry['band'] = v >= 40 ? 'strong' : v >= 15 ? 'middle' : 'weak';
    entries.push({
      key: 'freshness', dimension: 'Creative freshness', value: r1(v), unit: '% of spend on recent launches',
      band,
      position:
        band === 'strong' ? `Creative freshness — healthy refresh rhythm (${r1(v)}% of this month's spend on recent launches)`
        : band === 'middle' ? `Creative freshness — modest refresh rhythm (${r1(v)}%)`
        : `Creative freshness — the account is living off old creative (${r1(v)}% of spend on recent launches)`,
      lever: 'How quickly new creative earns budget.',
      next_step: band === 'weak' ? `Set a monthly launch quota — the fatigue cliff builds exactly here.` : band === 'middle' ? `Nudge the launch cadence up; watch the cohort chart month over month.` : `Keep the cadence.`,
      section_key: 'creative_cohorts',
      cohort: null,
    });
  }
  if (inp.concentration) {
    const v = inp.concentration.value;
    const band: ScorecardEntry['band'] = v < 40 ? 'strong' : v < 60 ? 'middle' : 'weak';
    entries.push({
      key: 'concentration', dimension: 'Budget concentration', value: r1(v), unit: '% of spend in top 3 ads',
      band,
      position:
        band === 'weak' ? `Budget concentration — key-man risk (top 3 ads = ${r1(v)}% of spend)`
        : band === 'middle' ? `Budget concentration — elevated (${r1(v)}% in the top 3)`
        : `Budget concentration — healthy spread (${r1(v)}% in the top 3)`,
      lever: 'How much of the account dies if the hero ad fatigues.',
      next_step: band === 'weak' ? `Get 2-3 genuinely different concepts live this month.` : band === 'middle' ? `Keep one new concept entering test every other week.` : `Keep the testing cadence.`,
      section_key: 'spend_concentration',
      cohort: null,
    });
  }
  if (inp.cpmTrend) {
    const v = inp.cpmTrend.value;
    const band: ScorecardEntry['band'] = v <= 0 ? 'strong' : v <= 15 ? 'middle' : 'weak';
    entries.push({
      key: 'cpm_trend', dimension: 'Cost trajectory (CPM, your own trend)', value: r1(v), unit: '% vs start of window',
      band,
      position:
        band === 'strong' ? `Cost trajectory — CPM flat-to-falling (${r1(v)}%) over the window`
        : band === 'middle' ? `Cost trajectory — CPM drifting up ${r1(v)}%`
        : `Cost trajectory — CPM up ${r1(v)}% over the window`,
      lever: 'Whether rising costs are the market or your creative earning worse auctions (see the decomposition).',
      next_step: band === 'weak' ? `Read the CPM section: if CTR fell with it, it's a creative problem first.` : `Baseline for the next audit.`,
      section_key: 'cost_trends',
      cohort: null,
    });
  }

  // Worst-first; keep one strength LAST (the design's "end on the one strength").
  const order = { weak: 0, middle: 1, strong: 2 } as const;
  entries.sort((a, b) => order[a.band] - order[b.band]);
  return entries;
}
