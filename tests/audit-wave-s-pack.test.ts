import { describe, it, expect } from 'vitest';
import {
  computeConcentration, computeFatigue, computeCohorts, computeCostTrend, computeDayOfWeek,
  type PackAdRow, type PackAccountRow, type FatigueAd, type DraggingAd,
} from '../src/audit/report-pack.js';

/**
 * The customer-simulation review of the first live lead-gen report. Every case
 * here is a thing the page printed wrong because the generator handed it the
 * wrong shape: a leads-per-spend RATE labelled "0.04x ROAS", a daily run-rate
 * multiplied out to a month, a "below breakeven" filter that matched every ad on
 * an account with no revenue, a CPM chapter that read "flat, no action needed"
 * over a 62% CTR slide, and a freshness grade built on a 65-day window.
 *
 * The anchor account is the life-insurance one: 482 leads, 18.59 cost per lead,
 * ZERO purchases, `results` left at 0 by the bridged pull.
 */

const day = (i: number): string => new Date(Date.UTC(2026, 3, 1 + i)).toISOString().slice(0, 10);

/** One lead-gen ad: no purchases, no purchase value, results unmapped. */
function leadRows(
  adId: string,
  name: string,
  days: number,
  spendByDay: (i: number) => number,
  leadsByDay: (i: number) => number,
  freq = 1.8,
): PackAdRow[] {
  return Array.from({ length: days }, (_, i) => ({
    ad_id: adId, ad_name: name, date: day(i), spend: spendByDay(i),
    impressions: 8_000, purchases: 0, purchase_value: 0, results: 0,
    frequency: freq, hook_rate: null, hold_rate: null, leads: leadsByDay(i),
  }));
}

/** One e-commerce ad: purchase value present, so the account reads in ROAS. */
function ecomRows(
  adId: string,
  name: string,
  days: number,
  spendPerDay: number,
  roasByDay: (i: number) => number,
  freq = 2.0,
): PackAdRow[] {
  return Array.from({ length: days }, (_, i) => ({
    ad_id: adId, ad_name: name, date: day(i), spend: spendPerDay,
    impressions: 10_000, purchases: 5, purchase_value: spendPerDay * roasByDay(i),
    results: 5, frequency: freq, hook_rate: 25, hold_rate: 10,
  }));
}

const adOf = (s: { data: { ads: FatigueAd[] } }, id: string): FatigueAd =>
  s.data.ads.find((a) => a.ad_id === id)!;

// The anchor ad: 185.9/day and 10 leads/day is a cost per lead of exactly 18.59.
const ANCHOR_DECAYER = leadRows('f1', 'anchor-decayer', 60, () => 185.9, (i) => (i < 30 ? 20 : 10));

describe('fatigue rows carry money, not just rates (T1)', () => {
  it('spend_30d is REAL summed spend over the window\'s last 30 days, not a run-rate times 30', () => {
    // 100/day for 76 days, then 300/day for the last 14. The page multiplied the
    // 300/day run-rate by 30 and printed 9,000 against a real 5,800.
    const s = computeFatigue(leadRows('a1', 'anchor', 90, (i) => (i < 76 ? 100 : 300), () => 10));
    const ad = adOf(s, 'a1');
    expect(ad.spend_30d).toBe(5_800);
    expect(ad.recent_daily_spend).toBe(300);
    expect(ad.spend_30d).not.toBe(ad.recent_daily_spend * 30);
    expect(ad.spend).toBe(11_800); // the 90-day figure is untouched
  });

  it('cpr mode adds a real cost per lead beside the unitless rate fields', () => {
    const ad = adOf(computeFatigue(ANCHOR_DECAYER, 1.0, 'USD'), 'f1');
    expect(ad.cpl_first_half).toBe(9.29); // 5,577 spend / 600 leads, rounded to the cent
    expect(ad.cpl_last_14).toBeCloseTo(18.59, 2);
    // The rate fields the page mislabelled as ROAS are still there, untouched.
    expect(ad.kpi_first_half).toBeCloseTo(0.11, 2);
    expect(ad.kpi_recent).toBeCloseTo(0.05, 2);
  });

  it('a period with no mapped lead gets a null cost per lead, never a zero', () => {
    const ad = adOf(computeFatigue(leadRows('n1', 'dries-up', 60, () => 200, (i) => (i < 46 ? 10 : 0))), 'n1');
    expect(ad.cpl_first_half).toBeCloseTo(20, 5);
    expect(ad.cpl_last_14).toBeNull();
  });

  it('an e-commerce account carries no cpl fields (its grammar is ROAS)', () => {
    const ad = adOf(computeFatigue(ecomRows('e1', 'ecom-evergreen', 80, 300, () => 2.5)), 'e1');
    expect(ad.cpl_first_half).toBeNull();
    expect(ad.cpl_last_14).toBeNull();
    expect(ad.spend_30d).toBe(9_000); // 30 days x 300
  });

  it('cpr mode emits no breakeven and no margin; roas mode still does', () => {
    const lead = computeFatigue(ANCHOR_DECAYER, 1.0, 'USD');
    expect(lead.data.breakeven_roas).toBeUndefined();
    expect(lead.data.gross_margin_pct).toBeUndefined();
    const ecom = computeFatigue(ecomRows('e1', 'ecom', 60, 300, (i) => 4.5 - (2.0 * i) / 59), 2.22, 'GBP', 45);
    expect(ecom.data.breakeven_roas).toBe(2.22);
    expect(ecom.data.gross_margin_pct).toBe(45);
  });
});

