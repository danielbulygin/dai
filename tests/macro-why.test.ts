/**
 * The macro why — the cases that protect the decomposition.
 *
 * What these exist to defend:
 *   1. The identity is EXACT. mix + within = the whole move, always, or the
 *      split is a story rather than arithmetic.
 *   2. Small components fold into "other" and are never named as the cause.
 *   3. Frequency is never split. Reach is never summed and called reach. The
 *      only frequency claims are per-entity ones and impression shares.
 *   4. Strain needs BOTH arms: reach per unit spent fell AND the budget held.
 *      Falling reach on a halved budget is a budget fact, not an audience one.
 *   5. "New creative" means new in the history we actually have, and means it
 *      took real spend — a 20p trickle is not a refresh.
 *   6. Voice: currency amounts lead, components are NAMED, the unexplained
 *      part is said out loud, and no line says "yesterday" or "today".
 *   7. An entrant has no baseline of its own, so it can never be quoted as
 *      having "gone from X to Y" — and when entrants carry the account, the
 *      line says the account changed shape instead of faking a clean split.
 */

import { describe, expect, it } from 'vitest';

import {
  CARRIER_FREQUENCY,
  audienceStrain,
  buildAdsetWindows,
  buildComponentSet,
  categorize,
  attachMacroWhysSafely,
  composeMacroWhy,
  creativeRefreshRead,
  decomposeRate,
  frequencyCarriers,
  macroWhyFor,
  type AdDailyRow,
  type AdsetDailyRow,
  type CampaignDailyRow,
  type CategoryConfig,
  type MacroWhyContext,
  type RateComponent,
} from '../src/monitoring/macro-why.js';
import { pulseLines, type RenderedPulse } from '../src/monitoring/macro-vitals.js';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** A component described the way a media buyer says it: shares and rates. */
function comp(
  key: string,
  o: { curImpr: number; curCpm: number; baseImpr: number; baseCpm: number },
): RateComponent {
  return {
    key,
    name: key,
    curDen: o.curImpr,
    curNum: (o.curCpm * o.curImpr) / 1000,
    baseDen: o.baseImpr,
    baseNum: (o.baseCpm * o.baseImpr) / 1000,
  };
}

const CPM = { scale: 1000 } as const;

