import { describe, it, expect } from 'vitest';
import {
  BEATABLE_GAP,
  BEST_IS_NOW_OVERLAP_DAYS,
  MIN_SPEND_DAYS,
  MIN_WINDOW_RESULTS,
  MIN_WINDOW_SPEND,
  SEASON_GAP_DAYS,
  buildSeries,
  carriedBy,
  computeOwnBestMonth,
  findBestWindow,
  type OwnBestAdRow,
  type OwnBestDayRow,
  type OwnBestMonthRead,
} from '../src/audit/own-best-month.js';
import { buildComparisonSection, type ScorecardEntry } from '../src/audit/scorecard.js';
import { SECTION_ORDER, workLineFor } from '../src/audit/magic-audit.js';
import { dedash } from '../src/audit/prose.js';

/**
 * The account against its own best month.
 *
 * Every number asserted here is hand-computable from the grid above it, which
 * is the whole point of the engine being arithmetic: a benchmark built from the
 * account's own history is only worth more than a peer benchmark if the reader
 * can check it.
 */

const day = (offset: number): string => new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10);

const run = (count: number, per: { spend: number; results: number }, startAt = 0): OwnBestDayRow[] =>
  Array.from({ length: count }, (_, i) => ({ date: day(startAt + i), spend: per.spend, results: per.results }));

/** 100 a day at 10 results is a cost of 10; at 5 results it is 20. */
const CHEAP = { spend: 100, results: 10 };
const NORMAL = { spend: 100, results: 5 };

const read = (days: OwnBestDayRow[], ads: OwnBestAdRow[] = []): OwnBestMonthRead =>
  computeOwnBestMonth({ days, ads, currency: 'USD', resultNoun: 'lead' });

const best = (r: OwnBestMonthRead) => r.data.best_window as { start: string; end: string; spend: number; results: number; cost_per_result: number };
const current = (r: OwnBestMonthRead) => r.data.current_window as { start: string; end: string; spend: number; results: number; cost_per_result: number };

// ---------------------------------------------------------------------------
// The search: which 30 days may be called the best, and which may not
// ---------------------------------------------------------------------------

describe('finding the best 30 days', () => {
  it('picks the cheapest stretch on a hand-computed grid', () => {
    // 30 days at 10 per lead, then 60 at 20. Nothing overlapping the cheap
    // stretch can beat it: one day of 20 pulls the window to 10.17.
    const series = buildSeries([...run(30, CHEAP), ...run(60, NORMAL, 30)]);
    const w = findBestWindow(series, 500)!;
    expect(w.startDate).toBe(day(0));
    expect(w.endDate).toBe(day(29));
    expect(w.spend).toBe(3000);
    expect(w.results).toBe(300);
    expect(w.costPerResult).toBeCloseTo(10, 6);
  });

  it('keeps the EARLIER stretch on a tie, so the same rows always name the same month', () => {
    const series = buildSeries(run(90, NORMAL));
    expect(findBestWindow(series, 500)!.startDate).toBe(day(0));
  });

  it('REJECTS a lucky cheap stretch that never carried real money', () => {
    // 30 days of 400 total spend buying 25 leads (16 each) while the account
    // was tiny, a 30-day gap, then 60 days of real spend at 20 each. Without
    // the spend floor the tiny stretch is an unbeatable fake record.
    const lucky: OwnBestDayRow[] = Array.from({ length: 30 }, (_, i) => ({
      date: day(i),
      spend: 400 / 30,
      results: 25 / 30,
    }));
    const series = buildSeries([...lucky, ...run(60, NORMAL, 60)]);
    const withFloor = findBestWindow(series, MIN_WINDOW_SPEND)!;
    expect(withFloor.costPerResult).toBeCloseTo(20, 6);
    expect(withFloor.startDate > day(29)).toBe(true);
    // Drop the floor and the same rows hand back the fake record.
    expect(findBestWindow(series, 100)!.startDate).toBe(day(0));
    expect(findBestWindow(series, 100)!.costPerResult).toBeCloseTo(16, 6);
  });

  it('REJECTS a stretch whose cost per lead rests on a handful of leads', () => {
    // 15 leads for 150 is 10 each and cheaper than everything after it, and it
    // is still noise: 15 is under the result floor whatever the spend floor is.
    const thin: OwnBestDayRow[] = Array.from({ length: 30 }, (_, i) => ({ date: day(i), spend: 5, results: 0.5 }));
    const series = buildSeries([...thin, ...run(60, NORMAL, 60)]);
    expect(MIN_WINDOW_RESULTS).toBe(20);
    const w = findBestWindow(series, 0)!;
    expect(w.costPerResult).toBeCloseTo(20, 6);
    expect(w.startDate > day(29)).toBe(true);
  });

  it('fills a day the pull never carried with no spend and no result, so a stretch is 30 calendar days', () => {
    const series = buildSeries([{ date: day(0), spend: 100, results: 5 }, { date: day(9), spend: 100, results: 5 }]);
    expect(series.length).toBe(10);
    expect(series[4]).toEqual({ date: day(4), spend: 0, results: 0 });
  });

  it('drops days after the anchor, so the window never reads a day the report does not cover', () => {
    const series = buildSeries(run(90, NORMAL), day(59));
    expect(series.length).toBe(60);
    expect(series[series.length - 1]!.date).toBe(day(59));
  });
});

