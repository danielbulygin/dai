/**
 * Loop 1 regression cases — the two proofs from the 2026-08-06 build night,
 * encoded (design: tinkers docs/factory/day-2026-08-06/loop1-detection-design.md).
 *
 * 1. The honesty gate: a day is only quoted if its row was fetched AFTER the
 *    account-local day closed; absence of data is a verification gap, never
 *    a delivery claim. (Live proof: seeded "tomorrow morning, no sync" run
 *    refused to quote and fell back per account — BFM→Aug 4, PL→Aug 5.)
 * 2. The movers detector: materiality → surprise → persistence. (Live proof:
 *    warehouse numbers hand-checked against Meta Graph API — PL 2026-08-05
 *    exact match, BFM 2026-08-04 within 2 cents on $9.8k.)
 */

import { describe, expect, it } from 'vitest';
import {
  accountYesterday,
  detectMovers,
  gateYesterday,
} from '../src/monitoring/agency-morning-brief.js';
import {
  composeWhy,
  type AdDayWhy,
  type WhyContext,
} from '../src/monitoring/why-clause.js';

const NY = 'America/New_York';

function day(date: string, spend: number, fetched_at: string | null) {
  return {
    date,
    spend,
    purchases: 0,
    purchase_value: null,
    roas: null,
    results: null,
    cost_per_result: null,
    leads: null,
    fetched_at,
  };
}

describe('accountYesterday — the account-local day, never the server day', () => {
  it('NY yesterday is two calendar days back while NY is still on the prior date', () => {
    // 03:00 UTC Aug 6 = 23:00 Aug 5 in New York → NY "yesterday" is Aug 4.
    expect(accountYesterday(NY, new Date('2026-08-06T03:00:00Z'))).toBe('2026-08-04');
    // 06:10 UTC Aug 6 = 02:10 Aug 6 in New York → NY "yesterday" is Aug 5.
    expect(accountYesterday(NY, new Date('2026-08-06T06:10:00Z'))).toBe('2026-08-05');
  });
  it('London and Berlin roll over at their own midnights', () => {
    expect(accountYesterday('Europe/London', new Date('2026-08-06T03:00:00Z'))).toBe('2026-08-05');
    expect(accountYesterday('Europe/Berlin', new Date('2026-08-05T22:30:00Z'))).toBe('2026-08-05');
  });
});

describe('gateYesterday — the honesty gate', () => {
  it('verifies a row fetched after the account-local day closed', () => {
    const rows = [day('2026-08-05', 891.33, '2026-08-06T02:10:00Z')];
    expect(gateYesterday(rows, '2026-08-05', 'Europe/London')).toBe('verified');
  });
  it('refuses a row frozen mid-day (the PL 10:59 freeze)', () => {
    const rows = [day('2026-08-05', 891.33, '2026-08-05T10:59:00Z')];
    expect(gateYesterday(rows, '2026-08-05', 'Europe/London')).toBe('unverified');
  });
  it('timezone matters: 02:10 UTC Aug 6 is still Aug 5 in New York', () => {
    const rows = [day('2026-08-05', 8368, '2026-08-06T02:10:00Z')];
    // For a London account that fetch closes the day; for NY it does not.
    expect(gateYesterday(rows, '2026-08-05', 'Europe/London')).toBe('verified');
    expect(gateYesterday(rows, '2026-08-05', NY)).toBe('unverified');
  });
  it('missing yesterday row on an account with recent spend → unverified', () => {
    const rows = [day('2026-08-03', 500, '2026-08-04T02:00:00Z')];
    expect(gateYesterday(rows, '2026-08-05', 'Europe/London')).toBe('unverified');
  });
  it('zero-spend ROWS are dormancy evidence; NO rows are a verification gap', () => {
    const zeroRows = [day('2026-07-27', 0, '2026-07-28T00:06:00Z')];
    expect(gateYesterday(zeroRows, '2026-08-05', 'Europe/Berlin')).toBe('dormant');
    expect(gateYesterday([], '2026-08-05', 'Europe/Berlin')).toBe('unverified');
  });
});