function addDays(dateStr: string, delta: number): string {
  return new Date(Date.parse(`${dateStr}T12:00:00Z`) + delta * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function adRow(o: Partial<AdDailyRow> & { date: string; ad_id: string; spend: number }): AdDailyRow {
  return {
    ad_name: o.ad_id,
    adset_id: 'adset-1',
    campaign_id: 'camp-1',
    impressions: Math.round(o.spend * 100),
    reach: Math.round(o.spend * 60),
    frequency: null,
    link_clicks: 0,
    purchases: 0,
    ...o,
  };
}

function campaignRow(
  date: string,
  id: string,
  name: string,
  o: { spend: number; impressions: number; reach?: number; clicks?: number },
): CampaignDailyRow {
  return {
    date,
    campaign_id: id,
    campaign_name: name,
    spend: o.spend,
    impressions: o.impressions,
    reach: o.reach ?? Math.round(o.impressions * 0.6),
    link_clicks: o.clicks ?? 0,
  };
}

const CURRENT = { start: '2026-07-27', end: '2026-08-09' };
const BASELINE = { start: '2026-04-28', end: '2026-05-11' };

// ---------------------------------------------------------------------------
// 1. decomposeRate — the identity
// ---------------------------------------------------------------------------

describe('decomposeRate', () => {
  it('calls a pure share shift mix, with nothing left over', () => {
    // Both components cost exactly what they always did; only the split moved.
    const d = decomposeRate(
      [
        comp('Juices', { curImpr: 400_000, curCpm: 10, baseImpr: 800_000, baseCpm: 10 }),
        comp('Meals', { curImpr: 600_000, curCpm: 20, baseImpr: 200_000, baseCpm: 20 }),
      ],
      CPM,
    );

    expect(d.baseRate).toBeCloseTo(12, 9);
    expect(d.curRate).toBeCloseTo(16, 9);
    expect(d.mixPct).toBeCloseTo(1, 9);
    expect(d.withinPct).toBeCloseTo(0, 9);
    expect(d.mixPct! + d.withinPct!).toBeCloseTo(1, 9);
    expect(d.topMix?.name).toBe('Meals');
    expect(d.counterMix?.name).toBe('Juices');
    expect(d.topWithin).toBeNull();
    expect(d.shapeChanged).toBe(false);
  });

  it('calls a pure rate change within, and names the component that moved', () => {
    const d = decomposeRate(
      [
        comp('Juices', { curImpr: 500_000, curCpm: 12, baseImpr: 500_000, baseCpm: 10 }),
        comp('Meals', { curImpr: 500_000, curCpm: 20, baseImpr: 500_000, baseCpm: 20 }),
      ],
      CPM,
    );

    expect(d.delta).toBeCloseTo(1, 9);
    expect(d.mixPct).toBeCloseTo(0, 9);
    expect(d.withinPct).toBeCloseTo(1, 9);
    expect(d.topWithin?.name).toBe('Juices');
    expect(d.topWithin?.withinPctOfDelta).toBeCloseTo(1, 9);
    expect(d.topMix).toBeNull();
  });

  it('splits a mixed move exactly, and reports an honest negative remainder', () => {
    // B both gained share AND got dearer; A got slightly dearer while shrinking.
    const d = decomposeRate(
      [
        comp('A', { curImpr: 400_000, curCpm: 11, baseImpr: 700_000, baseCpm: 10 }),
        comp('B', { curImpr: 600_000, curCpm: 24, baseImpr: 300_000, baseCpm: 20 }),
      ],
      CPM,
    );

    expect(d.baseRate).toBeCloseTo(13, 9);
    expect(d.curRate).toBeCloseTo(18.8, 9);
    expect(d.mixPct).toBeCloseTo(3 / 5.8, 6);
    expect(d.withinPct).toBeCloseTo(2.8 / 5.8, 6);
    // The identity holds to floating-point precision — this is the whole point.
    expect(d.mixPct! + d.withinPct!).toBeCloseTo(1, 9);
    expect(
      d.components.reduce((s, c) => s + c.mix + c.within, 0),
    ).toBeCloseTo(d.delta!, 9);

    // B carries more than the whole move on its own; A pushed back. The
    // remainder says so rather than being clamped to a comfortable zero.
    expect(d.topMix?.name).toBe('B');
    expect(d.topWithin?.name).toBe('B');
    expect(d.remainderPct).toBeLessThan(0);
    expect(d.remainderPct).toBeCloseTo(1 - 6 / 5.8 - 2.4 / 5.8, 6);
  });

  it('leaves a positive remainder when the named two do not carry the move', () => {
    // Four components each drifting up a little: nobody is the cause.
    const d = decomposeRate(
      [
        comp('A', { curImpr: 250_000, curCpm: 11, baseImpr: 250_000, baseCpm: 10 }),
        comp('B', { curImpr: 250_000, curCpm: 11, baseImpr: 250_000, baseCpm: 10 }),
        comp('C', { curImpr: 250_000, curCpm: 11, baseImpr: 250_000, baseCpm: 10 }),
        comp('D', { curImpr: 250_000, curCpm: 11, baseImpr: 250_000, baseCpm: 10 }),
      ],
      CPM,
    );

    expect(d.mixPct).toBeCloseTo(0, 9);
    expect(d.withinPct).toBeCloseTo(1, 9);
    expect(d.topWithin?.withinPctOfDelta).toBeCloseTo(0.25, 6);
    expect(d.remainderPct).toBeCloseTo(0.75, 6);
  });

  it('folds components under 5% share in BOTH windows into "other"', () => {
    const tiny = (key: string): RateComponent =>
      comp(key, { curImpr: 20_000, curCpm: 40, baseImpr: 20_000, baseCpm: 40 });
    const d = decomposeRate(
      [
        comp('Big', { curImpr: 600_000, curCpm: 20, baseImpr: 600_000, baseCpm: 15 }),
        comp('Mid', { curImpr: 320_000, curCpm: 12, baseImpr: 320_000, baseCpm: 12 }),
        tiny('t1'),
        tiny('t2'),
        tiny('t3'),
        tiny('t4'),
      ],
      CPM,
    );

    expect(d.folded).toBe(4);
    expect(d.components.map((c) => c.key).sort()).toEqual(['Big', 'Mid', 'other']);
    // The fold is lossless: the identity still closes on the full delta.
    expect(d.components.reduce((s, c) => s + c.mix + c.within, 0)).toBeCloseTo(d.delta!, 9);
    // …and "other" is never the answer to "which one?".
    expect(d.topWithin?.key).toBe('Big');
    expect(d.topMix?.key).not.toBe('other');
  });

  it('keeps a component that is small in one window but big in the other', () => {
    const d = decomposeRate(
      [
        comp('Grew', { curImpr: 400_000, curCpm: 25, baseImpr: 20_000, baseCpm: 25 }),
        comp('Rest', { curImpr: 600_000, curCpm: 10, baseImpr: 980_000, baseCpm: 10 }),
      ],
      CPM,
    );
    expect(d.folded).toBe(0);
    expect(d.components.map((c) => c.key)).toContain('Grew');
  });

  it('never quotes an entrant as having changed, and says the account changed shape', () => {
    // The PL case: the baseline window ran one category, today runs three.
    const d = decomposeRate(
      [
        comp('Meals', { curImpr: 140_000, curCpm: 22, baseImpr: 1_000_000, baseCpm: 15 }),
        comp('Juices', { curImpr: 240_000, curCpm: 18, baseImpr: 0, baseCpm: 0 }),
        comp('Shots', { curImpr: 620_000, curCpm: 17, baseImpr: 0, baseCpm: 0 }),
      ],
      CPM,
    );

    expect(d.entrantShare).toBeCloseTo(0.86, 2);
    expect(d.shapeChanged).toBe(true);
    expect(d.topEntrant?.key).toBe('Shots');
    // Entrants have no baseline rate, so they can never be the "within" story.
    expect(d.topWithin?.key).toBe('Meals');
    expect(d.survivor?.key).toBe('Meals');
    // Even here the identity closes.
    expect(d.mixPct! + d.withinPct!).toBeCloseTo(1, 9);
  });

  it('refuses to attribute a move too small to be a move, and empty input', () => {
    const flat = decomposeRate(
      [
        comp('A', { curImpr: 500_000, curCpm: 10.01, baseImpr: 500_000, baseCpm: 10 }),
        comp('B', { curImpr: 500_000, curCpm: 10, baseImpr: 500_000, baseCpm: 10 }),
      ],
      CPM,
    );
    expect(flat.readable).toBe(false);
    expect(flat.mixPct).toBeNull();
    expect(flat.topMix).toBeNull();

    const none = decomposeRate([]);
    expect(none.readable).toBe(false);
    expect(none.curRate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. frequencyCarriers
// ---------------------------------------------------------------------------

describe('frequencyCarriers', () => {
  const set = (
    key: string,
    curFreq: number,
    curImpr: number,
    baseFreq: number | null,
  ): {
    key: string;
    name: string;
    curImpressions: number;
    curReach: number;
    baseImpressions: number;
    baseReach: number;
  } => ({
    key,
    name: key,
    curImpressions: curImpr,
    curReach: curImpr / curFreq,
    baseImpressions: baseFreq === null ? 0 : 100_000,
    baseReach: baseFreq === null ? 0 : 100_000 / baseFreq,
  });

  it('names only ad sets above the bar, rising, and big enough to carry anything', () => {
    const read = frequencyCarriers([
      set('rising-big', 3.0, 300_000, 2.0), // ✓
      set('rising-mid', 3.4, 200_000, 3.1), // ✓
      set('below-bar', 2.4, 250_000, 1.8), // ✗ not above 2.5
      set('falling', 3.5, 200_000, 3.8), // ✗ not rising
      set('too-small', 4.0, 4_000, 1.5), // ✗ under 1% of impressions
      set('no-baseline', 3.2, 46_000, null), // counted, never called rising
    ]);

    expect(read.carriers.map((c) => c.key)).toEqual(['rising-big', 'rising-mid']);
    expect(read.carriers[0]!.impressionShare).toBeGreaterThan(read.carriers[1]!.impressionShare);
    expect(read.impressionShare).toBeCloseTo(500_000 / 1_000_000, 6);
    expect(read.newAboveThreshold).toBe(1);
    expect(read.readable).toBe(6);
    expect(read.entitiesBaseline).toBe(5);
    expect(CARRIER_FREQUENCY).toBe(2.5);
  });

  it('weights carriers by impressions and never sums reach anywhere', () => {
    const read = frequencyCarriers([set('a', 3.0, 900_000, 2.0), set('b', 3.0, 100_000, 2.0)]);
    expect(read.carriers[0]!.key).toBe('a');
    // The read exposes impression shares and per-entity frequencies only —
    // there is no combined reach on it, because a combined reach would be a
    // sum of overlapping audiences dressed up as a number.
    const serialized = JSON.stringify(read);
    expect(serialized).not.toMatch(/reach/i);
    expect(read.carriers.every((c) => c.impressionShare <= 1)).toBe(true);
  });

  it('reports the highest ad set even when nothing qualifies as a carrier', () => {
    const read = frequencyCarriers([set('a', 1.9, 600_000, 1.5), set('b', 1.4, 400_000, 1.2)]);
    expect(read.carriers).toHaveLength(0);
    expect(read.top?.key).toBe('a');
    expect(read.top?.curFrequency).toBeCloseTo(1.9, 6);
  });
});

// ---------------------------------------------------------------------------
// 3. audienceStrain
// ---------------------------------------------------------------------------

describe('audienceStrain', () => {
  const window = (
    key: string,
    o: { curSpend: number; curReach: number; baseSpend: number; baseReach: number },
  ) => ({ key, name: key, ...o });

  it('flags a tightening pool only when the budget held still', () => {
    const read = audienceStrain([
      // reach/£ 66 → 44 (−34%) on spend +5%: the audience, not the budget.
      window('Juices', { curSpend: 4200, curReach: 184_800, baseSpend: 4000, baseReach: 264_000 }),
      // Same reach/£ fall, but the budget halved — that is money, not a pool.
      window('Shots', { curSpend: 2000, curReach: 88_000, baseSpend: 4000, baseReach: 264_000 }),
      // Budget held, but reach/£ only slipped 10%.
      window('Meals', { curSpend: 4000, curReach: 237_600, baseSpend: 4000, baseReach: 264_000 }),
      // No baseline delivery at all: untestable, never guessed at.
      window('New', { curSpend: 1000, curReach: 10_000, baseSpend: 0, baseReach: 0 }),
    ]);

    expect(read.strained.map((s) => s.key)).toEqual(['Juices']);
    expect(read.checked).toBe(3);
    // 264k reach on £4000 → 66 per £; 184.8k on £4200 → 44 per £.
    expect(read.strained[0]!.reachPerSpendPct).toBeCloseTo(-1 / 3, 3);
    expect(Math.abs(read.strained[0]!.spendPct)).toBeLessThanOrEqual(0.25);
  });

  it('orders the strained components by the money at stake', () => {
    const bad = (key: string, spend: number) =>
      window(key, {
        curSpend: spend,
        curReach: spend * 40,
        baseSpend: spend,
        baseReach: spend * 66,
      });
    const read = audienceStrain([bad('small', 500), bad('big', 9000), bad('mid', 3000)]);
    expect(read.strained.map((s) => s.key)).toEqual(['big', 'mid', 'small']);
  });
});

// ---------------------------------------------------------------------------
// 4. creativeRefreshRead
// ---------------------------------------------------------------------------

describe('creativeRefreshRead', () => {
  const END = '2026-08-09';
  const WINDOW = { start: addDays(END, -13), end: END };

  /** A roster: three old creatives carrying the money, one recent arrival. */
  function roster(o: { newcomerSpendPerDay: number; newcomerFirst: string }): AdDailyRow[] {
    const rows: AdDailyRow[] = [];
    // History starts 90 days back; these three were already running then.
    for (let d = 90; d >= 0; d -= 1) {
      const date = addDays(END, -d);
      rows.push(adRow({ date, ad_id: 'veteran-A', spend: 400 }));
      rows.push(adRow({ date, ad_id: 'veteran-B', spend: 300 }));
      rows.push(adRow({ date, ad_id: 'veteran-C', spend: 200 }));
      rows.push(adRow({ date, ad_id: 'trickle-D', spend: 1 }));
      if (date >= o.newcomerFirst) {
        rows.push(adRow({ date, ad_id: 'newcomer', spend: o.newcomerSpendPerDay }));
      }
    }
    return rows;
  }

  it('counts a genuinely new creative only when it took ≥1% of a day', () => {
    const landed = creativeRefreshRead(
      roster({ newcomerSpendPerDay: 100, newcomerFirst: addDays(END, -12) }),
      WINDOW,
    );
    expect(landed.lastNewCreativeName).toBe('newcomer');
    expect(landed.lastNewCreativeDate).toBe(addDays(END, -12));
    expect(landed.daysSinceNewCreative).toBe(12);

    // Same arrival date, but it never took 1% of a day: not a refresh.
    const trickled = creativeRefreshRead(
      roster({ newcomerSpendPerDay: 2, newcomerFirst: addDays(END, -12) }),
      WINDOW,
    );
    expect(trickled.daysSinceNewCreative).toBeNull();
    expect(trickled.lastNewCreativeName).toBeNull();
  });

  it('never calls an ad new just because the history starts where it does', () => {
    // Every ad here was already spending on day one of the fetched history.
    const rows: AdDailyRow[] = [];
    for (let d = 30; d >= 0; d -= 1) {
      rows.push(adRow({ date: addDays(END, -d), ad_id: 'always-on', spend: 500 }));
    }
    const read = creativeRefreshRead(rows, WINDOW);
    expect(read.daysSinceNewCreative).toBeNull();
    expect(read.historyStart).toBe(addDays(END, -30));
    expect(read.ageIsFloor).toBe(true);
  });

  it('counts a slow launch at its first spend day when it lands within the week', () => {
    const rows: AdDailyRow[] = [];
    for (let d = 60; d >= 0; d -= 1) {
      const date = addDays(END, -d);
      rows.push(adRow({ date, ad_id: 'veteran', spend: 1000 }));
      // Arrives on -20 with pocket change, gets real budget on -16.
      if (d <= 20) rows.push(adRow({ date, ad_id: 'slow-burn', spend: d >= 16 ? 2 : 300 }));
    }
    const read = creativeRefreshRead(rows, WINDOW);
    expect(read.lastNewCreativeName).toBe('slow-burn');
    expect(read.lastNewCreativeDate).toBe(addDays(END, -20));
    expect(read.daysSinceNewCreative).toBe(20);
  });

  it('reads the concentration by creative NAME and the median age of what carries it', () => {
    const rows: AdDailyRow[] = [];
    for (let d = 80; d >= 0; d -= 1) {
      const date = addDays(END, -d);
      // One creative, two ad ids: pooled by name, it is ONE creative.
      if (d <= 60) {
        rows.push(adRow({ date, ad_id: 'twin-1', ad_name: 'Hero cut', spend: 300 }));
        rows.push(adRow({ date, ad_id: 'twin-2', ad_name: 'Hero cut', spend: 300 }));
      }
      if (d <= 40) rows.push(adRow({ date, ad_id: 'b', ad_name: 'Testimonial', spend: 250 }));
      if (d <= 20) rows.push(adRow({ date, ad_id: 'c', ad_name: 'UGC', spend: 200 }));
      // A long tail that carries almost nothing.
      for (let i = 0; i < 6; i += 1) {
        rows.push(adRow({ date, ad_id: `tail-${i}`, ad_name: `Tail ${i}`, spend: 5 }));
      }
    }
    const read = creativeRefreshRead(rows, WINDOW);

    expect(read.totalCreatives).toBe(9);
    // Per day: Hero cut £600 (two ad ids, ONE creative), Testimonial £250,
    // UGC £200, six tails £5 each = £1080. Two creatives reach only 79%, so
    // the 80% line needs three.
    expect(read.carrierCount).toBe(3);
    expect(read.carrierSharePct).toBeGreaterThanOrEqual(0.8);
    expect(read.carriers.map((c) => c.name)).toEqual(['Hero cut', 'Testimonial', 'UGC']);
    expect(read.carriers[0]!.share).toBeCloseTo(600 / 1080, 6);
    // Ages 60 / 40 / 20 → median 40.
    expect(read.medianAgeDays).toBe(40);
    expect(read.ageIsFloor).toBe(false);
  });

  it('says nothing at all when nothing spent', () => {
    const read = creativeRefreshRead([], WINDOW);
    expect(read.carrierCount).toBe(0);
    expect(read.medianAgeDays).toBeNull();
    expect(read.historyStart).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Category semantics — the brief's rules, to the letter
// ---------------------------------------------------------------------------

const PL_CONFIG: CategoryConfig = {
  rules: [
    { category: 'juices_cleanses', patterns: ['JUICE', 'Juice', 'Cleanse'] },
    { category: 'meals', patterns: ['MEAL', 'Meal'] },
  ],
  defaultCategory: 'default',
  names: { juices_cleanses: 'Juices & Cleanses', meals: 'Meal Plans', default: 'Other/Mixed' },
};

describe('categorize', () => {
  it('takes the first rule whose pattern is a substring, else the default', () => {
    expect(categorize('AOT // Juice cleanse // CBO', PL_CONFIG)).toBe('juices_cleanses');
    expect(categorize('AOT // Meal prep', PL_CONFIG)).toBe('meals');
    // First rule wins even when a later one also matches — same as the brief.
    expect(categorize('Juice + Meal bundle', PL_CONFIG)).toBe('juices_cleanses');
    expect(categorize('AOT // Sale May 2026', PL_CONFIG)).toBe('default');
  });
});

// ---------------------------------------------------------------------------
// 6. The voice
// ---------------------------------------------------------------------------

const NO_DAY_WORDS = /\byesterday\b|\btoday\b/i;

describe('composeMacroWhy', () => {
  const mixed = () =>
    decomposeRate(
      [
        comp('Juices', { curImpr: 300_000, curCpm: 14.2, baseImpr: 700_000, baseCpm: 14 }),
        comp('Meals', { curImpr: 700_000, curCpm: 24.1, baseImpr: 300_000, baseCpm: 20.3 }),
      ],
      CPM,
    );

  it('leads with the currency, names the components, and never says yesterday', () => {
    const why = composeMacroWhy(
      { kind: 'vital', vital: 'cpm', direction: 'up', componentLabel: 'category' },
      { rate: mixed(), rateMetric: 'cpm' },
      'GBP',
    )!;

    expect(why).not.toBeNull();
    expect(why.text).toContain('Meals');
    expect(why.text).toContain('Juices');
    expect(why.text).toMatch(/£\d/); // every rate is quoted as money
    expect(why.text).not.toMatch(NO_DAY_WORDS);
    expect(why.next).not.toMatch(NO_DAY_WORDS);
    expect(why.text.split('. ').length).toBeLessThanOrEqual(3);
    expect(why.next.length).toBeGreaterThan(0);
    expect((why.evidence.rate as Record<string, unknown>).metric).toBe('cpm');
  });

  it('says the remainder out loud when the named components do not carry it', () => {
    const spread = decomposeRate(
      [
        comp('A', { curImpr: 250_000, curCpm: 11, baseImpr: 250_000, baseCpm: 10 }),
        comp('B', { curImpr: 250_000, curCpm: 11, baseImpr: 250_000, baseCpm: 10 }),
        comp('C', { curImpr: 250_000, curCpm: 11, baseImpr: 250_000, baseCpm: 10 }),
        comp('D', { curImpr: 250_000, curCpm: 11, baseImpr: 250_000, baseCpm: 10 }),
      ],
      CPM,
    );
    const why = composeMacroWhy(
      { kind: 'vital', vital: 'cpm', direction: 'up', componentLabel: 'campaign' },
      { rate: spread, rateMetric: 'cpm' },
      'GBP',
    )!;
    expect(why.text).toMatch(/remaining 75% is spread across the other campaigns/);
  });

  it('renames components through categoryNames when the caller passes them', () => {
    const why = composeMacroWhy(
      { kind: 'vital', vital: 'cpm', direction: 'up', componentLabel: 'category' },
      { rate: mixed(), rateMetric: 'cpm' },
      'GBP',
      { Meals: 'Meal Plans', Juices: 'Juices & Cleanses' },
    )!;
    expect(why.text).toContain('Meal Plans');
    expect(why.text).not.toMatch(/toward Meals\b/);
  });

  it('proves overlap instead of shrugging when no single ad set is above the bar', () => {
    const carriers = frequencyCarriers([
      {
        key: 'a',
        name: 'UK | Broad | Juice',
        curImpressions: 600_000,
        curReach: 600_000 / 1.98,
        baseImpressions: 100_000,
        baseReach: 100_000 / 1.6,
      },
      {
        key: 'b',
        name: 'UK | LAL | Meals',
        curImpressions: 400_000,
        curReach: 400_000 / 1.4,
        baseImpressions: 0,
        baseReach: 0,
      },
    ]);
    const why = composeMacroWhy(
      { kind: 'vital', vital: 'frequency', direction: 'up', componentLabel: 'ad set' },
      { carriers, accountFrequency: { cur: 2.6, base: 1.69 } },
      'GBP',
    )!;

    expect(why.text).toContain('No single ad set is above 2.5');
    expect(why.text).toContain('UK | Broad | Juice');
    expect(why.text).toContain('2.60');
    expect(why.text).toMatch(/overlap/);
    expect(why.next).toMatch(/merging them or adding exclusions/);
    expect(why.text).not.toMatch(NO_DAY_WORDS);
  });

  it('says "away from" when the top mix contributor LOST share', () => {
    // A CPM fall driven by delivery leaving an expensive campaign. Calling
    // that "delivery moved toward Expensive" would state the opposite of what
    // happened — found on live accounts before this case existed.
    const d = decomposeRate(
      [
        comp('Expensive', { curImpr: 100_000, curCpm: 30, baseImpr: 300_000, baseCpm: 30 }),
        comp('Cheap', { curImpr: 900_000, curCpm: 10, baseImpr: 700_000, baseCpm: 10 }),
      ],
      CPM,
    );
    expect(d.mixPct).toBeCloseTo(1, 9);
    expect(d.topMix?.key).toBe('Expensive');

    const why = composeMacroWhy(
      { kind: 'vital', vital: 'cpm', direction: 'down', componentLabel: 'campaign' },
      { rate: d, rateMetric: 'cpm' },
      'GBP',
    )!;
    expect(why.text).toContain('away from Expensive (£30.00) at 30% → 10%');
    expect(why.text).toContain('offset by the move toward Cheap (£10.00) at 70% → 90%');
    expect(why.text).not.toContain('toward Expensive');
  });

  it('keeps the sign when a term pushed the other way, instead of rounding it away', () => {
    // within +126%, mix −26%. Printing both as bare magnitudes would read as
    // 126 + 26 = 152% of one move, and would hide which way the split pushed.
    const d = decomposeRate(
      [
        comp('A', { curImpr: 600_000, curCpm: 12, baseImpr: 500_000, baseCpm: 20 }),
        comp('B', { curImpr: 400_000, curCpm: 10, baseImpr: 500_000, baseCpm: 10 }),
      ],
      CPM,
    );
    expect(d.mixPct).toBeLessThan(0);
    expect(d.mixPct! + d.withinPct!).toBeCloseTo(1, 9);

    const why = composeMacroWhy(
      { kind: 'vital', vital: 'cpm', direction: 'down', componentLabel: 'campaign' },
      { rate: d, rateMetric: 'cpm' },
      'GBP',
    )!;
    expect(why.text).toMatch(/126% of the CPM fall is within-component: A itself went £20\.00 → £12\.00/);
    expect(why.text).toMatch(/campaign split worked against the CPM fall \(mix -26% of it\)/);
    // The residue is arithmetic, not a finding, once the terms offset that far.
    expect(why.text).not.toMatch(/spread across the other campaigns/);
  });

  it('says where the detail starts instead of decomposing against nothing', () => {
    const why = composeMacroWhy(
      { kind: 'vital', vital: 'cpm', direction: 'up', componentLabel: 'campaign' },
      { detailStartsAt: '2026-05-12' },
      'GBP',
    )!;
    expect(why.text).toContain('Component detail starts May 12');
    expect(why.text).toContain('account-level rows only');
    expect(why.evidence.detail_starts_at).toBe('2026-05-12');
  });

  it('returns null rather than an empty explanation', () => {
    expect(
      composeMacroWhy(
        { kind: 'vital', vital: 'cpm', direction: 'up', componentLabel: 'campaign' },
        {},
        'GBP',
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. Integration — rows in, the block's why out (no database anywhere)
// ---------------------------------------------------------------------------

describe('macroWhyFor', () => {
  /** A two-category account whose Meals share and Meals CPM both climbed. */
  function context(): MacroWhyContext {
    const campaignRows: CampaignDailyRow[] = [];
    const adsetRows: AdsetDailyRow[] = [];
    const adRows: AdDailyRow[] = [];

    const day = (date: string, cur: boolean): void => {
      const juiceImpr = cur ? 30_000 : 50_000;
      const mealImpr = cur ? 50_000 : 20_000;
      const juiceCpm = 14;
      const mealCpm = cur ? 24 : 20;
      campaignRows.push(
        campaignRow(date, 'c-juice', 'AOT // Juice cleanse // CBO', {
          spend: (juiceCpm * juiceImpr) / 1000,
          impressions: juiceImpr,
          reach: cur ? juiceImpr / 2.2 : juiceImpr / 1.4,
          clicks: Math.round(juiceImpr * 0.01),
        }),
      );
      campaignRows.push(
        campaignRow(date, 'c-meal', 'AOT // Meal prep', {
          spend: (mealCpm * mealImpr) / 1000,
          impressions: mealImpr,
          reach: mealImpr / 1.5,
          clicks: Math.round(mealImpr * 0.01),
        }),
      );
      adsetRows.push({
        date,
        adset_id: 'as-juice',
        adset_name: 'UK | Broad | Juice',
        impressions: juiceImpr,
        reach: cur ? juiceImpr / 3.1 : juiceImpr / 1.8,
      });
      adsetRows.push({
        date,
        adset_id: 'as-meal',
        adset_name: 'UK | LAL | Meals',
        impressions: mealImpr,
        reach: mealImpr / 1.5,
      });
      adRows.push(
        adRow({
          date,
          ad_id: 'ad-juice',
          ad_name: 'Hero cut',
          campaign_id: 'c-juice',
          adset_id: 'as-juice',
          spend: (juiceCpm * juiceImpr) / 1000,
        }),
      );
      adRows.push(
        adRow({
          date,
          ad_id: 'ad-meal',
          ad_name: 'Meal prep demo',
          campaign_id: 'c-meal',
          adset_id: 'as-meal',
          spend: (mealCpm * mealImpr) / 1000,
        }),
      );
    };

    for (let d = 0; d < 14; d += 1) day(addDays(BASELINE.start, d), false);
    for (let d = 0; d < 14; d += 1) day(addDays(CURRENT.start, d), true);

    return {
      adRows,
      campaignRows,
      adsetRows,
      category: PL_CONFIG,
      currentWindow: CURRENT,
      baselineWindow: BASELINE,
      currency: 'GBP',
      accountFrequency: { cur: 2.6, base: 1.7 },
      spendContext: { cur: 1620, base: 1100 },
    };
  }

  it('explains a CPM creep by named categories, mix and within', () => {
    const why = macroWhyFor({ kind: 'vital', vital: 'cpm', direction: 'up' }, context())!;
    expect(why).not.toBeNull();
    expect(why.text).toContain('Meal Plans'); // the config's display name
    expect(why.text).toMatch(/mix|within-component/);
    expect(why.text).toMatch(/£\d/);
    expect(why.text).not.toMatch(NO_DAY_WORDS);
    const rate = why.evidence.rate as Record<string, unknown>;
    expect((rate.mix_pct as number) + (rate.within_pct as number)).toBeCloseTo(1, 9);
    expect(rate.shape_changed).toBe(false);
  });

  it('names the real frequency carrier for the frequency line', () => {
    const why = macroWhyFor({ kind: 'vital', vital: 'frequency', direction: 'up' }, context())!;
    expect(why.text).toContain('UK | Broad | Juice');
    expect(why.text).toMatch(/3\.10 from 1\.80/);
    expect(why.next).toMatch(/widen or split|creative refresh/);
    const carriers = why.evidence.carriers as Record<string, unknown>;
    expect(carriers.count).toBe(1);
  });

  it('falls back to campaigns when the client has no category rules', () => {
    const ctx = { ...context(), category: null };
    const why = macroWhyFor({ kind: 'vital', vital: 'cpm', direction: 'up' }, ctx)!;
    expect(why.text).toContain('AOT // Meal prep');
    expect(why.evidence.component).toBe('campaign');
  });

  it('says the detail is missing rather than guessing when the baseline has none', () => {
    const ctx = context();
    const trimmed: MacroWhyContext = {
      ...ctx,
      campaignRows: ctx.campaignRows.filter((r) => r.date >= CURRENT.start),
      adRows: ctx.adRows.filter((r) => r.date >= CURRENT.start),
    };
    const why = macroWhyFor({ kind: 'vital', vital: 'cpm', direction: 'up' }, trimmed)!;
    expect(why.text).toContain('Component detail starts');
    expect(why.text).toContain('account-level rows only');
  });

  it('builds the same component keys the brief would, from campaign_daily', () => {
    const ctx = context();
    const set = buildComponentSet(ctx.campaignRows, CURRENT, BASELINE, 'category', PL_CONFIG);
    expect(set.entries.map((e) => e.key).sort()).toEqual(['juices_cleanses', 'meals']);
    expect(set.entries.find((e) => e.key === 'meals')!.name).toBe('Meal Plans');
    const adsets = buildAdsetWindows(ctx.adsetRows, CURRENT, BASELINE);
    expect(adsets.map((a) => a.name).sort()).toEqual(['UK | Broad | Juice', 'UK | LAL | Meals']);
  });
});

// ---------------------------------------------------------------------------
// 8. The rendered grammar — the why sits under its bullet
// ---------------------------------------------------------------------------

describe('attachMacroWhysSafely', () => {
  it('costs the reader nothing when the warehouse read blows up', async () => {
    // No Supabase configured in the test env: getSupabase() throws on the
    // first fetch. The pulse must survive that without losing a single line.
    const rendered: RenderedPulse = {
      header: 'Macro pulse:',
      items: [{ key: 'cpm', kind: 'vital', vital: 'cpm', line: 'CPM £19.72', level: 19.72 }],
      steady: null,
      lines: ['Macro pulse:', '• CPM £19.72'],
      currency: 'GBP',
    };
    const attached = await attachMacroWhysSafely({
      client: { id: 'client-uuid', code: 'PL' },
      reads: {
        asOf: '2026-08-09',
        currentWindow: { ...CURRENT, days: 14 },
        baselineWindow: { ...BASELINE, days: 14, fallback: false },
        baselineLabel: 'early May',
        spend: { level: 900, baseline: 800, pctVsBaseline: 0.125 },
        impressionsPerDay: 50_000,
        thin: false,
        vitals: [],
      },
      chords: [],
      rendered,
      currency: 'GBP',
    });

    expect(attached).toBe(0);
    expect(rendered.items[0]!.why).toBeUndefined();
    expect(pulseLines(rendered)).toEqual(['Macro pulse:', '• CPM £19.72']);
  });

  it('does not read anything at all when nothing is voiced', async () => {
    const rendered: RenderedPulse = {
      header: 'Macro pulse:',
      items: [],
      steady: { line: 'Everything else steady.', collapsed: 'Macro pulse: vitals steady.' },
      lines: ['Macro pulse: vitals steady.'],
      currency: 'GBP',
    };
    // A steady account must not pay for the extra read — this returns before
    // it ever touches getSupabase (which would throw in this environment).
    await expect(
      attachMacroWhysSafely({
        client: { id: 'client-uuid', code: 'PL' },
        reads: {
          asOf: '2026-08-09',
          currentWindow: { ...CURRENT, days: 14 },
          baselineWindow: { ...BASELINE, days: 14, fallback: false },
          baselineLabel: 'early May',
          spend: { level: 900, baseline: 800, pctVsBaseline: 0.125 },
          impressionsPerDay: 50_000,
          thin: false,
          vitals: [],
        },
        chords: [],
        rendered,
        currency: 'GBP',
      }),
    ).resolves.toBe(0);
  });
});

describe('pulseLines with a why attached', () => {
  it('indents why and next under the bullet, in the brief\'s movers grammar', () => {
    const rendered: RenderedPulse = {
      header: 'Macro pulse (14d vs early May, spend-context attached):',
      items: [
        {
          key: 'cpm',
          kind: 'vital',
          vital: 'cpm',
          line: 'CPM £19.72 — +32% vs early May (£14.96)',
          level: 19.72,
          why: { text: 'Meals carries it.', next: 'refresh Meals.', evidence: {} },
        },
        { key: 'ctr', kind: 'vital', vital: 'ctr', line: 'CTR 1.13%', level: 0.0113 },
      ],
      steady: null,
      lines: [],
      currency: 'GBP',
    };

    const lines = pulseLines(rendered);
    expect(lines).toEqual([
      'Macro pulse (14d vs early May, spend-context attached):',
      '• CPM £19.72 — +32% vs early May (£14.96)',
      '    ↳ why: Meals carries it.',
      '    ↳ next: refresh Meals.',
      '• CTR 1.13%',
    ]);
  });
});
