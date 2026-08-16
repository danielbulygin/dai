/**
 * The Monday rollup, end to end — runAgencyMorningBrief with the warehouse and
 * the ledger stubbed out, nothing posted, nothing written, no judge.
 *
 * agency-morning-brief.test.ts covers the pure helpers one at a time. This file
 * covers the WIRING: that briefAccount hands the same window to the gate, the
 * movers, detectNewAds, evaluateLaunches and walkAdInsights, and that the
 * rendered Slack text tells the reader what those five agreed on. Every case
 * here is a weekend-gap regression — the ones that were invisible while the
 * cron reported a single "yesterday".
 *
 * Fixture rule: the account_daily rows are COMPUTED as the sum of the ad_daily
 * rows (see `accountDays`). A hand-written account total that disagreed with
 * its own ads would let a wrong number pass this file unnoticed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fixture state the module mocks read. vi.hoisted so the mock factories — which
// run before the imports — can close over it and later tests can re-seed it.
// ---------------------------------------------------------------------------

const warehouse = vi.hoisted(() => ({
  clients: [] as Array<Record<string, unknown>>,
  accountDaily: [] as Array<Record<string, unknown>>,
  adDaily: [] as Array<Record<string, unknown>>,
  /** The detectNewAds full-history probe. Empty = nothing older exists, which
   *  is the interesting case: the candidate really is a launch. */
  adProbe: [] as Array<Record<string, unknown>>,
  clientConfig: null as Record<string, unknown> | null,
  campaignDaily: [] as Array<Record<string, unknown>>,
  accountChanges: [] as Array<Record<string, unknown>>,
  breakdowns: [] as Array<Record<string, unknown>>,
  /** Every table the brief actually reached for, in order. */
  tables: [] as string[],
}));

const ledger = vi.hoisted(() => ({
  watches: [] as Array<Record<string, unknown>>,
  observations: [] as Array<Record<string, unknown>>,
  uncovered: [] as Array<Record<string, unknown>>,
}));

// The shared warehouse. One chain per .from(), so a query knows which table it
// is and which operators it was built with — the brief reads eight different
// shapes through this one client and a single fixture array cannot serve them.
vi.mock('../src/integrations/supabase.js', () => {
  const CHAIN = ['select', 'eq', 'gte', 'lte', 'lt', 'gt', 'in', 'or', 'order', 'range', 'limit'];
  const makeQuery = (table: string) => {
    warehouse.tables.push(table);
    const used = new Set<string>();
    const rows = (): unknown => {
      switch (table) {
        case 'clients':
          return warehouse.clients;
        case 'account_daily':
          return warehouse.accountDaily;
        // Two very different reads share this table: the paged history fetch
        // (.range) and detectNewAds' existence probe (.gt('spend', 0)).
        case 'ad_daily':
          return used.has('gt') ? warehouse.adProbe : warehouse.adDaily;
        case 'client_configs':
          return warehouse.clientConfig;
        case 'campaign_daily':
          return warehouse.campaignDaily;
        case 'account_changes':
          return warehouse.accountChanges;
        case 'breakdowns':
          return warehouse.breakdowns;
        default:
          return [];
      }
    };
    const q: Record<string, unknown> = {};
    for (const m of CHAIN) {
      q[m] = (..._args: unknown[]) => {
        used.add(m);
        return q;
      };
    }
    q.maybeSingle = () => ({
      then: (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null }),
    });
    q.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null });
    return q;
  };
  return { getSupabase: () => ({ from: (table: string) => makeQuery(table) }) };
});

