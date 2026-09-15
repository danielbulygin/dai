/**
 * Loop 3's ledger walker — one case per signal × outcome, plus the three rules
 * that decide what the reader actually SEES.
 *
 * What these cases exist to protect:
 *   1. Every prior-day claim gets an answer. confirmed / resolved / stale is
 *      always computed — a claim never just stops being mentioned.
 *   2. Direction matters. A CPA that swung the other way has not confirmed the
 *      original claim, however big the new move is.
 *   3. Lines are scarce and never duplicated: an ad already in today's Movers
 *      section gets an outcome but no follow-up line, one thread gets one line,
 *      and the section caps at 3 with closures winning the slots.
 *   4. No relative day words. Days are named via dayLabel or not at all.
 *   5. Monday's rollup judges the whole verified weekend as one window, and a
 *      window too thin to judge parks the thread instead of killing it.
 */

import { describe, expect, it } from 'vitest';
import {
  walkAdInsights,
  type LedgerInsight,
  type WalkAdDay,
  type WalkArgs,
} from '../src/monitoring/ledger-walker.js';

const Y = '2026-08-06'; // the reporting day under test
const TRAIL = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05'];

/** Same shape as the brief's dayLabel: '2026-08-05' → 'Wed, Aug 5'. */
const dayLabel = (d: string): string =>
  new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${d}T12:00:00Z`));

interface DaySpec {
  spend: number;
  purchases?: number;
}

/** A trailing series at `trailing` per day plus the reporting day at `day`. */
function series(adId: string, trailing: DaySpec, day: DaySpec | null): WalkAdDay[] {
  const row = (date: string, s: DaySpec): WalkAdDay => ({
    date,
    ad_id: adId,
    spend: s.spend,
    purchases: s.purchases ?? 0,
    impressions: 20_000,
    link_clicks: 300,
  });
  const rows = TRAIL.map((d) => row(d, trailing));
  if (day) rows.push(row(Y, day));
  return rows;
}

function insight(
  adId: string,
  kind: string,
  evidence: Record<string, unknown> = {},
  date = '2026-08-05',
): LedgerInsight {
  return {
    id: `ins-${adId}-${kind}-${date}`,
    entity_id: adId,
    entity_name: adId,
    evidence: { date, kind, ...evidence },
    // The brief derives a claim the morning AFTER its data day.
    derived_at: `${date}T06:10:00Z`,
  };
}

function args(over: Partial<WalkArgs> = {}): WalkArgs {
  return {
    insights: [],
    ads: [],
    yesterday: Y,
    accountSpendYesterday: 1000,
    trailingAvgDailySpend: 1000,
    currency: 'USD',
    todaysMoverAdIds: new Set<string>(),
    dayLabel,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// cpa_shift
// ---------------------------------------------------------------------------

describe('cpa_shift re-check', () => {
  // Trailing: $300/day for 10 purchases → $30 pooled CPA.
  const trailing: DaySpec = { spend: 300, purchases: 10 };
  const claim = insight('a1', 'cpa_shift', {
    yesterday_cpa: 75,
    trailing_cpa: 30,
    rel_change: 1.5,
    yesterday_spend: 300,
  });

  it('still >25% adverse in the same direction → confirmed, with the day count', () => {
    // $300 on 5 purchases = $60 CPA vs $30 usual.
    const [w] = walkAdInsights(
      args({ insights: [claim], ads: series('a1', trailing, { spend: 300, purchases: 5 }) }),
    );
    expect(w!.outcome).toBe('confirmed');
    expect(w!.value).toBe(60);
    expect(w!.line).toContain('still elevated');
    expect(w!.line).toContain('$60.00');
    expect(w!.line).toContain('$30.00');
    expect(w!.line).toContain('day 2 of the story');
  });

  it('back within 25% → resolved, and the closure quotes both numbers', () => {
    // $330 on 10 purchases = $33 CPA vs $30 usual → 10% off, inside the band.
    const [w] = walkAdInsights(
      args({ insights: [claim], ads: series('a1', trailing, { spend: 330, purchases: 10 }) }),
    );
    expect(w!.outcome).toBe('resolved');
    expect(w!.line).toContain('back in range');
    expect(w!.line).toContain('$33.00');
    expect(w!.line).toContain('$30.00');
  });

  it('a big move the OTHER way does not confirm an expensive-CPA claim', () => {
    // $150 on 10 purchases = $15 CPA — half the usual, opposite of rel_change.
    const [w] = walkAdInsights(
      args({ insights: [claim], ads: series('a1', trailing, { spend: 150, purchases: 10 }) }),
    );
    expect(w!.outcome).toBe('resolved');
    expect(w!.evidence.same_direction).toBe(false);
  });

  it('a cheap-CPA claim confirms on a cheap day, not an expensive one', () => {
    const cheapClaim = insight('a1', 'cpa_shift', {
      trailing_cpa: 30,
      rel_change: -0.5,
      yesterday_spend: 300,
    });
    const stillCheap = walkAdInsights(
      args({ insights: [cheapClaim], ads: series('a1', trailing, { spend: 150, purchases: 10 }) }),
    );
    expect(stillCheap[0]!.outcome).toBe('confirmed');
    expect(stillCheap[0]!.line).toContain('still cheaper');
  });

  it('no spend, or too few purchases to judge → stale', () => {
    const noSpend = walkAdInsights(
      args({ insights: [claim], ads: series('a1', trailing, null) }),
    );
    expect(noSpend[0]!.outcome).toBe('stale');
    expect(noSpend[0]!.line).toContain('no longer enough delivery to judge');
    expect(noSpend[0]!.value).toBeNull();

    // Spend is there, but 2 purchases is under the small-numbers floor.
    const thin = walkAdInsights(
      args({ insights: [claim], ads: series('a1', trailing, { spend: 300, purchases: 2 }) }),
    );
    expect(thin[0]!.outcome).toBe('stale');
  });
});

// ---------------------------------------------------------------------------
// zero_results_on_spend
// ---------------------------------------------------------------------------

describe('zero_results_on_spend re-check', () => {
  const trailing: DaySpec = { spend: 300, purchases: 10 };
  const claim = insight('z1', 'zero_results_on_spend', {
    yesterday_spend: 320,
    trailing_avg_purchases: 10,
  });

  it('still spending at least half as much, still nothing back → confirmed', () => {
    const [w] = walkAdInsights(
      args({ insights: [claim], ads: series('z1', trailing, { spend: 280, purchases: 0 }) }),
    );
    expect(w!.outcome).toBe('confirmed');
    expect(w!.value).toBe(0);
    expect(w!.line).toContain('still nothing back on $280');
    expect(w!.line).toContain('day 2 of the story');
  });

  it('a purchase lands → resolved, converting again', () => {
    const [w] = walkAdInsights(
      args({ insights: [claim], ads: series('z1', trailing, { spend: 290, purchases: 4 }) }),
    );
    expect(w!.outcome).toBe('resolved');
    expect(w!.value).toBe(4);
    expect(w!.line).toContain('converting again, 4 purchases on $290');
  });

  it('spend collapsed → stale, quoting what it used to spend', () => {
    const [w] = walkAdInsights(
      args({ insights: [claim], ads: series('z1', trailing, { spend: 12, purchases: 0 }) }),
    );
    expect(w!.outcome).toBe('stale');
    expect(w!.line).toContain('spend collapsed to $12');
    expect(w!.line).toContain('$320');
  });
});

// ---------------------------------------------------------------------------
// spend_share_shift
// ---------------------------------------------------------------------------

describe('spend_share_shift re-check', () => {
  // Trailing $100/day on a $1000/day account → 10% usual share.
  const trailing: DaySpec = { spend: 100, purchases: 3 };
  const claim = insight('s1', 'spend_share_shift', {
    yesterday_spend: 400,
    trailing_avg_spend: 100,
    yesterday_share: 0.4,
    trailing_share: 0.1,
  });

  it('still more than 8 points shifted the same way → confirmed', () => {
    // $450 of a $1000 day = 45% vs 10% usual.
    const [w] = walkAdInsights(
      args({ insights: [claim], ads: series('s1', trailing, { spend: 450, purchases: 4 }) }),
    );
    expect(w!.outcome).toBe('confirmed');
    expect(w!.value).toBe(0.45);
    expect(w!.line).toContain('still shifted, $450 vs $100/day usual');
    expect(w!.line).toContain('10% → 45%');
  });

  it('share back inside 8 points → resolved', () => {
    // $150 of a $1000 day = 15% vs 10% usual → a 5-point gap.
    const [w] = walkAdInsights(
      args({ insights: [claim], ads: series('s1', trailing, { spend: 150, purchases: 5 }) }),
    );
    expect(w!.outcome).toBe('resolved');
    expect(w!.line).toContain('back to its usual share');
  });

  it('an ad at zero is stale, never "back to normal"', () => {
    const [w] = walkAdInsights(
      args({ insights: [claim], ads: series('s1', trailing, null) }),
    );
    expect(w!.outcome).toBe('stale');
    expect(w!.line).toContain('not spending at all now');
    expect(w!.line).not.toContain('usual share');
  });
});

// ---------------------------------------------------------------------------
// Which claims get walked at all
// ---------------------------------------------------------------------------

describe('the walk queue', () => {
  const trailing: DaySpec = { spend: 300, purchases: 10 };

  it('a claim about THIS reporting day is not a prior thread', () => {
    const sameDay = insight('a1', 'cpa_shift', { trailing_cpa: 30, rel_change: 1.5 }, Y);
    expect(
      walkAdInsights(
        args({ insights: [sameDay], ads: series('a1', trailing, { spend: 300, purchases: 5 }) }),
      ),
    ).toHaveLength(0);
  });

  it('claims older than 10 days are history, not a live thread', () => {
    const old = insight('a1', 'cpa_shift', { trailing_cpa: 30, rel_change: 1.5 }, '2026-07-20');
    expect(
      walkAdInsights(
        args({ insights: [old], ads: series('a1', trailing, { spend: 300, purchases: 5 }) }),
      ),
    ).toHaveLength(0);
  });

  it('a kind with no cheap re-check is skipped rather than guessed at', () => {
    const other = insight('a1', 'creative_fatigue', {});
    expect(
      walkAdInsights(
        args({ insights: [other], ads: series('a1', trailing, { spend: 300, purchases: 5 }) }),
      ),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Lines: suppression, one-thread-one-line, and the cap
// ---------------------------------------------------------------------------

describe('follow-up lines', () => {
  const trailing: DaySpec = { spend: 300, purchases: 10 };
  const claim = insight('a1', 'cpa_shift', { trailing_cpa: 30, rel_change: 1.5 });

  it("an ad in today's Movers gets an outcome but no duplicate line", () => {
    const [w] = walkAdInsights(
      args({
        insights: [claim],
        ads: series('a1', trailing, { spend: 330, purchases: 10 }),
        todaysMoverAdIds: new Set(['a1']),
      }),
    );
    expect(w!.outcome).toBe('resolved'); // the ledger still learns the answer
    expect(w!.line).toBeNull(); // the Movers section is telling this story
  });

  it('several days of the same ad+signal are one thread, so one line', () => {
    const walked = walkAdInsights(
      args({
        insights: [
          insight('a1', 'cpa_shift', { trailing_cpa: 30, rel_change: 1.5 }, '2026-08-04'),
          insight('a1', 'cpa_shift', { trailing_cpa: 30, rel_change: 1.5 }, '2026-08-05'),
        ],
        ads: series('a1', trailing, { spend: 300, purchases: 5 }),
      }),
    );
    expect(walked).toHaveLength(2); // both rows get an outcome...
    expect(walked.every((w) => w.outcome === 'confirmed')).toBe(true);
    const lines = walked.filter((w) => w.line);
    expect(lines).toHaveLength(1); // ...and the oldest owns the line
    expect(lines[0]!.line).toContain('day 3 of the story'); // Aug 4 → Aug 6
  });

  it('caps at 3 lines, and closures win the slots over live signals', () => {
    const ads: WalkAdDay[] = [
      // Three resolved threads: CPA back in range.
      ...series('r1', trailing, { spend: 330, purchases: 10 }),
      ...series('r2', trailing, { spend: 320, purchases: 10 }),
      ...series('r3', trailing, { spend: 310, purchases: 10 }),
      // Two still-confirmed threads.
      ...series('c1', trailing, { spend: 300, purchases: 5 }),
      ...series('c2', trailing, { spend: 300, purchases: 4 }),
    ];
    const cpa = (id: string) => insight(id, 'cpa_shift', { trailing_cpa: 30, rel_change: 1.5 });
    const walked = walkAdInsights(
      args({
        insights: [cpa('c1'), cpa('r1'), cpa('c2'), cpa('r2'), cpa('r3')],
        ads,
        accountSpendYesterday: 5000,
        trailingAvgDailySpend: 5000,
      }),
    );
    expect(walked).toHaveLength(5);
    const lined = walked.filter((w) => w.line);
    expect(lined).toHaveLength(3);
    expect(lined.map((w) => w.adId).sort()).toEqual(['r1', 'r2', 'r3']);
  });

  it('never uses a relative day word — days are named or not mentioned', () => {
    // One walk per case, so every composed sentence wins a slot and gets read:
    // the 3-line cap must never be what saves the phrasing rule.
    const cases: Array<[LedgerInsight, WalkAdDay[]]> = [
      [
        insight('a1', 'cpa_shift', { trailing_cpa: 30, rel_change: 1.5 }),
        series('a1', trailing, { spend: 300, purchases: 5 }), // confirmed
      ],
      [
        insight('a2', 'cpa_shift', { trailing_cpa: 30, rel_change: 1.5 }),
        series('a2', trailing, { spend: 330, purchases: 10 }), // resolved
      ],
      [
        insight('a3', 'cpa_shift', { trailing_cpa: 30, rel_change: 1.5 }),
        series('a3', trailing, null), // stale
      ],
      [
        insight('z1', 'zero_results_on_spend', { yesterday_spend: 320 }),
        series('z1', trailing, { spend: 300, purchases: 0 }), // confirmed
      ],
      [
        insight('z2', 'zero_results_on_spend', { yesterday_spend: 320 }),
        series('z2', trailing, { spend: 10, purchases: 0 }), // stale
      ],
      [
        insight('s1', 'spend_share_shift', {
          yesterday_spend: 400,
          yesterday_share: 0.4,
          trailing_share: 0.1,
        }),
        series('s1', { spend: 100, purchases: 3 }, { spend: 450, purchases: 4 }), // confirmed
      ],
      [
        insight('s2', 'spend_share_shift', {
          yesterday_spend: 400,
          yesterday_share: 0.4,
          trailing_share: 0.1,
        }),
        series('s2', { spend: 100, purchases: 3 }, null), // stale
      ],
    ];

    for (const [claim, ads] of cases) {
      const [w] = walkAdInsights(args({ insights: [claim], ads }));
      expect(w!.line).not.toBeNull();
      const text = `${w!.line} ${JSON.stringify(w!.evidence)}`.toLowerCase();
      expect(text).not.toContain('yesterday');
      expect(text).not.toContain('today');
      expect(text).not.toContain('tomorrow');
      // And the day that IS named is named the way the brief names days.
      expect(w!.line).toContain('Wed, Aug 5');
    }
  });
});

// ---------------------------------------------------------------------------
// Monday's weekend rollup — the window is the unit of judgement, not one day
// ---------------------------------------------------------------------------

describe('the weekend rollup walk', () => {
  const THU = '2026-08-06'; // the data day the story was flagged on
  const FRI = '2026-08-07';
  const SAT = '2026-08-08';
  const SUN = '2026-08-09'; // Monday's brief reports through here
  const WEEKEND = [FRI, SAT, SUN];

  /** An explicit calendar for one ad — a weekend fixture needs uneven days. */
  function days(adId: string, spec: Record<string, DaySpec>): WalkAdDay[] {
    return Object.entries(spec).map(([date, s]) => ({
      date,
      ad_id: adId,
      spend: s.spend,
      purchases: s.purchases ?? 0,
      impressions: 20_000,
      link_clicks: 300,
    }));
  }

  /** Monday's args: the same fixture, judged across the verified weekend. */
  function weekendArgs(over: Partial<WalkArgs> = {}): WalkArgs {
    return args({ yesterday: SUN, windowDates: WEEKEND, ...over });
  }

  /** The identical fixture as the old caller sent it: Sunday alone. */
  function sundayOnlyArgs(over: Partial<WalkArgs> = {}): WalkArgs {
    return args({ yesterday: SUN, ...over });
  }

  describe('cpa_shift across the weekend', () => {
    const claim = insight('w1', 'cpa_shift', { trailing_cpa: 30, rel_change: 1.5 }, THU);
    // Weekdays at $300 for 10 purchases → $30 usual. The weekend stays
    // expensive across Fri+Sat, and Sunday is the thin day that used to decide.
    const ads = days('w1', {
      '2026-08-04': { spend: 300, purchases: 10 },
      '2026-08-05': { spend: 300, purchases: 10 },
      [THU]: { spend: 300, purchases: 10 },
      [FRI]: { spend: 300, purchases: 2 },
      [SAT]: { spend: 300, purchases: 2 },
      [SUN]: { spend: 100, purchases: 0 },
    });

    it('judges the pooled weekend, so a thin Sunday no longer kills the thread', () => {
      // Pooled: $700 on 4 purchases = $175 vs $30 usual.
      const [w] = walkAdInsights(weekendArgs({ insights: [claim], ads }));
      expect(w!.outcome).toBe('confirmed');
      expect(w!.value).toBe(175);
      expect(w!.line).toContain('still elevated');
      expect(w!.line).toContain('$175.00');
      expect(w!.line).toContain('Fri, Aug 7');
      expect(w!.line).toContain('Sun, Aug 9');
      expect(w!.evidence.window_spend).toBe(700);
      expect(w!.evidence.window_purchases).toBe(4);
    });

    it('the same fixture judged on Sunday alone goes stale — the bug this fixes', () => {
      const [w] = walkAdInsights(sundayOnlyArgs({ insights: [claim], ads }));
      expect(w!.outcome).toBe('stale');
      expect(w!.line).toContain('no longer enough delivery to judge');
    });

    it('a weekend is never its own comparison — the trail stops at the window', () => {
      // Two cheap weekdays ($10 CPA) then a heavy $30-CPA weekend. Pooling the
      // weekend into its own baseline would read $28.75 usual → "resolved".
      const ads = days('w2', {
        '2026-08-05': { spend: 30, purchases: 3 },
        [THU]: { spend: 30, purchases: 3 },
        [FRI]: { spend: 900, purchases: 30 },
        [SAT]: { spend: 900, purchases: 30 },
        [SUN]: { spend: 900, purchases: 30 },
      });
      const [w] = walkAdInsights(
        weekendArgs({
          insights: [insight('w2', 'cpa_shift', { trailing_cpa: 10, rel_change: 1.5 }, THU)],
          ads,
        }),
      );
      expect(w!.outcome).toBe('confirmed');
      expect(w!.evidence.trailing_cpa).toBe(10);
      expect(w!.evidence.trailing_days).toBe(2);
    });
  });

  describe('a weekend too thin to judge', () => {
    const claim = insight('t1', 'cpa_shift', { trailing_cpa: 30, rel_change: 1.5 }, THU);
    // Pooled 2 purchases — under the small-numbers floor however you slice it.
    const ads = days('t1', {
      '2026-08-05': { spend: 300, purchases: 10 },
      [THU]: { spend: 300, purchases: 10 },
      [FRI]: { spend: 120, purchases: 1 },
      [SAT]: { spend: 100, purchases: 1 },
      [SUN]: { spend: 80, purchases: 0 },
    });

    it('a rollup stale keeps the row active — a thin weekend is not an ending', () => {
      const [w] = walkAdInsights(weekendArgs({ insights: [claim], ads }));
      expect(w!.outcome).toBe('stale');
      expect(w!.keepActive).toBe(true);
    });

    it('a thin single day still closes the row, exactly as it always did', () => {
      const [w] = walkAdInsights(sundayOnlyArgs({ insights: [claim], ads }));
      expect(w!.outcome).toBe('stale');
      expect(w!.keepActive).toBeFalsy();
    });
  });

  describe('zero_results_on_spend across the weekend', () => {
    const claim = insight('z9', 'zero_results_on_spend', { yesterday_spend: 320 }, THU);

    it('spend that persists all weekend with nothing back → confirmed, pooled', () => {
      // $280/day average against a $320 origin day: the same story, still burning.
      const ads = days('z9', {
        '2026-08-05': { spend: 320, purchases: 8 },
        [THU]: { spend: 320, purchases: 0 },
        [FRI]: { spend: 300, purchases: 0 },
        [SAT]: { spend: 280, purchases: 0 },
        [SUN]: { spend: 260, purchases: 0 },
      });
      const [w] = walkAdInsights(weekendArgs({ insights: [claim], ads }));
      expect(w!.outcome).toBe('confirmed');
      expect(w!.value).toBe(0);
      expect(w!.line).toContain('still nothing back on $840');
      expect(w!.evidence.window_purchases).toBe(0);
    });

    it("one purchase on Saturday resolves it, though Sunday alone saw none", () => {
      const ads = days('z9', {
        '2026-08-05': { spend: 320, purchases: 8 },
        [THU]: { spend: 320, purchases: 0 },
        [FRI]: { spend: 300, purchases: 0 },
        [SAT]: { spend: 280, purchases: 1 },
        [SUN]: { spend: 260, purchases: 0 },
      });
      const [w] = walkAdInsights(weekendArgs({ insights: [claim], ads }));
      expect(w!.outcome).toBe('resolved');
      expect(w!.value).toBe(1);
      expect(w!.line).toContain('converting again, 1 purchase');
      expect(w!.line).toContain('Sat, Aug 8'); // the day it landed, named

      // Sunday alone never sees Saturday's purchase and re-confirms the claim.
      const [sundayOnly] = walkAdInsights(sundayOnlyArgs({ insights: [claim], ads }));
      expect(sundayOnly!.outcome).toBe('confirmed');
    });
  });

  describe('spend_share_shift across the weekend', () => {
    const claim = insight(
      's9',
      'spend_share_shift',
      { yesterday_spend: 400, yesterday_share: 0.4, trailing_share: 0.1 },
      THU,
    );
    // $100/day usual on a $1000/day account → 10% share. The ad takes the
    // weekend's delivery on Fri+Sat and hands it back on Sunday.
    const ads = days('s9', {
      '2026-08-05': { spend: 100, purchases: 3 },
      [THU]: { spend: 100, purchases: 3 },
      [FRI]: { spend: 450, purchases: 4 },
      [SAT]: { spend: 450, purchases: 4 },
      [SUN]: { spend: 60, purchases: 1 },
    });

    it("judges the ad's window spend against the account's window spend", () => {
      // $960 of a $3000 weekend = 32% vs 10% usual.
      const [w] = walkAdInsights(weekendArgs({ insights: [claim], ads, accountSpendWindow: 3000 }));
      expect(w!.outcome).toBe('confirmed');
      expect(w!.value).toBe(0.32);
      expect(w!.line).toContain('10% → 32%');
      expect(w!.evidence.account_spend_window).toBe(3000);
    });

    it('Sunday alone reads 6% of one day and wrongly closes the story', () => {
      const [w] = walkAdInsights(sundayOnlyArgs({ insights: [claim], ads }));
      expect(w!.outcome).toBe('resolved');
      expect(w!.line).toContain('back to its usual share');
    });
  });
});
