import { describe, it, expect } from 'vitest';
import {
  computeFatigue, computeBudgetScatter, computeCostTrend, computeDayOfWeek,
  type PackAdRow, type PackAccountRow, type FatigueAd, type DraggingAd, type ScatterDot,
} from '../src/audit/report-pack.js';

/**
 * The SECOND customer-simulation round, read off a live lead-gen report. Every
 * case here is a thing the page printed that its own data disproved: a 30-day
 * spend of 0 sitting under a 141/day run rate, per-ad daily figures that summed
 * past the account's calendar rate, a `fresh` verdict on an ad whose cost per
 * lead went 16.68 to 23.65 in 17 days, a share with no denominator, a list
 * ranked on one figure and labelled with another, "the red dots" on a chart with
 * no red dot, and a budget shift advised across a 2.5% weekday spread.
 *
 * Anchor account: 482 leads, 18.59 cost per lead, ZERO purchases, `results` 0.
 */

const day = (i: number): string => new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10);

/** One lead-gen ad: no purchases, no purchase value, results unmapped, leads priced by cost per lead. */
function leadAd(
  adId: string,
  name: string,
  startDay: number,
  days: number,
  spendPerDay: number,
  cplByDay: (i: number) => number,
  freq = 1.8,
): PackAdRow[] {
  return Array.from({ length: days }, (_, i) => ({
    ad_id: adId, ad_name: name, date: day(startDay + i), spend: spendPerDay,
    impressions: 8_000, purchases: 0, purchase_value: 0, results: 0,
    frequency: freq, hook_rate: null, hold_rate: null, leads: spendPerDay / cplByDay(i),
  }));
}

function ecomAd(adId: string, name: string, startDay: number, days: number, spendPerDay: number, roasByDay: (i: number) => number, freq = 2.0): PackAdRow[] {
  return Array.from({ length: days }, (_, i) => ({
    ad_id: adId, ad_name: name, date: day(startDay + i), spend: spendPerDay,
    impressions: 10_000, purchases: 5, purchase_value: spendPerDay * roasByDay(i),
    results: 5, frequency: freq, hook_rate: 25, hold_rate: 10,
  }));
}

const adsOf = (s: { data: { ads: FatigueAd[] } }): Map<string, FatigueAd> =>
  new Map(s.data.ads.map((a) => [a.ad_id, a]));

/** The live report's own rows: one confirmed decliner, two 17-day decliners, one stopped ad. */
const LIVE_ROWS: PackAdRow[] = [
  // Stopped 31 days before the window ends: 6,280 over 90 days, nothing in the last 30.
  ...leadAd('thread', 'Thread', 0, 59, 6_280 / 59, (i) => (i < 30 ? 14 : 20)),
  // 17 days live, cost per lead 16.68 then 23.65 — the report called this "fresh".
  ...leadAd('ash', 'ASH', 72, 17, 200, (i) => (i < 8 ? 16.68 : 23.65)),
  // 17 days live, 14.14 then 23.81 — also "fresh".
  ...leadAd('sbp', 'SB-parents', 72, 17, 250, (i) => (i < 8 ? 14.14 : 23.81)),
  // 50 days, trend −25.6% — the report called this "stable".
  ...leadAd('02', '02', 40, 50, 180, (i) => (i < 25 ? 16 : 21.5)),
  // The one genuinely confirmed decliner, still spending.
  ...leadAd('big', 'SB-Image', 30, 60, 300, (i) => (i < 30 ? 12 : 26)),
  // A holder: the cost per lead does not move.
  ...leadAd('hold', 'Holder', 55, 35, 150, () => 18.5),
];

