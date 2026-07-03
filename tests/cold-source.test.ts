import { describe, it, expect } from 'vitest';
import { buildColdRows, coldBreakeven, buildColdKnowledge, type RawAdDay } from '../src/audit/cold-source.js';

/**
 * The cold-path mapper turns a live Graph level=ad,time_increment=1 pull into
 * the exact shapes the fast tier consumes. These pin the field semantics that
 * make the R2 diff vs the synced warehouse apples-to-apples: hook_rate as a
 * FRACTION, omni_purchase-first money, ad→account aggregation, and windowing.
 */

const ASOF = '2026-07-03';
const day = (offset: number): string => {
  const d = new Date(`${ASOF}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
};

function adDay(over: Partial<RawAdDay> & { ad_id: string; date_start: string }): RawAdDay {
  return {
    ad_name: `ad-${over.ad_id}`,
    adset_id: `set-${over.ad_id}`,
    spend: '100',
    impressions: '10000',
    clicks: '200',
    frequency: '1.8',
    actions: [
      { action_type: 'omni_purchase', value: '5' },
      { action_type: 'link_click', value: '180' },
      { action_type: 'view_content', value: '400' },
      { action_type: 'add_to_cart', value: '60' },
      { action_type: 'initiate_checkout', value: '30' },
      { action_type: 'lead', value: '3' },
      { action_type: 'video_view', value: '2500' },
    ],
    action_values: [{ action_type: 'omni_purchase', value: '900' }],
    video_thruplay_watched_actions: [{ action_type: 'video_view', value: '1200' }],
    ...over,
  };
}

describe('buildColdRows — field semantics', () => {
  const rows = buildColdRows({ asOf: ASOF, adDays: [adDay({ ad_id: '1', date_start: day(1) })] });

  it('maps a PackAdRow with warehouse-faithful fields', () => {
    expect(rows.packRows90).toHaveLength(1);
    const r = rows.packRows90[0]!;
    expect(r.ad_id).toBe('1');
    expect(r.ad_name).toBe('ad-1');
    expect(r.adset_id).toBe('set-1');
    expect(r.spend).toBe(100);
    expect(r.impressions).toBe(10000);
    expect(r.purchases).toBe(5);        // omni_purchase count
    expect(r.purchase_value).toBe(900); // omni_purchase value
    expect(r.leads).toBe(3);
    expect(r.frequency).toBe(1.8);
    expect(r.results).toBe(0);          // matches warehouse (null/0)
  });

  it('computes hook_rate + hold_rate as FRACTIONS (as ad_daily stores them)', () => {
    const r = rows.packRows90[0]!;
    expect(r.hook_rate).toBeCloseTo(0.25, 5);  // 2500 / 10000
    expect(r.hold_rate).toBeCloseTo(0.12, 5);  // 1200 / 10000
  });

  it('falls back to bare `purchase` when omni_purchase is absent', () => {
    const r = buildColdRows({
      asOf: ASOF,
      adDays: [adDay({
        ad_id: '9', date_start: day(1),
        actions: [{ action_type: 'purchase', value: '4' }],
        action_values: [{ action_type: 'purchase', value: '400' }],
      })],
    }).packRows90[0]!;
    expect(r.purchases).toBe(4);
    expect(r.purchase_value).toBe(400);
  });

  it('leaves hook_rate null when there are no video views', () => {
    const r = buildColdRows({
      asOf: ASOF,
      adDays: [adDay({ ad_id: '2', date_start: day(1), actions: [{ action_type: 'link_click', value: '5' }], video_thruplay_watched_actions: [] })],
    }).packRows90[0]!;
    expect(r.hook_rate).toBeNull();
    expect(r.hold_rate).toBeNull();
  });
});

describe('buildColdRows — account aggregation', () => {
  it('aggregates ad-level to one account-daily row per date', () => {
    const d = day(1);
    const rows = buildColdRows({
      asOf: ASOF,
      adDays: [
        adDay({ ad_id: '1', date_start: d }),
        adDay({ ad_id: '2', date_start: d }),
      ],
    });
    expect(rows.packAccRows90).toHaveLength(1);
    const a = rows.packAccRows90[0]!;
    expect(a.spend).toBe(200);
    expect(a.impressions).toBe(20000);
    expect(a.link_clicks).toBe(360);
    expect(a.purchases).toBe(10);
    expect(a.purchase_value).toBe(1800);

    expect(rows.accFull30).toHaveLength(1);
    const f = rows.accFull30[0]!;
    expect(f.content_views).toBe(800);
    expect(f.add_to_carts).toBe(120);
    expect(f.checkouts_initiated).toBe(60);
    expect(f.leads).toBe(6);
  });
});

describe('buildColdRows — windowing', () => {
  const adDays = [
    adDay({ ad_id: 'a', date_start: day(10) }),   // in 30/90/180
    adDay({ ad_id: 'b', date_start: day(45) }),    // in 90/180 only
    adDay({ ad_id: 'c', date_start: day(150) }),   // in 180 only
  ];
  const rows = buildColdRows({ asOf: ASOF, adDays });

  it('scopes packRows90 to the last 90 days', () => {
    const ids = new Set(rows.packRows90.map((r) => r.ad_id));
    expect(ids).toEqual(new Set(['a', 'b']));
  });

  it('scopes packRows180 to the last 180 days', () => {
    const ids = new Set(rows.packRows180.map((r) => r.ad_id));
    expect(ids).toEqual(new Set(['a', 'b', 'c']));
  });

  it('scopes accFull30 + landing30 to the last 30 days', () => {
    expect(rows.accFull30).toHaveLength(1);
    expect(rows.landing30.map((l) => l.ad_id)).toEqual(['a']);
    expect(rows.daysCovered).toBe(1);
  });
});

describe('buildColdRows — landing destinations', () => {
  it('attaches resolved destinations and aggregates 30d ad spend', () => {
    const d1 = day(2);
    const d2 = day(3);
    const rows = buildColdRows({
      asOf: ASOF,
      adDays: [
        adDay({ ad_id: '1', date_start: d1 }),
        adDay({ ad_id: '1', date_start: d2 }),
      ],
      destinations: { '1': { market: 'de', path: '/lp/gin' } },
    });
    expect(rows.landing30).toHaveLength(1);
    const l = rows.landing30[0]!;
    expect(l.spend).toBe(200);
    expect(l.purchases).toBe(10);
    expect(l.landing_page_market).toBe('de');
    expect(l.landing_page_path).toBe('/lp/gin');
  });

  it('leaves landing paths null when no destination is resolved', () => {
    const rows = buildColdRows({ asOf: ASOF, adDays: [adDay({ ad_id: '1', date_start: day(1) })] });
    expect(rows.landing30[0]!.landing_page_path).toBeNull();
  });
});

describe('buildColdRows — edge cases', () => {
  it('drops rows with no ad_id or no date', () => {
    const rows = buildColdRows({
      asOf: ASOF,
      adDays: [
        { ad_id: '', date_start: day(1) } as RawAdDay,
        { ad_id: '1' } as RawAdDay,
        adDay({ ad_id: '2', date_start: day(1) }),
      ],
    });
    expect(rows.rowCount).toBe(1);
    expect(rows.packRows90).toHaveLength(1);
  });

  it('returns empty structures for an empty pull', () => {
    const rows = buildColdRows({ asOf: ASOF, adDays: [] });
    expect(rows.packRows90).toEqual([]);
    expect(rows.packAccRows90).toEqual([]);
    expect(rows.accFull30).toEqual([]);
    expect(rows.landing30).toEqual([]);
    expect(rows.rowCount).toBe(0);
    expect(rows.daysCovered).toBe(0);
  });
});

describe('coldBreakeven (stated-margin re-basing, 2026-07-04)', () => {
  it('45% margin → 2.22× breakeven ROAS (1 ÷ margin, 2dp)', () => {
    expect(coldBreakeven(45)).toEqual({ grossMarginPct: 45, breakevenRoas: 2.22 });
    expect(coldBreakeven(50)).toEqual({ grossMarginPct: 50, breakevenRoas: 2 });
    expect(coldBreakeven(80)).toEqual({ grossMarginPct: 80, breakevenRoas: 1.25 });
  });

  it('missing or invalid margins fall back to the honest 1.0× default', () => {
    for (const bad of [null, undefined, 0, -5, 100, 150, NaN]) {
      expect(coldBreakeven(bad as number | null | undefined)).toEqual({ grossMarginPct: null, breakevenRoas: 1.0 });
    }
  });
});

describe('buildColdKnowledge (attribution contract — founder-sim debt #1)', () => {
  it('a stated target is ALWAYS the owner\'s, with an in-text attribution instruction', () => {
    const k = buildColdKnowledge({ goalMetric: 'cpa', goalValue: 30, grossMarginPct: null, breakevenRoas: 1.0 });
    expect(k).toContain('The account owner set this target themselves at signup: CPA of 30.');
    expect(k).toContain('ALWAYS attribute it in-text');
    expect(k).toContain('the CPA 30 target you set when you connected');
    expect(k).toContain('never present it as our estimate, a Meta value, or an industry number');
    // margin NOT stated → the model must not invent one
    expect(k).toContain('No gross margin was given — never invent or imply a margin or breakeven figure.');
  });

  it('a stated margin carries the derived breakeven with the same attribution rule', () => {
    const k = buildColdKnowledge({ goalMetric: 'cpa', goalValue: 30, grossMarginPct: 45, breakevenRoas: 2.22 });
    expect(k).toContain('gross margin at signup: 45%');
    expect(k).toContain('true breakeven at 2.22x ROAS');
    expect(k).toContain('at your stated 45% margin');
    expect(k).not.toContain('No gross margin was given');
  });

  it('margin without a target: attribution for the margin, never-invent for the target', () => {
    const k = buildColdKnowledge({ goalMetric: null, goalValue: null, grossMarginPct: 45, breakevenRoas: 2.22 });
    expect(k).toContain('at your stated 45% margin');
    expect(k).toContain('No performance target was given — never invent or imply one');
  });

  it('NEITHER stated: never invent a target, margin, or breakeven — anchor to observed figures', () => {
    const k = buildColdKnowledge({ goalMetric: null, goalValue: null, grossMarginPct: null, breakevenRoas: 1.0 });
    expect(k).toContain('NEVER invent, assume, or imply one');
    expect(k).toContain("account's own observed figures");
    expect(k).toContain('no target has been set yet');
    expect(k).not.toContain('stated');
  });

  it('every variant keeps the first-time-audit framing', () => {
    for (const args of [
      { goalMetric: 'roas', goalValue: 3, grossMarginPct: 45, breakevenRoas: 2.22 },
      { goalMetric: null, goalValue: null, grossMarginPct: null, breakevenRoas: 1.0 },
    ]) {
      expect(buildColdKnowledge(args)).toContain('first-time audit of a freshly connected account');
    }
  });
});
