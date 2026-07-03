/**
 * Magic-audit report pack — EXTENSION SET (Session G, 2026-07-02).
 *
 * Dan's ruling: "all the reports done for TL" — the full designed set from
 * docs/ada-magic-audit-design-2026-06-25.md that never made it into the
 * engine. Same contract as report-pack.ts: pure functions, PackSection out,
 * honest floors, a `derivation` on everything (pro-trust layer), operator
 * voice, goal-aware (roas vs cpr), and binding rules respected:
 *   - AN/rewarded video is flagged, never silently blended (design §2).
 *   - Discount/offer angles never get "do more discounts".
 *   - Absence of data → suppress honestly, never guess.
 */

import type { PackSection, PackAdRow, AdsetConfigLite } from './report-pack.js';
import { kpiMode } from './report-pack.js';

const r1 = (v: number): number => Math.round(v * 10) / 10;
const r2 = (v: number): number => Math.round(v * 100) / 100;
const pct = (num: number, den: number): number => (den > 0 ? r1((num / den) * 100) : 0);
const div = (num: number, den: number): number => (den > 0 ? num / den : 0);
const money = (v: number, currency: string): string =>
  `${Math.round(v).toLocaleString('en-US')}${currency ? ` ${currency}` : ''}`;

// ---------------------------------------------------------------------------
// A. Placement breakdown — where the spend actually goes (design §2, Dan
//    emphatic on the Audience Network flag)
// ---------------------------------------------------------------------------

export interface PlacementInsightRow {
  publisher_platform: string;
  platform_position: string;
  spend: number;
  impressions: number;
  purchases: number;
  purchase_value: number;
  leads: number;
}