// ---------------------------------------------------------------------------
// The three cases
// ---------------------------------------------------------------------------

describe('beatable: the account has already run a cheaper month than the one it is in', () => {
  // 30 days at 10 a lead, then 60 at 20. Best = day 0-29, current = day 60-89.
  const section = read([...run(30, CHEAP), ...run(60, NORMAL, 30)]);

  it('names the case and declares a signal', () => {
    expect(section.case).toBe('beatable');
    expect(section.signal).toBe(true);
    expect(section.refusal).toBeNull();
    expect(section.warnings).toEqual([]);
  });

  it('states both stretches with their own arithmetic', () => {
    expect(best(section)).toEqual({ start: day(0), end: day(29), spend: 3000, results: 300, cost_per_result: 10 });
    expect(current(section)).toEqual({ start: day(60), end: day(89), spend: 3000, results: 150, cost_per_result: 20 });
    expect(section.data.gap_pct).toBe(100);
    expect(section.data.overlap_days).toBe(0);
    expect(section.summary).toContain('1 Jan to 30 Jan');
    expect(section.summary).toContain('300 leads at 10.00 USD each');
    expect(section.summary).toContain('The 30 days ending 31 Mar are running at 20.00 USD per lead, 100% more.');
  });

  it('frames the gap as leads the same money would have bought', () => {
    // 3,000 at 10.00 each is 300 leads against the 150 actually bought.
    expect(section.data.extra_results_same_money).toBe(150);
    expect(section.summary).toContain('would have bought 150 more leads for the same money');
  });

  it('carries a step, and points it at the account\'s own proven number', () => {
    expect(section.next_step).toBeTruthy();
    expect(section.next_step).toContain('10.00 USD per lead is reachable in this account');
  });

  it('suppresses the money framing when it rounds down to nothing', () => {
    // 98 spent buying 4 leads is 24.50 each against a proven 20.00, a 22.5%
    // gap. 98 at 20.00 buys 4.9 leads, so the difference rounds down to none,
    // and "0 more leads" is not a finding.
    const thinCurrent = read([
      ...run(60, NORMAL),
      ...Array.from({ length: 4 }, (_, i) => ({ date: day(60 + i), spend: 24.5, results: 1 })),
      ...run(26, { spend: 0, results: 0 }, 64),
    ]);
    expect(thinCurrent.case).toBe('beatable');
    expect(thinCurrent.data.gap_pct).toBe(22.5);
    expect(thinCurrent.data.extra_results_same_money).toBeNull();
    expect(thinCurrent.summary).not.toContain('for the same money');
    expect(thinCurrent.summary).not.toContain('0 more');
  });
});

describe('holding: running near its own proven best', () => {
  // 60 days at 20 a lead, then 30 at 22: a 10% gap, under the 20% bar.
  const section = read([...run(60, NORMAL), ...run(30, { spend: 110, results: 5 }, 60)]);

  it('reads quiet, with no step and no signal', () => {
    expect(section.case).toBe('holding');
    expect(section.signal).toBe(false);
    expect(section.next_step).toBeNull();
    expect(section.data.gap_pct).toBe(10);
    expect(section.summary).toContain(`inside ${Math.round(BEATABLE_GAP * 100)}% of its own proven best`);
    expect(section.summary).toContain('20.00 USD per lead');
    expect(section.summary).toContain('22.00 USD');
  });

  it('states the floor it beat when the current stretch is the cheapest thing in the read', () => {
    // 3 leads for 30 is 10.00 each and cheaper than the proven 20.00, and it
    // misses the result floor, so it is never a candidate itself. Saying "your
    // cheapest month" about 3 leads is exactly what the floor exists to stop.
    const cheaperNow = read([
      ...run(60, NORMAL),
      ...run(29, { spend: 0, results: 0 }, 60),
      { date: day(89), spend: 30, results: 3 },
    ]);
    expect(cheaperNow.case).toBe('holding');
    expect(cheaperNow.signal).toBe(false);
    expect(cheaperNow.next_step).toBeNull();
    expect(cheaperNow.data.gap_pct).toBe(-50);
    expect(cheaperNow.summary).toContain('below every earlier 30-day stretch in this read that carries at least 20 leads');
    expect(cheaperNow.summary).toContain('no cheaper month to aim at');
  });
});