describe('a stopped ad says when it stopped, and drags nothing (T1)', () => {
  const s = computeFatigue(LIVE_ROWS, 1.0, 'USD');

  it('carries the last spending day, the days since, and the still-spending flag', () => {
    const thread = adsOf(s).get('thread')!;
    expect(thread.spend_30d).toBe(0);
    expect(thread.last_spend_date).toBe(day(58));
    expect(thread.days_since_last_spend).toBe(31);
    expect(thread.still_spending).toBe(false);
    // The 90-day figure is untouched: the ad did spend that money.
    expect(thread.spend).toBe(6_280);
  });

  it('an ad still running is flagged as such', () => {
    const big = adsOf(s).get('big')!;
    expect(big.still_spending).toBe(true);
    expect(big.days_since_last_spend).toBe(0);
    expect(big.spend_30d).toBe(9_000);
  });

  it('no ad with a zero 30-day spend can reach the dragging list', () => {
    // A confirmed decliner that stopped 31 days ago: fatiguing, and not dragging.
    const stopped = computeFatigue(
      [...leadAd('gone', 'gone-decliner', 0, 59, 400, (i) => (i < 30 ? 10 : 30)), ...leadAd('live', 'still-here', 60, 30, 100, () => 18)],
      1.0,
      'USD',
    );
    expect(adsOf(stopped).get('gone')!.class).toBe('fatiguing');
    expect(adsOf(stopped).get('gone')!.spend_30d).toBe(0);
    expect((stopped.data.dragging as DraggingAd[]).map((d) => d.ad_id)).not.toContain('gone');
    expect(String(stopped.data.dragging_note)).toContain('no spend in the last 30 days');
  });

  it('when a named row has no 30-day spend the prose gives the date, never the zero', () => {
    // The stopped decliner is the biggest unconfirmed row, so it is the one the
    // summary names. A second, smaller ad carries the window to its real end.
    const only = computeFatigue(
      [
        ...leadAd('gone', 'gone-decliner', 0, 59, 400, (i) => (i < 30 ? 10 : 13.4)),
        ...leadAd('small', 'small-holder', 60, 30, 20, () => 18),
      ],
      1.0,
      'USD',
    );
    expect(adsOf(only).get('gone')!.class).toBe('declining_unconfirmed');
    expect(adsOf(only).get('gone')!.spend_30d).toBe(0);
    expect(only.summary).toContain(`the biggest of those is "gone-decliner"`);
    expect(only.summary).toContain(`it last spent on ${day(58)}`);
    expect(only.summary).not.toMatch(/0 USD in the last 30 days/);
  });
});

describe('the daily figures name their own basis (T1)', () => {
  it('the section states the basis in the data and once in plain words', () => {
    const s = computeFatigue(LIVE_ROWS, 1.0, 'USD');
    expect(s.data.daily_basis).toBe('active_days');
    expect(s.summary).toContain("that ad's own average while it was running");
    expect(s.derivation).toContain("do not add up to the account's daily spend");
  });

  it('the burn counts only the fatiguing ads that are still spending', () => {
    // Two confirmed decliners: one stopped 31 days ago, one still running at 300/day.
    const s = computeFatigue(
      [
        ...leadAd('gone', 'gone-decliner', 0, 59, 400, (i) => (i < 30 ? 10 : 30)),
        ...leadAd('big', 'SB-Image', 30, 60, 300, (i) => (i < 30 ? 12 : 26)),
      ],
      1.0,
      'USD',
    );
    expect(adsOf(s).get('gone')!.class).toBe('fatiguing');
    expect(adsOf(s).get('big')!.class).toBe('fatiguing');
    expect(s.data.fatiguing_daily_burn).toBe(300); // not 700: the stopped ad runs nothing now
  });
});