export function computePlacementBreakdown(rows: PlacementInsightRow[], currency: string): PackSection {
  const totalSpend = rows.reduce((s, r) => s + (r.spend || 0), 0);
  if (totalSpend < 100 || rows.length === 0) {
    return {
      summary: 'Not enough placement-level delivery in the window to read a split.',
      next_step: 'Re-audit once the account has meaningful spend in the last 30 days.',
      data: { platforms: [], positions: [] },
      warnings: ['Thin placement data — read suppressed rather than guessed.'],
    };
  }
  const mode = rows.some((r) => (r.purchase_value || 0) > 0) ? 'roas' : 'cpr';
  const kpiLabel = mode === 'roas' ? 'Meta ROAS' : 'cost per result';

  const byPlatform = new Map<string, { spend: number; impressions: number; value: number; results: number }>();
  const byPosition = new Map<string, { spend: number; impressions: number }>();
  for (const r of rows) {
    const p = byPlatform.get(r.publisher_platform) ?? { spend: 0, impressions: 0, value: 0, results: 0 };
    p.spend += r.spend || 0;
    p.impressions += r.impressions || 0;
    p.value += r.purchase_value || 0;
    p.results += (mode === 'roas' ? r.purchases : r.purchases || r.leads) || 0;
    byPlatform.set(r.publisher_platform, p);
    const posKey = `${r.publisher_platform} · ${r.platform_position}`;
    const q = byPosition.get(posKey) ?? { spend: 0, impressions: 0 };
    q.spend += r.spend || 0;
    q.impressions += r.impressions || 0;
    byPosition.set(posKey, q);
  }

  const platforms = [...byPlatform.entries()]
    .map(([platform, a]) => ({
      platform,
      spend: Math.round(a.spend),
      spend_share_pct: pct(a.spend, totalSpend),
      kpi: a.spend > 0 ? (mode === 'roas' ? r2(div(a.value, a.spend)) : a.results > 0 ? r2(div(a.spend, a.results)) : null) : null,
    }))
    .sort((a, b) => b.spend - a.spend);
  const positions = [...byPosition.entries()]
    .map(([position, a]) => ({ position, spend: Math.round(a.spend), spend_share_pct: pct(a.spend, totalSpend) }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 8);

  const an = platforms.find((p) => p.platform === 'audience_network');
  const rewarded = rows.filter((r) => r.platform_position.toLowerCase().includes('rewarded'));
  const rewardedSpendPct = pct(rewarded.reduce((s, r) => s + (r.spend || 0), 0), totalSpend);

  const warnings: string[] = [];
  if (an && an.spend_share_pct >= 1) {
    warnings.push(
      `${an.spend_share_pct}% of spend runs on Audience Network — usually the worst placement for quality traffic. ` +
        `Check its ${kpiLabel} above before letting Advantage+ keep buying it.` +
        (rewardedSpendPct >= 0.5 ? ` ${rewardedSpendPct}% of spend sits on rewarded video (forced views — inflates view metrics).` : ''),
    );
  }

  const top = platforms[0]!;
  return {
    summary:
      `${top.platform} carries ${top.spend_share_pct}% of spend` +
      (platforms.length > 1 ? `; ${platforms.length} platforms deliver in total.` : '.') +
      (an && an.spend_share_pct >= 1 ? ` Audience Network takes ${an.spend_share_pct}%.` : ' No meaningful Audience Network spend — good.'),
    next_step:
      an && an.spend_share_pct >= 3 && an.kpi != null
        ? `Audience Network is ${an.spend_share_pct}% of budget — compare its ${kpiLabel} (${an.kpi}) against your feed placements and cap it if it underperforms.`
        : `The split looks sane — re-check after any placement-strategy change; Advantage+ shifts this quietly.`,
    data: {
      window_days: 30,
      kpi_mode: mode,
      kpi_label: kpiLabel,
      total_spend: Math.round(totalSpend),
      currency,
      platforms,
      positions,
      audience_network_share_pct: an?.spend_share_pct ?? 0,
      rewarded_spend_share_pct: rewardedSpendPct,
    },
    warnings: warnings.length ? warnings : undefined,
    derivation:
      `One placement-broken-down account insights pull (last 30 days) from Meta directly — spend, impressions and ` +
      `conversions per publisher platform and position, summed here with no modeling. ${kpiLabel} per platform = that ` +
      `platform's returns against its own spend. Positions under the top 8 by spend are not listed.`,
  };
}

// ---------------------------------------------------------------------------
// B. Audience breakdown — age / gender / geography (design §2.3)
// ---------------------------------------------------------------------------

export interface DemoInsightRow {
  age: string;
  gender: string;
  spend: number;
  impressions: number;
  purchases: number;
  purchase_value: number;
  leads: number;
}

export interface GeoInsightRow {
  country: string;
  spend: number;
  impressions: number;
  purchases: number;
  purchase_value: number;
  leads: number;
}

export function computeAudienceBreakdown(demo: DemoInsightRow[], geo: GeoInsightRow[], currency: string): PackSection {
  const totalSpend = demo.reduce((s, r) => s + (r.spend || 0), 0);
  if (totalSpend < 100) {
    return {
      summary: 'Not enough delivery in the window for an audience split.',
      next_step: 'Re-audit once the account has meaningful spend in the last 30 days.',
      data: { age_bands: [], genders: [], countries: [] },
      warnings: ['Thin demographic data — read suppressed rather than guessed.'],
    };
  }
  const mode = demo.some((r) => (r.purchase_value || 0) > 0) ? 'roas' : 'cpr';
  const kpiLabel = mode === 'roas' ? 'Meta ROAS' : 'cost per result';
  const kpiOf = (spend: number, value: number, results: number): number | null =>
    mode === 'roas' ? (spend > 0 ? r2(div(value, spend)) : null) : results > 0 ? r2(div(spend, results)) : null;

  const agg = <T>(rows: T[], keyOf: (r: T) => string, of: (r: T) => { spend: number; value: number; results: number }) => {
    const m = new Map<string, { spend: number; value: number; results: number }>();
    for (const r of rows) {
      const k = keyOf(r);
      const a = m.get(k) ?? { spend: 0, value: 0, results: 0 };
      const v = of(r);
      a.spend += v.spend;
      a.value += v.value;
      a.results += v.results;
      m.set(k, a);
    }
    return [...m.entries()]
      .map(([key, a]) => ({
        key,
        spend: Math.round(a.spend),
        spend_share_pct: pct(a.spend, totalSpend),
        kpi: kpiOf(a.spend, a.value, a.results),
      }))
      .sort((a, b) => b.spend - a.spend);
  };
  const ofDemo = (r: DemoInsightRow) => ({
    spend: r.spend || 0,
    value: r.purchase_value || 0,
    results: (mode === 'roas' ? r.purchases : r.purchases || r.leads) || 0,
  });

  const ageBands = agg(demo.filter((r) => r.age && r.age !== 'unknown'), (r) => r.age, ofDemo).sort((a, b) =>
    a.key.localeCompare(b.key),
  );
  const genders = agg(demo.filter((r) => r.gender && r.gender !== 'unknown'), (r) => r.gender, ofDemo);
  const geoTotal = geo.reduce((s, r) => s + (r.spend || 0), 0);
  const countries = [...geo]
    .map((r) => ({
      key: r.country,
      spend: Math.round(r.spend || 0),
      spend_share_pct: pct(r.spend || 0, geoTotal),
      kpi: kpiOf(r.spend || 0, r.purchase_value || 0, (mode === 'roas' ? r.purchases : r.purchases || r.leads) || 0),
    }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 6);

  // The design's core move: name the best-returning cell that's underfunded.
  const FLOOR = Math.max(150, totalSpend * 0.05);
  const assessedAges = ageBands.filter((a) => a.spend >= FLOOR && a.kpi != null);
  const better = (a: { kpi: number | null }, b: { kpi: number | null }) =>
    mode === 'roas' ? (b.kpi ?? 0) - (a.kpi ?? 0) : (a.kpi ?? Infinity) - (b.kpi ?? Infinity);
  const bestAge = [...assessedAges].sort(better)[0];
  const biggestAge = assessedAges[0];
  const underfunded = bestAge && biggestAge && bestAge.key !== biggestAge.key && bestAge.spend_share_pct < biggestAge.spend_share_pct ? bestAge : null;

  return {
    summary:
      (biggestAge
        ? `Most budget sits on ${biggestAge.key} (${biggestAge.spend_share_pct}% of spend, ${kpiLabel} ${biggestAge.kpi}).`
        : `Delivery is spread across age bands.`) +
      (underfunded ? ` ${underfunded.key} returns better (${kpiLabel} ${underfunded.kpi}) on ${underfunded.spend_share_pct}% of spend — underfunded.` : '') +
      (countries.length > 1 ? ` Top market: ${countries[0]!.key} at ${countries[0]!.spend_share_pct}% of spend.` : ''),
    next_step: underfunded
      ? `Meta allocates inside your targeting — don't force it with age splits, but DO brief creative that speaks to ${underfunded.key} and watch whether Advantage+ follows the signal.`
      : `Budget already follows the best-returning demographics — nothing to force here.`,
    data: {
      window_days: 30,
      kpi_mode: mode,
      kpi_label: kpiLabel,
      currency,
      age_bands: ageBands,
      genders,
      countries,
    },
    derivation:
      `Two account insights pulls from Meta (last 30 days): one broken down by age and gender, one by country — spend and ` +
      `conversions summed per cell, ${kpiLabel} computed per cell. Cells under ${Math.round(FLOOR)} ${currency} spend aren't ` +
      `ranked (too thin to compare honestly). Demographic delivery is Meta's allocation, not your targeting — treat gaps as ` +
      `creative signals, not exclusion lists.`,
  };
}

// ---------------------------------------------------------------------------
// C. Targeting split — broad vs interest vs LAL vs retargeting vs Advantage+
//    (design round-2 [build]; Andromeda-era read: broad usually wins)
// ---------------------------------------------------------------------------

export interface TargetingSpecLite {
  adset_id: string;
  adset_name: string;
  effective_status: string | null;
  advantage_audience: boolean;
  has_custom_audiences: boolean;
  has_lookalikes: boolean;
  has_interests: boolean;
  age_min: number | null;
  age_max: number | null;
  genders: string | null;
}

export type TargetingClass = 'Advantage+ audience' | 'Retargeting (custom audiences)' | 'Lookalike' | 'Interest-targeted' | 'Broad';

export function classifyTargeting(t: TargetingSpecLite): TargetingClass {
  if (t.advantage_audience) return 'Advantage+ audience';
  if (t.has_custom_audiences && !t.has_lookalikes) return 'Retargeting (custom audiences)';
  if (t.has_lookalikes) return 'Lookalike';
  if (t.has_interests) return 'Interest-targeted';
  return 'Broad';
}

export function computeTargetingSplit(
  specs: TargetingSpecLite[],
  spendByAdset: Map<string, number>,
  kpiByAdset: Map<string, { value: number; results: number }>,
  rows30ForMode: PackAdRow[],
  currency: string,
): PackSection {
  const spending = specs.filter((s) => (spendByAdset.get(s.adset_id) ?? 0) > 0);
  const totalSpend = spending.reduce((s, a) => s + (spendByAdset.get(a.adset_id) ?? 0), 0);
  if (spending.length === 0 || totalSpend < 100) {
    return {
      summary: 'No ad sets with meaningful spend to classify.',
      next_step: 'Re-audit once the account is delivering.',
      data: { classes: [] },
      warnings: ['No spending ad sets in the window — read suppressed.'],
    };
  }
  const mode = kpiMode(rows30ForMode);
  const kpiLabel = mode === 'roas' ? 'Meta ROAS' : 'cost per result';

  const byClass = new Map<TargetingClass, { spend: number; value: number; results: number; adsets: number; genderRestricted: number }>();
  for (const s of spending) {
    const cls = classifyTargeting(s);
    const a = byClass.get(cls) ?? { spend: 0, value: 0, results: 0, adsets: 0, genderRestricted: 0 };
    const spend = spendByAdset.get(s.adset_id) ?? 0;
    const k = kpiByAdset.get(s.adset_id) ?? { value: 0, results: 0 };
    a.spend += spend;
    a.value += k.value;
    a.results += k.results;
    a.adsets += 1;
    if (s.genders && s.genders !== 'all') a.genderRestricted += 1;
    byClass.set(cls, a);
  }

  const classes = [...byClass.entries()]
    .map(([cls, a]) => ({
      class: cls,
      adsets: a.adsets,
      spend: Math.round(a.spend),
      spend_share_pct: pct(a.spend, totalSpend),
      kpi: mode === 'roas' ? (a.spend > 0 ? r2(div(a.value, a.spend)) : null) : a.results > 0 ? r2(div(a.spend, a.results)) : null,
    }))
    .sort((a, b) => b.spend - a.spend);

  const genderRestricted = [...byClass.values()].reduce((s, a) => s + a.genderRestricted, 0);
  const warnings: string[] = [];
  if (genderRestricted > 0) {
    warnings.push(
      `${genderRestricted} spending ad set${genderRestricted > 1 ? 's' : ''} restrict gender — in the current auction that usually costs more than it filters. Worth re-testing without.`,
    );
  }
  const advantage = classes.find((c) => c.class === 'Advantage+ audience');
  if (advantage) {
    warnings.push(
      `Advantage+ audience treats your targeting as a suggestion, not a boundary — its ${advantage.spend_share_pct}% of spend mixes funnel stages by design.`,
    );
  }

  const top = classes[0]!;
  return {
    summary:
      `${classes.length} targeting style${classes.length > 1 ? 's' : ''} carry spend — biggest: ${top.class} ` +
      `(${top.spend_share_pct}% of spend${top.kpi != null ? `, ${kpiLabel} ${top.kpi}` : ''}).`,
    next_step:
      classes.find((c) => c.class === 'Interest-targeted' && c.spend_share_pct >= 20) != null
        ? `A real slice of budget still runs on interest stacks — current-era accounts usually beat them with broad + strong creative. Test broad against your best interest ad set head-to-head.`
        : `The split is current-era sane. Judge classes by their ${kpiLabel} above before moving budget.`,
    data: { window_days: 30, kpi_mode: mode, kpi_label: kpiLabel, currency, classes, total_spend: Math.round(totalSpend) },
    warnings: warnings.length ? warnings : undefined,
    derivation:
      `Every spending ad set's live targeting spec read from Meta and classified by a fixed rule: Advantage+ audience flag → ` +
      `Advantage+; custom audiences without lookalikes → retargeting; lookalikes → LAL; detailed interests → interest-targeted; ` +
      `none of those → broad. Spend joins from the 30-day ad-level pull; ${kpiLabel} per class from that class's own results.`,
  };
}

// ---------------------------------------------------------------------------
// D. Learning Limited / structure waste (design menu — "invisible,
//    Meta-specific, actionable"). Meta's exit bar: ~50 optimization events
//    per ad set per week.
// ---------------------------------------------------------------------------

export function computeLearningLimited(
  adsets: AdsetConfigLite[],
  weeklyEventsByAdset: Map<string, number>,
  spendByAdset: Map<string, number>,
  currency: string,
): PackSection {
  // Count-scope bookkeeping (founder-sim debt, 2026-07-04): the optimization
  // report judges EVERY ad set that spent in the last 30 days; this check only
  // covers the ones still ACTIVE (a paused set can't be in learning). Print
  // both populations so the two sections' headline counts reconcile on-page.
  const spenders = adsets.filter((a) => (spendByAdset.get(a.adset_id) ?? 0) > 0);
  const active = spenders.filter((a) => a.effective_status === 'ACTIVE');
  const inactiveSpenders = spenders.length - active.length;
  const totalSpend = active.reduce((s, a) => s + (spendByAdset.get(a.adset_id) ?? 0), 0);
  if (active.length === 0 || totalSpend < 100) {
    return {
      summary: 'No active spending ad sets to check against the learning bar.',
      next_step: 'Re-audit once the account is delivering.',
      data: { rows: [] },
      warnings: ['No active delivery — read suppressed.'],
    };
  }

  const BAR = 50; // Meta's ~50 optimization events / week to exit learning
  const rows = active
    .map((a) => {
      const weekly = Math.round(weeklyEventsByAdset.get(a.adset_id) ?? 0);
      return {
        adset_name: a.adset_name,
        spend_30d: Math.round(spendByAdset.get(a.adset_id) ?? 0),
        weekly_events: weekly,
        starved: weekly < BAR,
      };
    })
    .sort((a, b) => b.spend_30d - a.spend_30d);

  const starved = rows.filter((r) => r.starved);
  const starvedSpend = starved.reduce((s, r) => s + r.spend_30d, 0);
  const starvedSharePct = pct(starvedSpend, totalSpend);

  const scopeClause =
    inactiveSpenders > 0
      ? ` (${spenders.length} ad sets spent in the last 30 days; ${inactiveSpenders} ${inactiveSpenders === 1 ? 'is' : 'are'} no longer active and ${inactiveSpenders === 1 ? 'is' : 'are'} excluded here — a paused set can't be in learning.)`
      : '';
  return {
    summary:
      starved.length === 0
        ? `All ${rows.length} currently active ad sets with spend clear Meta's ~50-events-a-week learning bar — the algorithm has enough signal everywhere.${scopeClause}`
        : `${starved.length} of the ${rows.length} currently active ad sets with spend run below Meta's ~50-events-a-week learning bar — ` +
          `${starvedSharePct}% of active spend (${money(starvedSpend, currency)}/30d) is optimizing on thin signal.${scopeClause}`,
    next_step:
      starved.length === 0
        ? `Keep new ad sets consolidated enough to clear the bar — splitting budgets thinner than ~50 events/week re-enters learning.`
        : `Consolidate: merge the starved ad sets into fewer, broader ones so Meta gets ≥50 events a week per set — fragmentation is paying learning tax on ${starvedSharePct}% of spend.`,
    data: {
      window_days: 30,
      bar_per_week: BAR,
      currency,
      rows: rows.slice(0, 15),
      // The honest population counts — data.rows above is display-capped at 15,
      // so every consumer (work log included) must count from these fields.
      assessed_adsets: rows.length,
      spending_adsets_30d: spenders.length,
      inactive_spenders_excluded: inactiveSpenders,
      starved_count: starved.length,
      starved_spend_share_pct: starvedSharePct,
    },
    warnings:
      starvedSharePct >= 30
        ? [`${starvedSharePct}% of active spend sits in ad sets that can't exit learning — this is structural, not creative.`]
        : undefined,
    derivation:
      `Population: every ad set that is currently ACTIVE and spent in the last 30 days` +
      (inactiveSpenders > 0
        ? ` — ${inactiveSpenders} ad set${inactiveSpenders === 1 ? '' : 's'} that spent but ${inactiveSpenders === 1 ? 'is' : 'are'} no longer active ${inactiveSpenders === 1 ? 'is' : 'are'} judged in the optimization report, not here`
        : '') +
      `. Per ad set: its optimization-type events (purchases, or leads on lead-gen accounts) from the last 30 days of ` +
      `ad-level delivery, averaged to a weekly rate and compared against Meta's documented ~50-conversions-per-week ` +
      `learning-phase exit bar. The table shows the top 15 by spend; the counts cover all assessed ad sets. ` +
      `The event count is our closest proxy for the set's true optimization event — treat borderline rows as directional.`,
  };
}

// ---------------------------------------------------------------------------
// E. Audience saturation / reach ceiling (design menu — forward-looking)
// ---------------------------------------------------------------------------

export interface WeeklyReachRow {
  week: string;
  reach: number;
  impressions: number;
  spend: number;
}

export function computeSaturation(weeks: WeeklyReachRow[], currency: string): PackSection {
  if (weeks.length < 8) {
    return {
      summary: 'Not enough weekly history for a saturation read (need ~8 weeks).',
      next_step: 'Re-audit in a few weeks — the reach curve needs history to mean anything.',
      data: { weeks: [] },
      warnings: ['Thin history — saturation read suppressed rather than guessed.'],
    };
  }
  const rows = weeks.map((w) => ({
    week: w.week,
    reach: w.reach,
    spend: Math.round(w.spend),
    frequency: w.reach > 0 ? r2(w.impressions / w.reach) : 0,
  }));
  const third = Math.max(2, Math.floor(rows.length / 3));
  const early = rows.slice(0, third);
  const late = rows.slice(-third);
  const avg = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / Math.max(1, xs.length);
  const earlyFreq = avg(early.map((r) => r.frequency));
  const lateFreq = avg(late.map((r) => r.frequency));
  const earlyReachPerSpend = avg(early.map((r) => (r.spend > 0 ? r.reach / r.spend : 0)));
  const lateReachPerSpend = avg(late.map((r) => (r.spend > 0 ? r.reach / r.spend : 0)));
  const freqDeltaPct = earlyFreq > 0 ? r1(((lateFreq - earlyFreq) / earlyFreq) * 100) : 0;
  const reachEffDeltaPct = earlyReachPerSpend > 0 ? r1(((lateReachPerSpend - earlyReachPerSpend) / earlyReachPerSpend) * 100) : 0;

  const saturating = freqDeltaPct >= 15 && reachEffDeltaPct <= -15;

  return {
    summary: saturating
      ? `Saturation signal: weekly frequency is up ${freqDeltaPct}% while reach per ${currency || 'unit'} spent fell ${Math.abs(reachEffDeltaPct)}% — you're paying more to show the same people the same things.`
      : `No saturation squeeze: frequency ${freqDeltaPct >= 0 ? `up ${freqDeltaPct}%` : `down ${Math.abs(freqDeltaPct)}%`} and reach efficiency ${reachEffDeltaPct >= 0 ? `up ${reachEffDeltaPct}%` : `down ${Math.abs(reachEffDeltaPct)}%`} across the window — the audience still has room.`,
    next_step: saturating
      ? `Before raising budgets, widen the pool: new creative angles reach new people better than higher bids reach the same ones.`
      : `Scaling headroom exists — watch this read again after any big budget step.`,
    data: {
      weeks: rows,
      early_frequency: r2(earlyFreq),
      late_frequency: r2(lateFreq),
      frequency_delta_pct: freqDeltaPct,
      reach_efficiency_delta_pct: reachEffDeltaPct,
      saturating,
      currency,
    },
    derivation:
      `Weekly reach, impressions and spend from one account insights pull (last ~90 days, weekly buckets, Meta's own deduplicated ` +
      `weekly reach). Frequency = impressions ÷ reach per week; reach efficiency = reach per unit spend. First third of the window ` +
      `vs the last third; "saturating" needs BOTH frequency up ≥15% AND reach efficiency down ≥15% — one alone is normal noise.`,
  };
}

// ---------------------------------------------------------------------------
// F. Creative diversity (design round-2, Dan's idea) — fragility read
// ---------------------------------------------------------------------------

export function computeCreativeDiversity(rows30: PackAdRow[], angleByAdId: Map<string, string>, currency: string): PackSection {
  const spendTotal = rows30.reduce((s, r) => s + (r.spend || 0), 0);
  const byAngle = new Map<string, number>();
  let taggedSpend = 0;
  for (const r of rows30) {
    const angle = angleByAdId.get(r.ad_id);
    if (!angle) continue;
    taggedSpend += r.spend || 0;
    byAngle.set(angle, (byAngle.get(angle) ?? 0) + (r.spend || 0));
  }
  const coverage = pct(taggedSpend, spendTotal);
  if (byAngle.size === 0 || coverage < 25) {
    return {
      summary: `Not enough angle-tagged creative for a diversity read (${coverage}% of spend tagged).`,
      next_step: 'Run the creative-intelligence analyzer across active ads, then re-audit.',
      data: { coverage_pct: coverage, angles: 0 },
      warnings: ['Thin angle coverage — diversity read suppressed.'],
    };
  }

  const shares = [...byAngle.values()].map((s) => s / taggedSpend);
  const hhi = Math.round(shares.reduce((s, x) => s + x * x, 0) * 10_000);
  const topShare = r1(Math.max(...shares) * 100);
  const topAngle = [...byAngle.entries()].sort((a, b) => b[1] - a[1])[0]![0];

  // Format mix (proxy: video = the ad reports video engagement rates)
  const videoSpend = rows30.filter((r) => (r.hook_rate ?? 0) > 0 || (r.hold_rate ?? 0) > 0).reduce((s, r) => s + (r.spend || 0), 0);
  const videoSharePct = pct(videoSpend, spendTotal);

  const fragile = byAngle.size <= 2 || topShare >= 70;
  return {
    summary: fragile
      ? `The portfolio is concentrated: ${byAngle.size} angle${byAngle.size > 1 ? 's' : ''} in market and "${topAngle}" carries ${topShare}% of tagged spend — one fatiguing concept takes the account with it.`
      : `${byAngle.size} distinct angles carry spend; the biggest ("${topAngle}") holds ${topShare}% of tagged spend — a workable spread.`,
    next_step: fragile
      ? `Brief 2 genuinely different angles (not variations of "${topAngle}") — diversity is the hedge against the fatigue report above.`
      : `Keep the exploration rhythm — retire the weakest angle's budget toward a new test lane each month.`,
    data: {
      window_days: 30,
      coverage_pct: coverage,
      angles: byAngle.size,
      top_angle: topAngle,
      top_angle_share_pct: topShare,
      hhi,
      video_spend_share_pct: videoSharePct,
      static_spend_share_pct: r1(100 - videoSharePct),
      currency,
    },
    derivation:
      `Angle tags from our creative analysis over the last 30 days of spend (${coverage}% of spend carries a tag). Concentration ` +
      `= HHI over angle spend shares (${hhi}; 10,000 = everything on one angle). Format mix is a delivery proxy: an ad counts as ` +
      `video when Meta reports video engagement rates for it. "Fragile" = ≤2 angles in market or one angle over 70% of tagged spend.`,
  };
}

// ---------------------------------------------------------------------------
// G. Monthly cohort wave (design menu — Dan's second cohort view: absolute
//    monthly cohorts tracked over time, not just relative vintages)
// ---------------------------------------------------------------------------

export interface CohortWaveMonth {
  month: string;
  cohorts: Array<{ cohort: string; spend: number }>;
}

export function computeCohortWave(rows180: Array<Pick<PackAdRow, 'ad_id' | 'date' | 'spend'>>): CohortWaveMonth[] {
  const firstSeen = new Map<string, string>();
  for (const r of rows180) {
    const d = String(r.date).slice(0, 10);
    const prev = firstSeen.get(r.ad_id);
    if (!prev || d < prev) firstSeen.set(r.ad_id, d);
  }
  const matrix = new Map<string, Map<string, number>>();
  for (const r of rows180) {
    const month = String(r.date).slice(0, 7);
    const cohort = (firstSeen.get(r.ad_id) ?? String(r.date)).slice(0, 7);
    const m = matrix.get(month) ?? new Map<string, number>();
    m.set(cohort, (m.get(cohort) ?? 0) + (r.spend || 0));
    matrix.set(month, m);
  }
  return [...matrix.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, cohorts]) => ({
      month,
      cohorts: [...cohorts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([cohort, spend]) => ({ cohort, spend: Math.round(spend) })),
    }));
}

