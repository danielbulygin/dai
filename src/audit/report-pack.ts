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