// The DAI ledger. Everything lives in one `ada_insights` table, so the fixture
// is chosen by the `kind` (and `source`) the caller filtered on.
vi.mock('../src/integrations/dai-supabase.js', () => {
  const CHAIN = ['select', 'gte', 'lte', 'lt', 'gt', 'in', 'or', 'order', 'range', 'limit'];
  const makeQuery = () => {
    const eqs = new Map<string, unknown>();
    let writing = false;
    const rows = (): unknown => {
      if (writing) return null;
      const kind = eqs.get('kind');
      if (kind === 'launch-watch') return ledger.watches;
      if (kind === 'uncovered-day') return ledger.uncovered;
      if (kind === 'daily-observation') {
        // markPersistence reads the same kind but filters on source — that pass
        // decorates mover lines with repeat tags and is not under test here.
        return eqs.has('source') ? [] : ledger.observations;
      }
      return [];
    };
    const q: Record<string, unknown> = {};
    for (const m of CHAIN) {
      q[m] = (..._args: unknown[]) => q;
    }
    q.eq = (col: string, value: unknown) => {
      eqs.set(col, value);
      return q;
    };
    for (const m of ['insert', 'update', 'delete']) {
      q[m] = (..._args: unknown[]) => {
        writing = true;
        return q;
      };
    }
    q.maybeSingle = () => ({
      then: (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null }),
    });
    q.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null });
    return q;
  };
  return { getDaiSupabase: () => ({ from: (_table: string) => makeQuery() }) };
});

const postMessage = vi.hoisted(() => vi.fn());
vi.mock('../src/slack/dedicated-bots.js', () => ({
  getDedicatedBotClient: () => ({ chat: { postMessage } }),
}));

// Macro vitals are a Monday-only block with their own 90-day fixture surface
// and their own test file. Null drops the block (the module's own fail-open).
vi.mock('../src/monitoring/macro-vitals.js', () => ({
  buildMacroPulse: vi.fn(async () => null),
}));

vi.mock('../src/monitoring/daniel-judge.js', () => ({
  judgeSafely: vi.fn(async () => null),
  selfCheckLine: () => null,
}));

import { runAgencyMorningBrief } from '../src/monitoring/agency-morning-brief.js';

// ---------------------------------------------------------------------------
// The calendar. 2026-08-10 is a Monday; Aug 7/8/9 are Fri/Sat/Sun.
// ---------------------------------------------------------------------------

const NY = 'America/New_York';
/** 06:10 UTC = the real 08:10 Berlin cron, and 02:10 Monday in New York. */
const MONDAY_CRON = new Date('2026-08-10T06:10:00Z');
const TUESDAY_CRON = new Date('2026-08-11T06:10:00Z');

const THU = '2026-08-06';
const FRI = '2026-08-07';
const SAT = '2026-08-08';
const SUN = '2026-08-09';
const MON = '2026-08-10';
const WEEKEND = [FRI, SAT, SUN];
const TRAILING = ['2026-08-03', '2026-08-04', '2026-08-05', THU];

/** The one made-up constant: revenue per purchase, so ROAS has a source. */
const AOV = 60;

const CLIENT = {
  id: 'client-test',
  code: 'TEST',
  name: 'Test Client',
  ad_account_id: 'act_test',
  timezone: NY,
  currency: 'USD',
  parent_code: null,
  account_label: null,
  goal_bands: null,
};

/** A $40 cost-per-purchase target, and no category parsing — the category view
 *  is a separate surface with its own campaign_daily fixture needs. */
const CONFIG = { config: { targets: { cpa: 40 } } };

interface AdFixture {
  date: string;
  ad_id: string;
  ad_name: string;
  adset_id: string;
  campaign_id: string;
  spend: number;
  impressions: number;
  link_clicks: number;
  hook_rate: number;
  frequency: number;
  content_views: number;
  purchases: number;
  results: number | null;
}

function ad(date: string, adId: string, spend: number, purchases: number): AdFixture {
  return {
    date,
    ad_id: adId,
    ad_name: adId,
    adset_id: 's1',
    campaign_id: 'c1',
    spend,
    impressions: Math.round(spend * 50),
    link_clicks: Math.round(spend * 0.75),
    hook_rate: 0.25,
    frequency: 1.5,
    content_views: 0,
    purchases,
    results: null,
  };
}