// ---------------------------------------------------------------------------
// H. "What's working" — the protect list (binding: tell them what's working
//    too, not only problems; evergreen rule)
// ---------------------------------------------------------------------------

export function computeWhatsWorking(
  fatigueData: { evergreen?: Array<{ ad_name: string; spend: number; roas_read?: string; days_running?: number }> } | undefined,
  conceptData: { angles?: Array<{ angle: string; kpi: number | null; spend_share_pct: number; below_floor: boolean }>; kpi_mode?: string; kpi_label?: string } | undefined,
  scorecard: Array<{ dimension: string; band: string; position: string }> | undefined,
  currency: string,
): PackSection {
  const evergreen = fatigueData?.evergreen ?? [];
  const strongDims = (scorecard ?? []).filter((e) => e.band === 'strong');
  const mode = conceptData?.kpi_mode ?? 'roas';
  const assessed = (conceptData?.angles ?? []).filter((a) => !a.below_floor && a.kpi != null);
  const bestAngle = assessed.length
    ? [...assessed].sort((a, b) => (mode === 'roas' ? (b.kpi ?? 0) - (a.kpi ?? 0) : (a.kpi ?? Infinity) - (b.kpi ?? Infinity)))[0]
    : null;

  if (evergreen.length === 0 && strongDims.length === 0 && !bestAngle) {
    return {
      summary: 'Nothing in the window clears the bar as a proven, protected winner yet — that itself is the finding.',
      next_step: 'The fastest path to a protect-list is creative volume: more genuinely different tests.',
      data: { evergreen: [], strong_dimensions: [] },
    };
  }

  const parts: string[] = [];
  if (evergreen.length > 0) {
    const evSpend = evergreen.reduce((s, e) => s + (e.spend || 0), 0);
    parts.push(
      `${evergreen.length} evergreen winner${evergreen.length > 1 ? 's' : ''} (${money(evSpend, currency)} of recent spend) running 60+ days with the number holding`,
    );
  }
  if (strongDims.length > 0) parts.push(`${strongDims.length} benchmarked dimension${strongDims.length > 1 ? 's' : ''} in the strong band`);
  if (bestAngle) parts.push(`"${bestAngle.angle}" is the proven angle (${conceptData?.kpi_label ?? 'Meta ROAS'} ${bestAngle.kpi})`);

  return {
    summary: `The protect list: ${parts.join(' · ')}.`,
    next_step:
      evergreen.length > 0
        ? `Do NOT refresh the evergreens on a calendar — they retire when their number declines, not when they age. Mine them: their hooks and structure are your next briefs' starting point.`
        : `Protect the strong dimensions while fixing the weak ones — don't churn what already works.`,
    data: {
      evergreen: evergreen.slice(0, 8),
      strong_dimensions: strongDims.map((d) => ({ dimension: d.dimension, position: d.position })),
      best_angle: bestAngle ? { angle: bestAngle.angle, kpi: bestAngle.kpi } : null,
      currency,
    },
    derivation:
      `Assembled from reports above, no new pulls: the fatigue report's evergreen set (60+ days running, return holding — the ` +
      `binding rule is decline-based, never age-based), the scorecard's strong-band dimensions, and the best assessed creative ` +
      `angle. If it's listed here, the data says protect it.`,
  };
}

