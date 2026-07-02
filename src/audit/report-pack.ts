/**
 * Report pack — the audit's DETERMINISTIC fast tier (Ada 2.0 Phase C).
 *
 * WHY: Dan (2026-07-02): "the speed to the first truly magic moment correlates
 * with conversion." These five reports are Dan's confirmed build set from the
 * design spec (docs/ada-magic-audit-design-2026-06-25.md §menu) that need ZERO
 * LLM calls and ZERO new syncs — pure math over ad_daily/account_daily. They
 * land in seconds, before any Opus synthesis finishes, so the first screen of
 * the audit is already "invisible things about YOUR money" while the heavy
 * sections still cook. Every function is pure (rows in → section out) and
 * unit-tested (tests/report-pack.test.ts).
 *
 * BINDING RULES from the design spec (do not weaken):
 * - Fatigue = ROAS *TREND*, never age or frequency. Old + stable + good =
 *   EVERGREEN — protect it, never flag it for refresh (Dan 2026-06-25).
 * - Frequency-aware kill guard: below-breakeven at LOW frequency is likely
 *   true top-of-funnel acquisition — never recommend killing on ROAS alone.
 * - Statistical floor: suppress findings built on thin data (persona fix #4).
 * - A labelled "Next step:" on EVERY report (Francis's #1 theme).
 * - Plain operator voice in templates — say it like you'd say it on a call.
 * - Honest labels: name the granularity/window; never imply data we don't have.
 */

export interface PackAdRow {
  ad_id: string;
  ad_name: string | null;
  date: string;
  spend: number;
  impressions: number;
  purchases: number;
  purchase_value: number;
  results: number;
  frequency: number | null;
  hook_rate: number | null;
  hold_rate: number | null;
  /** Present on the 90d pull since Session D (optimization-event spend mapping). */
  adset_id?: string | null;
}

export interface PackAccountRow {
  date: string;
  spend: number;
  impressions: number;
  link_clicks: number;
  purchases: number;
  purchase_value: number;
  results: number;
}

export interface PackSection {
  summary: string;
  next_step: string;
  data: Record<string, unknown>;
  warnings?: string[];
}

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r1 = (v: number): number => Math.round(v * 10) / 10;
const pct = (num: number, den: number): number => (den > 0 ? r1((num / den) * 100) : 0);
const div = (num: number, den: number): number => (den > 0 ? num / den : 0);

/** Whether this account's economics read as ROAS (purchase value present) or cost-per-result. */
export function kpiMode(rows: Array<{ purchase_value: number; results: number }>): 'roas' | 'cpr' {
  const value = rows.reduce((s, r) => s + (r.purchase_value || 0), 0);
  return value > 0 ? 'roas' : 'cpr';
}

// ---------------------------------------------------------------------------
// 1. Spend concentration / key-man risk
// ---------------------------------------------------------------------------

export function computeConcentration(rows30: PackAdRow[]): PackSection {
  const byAd = new Map<string, { name: string; spend: number }>();
  let total = 0;
  for (const r of rows30) {
    total += r.spend || 0;
    const a = byAd.get(r.ad_id) ?? { name: r.ad_name ?? r.ad_id, spend: 0 };
    a.spend += r.spend || 0;
    if (r.ad_name) a.name = r.ad_name;
    byAd.set(r.ad_id, a);
  }
  const ads = [...byAd.values()].sort((a, b) => b.spend - a.spend);
  const share = (n: number) => pct(ads.slice(0, n).reduce((s, a) => s + a.spend, 0), total);
  const top1 = share(1);
  const top3 = share(3);
  const top10 = share(10);
  // HHI over spend shares (0..10000 convention)
  const hhi = Math.round(ads.reduce((s, a) => s + Math.pow((100 * a.spend) / (total || 1), 2), 0));

  // Benchmark bands (design spec: give "what good looks like", not just their number)
  const band = top3 >= 60 ? 'high' : top3 >= 40 ? 'elevated' : 'healthy';
  const bandLine =
    band === 'high'
      ? `Top-3 concentration above 60% is key-man risk territory — if the #1 ad fatigues, most of the account goes with it.`
      : band === 'elevated'
        ? `40–60% in the top 3 is workable but worth watching — most healthy accounts at this spend sit under 40%.`
        : `Under 40% in the top 3 is a healthy spread.`;

  const warnings: string[] = [];
  if (ads.length < 5 || total < 500) {
    warnings.push(`Thin base (${ads.length} ads with spend) — concentration reads are directional only.`);
  }

  return {
    summary:
      `Your top ad takes ${top1}% of the last 30 days' spend; the top 3 take ${top3}% and the top 10 take ${top10}% ` +
      `(${ads.length} ads spent anything at all). ${bandLine}`,
    next_step:
      band === 'high'
        ? `Get 2–3 genuinely different concepts live this month so the account isn't riding one creative. Start from what the top ad does well — don't clone it, vary the angle.`
        : band === 'elevated'
          ? `Keep at least one new concept entering test every other week so the top 3 never become the whole account.`
          : `Nothing urgent — keep the testing cadence that produced this spread.`,
    data: {
      window_days: 30,
      total_spend: Math.round(total),
      ads_with_spend: ads.length,
      top1_share_pct: top1,
      top3_share_pct: top3,
      top10_share_pct: top10,
      hhi,
      band,
      top_ads: ads.slice(0, 10).map((a) => ({ ad_name: a.name, spend: Math.round(a.spend), share_pct: pct(a.spend, total) })),
    },
    warnings: warnings.length ? warnings : undefined,
  };
}