describe('the class words claim only what the rule proved (T1)', () => {
  const cls = adsOf(computeFatigue(LIVE_ROWS, 1.0, 'USD'));

  it('a 17-day ad whose cost per lead went 16.68 to 23.65 is not "fresh"', () => {
    expect(cls.get('ash')!.class).toBe('declining_unconfirmed');
    expect(cls.get('ash')!.cpl_first_half).toBeCloseTo(16.68, 2);
    expect(cls.get('ash')!.cpl_last_14).toBeCloseTo(23.65, 2);
    expect(cls.get('sbp')!.class).toBe('declining_unconfirmed');
  });

  it('a 25%+ decline the fatiguing test refused is not "stable" either', () => {
    expect(cls.get('02')!.trend_pct).toBeLessThanOrEqual(-25);
    expect(cls.get('02')!.class).toBe('declining_unconfirmed');
  });

  it('stable is earned on the confirmation window, not assumed', () => {
    expect(cls.get('hold')!.class).toBe('stable');
    expect(cls.get('hold')!.cpl_first_half).toBeCloseTo(18.5, 2);
    expect(cls.get('hold')!.cpl_last_14).toBeCloseTo(18.5, 2);
  });

  it('a young ad that is NOT declining is too_young_to_call, and says how thin the read is', () => {
    const s = computeFatigue(leadAd('new', 'just-launched', 75, 14, 200, () => 18), 1.0, 'USD');
    const ad = adsOf(s).get('new')!;
    expect(ad.class).toBe('too_young_to_call');
    expect(ad.in_window_age_days).toBe(14);
    expect(ad.confirmation_days).toBe(7);
  });

  it('the confirmed and the evergreen rules are untouched', () => {
    expect(cls.get('big')!.class).toBe('fatiguing');
    const ever = computeFatigue(leadAd('e1', 'evergreen', 0, 70, 200, () => 18.5), 1.0, 'USD');
    expect(adsOf(ever).get('e1')!.class).toBe('evergreen');
    // e-commerce: a decline into its own breakeven line still reads as fatiguing.
    const ecom = computeFatigue(ecomAd('f1', 'decayer', 0, 60, 300, (i) => 3.0 - (1.8 * i) / 59), 1.0, 'GBP');
    expect(adsOf(ecom).get('f1')!.class).toBe('fatiguing');
  });
});

describe('the summary states the split, and the share names its denominator (T1)', () => {
  const s = computeFatigue(LIVE_ROWS, 1.0, 'USD');

  it('counts the confirmed against the unconfirmed and names the biggest of them', () => {
    expect(s.data.fatiguing_count).toBe(1);
    expect(s.data.declining_unconfirmed_count).toBe(4);
    expect(s.summary).toContain('1 confirmed fatiguing');
    expect(s.summary).toContain('4 more are declining but too young or too thin to confirm');
    expect(s.summary).toContain('the biggest of those is "02"');
    // The two levels, in this account's own money grammar.
    expect(s.summary).toContain('16.00 USD then 21.50 USD');
    expect(s.summary).not.toMatch(/ROAS/);
  });

  it('the share says what it is a share OF, and the denominator is on the wire', () => {
    expect(s.summary).toContain('of the last 90 days\' spend behind the 6 ads we could read');
    expect(s.data.assessed_ads).toBe(6);
    expect(s.data.assessed_spend).toBe(46_180);
    expect(s.summary).not.toContain('of assessed spend');
  });

  it('the evergreen share names the same denominator', () => {
    const withEvergreen = computeFatigue([...LIVE_ROWS, ...leadAd('e1', 'evergreen', 0, 70, 200, () => 18.5)], 1.0, 'USD');
    expect(withEvergreen.summary).toContain('evergreen winner');
    expect(withEvergreen.summary).not.toContain('of assessed spend');
    expect(withEvergreen.summary).toContain('ads we could read');
  });

  it('an e-commerce account gets the same split in the ROAS grammar', () => {
    // 4.5 falling to 2.5 over 60 days: 25%+ down, but nowhere near a 1.0x floor.
    const ecom = computeFatigue(ecomAd('r1', 'rebase-me', 30, 60, 300, (i) => 4.5 - (2.0 * i) / 59), 1.0, 'GBP');
    expect(adsOf(ecom).get('r1')!.class).toBe('declining_unconfirmed');
    expect(ecom.summary).toContain('the biggest of those is "rebase-me" at 4.01× then 2.72×');
    expect(ecom.summary).not.toMatch(/lead/);
  });

  it('a section with only unconfirmed decliners is a finding, and says not to cut on it', () => {
    const only = computeFatigue(leadAd('d1', 'unconfirmed-decliner', 72, 17, 250, (i) => (i < 8 ? 14 : 23)), 1.0, 'USD');
    expect(adsOf(only).get('d1')!.class).toBe('declining_unconfirmed');
    expect(only.data.signal).toBe(true);
    expect(only.next_step).toContain('Nothing is confirmed fatiguing yet');
    expect(only.next_step).toContain("don't cut anything");
  });

  it('the next step never points at an evergreen list that does not exist', () => {
    expect(s.data.evergreen_count).toBe(0);
    expect(s.next_step).not.toContain('evergreen');
    const withEvergreen = computeFatigue([...LIVE_ROWS, ...leadAd('e1', 'evergreen', 0, 70, 200, () => 18.5)], 1.0, 'USD');
    expect(withEvergreen.data.evergreen_count).toBe(1);
    expect(withEvergreen.next_step).toContain('evergreen list');
  });
});