// ---------------------------------------------------------------------------
// I. Landing pages — spend by destination + the dead-URL check (design §8;
//    fold-in from ada-dead-url-scan, Dan 2026-07-01)
// ---------------------------------------------------------------------------

export interface LandingAdRow {
  ad_id: string;
  spend: number;
  purchases: number;
  purchase_value: number;
  leads: number;
  landing_page_path: string | null;
}

export interface DeadUrlCheck {
  url: string;
  /** ok | dead (hard 4xx/5xx or DNS) | redirect_home | inconclusive (429/403/timeout) */
  verdict: 'ok' | 'dead' | 'redirect_home' | 'inconclusive';
  status: number | null;
  daily_burn: number;
  ads: string[];
}

export function computeLandingPages(rows: LandingAdRow[], checks: DeadUrlCheck[], currency: string, mode: 'roas' | 'cpr'): PackSection {
  const total = rows.reduce((s, r) => s + (r.spend || 0), 0);
  const withPath = rows.filter((r) => r.landing_page_path);
  const covered = withPath.reduce((s, r) => s + (r.spend || 0), 0);
  const kpiLabel = mode === 'roas' ? 'Meta ROAS' : 'cost per result';

  const byPath = new Map<string, { spend: number; value: number; results: number; ads: Set<string> }>();
  for (const r of withPath) {
    const p = r.landing_page_path!;
    const a = byPath.get(p) ?? { spend: 0, value: 0, results: 0, ads: new Set<string>() };
    a.spend += r.spend || 0;
    a.value += r.purchase_value || 0;
    a.results += (mode === 'roas' ? r.purchases : r.purchases || r.leads) || 0;
    a.ads.add(r.ad_id);
    byPath.set(p, a);
  }
  const paths = [...byPath.entries()]
    .map(([path, a]) => ({
      path,
      spend: Math.round(a.spend),
      spend_share_pct: pct(a.spend, covered),
      ads: a.ads.size,
      kpi: mode === 'roas' ? (a.spend > 0 ? r2(div(a.value, a.spend)) : null) : a.results > 0 ? r2(div(a.spend, a.results)) : null,
    }))
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10);

  if (paths.length === 0) {
    return {
      summary: 'No landing-page destinations recorded against spending ads in the window.',
      next_step: 'Nothing to rank — destination data is missing from the sync for this account.',
      data: { paths: [], dead_checks: checks },
      warnings: ['No destination mapping — read suppressed.'],
    };
  }

  const dead = checks.filter((c) => c.verdict === 'dead');
  const redirects = checks.filter((c) => c.verdict === 'redirect_home');
  const burn = dead.reduce((s, c) => s + c.daily_burn, 0);
  const homepage = paths.find((p) => p.path === '/');

  const warnings: string[] = [];
  if (dead.length > 0) {
    warnings.push(
      `${dead.length} live destination${dead.length > 1 ? 's' : ''} came back DEAD (hard error) with ~${money(burn, currency)}/day still flowing at ${dead.length > 1 ? 'them' : 'it'} — pause the listed ads first.`,
    );
  }
  if (redirects.length > 0) {
    warnings.push(`${redirects.length} destination${redirects.length > 1 ? 's' : ''} bounce to the homepage — the ad's promise dies on arrival.`);
  }
  if (homepage && homepage.spend_share_pct >= 5) {
    warnings.push(`${homepage.spend_share_pct}% of mapped spend lands on the homepage — ads should land on the page that closes them, almost never "/".`);
  }

  const top = paths[0]!;
  return {
    summary:
      `${paths.length} destinations carry the mapped spend — biggest: ${top.path} (${top.spend_share_pct}%${top.kpi != null ? `, ${kpiLabel} ${top.kpi}` : ''}). ` +
      (dead.length > 0
        ? `${dead.length} spending URL${dead.length > 1 ? 's are' : ' is'} DEAD right now (~${money(burn, currency)}/day burning).`
        : `Every checked live destination loads.`),
    next_step:
      dead.length > 0
        ? `Pause the ads pointing at the dead URL${dead.length > 1 ? 's' : ''} today — that's ${money(burn * 30, currency)}/month recovered with zero downside.`
        : homepage && homepage.spend_share_pct >= 5
          ? `Move the homepage traffic to the closest converting page and re-measure — the homepage almost never closes cold traffic.`
          : `Ranking looks healthy — shift test budget toward the best-returning underfunded destination.`,
    data: {
      window_days: 30,
      kpi_mode: mode,
      kpi_label: kpiLabel,
      currency,
      coverage_pct: pct(covered, total),
      paths,
      dead_checks: checks,
      dead_count: dead.length,
      daily_burn: Math.round(burn),
    },
    warnings: warnings.length ? warnings : undefined,
    derivation:
      `Spend per destination path from the last 30 days of ad-level delivery (${pct(covered, total)}% of spend has a mapped ` +
      `destination). The dead-check does NOT trust stored URLs (they go stale on dynamic creatives — proven 2026-07-01): each ` +
      `top-spend ad's CURRENT destination is resolved live from its Meta creative at audit time, then fetched. Only hard failures ` +
      `count as dead; rate-limited or blocked fetches read "inconclusive", never alarmed.`,
  };
}