function nextDay(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Account rows summed from the ad rows. `fetched_at` is the honesty gate's whole
 * rule: stamped the MORNING AFTER the account-local day it describes, the day
 * verifies; stamped inside that day it does not — which is how `unverified`
 * days are staged.
 */
function accountDays(ads: AdFixture[], unverified: string[] = []) {
  const byDate = new Map<string, { spend: number; purchases: number }>();
  for (const a of ads) {
    const cur = byDate.get(a.date) ?? { spend: 0, purchases: 0 };
    cur.spend += a.spend;
    cur.purchases += a.purchases;
    byDate.set(a.date, cur);
  }
  return [...byDate.entries()]
    .sort((x, y) => x[0].localeCompare(y[0]))
    .map(([date, sums]) => ({
      date,
      spend: Math.round(sums.spend * 100) / 100,
      purchases: sums.purchases,
      purchase_value: sums.purchases * AOV,
      roas: sums.spend > 0 ? (sums.purchases * AOV) / sums.spend : null,
      results: null,
      cost_per_result: null,
      leads: null,
      // 14:00 UTC = 10:00 New York, comfortably inside the named local day.
      fetched_at: unverified.includes(date) ? `${date}T14:00:00Z` : `${nextDay(date)}T14:00:00Z`,
    }));
}

/**
 * Four ads, each carrying one of the weekend-gap cases:
 *   veteran     — a $40-CPA workhorse whose weekend CPA doubles (the mover)
 *   storyteller — small money, a live cpa_shift thread, rich Fri+Sat, thin Sun
 *   quiet       — first spend Thursday, trickle delivery, no purchases (the
 *                 day-3 checkpoint the weekend skipped)
 *   sat-launch  — first spend on Saturday (announced and watched, or lost)
 */
function baseAds(): AdFixture[] {
  const rows: AdFixture[] = [];
  for (const d of TRAILING) {
    rows.push(ad(d, 'veteran', 400, 10));
    // Thursday is the day the storyteller's CPA shift was flagged: $30 for one
    // purchase against the $10 it had been costing.
    rows.push(ad(d, 'storyteller', 30, d === THU ? 1 : 3));
  }
  rows.push(ad(THU, 'quiet', 8, 0));
  rows.push(ad(FRI, 'veteran', 400, 5), ad(FRI, 'storyteller', 25, 1), ad(FRI, 'quiet', 8, 0));
  rows.push(
    ad(SAT, 'veteran', 400, 5),
    ad(SAT, 'storyteller', 25, 1),
    ad(SAT, 'quiet', 8, 0),
    ad(SAT, 'sat-launch', 120, 1),
  );
  // Sunday is thin for everything already running — the day a single-day brief
  // would have judged the whole weekend on.
  rows.push(
    ad(SUN, 'veteran', 20, 0),
    ad(SUN, 'storyteller', 5, 1),
    ad(SUN, 'quiet', 6, 0),
    ad(SUN, 'sat-launch', 180, 3),
  );
  return rows;
}

/** An open launch-watch whose day-3 checkpoint fell on Saturday. */
const QUIET_WATCH = {
  id: 'watch-quiet',
  entity_id: 'quiet',
  entity_name: 'quiet',
  evidence: { first_spend_date: THU },
};

/** A live ad-level claim from Thursday, waiting to be re-checked. */
const STORYTELLER_THREAD = {
  id: 'obs-storyteller',
  entity_id: 'storyteller',
  entity_name: 'storyteller',
  evidence: {
    kind: 'cpa_shift',
    date: THU,
    yesterday_cpa: 30,
    trailing_cpa: 10,
    rel_change: 2,
    yesterday_spend: 30,
  },
  derived_at: '2026-08-07T06:10:00Z',
};

function seed(ads: AdFixture[], unverified: string[] = []): void {
  warehouse.clients = [{ ...CLIENT }];
  warehouse.adDaily = ads as unknown as Array<Record<string, unknown>>;
  warehouse.accountDaily = accountDays(ads, unverified) as unknown as Array<
    Record<string, unknown>
  >;
  warehouse.clientConfig = CONFIG;
}

/** Nothing posts, nothing is written, the judge stays off. */
function run(now: Date) {
  return runAgencyMorningBrief({
    post: false,
    writeToLedger: false,
    judge: false,
    pilots: ['TEST'],
    now,
  });
}

beforeEach(() => {
  warehouse.clients = [];
  warehouse.accountDaily = [];
  warehouse.adDaily = [];
  warehouse.adProbe = [];
  warehouse.clientConfig = null;
  warehouse.campaignDaily = [];
  warehouse.accountChanges = [];
  warehouse.breakdowns = [];
  warehouse.tables = [];
  ledger.watches = [];
  ledger.observations = [];
  ledger.uncovered = [];
  postMessage.mockClear();
});

// ---------------------------------------------------------------------------

describe('runAgencyMorningBrief — the Monday rollup, end to end', () => {
  it('covers Fri+Sat+Sun as one verified window and quotes the pooled numbers', async () => {
    seed(baseAds());
    const result = await run(MONDAY_CRON);

    const brief = result.accounts[0]!;
    expect(result.accounts).toHaveLength(1);
    expect(brief.status).toBe('verified');
    expect(brief.window).toEqual(WEEKEND);
    expect(brief.unverifiedDays).toEqual([]);
    expect(brief.yesterday).toBe(SUN);

    // The headline totals are the fixture's own weekend sum, not a repeated
    // literal — a fixture edit that changes the money changes both sides.
    const weekendRows = warehouse.accountDaily.filter((r) =>
      WEEKEND.includes(String(r.date)),
    ) as unknown as Array<{ spend: number; purchases: number }>;
    const spend = weekendRows.reduce((s, r) => s + r.spend, 0);
    const purchases = weekendRows.reduce((s, r) => s + r.purchases, 0);
    expect(spend).toBe(1197);
    expect(purchases).toBe(17);

    expect(result.text).toContain(`Weekend Fri, Aug 7 – Sun, Aug 9: $1,197 spent`);
    expect(result.text).toContain('17 purchases');
    expect(result.text).toContain('$70.41 CPA — 76% over your $40.00 target');
    // The per-day tail: the reader is never handed an average that hides how
    // much thinner Sunday was.
    expect(result.text).toContain('(Fri $433/$72.17 · Sat $553/$79.00 · Sun $211/$52.75)');
    expect(result.text).not.toMatch(/yesterday/i);

    // The whole chain really ran against the warehouse.
    expect(new Set(warehouse.tables)).toEqual(
      new Set(['clients', 'account_daily', 'client_configs', 'ad_daily', 'account_changes', 'breakdowns']),
    );
    // Dry run: no Slack call, no ledger rows.
    expect(postMessage).not.toHaveBeenCalled();
    expect(result.posted).toBe(false);
    expect(result.insightsWritten).toBe(0);
  });

  it('announces a Saturday launch on its true day and opens the New block for it', async () => {
    seed(baseAds());
    const result = await run(MONDAY_CRON);

    const brief = result.accounts[0]!;
    expect(brief.newAds).toHaveLength(1);
    expect(brief.newAds[0]).toMatchObject({
      adId: 'sat-launch',
      firstSpendDate: SAT,
      spend: 300,
      results: 4,
    });
    expect(result.text).toContain('New (1):');
    expect(result.text).toContain('"sat-launch" — first spend Sat, Aug 8, $300 · 4 purchases');
  });

  it('fires the day-3 checkpoint the weekend skipped, on the crossing', async () => {
    seed(baseAds());
    ledger.watches = [QUIET_WATCH];
    const result = await run(MONDAY_CRON);

    const brief = result.accounts[0]!;
    const verdict = brief.watchVerdicts.find((v) => v.adId === 'quiet');
    expect(verdict).toBeDefined();
    // Day 3 fell on Saturday, which no brief covered. The last covered morning
    // was Thursday's data (day 1), so Monday crosses 3 and must speak.
    expect(verdict!.kind).toBe('checkpoint');
    expect(verdict!.ageDays).toBe(4);
    expect(verdict!.evidence.checkpoint_crossed).toBe(3);
    expect(verdict!.evidence.previous_reporting_day).toBe(THU);
    expect(verdict!.isFinal).toBe(false);
    expect(result.text).toContain('Watch:');
    expect(result.text).toContain('"quiet" — day 4:');
  });

  it('judges a weekend-spanning story on the whole window, not on a thin Sunday', async () => {
    seed(baseAds());
    ledger.observations = [STORYTELLER_THREAD];
    const result = await run(MONDAY_CRON);

    const brief = result.accounts[0]!;
    const followUp = brief.followUps.find((f) => f.adId === 'storyteller');
    expect(followUp).toBeDefined();
    // Sunday alone is one purchase on $5 — below the 3-purchase floor, so a
    // single-day walk could only have said "no longer enough delivery to judge".
    expect(followUp!.evidence.day_purchases).toBe(1);
    expect(followUp!.evidence.day_spend).toBe(5);
    // Pooled across the window there are three purchases, and a real verdict.
    expect(followUp!.outcome).not.toBe('stale');
    expect(followUp!.outcome).toBe('confirmed');
    expect(followUp!.keepActive).toBeUndefined();
    expect(followUp!.evidence.window_dates).toEqual(WEEKEND);
    expect(followUp!.evidence.window_spend).toBe(55);
    expect(followUp!.evidence.window_purchases).toBe(3);
    expect(followUp!.evidence.window_cpa).toBe(18.33);
    expect(result.text).toContain('Follow-ups:');
    expect(result.text).toContain(
      '"storyteller" — the CPA shift flagged Thu, Aug 6: still elevated at $18.33 vs $12.00 usual over Fri, Aug 7–Sun, Aug 9 — day 4 of the story',
    );
  });

  it('an unverified Friday is named, and still lets its own launch be seen', async () => {
    // Same weekend, minus the Saturday launch, plus an ad whose first spend is
    // the Friday that fails the gate.
    const ads = [
      ...baseAds().filter((r) => r.ad_id !== 'sat-launch'),
      ad(FRI, 'fri-launch', 100, 1),
      ad(SAT, 'fri-launch', 150, 2),
      ad(SUN, 'fri-launch', 150, 2),
    ];
    seed(ads, [FRI]);
    const result = await run(MONDAY_CRON);

    const brief = result.accounts[0]!;
    expect(brief.status).toBe('verified');
    expect(brief.unverifiedDays).toEqual([FRI]);
    expect(brief.window).toEqual([SAT, SUN]);
    expect(result.text).toContain('⚠️ Fri, Aug 7 could not be verified — data sync incomplete.');

    // The boundary fix: "seen before" means before FRIDAY, not before the first
    // VERIFIED day — otherwise this launch is disqualified by its own
    // unverified first day and never announced.
    expect(brief.newAds).toHaveLength(1);
    expect(brief.newAds[0]).toMatchObject({
      adId: 'fri-launch',
      firstSpendDate: FRI,
      // Only the verified days are QUOTED: Friday's $100 names the day, it
      // never enters the number.
      spend: 300,
      results: 4,
    });
    expect(result.text).toContain('"fri-launch" — first spend Fri, Aug 7, $300 · 4 purchases');
  });
});

describe('runAgencyMorningBrief — every other morning is the single day it always was', () => {
  it('a Tuesday reports one day, with no rollup phrasing anywhere', async () => {
    const ads = [
      ...baseAds(),
      ad(MON, 'veteran', 400, 10),
      ad(MON, 'storyteller', 30, 3),
      ad(MON, 'quiet', 8, 0),
      ad(MON, 'sat-launch', 200, 4),
    ];
    seed(ads);
    ledger.watches = [QUIET_WATCH];
    ledger.observations = [STORYTELLER_THREAD];
    const result = await run(TUESDAY_CRON);

    const brief = result.accounts[0]!;
    expect(brief.status).toBe('verified');
    expect(brief.window).toEqual([MON]);
    expect(brief.window).toHaveLength(1);
    expect(brief.yesterday).toBe(MON);

    const headline = brief.lines[0]!;
    expect(headline.startsWith('Mon, Aug 10: $638 spent · 17 purchases')).toBe(true);
    for (const other of ['Aug 7', 'Aug 8', 'Aug 9']) {
      expect(headline).not.toContain(other);
    }
    expect(result.text).not.toContain('Weekend');

    // The crossing rule does not double-fire: Monday's brief already spoke for
    // day 3, and day 7 is still four days out, so Tuesday is silent.
    expect(brief.watchVerdicts).toEqual([]);
  });
});