// ---------------------------------------------------------------------------
// 2. Creative fatigue & runway (evergreen-aware — the binding rule)
// ---------------------------------------------------------------------------

export interface FatigueAd {
  ad_name: string;
  spend: number;
  in_window_age_days: number;
  kpi_first_half: number;
  kpi_second_half: number;
  /** The last-14-active-days level — where the ad is NOW (classification + runway use this). */
  kpi_recent: number;
  trend_pct: number; // second half vs first half, negative = worse
  avg_frequency: number | null;
  class: 'evergreen' | 'fatiguing' | 'fresh' | 'stable';
  days_to_breakeven: number | null;
  low_frequency_acquisition_guard: boolean;
}

export function computeFatigue(rows90: PackAdRow[], breakevenRoas = 1.0): PackSection & { data: { ads: FatigueAd[] } & Record<string, unknown> } {
  const mode = kpiMode(rows90);
  const byAd = new Map<string, PackAdRow[]>();
  for (const r of rows90) {
    const list = byAd.get(r.ad_id) ?? [];
    list.push(r);
    byAd.set(r.ad_id, list);
  }
  const totalSpend = rows90.reduce((s, r) => s + (r.spend || 0), 0);

  const ads: FatigueAd[] = [];
  for (const list of byAd.values()) {
    const spend = list.reduce((s, r) => s + r.spend, 0);
    const days = [...new Set(list.map((r) => r.date))].sort();
    // Statistical floor: enough days AND enough money to say anything.
    if (days.length < 10 || spend < Math.max(200, totalSpend * 0.01)) continue;

    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    const mid = Math.floor(sorted.length / 2);
    const rate = (part: PackAdRow[]): number => {
      const sp = part.reduce((s, r) => s + r.spend, 0);
      if (mode === 'roas') return div(part.reduce((s, r) => s + r.purchase_value, 0), sp);
      // cost-per-result mode: LOWER is better, so invert into a "results per spend" rate for trend math
      return div(part.reduce((s, r) => s + r.results, 0), sp);
    };
    const h1 = rate(sorted.slice(0, mid));
    const h2 = rate(sorted.slice(mid));
    const trendPct = h1 > 0 ? r1(((h2 - h1) / h1) * 100) : 0;
    const ageDays = Math.max(
      1,
      Math.round((Date.parse(days[days.length - 1]!) - Date.parse(days[0]!)) / 86_400_000) + 1,
    );
    // The half-window mean LAGS where the ad is NOW — a steady decliner can
    // average 1.65 while sitting at 1.2 today. Classify + runway off the
    // recent level (last 14 active days), trend off the halves.
    const lastDate = Date.parse(days[days.length - 1]!);
    const recentRows = sorted.filter((r) => lastDate - Date.parse(r.date) < 14 * 86_400_000);
    const recent = rate(recentRows);
    const freqVals = list.map((r) => r.frequency).filter((f): f is number => typeof f === 'number' && f > 0);
    const avgFreq = freqVals.length ? r2(freqVals.reduce((s, f) => s + f, 0) / freqVals.length) : null;

    // Classification — TREND-driven, never age-driven (the binding rule).
    const declining = trendPct <= -25;
    const nearFloor = mode === 'roas' ? recent < breakevenRoas * 1.5 : false;
    let cls: FatigueAd['class'];
    if (ageDays < 21) cls = 'fresh';
    else if (declining && (nearFloor || trendPct <= -40)) cls = 'fatiguing';
    else if (ageDays >= 60 && trendPct >= -15) cls = 'evergreen';
    else cls = 'stable';

    // Runway: only for ROAS mode, only when genuinely declining toward
    // breakeven — extrapolated from the RECENT level at the observed rate.
    let runway: number | null = null;
    if (mode === 'roas' && declining && recent > breakevenRoas && ageDays > 0) {
      const perDay = (h2 - h1) / (ageDays / 2); // decline rate across the two halves
      if (perDay < 0) runway = Math.max(1, Math.round((recent - breakevenRoas) / -perDay));
    }

    // The frequency-aware kill guard (binding): below breakeven + LOW frequency
    // is likely true acquisition — never recommend killing on ROAS alone.
    const belowBreakeven = mode === 'roas' && recent < breakevenRoas;
    const lowFreqGuard = belowBreakeven && avgFreq !== null && avgFreq < 1.5;

    ads.push({
      ad_name: list.find((r) => r.ad_name)?.ad_name ?? list[0]!.ad_id,
      spend: Math.round(spend),
      in_window_age_days: ageDays,
      kpi_first_half: r2(h1),
      kpi_second_half: r2(h2),
      kpi_recent: r2(recent),
      trend_pct: trendPct,
      avg_frequency: avgFreq,
      class: cls,
      days_to_breakeven: runway,
      low_frequency_acquisition_guard: lowFreqGuard,
    });
  }

  ads.sort((a, b) => b.spend - a.spend);
  const spendOf = (cls: FatigueAd['class']) => ads.filter((a) => a.class === cls).reduce((s, a) => s + a.spend, 0);
  const assessedSpend = ads.reduce((s, a) => s + a.spend, 0);
  const fatiguingShare = pct(spendOf('fatiguing'), assessedSpend);
  const evergreenShare = pct(spendOf('evergreen'), assessedSpend);
  const fatiguing = ads.filter((a) => a.class === 'fatiguing');
  const evergreens = ads.filter((a) => a.class === 'evergreen');
  const soonest = fatiguing.filter((a) => a.days_to_breakeven != null).sort((a, b) => a.days_to_breakeven! - b.days_to_breakeven!)[0];

  const kpiWord = mode === 'roas' ? 'ROAS' : 'results per spend';
  const summaryParts: string[] = [];
  if (fatiguing.length) {
    summaryParts.push(
      `${fatiguing.length} ad${fatiguing.length > 1 ? 's' : ''} carrying ${fatiguingShare}% of assessed spend ` +
      `${fatiguing.length > 1 ? 'are' : 'is'} genuinely fatiguing — ${kpiWord} down 25%+ from the first half of its run to the second` +
      (soonest?.days_to_breakeven ? `; at the current decline "${soonest.ad_name}" crosses breakeven in roughly ${soonest.days_to_breakeven} days` : '') + '.',
    );
  } else {
    summaryParts.push(`No ad with meaningful spend shows a real fatigue pattern right now (${kpiWord} trend, not age — long-running ads that still hold their number don't count).`);
  }
  if (evergreens.length) {
    summaryParts.push(
      `${evergreens.length} evergreen winner${evergreens.length > 1 ? 's' : ''} (${evergreenShare}% of assessed spend) — running 60+ days with the number holding. Protect these; do not "refresh" them.`,
    );
  }

  const warnings: string[] = [];
  const guarded = ads.filter((a) => a.low_frequency_acquisition_guard);
  if (guarded.length) {
    warnings.push(
      `${guarded.length} below-breakeven ad(s) run at low frequency (<1.5) — that pattern is usually true top-of-funnel acquisition, not waste. Don't kill on ROAS alone.`,
    );
  }

  return {
    summary: summaryParts.join(' '),
    next_step: fatiguing.length
      ? `Brief replacements for the fatiguing ad(s) now — the runway number is the deadline, and the evergreen list is the style guide for what this account rewards.`
      : `Nothing to refresh on trend. Re-check in 30 days — the runway math only means something when the decline is real.`,
    data: {
      window_days: 90,
      kpi_mode: mode,
      assessed_ads: ads.length,
      fatiguing_spend_share_pct: fatiguingShare,
      evergreen_spend_share_pct: evergreenShare,
      ads: ads.slice(0, 20),
    },
    warnings: warnings.length ? warnings : undefined,
  };
}