// ---------------------------------------------------------------------------
// J. Surprising account facts ("did you know" — design batch 4; proof of
//    real work + the you-specific hook)
// ---------------------------------------------------------------------------

export interface AccountFactsInputs {
  rows180: Array<Pick<PackAdRow, 'ad_id' | 'date' | 'spend'>>;
  adNames: Map<string, string>;
  partnershipSpendPct: number | null;
  currency: string;
}

/**
 * The longest first→last delivery span (days) among ads that still delivered
 * within the window's final 7 days. Shared by computeAccountFacts ("your
 * longest-running ad") and the Ads-Library age bridge, so the account-side
 * number is the SAME wherever the page cites it (count-scope debt 2026-07-04).
 */
export function longestStillSpendingSpan(
  rows: Array<Pick<PackAdRow, 'ad_id' | 'date' | 'spend'>>,
): { adId: string; first: string; spanDays: number } | null {
  if (rows.length === 0) return null;
  const byAd = new Map<string, { first: string; last: string }>();
  let lastDay = '';
  for (const r of rows) {
    const d = String(r.date).slice(0, 10);
    const a = byAd.get(r.ad_id) ?? { first: d, last: d };
    if (d < a.first) a.first = d;
    if (d > a.last) a.last = d;
    byAd.set(r.ad_id, a);
    if (d > lastDay) lastDay = d;
  }
  const recentCut = new Date(new Date(lastDay + 'T00:00:00Z').getTime() - 7 * 86400_000).toISOString().slice(0, 10);
  const still = [...byAd.entries()].filter(([, a]) => a.last >= recentCut);
  if (still.length === 0) return null;
  const longest = still.sort(
    (x, y) =>
      new Date(y[1].last).getTime() - new Date(y[1].first).getTime() - (new Date(x[1].last).getTime() - new Date(x[1].first).getTime()),
  )[0]!;
  return {
    adId: longest[0],
    first: longest[1].first,
    spanDays: Math.round((new Date(longest[1].last).getTime() - new Date(longest[1].first).getTime()) / 86400_000),
  };
}

