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
/** Two decimals kept: a cost per lead of 18.59 must not read as 19. */
const moneyExact = (v: number, currency: string): string =>
  `${v.toFixed(2)}${currency ? ` ${currency}` : ''}`;

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
      data: { platforms: [], positions: [], signal: false },
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

  // The only ask this chapter has: Audience Network taking a real slice of
  // budget with a readable number beside it. Without that there is nothing to
  // do, and a reminder to "re-check after a placement change" is not an action.
  const anActionable = !!an && an.spend_share_pct >= 3 && an.kpi != null;
  const top = platforms[0]!;
  return {
    summary:
      `${top.platform} carries ${top.spend_share_pct}% of spend` +
      (platforms.length > 1 ? `; ${platforms.length} platforms deliver in total.` : '.') +
      (an && an.spend_share_pct >= 1 ? ` Audience Network takes ${an.spend_share_pct}%.` : ' No meaningful Audience Network spend — good.'),
    ...(anActionable
      ? {
          next_step: `Audience Network is ${an!.spend_share_pct}% of budget. Compare its ${kpiLabel} (${an!.kpi}) against your feed placements and cap it if it underperforms.`,
        }
      : {}),
    data: {
      window_days: 30,
      signal: anActionable || rewardedSpendPct >= 0.5,
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
      data: { age_bands: [], genders: [], countries: [], signal: false },
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
    // Budget already following the best-returning cells is the chapter reading
    // clean. It used to carry "nothing to force here", which is a sentence with
    // no number in it and the page rendered it as a finding.
    ...(underfunded
      ? {
          next_step: `Meta allocates inside your targeting, so don't force it with age splits. Brief creative that speaks to ${underfunded.key} and watch whether Advantage+ follows.`,
        }
      : {}),
    data: {
      window_days: 30,
      signal: !!underfunded,
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

/**
 * One ad set whose NAME claims something its live targeting does not contain.
 *
 * The claim and the class travel separately from the sentence so a consumer can
 * count them without parsing prose, and the sentence itself never says which
 * half is wrong: a renamed ad set and a rebuilt audience look identical from
 * here, and only the person who did it knows which one is stale.
 */
export interface AdSetNamePromise {
  adset_id: string;
  adset_name: string;
  /** What the name reads as ("a lookalike", "retargeting", an audience name). */
  claim: string;
  /** The class its live spec was actually classified as. */
  targeting_class: string;
  detail: string;
}

export function computeTargetingSplit(
  specs: TargetingSpecLite[],
  spendByAdset: Map<string, number>,
  kpiByAdset: Map<string, { value: number; results: number }>,
  rows30ForMode: PackAdRow[],
  currency: string,
  /**
   * The name-versus-spec check, when the read that can answer it ran. Absent by
   * default, so a caller without the account's audience list produces exactly
   * the section it produced before this existed.
   */
  namePromises: AdSetNamePromise[] = [],
): PackSection {
  const spending = specs.filter((s) => (spendByAdset.get(s.adset_id) ?? 0) > 0);
  const totalSpend = spending.reduce((s, a) => s + (spendByAdset.get(a.adset_id) ?? 0), 0);
  if (spending.length === 0 || totalSpend < 100) {
    return {
      summary: 'No ad sets with meaningful spend to classify.',
      data: { classes: [], signal: false },
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

  // Only ad sets with spend are judged on their name: a paused ad set called
  // "Lookalike 1%" is somebody's old test, and correcting its label buys the
  // reader nothing.
  const spendingIds = new Set(spending.map((s) => s.adset_id));
  const brokenPromises = namePromises.filter((p) => spendingIds.has(p.adset_id));
  if (brokenPromises.length > 0) {
    const first = brokenPromises[0]!;
    warnings.push(
      brokenPromises.length === 1
        ? `One spending ad set's name does not match what it targets. ${first.detail} Either the name or the audience is out of date, and both cost you the ability to read this account from its own labels.`
        : `${brokenPromises.length} spending ad sets have names that do not match what they target. ${first.detail} Either the names or the audiences are out of date, and both cost you the ability to read this account from its own labels.`,
    );
  }

  const top = classes[0]!;
  const interestHeavy = classes.find((c) => c.class === 'Interest-targeted' && c.spend_share_pct >= 20) != null;
  return {
    summary:
      `${classes.length} targeting style${classes.length > 1 ? 's' : ''} carry spend. The biggest is ${top.class} ` +
      `(${top.spend_share_pct}% of spend${top.kpi != null ? `, ${kpiLabel} ${top.kpi}` : ''}).` +
      (brokenPromises.length > 0
        ? ` ${brokenPromises.length} of ${spending.length} spending ad set${spending.length === 1 ? '' : 's'} carr${brokenPromises.length === 1 ? 'ies' : 'y'} a name that does not describe its targeting.`
        : ''),
    // "Judge classes by their number above before moving budget" is the reader
    // reading the section, not a step they can take, so a sane split is quiet.
    ...(interestHeavy
      ? {
          next_step: `A real slice of budget still runs on interest stacks, and current-era accounts usually beat them with broad plus strong creative. Test broad against your best interest ad set head to head.`,
        }
      : brokenPromises.length > 0
        ? {
            next_step: `Open "${brokenPromises[0]!.adset_name}" and settle which half is stale: rename it to what it targets, or point it at the audience its name promises. Until then nobody can read this account from its own labels.`,
          }
        : {}),
    data: {
      window_days: 30,
      signal: interestHeavy || brokenPromises.length > 0,
      kpi_mode: mode,
      kpi_label: kpiLabel,
      currency,
      classes,
      total_spend: Math.round(totalSpend),
      name_promises: brokenPromises,
      name_promises_checked: namePromises.length > 0 || undefined,
    },
    warnings: warnings.length ? warnings : undefined,
    derivation:
      `Every spending ad set's live targeting spec read from Meta and classified by a fixed rule: Advantage+ audience flag → ` +
      `Advantage+; custom audiences without lookalikes → retargeting; lookalikes → LAL; detailed interests → interest-targeted; ` +
      `none of those → broad. Spend joins from the 30-day ad-level pull; ${kpiLabel} per class from that class's own results.` +
      (namePromises.length > 0
        ? ` Each spending ad set's NAME was then read against that classification, and against the account's own list of saved audiences, ` +
          `so a name claiming a lookalike or an audience the spec does not hold is reported. Only names that make a checkable claim are judged.`
        : ''),
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
      data: { rows: [], signal: false },
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
    // Every ad set clearing the bar is this chapter reading clean. The old
    // "keep new ad sets consolidated" line asked for nothing that is not
    // already true of the account.
    ...(starved.length === 0
      ? {}
      : {
          next_step: `Consolidate: merge the starved ad sets into fewer, broader ones so Meta gets at least 50 events a week per set. Fragmentation is paying learning tax on ${starvedSharePct}% of spend.`,
        }),
    data: {
      window_days: 30,
      signal: starved.length > 0,
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
      `. Per ad set: its optimization-type events (purchases, or leads on lead-gen accounts) over the last 30 days, ` +
      `read from ad-level delivery and averaged to a weekly rate and compared against Meta's documented ~50-conversions-per-week ` +
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
      summary: 'Not enough weekly history for a saturation read (need ~8 weeks). The reach curve needs history before it means anything.',
      data: { weeks: [], signal: false },
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
    // Headroom left is the chapter reading clean: "watch this again after a
    // budget step" is a diary note, not an action for today.
    ...(saturating
      ? {
          next_step: `Before raising budgets, widen the pool: new creative angles reach new people better than higher bids reach the same ones.`,
        }
      : {}),
    data: {
      signal: saturating,
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
      data: { coverage_pct: coverage, angles: 0, signal: false },
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
    ...(fragile
      ? {
          next_step: `Brief 2 genuinely different angles, not variations of "${topAngle}". Diversity is the hedge against the fatigue report above.`,
        }
      : {}),
    data: {
      window_days: 30,
      signal: fragile,
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

/**
 * The fatigue chapter's own rows, which is the only place an evergreen verdict
 * is made. There is no `evergreen` list on that wire: the class sits on each
 * ad, beside `evergreen_count`. Reading a field the fatigue report never emits
 * is how this protect list came out empty on an account that had evergreen
 * winners in it, so the shape here is the shape that chapter actually sends.
 */
export interface FatigueReadForProtect {
  ads?: Array<{
    ad_name?: string;
    /** 90-day spend. `spend_30d` is the recent figure this list quotes. */
    spend?: number;
    spend_30d?: number;
    in_window_age_days?: number;
    class?: string;
    trend_pct?: number;
    kpi_first_half?: number;
    kpi_recent?: number;
    cpl_first_half?: number | null;
    cpl_last_14?: number | null;
  }>;
  kpi_mode?: string;
}

interface ProtectedAd {
  ad_name: string;
  spend: number;
  days_running?: number;
  /** The two figures behind "its number is still holding", so a reader can check it. */
  proof?: string;
}

/**
 * Why this ad is on the list, in its own numbers. "Its number is still
 * holding" is a claim nobody can check; the level it ran at and the level it
 * runs at now is the same claim with the evidence attached.
 */
function evergreenProof(
  ad: NonNullable<FatigueReadForProtect['ads']>[number],
  mode: 'roas' | 'cpr' | null,
  costLabel: string,
  currency: string,
): string | undefined {
  if (mode === 'roas' && typeof ad.kpi_first_half === 'number' && typeof ad.kpi_recent === 'number') {
    return `Meta ROAS ${ad.kpi_first_half.toFixed(2)}× then ${ad.kpi_recent.toFixed(2)}×`;
  }
  if (mode === 'cpr' && typeof ad.cpl_first_half === 'number' && typeof ad.cpl_last_14 === 'number') {
    return `${costLabel} ${moneyExact(ad.cpl_first_half, currency)} then ${moneyExact(ad.cpl_last_14, currency)}`;
  }
  if (typeof ad.trend_pct === 'number') {
    return ad.trend_pct >= 0
      ? `its number is ${r1(ad.trend_pct)}% up on the first half of its run`
      : `its number is within ${r1(Math.abs(ad.trend_pct))}% of the first half of its run`;
  }
  return undefined;
}

export function computeWhatsWorking(
  fatigueData: FatigueReadForProtect | undefined,
  conceptData: { angles?: Array<{ angle: string; kpi: number | null; spend_share_pct: number; below_floor: boolean }>; kpi_mode?: string; kpi_label?: string } | undefined,
  scorecard: Array<{ key?: string; dimension: string; band: string; position: string }> | undefined,
  currency: string,
  cohortData?: { window_too_short?: boolean; days_covered?: number },
): PackSection {
  const fatigueMode: 'roas' | 'cpr' | null =
    fatigueData?.kpi_mode === 'roas' ? 'roas' : fatigueData?.kpi_mode === 'cpr' ? 'cpr' : null;
  const costLabel = conceptData?.kpi_label ?? (fatigueMode === 'roas' ? 'Meta ROAS' : 'cost per result');
  const evergreen: ProtectedAd[] = (fatigueData?.ads ?? [])
    .filter((a) => a.class === 'evergreen')
    .map((a) => ({
      ad_name: typeof a.ad_name === 'string' ? a.ad_name : '',
      spend: typeof a.spend_30d === 'number' ? a.spend_30d : (a.spend ?? 0),
      ...(typeof a.in_window_age_days === 'number' ? { days_running: a.in_window_age_days } : {}),
      ...(() => {
        const proof = evergreenProof(a, fatigueMode, costLabel, currency);
        return proof ? { proof } : {};
      })(),
    }))
    // An ad that has stopped spending is not something to protect NOW, which is
    // the same 30-day gate the fatigue chapter's dragging list uses.
    .filter((e) => e.ad_name.length > 0 && e.spend > 0)
    .sort((a, b) => b.spend - a.spend);
  // On a window shorter than the launch-cohort read needs, creative freshness
  // comes out ~100% by construction: every ad in view launched inside it. That
  // is arithmetic, not a strength, so it is withheld rather than graded.
  const freshnessWithheld = cohortData?.window_too_short === true;
  const isFreshness = (e: { key?: string; dimension: string }): boolean =>
    e.key === 'freshness' || e.dimension.toLowerCase().startsWith('creative freshness');
  const strongDims = (scorecard ?? []).filter((e) => e.band === 'strong' && !(freshnessWithheld && isFreshness(e)));
  const mode = conceptData?.kpi_mode ?? 'roas';
  const assessed = (conceptData?.angles ?? []).filter((a) => !a.below_floor && a.kpi != null);
  const bestAngle = assessed.length
    ? [...assessed].sort((a, b) => (mode === 'roas' ? (b.kpi ?? 0) - (a.kpi ?? 0) : (a.kpi ?? Infinity) - (b.kpi ?? Infinity)))[0]
    : null;
  const biggestEvergreen = evergreen[0] ?? null;
  const cohortDaysCovered = typeof cohortData?.days_covered === 'number' ? cohortData.days_covered : null;

  if (evergreen.length === 0 && strongDims.length === 0 && !bestAngle) {
    return {
      // The same word the creative chips use for the same thing: a winner. The
      // page had one vocabulary for the chips and another for this list.
      //
      // The base rate belongs HERE, on the empty list, because that is where a
      // reader concludes something is wrong with their creative. About one ad in
      // twenty earns a place on a list like this, so an empty list on five tests
      // is arithmetic and an empty list on fifty is a problem.
      summary:
        'No ad in the window is a proven winner we would protect yet, and that itself is the finding. ' +
        'Plan on roughly one ad in twenty earning a place on this list: that is the rate this desk works to, not a measurement of your account, ' +
        'and it is why the number of genuinely different tests you run decides how many winners you end up with.',
      next_step:
        'The fastest path to a protect list is creative volume: more genuinely different tests. At one winner per twenty tests, twenty is the number to plan the next quarter around.',
      data: {
        evergreen: [],
        strong_dimensions: [],
        top_evergreen: null,
        best_angle: null,
        freshness_withheld: freshnessWithheld,
        cohort_days_covered: cohortDaysCovered,
        currency,
        // Either there is a protect list or there is not, and the absence is
        // stated as the finding with a real ask under it. Never a quiet row.
        signal: true,
      },
    };
  }

  const parts: string[] = [];
  if (biggestEvergreen) {
    const evSpend = evergreen.reduce((s, e) => s + (e.spend || 0), 0);
    const age = biggestEvergreen.days_running ? `${biggestEvergreen.days_running} days live` : '60+ days live';
    const proof = biggestEvergreen.proof ? `, ${biggestEvergreen.proof}` : '';
    parts.push(
      evergreen.length === 1
        ? `"${biggestEvergreen.ad_name}" is the evergreen winner: ${money(biggestEvergreen.spend, currency)} of recent spend, ${age}${proof}, and its number is still holding`
        : `${evergreen.length} evergreen winners hold ${money(evSpend, currency)} of recent spend. The biggest is "${biggestEvergreen.ad_name}" at ${money(biggestEvergreen.spend, currency)}, ${age}${proof}, with its number still holding`,
    );
  }
  if (strongDims.length > 0) parts.push(`${strongDims.length} benchmarked dimension${strongDims.length > 1 ? 's' : ''} in the strong band`);
  if (bestAngle) {
    parts.push(
      `"${bestAngle.angle}" is the proven angle (${conceptData?.kpi_label ?? 'Meta ROAS'} ${bestAngle.kpi} on ${bestAngle.spend_share_pct}% of spend)`,
    );
  }

  return {
    summary: `The protect list: ${parts.join(' · ')}.`,
    next_step:
      biggestEvergreen
        ? `Do NOT refresh "${biggestEvergreen.ad_name}" on a calendar. It retires when its number declines, not when it ages. Mine it: its hook and structure are the starting point for the next briefs.`
        : `Protect the strong dimensions while fixing the weak ones. Don't churn what already works.`,
    data: {
      evergreen: evergreen.slice(0, 8),
      top_evergreen: biggestEvergreen
        ? {
            ad_name: biggestEvergreen.ad_name,
            spend: Math.round(biggestEvergreen.spend || 0),
            days_running: biggestEvergreen.days_running ?? null,
            proof: biggestEvergreen.proof ?? null,
          }
        : null,
      strong_dimensions: strongDims.map((d) => ({ dimension: d.dimension, position: d.position })),
      best_angle: bestAngle ? { angle: bestAngle.angle, kpi: bestAngle.kpi, spend_share_pct: bestAngle.spend_share_pct } : null,
      freshness_withheld: freshnessWithheld,
      cohort_days_covered: cohortDaysCovered,
      currency,
      signal: true,
    },
    derivation:
      `Assembled from reports above, no new pulls: the fatigue report's evergreen set (60+ days running, return holding, the ` +
      `binding rule is decline-based, never age-based), the scorecard's strong-band dimensions, and the best assessed creative ` +
      `angle. If it's listed here, the data says protect it.` +
      (freshnessWithheld
        ? ` Creative freshness is left out here: ` +
          (cohortDaysCovered != null ? `the ad-level window covers only ${cohortDaysCovered} days, ` : `the ad-level window is too short, `) +
          `so a "recent launches" share of ~100% would only be restating the window's length.`
        : ''),
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
  /** ok | dead (hard 4xx/5xx or DNS) | soft_404 (HTTP 200 whose body reads "not found" —
   * money is just as wasted as a hard 404) | redirect_home | inconclusive (429/403/timeout) */
  verdict: 'ok' | 'dead' | 'soft_404' | 'redirect_home' | 'inconclusive';
  status: number | null;
  daily_burn: number;
  ads: string[];
  /** Human-readable verdict reason for the render/synthesis (optional, additive). */
  reason?: string;
}

// High-precision "this is a not-found page" phrases (EN + DE) — same list as the
// launch url_guard and the nightly dead_url_scan (bmad pma/tools). Kept tight on
// purpose: a healthy page (out-of-stock size, filter label) must never match.
const NOT_FOUND_MARKERS = [
  '404 not found', 'page not found', '404 page not found', 'error 404',
  'this page could not be found', 'the page you requested could not be found',
  'the page you were looking for', 'the page you are looking for',
  "page doesn't exist", 'page does not exist', "this page doesn't exist",
  'no longer available', 'product no longer available', 'this product is unavailable',
  // DE
  'seite nicht gefunden', 'diese seite existiert nicht', 'seite existiert nicht',
  'seite konnte nicht gefunden werden', 'produkt nicht mehr verfügbar',
  'dieses produkt ist nicht mehr verfügbar', 'die gesuchte seite',
];
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const HOME_PATHS = new Set(['', '/', '/collections', '/collections/all', '/pages/home', '/home']);

/**
 * Pure classifier for a fetched ad destination (soft-404 aware). Body is a
 * sniff slice (~64KB is plenty for <title> + a not-found banner).
 */
export function classifyDestination(
  originalUrl: string,
  finalUrl: string,
  status: number,
  body: string,
): { verdict: DeadUrlCheck['verdict']; reason: string } {
  if (status === 429) return { verdict: 'inconclusive', reason: 'HTTP 429 rate-limited — could not verify (not a dead page)' };
  if (status === 401 || status === 403) return { verdict: 'inconclusive', reason: `HTTP ${status} blocked (bot protection) — could not verify` };
  if (status === 404 || status === 410) return { verdict: 'dead', reason: `HTTP ${status} — the page does not exist` };
  if (status >= 400) return { verdict: 'dead', reason: `HTTP ${status} error` };

  const low = body.toLowerCase();
  const title = (TITLE_RE.exec(body)?.[1] ?? '').trim().toLowerCase();
  if (NOT_FOUND_MARKERS.some((p) => title.includes(p)) || NOT_FOUND_MARKERS.some((p) => low.includes(p))) {
    return { verdict: 'soft_404', reason: `HTTP ${status} but the page reads like a "not found" page (soft-404)` };
  }

  try {
    const o = new URL(originalUrl);
    const f = new URL(finalUrl);
    const oPath = o.pathname.replace(/\/$/, '');
    const fPath = f.pathname.replace(/\/$/, '');
    const sameHost = o.hostname.toLowerCase().replace(/^www\./, '') === f.hostname.toLowerCase().replace(/^www\./, '');
    if (sameHost && oPath && !HOME_PATHS.has(oPath) && (HOME_PATHS.has(fPath) || fPath === '')) {
      return { verdict: 'redirect_home', reason: `redirected to ${finalUrl} — the target page likely no longer exists` };
    }
  } catch {
    /* unparseable URL — fall through to ok */
  }
  return { verdict: 'ok', reason: `HTTP ${status}` };
}

/** One destination's share of the mapped spend, and the ads behind it. */
export interface DestinationRank {
  destination: string;
  spend: number;
  spend_share_pct: number;
  ads: number;
  /** Meta ROAS in roas mode, cost per result in cpr mode, null when unreadable. */
  kpi: number | null;
  /** Every ad pointing here, biggest spender first. */
  ad_ids: string[];
  /** The mapped-spend denominator the share is taken against. */
  covered_spend: number;
}

/**
 * Spend by destination — the ONE resolution. The landing chapter groups by
 * path, and the site walk groups the same rows by their full URL (a path
 * cannot be fetched), so both read the same ranking rather than two that can
 * disagree about which page the money is on.
 */
export function rankDestinationsBySpend(
  rows: LandingAdRow[],
  destOf: (row: LandingAdRow) => string | null,
  mode: 'roas' | 'cpr',
): DestinationRank[] {
  const byDest = new Map<string, { spend: number; value: number; results: number; ads: Map<string, number> }>();
  let covered = 0;
  for (const r of rows) {
    const key = destOf(r);
    if (!key) continue;
    covered += r.spend || 0;
    const a = byDest.get(key) ?? { spend: 0, value: 0, results: 0, ads: new Map<string, number>() };
    a.spend += r.spend || 0;
    a.value += r.purchase_value || 0;
    a.results += (mode === 'roas' ? r.purchases : r.purchases || r.leads) || 0;
    a.ads.set(r.ad_id, (a.ads.get(r.ad_id) ?? 0) + (r.spend || 0));
    byDest.set(key, a);
  }
  return [...byDest.entries()]
    .map(([destination, a]) => ({
      destination,
      spend: Math.round(a.spend),
      spend_share_pct: pct(a.spend, covered),
      ads: a.ads.size,
      kpi: mode === 'roas' ? (a.spend > 0 ? r2(div(a.value, a.spend)) : null) : a.results > 0 ? r2(div(a.spend, a.results)) : null,
      ad_ids: [...a.ads.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id),
      covered_spend: covered,
    }))
    .sort((a, b) => b.spend - a.spend);
}

export function computeLandingPages(rows: LandingAdRow[], checks: DeadUrlCheck[], currency: string, mode: 'roas' | 'cpr', uncheckedUrls = 0): PackSection {
  const total = rows.reduce((s, r) => s + (r.spend || 0), 0);
  const withPath = rows.filter((r) => r.landing_page_path);
  const covered = withPath.reduce((s, r) => s + (r.spend || 0), 0);
  const kpiLabel = mode === 'roas' ? 'Meta ROAS' : 'cost per result';

  const paths = rankDestinationsBySpend(rows, (r) => r.landing_page_path, mode)
    .map(({ destination, spend, spend_share_pct, ads, kpi }) => ({ path: destination, spend, spend_share_pct, ads, kpi }))
    .slice(0, 10);

  if (paths.length === 0) {
    return {
      summary: 'No landing-page destinations recorded against spending ads in the window. Destination data is missing from the sync for this account.',
      data: { paths: [], dead_checks: checks, signal: false },
      warnings: ['No destination mapping — read suppressed.'],
    };
  }

  // soft_404 counts as dead for burn/urgency: the server says 200 but the page
  // tells the visitor "not found" — the click is exactly as wasted.
  const dead = checks.filter((c) => c.verdict === 'dead' || c.verdict === 'soft_404');
  const softCount = checks.filter((c) => c.verdict === 'soft_404').length;
  const redirects = checks.filter((c) => c.verdict === 'redirect_home');
  const burn = dead.reduce((s, c) => s + c.daily_burn, 0);
  const deadAdCount = new Set(dead.flatMap((c) => c.ads)).size;
  const homepage = paths.find((p) => p.path === '/');

  const warnings: string[] = [];
  if (dead.length > 0) {
    warnings.push(
      `${dead.length} live destination${dead.length > 1 ? 's' : ''} came back DEAD with ~${money(burn, currency)}/day still flowing at ${dead.length > 1 ? 'them' : 'it'} — pause the listed ${deadAdCount === 1 ? 'ad' : 'ads'} first.` +
        (softCount > 0 ? ` (${softCount} of these ${softCount > 1 ? 'are' : 'is a'} soft-404${softCount > 1 ? 's' : ''}: the server answers 200 but the page itself says "not found".)` : ''),
    );
  }
  if (redirects.length > 0) {
    warnings.push(`${redirects.length} destination${redirects.length > 1 ? 's' : ''} ${redirects.length === 1 ? 'bounces' : 'bounce'} to the homepage — the ad's promise dies on arrival.`);
  }
  if (uncheckedUrls > 0) {
    warnings.push(
      `${uncheckedUrls} additional lower-spend destination${uncheckedUrls > 1 ? 's were' : ' was'} not fetched this run (per-audit URL cap) — coverage is top-spend-first, not exhaustive.`,
    );
  }
  if (homepage && homepage.spend_share_pct >= 5) {
    warnings.push(`${homepage.spend_share_pct}% of mapped spend lands on the homepage — ads should land on the page that closes them, almost never "/".`);
  }

  const top = paths[0]!;
  const topFigure = `${top.path} (${top.spend_share_pct}%${top.kpi != null ? `, ${kpiLabel} ${top.kpi}` : ''})`;
  // Homepage advice is one piece of advice, and the ad-promise chapter gives
  // the same click a sharper read. Flagged here so the orchestrator can hand
  // the call to that chapter once it has a verdict, instead of the reader
  // getting "move off the homepage" beside "fix the homepage line".
  const homepageAdvice = !!homepage && homepage.spend_share_pct >= 5 && dead.length === 0;
  return {
    summary:
      (paths.length === 1
        ? `1 destination carries the mapped spend: ${topFigure}. `
        : `${paths.length} destinations carry the mapped spend — biggest: ${topFigure}. `) +
      (dead.length > 0
        ? `${dead.length} spending URL${dead.length > 1 ? 's are' : ' is'} DEAD right now (~${money(burn, currency)}/day burning).`
        : `Every checked live destination loads.`),
    ...(dead.length > 0
      ? {
          next_step: `Pause the ${deadAdCount === 1 ? 'ad' : 'ads'} pointing at the dead URL${dead.length > 1 ? 's' : ''} today. That is ${money(burn * 30, currency)}/month recovered with zero downside.`,
        }
      : homepageAdvice
        ? {
            next_step: `Move the homepage traffic to the closest converting page and re-measure. The homepage almost never closes cold traffic.`,
          }
        : {}),
    data: {
      window_days: 30,
      signal: dead.length > 0 || homepageAdvice || redirects.length > 0,
      homepage_advice: homepageAdvice || undefined,
      kpi_mode: mode,
      kpi_label: kpiLabel,
      currency,
      coverage_pct: pct(covered, total),
      paths,
      dead_checks: checks,
      dead_count: dead.length,
      soft_404_count: softCount,
      unchecked_urls: uncheckedUrls,
      daily_burn: Math.round(burn),
    },
    warnings: warnings.length ? warnings : undefined,
    derivation:
      `Spend per destination path over the last 30 days, read from ad-level delivery (${pct(covered, total)}% of spend has a mapped ` +
      `destination). The dead-check does NOT trust stored URLs (they go stale on dynamic creatives — proven 2026-07-01): EVERY ` +
      `currently-delivering ad with spend has its CURRENT destination resolved live from its Meta creative at audit time, then each ` +
      `unique URL is fetched and read (soft-404 aware — an HTTP-200 "not found" page counts as dead). Rate-limited or blocked ` +
      `fetches read "inconclusive", never alarmed.`,
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
  const firstDay = days[0]!;
  const lastDay = days[days.length - 1]!;
  // One window, one denominator. Every sentence below states the span of the
  // rows it was handed, and the daily average divides THIS window's spend by
  // THIS window's day count. The report's hero states a shorter window of its
  // own, so a fact that leaves its window unsaid reads as if it shared that one.
  const windowDays =
    Math.round((new Date(lastDay + 'T00:00:00Z').getTime() - new Date(firstDay + 'T00:00:00Z').getTime()) / 86400_000) + 1;
  const deliveryDays = days.length;
  const windowSpend = total;
  const dailyAvg = windowSpend / Math.max(1, windowDays);
  // ONE name for this window everywhere in the section. A month count is a
  // rounding of the span we actually have, and the live report proved that a
  // second name for the same window reads as a second window.
  const windowNoun = `the ${windowDays} days we can read`;
  const windowPhrase = `in ${windowNoun}`;

  const facts: Array<{ fact: string; detail: string }> = [];

  // Longest-running ad still spending (shared helper — the Ads-Library bridge
  // cites the same number, so the two sections can never disagree silently).
  const longest = longestStillSpendingSpan(rows180);
  if (longest && longest.spanDays >= 30) {
    facts.push({
      fact: `Your longest-running ad has been live ${longest.spanDays} days, out of ${windowNoun}, and it is still spending.`,
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
      fact: `${pct(oldSpend, recent30)}% of the last 30 days' spend runs on creative that first went live more than 90 days ago.`,
      detail: `Not automatically bad — the cohorts report says whether the old guard still earns its budget.`,
    });
  }

  // Biggest single day
  const biggest = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0]!;
  facts.push({
    fact: `Your biggest single day ${windowPhrase}: ${money(biggest[1], currency)} on ${biggest[0]}.`,
    detail:
      `Daily average is ${money(dailyAvg, currency)}: ${money(windowSpend, currency)} across ${windowNoun}` +
      (deliveryDays < windowDays ? `, ${deliveryDays} of which had delivery.` : '.'),
  });

  // Weekend share
  facts.push({
    fact: `${pct(weekend, total)}% of spend ${windowPhrase} delivers on weekends.`,
    detail: `The day-of-week report says whether those weekend ${currency || 'units'} return like the weekday ones.`,
  });

  // Partnership share
  if (inp.partnershipSpendPct != null && inp.partnershipSpendPct > 0) {
    facts.push({
      fact: `${inp.partnershipSpendPct}% of the last 30 days' spend runs through partnership (branded-content) ads.`,
      detail: `Creator handles carry that spend — worth knowing which creators' posts are doing the lifting.`,
    });
  }

  // Portfolio churn ("still spending" = delivered within 7 days of the newest
  // data day — the same cut longestStillSpendingSpan uses)
  const recentCut = new Date(new Date(lastDay + 'T00:00:00Z').getTime() - 7 * 86400_000).toISOString().slice(0, 10);
  const adsCount = byAd.size;
  const activeRecent = [...byAd.values()].filter((a) => a.last >= recentCut).length;
  facts.push({
    fact: `${adsCount} ads spent something ${windowPhrase}; ${activeRecent} still spend today.`,
    detail: `${pct(adsCount - activeRecent, adsCount)}% of everything launched has already been retired — that's the real test-and-kill rate.`,
  });

  return {
    summary:
      `${facts.length} things about this account most people running it couldn't quote, measured across ${windowNoun}. ` +
      `These are the texture behind the reports above; the ones that demand action are flagged there.`,
    // No next step, and no `signal` either: this chapter never claimed to be a
    // finding, so it is neither an action row nor part of the quiet pile. The
    // line that used to sit here said in an action row that there was no action.
    data: {
      facts: facts.slice(0, 6),
      window_days: windowDays,
      window_start: firstDay,
      window_end: lastDay,
      delivery_days: deliveryDays,
      window_spend: Math.round(windowSpend),
      daily_avg: Math.round(dailyAvg),
      currency,
    },
    derivation:
      `Computed from ${windowNoun} of ad-level delivery history (${firstDay} to ${lastDay}, ` +
      `${rows180.length.toLocaleString('en-US')} ad-day rows) — first/last spend day per ad, daily totals, weekend split, and the ` +
      `branded-content flag read live from Meta's creative metadata. The daily average is this window's own spend divided by its ` +
      `own ${windowDays} days, which is why it will not match a shorter window's total. ` +
      `"Still spending" = delivered within 7 days of the newest data day.`,
  };
}

// ---------------------------------------------------------------------------
// Account activity / change history (2026-07-06)
//
// Meta's account activities edge (act_<id>/activities) is the account's audit
// log: every change made to campaigns/ad sets/ads/creatives/budgets/targeting,
// with a timestamp and (usually) an actor + application. Read-only under
// ads_read. This section answers three founder questions the delivery data
// can't: how much is anyone actually TOUCHING this account, WHO is touching it
// (agency vs a person vs an automated app), and how long it sits UNTOUCHED.
//
// Contract, same as the rest of the pack: pure function, PackSection out, no
// speculative claims. We only ever report the counts/actors/gaps the log
// literally contains — we never infer intent ("your agency is lazy") or invent
// numbers. Cost-per-change is derived ONLY when a monthly retainer is supplied
// (nullable — unknown at audit time), otherwise the field is null and the prose
// makes no cost claim.
// ---------------------------------------------------------------------------

/** One normalized row from Meta's activities edge (mapped in magic-audit.ts). */
export interface ActivityEvent {
  /** Meta's raw event_type enum value, e.g. "update_ad_set_run_status". */
  event_type: string;
  /** ISO-8601 timestamp (event_time). */
  event_time: string;
  actor_id: string | null;
  actor_name: string | null;
  application_id: string | null;
  application_name: string | null;
  object_type: string | null;
}

/** Small human-readable buckets Meta's large event_type enum maps into. */
export type ActivityCategory =
  | 'creative' // new ads, image/video uploads, creative edits
  | 'budget' // budget / bid / spend-cap changes
  | 'status' // pauses, unpauses, deletes, archives (run-status flips)
  | 'targeting' // audience / targeting-spec edits
  | 'structure' // create/delete of campaigns & ad sets (non-creative scaffolding)
  | 'account' // account-level settings, billing, users, permissions
  | 'other'; // anything the map doesn't recognize (kept, never dropped)

const ACTIVITY_CATEGORY_LABEL: Record<ActivityCategory, string> = {
  creative: 'creative uploads & edits',
  budget: 'budget & bid changes',
  status: 'pauses / unpauses',
  targeting: 'targeting edits',
  structure: 'campaign & ad-set structure',
  account: 'account settings',
  other: 'other changes',
};

/**
 * Map one Meta event_type into a human category. Order matters: more specific
 * signals (targeting, budget, run-status) are tested BEFORE the generic
 * object-name signals (ad_set / campaign) so e.g. `update_ad_set_target_spec`
 * lands in `targeting`, not `structure`, and `update_campaign_budget` lands in
 * `budget`, not `structure`. Pure + exported for unit testing.
 */
export function categorizeActivityEvent(eventType: string): ActivityCategory {
  const e = (eventType || '').toLowerCase();
  if (/target|audience|geo_location|interest|behavior|lookalike|placement|dsa|country/.test(e)) return 'targeting';
  if (/budget|bid|spend_cap|spend_limit|cost_cap|roas|amount/.test(e)) return 'budget';
  if (/run_status|pause|unpause|resume|reactivat|archive|delete|remove/.test(e)) return 'status';
  if (/creativ|add_image|add_video|create_ad(?!_set|_campaign)|update_ad(?!_set|_campaign|_account)/.test(e)) return 'creative';
  if (/campaign|ad_set|adgroup|ad_group|create_ad_set/.test(e)) return 'structure';
  if (/account|billing|payment|funding|invoice|user|permission|business|owner/.test(e)) return 'account';
  return 'other';
}

export interface AccountActivityInputs {
  events: ActivityEvent[];
  currency: string;
  /** Monthly retainer the account owner pays whoever manages the account.
   *  Nullable — usually unknown at audit time; when null, no cost claim is made. */
  monthlyRetainer: number | null;
  /** True when the live pull hit its page cap — counts are a floor, not exact. */
  partial?: boolean;
  /**
   * Whether the source carried WHO made each change. False on a read whose rows
   * have no actor on them at all (the generation seam's normalized history), and
   * then the section reports what changed and when, and never a who: one
   * "Unattributed" bucket holding every change reads as a finding about a person
   * rather than as a gap in the data.
   */
  actorsAvailable?: boolean;
  /** Override "now" for deterministic tests. Defaults to current time. */
  asOf?: string;
  /** Lookback the fetch actually requested (days). Default 90. */
  windowDays?: number;
}

const dayOf = (iso: string): string => String(iso).slice(0, 10);
const dayNumber = (isoDay: string): number => Math.floor(Date.parse(`${isoDay}T00:00:00Z`) / 86_400_000);

export function computeAccountActivity(inp: AccountActivityInputs): PackSection {
  const { events, currency, monthlyRetainer } = inp;
  const windowDays = inp.windowDays ?? 90;
  const asOf = inp.asOf ? new Date(inp.asOf) : new Date();
  const asOfDay = dayOf(asOf.toISOString());
  const cut30 = new Date(asOf.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);

  // Empty log is itself an honest finding — a dormant / untouched account.
  if (events.length === 0) {
    return {
      summary:
        `Meta's change log shows no recorded account changes in the last ${windowDays} days. ` +
        `Nobody — no person, no agency, no automated tool — has touched campaigns, budgets, creative, or targeting in that window (as far as the audit log records).`,
      next_step:
        `If someone is being paid to manage this account, ask what they've changed lately — the log is empty. ` +
        `A truly evergreen account can coast, but zero activity usually means the account is on autopilot, not being optimized.`,
      data: {
        window_days: windowDays,
        no_activity: true,
        total_30d: 0,
        total_window: 0,
        actions_per_week: 0,
        days_since_last_change: null,
        longest_zero_streak_days: null,
        by_category: [],
        by_actor: [],
        by_application: [],
        monthly_retainer: monthlyRetainer,
        cost_per_change_30d: null,
        cost_per_change_window: null,
        partial: !!inp.partial,
      },
      warnings: [
        `Meta's activities log has a limited retention window and does not record every automated delivery adjustment — read "no changes" as "no changes we can see", not a guarantee.`,
      ],
      derivation:
        `Read the account's change history live from Meta's activities edge (read-only, ads_read). ` +
        `The log returned zero events in the ${windowDays}-day lookback.`,
    };
  }

  // Sort ascending by time; derive counts, categories, actors, and gaps.
  const sorted = [...events].sort((a, b) => a.event_time.localeCompare(b.event_time));
  let count30 = 0;
  const catWindow = new Map<ActivityCategory, number>();
  const cat30 = new Map<ActivityCategory, number>();
  const actorAgg = new Map<string, { id: string | null; name: string; count: number }>();
  const appAgg = new Map<string, { id: string | null; name: string; count: number }>();
  const activeDays = new Set<string>();

  for (const ev of sorted) {
    const cat = categorizeActivityEvent(ev.event_type);
    catWindow.set(cat, (catWindow.get(cat) ?? 0) + 1);
    const d = dayOf(ev.event_time);
    activeDays.add(d);
    if (d >= cut30) {
      count30 += 1;
      cat30.set(cat, (cat30.get(cat) ?? 0) + 1);
    }
    // Actor attribution: prefer a named human/actor; fall back to the
    // application, then to an explicit "unattributed" bucket — never guess.
    const actorKey = ev.actor_id ?? (ev.actor_name ? `name:${ev.actor_name}` : null);
    const actorName = ev.actor_name ?? (ev.actor_id ? `Actor ${ev.actor_id}` : 'Unattributed (no actor on record)');
    if (actorKey || ev.actor_name) {
      const k = actorKey ?? `name:${ev.actor_name}`;
      const a = actorAgg.get(k) ?? { id: ev.actor_id, name: actorName, count: 0 };
      a.count += 1;
      actorAgg.set(k, a);
    } else {
      const a = actorAgg.get('__none__') ?? { id: null, name: 'Unattributed (no actor on record)', count: 0 };
      a.count += 1;
      actorAgg.set('__none__', a);
    }
    if (ev.application_id || ev.application_name) {
      const k = ev.application_id ?? `name:${ev.application_name}`;
      const app = appAgg.get(k) ?? { id: ev.application_id, name: ev.application_name ?? `App ${ev.application_id}`, count: 0 };
      app.count += 1;
      appAgg.set(k, app);
    }
  }

  const totalWindow = sorted.length;
  const weeks = windowDays / 7;
  const actionsPerWeek = r1(totalWindow / weeks);

  // Inactivity gaps. We count gaps BETWEEN observed changes and the trailing
  // gap up to "now" — but deliberately NOT the leading gap from window-start to
  // the first observed change: the activities log has a retention limit, so an
  // apparent lull at the start of the window can be missing data, not real
  // quiet. Trailing/inter-event gaps are real.
  const sortedActiveDays = [...activeDays].sort();
  const lastDay = sortedActiveDays[sortedActiveDays.length - 1]!;
  const daysSinceLastChange = Math.max(0, dayNumber(asOfDay) - dayNumber(lastDay));
  let longestZeroStreak = daysSinceLastChange; // trailing quiet counts
  for (let i = 1; i < sortedActiveDays.length; i++) {
    const gap = dayNumber(sortedActiveDays[i]!) - dayNumber(sortedActiveDays[i - 1]!) - 1;
    if (gap > longestZeroStreak) longestZeroStreak = gap;
  }

  const byCategory = [...catWindow.entries()]
    .map(([category, count]) => ({
      category,
      label: ACTIVITY_CATEGORY_LABEL[category],
      count,
      count_30d: cat30.get(category) ?? 0,
      share_pct: pct(count, totalWindow),
    }))
    .sort((a, b) => b.count - a.count);

  const byActor = [...actorAgg.values()]
    .map((a) => ({ actor_id: a.id, actor_name: a.name, count: a.count, share_pct: pct(a.count, totalWindow) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const byApplication = [...appAgg.values()]
    .map((a) => ({ application_id: a.id, application_name: a.name, count: a.count, share_pct: pct(a.count, totalWindow) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Derived cost framing — ONLY when a retainer is known (nullable). We store
  // the raw quotients; the report layer decides how to phrase them.
  const costPerChange30d = monthlyRetainer != null && count30 > 0 ? r2(monthlyRetainer / count30) : null;
  const retainerOverWindow = monthlyRetainer != null ? monthlyRetainer * (windowDays / 30) : null;
  const costPerChangeWindow = retainerOverWindow != null && totalWindow > 0 ? r2(retainerOverWindow / totalWindow) : null;

  const topCat = byCategory[0];
  const actorsKnown = inp.actorsAvailable !== false;
  const topActor = actorsKnown ? byActor[0] : undefined;
  const namedActors = actorsKnown
    ? byActor.filter((a) => a.actor_id || !a.actor_name.startsWith('Unattributed'))
    : [];

  const summaryParts: string[] = [];
  summaryParts.push(
    `Meta logged ${totalWindow.toLocaleString('en-US')} account change${totalWindow === 1 ? '' : 's'} in the last ${windowDays} days ` +
      `(${count30} in the last 30) — about ${actionsPerWeek} per week.`,
  );
  if (topCat) {
    summaryParts.push(`The biggest slice was ${topCat.label} (${topCat.share_pct}%).`);
  }
  if (topActor && namedActors.length > 0) {
    summaryParts.push(
      `Most changes were made by ${topActor.actor_name} (${topActor.count} of ${totalWindow}${byApplication[0] ? `, via ${byApplication[0].application_name}` : ''}).`,
    );
  } else if (byApplication[0]) {
    summaryParts.push(
      `The log doesn't attribute changes to a named person; the most active tool was ${byApplication[0].application_name} (${byApplication[0].count} of ${totalWindow}).`,
    );
  }
  summaryParts.push(
    `Longest quiet stretch: ${longestZeroStreak} day${longestZeroStreak === 1 ? '' : 's'} with zero changes; the last change was ${daysSinceLastChange} day${daysSinceLastChange === 1 ? '' : 's'} ago.`,
  );
  if (costPerChange30d != null) {
    summaryParts.push(
      `At a ${money(monthlyRetainer!, currency)}/mo retainer that's ${money(costPerChange30d, currency)} per logged change last month.`,
    );
  }

  const nextStep =
    count30 === 0
      ? `No changes at all in the last 30 days. If you're paying for active management, that's the first thing to raise — ask what was done and why the account went quiet.`
      : actionsPerWeek < 1
        ? `Under one change a week is light-touch management. Ask whoever runs the account what their testing cadence is — healthy accounts usually see new creative and budget moves every week.`
        : `Cross-check this against the results: lots of changes is only good if the account is improving. Ask for the reasoning behind the recent ${count30} changes, not just the count.`;

  const warnings: string[] = [];
  warnings.push(
    `Meta's activities log has a limited retention window and does not capture every automated delivery adjustment — treat these counts as what's on the record, not a complete history.`,
  );
  if (inp.partial) {
    warnings.push(`The change-history pull hit its page cap — the ${windowDays}-day counts are a floor; the real totals are higher.`);
  }
  if (!actorsKnown) {
    // The seam's normalized history carries WHAT changed and WHEN, and no actor
    // column at all. Reporting one "unattributed" bucket over every change
    // would read as a finding about a person nobody named.
    warnings.push(
      `This account's change log reached us without the person or tool behind each change, so this section reports what changed and when, and says nothing about who did it.`,
    );
  } else if (namedActors.length === 0) {
    warnings.push(`No changes in this window are attributed to a named person — Meta returned only app/system-level actors, so "who acted" can't be broken down by individual.`);
  }

  // A managed account changing every week is the log reading normal: the old
  // "cross-check this against the results" line asked the reader to go and
  // think, which is not a step. A quiet account, or a near-quiet one, is.
  const activitySignal = count30 === 0 || actionsPerWeek < 1;
  return {
    summary: summaryParts.join(' '),
    ...(activitySignal ? { next_step: nextStep } : {}),
    data: {
      window_days: windowDays,
      signal: activitySignal,
      no_activity: false,
      total_window: totalWindow,
      total_30d: count30,
      actions_per_week: actionsPerWeek,
      days_since_last_change: daysSinceLastChange,
      longest_zero_streak_days: longestZeroStreak,
      by_category: byCategory,
      by_actor: actorsKnown ? byActor : [],
      by_application: byApplication,
      named_actor_count: namedActors.length,
      actor_attribution_available: actorsKnown,
      monthly_retainer: monthlyRetainer,
      cost_per_change_30d: costPerChange30d,
      cost_per_change_window: costPerChangeWindow,
      currency,
      partial: !!inp.partial,
    },
    warnings: warnings.length ? warnings : undefined,
    derivation:
      `Read the account's change history live from Meta's activities edge (act_<id>/activities, read-only under ads_read). ` +
      `Counted ${totalWindow.toLocaleString('en-US')} events over ${windowDays} days, bucketed each event_type into ${Object.keys(ACTIVITY_CATEGORY_LABEL).length} human categories, ` +
      (actorsKnown
        ? `aggregated by actor and by application, and measured gaps between change-days (trailing quiet counts; a leading gap is treated as possible missing data, not inactivity). `
        : `and measured gaps between change-days (trailing quiet counts; a leading gap is treated as possible missing data, not inactivity). The rows reached us without an actor on them, so nothing here is attributed to a person or a tool. `) +
      (monthlyRetainer != null
        ? `Cost-per-change divides the stated ${money(monthlyRetainer, currency)}/mo retainer by the change count.`
        : `No retainer was supplied, so no cost-per-change is claimed.`),
  };
}

// ---------------------------------------------------------------------------
// L. Audience segments — who the budget actually reaches (the generation
//    seam's user_segment breakdown; Meta's own Advantage+ segment keys)
// ---------------------------------------------------------------------------

export interface SegmentSpendRow {
  /** The provider's own segment key, verbatim, `unknown` included. */
  key: string;
  spend: number;
  impressions: number;
  purchases: number;
  purchase_value: number;
  leads: number;
}

export type SegmentKind = 'new' | 'engaged' | 'existing' | 'unknown' | 'other';

/**
 * Which of the four things a segment key means, by the words in the key.
 *
 * Meta names these keys and renames them, so nothing here hardcodes a full
 * string: a key it cannot place reads `other` and is reported under its own
 * name rather than folded into a bucket it might not belong to. `new` is tested
 * BEFORE `existing` on purpose, because "non-customer" contains "customer".
 */
export function classifySegmentKey(key: string): SegmentKind {
  const k = (key || '').trim().toLowerCase();
  if (!k || /^(unknown|n\/?a|not available|undefined)$/.test(k)) return 'unknown';
  if (/\b(new|prospect\w*|cold|unengaged|non.?customer)\b/.test(k)) return 'new';
  if (/engag/.test(k)) return 'engaged';
  if (/exist\w*|customer|purchas\w*|repeat|retarget\w*/.test(k)) return 'existing';
  return 'other';
}

const SEGMENT_LABEL: Record<SegmentKind, string> = {
  new: 'people who have never heard of you',
  engaged: 'people who engaged with you before',
  existing: 'people who already bought from you',
  unknown: 'a segment Meta did not name',
  other: 'another segment',
};

export interface AudienceSegmentsInputs {
  rows: SegmentSpendRow[];
  currency: string;
  /** The window the rows cover, for the sentence that quotes them. */
  windowDays: number;
  /**
   * True when the core window held nothing and the read was widened backwards.
   * Stated on the section, because a figure over a different window than the
   * rest of the report has to say so.
   */
  widened?: boolean;
}

/**
 * How much of the budget reaches people who already know the business.
 *
 * TWO findings live here and they are different sentences. On an account with
 * real segment keys it is a share: what went to strangers versus to people who
 * have met you. On an account where every impression comes back `unknown` it is
 * the absence itself: no engaged or existing audiences are defined, which most
 * accounts never do, and until they exist nobody can read this split. Meta does
 * not error on the second case, it answers unknown for everything, so the
 * distinction has to be drawn here.
 */
export function computeAudienceSegments(inp: AudienceSegmentsInputs): PackSection {
  const { currency, windowDays } = inp;
  const byKey = new Map<string, SegmentSpendRow>();
  for (const row of inp.rows) {
    const a = byKey.get(row.key) ?? { key: row.key, spend: 0, impressions: 0, purchases: 0, purchase_value: 0, leads: 0 };
    a.spend += row.spend || 0;
    a.impressions += row.impressions || 0;
    a.purchases += row.purchases || 0;
    a.purchase_value += row.purchase_value || 0;
    a.leads += row.leads || 0;
    byKey.set(row.key, a);
  }
  const rows = [...byKey.values()];
  const totalSpend = rows.reduce((s, r) => s + r.spend, 0);
  const windowWord = inp.widened
    ? `the last ${windowDays} days this account actually spent in`
    : `the last ${windowDays} days`;

  if (rows.length === 0 || totalSpend < 100) {
    return {
      summary: `Meta reported no audience-segment delivery for ${windowWord}, so there is no split to read.`,
      data: { segments: [], signal: false, window_days: windowDays, widened: !!inp.widened },
      warnings: ['No segment rows with meaningful spend — read suppressed rather than guessed.'],
    };
  }

  const mode = rows.some((r) => r.purchase_value > 0) ? 'roas' : 'cpr';
  const kpiLabel = mode === 'roas' ? 'Meta ROAS' : 'cost per result';
  const resultsOf = (r: SegmentSpendRow): number => (mode === 'roas' ? r.purchases : r.purchases || r.leads);
  const kpiOf = (r: SegmentSpendRow): number | null =>
    mode === 'roas' ? (r.spend > 0 ? r2(div(r.purchase_value, r.spend)) : null) : resultsOf(r) > 0 ? r2(div(r.spend, resultsOf(r))) : null;

  const segments = rows
    .map((r) => ({
      key: r.key,
      kind: classifySegmentKey(r.key),
      spend: Math.round(r.spend),
      spend_share_pct: pct(r.spend, totalSpend),
      results: resultsOf(r),
      kpi: kpiOf(r),
    }))
    .sort((a, b) => b.spend - a.spend);

  const shareOf = (kind: SegmentKind): number =>
    pct(
      segments.filter((s) => s.kind === kind).reduce((s, x) => s + x.spend, 0),
      totalSpend,
    );

  // Every impression under an unnamed segment IS the finding: it is what an
  // account with no engaged or existing audiences defined looks like from here.
  if (segments.every((s) => s.kind === 'unknown')) {
    return {
      summary:
        `Every one of the ${money(totalSpend, currency)} spent in ${windowWord} comes back under a segment Meta could not name, ` +
        `which is what an account with no engaged or existing audiences defined looks like. Most accounts never set these up, ` +
        `so this is common rather than careless, and it means nobody can tell how much of this budget goes to people who already know you.`,
      next_step:
        `Define the two audiences that make this readable: a customer list of the people who already bought, and a website audience of ` +
        `the people who visited and did not. Once they exist, this split says how much of the budget goes to strangers and how much to people who have met you.`,
      data: {
        window_days: windowDays,
        widened: !!inp.widened,
        signal: true,
        segments_defined: false,
        currency,
        total_spend: Math.round(totalSpend),
        segments,
      },
      derivation:
        `One account-level insights read for ${windowWord}, split by Meta's own audience-segment key. ` +
        `Every row came back under an unnamed segment, and that is reported as the absence of defined audiences rather than as a share of anything. ` +
        `Meta does not refuse this read on an account without segments, it answers unknown for all of it, so the two cases are told apart here.`,
    };
  }

  const newShare = shareOf('new');
  const knownShare = shareOf('engaged') + shareOf('existing');
  const newSegment = segments.find((s) => s.kind === 'new') ?? null;
  const bestKnown = segments
    .filter((s) => s.kind === 'engaged' || s.kind === 'existing')
    .filter((s) => s.kpi != null && s.spend_share_pct >= 10)
    .sort((a, b) => (mode === 'roas' ? (b.kpi ?? 0) - (a.kpi ?? 0) : (a.kpi ?? Infinity) - (b.kpi ?? Infinity)))[0];
  const beatsCold =
    bestKnown != null &&
    newSegment?.kpi != null &&
    bestKnown.kpi != null &&
    (mode === 'roas' ? bestKnown.kpi >= newSegment.kpi * 1.25 : bestKnown.kpi <= newSegment.kpi * 0.75);

  const summaryParts: string[] = [];
  if (newSegment) {
    summaryParts.push(
      `${newShare}% of the spend in ${windowWord} went to people who have never heard of you ` +
        `(${money(newSegment.spend, currency)} of ${money(totalSpend, currency)}${newSegment.kpi != null ? `, at ${kpiLabel} ${newSegment.kpi}` : ''}).`,
    );
  } else {
    const top = segments[0]!;
    summaryParts.push(
      `The biggest segment in ${windowWord} is "${top.key}" at ${top.spend_share_pct}% of spend ` +
        `(${money(top.spend, currency)}${top.kpi != null ? `, ${kpiLabel} ${top.kpi}` : ''}).`,
    );
  }
  if (knownShare === 0) {
    summaryParts.push(
      `Nothing at all went to people who already know you: the segments exist and no budget is running against them.`,
    );
  } else if (beatsCold && bestKnown) {
    summaryParts.push(
      `"${bestKnown.key}" carries ${bestKnown.spend_share_pct}% of spend at ${kpiLabel} ${bestKnown.kpi}, against ${newSegment?.kpi} for the cold half.`,
    );
  }

  const signal = knownShare === 0 || beatsCold;
  return {
    summary: summaryParts.join(' '),
    ...(knownShare === 0
      ? {
          next_step:
            `Run one small ad set against the people who already know you and compare its ${kpiLabel} to the ${newSegment?.kpi ?? 'cold'} you pay now. ` +
            `A business spending everything on strangers is either growing on purpose or forgetting to ask its own customers twice.`,
        }
      : beatsCold && bestKnown
        ? {
            next_step: `Move a step of budget toward "${bestKnown.key}" and re-read this in two weeks: it is buying results at ${kpiLabel} ${bestKnown.kpi} on ${bestKnown.spend_share_pct}% of spend.`,
          }
        : {}),
    data: {
      window_days: windowDays,
      widened: !!inp.widened,
      signal,
      segments_defined: true,
      kpi_mode: mode,
      kpi_label: kpiLabel,
      currency,
      total_spend: Math.round(totalSpend),
      new_audience_spend_share_pct: newSegment ? newShare : null,
      known_audience_spend_share_pct: knownShare,
      segments,
    },
    derivation:
      `One account-level insights read for ${windowWord}, split by Meta's own audience-segment key, with each key's spend, results and ${kpiLabel}. ` +
      `Keys are placed into "never heard of you", "engaged before" and "already bought" by the words in the key itself; a key we cannot place is reported under its own name rather than folded into a bucket. ` +
      `Shares are of the spend in this window only.`,
  };
}

// ---------------------------------------------------------------------------
// M. Pixel health — what the tracking is set up to send (docs/decisions/0066
//    on the Tinkers side: no invented match-quality score, ever)
// ---------------------------------------------------------------------------

export interface PixelLite {
  id: string;
  name: string | null;
  /** ISO instant of the last event received, when the provider reports one. */
  last_fired_time: string | null;
  automatic_matching_enabled: boolean | null;
  automatic_matching_fields: string[];
  /** Null whenever nothing was measured. A null rate is never mentioned. */
  match_rate_approx: number | null;
  /** The provider's own checks, with its own result word. */
  diagnostics: Array<{ key: string; title: string; result: string }>;
}

export interface PixelHealthInputs {
  pixels: PixelLite[];
  /** The run day, so "last fired" can be stated in days. */
  asOf: string;
}

/** A rate reported as a fraction on the node and as a percentage elsewhere. */
function matchRatePct(value: number): number {
  return r1(value <= 1 ? value * 100 : value);
}

/**
 * What the account's tracking is set up to send, and what Meta says about it.
 *
 * There is deliberately NO score here. `event_match_quality` is not a field on
 * this node, the approximate match rate is null whenever nothing was measured,
 * and the diagnostics are a pass/fail checklist carrying Meta's own result
 * word. A grade would be the most quotable wrong thing an audit could say about
 * somebody's tracking, so the section reports the settings, the recency and the
 * named checks that are not passing, and nothing else.
 */
export function computePixelHealth(inp: PixelHealthInputs): PackSection {
  const asOfDay = String(inp.asOf).slice(0, 10);
  const daysSince = (iso: string | null): number | null => {
    if (!iso) return null;
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return null;
    return Math.max(0, Math.round((Date.parse(`${asOfDay}T00:00:00Z`) - then) / 86_400_000));
  };

  if (inp.pixels.length === 0) {
    return {
      summary:
        `Meta lists no pixel on this ad account, so nothing that happens after the click is measured here and every optimization runs on the click alone.`,
      next_step:
        `Create a pixel in Events Manager and put it on the site, then point the ad sets at the event that matters (a purchase or a lead). Until it exists there is no cost per result to optimize toward.`,
      data: { signal: true, pixels: [], pixel_count: 0 },
      derivation: `One read of the ad account's own pixel list. An empty list is the account having no pixel attached, not a read that failed: a failed read is reported as a failed read.`,
    };
  }

  const rows = inp.pixels.map((p) => {
    const failing = p.diagnostics.filter((d) => d.result.toLowerCase() !== 'passed');
    return {
      id: p.id,
      name: p.name,
      advanced_matching: p.automatic_matching_enabled,
      advanced_matching_fields: p.automatic_matching_fields,
      advanced_matching_field_count: p.automatic_matching_fields.length,
      last_fired_days_ago: daysSince(p.last_fired_time),
      match_rate_pct: p.match_rate_approx != null ? matchRatePct(p.match_rate_approx) : null,
      failing_checks: failing.map((d) => ({ title: d.title || d.key, result: d.result })),
      checks_read: p.diagnostics.length,
    };
  });

  // The pixel that fired most recently is the one the account is actually
  // running on; an older one is usually a leftover from a previous site.
  const primary =
    [...rows].sort((a, b) => (a.last_fired_days_ago ?? Number.MAX_SAFE_INTEGER) - (b.last_fired_days_ago ?? Number.MAX_SAFE_INTEGER))[0]!;
  const primaryName = primary.name ? `"${primary.name}"` : `the pixel on this account`;

  const parts: string[] = [];
  parts.push(
    rows.length === 1
      ? `${primaryName} is the one pixel on this account.`
      : `${primaryName} is the most recently active of the ${rows.length} pixels on this account.`,
  );
  if (primary.advanced_matching === true) {
    parts.push(
      primary.advanced_matching_field_count > 0
        ? `Advanced Matching is on and sending ${primary.advanced_matching_field_count} customer field${primary.advanced_matching_field_count === 1 ? '' : 's'} (${primary.advanced_matching_fields.join(', ')}), which is what lets Meta match a sale back to the person who saw the ad.`
        : `Advanced Matching is on and Meta reports no fields against it, so nothing extra is being matched.`,
    );
  } else if (primary.advanced_matching === false) {
    parts.push(
      `Advanced Matching is off, so Meta only matches a conversion when the browser hands it enough on its own. Every unmatched sale is a sale your ads do not get credited with.`,
    );
  } else {
    parts.push(`Meta did not say whether Advanced Matching is on, so this report does not claim either way.`);
  }
  if (primary.last_fired_days_ago === null) {
    parts.push(`Meta reports no last-fired time for it, so the recency of the last event is not on record.`);
  } else if (primary.last_fired_days_ago === 0) {
    parts.push(`It last received an event today.`);
  } else {
    parts.push(
      `It last received an event ${primary.last_fired_days_ago} day${primary.last_fired_days_ago === 1 ? '' : 's'} ago.`,
    );
  }
  if (primary.match_rate_pct != null) {
    parts.push(`Meta puts its approximate match rate at ${primary.match_rate_pct}%.`);
  }
  const failing = rows.flatMap((r) => r.failing_checks.map((c) => ({ ...c, pixel: r.name ?? r.id })));
  if (failing.length > 0) {
    const named = failing.slice(0, 3).map((c) => `"${c.title}" (${c.result})`).join(', ');
    parts.push(
      `${failing.length} of Meta's own checks on ${failing.length === 1 ? 'it' : 'these pixels'} is not passing: ${named}. Those are Meta's words for its own checks, carried over unchanged.`,
    );
  } else if (rows.some((r) => r.checks_read > 0)) {
    parts.push(`Every check Meta runs on it comes back passed.`);
  }

  const stale = primary.last_fired_days_ago != null && primary.last_fired_days_ago >= 7;
  const signal = primary.advanced_matching === false || failing.length > 0 || stale;
  const nextStep =
    primary.advanced_matching === false
      ? `Turn Advanced Matching on in Events Manager and let it send email and phone where the site already collects them. It is a settings change, and it usually recovers conversions the pixel is currently dropping.`
      : failing.length > 0
        ? `Open Events Manager and work through the check Meta names first: "${failing[0]!.title}". Every one of these is Meta telling you a specific thing about the setup, in its own words.`
        : stale
          ? `Nothing has reached this pixel in ${primary.last_fired_days_ago} days. Fire a test event from the site and confirm it lands, because a silent pixel makes every cost per result in this report a floor.`
          : '';

  return {
    summary: parts.join(' '),
    ...(nextStep ? { next_step: nextStep } : {}),
    data: {
      signal,
      pixel_count: rows.length,
      pixels: rows,
      // Named so nobody adds one later: this section carries no score.
      match_quality_score: null,
    },
    derivation:
      `One read of the ad account's pixels: whether Advanced Matching is on and which customer fields it sends, when each pixel last received an event, ` +
      `and Meta's own diagnostic checks with their result word carried verbatim. There is deliberately no match-quality score: Meta does not expose one on this node, ` +
      `and the approximate match rate is only stated when Meta measured one.`,
  };
}

// ---------------------------------------------------------------------------
// N. Launching and testing — how much new creative ships, and how far each
//    test gets before it stops
// ---------------------------------------------------------------------------

/** One ad's whole read, as the six-month inventory holds it. */
export interface LaunchAdSpan {
  ad_id: string;
  ad_name: string | null;
  spend: number;
  first_spend_date: string | null;
  last_spend_date: string | null;
}

export interface LaunchDisciplineInputs {
  ads: LaunchAdSpan[];
  /** Account spend per calendar month, ascending, from the six-month read. */
  monthlySpend: Array<{ month: string; spend: number }>;
  /** The window's last day: an ad still spending on it has not stopped. */
  anchorDate: string;
  currency: string;
  /** The owner's own stated cost per result, when they gave one. */
  costTarget: { metric: string; value: number } | null;
  resultNoun: string;
}

/**
 * The launch expectation, and it is a PLANNING RULE rather than a measurement:
 * about one new ad a month per 3,000 of monthly spend, never fewer than two.
 * Currency-naive, like every other floor in this file. It is stated in the
 * section as what it is, because a benchmark a reader cannot source is a
 * number they cannot argue with.
 */
export const SPEND_PER_NEW_AD = 3_000;
export const MIN_NEW_ADS_PER_MONTH = 2;

/** A test is fair once it has had about three times the target cost per result. */
export const FAIR_TEST_TARGET_MULTIPLE = 3;

export function computeLaunchDiscipline(inp: LaunchDisciplineInputs): PackSection {
  const months = [...inp.monthlySpend].sort((a, b) => a.month.localeCompare(b.month));
  // The read's FIRST month is dropped from the cadence: every ad already
  // running when the window opens has its first spending day inside it, so that
  // month reports launches that are really just the account's existing ads.
  const judged = months.slice(1);
  if (judged.length < 2) {
    return {
      summary: `The read covers too few months to judge a launch cadence: a rhythm needs at least two full months after the first one, which only shows the ads that were already running.`,
      data: { signal: false, months: [], window_months: months.length },
      warnings: ['Not enough monthly history for a launch cadence — read suppressed rather than guessed.'],
    };
  }

  const monthOf = (date: string | null): string | null => (date ? date.slice(0, 7) : null);
  const launchesByMonth = new Map<string, string[]>();
  for (const ad of inp.ads) {
    const month = monthOf(ad.first_spend_date);
    if (!month) continue;
    const list = launchesByMonth.get(month) ?? [];
    list.push(ad.ad_name ?? ad.ad_id);
    launchesByMonth.set(month, list);
  }

  const rows = judged.map((m) => {
    const launched = launchesByMonth.get(m.month)?.length ?? 0;
    const expected = Math.max(MIN_NEW_ADS_PER_MONTH, Math.round(m.spend / SPEND_PER_NEW_AD));
    return { month: m.month, spend: Math.round(m.spend), launched, expected, short: launched < expected };
  });

  const totalLaunched = rows.reduce((s, r) => s + r.launched, 0);
  const avgLaunched = r1(totalLaunched / rows.length);
  const avgSpend = rows.reduce((s, r) => s + r.spend, 0) / rows.length;
  const avgExpected = Math.max(MIN_NEW_ADS_PER_MONTH, Math.round(avgSpend / SPEND_PER_NEW_AD));
  const shortMonths = rows.filter((r) => r.short).length;

  // The fair-test bar only exists when the owner gave us a target: three times
  // a number nobody stated is three times nothing.
  const fairTestBar = inp.costTarget ? inp.costTarget.value * FAIR_TEST_TARGET_MULTIPLE : null;
  const unfairlyTested = fairTestBar
    ? inp.ads.filter(
        (a) =>
          a.spend > 0 &&
          a.spend < fairTestBar &&
          a.last_spend_date != null &&
          a.last_spend_date < inp.anchorDate,
      )
    : [];

  const parts: string[] = [];
  parts.push(
    `Across the ${rows.length} full months in this read you launched ${totalLaunched} new ad${totalLaunched === 1 ? '' : 's'}, ` +
      `about ${avgLaunched} a month on ${money(avgSpend, inp.currency)} of monthly spend.`,
  );
  parts.push(
    shortMonths > 0
      ? `At one new ad per ${money(SPEND_PER_NEW_AD, inp.currency)} of monthly spend, with a floor of ${MIN_NEW_ADS_PER_MONTH} a month, that spend calls for about ${avgExpected}. ` +
          `${shortMonths} of the ${rows.length} months came in under it. That number is the rate this desk plans to, not a measurement of your account.`
      : `At one new ad per ${money(SPEND_PER_NEW_AD, inp.currency)} of monthly spend, with a floor of ${MIN_NEW_ADS_PER_MONTH} a month, that spend calls for about ${avgExpected}, and every month in the read clears it. ` +
          `That number is the rate this desk plans to, not a measurement of your account.`,
  );
  if (fairTestBar != null && unfairlyTested.length > 0) {
    parts.push(
      `${unfairlyTested.length} ad${unfairlyTested.length === 1 ? '' : 's'} never got a fair test: ${unfairlyTested.length === 1 ? 'it' : 'each'} stopped spending having taken under ` +
        `${money(fairTestBar, inp.currency)}, which is ${FAIR_TEST_TARGET_MULTIPLE} times the ${money(inp.costTarget!.value, inp.currency)} per ${inp.resultNoun} you told us you want. ` +
        `Under that much spend one result is luck and none is not evidence.`,
    );
  }

  const signal = shortMonths > rows.length / 2 || unfairlyTested.length > 0;
  return {
    summary: parts.join(' '),
    ...(signal
      ? {
          next_step:
            unfairlyTested.length > 0 && shortMonths > rows.length / 2
              ? `Two things, in this order: launch about ${avgExpected} genuinely different ads a month at this spend, and give each one ${money(fairTestBar ?? 0, inp.currency)} before you judge it. Fewer tests, each funded properly, beats more tests nobody can read.`
              : unfairlyTested.length > 0
                ? `Give each new ad ${money(fairTestBar ?? 0, inp.currency)} before you decide about it. Stopping earlier than that is paying for a test and throwing away the answer.`
                : `Raise the launch rate to about ${avgExpected} genuinely different ads a month at this spend. At one winner per twenty tests, the number of tests is what decides how many winners you get.`,
        }
      : {}),
    data: {
      signal,
      window_months: months.length,
      months_judged: rows.length,
      months: rows,
      launched_total: totalLaunched,
      launched_per_month: avgLaunched,
      expected_per_month: avgExpected,
      months_below_expectation: shortMonths,
      spend_per_new_ad_benchmark: SPEND_PER_NEW_AD,
      min_new_ads_per_month: MIN_NEW_ADS_PER_MONTH,
      fair_test_bar: fairTestBar,
      fair_test_target_multiple: fairTestBar != null ? FAIR_TEST_TARGET_MULTIPLE : null,
      ads_without_fair_test: unfairlyTested.length,
      ads_without_fair_test_names: unfairlyTested.slice(0, 8).map((a) => a.ad_name ?? a.ad_id),
      currency: inp.currency,
    },
    derivation:
      `Every ad in the six-month read is dated by its FIRST spending day, which is when it launched as far as delivery is concerned, and counted into that month. ` +
      `The read's first month is left out of the cadence: every ad already running when the window opens has its first spending day inside it, which would report old ads as new ones. ` +
      `The expectation is one new ad per ${money(SPEND_PER_NEW_AD, inp.currency)} of that month's own spend with a floor of ${MIN_NEW_ADS_PER_MONTH} a month. ` +
      `It is a planning rate this desk works to, currency-naive like the other floors in this report, and it is not derived from your account.` +
      (fairTestBar != null
        ? ` A fair test is ${FAIR_TEST_TARGET_MULTIPLE} times your own stated ${money(inp.costTarget!.value, inp.currency)} per ${inp.resultNoun}: an ad that stopped spending under that has not been given enough to read.`
        : ` No cost target was given, so no fair-test bar is claimed and no ad is counted as under-tested.`),
  };
}