describe('the row order matches the label (T1)', () => {
  it('ranks on the 30-day spend the row shows, and says so in the data', () => {
    const s = computeFatigue(LIVE_ROWS, 1.0, 'USD');
    const order = s.data.ads.map((a) => a.spend_30d);
    expect(order).toEqual([...order].sort((x, y) => y - x));
    expect(s.data.sorted_by).toBe('spend_30d');
    expect(s.data.ads_shown).toBe(6);
    // The stopped ad sits last, not first on a 6,280 90-day sum.
    expect(s.data.ads[s.data.ads.length - 1]!.ad_id).toBe('thread');
  });

  it('the 90-day sum only breaks a tie', () => {
    const s = computeFatigue(
      [
        ...leadAd('long', 'long-run', 30, 60, 100, () => 18),
        ...leadAd('short', 'short-run', 60, 30, 100, () => 18),
      ],
      1.0,
      'USD',
    );
    // Same 30-day spend (3,000 each); the longer run wins the tie-break.
    expect(s.data.ads.map((a) => a.spend_30d)).toEqual([3_000, 3_000]);
    expect(s.data.ads[0]!.ad_id).toBe('long');
  });
});

describe('the auction chapter tells one story about its own chart (T3)', () => {
  const accRow = (i: number, cpm: number, ctr: number): PackAccountRow => ({
    date: day(i), spend: (cpm * 100_000) / 1000, impressions: 100_000,
    link_clicks: Math.round(100_000 * (ctr / 100)), purchases: 0, purchase_value: 0, results: 0, leads: 52,
  });
  const rows = Array.from({ length: 98 }, (_, i) => accRow(i, 9 + (2.1 * i) / 97, 1.3 - (0.78 * i) / 97));
  const s = computeCostTrend(rows, 'USD');

  it('carries BOTH bases, each labelled, over the same buckets the series holds', () => {
    const d = s.data as Record<string, unknown>;
    expect(d.delta_basis).toBe('thirds_average');
    expect(d.chart_delta_basis).toBe('last_bucket_vs_first_bucket');
    const series = d.series as Array<{ cpm: number; ctr_link_pct: number }>;
    const chartCpm = ((series[series.length - 1]!.cpm - series[0]!.cpm) / series[0]!.cpm) * 100;
    expect(d.cpm_chart_delta_pct as number).toBeCloseTo(chartCpm, 0);
    // The two bases genuinely disagree, which is why both are on the wire.
    expect(d.cpm_chart_delta_pct).not.toBe(d.cpm_delta_pct);
    expect(d.ctr_chart_delta_pct).not.toBe(d.ctr_delta_pct);
  });

  it('the summary names the basis it quotes, in plain words', () => {
    const d = s.data as { delta_first_weeks: number; delta_last_weeks: number; weeks: number };
    expect(s.summary).toContain(`averaging the first ${d.delta_first_weeks} weeks against the last ${d.delta_last_weeks}`);
    expect(s.summary).toContain(`Over the last ${d.weeks} weeks`);
    expect(s.summary).toContain("The chart's own first and last week");
  });

  it('every CTR level it quotes is named as a weekly average, with the when', () => {
    const d = s.data as { ctr_first: number; ctr_last: number; delta_first_weeks: number; delta_last_weeks: number };
    expect(s.summary).toContain(`${d.ctr_last}% as a weekly average over the last ${d.delta_last_weeks} weeks`);
    expect(s.summary).toContain(`against ${d.ctr_first}% over the first ${d.delta_first_weeks}`);
    expect(s.derivation).toContain('not the 30-day figure quoted elsewhere in the report');
  });

  it('a recoverable CTR is named as a weekly average in the next step too', () => {
    const held = computeCostTrend(Array.from({ length: 98 }, (_, i) => accRow(i, 9, 1.3 - (0.78 * i) / 97)), 'USD');
    expect((held.data as { verdict: string }).verdict).toBe('ctr_down_cpm_held');
    expect(held.next_step).toContain('weekly-average link CTR');
    expect(held.next_step).toContain('recovery target');
  });

  it('a market-pressure read states the CTR that held, rather than asserting it', () => {
    const s2 = computeCostTrend(Array.from({ length: 98 }, (_, i) => accRow(i, 9 + (3 * i) / 97, 1.3)), 'USD');
    expect((s2.data as { verdict: string }).verdict).toBe('cpm_up_ctr_held');
    expect(s2.summary).toContain('as a weekly average');
  });

  it('no week count in the prose is a hardcoded number', () => {
    const d = s.data as { weeks: number };
    const numbers = (s.summary.match(/(\d+) weeks/g) ?? []).map((m) => Number(m.replace(' weeks', '')));
    for (const n of numbers) expect([d.weeks, 5]).toContain(n); // 5 = the real third-of-window bucket count
  });
});