export function computeAccountFacts(inp: AccountFactsInputs): PackSection {
  const { rows180, adNames, currency } = inp;
  if (rows180.length === 0) {
    return {
      summary: 'Not enough history for account facts.',
      next_step: 'Re-audit with more history.',
      data: { facts: [] },
    };
  }

  const byAd = new Map<string, { first: string; last: string; spend: number }>();
  const byDay = new Map<string, number>();
  let weekend = 0;
  let total = 0;
  for (const r of rows180) {
    const d = String(r.date).slice(0, 10);
    const a = byAd.get(r.ad_id) ?? { first: d, last: d, spend: 0 };
    if (d < a.first) a.first = d;
    if (d > a.last) a.last = d;
    a.spend += r.spend || 0;
    byAd.set(r.ad_id, a);
    byDay.set(d, (byDay.get(d) ?? 0) + (r.spend || 0));
    const dow = new Date(d + 'T00:00:00Z').getUTCDay();
    if (dow === 0 || dow === 6) weekend += r.spend || 0;
    total += r.spend || 0;
  }

  const days = [...byDay.keys()].sort();
  const lastDay = days[days.length - 1]!;

  const facts: Array<{ fact: string; detail: string }> = [];

  // Longest-running ad still spending (shared helper — the Ads-Library bridge
  // cites the same number, so the two sections can never disagree silently).
  const longest = longestStillSpendingSpan(rows180);
  if (longest && longest.spanDays >= 30) {
    facts.push({
      fact: `Your longest-running ad has been live ${longest.spanDays} days — and it's still spending.`,
      detail: `${adNames.get(longest.adId) ?? longest.adId} (first seen ${longest.first} in this window). Check the fatigue report: if its number holds, that's an evergreen, not a liability.`,
    });
  }

  // Spend on old creative
  const oldCut = new Date(new Date(lastDay + 'T00:00:00Z').getTime() - 90 * 86400_000).toISOString().slice(0, 10);
  const last30Cut = new Date(new Date(lastDay + 'T00:00:00Z').getTime() - 30 * 86400_000).toISOString().slice(0, 10);
  let oldSpend = 0;
  let recent30 = 0;
  for (const r of rows180) {
    const d = String(r.date).slice(0, 10);
    if (d < last30Cut) continue;
    recent30 += r.spend || 0;
    const first = byAd.get(r.ad_id)?.first ?? d;
    if (first < oldCut) oldSpend += r.spend || 0;
  }
  if (recent30 > 0) {
    facts.push({
      fact: `${pct(oldSpend, recent30)}% of this month's spend runs on creative older than 90 days.`,
      detail: `Not automatically bad — the cohorts report says whether the old guard still earns its budget.`,
    });
  }

  // Biggest single day
  const biggest = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0]!;
  facts.push({
    fact: `Your biggest single day in this window: ${money(biggest[1], currency)} on ${biggest[0]}.`,
    detail: `Daily average is ${money(total / Math.max(1, days.length), currency)} across ${days.length} delivery days.`,
  });

  // Weekend share
  facts.push({
    fact: `${pct(weekend, total)}% of spend delivers on weekends.`,
    detail: `The day-of-week report says whether those weekend ${currency || 'units'} return like the weekday ones.`,
  });

  // Partnership share
  if (inp.partnershipSpendPct != null && inp.partnershipSpendPct > 0) {
    facts.push({
      fact: `${inp.partnershipSpendPct}% of spend runs through partnership (branded-content) ads.`,
      detail: `Creator handles carry that spend — worth knowing which creators' posts are doing the lifting.`,
    });
  }

  // Portfolio churn ("still spending" = delivered within 7 days of the newest
  // data day — the same cut longestStillSpendingSpan uses)
  const recentCut = new Date(new Date(lastDay + 'T00:00:00Z').getTime() - 7 * 86400_000).toISOString().slice(0, 10);
  const adsCount = byAd.size;
  const activeRecent = [...byAd.values()].filter((a) => a.last >= recentCut).length;
  facts.push({
    fact: `${adsCount} ads spent something in ~6 months; ${activeRecent} still spend today.`,
    detail: `${pct(adsCount - activeRecent, adsCount)}% of everything launched has already been retired — that's the real test-and-kill rate.`,
  });

  return {
    summary: `${facts.length} things about this account most people running it couldn't quote.`,
    next_step: `None of these demand action alone — they're the texture behind the reports above. The ones that do demand action are flagged there.`,
    data: { facts: facts.slice(0, 6), window_days: 180, currency },
    derivation:
      `Computed from ~6 months of ad-level delivery history (${rows180.length.toLocaleString('en-US')} ad-day rows) — first/last ` +
      `spend day per ad, daily totals, weekend split, and the branded-content flag read live from Meta's creative metadata. ` +
      `"Still spending" = delivered within 7 days of the newest data day.`,
  };
}