// ---------------------------------------------------------------------------
// 3. Creative cohorts by launch month (does the account live off old creative?)
// ---------------------------------------------------------------------------

export function computeCohorts(rows180: Array<Pick<PackAdRow, 'ad_id' | 'date' | 'spend'>>): PackSection {
  const firstSeen = new Map<string, string>();
  for (const r of rows180) {
    const cur = firstSeen.get(r.ad_id);
    if (!cur || r.date < cur) firstSeen.set(r.ad_id, r.date);
  }
  const month = (d: string) => d.slice(0, 7);
  const windowStart = rows180.reduce((min, r) => (r.date < min ? r.date : min), '9999-12-31');

  // monthly spend by launch-cohort
  const byMonth = new Map<string, Map<string, number>>(); // spend month → (cohort → spend)
  for (const r of rows180) {
    const m = month(r.date);
    const launch = firstSeen.get(r.ad_id)!;
    // Ads already running in the window's first days may predate it — honest label.
    const cohort = month(launch) === month(windowStart) ? `${month(windowStart)} or earlier` : month(launch);
    const row = byMonth.get(m) ?? new Map<string, number>();
    row.set(cohort, (row.get(cohort) ?? 0) + (r.spend || 0));
    byMonth.set(m, row);
  }
  const months = [...byMonth.keys()].sort();
  const series = months.map((m) => {
    const row = byMonth.get(m)!;
    const total = [...row.values()].reduce((s, v) => s + v, 0);
    return {
      month: m,
      total_spend: Math.round(total),
      cohorts: [...row.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([cohort, spend]) => ({ cohort, spend: Math.round(spend), share_pct: pct(spend, total) })),
    };
  });

  // Freshness read on the LAST full month: share of spend on cohorts launched in that month or the one before.
  const last = series[series.length - 1];
  let freshShare = 0;
  if (last) {
    const lastM = last.month;
    const prevM = months.length > 1 ? months[months.length - 2]! : lastM;
    freshShare = last.cohorts.filter((c) => c.cohort === lastM || c.cohort === prevM).reduce((s, c) => s + c.share_pct, 0);
  }
  const read =
    freshShare >= 40
      ? `a healthy refresh rhythm — new work earns budget quickly`
      : freshShare >= 15
        ? `a modest refresh rhythm — most budget still sits on older launches`
        : `an account living off old creative — recent launches barely take budget, which is exactly how a fatigue cliff builds`;

  return {
    summary:
      `Of this month's spend, ${r1(freshShare)}% goes to creatives launched in the last ~2 months — ${read}. ` +
      `The stacked view shows each month's spend split by WHEN its creatives first launched (launch month approximated by first spend day in the ${series.length}-month window).`,
    next_step:
      freshShare >= 40
        ? `Keep the launch cadence — and use the fatigue report to make sure the old cohorts still earning budget are evergreen, not decaying.`
        : `Set a monthly launch quota and track this chart month over month — the fresh-cohort share should climb toward 30–40% without touching proven evergreens.`,
    data: {
      window_months: series.length,
      fresh_cohort_share_pct: r1(freshShare),
      series,
    },
  };
}