describe('the scatter only claims dots it actually drew (T4)', () => {
  const flagged = [{ ad_id: 'tiny', class: 'fatiguing' as const, low_frequency_acquisition_guard: false }];
  const rows30: PackAdRow[] = [
    ...leadAd('a1', 'big-spender', 60, 30, 400, () => 18),
    ...leadAd('a2', 'second', 60, 30, 300, () => 26),
    ...leadAd('tiny', 'tiny-flagged', 60, 30, 2, () => 40),
  ];

  it('says the flagged ad spends too little to plot, instead of pointing at a red dot', () => {
    const s = computeBudgetScatter(rows30, flagged, 1.0, 'USD', null, { resultNoun: 'lead' });
    const dots = s.data.dots as ScatterDot[];
    expect(dots.find((d) => d.ad_id === 'tiny')).toBeUndefined();
    expect(s.data.move_count).toBe(0);
    expect(s.data.flagged_off_chart).toBe(1);
    expect(s.data.flagged_off_chart_reasons).toEqual(['below_plot_floor']);
    expect(s.summary).toContain('The one ad flagged past peak in the fatigue chapter spends too little');
    expect(s.derivation).not.toContain('red = past-peak');
  });

  it('and keeps the red-dot line when a red dot is really there', () => {
    const plottedFlag = [{ ad_id: 'a2', class: 'fatiguing' as const, low_frequency_acquisition_guard: false }];
    const s = computeBudgetScatter(rows30, plottedFlag, 1.0, 'USD', null, { resultNoun: 'lead' });
    expect(s.data.move_count).toBe(1);
    expect(s.data.flagged_off_chart).toBeUndefined();
    expect(s.summary).toContain('1 ad sits in the danger zone');
    expect(s.derivation).toContain('red = past-peak');
  });

  it('an ad with no mapped result is told apart from an ad that is simply small', () => {
    const noResult: PackAdRow[] = [
      ...leadAd('a1', 'big-spender', 60, 30, 400, () => 18),
      ...Array.from({ length: 30 }, (_, i) => ({
        ad_id: 'dry', ad_name: 'dry-flagged', date: day(60 + i), spend: 300,
        impressions: 8_000, purchases: 0, purchase_value: 0, results: 0,
        frequency: 1.8, hook_rate: null, hold_rate: null, leads: 0,
      })),
    ];
    const s = computeBudgetScatter(noResult, [{ ad_id: 'dry', class: 'fatiguing', low_frequency_acquisition_guard: false }], 1.0, 'USD', null, { resultNoun: 'lead' });
    expect(s.data.flagged_off_chart_reasons).toEqual(['no_mapped_result']);
    expect(s.summary).toContain('carries no mapped result in the last 30 days');
  });

  it('names the set every "worst cost per lead" is measured inside', () => {
    const s = computeBudgetScatter(rows30, [], 1.0, 'USD', null, { resultNoun: 'lead' });
    expect(s.data.plotted_set_label).toBe('the 2 biggest spenders of the last 30 days');
    expect(s.summary).toContain('Across the 2 biggest spenders of the last 30 days');
    expect(String(s.next_step)).toContain('Among those 2 biggest spenders');
  });
});