describe('best is now: the best 30 days are the ones being lived in', () => {
  const section = read([...run(60, NORMAL), ...run(30, CHEAP, 60)]);

  it('reads positive, quiet, and asks for nothing', () => {
    expect(section.case).toBe('best_is_now');
    expect(section.signal).toBe(false);
    expect(section.next_step).toBeNull();
    expect(section.data.overlap_days).toBe(30);
    expect(section.summary).toContain('Your best 30 days are the ones you are in');
    expect(section.summary).toContain('300 leads at 10.00 USD each');
  });

  it(`takes ${BEST_IS_NOW_OVERLAP_DAYS} shared days, and 14 is a different read`, () => {
    // Cheap stretch day 45-74 shares exactly 15 days with the current 60-89.
    const fifteen = read([...run(45, NORMAL), ...run(30, CHEAP, 45), ...run(15, NORMAL, 75)]);
    expect(fifteen.data.overlap_days).toBe(15);
    expect(fifteen.case).toBe('best_is_now');
    // One day earlier and it shares 14, which is a stretch that has passed.
    const fourteen = read([...run(44, NORMAL), ...run(30, CHEAP, 44), ...run(16, NORMAL, 74)]);
    expect(fourteen.data.overlap_days).toBe(14);
    expect(fourteen.case).toBe('beatable');
  });
});

// ---------------------------------------------------------------------------
// What carried the best stretch
// ---------------------------------------------------------------------------

describe('naming what carried the best stretch', () => {
  const days = [...run(30, CHEAP), ...run(60, NORMAL, 30)];
  const adDays = (ad_id: string, ad_name: string | null, from: number, count: number, spend: number): OwnBestAdRow[] =>
    Array.from({ length: count }, (_, i) => ({ ad_id, ad_name, date: day(from + i), spend }));

  it('names the top two by spend and says which of them stopped', () => {
    const section = read(days, [
      ...adDays('a', 'Hook A UGC', 0, 30, 70),
      ...adDays('b', 'Carousel B', 0, 30, 30),
      ...adDays('b', 'Carousel B', 60, 30, 100),
    ]);
    const carried = section.data.carried_by as Array<{ name: string; share_pct: number; still_spending: boolean }>;
    expect(carried.map((c) => c.name)).toEqual(['Hook A UGC', 'Carousel B']);
    expect(carried[0]!.share_pct).toBe(70);
    expect(carried[0]!.still_spending).toBe(false);
    expect(carried[1]!.still_spending).toBe(true);
    expect(section.summary).toContain('2 ads carried that stretch: "Hook A UGC" and "Carousel B", 100% of its ad spend between them.');
    expect(section.summary).toContain('"Hook A UGC" has spent nothing in the 30 days ending 31 Mar.');
    expect(section.next_step).toContain('"Hook A UGC" and "Carousel B" were carrying it');
  });

  it('reads singular when one ad carried it, and says it has stopped', () => {
    const section = read(days, adDays('a', 'Hook A', 0, 30, 100));
    expect(section.summary).toContain('1 ad carried that stretch: "Hook A", 100% of its ad spend.');
    expect(section.summary).toContain('It has spent nothing in the 30 days ending 31 Mar.');
    expect(section.summary).not.toContain('1 ads');
    expect(section.next_step).toContain('"Hook A" was carrying it');
  });

  it('says neither is spending when both of them stopped', () => {
    const section = read(days, [...adDays('a', 'Hook A', 0, 30, 70), ...adDays('b', 'Carousel B', 0, 30, 30)]);
    expect(section.summary).toContain('Neither of them has spent anything in the 30 days ending 31 Mar.');
  });

  it('says it is still spending when the one ad never stopped', () => {
    const section = read(days, [...adDays('a', 'Hook A', 0, 30, 100), ...adDays('a', 'Hook A', 60, 30, 50)]);
    expect(section.summary).toContain('It is still spending in the 30 days ending 31 Mar, 1,500 USD of it.');
  });

  it('skips the line entirely when the pull gave no ad names', () => {
    const section = read(days, adDays('a', null, 0, 30, 100));
    expect(section.data.carried_by).toEqual([]);
    expect(section.summary).not.toContain('carried that stretch');
    expect(section.next_step).toContain('Start from what the account ran between 1 Jan and 30 Jan');
  });

  it('skips the line when no ad rows were fetched at all', () => {
    const section = read(days);
    expect(section.data.carried_by).toEqual([]);
    expect(section.summary).not.toContain('carried that stretch');
  });

  it('counts each ad in the right stretch and nowhere else', () => {
    const carried = carriedBy(
      [
        { ad_id: 'a', ad_name: 'A', date: day(5), spend: 100 },
        { ad_id: 'a', ad_name: 'A', date: day(65), spend: 40 },
        { ad_id: 'b', ad_name: 'B', date: day(40), spend: 900 },
      ],
      { startDate: day(0), endDate: day(29) },
      { startDate: day(60), endDate: day(89) },
    );
    expect(carried.map((c) => c.ad_id)).toEqual(['a']);
    expect(carried[0]).toMatchObject({ spend_in_best: 100, spend_in_current: 40, still_spending: true, share_pct: 100 });
  });
});