describe('the dragging list is built here, not derived by the page (T1)', () => {
  const draggingOf = (s: { data: Record<string, unknown> }): DraggingAd[] => s.data.dragging as DraggingAd[];

  it('ranks by REAL 30-day spend, not by the 90-day figure the rows are sorted on', () => {
    const s = computeFatigue(
      [
        ...leadRows('early', 'early-heavy', 60, (i) => (i < 30 ? 400 : 50), (i) => (i < 30 ? 40 : 1)),
        ...leadRows('late', 'late-heavy', 60, (i) => (i < 30 ? 50 : 200), (i) => (i < 30 ? 5 : 4)),
      ],
      1.0,
      'USD',
    );
    // The rows are ranked by the figure each row SHOWS: last-30-day spend, with
    // the 90-day sum only as a tie-break. 'early' is the bigger 90-day spender
    // (12,000 against 7,500) but it spent 1,500 in the last 30 days against
    // 6,000, and a list labelled by 30-day spend has to be ordered by it.
    expect(s.data.ads[0]!.ad_id).toBe('late');
    expect(s.data.ads[1]!.ad_id).toBe('early');
    expect(s.data.sorted_by).toBe('spend_30d');
    const drag = draggingOf(s);
    expect(drag.map((d) => d.ad_id)).toEqual(['late', 'early']);
    expect(drag[0]!.spend_30d).toBe(6_000);
    expect(drag[1]!.spend_30d).toBe(1_500);
  });

  it('states the account\'s own labelled figure, never a unitless rate', () => {
    const drag = draggingOf(computeFatigue(ANCHOR_DECAYER, 1.0, 'USD'));
    expect(drag[0]!.stat).toBe('Meta CPL 18.59 USD');
    expect(drag[0]!.why).toContain('9.29 USD');
    expect(drag[0]!.why).toContain('18.59 USD');
    expect(drag[0]!.recent_daily_spend).toBe(186);
  });

  it('says so when the recent window measured no lead at all', () => {
    const drag = draggingOf(computeFatigue(leadRows('n1', 'dries-up', 60, () => 200, (i) => (i < 46 ? 10 : 0)), 1.0, 'USD'));
    expect(drag[0]!.stat).toBe('no leads measured in the last 14 days');
    expect(drag[0]!.why).toContain('200 USD a day');
  });

  it('an e-commerce account gets the ROAS grammar', () => {
    const drag = draggingOf(computeFatigue(ecomRows('f1', 'decayer', 60, 300, (i) => 3.0 - (1.8 * i) / 59), 1.0, 'GBP'));
    expect(drag[0]!.stat).toMatch(/^Meta ROAS \d+\.\d{2}$/);
    expect(drag[0]!.why).toMatch(/down \d/);
  });

  it('excludes the low-frequency acquisition ads and caps the list at 3', () => {
    const guarded = ecomRows('g1', 'prospector', 40, 500, (i) => 2.0 - (1.6 * i) / 39, 1.1);
    const decliners = [200, 300, 400, 500].map((sp, n) =>
      ecomRows(`d${n}`, `decliner-${n}`, 60, sp, (i) => 3.0 - (1.8 * i) / 59),
    );
    const s = computeFatigue([...guarded, ...decliners.flat()], 1.0, 'GBP');
    expect(adOf(s, 'g1').low_frequency_acquisition_guard).toBe(true);
    expect(adOf(s, 'g1').class).toBe('fatiguing');
    const drag = draggingOf(s);
    expect(drag.length).toBe(3);
    expect(drag.map((d) => d.ad_id)).not.toContain('g1');
    expect(drag.map((d) => d.ad_id)).toEqual(['d3', 'd2', 'd1']);
  });

  it('an empty list is stated as empty, with the note that says where to look instead', () => {
    const s = computeFatigue(ecomRows('g1', 'prospector', 40, 500, (i) => 2.0 - (1.6 * i) / 39, 1.1), 1.0, 'GBP');
    expect(draggingOf(s)).toEqual([]);
    expect(String(s.data.dragging_note)).toContain('low-frequency acquisition ads are excluded');
  });

  it('a quiet account carries the same empty list and note', () => {
    const s = computeFatigue(leadRows('e1', 'lead-evergreen', 70, () => 200, () => 10));
    expect(s.data.signal).toBe(false);
    expect(draggingOf(s)).toEqual([]);
    expect(s.data.dragging_note).toBeTruthy();
  });
});

