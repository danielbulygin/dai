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

import { describe, expect, it, vi } from 'vitest';

// detectNewAds confirms each candidate against FULL history with one existence
// probe per ad. The warehouse is stubbed to "no older spend", which is the
// interesting case: everything else is pure.
const probe = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('../src/integrations/supabase.js', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'select', 'eq', 'lt', 'gt', 'gte', 'lte', 'in', 'or', 'order', 'range', 'limit', 'maybeSingle']) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: probe.rows });
  return { getSupabase: () => chain };
});

import {
  accountYesterday,
  composeWindowLine,
  detectMovers,
  detectNewAds,
  gateWindow,
  gateYesterday,
  reportingWindow,
  unverifiedDaysLine,
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

// ---------------------------------------------------------------------------
// The reporting WINDOW — the weekend gap (2026-08-08)
//
// Mon–Fri cron + one "yesterday" = Friday and Saturday account-days are never
// reported. Monday's brief therefore covers Fri+Sat+Sun as one rollup, and the
// weekday that decides it is the ACCOUNT's, not the server's.
// ---------------------------------------------------------------------------

const LA = 'America/Los_Angeles';
const BERLIN = 'Europe/Berlin';
// 2026-08-10 is a Monday; Aug 7/8/9 are Fri/Sat/Sun. 06:10 UTC = the real
// 08:10 Berlin cron in summer.
const MONDAY_CRON = new Date('2026-08-10T06:10:00Z');

describe('reportingWindow — Monday rolls the weekend up, every other day is one day', () => {
  it('a Monday account gets its three prior local days, oldest first', () => {
    expect(reportingWindow(BERLIN, MONDAY_CRON)).toEqual([
      '2026-08-07',
      '2026-08-08',
      '2026-08-09',
    ]);
  });

  it('every other morning is the single day it always was', () => {
    // Tuesday → Monday. Friday → Thursday. Same answer as accountYesterday.
    for (const iso of ['2026-08-11T06:10:00Z', '2026-08-14T06:10:00Z']) {
      const now = new Date(iso);
      expect(reportingWindow(BERLIN, now)).toEqual([accountYesterday(BERLIN, now)]);
    }
  });

  it('New York is already on Monday at the Berlin cron, so BFM rolls up with everyone else', () => {
    // 06:10 UTC Aug 10 = 02:10 Aug 10 in New York — Monday, not Sunday.
    expect(accountYesterday(NY, MONDAY_CRON)).toBe('2026-08-09');
    expect(reportingWindow(NY, MONDAY_CRON)).toEqual([
      '2026-08-07',
      '2026-08-08',
      '2026-08-09',
    ]);
  });

  it('an account still on Sunday gets its single Saturday, and its rollup the NEXT morning', () => {
    // 06:10 UTC Aug 10 = 23:10 Sun Aug 9 in Los Angeles. Its calendar has not
    // reached Monday, so there is no weekend to roll up yet — that is the
    // whole point of judging the weekday in the ACCOUNT's timezone.
    expect(reportingWindow(LA, MONDAY_CRON)).toEqual(['2026-08-08']);
    // One Berlin morning later it IS Monday in LA, and the rollup lands.
    expect(reportingWindow(LA, new Date('2026-08-11T06:10:00Z'))).toEqual([
      '2026-08-07',
      '2026-08-08',
      '2026-08-09',
    ]);
  });

  it('the rollup is calendar arithmetic, so a DST weekend still spans Fri–Sun', () => {
    // Europe sprang forward on Sun 2026-03-29 — that local day was 23h long.
    expect(reportingWindow(BERLIN, new Date('2026-03-30T06:10:00Z'))).toEqual([
      '2026-03-27',
      '2026-03-28',
      '2026-03-29',
    ]);
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

describe('gateWindow — a rollup reports what it can verify and names what it cannot', () => {
  const WEEKEND = ['2026-08-07', '2026-08-08', '2026-08-09'];
  const LDN = 'Europe/London';

  it('all three days verified → the whole weekend is fact', () => {
    const rows = [
      day('2026-08-07', 8100, '2026-08-08T02:10:00Z'),
      day('2026-08-08', 7900, '2026-08-09T02:10:00Z'),
      day('2026-08-09', 7400, '2026-08-10T02:10:00Z'),
    ];
    const gate = gateWindow(rows, WEEKEND, LDN);
    expect(gate.status).toBe('verified');
    expect(gate.verified).toEqual(WEEKEND);
    expect(gate.unverified).toEqual([]);
    expect(gate.reportingDay).toBe('2026-08-09');
  });

  it('Sunday frozen mid-day → Fri+Sat reported, Sunday named, as-of falls back to Saturday', () => {
    const rows = [
      day('2026-08-07', 8100, '2026-08-08T02:10:00Z'),
      day('2026-08-08', 7900, '2026-08-09T02:10:00Z'),
      day('2026-08-09', 7400, '2026-08-09T10:59:00Z'), // the PL freeze, on Sunday
    ];
    const gate = gateWindow(rows, WEEKEND, LDN);
    expect(gate.status).toBe('verified');
    expect(gate.verified).toEqual(['2026-08-07', '2026-08-08']);
    expect(gate.unverified).toEqual(['2026-08-09']);
    expect(gate.reportingDay).toBe('2026-08-08');
    expect(unverifiedDaysLine(gate.unverified)).toBe(
      '⚠️ Sun, Aug 9 could not be verified — data sync incomplete.',
    );
  });

  it('a verified ZERO-spend day is a fact inside the rollup, not a gap', () => {
    const rows = [
      day('2026-08-07', 8100, '2026-08-08T02:10:00Z'),
      day('2026-08-08', 0, '2026-08-09T02:10:00Z'),
      day('2026-08-09', 7400, '2026-08-10T02:10:00Z'),
    ];
    expect(gateWindow(rows, WEEKEND, LDN).verified).toEqual(WEEKEND);
  });

  it('nothing verifiable falls back to the paths that already existed', () => {
    const stale = [day('2026-08-07', 8100, '2026-08-07T10:59:00Z')];
    expect(gateWindow(stale, WEEKEND, LDN).status).toBe('unverified');
    const dormant = [day('2026-07-27', 0, '2026-07-28T00:06:00Z')];
    expect(gateWindow(dormant, WEEKEND, LDN).status).toBe('dormant');
    // With nothing verified the as-of day is the window's last day.
    expect(gateWindow(stale, WEEKEND, LDN).reportingDay).toBe('2026-08-09');
  });

  it('a single-day window is exactly gateYesterday', () => {
    const rows = [day('2026-08-05', 891.33, '2026-08-06T02:10:00Z')];
    const gate = gateWindow(rows, ['2026-08-05'], LDN);
    expect(gate.status).toBe(gateYesterday(rows, '2026-08-05', LDN));
    expect(gate.verified).toEqual(['2026-08-05']);
    expect(gate.reportingDay).toBe('2026-08-05');
    expect(unverifiedDaysLine(gate.unverified)).toBeNull();
  });

  it('several unverified days are all named, never summarised away', () => {
    expect(unverifiedDaysLine(['2026-08-08', '2026-08-09'])).toBe(
      '⚠️ Sat, Aug 8 and Sun, Aug 9 could not be verified — data sync incomplete.',
    );
  });
});

describe('composeWindowLine — the weekend rollup headline', () => {
  function acct(
    date: string,
    spend: number,
    purchases: number,
    purchase_value: number | null = null,
  ) {
    return {
      date,
      spend,
      purchases,
      purchase_value,
      roas: null,
      results: null,
      cost_per_result: null,
      leads: null,
      fetched_at: `${date}T23:59:00Z`,
    };
  }

  const weekend = [
    acct('2026-08-07', 8100, 200, 14000),
    acct('2026-08-08', 7900, 160, 13000),
    acct('2026-08-09', 7400, 152, 13014),
  ];

  it('totals with meaning, named days, and a per-day tail nobody can hide behind', () => {
    const line = composeWindowLine(weekend, weekend, 'USD', null, { targets: { cpa: 40 } });
    // $23,400 over 512 purchases = $45.70, 14% over the $40 target.
    expect(line).toContain('Weekend Fri, Aug 7 – Sun, Aug 9: $23,400 spent');
    expect(line).toContain('512 purchases');
    expect(line).toContain('$45.70 CPA — 14% over your $40.00 target');
    expect(line).toContain('ROAS 1.71');
    expect(line).toContain('(Fri $8.1k/$40.50 · Sat $7.9k/$49.38 · Sun $7.4k/$48.68)');
  });

  it('never says yesterday or today, and never leaves a day unnamed', () => {
    const line = composeWindowLine(weekend, weekend, 'USD', null, null);
    expect(line.toLowerCase()).not.toContain('yesterday');
    expect(line.toLowerCase()).not.toContain('today');
    for (const wd of ['Fri', 'Sat', 'Sun']) expect(line).toContain(wd);
  });

  it('the band → target → absence precedence is the single-day precedence', () => {
    const banded = composeWindowLine(weekend, weekend, 'USD', { happy: 30, nervous: 44, kill: 60 }, {
      targets: { cpa: 40 },
    });
    // Bands win over the config target: $45.70 sits in the nervous band.
    expect(banded).toContain('in your nervous band ($44–$60)');
    const naked = composeWindowLine(weekend, weekend, 'USD', null, null);
    expect(naked).toContain('no target on file — goal-bands slot open');
  });

  it('a verified zero-spend day stays in the tail as a fact', () => {
    const withDark = [weekend[0]!, acct('2026-08-08', 0, 0), weekend[2]!];
    expect(composeWindowLine(withDark, withDark, 'USD', null, null)).toContain('Sat no delivery');
  });

  it('a thin day says how thin instead of pricing it', () => {
    const thin = [weekend[0]!, acct('2026-08-08', 120, 1), weekend[2]!];
    expect(composeWindowLine(thin, thin, 'USD', null, null)).toContain('Sat $120/1 purchase');
  });

  it('the trailing context is measured BEFORE the window, per day', () => {
    const before = [
      acct('2026-08-03', 7000, 175),
      acct('2026-08-04', 7000, 175),
      acct('2026-08-05', 7000, 175),
      acct('2026-08-06', 7000, 175),
    ];
    const line = composeWindowLine(weekend, [...before, ...weekend], 'USD', null, null);
    expect(line).toContain('7d avg spend $7,000/day');
    expect(line).toContain('7d CPA $40.00');
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
// The pooled window — movers and first-spend across Fri+Sat+Sun
// ---------------------------------------------------------------------------

describe('detectMovers over a weekend window — pooled, and scaled where money is', () => {
  const WEEKEND = ['2026-08-07', '2026-08-08', '2026-08-09'];
  const TRAILING = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06'];

  function row(date: string, adId: string, spend: number, purchases: number) {
    return {
      date,
      ad_id: adId,
      ad_name: adId,
      adset_id: 's1',
      campaign_id: 'c1',
      spend,
      purchases,
      results: null,
    };
  }
  /** $300/day, 10 purchases/day before the window — a $30 CPA workhorse. */
  function trailing(adId: string, spend = 300, purchases = 10) {
    return TRAILING.map((d) => row(d, adId, spend, purchases));
  }

  it('pools the window CPA against the trailing week and names the span', () => {
    // $900 over Fri–Sun on 12 purchases = $75 vs the $30 it usually costs.
    const ads = [
      ...trailing('workhorse'),
      row('2026-08-07', 'workhorse', 300, 4),
      row('2026-08-08', 'workhorse', 300, 4),
      row('2026-08-09', 'workhorse', 300, 4),
    ];
    const movers = detectMovers(ads, WEEKEND, 3000, 1000, 'USD');
    expect(movers).toHaveLength(1);
    expect(movers[0]!.kind).toBe('cpa_shift');
    expect(movers[0]!.line).toBe(
      '"workhorse" — CPA $75.00 over Fri–Sun vs $30.00 usual (up 150%), on $900',
    );
    // The ledger's yesterday_spend is read back against a SINGLE day next
    // morning, so it stays per-day; the pooled total travels beside it.
    expect(movers[0]!.evidence.yesterday_spend).toBe(300);
    expect(movers[0]!.evidence.window_spend).toBe(900);
    expect(movers[0]!.evidence.window_days).toBe(3);
    expect(movers[0]!.evidence.window).toEqual(WEEKEND);
  });

  it('the materiality floor is the window TOTAL, not one day of it', () => {
    const ads = [
      ...trailing('smallish', 40, 3),
      row('2026-08-07', 'smallish', 40, 0),
      row('2026-08-08', 'smallish', 40, 0),
      row('2026-08-09', 'smallish', 40, 0),
    ];
    // $120 pooled is 4% of a $3,000 weekend — under the 5% floor, so silence.
    expect(detectMovers(ads, WEEKEND, 3000, 1000, 'USD')).toHaveLength(0);
    // The same $120 is 12% of a $1,000 weekend, and that is worth a line.
    const movers = detectMovers(ads, WEEKEND, 1000, 300, 'USD');
    expect(movers).toHaveLength(1);
    expect(movers[0]!.kind).toBe('zero_results_on_spend');
    expect(movers[0]!.line).toBe(
      '"smallish" — $120 spent over Fri–Sun, 0 purchases (usually ~3.0/day)',
    );
  });

  it('a pooled spend is compared against the usual DAY times the window length', () => {
    // Usually $300/day (30% of a $1,000 day); over the weekend $1,500 of a
    // $3,000 window (50%). The comparison figure must be 3 × $300, not $300.
    const ads = [
      ...trailing('grabber'),
      row('2026-08-07', 'grabber', 500, 17),
      row('2026-08-08', 'grabber', 500, 17),
      row('2026-08-09', 'grabber', 500, 16),
    ];
    const movers = detectMovers(ads, WEEKEND, 3000, 1000, 'USD');
    expect(movers).toHaveLength(1);
    expect(movers[0]!.kind).toBe('spend_share_shift');
    expect(movers[0]!.line).toBe(
      '"grabber" — $1,500 over Fri–Sun vs $900 usual (share of account 30% → 50%)',
    );
  });

  it('trailing history stops at the window edge — a weekend is never its own baseline', () => {
    // Only Fri/Sat/Sun rows exist: no history BEFORE the window, so this is a
    // launch for What's-New, not a mover, however much it spent.
    const ads = [
      row('2026-08-07', 'fresh', 400, 0),
      row('2026-08-08', 'fresh', 400, 0),
      row('2026-08-09', 'fresh', 400, 0),
    ];
    expect(detectMovers(ads, WEEKEND, 1200, 400, 'USD')).toHaveLength(0);
  });

  it('a single-day window given as an array is the single-day detector, unchanged', () => {
    const ads = [...trailing('workhorse'), row('2026-08-09', 'workhorse', 300, 4)];
    const asArray = detectMovers(ads, ['2026-08-09'], 1000, 1000, 'USD');
    const asString = detectMovers(ads, '2026-08-09', 1000, 1000, 'USD');
    expect(asArray).toEqual(asString);
    expect(asArray[0]!.line).toBe(
      '"workhorse" — CPA $75.00 vs $30.00 usual (up 150%), on $300',
    );
  });
});

describe("detectNewAds over a weekend window — the Saturday launch that used to vanish", () => {
  const WEEKEND = ['2026-08-07', '2026-08-08', '2026-08-09'];
  function row(date: string, adId: string, spend: number, purchases: number) {
    return { date, ad_id: adId, ad_name: adId, adset_id: 's1', campaign_id: 'c1', spend, purchases, results: null };
  }
  const ads = [
    row('2026-08-05', 'veteran', 500, 12),
    row('2026-08-07', 'veteran', 500, 12),
    row('2026-08-08', 'veteran', 500, 12),
    row('2026-08-09', 'veteran', 500, 12),
    row('2026-08-08', 'sat-launch', 120, 1), // first spend: Saturday
    row('2026-08-09', 'sat-launch', 180, 3),
  ];

  it('announces the launch with its TRUE first day and pools what it has done since', async () => {
    const fresh = await detectNewAds('client-1', ads, WEEKEND);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({
      adId: 'sat-launch',
      firstSpendDate: '2026-08-08',
      spend: 300,
      results: 4,
    });
  });

  it('this is the bug: pointed at Sunday alone, a Saturday launch is already "seen before"', async () => {
    expect(await detectNewAds('client-1', ads, '2026-08-09')).toHaveLength(0);
  });

  it('an ad that was already spending before the window is not new', async () => {
    const fresh = await detectNewAds('client-1', ads, WEEKEND);
    expect(fresh.map((f) => f.adId)).not.toContain('veteran');
  });

  it('a single-day window still reports that day as the first spend', async () => {
    const fresh = await detectNewAds('client-1', ads, '2026-08-08');
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ adId: 'sat-launch', firstSpendDate: '2026-08-08', spend: 120 });
  });

  // The partly verified rollup: Friday failed the honesty gate, so the VERIFIED
  // window starts Saturday — but a launch that first spent on that unverified
  // Friday must not be disqualified by its own missing day.
  describe('an unverified Friday under the seen-before boundary', () => {
    const VERIFIED = ['2026-08-08', '2026-08-09'];
    const FRIDAY = '2026-08-07';
    const withFridayLaunch = [
      ...ads,
      row(FRIDAY, 'fri-launch', 90, 0),
      row('2026-08-08', 'fri-launch', 140, 2),
      row('2026-08-09', 'fri-launch', 160, 2),
    ];

    it('this is the bug: with no boundary, the unverified Friday makes its own launch "seen before"', async () => {
      const fresh = await detectNewAds('client-1', withFridayLaunch, VERIFIED);
      expect(fresh.map((f) => f.adId)).not.toContain('fri-launch');
    });

    it('the boundary keeps the launch, names its TRUE Friday, and quotes only verified spend', async () => {
      const fresh = await detectNewAds('client-1', withFridayLaunch, VERIFIED, FRIDAY);
      const launch = fresh.find((f) => f.adId === 'fri-launch');
      expect(launch).toMatchObject({ firstSpendDate: FRIDAY, spend: 300, results: 4 });
    });

    it('an ad spending before the boundary is still not new', async () => {
      const fresh = await detectNewAds('client-1', withFridayLaunch, VERIFIED, FRIDAY);
      expect(fresh.map((f) => f.adId)).not.toContain('veteran');
    });

    it('a boundary equal to the window start changes nothing', async () => {
      const withBoundary = await detectNewAds('client-1', ads, WEEKEND, WEEKEND[0]);
      const without = await detectNewAds('client-1', ads, WEEKEND);
      expect(withBoundary).toEqual(without);
    });
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