// ---------------------------------------------------------------------------
// Seasonality: a qualifier, never a veto
// ---------------------------------------------------------------------------

describe('a comparison that crosses seasons', () => {
  // A 180-day series: cheap stretch at the start, current stretch 150 days later.
  const section = read([...run(30, CHEAP), ...run(150, NORMAL, 30)]);

  it('qualifies the gap without killing the finding', () => {
    expect(section.data.days_between_window_starts).toBe(150);
    expect(section.data.crosses_seasons).toBe(true);
    expect(section.case).toBe('beatable');
    expect(section.signal).toBe(true);
    expect(section.next_step).toBeTruthy();
    expect(section.summary).toContain('start 150 days apart, so the comparison crosses seasons');
  });

  it('stays silent about seasons when the two stretches sit close together', () => {
    const close = read([...run(30, CHEAP), ...run(60, NORMAL, 30)]);
    expect(close.data.days_between_window_starts).toBe(60);
    expect(SEASON_GAP_DAYS).toBe(120);
    expect(close.data.crosses_seasons).toBe(false);
    expect(close.summary).not.toContain('crosses seasons');
  });
});

// ---------------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------------

describe('the quiet no-report shapes', () => {
  it('refuses a series too short to hold two months', () => {
    const section = read(run(50, NORMAL));
    expect(section.refusal).toBe('series_too_short');
    expect(section.case).toBeNull();
    expect(section.signal).toBe(false);
    expect(section.next_step).toBeNull();
    expect(section.summary).toContain('50 days of account spend');
    expect(section.summary).toContain(`at least ${MIN_SPEND_DAYS} spending days`);
    expect(section.warnings).toHaveLength(1);
    expect(section.warnings[0]).toContain('50 spending days');
  });

  it('refuses when no stretch clears the floors', () => {
    // A lead every fifth day is six per 30 days, under the result floor.
    const section = read(Array.from({ length: 90 }, (_, i) => ({ date: day(i), spend: 100, results: i % 5 === 0 ? 1 : 0 })));
    expect(section.refusal).toBe('no_candidate_window');
    expect(section.signal).toBe(false);
    expect(section.next_step).toBeNull();
    expect(section.summary).toContain('20 leads and 500 USD of spend');
    expect(section.summary).toContain('solid enough to call its best');
    expect(section.warnings[0]).toContain('no best month is named');
  });

  it('refuses when the current stretch recorded no lead at all', () => {
    const section = read([...run(60, NORMAL), ...run(30, { spend: 100, results: 0 }, 60)]);
    expect(section.refusal).toBe('no_current_results');
    expect(section.signal).toBe(false);
    expect(section.summary).toContain('The 30 days ending 31 Mar record no lead');
    expect(section.warnings[0]).toContain('nothing to compare against a best stretch');
  });

  it('every refusal carries a machine reason and no advice', () => {
    const refusals = [
      read(run(50, NORMAL)),
      read(Array.from({ length: 90 }, (_, i) => ({ date: day(i), spend: 100, results: i % 5 === 0 ? 1 : 0 }))),
      read([...run(60, NORMAL), ...run(30, { spend: 100, results: 0 }, 60)]),
    ];
    for (const r of refusals) {
      expect(r.case).toBeNull();
      expect(r.next_step).toBeNull();
      expect(r.signal).toBe(false);
      expect(r.warnings).toHaveLength(1);
      expect(r.summary.length).toBeGreaterThan(40);
      expect(r.derivation.length).toBeGreaterThan(40);
    }
  });
});