describe('the fatigue summary names the ads it counts (T1)', () => {
  it('names the fatiguing ad and the evergreen winner', () => {
    const s = computeFatigue(
      [
        ...leadRows('f1', 'anchor-decayer', 60, () => 185.9, (i) => (i < 30 ? 20 : 10)),
        ...leadRows('e1', 'lead-evergreen', 70, () => 200, () => 10),
      ],
      1.0,
      'USD',
    );
    expect(s.summary).toContain('"anchor-decayer"');
    expect(s.summary).toContain('"lead-evergreen"');
  });

  it('names the biggest of several fatiguing ads', () => {
    const s = computeFatigue(
      [
        ...leadRows('small', 'small-decayer', 60, () => 100, (i) => (i < 30 ? 20 : 8)),
        ...leadRows('big', 'big-decayer', 60, () => 400, (i) => (i < 30 ? 20 : 8)),
      ],
      1.0,
      'USD',
    );
    expect(s.summary).toContain('the biggest being "big-decayer"');
  });
});

describe('the confirmation window can never overlap the first half (T2)', () => {
  it('a 20-day run confirms on its last 10 days only', () => {
    // First 10 days 10 leads on 200 spend, last 10 days 2 leads on 200.
    const ad = adOf(computeFatigue(leadRows('s1', 'short-run', 20, () => 200, (i) => (i < 10 ? 10 : 2))), 's1');
    expect(ad.kpi_recent).toBeCloseTo(0.01, 5); // 2 leads / 200 spend
    expect(ad.cpl_last_14).toBeCloseTo(100, 5);
    // A flat 14-day window would have reached 4 days back into the first half
    // and read 0.0214 — the trend confirmed against itself.
    expect(ad.kpi_recent).not.toBeCloseTo(0.0214, 3);
  });

  it('14 stays the cap on a longer run (no behavior change)', () => {
    // 26 days at 10 leads, then 14 days at 2. A half-of-run window (20 days)
    // would blend the two; the 14-day cap must hold.
    const ad = adOf(computeFatigue(leadRows('l1', 'long-run', 40, () => 200, (i) => (i < 26 ? 10 : 2))), 'l1');
    expect(ad.kpi_recent).toBeCloseTo(0.01, 5);
    expect(ad.cpl_last_14).toBeCloseTo(100, 5);
  });

  it('the daily run-rate follows the same window', () => {
    const ad = adOf(computeFatigue(leadRows('s1', 'short-run', 20, (i) => (i < 10 ? 100 : 400), () => 5)), 's1');
    expect(ad.recent_daily_spend).toBe(400);
  });
});