describe('detectMovers — materiality → surprise → persistence', () => {
  const Y = '2026-08-05';
  function adRows(
    adId: string,
    dailySpend: number[],
    dailyPurchases: number[],
    yesterdaySpend: number,
    yesterdayPurchases: number,
  ) {
    const rows = dailySpend.map((spend, i) => ({
      date: `2026-07-${String(28 + i).padStart(2, '0')}`,
      ad_id: adId,
      ad_name: adId,
      campaign_id: 'c1',
      spend,
      purchases: dailyPurchases[i] ?? 0,
      results: null,
    }));
    rows.push({
      date: Y,
      ad_id: adId,
      ad_name: adId,
      campaign_id: 'c1',
      spend: yesterdaySpend,
      purchases: yesterdayPurchases,
      results: null,
    });
    return rows;
  }

  it('immaterial ads never move, whatever their percentages', () => {
    // $6/day ad quadruples its CPA on a $1000/day account — not a mover.
    const ads = adRows('tiny', [6, 6, 6, 6], [2, 2, 2, 2], 6, 0);
    expect(detectMovers(ads, Y, 1000, 1000, 'USD')).toHaveLength(0);
  });

  it('money out, nothing back — on an ad that usually converts', () => {
    const ads = adRows('big', [300, 300, 300, 300], [10, 9, 11, 10], 320, 0);
    const movers = detectMovers(ads, Y, 1000, 1000, 'USD');
    expect(movers).toHaveLength(1);
    expect(movers[0]!.kind).toBe('zero_results_on_spend');
  });

  it('a stable ad with a stable CPA is not news', () => {
    const ads = adRows('steady', [300, 310, 290, 305], [10, 10, 10, 10], 300, 10);
    expect(detectMovers(ads, Y, 1000, 1000, 'USD')).toHaveLength(0);
  });

  it("a material CPA jump beyond the ad's own variation is news", () => {
    const ads = adRows('jumper', [300, 300, 300, 300], [10, 10, 10, 10], 300, 4);
    const movers = detectMovers(ads, Y, 1000, 1000, 'USD');
    expect(movers).toHaveLength(1);
    expect(movers[0]!.kind).toBe('cpa_shift');
  });

  it("new ads (<3 spending days) belong to What's-New, never to movers", () => {
    const ads = [
      { date: '2026-08-04', ad_id: 'new1', ad_name: 'new1', campaign_id: 'c1', spend: 200, purchases: 0, results: null },
      { date: Y, ad_id: 'new1', ad_name: 'new1', campaign_id: 'c1', spend: 400, purchases: 0, results: null },
    ];
    expect(detectMovers(ads, Y, 1000, 1000, 'USD')).toHaveLength(0);
  });

  it('caps at 3, ranked by money at stake × surprise', () => {
    let ads: ReturnType<typeof adRows> = [];
    for (const [id, y] of [
      ['a', 350],
      ['b', 300],
      ['c', 250],
      ['d', 200],
    ] as const) {
      ads = ads.concat(adRows(id, [300, 300, 300, 300], [10, 10, 10, 10], y, 0));
    }
    const movers = detectMovers(ads, Y, 1200, 1200, 'USD');
    expect(movers).toHaveLength(3);
    expect(movers[0]!.adId).toBe('a');
  });
});

// ---------------------------------------------------------------------------
// The why-clause — one test per diagnosis signature (spec:
// tinkers docs/factory/day-2026-08-07/why-clause-design.md)
// ---------------------------------------------------------------------------

