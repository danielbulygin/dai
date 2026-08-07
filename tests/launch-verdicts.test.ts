/**
 * Loop 2's verdict half — one case per decision rule (board card 82,
 * reshaped 2026-08-07 by Daniel's "I sometimes also check earlier to get an
 * early indicator").
 *
 * The two rules these cases exist to protect:
 *   1. Verdicts are EVIDENCE-based. Each type fires the moment its own
 *      evidence exists; the day 1/3/7 checkpoints are only the floor, and a
 *      quiet ad on an off-checkpoint day gets silence, not filler.
 *   2. A floored ad set's spend is not a vote. Known floor → the line refuses
 *      the auction claim; unknown floors → the line makes no floor claim at
 *      all, in either direction.
 */

import { describe, expect, it } from 'vitest';
import {
  evaluateLaunches,
  type EvaluateArgs,
  type LaunchAdDay,
  type WatchInput,
} from '../src/monitoring/launch-verdicts.js';

const Y = '2026-08-06';

/** Same shape as the brief's dayLabel: '2026-08-05' → 'Wed, Aug 5'. */
const dayLabel = (d: string): string =>
  new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${d}T12:00:00Z`));

function watch(adId: string, firstSpendDate: string, adName = adId): WatchInput {
  return { insightId: `ins-${adId}`, adId, adName, firstSpendDate };
}

interface DaySpec {
  date: string;
  spend: number;
  purchases?: number;
  impressions?: number;
  clicks?: number;
}

function rows(adId: string, days: DaySpec[], adsetId: string | null = 's1'): LaunchAdDay[] {
  return days.map((d) => ({
    date: d.date,
    ad_id: adId,
    adset_id: adsetId,
    spend: d.spend,
    impressions: d.impressions ?? 5000,
    link_clicks: d.clicks ?? 50,
    hook_rate: 0.22,
    purchases: d.purchases ?? 0,
  }));
}

function args(over: Partial<EvaluateArgs> = {}): EvaluateArgs {
  return {
    watches: [],
    ads: [],
    yesterday: Y,
    accountSpendYesterday: 5000,
    trailingAvgDailySpend: 5000,
    accountTrailingCpa: 40,
    expectedCpa: 25,
    currency: 'USD',
    dayLabel,
    ...over,
  };
}

describe('evaluateLaunches — money out, nothing back', () => {
  it('fires on 2x the expected cost per result with zero purchases, and names the line it crossed', () => {
    const out = evaluateLaunches(
      args({
        watches: [watch('a1', '2026-08-04', 'Hook v3 — UGC')],
        ads: rows('a1', [
          { date: '2026-08-04', spend: 30 },
          { date: '2026-08-05', spend: 40 },
          { date: Y, spend: 50 },
        ]),
      }),
    );
    expect(out).toHaveLength(1);
    const v = out[0]!;
    expect(v.kind).toBe('money_out_nothing_back');
    expect(v.ageDays).toBe(3);
    // Money leads, the reference is named, and no verdict is claimed.
    expect(v.line).toContain('$120');
    expect(v.line).toContain('over 3 days');
    expect(v.line).toContain('0 purchases');
    expect(v.line).toContain('happy band is $25.00');
    expect(v.next).toContain('worth a look now');
    expect(v.isFinal).toBe(false);
    expect(v.insightId).toBe('ins-a1');
  });
});

describe('evaluateLaunches — the CPA verdicts (never under 3 purchases)', () => {
  it('taking off: 3+ purchases at or under the happy band closes the watch from day 3', () => {
    const out = evaluateLaunches(
      args({
        watches: [watch('a2', '2026-08-04')],
        ads: rows('a2', [
          { date: '2026-08-04', spend: 30, purchases: 1 },
          { date: '2026-08-05', spend: 35, purchases: 2 },
          { date: Y, spend: 35, purchases: 2 },
        ]),
      }),
    );
    const v = out[0]!;
    expect(v.kind).toBe('taking_off');
    expect(v.line).toContain('$20.00 CPA on 5 purchases by day 3');
    expect(v.line).toContain('20% under your happy band of $25.00');
    expect(v.next).toContain('scale test');
    expect(v.isFinal).toBe(true);
  });

  it('flat: 3+ purchases above the band, judged against the reference by name', () => {
    const out = evaluateLaunches(
      args({
        watches: [watch('a3', '2026-08-04')],
        ads: rows('a3', [
          { date: '2026-08-04', spend: 70, purchases: 1 },
          { date: '2026-08-05', spend: 70, purchases: 2 },
          { date: Y, spend: 60, purchases: 1 },
        ]),
      }),
    );
    const v = out[0]!;
    expect(v.kind).toBe('flat');
    expect(v.line).toContain('$50.00 CPA on 4 purchases by day 3');
    expect(v.line).toContain('100% over your happy band of $25.00');
    expect(v.next).toContain('finish the week');
    expect(v.isFinal).toBe(true);
  });

  it('with no band and no account CPA, the number is shown but no verdict is voiced', () => {
    const out = evaluateLaunches(
      args({
        expectedCpa: null,
        accountTrailingCpa: null,
        watches: [watch('a4', '2026-08-04')],
        ads: rows('a4', [
          { date: '2026-08-04', spend: 30, purchases: 1 },
          { date: '2026-08-05', spend: 30, purchases: 1 },
          { date: Y, spend: 30, purchases: 1 },
        ]),
      }),
    );
    const v = out[0]!;
    expect(v.kind).toBe('checkpoint');
    expect(v.line).toContain('$30.00 per purchase on 3 purchases by day 3');
    expect(v.line).toContain('no reference to judge against');
    expect(v.isFinal).toBe(false);
  });
});

describe('evaluateLaunches — starved', () => {
  it('trivial delivery reads as starvation: money first, the share only as its meaning', () => {
    const out = evaluateLaunches(
      args({
        watches: [watch('a5', '2026-08-04')],
        ads: rows('a5', [
          { date: '2026-08-04', spend: 4 },
          { date: '2026-08-05', spend: 4 },
          { date: Y, spend: 4 },
        ]),
      }),
    );
    const v = out[0]!;
    expect(v.kind).toBe('starved');
    // $12 against 3 days of a $5k/day account.
    expect(v.line).toContain('$12.00 in 3 days');
    expect(v.line).toContain(dayLabel('2026-08-04'));
    expect(v.line).toContain('under 0.1%');
    expect(v.line).toContain('$15,000');
    expect(v.next).toContain("isn't choosing it");
    expect(v.isFinal).toBe(true);
  });
});

describe('evaluateLaunches — the first conversion', () => {
  it('crossing 0 → 1 purchases is announced on its own, with the early CPA labelled', () => {
    const out = evaluateLaunches(
      args({
        watches: [watch('a6', '2026-08-05')],
        ads: rows('a6', [
          { date: '2026-08-05', spend: 40 },
          { date: Y, spend: 50, purchases: 1 },
        ]),
      }),
    );
    const v = out[0]!;
    expect(v.kind).toBe('first_conversion');
    expect(v.line).toContain(`first purchase on ${dayLabel(Y)}, day 2`);
    expect(v.line).toContain('$90.00 in so far');
    expect(v.line).toContain('early, not a verdict');
    expect(v.next).toContain('verdict when it reaches 3');
    expect(v.isFinal).toBe(false);
  });
});

describe('evaluateLaunches — Meta picked it up (a floored ad set is not a vote)', () => {
  const pickedUp = (over: Partial<EvaluateArgs> = {}) =>
    evaluateLaunches(
      args({
        expectedCpa: 200,
        accountTrailingCpa: 200,
        watches: [watch('a7', Y)],
        ads: rows('a7', [{ date: Y, spend: 300 }]),
        ...over,
      }),
    );

  it('floors unknown: states the delivery, claims nothing about the auction', () => {
    const v = pickedUp()[0]!;
    expect(v.kind).toBe('meta_picked_up');
    expect(v.line).toContain("Meta gave it $300 (6% of the account's day) on day 1");
    expect(v.line).not.toMatch(/floor/i);
    expect(v.line).not.toMatch(/auction/i);
    expect(v.next).toContain('watching response next');
    expect(v.isFinal).toBe(false);
  });

  it('floor known on this ad set: the auction-vote claim is suppressed and the signal called void', () => {
    const v = pickedUp({ flooredAdsetIds: new Set(['s1']) })[0]!;
    expect(v.kind).toBe('meta_picked_up');
    expect(v.line).toContain('minimum-spend floor');
    expect(v.line).toContain('forced');
    expect(v.line).not.toContain('the auction chose it');
    expect(v.evidence.adset_floored).toBe(true);
  });

  it('floors known and this ad set is clean: the auction vote may finally be claimed', () => {
    const v = pickedUp({ flooredAdsetIds: new Set(['other-adset']) })[0]!;
    expect(v.line).toContain('no spend floor forcing it');
    expect(v.line).toContain('the auction chose it');
    expect(v.evidence.adset_floored).toBe(false);
  });
});

describe('evaluateLaunches — early CPA', () => {
  it('1-2 purchases show their CPA, always labelled early', () => {
    const out = evaluateLaunches(
      args({
        watches: [watch('a8', '2026-08-04')],
        ads: rows('a8', [
          { date: '2026-08-04', spend: 30, purchases: 1 },
          { date: '2026-08-05', spend: 30 },
          { date: Y, spend: 40 },
        ]),
      }),
    );
    const v = out[0]!;
    expect(v.kind).toBe('early_cpa');
    expect(v.line).toContain('$100.00 CPA on 1 purchase by day 3 — early, not a verdict');
    expect(v.next).toContain('looking expensive so far');
    expect(v.isFinal).toBe(false);
  });
});

describe('evaluateLaunches — the calendar floor', () => {
  it('day 7 with nothing to judge still speaks, and closes the watch', () => {
    const out = evaluateLaunches(
      args({
        expectedCpa: 200,
        watches: [watch('a9', '2026-07-31')],
        ads: rows(
          'a9',
          ['2026-07-31', '2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05', Y].map(
            (date) => ({ date, spend: 40 }),
          ),
        ),
      }),
    );
    const v = out[0]!;
    expect(v.ageDays).toBe(7);
    expect(v.kind).toBe('checkpoint');
    expect(v.line).toContain('day 7: $280 in, 0 purchases — too early to judge');
    expect(v.next).toContain('closing the watch');
    expect(v.isFinal).toBe(true);
  });

  it('a quiet ad on day 2 gets nothing at all — no signal, no checkpoint due', () => {
    const out = evaluateLaunches(
      args({
        expectedCpa: 100,
        accountTrailingCpa: null,
        watches: [watch('a10', '2026-08-05')],
        ads: rows('a10', [
          { date: '2026-08-05', spend: 40 },
          { date: Y, spend: 40 },
        ]),
      }),
    );
    expect(out).toHaveLength(0);
  });
});

describe('evaluateLaunches — priority and house rules', () => {
  it('an ad that qualifies for both gets money_out_nothing_back, not starved', () => {
    const out = evaluateLaunches(
      args({
        // A $5 cost-per-lead account spending $5k/day: $12 in 3 days is both
        // trivial delivery AND already 2x the expected cost with nothing back.
        expectedCpa: 5,
        watches: [watch('a11', '2026-08-04')],
        ads: rows('a11', [
          { date: '2026-08-04', spend: 4 },
          { date: '2026-08-05', spend: 4 },
          { date: Y, spend: 4 },
        ]),
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('money_out_nothing_back');
  });

  it('every line names its day explicitly, leads with money, and never says "yesterday"', () => {
    const out = evaluateLaunches(
      args({
        watches: [
          watch('m1', '2026-08-04', 'Money out'),
          watch('m2', '2026-08-04', 'Winner'),
          watch('m3', '2026-08-04', 'Starved'),
          watch('m4', '2026-08-05', 'First sale'),
        ],
        ads: [
          ...rows('m1', [
            { date: '2026-08-04', spend: 40 },
            { date: '2026-08-05', spend: 40 },
            { date: Y, spend: 40 },
          ]),
          ...rows('m2', [
            { date: '2026-08-04', spend: 30, purchases: 2 },
            { date: '2026-08-05', spend: 30, purchases: 2 },
            { date: Y, spend: 30, purchases: 2 },
          ]),
          ...rows('m3', [
            { date: '2026-08-04', spend: 4 },
            { date: '2026-08-05', spend: 4 },
            { date: Y, spend: 4 },
          ]),
          ...rows('m4', [
            { date: '2026-08-05', spend: 40 },
            { date: Y, spend: 50, purchases: 1 },
          ]),
        ],
      }),
    );
    // Verdicts come back in watch order, one per watched ad at most.
    expect(out.map((v) => v.kind)).toEqual([
      'money_out_nothing_back',
      'taking_off',
      'starved',
      'first_conversion',
    ]);
    for (const v of out) {
      expect(v.line).not.toMatch(/\b(yesterday|today)\b/i);
      expect(v.next).not.toMatch(/\b(yesterday|today)\b/i);
      expect(v.line).toContain('$');
      expect(v.line.startsWith('•')).toBe(false);
      expect(v.next.length).toBeGreaterThan(0);
      expect(v.evidence.age_days).toBe(v.ageDays);
    }
  });
});