describe('the CPM x CTR chapter reacts to its own chart (T3)', () => {
  const accRow = (i: number, cpm: number, ctr: number): PackAccountRow => ({
    date: day(i), spend: (cpm * 100_000) / 1000, impressions: 100_000,
    link_clicks: Math.round(100_000 * (ctr / 100)), purchases: 0, purchase_value: 0, results: 0, leads: 16,
  });

  /** The live lead-gen case: CTR collapsing while CPM barely moves. */
  const ctrCollapse = Array.from({ length: 84 }, (_, i) => accRow(i, 9 + (0.2 * i) / 83, 2.2 - (1.35 * i) / 83));

  it('CTR down 25%+ with CPM flat or up is a finding, not "flat, no action needed"', () => {
    const s = computeCostTrend(ctrCollapse, 'USD');
    const d = s.data as { verdict: string; signal: boolean; ctr_delta_pct: number; cpm_delta_pct: number };
    expect(d.verdict).toBe('ctr_down_cpm_held');
    expect(d.signal).toBe(true);
    expect(s.summary).not.toContain('flat (within');
    expect(s.next_step).toContain('Rebuild the creative');
    expect(s.next_step).not.toMatch(/No action needed/);
  });

  it('the summary cites BOTH deltas and the CTR the account held at the start', () => {
    const s = computeCostTrend(ctrCollapse, 'USD');
    const d = s.data as { ctr_delta_pct: number; cpm_delta_pct: number; ctr_first: number; ctr_last: number; weeks: number };
    expect(s.summary).toContain(`${Math.abs(d.ctr_delta_pct)}%`);
    expect(s.summary).toContain(`${d.cpm_delta_pct}%`);
    expect(s.summary).toContain(`${d.ctr_last}%`);
    expect(s.summary).toContain(`${d.ctr_first}%`);
    expect(d.ctr_first).toBeGreaterThan(d.ctr_last);
  });

  it('ONE computation owns the figures: the data carries every one the prose uses', () => {
    const s = computeCostTrend(ctrCollapse, 'USD');
    const d = s.data as Record<string, unknown>;
    for (const k of ['cpm_delta_pct', 'ctr_delta_pct', 'cpm_first', 'cpm_last', 'ctr_first', 'ctr_last', 'weeks', 'verdict']) {
      expect(d[k], k).toBeDefined();
    }
    // The week count in the prose IS the bucket count — the page titled "12
    // weeks" over 14 buckets.
    expect(d.weeks).toBe((d.series as unknown[]).length);
    expect(s.summary).toContain(`Over the last ${d.weeks} weeks`);
  });

  it('rising CPM with a collapsing CTR still reads as the creative earning worse auctions', () => {
    const rows = Array.from({ length: 84 }, (_, i) => accRow(i, 9 + (2.5 * i) / 83, 2.2 - (1.35 * i) / 83));
    const s = computeCostTrend(rows, 'USD');
    const d = s.data as { verdict: string; ctr_first: number; ctr_last: number };
    expect(d.verdict).toBe('cpm_up_ctr_down');
    expect(s.summary).toContain(`${d.ctr_last}%`);
    expect(s.summary).toContain(`${d.ctr_first}%`);
    expect(s.next_step).toContain('creative problem');
  });

  it('a CTR slide too small to call still says what it is, and never claims flat', () => {
    const rows = Array.from({ length: 84 }, (_, i) => accRow(i, 9, 1.5 - (0.25 * i) / 83));
    const s = computeCostTrend(rows, 'USD');
    const d = s.data as { verdict: string; signal: boolean };
    expect(d.verdict).toBe('ctr_down_cpm_soft');
    expect(d.signal).toBe(true);
    expect(s.next_step).toContain('new hooks');
  });

  it('genuinely flat is still flat, quiet, and carries no next step', () => {
    const rows = Array.from({ length: 84 }, (_, i) => accRow(i, 9, 1.2));
    const s = computeCostTrend(rows, 'EUR');
    const d = s.data as { verdict: string; signal: boolean };
    expect(d.verdict).toBe('flat');
    expect(d.signal).toBe(false);
    expect(s.summary).toContain('flat');
    expect(s.next_step).toBeUndefined();
  });

  it('with no link click in the window the CTR half is withheld, not read as "CTR held"', () => {
    const rows = Array.from({ length: 84 }, (_, i) => ({ ...accRow(i, 9, 0), link_clicks: 0 }));
    const s = computeCostTrend(rows, 'USD');
    const d = s.data as { ctr_readable: boolean; ctr_delta_pct: number; verdict: string };
    expect(d.ctr_readable).toBe(false);
    expect(s.summary).toContain('No link click is recorded');
    expect(d.verdict).toBe('flat');
  });

  it('the thin window is suppressed AND quiet (a quiet row carries no action)', () => {
    const s = computeCostTrend(Array.from({ length: 10 }, (_, i) => accRow(i, 9, 1.2)));
    expect((s.data as { signal: boolean }).signal).toBe(false);
    expect(s.next_step).toBeUndefined();
    expect(s.warnings?.[0]).toContain('suppressed');
    expect((s.data as { weeks: number }).weeks).toBeGreaterThan(0);
  });
});