describe('composeWhy — cause signatures', () => {
  const Y = '2026-08-06';
  const TRAILING = ['2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05'];

  interface DaySpec {
    spend: number;
    imp: number;
    clicks: number;
    hook: number;
    purch: number;
  }

  function mkRows(adId: string, trailing: DaySpec, yday: DaySpec): AdDayWhy[] {
    const row = (date: string, s: DaySpec): AdDayWhy => ({
      date,
      ad_id: adId,
      ad_name: adId,
      adset_id: 's1',
      campaign_id: 'c1',
      spend: s.spend,
      impressions: s.imp,
      link_clicks: s.clicks,
      hook_rate: s.hook,
      frequency: 1.5,
      content_views: 0,
      purchases: s.purch,
    });
    return [...TRAILING.map((d) => row(d, trailing)), row(Y, yday)];
  }

  function ctx(
    adRows: AdDayWhy[],
    over: Partial<WhyContext> = {},
  ): WhyContext {
    return {
      moverKind: 'cpa_shift',
      direction: 'bad',
      adRows,
      peerRows: adRows,
      yesterday: Y,
      changes: [],
      mixShifts: [],
      dayLabel: (d) => d,
      ...over,
    };
  }

  const steady: DaySpec = { spend: 1200, imp: 40000, clicks: 500, hook: 0.25, purch: 40 };

  it('bad traffic: conversion fell while delivery got cheaper and broader', () => {
    const why = composeWhy(
      ctx(mkRows('a1', steady, { spend: 1200, imp: 80000, clicks: 700, hook: 0.24, purch: 25 })),
    );
    expect(why.causeClass).toBe('bad_traffic');
    expect(why.text).toContain('worse');
  });

  it('creative response: hook fell, cost side flat', () => {
    const why = composeWhy(
      ctx(mkRows('a1', steady, { spend: 1200, imp: 40000, clicks: 360, hook: 0.15, purch: 29 })),
    );
    expect(why.causeClass).toBe('creative_response');
  });

  it('auction inflation: every rate flat, CPM up', () => {
    const why = composeWhy(
      ctx(mkRows('a1', steady, { spend: 1700, imp: 40000, clicks: 500, hook: 0.25, purch: 40 })),
    );
    expect(why.causeClass).toBe('auction_inflation');
    expect(why.next).toContain('hold');
  });

  it('flat everything: says unclear, never invents', () => {
    const why = composeWhy(
      ctx(mkRows('a1', steady, { spend: 1250, imp: 41000, clicks: 505, hook: 0.25, purch: 38 })),
    );
    expect(why.causeClass).toBe('unclear');
    expect(why.text).toContain('cause unclear');
  });

  it('measurement suspect: conversions collapsed on this ad AND the rest of the account', () => {
    const mine = mkRows('a1', steady, { spend: 1200, imp: 40000, clicks: 520, hook: 0.25, purch: 0 });
    const peer = mkRows('b2', steady, { spend: 1200, imp: 40000, clicks: 500, hook: 0.25, purch: 10 });
    const why = composeWhy(
      ctx(mine, { moverKind: 'zero_results_on_spend', peerRows: [...mine, ...peer] }),
    );
    expect(why.causeClass).toBe('measurement_suspect');
    expect(why.next).toContain('Events Manager');
  });

  it('wins get interrogated too: improvement names its mechanism', () => {
    const why = composeWhy(
      ctx(mkRows('a1', steady, { spend: 1200, imp: 40000, clicks: 700, hook: 0.38, purch: 60 }), {
        direction: 'good',
      }),
    );
    expect(why.causeClass).toBe('improved');
    expect(why.text).toContain('hook');
  });

  it('delivery shift: names the sibling the spend came from', () => {
    const mine = mkRows('a1', steady, { spend: 2400, imp: 80000, clicks: 1000, hook: 0.25, purch: 80 });
    const sibling = mkRows('b2', { spend: 1200, imp: 40000, clicks: 500, hook: 0.2, purch: 30 }, { spend: 100, imp: 3500, clicks: 40, hook: 0.2, purch: 3 });
    const why = composeWhy(
      ctx(mine, { moverKind: 'spend_share_shift', peerRows: [...mine, ...sibling] }),
    );
    expect(why.causeClass).toBe('delivery_shift');
    expect(why.text).toContain('b2');
  });
});