// ---------------------------------------------------------------------------
// The derivation states the floors, because they decide the answer
// ---------------------------------------------------------------------------

describe('the derivation', () => {
  const section = read([...run(30, CHEAP), ...run(60, NORMAL, 30)]);

  it('states the window, the step, the floors and the formula', () => {
    expect(section.derivation).toContain('Every 30-day stretch of the 90 days');
    expect(section.derivation).toContain('stepping one day at a time');
    expect(section.derivation).toContain('at least 20 leads');
    expect(section.derivation).toContain('half the current stretch\'s spend and 500 USD');
    expect(section.derivation).toContain('a tie keeps the earlier one');
    expect(section.derivation).toContain('rounds down');
  });
});

// ---------------------------------------------------------------------------
// The chapter: two halves, either one enough
// ---------------------------------------------------------------------------

const hookBand = (band: 'weak' | 'strong'): ScorecardEntry => ({
  key: 'hooks',
  dimension: 'Hooks (3s view rate)',
  value: band === 'weak' ? 16.3 : 26,
  unit: '%',
  band,
  position: '',
  lever: '',
  next_step: '',
  section_key: 'creative_analysis',
  cohort: { label: 'the 17 accounts on our desk (last 7 days)', n: 17, median: 21.7, p25: 16.3, p75: 25.1 },
});

const ownInputs = (days: OwnBestDayRow[], ads: OwnBestAdRow[] = []) => ({
  days,
  ads,
  currency: 'USD',
  resultNoun: 'lead',
  anchorDate: null,
});

describe('how you compare, with both halves', () => {
  const beatableDays = [...run(30, CHEAP), ...run(60, NORMAL, 30)];

  it('runs on the own-history half alone when the desk has no cohort', () => {
    const s = buildComparisonSection([], ownInputs(beatableDays));
    expect(s.data.bands).toEqual([]);
    expect(s.data.cohort_label).toBeNull();
    expect(s.data.signal).toBe(true);
    expect(s.summary).toContain('Your best 30 days in this read ran 1 Jan to 30 Jan');
    expect(s.next_step).toContain('10.00 USD per lead is reachable');
    expect((s.data.own_best as { case: string }).case).toBe('beatable');
  });

  it('runs on the desk half alone when the account has no history to compare', () => {
    const s = buildComparisonSection([hookBand('weak')], ownInputs(run(50, NORMAL)));
    expect((s.data.bands as unknown[]).length).toBe(1);
    expect(s.summary).toContain('50 days of account spend');
    expect(s.summary).toContain('Your hook rate sits below');
    // The desk half still owns the step, because the own half refused.
    expect(s.next_step).toContain('Brief new openings');
    expect(s.warnings?.[0]).toContain('spending days');
  });

  it('speaks the own-history half FIRST, and the own step wins where both have one', () => {
    const s = buildComparisonSection([hookBand('weak')], ownInputs(beatableDays));
    expect(s.summary.indexOf('Your best 30 days')).toBeLessThan(s.summary.indexOf('Your hook rate'));
    expect(s.next_step).toContain('reachable in this account');
    expect(s.derivation).toContain('Every 30-day stretch');
    expect(s.derivation).toContain('middle half (25th');
  });

  it('leaves the desk half byte-identical when no own-history rows are threaded', () => {
    const withoutOwn = buildComparisonSection([hookBand('weak')]);
    const legacyShape = buildComparisonSection([hookBand('weak')], null);
    expect(withoutOwn.summary).toBe(legacyShape.summary);
    expect(withoutOwn.data.own_best).toBeNull();
    expect(withoutOwn.next_step).toContain('Brief new openings');
    expect(withoutOwn.data.signal).toBe(true);
  });

  it('refuses only when BOTH halves have nothing, and then carries no step', () => {
    const s = buildComparisonSection([]);
    expect(s.summary).toContain('This read has neither');
    expect(s.next_step).toBeUndefined();
    expect(s.data.signal).toBe(false);
    expect(s.data.own_best).toBeNull();
  });

  it('stays quiet on a strong desk band and a quiet own-history read', () => {
    const s = buildComparisonSection([hookBand('strong')], ownInputs([...run(60, NORMAL), ...run(30, CHEAP, 60)]));
    expect(s.data.signal).toBe(false);
    expect(s.summary).toContain('Your best 30 days are the ones you are in');
  });

  it('names both halves in the work ledger line, and only the halves that ran', () => {
    const bothHalves = workLineFor('how_you_compare', {
      key: 'how_you_compare',
      title: 't',
      status: 'complete',
      data: buildComparisonSection([hookBand('weak')], ownInputs(beatableDays)).data,
    });
    expect(bothHalves).toContain("the account's own cheapest 30");
    expect(bothHalves).toContain('accounts on our desk');
    const ownOnly = workLineFor('how_you_compare', {
      key: 'how_you_compare',
      title: 't',
      status: 'complete',
      data: buildComparisonSection([], ownInputs(beatableDays)).data,
    });
    expect(ownOnly).toContain('every 30-day stretch');
    expect(ownOnly).not.toContain('desk');
    const refused = workLineFor('how_you_compare', {
      key: 'how_you_compare',
      title: 't',
      status: 'complete',
      data: buildComparisonSection([hookBand('weak')], ownInputs(run(50, NORMAL))).data,
    });
    expect(refused).toBe('Benchmarked your hook rate against the accounts on our desk');
  });
});