describe('weekday advice clears the same guard as the weekday read (T4)', () => {
  const accRows = (leadsFor: (dow: number) => number): PackAccountRow[] =>
    Array.from({ length: 98 }, (_, i) => {
      const dow = new Date(day(i) + 'T00:00:00Z').getUTCDay();
      return {
        date: day(i), spend: 100, impressions: 40_000, link_clicks: 400,
        purchases: 0, purchase_value: 0, results: 0, leads: leadsFor(dow),
      };
    });

  it('a 2.5% spread keeps the table and withholds the shift pair', () => {
    // Saturday 17.44 against Tuesday 17.31 in the live report: a 0.75% spread.
    const s = computeDayOfWeek(accRows((dow) => (dow === 6 ? 5.73 : 5.78)));
    const d = s.data as Record<string, unknown>;
    expect(d.shift_advice).toBe(false);
    expect(d.shift_from_day).toBeUndefined();
    expect(d.shift_to_day).toBeUndefined();
    expect(String(d.shift_withheld_reason)).toContain('under the 25% we need');
    // The figures and the table are untouched.
    expect((d.rows as unknown[]).length).toBe(7);
    expect(d.best_day).toBeTruthy();
    expect(d.worst_day).toBeTruthy();
    expect(d.signal).toBe(false);
    expect(s.next_step).toContain("don't build schedule complexity");
  });

  it('a real gap hands over the pair to move budget with', () => {
    const s = computeDayOfWeek(accRows((dow) => (dow === 2 ? 2 : 5)));
    const d = s.data as Record<string, unknown>;
    expect(d.shift_advice).toBe(true);
    expect(d.shift_from_day).toBe('Tuesday');
    expect(d.shift_to_day).toBe(d.best_day);
    expect(d.shift_withheld_reason).toBeUndefined();
    expect(s.next_step).toContain('Worth acting on');
  });
});

describe('no new em-dash reaches the customer (house rule)', () => {
  it('every string this wave writes carries none', () => {
    const f = computeFatigue(LIVE_ROWS, 1.0, 'USD');
    for (const part of f.summary.split('. ')) {
      // The split sentence and the stopped-ad note are this wave's own prose.
      if (/confirmed fatiguing|last spent on|own average while/.test(part)) expect(part).not.toMatch(/—/);
    }
    expect(String(f.next_step)).not.toMatch(/—/);
    const s = computeBudgetScatter(
      [...leadAd('a1', 'big-spender', 60, 30, 400, () => 18), ...leadAd('tiny', 'tiny-flagged', 60, 30, 2, () => 40)],
      [{ ad_id: 'tiny', class: 'fatiguing', low_frequency_acquisition_guard: false }],
      1.0, 'USD', null, { resultNoun: 'lead' },
    );
    const offChart = s.summary.split('. ').find((x) => x.includes('flagged past peak'))!;
    expect(offChart).not.toMatch(/—/);
    const dow = computeDayOfWeek(
      Array.from({ length: 98 }, (_, i) => ({
        date: day(i), spend: 100, impressions: 40_000, link_clicks: 400,
        purchases: 0, purchase_value: 0, results: 0, leads: 5,
      })),
    );
    expect(String((dow.data as { shift_withheld_reason?: string }).shift_withheld_reason)).not.toMatch(/—/);
  });
});
