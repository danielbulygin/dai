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