// ---------------------------------------------------------------------------
// The copy sweep
// ---------------------------------------------------------------------------

describe('the words', () => {
  const sections: OwnBestMonthRead[] = [
    read([...run(30, CHEAP), ...run(60, NORMAL, 30)]),
    read([...run(30, CHEAP), ...run(60, NORMAL, 30)], [
      { ad_id: 'a', ad_name: 'Hook A', date: day(0), spend: 3000 },
    ]),
    read([...run(30, CHEAP), ...run(150, NORMAL, 30)]),
    read([...run(60, NORMAL), ...run(30, { spend: 110, results: 5 }, 60)]),
    read([...run(60, NORMAL), ...run(30, CHEAP, 60)]),
    read(run(50, NORMAL)),
    read(Array.from({ length: 90 }, (_, i) => ({ date: day(i), spend: 100, results: i % 5 === 0 ? 1 : 0 }))),
    read([...run(60, NORMAL), ...run(30, { spend: 100, results: 0 }, 60)]),
  ];

  it('the chapter title covers both halves and carries no dash', () => {
    const title = SECTION_ORDER.find((s) => s.key === 'how_you_compare')!.title;
    expect(title).not.toMatch(/[—–]/);
    expect(title).toContain(':');
    expect(title).toMatch(/best month/i);
    expect(title).toMatch(/desk/i);
  });

  it('every string this engine writes is already house punctuation', () => {
    for (const s of sections) {
      for (const text of [s.summary, s.next_step ?? '', s.derivation, ...s.warnings]) {
        expect(text).not.toMatch(/[—]/);
        expect(dedash(text)).toBe(text);
      }
    }
  });

  it('never writes a plural count as singular or a singular one as plural', () => {
    for (const s of sections) {
      const text = `${s.summary} ${s.next_step ?? ''} ${s.derivation}`;
      expect(text, s.summary).not.toMatch(/\b1 (?:days|leads|ads|results)\b/);
      expect(text, s.summary).not.toMatch(/\b(?:[02-9]|\d\d+) (?:day|lead|ad|result) \b/);
      expect(text, s.summary).not.toMatch(/\b0 more\b/);
      expect(text, s.summary).not.toMatch(/\bof them with spends\b/);
    }
  });

  it('reads the singular through, count by count', () => {
    // One lead in the current stretch, one ad carrying the best one.
    const one = read(
      [...run(60, CHEAP), ...run(29, { spend: 0, results: 0 }, 60), { date: day(89), spend: 30, results: 1 }],
      [{ ad_id: 'a', ad_name: 'Solo', date: day(0), spend: 100 }],
    );
    expect(one.case).toBe('beatable');
    expect(one.summary).toContain('1 ad carried that stretch');
    expect(one.summary).not.toMatch(/\b1 (?:leads|ads)\b/);
    const oneMore = read([
      ...run(60, CHEAP),
      ...Array.from({ length: 29 }, (_, i) => ({ date: day(60 + i), spend: 0, results: 0 })),
      { date: day(89), spend: 32, results: 2 },
    ]);
    expect(oneMore.data.extra_results_same_money).toBe(1);
    expect(oneMore.summary).toContain('1 more lead for the same money');
  });
});