describe('a short ad-level read cannot grade creative age (T4)', () => {
  const shortRows = [
    ...Array.from({ length: 65 }, (_, i) => ({ ad_id: 'a1', date: day(i), spend: 100 })),
    ...Array.from({ length: 40 }, (_, i) => ({ ad_id: 'a2', date: day(25 + i), spend: 120 })),
  ];

  it('says how many days it covers, stays quiet and carries no next step', () => {
    const s = computeCohorts(shortRows);
    const d = s.data as { window_too_short: boolean; days_covered: number; signal: boolean };
    expect(d.window_too_short).toBe(true);
    expect(d.days_covered).toBe(65);
    expect(d.signal).toBe(false);
    expect(s.summary).toContain('covers 65 days');
    expect(s.summary).toContain('too short to judge');
    expect(s.next_step).toBeUndefined();
  });

  it('still hands the cohort split downstream, ungraded', () => {
    const d = computeCohorts(shortRows).data as { series: unknown[]; fresh_cohort_share_pct: number };
    expect(d.series.length).toBeGreaterThan(0);
    expect(typeof d.fresh_cohort_share_pct).toBe('number');
  });

  it('a full window is graded exactly as before', () => {
    // 180 days: one old ad spending throughout, one launched last month.
    const rows = [
      ...Array.from({ length: 180 }, (_, i) => ({ ad_id: 'old', date: day(i), spend: 100 })),
      ...Array.from({ length: 20 }, (_, i) => ({ ad_id: 'new', date: day(160 + i), spend: 20 })),
    ];
    const s = computeCohorts(rows);
    const d = s.data as { window_too_short: boolean; days_covered: number; signal: boolean };
    expect(d.window_too_short).toBe(false);
    expect(d.days_covered).toBe(180);
    expect(d.signal).toBe(true);
    expect(s.next_step).toBeTruthy();
  });
});

describe('method notes only describe figures that are there (T5)', () => {
  it('the fatigue derivation drops the runway sentence when no runway exists', () => {
    const lead = computeFatigue(ANCHOR_DECAYER, 1.0, 'USD');
    expect(lead.data.ads.every((a) => a.days_to_breakeven === null)).toBe(true);
    expect(lead.derivation).not.toContain('runway extrapolates');
    expect(lead.next_step).not.toContain('runway number');
  });

  it('and keeps it when a runway is actually computed', () => {
    const ecom = computeFatigue(ecomRows('f1', 'decayer', 60, 300, (i) => 3.0 - (1.8 * i) / 59), 1.0, 'GBP');
    expect(ecom.data.ads.some((a) => a.days_to_breakeven !== null)).toBe(true);
    expect(ecom.derivation).toContain('runway extrapolates');
  });

  it('the cost-trend derivation only prices impressions when CPM actually rose', () => {
    const accRow = (i: number, cpm: number, ctr: number): PackAccountRow => ({
      date: day(i), spend: (cpm * 100_000) / 1000, impressions: 100_000,
      link_clicks: Math.round(100_000 * (ctr / 100)), purchases: 10, purchase_value: 500, results: 10,
    });
    const flat = computeCostTrend(Array.from({ length: 84 }, (_, i) => accRow(i, 9, 1.2)), 'EUR');
    expect(flat.derivation).not.toContain('opening prices');
    expect(flat.derivation).toContain('No cost figure is quoted');
    const rising = computeCostTrend(Array.from({ length: 84 }, (_, i) => accRow(i, 8 + (6 * i) / 83, 1.5)), 'EUR');
    expect(rising.derivation).toContain('opening prices');
    expect((rising.data as { cpm_extra_cost_recent?: number }).cpm_extra_cost_recent).toBeGreaterThan(0);
  });
});