// ---------------------------------------------------------------------------
// 4. CPM / auction-pressure trend (is it the market, or your creative?)
// ---------------------------------------------------------------------------

export function computeCostTrend(accRows90: PackAccountRow[]): PackSection {
  const sorted = [...accRows90].sort((a, b) => a.date.localeCompare(b.date));
  // weekly buckets
  const weeks = new Map<string, { spend: number; imps: number; clicks: number }>();
  for (const r of sorted) {
    const d = new Date(r.date + 'T00:00:00Z');
    const wk = new Date(d);
    wk.setUTCDate(d.getUTCDate() - d.getUTCDay()); // week starting Sunday
    const key = wk.toISOString().slice(0, 10);
    const w = weeks.get(key) ?? { spend: 0, imps: 0, clicks: 0 };
    w.spend += r.spend || 0;
    w.imps += r.impressions || 0;
    w.clicks += r.link_clicks || 0;
    weeks.set(key, w);
  }
  const series = [...weeks.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .filter(([, w]) => w.imps > 0)
    .map(([week, w]) => ({ week, cpm: r2(div(w.spend * 1000, w.imps)), ctr_link_pct: r2(pct(w.clicks, w.imps)), spend: Math.round(w.spend) }));

  if (series.length < 4) {
    return {
      summary: `Not enough weekly history to read a cost trend (${series.length} weeks with impressions).`,
      next_step: `Revisit once 4+ weeks of delivery are synced.`,
      data: { series },
      warnings: ['Thin window — cost trend suppressed.'],
    };
  }

  const firstQ = series.slice(0, Math.max(2, Math.floor(series.length / 3)));
  const lastQ = series.slice(-Math.max(2, Math.floor(series.length / 3)));
  const avg = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / (xs.length || 1);
  const cpmDelta = pct(avg(lastQ.map((s) => s.cpm)) - avg(firstQ.map((s) => s.cpm)), avg(firstQ.map((s) => s.cpm)));
  const ctrDelta = pct(avg(lastQ.map((s) => s.ctr_link_pct)) - avg(firstQ.map((s) => s.ctr_link_pct)), avg(firstQ.map((s) => s.ctr_link_pct)) || 1);

  // Decompose: CPM up + CTR holding = auction/market. CPM up + CTR down = the creative is earning worse delivery.
  let read: string;
  if (cpmDelta > 10 && ctrDelta < -10) read = `costs are up ${r1(cpmDelta)}% AND link CTR is down ${r1(-ctrDelta)}% — that combination points at the creative earning worse auctions, not just a pricier market`;
  else if (cpmDelta > 10) read = `CPM is up ${r1(cpmDelta)}% while CTR held — that reads as auction/market pressure, not something your creative did wrong`;
  else if (cpmDelta < -10) read = `CPM is DOWN ${r1(-cpmDelta)}% across the window — the market is getting cheaper for you`;
  else read = `CPM has been flat (within ±10%) across the window — cost pressure is not the story here`;

  return {
    summary: `Over the last ${series.length} weeks: ${read}. (Weekly averages, account level.)`,
    next_step:
      cpmDelta > 10 && ctrDelta < -10
        ? `Treat this as a creative problem first: fresher hooks lift CTR, better CTR buys cheaper auctions. Re-check CPM two weeks after new creative lands.`
        : cpmDelta > 10
          ? `Nothing to fix on your side — budget for the pricier auction or shift spend toward the placements/dayparts where CPM held.`
          : `No action needed — keep this chart as the baseline for the next audit.`,
    data: { series, cpm_delta_pct: r1(cpmDelta), ctr_delta_pct: r1(ctrDelta) },
  };
}

// ---------------------------------------------------------------------------
// 5. Day-of-week pattern (honest: daily granularity, not hourly)
// ---------------------------------------------------------------------------

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function computeDayOfWeek(accRows90: PackAccountRow[]): PackSection {
  const mode = kpiMode(accRows90);
  const byDow = new Map<number, { spend: number; value: number; results: number; days: number }>();
  for (const r of accRows90) {
    const dow = new Date(r.date + 'T00:00:00Z').getUTCDay();
    const b = byDow.get(dow) ?? { spend: 0, value: 0, results: 0, days: 0 };
    b.spend += r.spend || 0;
    b.value += r.purchase_value || 0;
    b.results += mode === 'roas' ? r.purchases || 0 : r.results || 0;
    b.days += 1;
    byDow.set(dow, b);
  }
  const rows = [...byDow.entries()]
    .map(([dow, b]) => ({
      day: DOW[dow]!,
      spend: Math.round(b.spend),
      kpi: mode === 'roas' ? r2(div(b.value, b.spend)) : r2(div(b.spend, b.results || 1)),
      n_days: b.days,
    }))
    .sort((a, b) => DOW.indexOf(a.day) - DOW.indexOf(b.day));

  const enough = rows.every((r) => r.n_days >= 8) && rows.length === 7;
  if (!enough) {
    return {
      summary: `Not enough history for a reliable day-of-week read (need 8+ of each weekday).`,
      next_step: `Revisit at the next audit once the window fills out.`,
      data: { kpi_mode: mode, rows },
      warnings: ['Thin window — day-of-week pattern suppressed.'],
    };
  }

  const better = (a: { kpi: number }, b: { kpi: number }) => (mode === 'roas' ? b.kpi - a.kpi : a.kpi - b.kpi);
  const ranked = [...rows].sort(better);
  const best = ranked[0]!;
  const worst = ranked[ranked.length - 1]!;
  const kpiLabel = mode === 'roas' ? 'Meta ROAS' : 'cost per result';
  const gap = mode === 'roas' ? pct(best.kpi - worst.kpi, worst.kpi || 1) : pct(worst.kpi - best.kpi, best.kpi || 1);

  return {
    summary:
      `${best.day} is your strongest day (${kpiLabel} ${best.kpi}) and ${worst.day} the weakest (${worst.kpi}) — a ${r1(gap)}% gap, ` +
      `measured across ~13 of each weekday. Daily granularity only — Meta doesn't give us clean hourly history, so this is day-of-week, not dayparting.`,
    next_step:
      gap >= 25
        ? `Worth acting on: shift a slice of budget toward ${best.day}/${ranked[1]!.day} via a campaign schedule or manual weekly rhythm, and re-measure in 30 days.`
        : `The gap is modest — don't build schedule complexity for ${r1(gap)}%; just keep it on the watchlist.`,
    data: { kpi_mode: mode, kpi_label: kpiLabel, rows, best_day: best.day, worst_day: worst.day, gap_pct: r1(gap) },
  };
}

// ---------------------------------------------------------------------------
// 6. Creative concept/angle ROAS (Dan's confirmed set — Session D)
// ---------------------------------------------------------------------------

/**
 * Group 30d spend/return by the Gemini messaging-angle tag. The join
 * (ad_id → content_hash → ai_analysis.messaging_angle) happens in the
 * orchestrator; this stays pure.
 *
 * BINDING (design spec, Francis "be smarter" fix): if the best-returning angle
 * is a discount/offer angle, do NOT say "do more discounts" — over-indexing on
 * discounts empties the funnel and trains the audience to wait. The report
 * flags it instead of scaling it.
 */
const DISCOUNT_ANGLE = /discount|offer|sale|promo|rabatt|deal|coupon|voucher|%\s*off|prozent/i;

export function computeConceptRoas(
  rows30: PackAdRow[],
  angleByAdId: Map<string, string>,
): PackSection {
  const mode = kpiMode(rows30);
  const byAngle = new Map<string, { spend: number; value: number; results: number; purchases: number; ads: Set<string> }>();
  let total = 0;
  let taggedSpend = 0;
  for (const r of rows30) {
    total += r.spend || 0;
    const angle = angleByAdId.get(r.ad_id);
    if (!angle) continue;
    taggedSpend += r.spend || 0;
    const a = byAngle.get(angle) ?? { spend: 0, value: 0, results: 0, purchases: 0, ads: new Set<string>() };
    a.spend += r.spend || 0;
    a.value += r.purchase_value || 0;
    a.results += r.results || 0;
    a.purchases += r.purchases || 0;
    a.ads.add(r.ad_id);
    byAngle.set(angle, a);
  }
  const coverage = pct(taggedSpend, total);

  if (byAngle.size < 2 || coverage < 25) {
    return {
      summary: `Not enough angle-tagged creative to read concept performance (${coverage}% of spend has an analyzed angle tag).`,
      next_step: `Run the creative-intelligence analyzer across the account's active ads, then re-audit — this report needs the Gemini angle tags.`,
      data: { coverage_pct: coverage, angles: [] },
      warnings: ['Thin angle coverage — concept read suppressed rather than guessed.'],
    };
  }

  // Statistical floor: angles below it fold into "other" instead of pretending precision.
  const floor = Math.max(200, taggedSpend * 0.03);
  const angles = [...byAngle.entries()]
    .map(([angle, a]) => ({
      angle,
      spend: Math.round(a.spend),
      spend_share_pct: pct(a.spend, taggedSpend),
      kpi: mode === 'roas' ? r2(div(a.value, a.spend)) : r2(div(a.spend, a.results || 1)),
      ads: a.ads.size,
      results: mode === 'roas' ? a.purchases : a.results,
      below_floor: a.spend < floor,
    }))
    .sort((a, b) => b.spend - a.spend);
  const assessed = angles.filter((a) => !a.below_floor);
  const kpiLabel = mode === 'roas' ? 'Meta ROAS' : 'cost per result';
  const better = (a: { kpi: number }, b: { kpi: number }) => (mode === 'roas' ? b.kpi - a.kpi : a.kpi - b.kpi);
  const ranked = [...assessed].sort(better);
  const best = ranked[0];
  const biggest = assessed[0];

  const warnings: string[] = [];
  let discountFlag = false;
  if (best && DISCOUNT_ANGLE.test(best.angle)) {
    discountFlag = true;
    warnings.push(
      `Best ${kpiLabel} sits on a discount/offer angle ("${best.angle}") — that is NOT a green light to scale discounts. ` +
      `Discount creative usually harvests demand the other angles created; over-indexing on it empties the funnel and trains buyers to wait for deals.`,
    );
  }
  if (coverage < 60) {
    warnings.push(`Angle tags cover ${coverage}% of spend — the untagged remainder is not represented here.`);
  }

  const underfunded = best && biggest && best.angle !== biggest.angle && !discountFlag ? best : null;

  return {
    summary: best && biggest
      ? `${assessed.length} creative angles carry real spend. Biggest budget: "${biggest.angle}" (${biggest.spend_share_pct}% of tagged spend, ${kpiLabel} ${biggest.kpi}). ` +
        (best.angle === biggest.angle
          ? `It's also the best performer — budget and performance agree here.`
          : `Best performer: "${best.angle}" (${kpiLabel} ${best.kpi} on ${best.spend_share_pct}% of tagged spend).`)
      : `Angle performance computed on ${coverage}% tag coverage.`,
    next_step: discountFlag
      ? `Scale the best NON-discount angle instead, and keep the discount angle as a harvest layer — watch new-customer share if you push it.`
      : underfunded
        ? `"${underfunded.angle}" out-earns the biggest budget line — shift test budget toward it and brief 2 new variations on that angle.`
        : `Budget already follows performance across angles — keep the current allocation and test a genuinely new angle for diversity.`,
    data: {
      window_days: 30,
      kpi_mode: mode,
      kpi_label: kpiLabel,
      coverage_pct: coverage,
      angles: angles.slice(0, 10),
      discount_flag: discountFlag,
    },
    warnings: warnings.length ? warnings : undefined,
  };
}

// ---------------------------------------------------------------------------
// 7. Optimization-event correctness (the "1 check / 2 X" panel)
// ---------------------------------------------------------------------------

export interface AdsetConfigLite {
  adset_id: string;
  adset_name: string;
  optimization_goal: string | null;
  custom_event_type: string | null;
  effective_status: string | null;
}

/** Soft signals that never pay the bills when real conversions exist. */
const SOFT_GOALS = new Set(['LINK_CLICKS', 'LANDING_PAGE_VIEWS', 'THRUPLAY', 'POST_ENGAGEMENT', 'REACH', 'IMPRESSIONS', 'PAGE_LIKES', 'VIDEO_VIEWS']);
const MID_FUNNEL_EVENTS = new Set(['ADD_TO_CART', 'INITIATED_CHECKOUT', 'CONTENT_VIEW', 'ADD_TO_WISHLIST', 'SEARCH']);

export function computeOptimizationEvents(
  adsets: AdsetConfigLite[],
  spendByAdset: Map<string, number>,
  totals30: { purchases: number; leads: number; purchase_value: number },
): PackSection {
  // What SHOULD this account optimize for? Revenue accounts → Purchase;
  // lead accounts → Lead. Mirrors the account-model classification.
  const wantsPurchase = totals30.purchase_value > 0 && totals30.purchases > 0;
  const wantsLead = !wantsPurchase && totals30.leads > totals30.purchases;
  const targetWord = wantsPurchase ? 'Purchase' : wantsLead ? 'Lead' : 'your real conversion';
  // Enough weekly conversion volume that optimizing on the real event is viable
  // (Meta's ~50/week learning heuristic, halved to be conservative per ad set).
  const conversionVolume = wantsPurchase ? totals30.purchases : totals30.leads;
  const volumeOk = conversionVolume >= 100; // ~25/week account-wide

  const rows = adsets
    .map((a) => {
      const spend = spendByAdset.get(a.adset_id) ?? 0;
      const goal = (a.optimization_goal ?? 'UNKNOWN').toUpperCase();
      const event = (a.custom_event_type ?? '').toUpperCase();
      let verdict: 'check' | 'x' | 'question';
      let reason: string;
      if (goal === 'OFFSITE_CONVERSIONS' && (event === 'PURCHASE' || (!wantsPurchase && event === 'LEAD'))) {
        verdict = 'check';
        reason = `Optimizing for ${event.toLowerCase()} — matches what the account actually sells.`;
      } else if (goal === 'OFFSITE_CONVERSIONS' && wantsPurchase && event === 'LEAD') {
        verdict = 'x';
        reason = `Optimizing for Lead on a revenue account — Meta hunts form-fillers, not buyers.`;
      } else if (goal === 'OFFSITE_CONVERSIONS' && MID_FUNNEL_EVENTS.has(event)) {
        verdict = volumeOk ? 'x' : 'question';
        reason = volumeOk
          ? `Optimizing for ${event.replace(/_/g, ' ').toLowerCase()} while the account records ${conversionVolume} ${targetWord.toLowerCase()}s in 30 days — Meta will find carts, not ${targetWord.toLowerCase()}s. Move to ${targetWord}.`
          : `Mid-funnel event — sometimes a deliberate learning-volume choice at ${conversionVolume} ${targetWord.toLowerCase()}s/30d; confirm it's intentional.`;
      } else if (SOFT_GOALS.has(goal)) {
        verdict = conversionVolume >= 30 ? 'x' : 'question';
        reason = conversionVolume >= 30
          ? `Optimizing for ${goal.replace(/_/g, ' ').toLowerCase()} while the pixel records real ${targetWord.toLowerCase()}s — this buys the cheapest clicks, not customers.`
          : `Soft goal — with thin conversion volume this may be deliberate; confirm the intent.`;
      } else if (goal === 'OFFSITE_CONVERSIONS' && !event) {
        verdict = 'question';
        reason = `Conversion-optimized but the event could not be read from the config.`;
      } else if (goal === 'APP_INSTALLS' || goal === 'VALUE' || goal === 'OFFSITE_CONVERSIONS' || goal === 'CONVERSATIONS' || goal === 'LEAD_GENERATION' || goal === 'QUALITY_LEAD') {
        verdict = 'check';
        reason = `Conversion-class goal (${goal.replace(/_/g, ' ').toLowerCase()}).`;
      } else {
        verdict = 'question';
        reason = `Unrecognized goal "${goal}" — read it manually before judging.`;
      }
      return {
        adset_name: a.adset_name,
        goal: goal + (event ? ` → ${event}` : ''),
        spend_30d: Math.round(spend),
        verdict,
        reason,
      };
    })
    .filter((r) => r.spend_30d > 0)
    .sort((a, b) => b.spend_30d - a.spend_30d);

  if (rows.length === 0) {
    return {
      summary: `No ad sets with spend could be matched to a readable optimization config.`,
      next_step: `Check the ad-set config read — this report needs it.`,
      data: { rows: [] },
      warnings: ['Ad-set config read returned nothing usable — report suppressed.'],
    };
  }

  const totalSpend = rows.reduce((s, r) => s + r.spend_30d, 0);
  const misSpend = rows.filter((r) => r.verdict === 'x').reduce((s, r) => s + r.spend_30d, 0);
  const checks = rows.filter((r) => r.verdict === 'check').length;
  const xs = rows.filter((r) => r.verdict === 'x').length;
  const qs = rows.filter((r) => r.verdict === 'question').length;

  return {
    summary: xs === 0
      ? `All ${rows.length} spending ad sets optimize for the right thing (${targetWord}-class events). This is the foundational setting most accounts get wrong — yours is clean.`
      : `${xs} of ${rows.length} spending ad sets optimize for the WRONG event — ${pct(misSpend, totalSpend)}% of spend (${Math.round(misSpend).toLocaleString('en-US')}) is telling Meta to hunt something other than ${targetWord.toLowerCase()}s.`,
    next_step: xs === 0
      ? `Nothing to change here — keep new ad sets on the same optimization event.`
      : `Switch the flagged ad sets to ${targetWord} optimization (or fold their budget into the correctly-set ones). Expect a learning reset — do it per ad set, not all at once.`,
    data: {
      window_days: 30,
      target_event: targetWord,
      counts: { check: checks, x: xs, question: qs },
      misoptimized_spend_share_pct: pct(misSpend, totalSpend),
      rows: rows.slice(0, 15),
    },
    warnings: qs > 0 ? [`${qs} ad set(s) marked "?" — plausible-but-unusual configs we won't guess about.`] : undefined,
  };
}

// ---------------------------------------------------------------------------
// 8. Provisional lead insights (choreography — the top of the page must never
//    be the LAST thing to arrive)
// ---------------------------------------------------------------------------

/**
 * Deterministic top-3 the moment the fast tier lands (UX review §2.2): worst
 * scorecard dimension · the fatiguing ad with its runway · concentration risk,
 * with strengths as fallback. The end-of-audit LLM ranking OVERWRITES these —
 * they are honest placeholders built from real numbers, flagged provisional so
 * the page can say "first read".
 */
export interface ProvisionalInsight {
  headline: string;
  detail: string;
  severity: 'risk' | 'opportunity' | 'info';
  section: string;
  provisional: true;
}

export function buildProvisionalInsights(
  scorecard: Array<{ dimension: string; band: string; position: string; lever: string; next_step: string; section_key: string }>,
  fatigueData: { ads?: FatigueAd[] } | undefined,
  concentrationData: { top3_share_pct?: number; band?: string; top_ads?: Array<{ ad_name: string; share_pct: number }> } | undefined,
): ProvisionalInsight[] {
  const out: ProvisionalInsight[] = [];

  const worst = scorecard.find((e) => e.band === 'weak');
  if (worst) {
    out.push({
      headline: worst.position,
      detail: `${worst.lever} ${worst.next_step}`,
      severity: 'risk',
      section: worst.section_key,
      provisional: true,
    });
  }

  const soonest = (fatigueData?.ads ?? [])
    .filter((a) => a.class === 'fatiguing' && a.days_to_breakeven != null)
    .sort((a, b) => a.days_to_breakeven! - b.days_to_breakeven!)[0];
  if (soonest) {
    out.push({
      headline: `"${soonest.ad_name}" crosses breakeven in ~${soonest.days_to_breakeven} days at its current decline`,
      detail: `It carries ${soonest.spend.toLocaleString('en-US')} of 90-day spend and its return has dropped ${Math.abs(soonest.trend_pct)}% from the first half of its run to the second. The runway number is the deadline for its replacement.`,
      severity: 'risk',
      section: 'creative_fatigue',
      provisional: true,
    });
  }

  const conc = concentrationData;
  if (out.length < 3 && conc && typeof conc.top3_share_pct === 'number' && (conc.band === 'high' || conc.band === 'elevated')) {
    const hero = conc.top_ads?.[0];
    out.push({
      headline: `Your top 3 ads carry ${conc.top3_share_pct}% of all spend`,
      detail: hero
        ? `"${hero.ad_name}" alone takes ${hero.share_pct}% — if it fatigues, most of the account goes with it. Concentration this high is a key-man risk, not a strategy.`
        : `Concentration this high is a key-man risk, not a strategy.`,
      severity: 'risk',
      section: 'spend_concentration',
      provisional: true,
    });
  }

  // Fallbacks so the strip still says something real on a healthy account.
  if (out.length < 3) {
    const evergreens = (fatigueData?.ads ?? []).filter((a) => a.class === 'evergreen');
    if (evergreens.length) {
      const share = evergreens.reduce((s, a) => s + a.spend, 0);
      out.push({
        headline: `${evergreens.length} evergreen winner${evergreens.length > 1 ? 's' : ''} — 60+ days old and still holding their number`,
        detail: `${Math.round(share).toLocaleString('en-US')} of assessed spend runs on proven creative that is NOT fatiguing. Protect these ads; whatever they do right is this account's style guide.`,
        severity: 'opportunity',
        section: 'creative_fatigue',
        provisional: true,
      });
    }
  }
  if (out.length < 3) {
    const strength = [...scorecard].reverse().find((e) => e.band === 'strong');
    if (strength) {
      out.push({
        headline: strength.position,
        detail: `${strength.lever} A genuine strength — protect what's producing it.`,
        severity: 'opportunity',
        section: strength.section_key,
        provisional: true,
      });
    }
  }

  return out.slice(0, 3);
}