describe('the day-of-week caveat is stated once, in the account\'s own grammar (T6, T8)', () => {
  const accRows = (leadsFor: (dow: number) => number): PackAccountRow[] =>
    Array.from({ length: 91 }, (_, i) => {
      const dow = new Date(day(i) + 'T00:00:00Z').getUTCDay();
      return {
        date: day(i), spend: 100, impressions: 40_000, link_clicks: 400,
        purchases: 0, purchase_value: 0, results: 0, leads: leadsFor(dow),
      };
    });

  it('the caveat appears in the summary and NOT again in the derivation', () => {
    const s = computeDayOfWeek(accRows((dow) => (dow === 2 ? 2 : 5)));
    expect(s.summary).toContain('day-of-week, not dayparting');
    expect(s.derivation).not.toContain('day-of-week, not dayparting');
  });

  it('no sentence is repeated verbatim between the summary and the derivation', () => {
    const s = computeDayOfWeek(accRows((dow) => (dow === 2 ? 2 : 5)));
    const sentences = (s.summary ?? '').split('. ').map((x) => x.trim()).filter((x) => x.length > 25);
    for (const sentence of sentences) expect(s.derivation ?? '').not.toContain(sentence);
  });

  it('a lead-gen account is told about its own result kind, with no purchase alternative offered', () => {
    const s = computeDayOfWeek(accRows(() => 5));
    expect((s.data as { kpi_mode: string }).kpi_mode).toBe('cpr');
    expect(s.derivation).toContain('lead actions');
    expect(s.derivation).not.toMatch(/purchases/);
  });

  it('an e-commerce account is told about purchases', () => {
    const rows: PackAccountRow[] = Array.from({ length: 91 }, (_, i) => {
      const dow = new Date(day(i) + 'T00:00:00Z').getUTCDay();
      return {
        date: day(i), spend: 100, impressions: 50_000, link_clicks: 600,
        purchases: 4, purchase_value: 100 * (dow === 0 ? 3.2 : 1.8), results: 4,
      };
    });
    const s = computeDayOfWeek(rows);
    expect((s.data as { kpi_mode: string }).kpi_mode).toBe('roas');
    expect(s.derivation).toContain('purchases');
    expect(s.derivation).not.toContain('lead actions');
  });
});

describe('two ads can share a name, and the page must be able to tell them apart (T7)', () => {
  const rows = (adId: string, name: string, spendPerDay: number): PackAdRow[] =>
    leadRows(adId, name, 30, () => spendPerDay, () => 5);

  it('flags every top_ads row whose name is shared with another ad in the list', () => {
    const s = computeConcentration([
      ...rows('a1', 'SB-Image-Life cover calculator', 300),
      ...rows('a2', 'SB-Image-Life cover calculator', 200),
      ...rows('a3', 'SB-Video-Testimonial', 100),
    ]);
    const top = s.data.top_ads as Array<{ ad_id: string; ad_name: string; name_shared_with_other_ad?: boolean }>;
    expect(top.find((a) => a.ad_id === 'a1')!.name_shared_with_other_ad).toBe(true);
    expect(top.find((a) => a.ad_id === 'a2')!.name_shared_with_other_ad).toBe(true);
    // Omitted, not false, on a unique name — and no ad is ever renamed.
    expect('name_shared_with_other_ad' in top.find((a) => a.ad_id === 'a3')!).toBe(false);
    expect(top.find((a) => a.ad_id === 'a1')!.ad_name).toBe('SB-Image-Life cover calculator');
  });

  it('a list of unique names carries the flag nowhere', () => {
    const s = computeConcentration([...rows('a1', 'one', 300), ...rows('a2', 'two', 200)]);
    const top = s.data.top_ads as Array<Record<string, unknown>>;
    for (const a of top) expect('name_shared_with_other_ad' in a).toBe(false);
  });
});

describe('no new em-dash reaches the customer (house rule)', () => {
  it('the strings this wave writes carry none', () => {
    const s = computeFatigue(ANCHOR_DECAYER, 1.0, 'USD');
    const drag = s.data.dragging as DraggingAd[];
    for (const d of drag) {
      expect(d.stat).not.toMatch(/—/);
      expect(d.why).not.toMatch(/—/);
    }
    expect(String(s.data.dragging_note ?? '')).not.toMatch(/—/);
    const short = computeCohorts(Array.from({ length: 65 }, (_, i) => ({ ad_id: 'a1', date: day(i), spend: 100 })));
    expect(short.summary).not.toMatch(/—/);
    const trend = computeCostTrend(
      Array.from({ length: 84 }, (_, i) => ({
        date: day(i), spend: 900, impressions: 100_000,
        link_clicks: Math.round(100_000 * ((2.2 - (1.35 * i) / 83) / 100)),
        purchases: 0, purchase_value: 0, results: 0, leads: 16,
      })),
      'USD',
    );
    expect(String(trend.next_step)).not.toMatch(/—/);
  });
});
