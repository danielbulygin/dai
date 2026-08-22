import { describe, it, expect } from 'vitest';
import {
  BREAK_RATIO,
  MAX_RECEIPTS,
  MIN_ACCOUNT_DAYS,
  MOVE_THRESHOLD,
  computeRootCause,
  pinStartDate,
  type ChangeReceipt,
  type RootCauseDayRow,
} from '../src/audit/root-cause.js';
import { SECTION_ORDER, enforceQuietSection } from '../src/audit/magic-audit.js';
import { buildWorkLedger, type WorkLedgerInputs } from '../src/audit/work-ledger.js';
import { toChangeReceipts } from '../src/audit/tinkers-reads.js';
import { receiptsFromActivityEvents, type ActivityEvent } from '../src/audit/report-pack-extra.js';
import { dedash } from '../src/audit/prose.js';

/**
 * The story behind the biggest move, and the honesty rule each half exists for.
 *
 * The engine is deterministic, so every number asserted here is hand-computable
 * from the grid above it. The grids are built so the pinned date lands on the
 * step day itself: a step of 1.3x to 1.45x is the band where the trailing
 * 3-day window cannot catch the jump early, and the test right below the grids
 * pins that property rather than leaving it to luck.
 */

const day = (offset: number): string => new Date(Date.UTC(2026, 6, 1 + offset)).toISOString().slice(0, 10);

interface DaySpec {
  spend: number;
  impressions: number;
  link_clicks: number;
  results: number;
}

const run = (count: number, per: DaySpec, startAt = 0): RootCauseDayRow[] =>
  Array.from({ length: count }, (_, i) => ({ date: day(startAt + i), ...per }));

/** 20 quiet days then 10 changed ones: the break day is always day(20). */
const grid = (before: DaySpec, after: DaySpec): RootCauseDayRow[] => [...run(20, before), ...run(10, after, 20)];

const BASE: DaySpec = { spend: 100, impressions: 20_000, link_clicks: 200, results: 10 };

const receipt = (over: Partial<ChangeReceipt> & { at: string }): ChangeReceipt => ({
  kind: 'other',
  objectName: null,
  objectType: null,
  fromBudget: null,
  toBudget: null,
  actorName: null,
  ...over,
});

// ---------------------------------------------------------------------------
// The start date: the join key everything else hangs off
// ---------------------------------------------------------------------------

describe('pinning the day the move started', () => {
  it('pins the step day itself when the step is inside the clean band', () => {
    // 10 per result for twenty days, 14 for ten: 1.4x, over the 1.3 bar and
    // under the 1.45 where the trailing window starts catching it early.
    const days = grid(BASE, { spend: 140, impressions: 28_000, link_clicks: 280, results: 10 });
    expect(pinStartDate(days)).toBe(day(20));
  });

  it('pins EARLY on a violent step, because the trailing three days include it', () => {
    // 10 to 25 is 2.5x: the window starting two days before the step already
    // averages 15 against 10, which clears the bar. The receipt window is three
    // days either side for exactly this reason.
    const days = grid(BASE, { spend: 250, impressions: 50_000, link_clicks: 500, results: 10 });
    expect(pinStartDate(days)).toBe(day(18));
  });

  it('never pins a day without seven days of history behind it', () => {
    // The step is on day 5, and the first day the scan may consider is day 7.
    const days = [...run(5, BASE), ...run(7, { spend: 200, impressions: 40_000, link_clicks: 400, results: 10 }, 5)];
    expect(pinStartDate(days)).toBe(day(7));
  });

  it('pins nothing on a flat series', () => {
    expect(pinStartDate(run(30, BASE))).toBeNull();
  });

  it('reads a zero-result day as no reading, never as a free day', () => {
    // Ten days at 10 per result, then a no-result day. A zero there would read
    // as the cheapest day in the account and pull the mean DOWN.
    const days = [...run(20, BASE), ...run(10, { spend: 140, impressions: 28_000, link_clicks: 280, results: 0 }, 20)];
    expect(pinStartDate(days)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The six signatures
// ---------------------------------------------------------------------------

describe('self-inflicted scale damage', () => {
  const section = computeRootCause({
    days: grid(BASE, { spend: 140, impressions: 28_000, link_clicks: 280, results: 10 }),
    currency: 'USD',
    changes: [
      receipt({ at: `${day(20)}T09:00:00Z`, kind: 'budget_increased', objectName: 'Prospecting AU', fromBudget: 100, toBudget: 140 }),
    ],
  });

  it('blames the budget move, with the two costs and the two budgets in the sentence', () => {
    expect(section.data.signature).toBe('scale_damage');
    expect(section.data.start_date).toBe(day(20));
    expect(section.data.cost_per_result_before).toBe(10);
    expect(section.data.cost_per_result_after).toBe(14);
    expect(section.data.cost_per_result_change_pct).toBe(40);
    expect(section.summary).toContain('10.00 USD against 14.00 USD');
    expect(section.summary).toContain('the daily budget on "Prospecting AU" went up from 100 USD to 140 USD on 21 Jul');
    expect(section.data.signal).toBe(true);
  });

  it('asks for seven full days at the new level before judging it, and names the old cost to judge against', () => {
    expect(section.next_step).toContain('7 full days');
    expect(section.next_step).toContain('10.00 USD');
    expect(section.next_step).toContain('step the budget back down');
  });
});

describe('bad traffic: more clicks, fewer of them worth anything', () => {
  const section = computeRootCause({
    // Clicks up 50%, results down: 7 results on 300 clicks against 10 on 200.
    days: grid(BASE, { spend: 100, impressions: 20_000, link_clicks: 300, results: 7 }),
    currency: 'USD',
    changes: [],
  });

  it('says the extra traffic is the wrong traffic, with both directions', () => {
    expect(section.data.signature).toBe('bad_traffic');
    expect(section.summary).toContain('interest in the ads (link CTR) up 50%');
    expect(section.summary).toContain('down 53.3%');
    expect(section.summary).toContain('something changed who the ads attract, not how many');
  });

  it('sends the reader to cost per result rather than to clicks', () => {
    expect(section.next_step).toContain('cost per result, not on clicks');
    expect(section.next_step).toContain('21 Jul');
  });
});

describe('measurement or the site, not the ads', () => {
  const section = computeRootCause({
    // Delivery and interest byte-identical; only the last step moves.
    days: grid(BASE, { spend: 100, impressions: 20_000, link_clicks: 200, results: 7 }),
    currency: 'USD',
    changes: [],
  });

  it('needs delivery flat, interest flat, and nobody having touched the ads', () => {
    expect(section.data.signature).toBe('measurement_or_site');
    const stages = section.data.stages as Array<{ stage: string; change_pct: number | null; moved: boolean }>;
    expect(stages.find((s) => s.stage === 'delivery_cost')).toMatchObject({ change_pct: 0, moved: false });
    expect(stages.find((s) => s.stage === 'interest')).toMatchObject({ change_pct: 0, moved: false });
    expect(stages.find((s) => s.stage === 'clicks_to_results')).toMatchObject({ change_pct: -30, moved: true });
    expect(section.summary).toContain('as often a measurement change as a real change');
    expect(section.next_step).toContain('the site and in the tracking');
  });

  it('is NOT claimed when somebody did touch the ads that week', () => {
    const withReceipt = computeRootCause({
      days: grid(BASE, { spend: 100, impressions: 20_000, link_clicks: 200, results: 7 }),
      currency: 'USD',
      changes: [receipt({ at: `${day(21)}T10:00:00Z`, kind: 'paused', objectName: 'Retargeting' })],
    });
    expect(withReceipt.data.signature).not.toBe('measurement_or_site');
  });

  it('is NOT claimed when the change log could not be read at all', () => {
    const blind = computeRootCause({
      days: grid(BASE, { spend: 100, impressions: 20_000, link_clicks: 200, results: 7 }),
      currency: 'USD',
      changes: null,
    });
    expect(blind.data.signature).not.toBe('measurement_or_site');
  });
});

describe('the auction squeeze', () => {
  const section = computeRootCause({
    // Same spend, 30% fewer impressions bought: CPM 5.00 to 7.14.
    days: grid(BASE, { spend: 100, impressions: 14_000, link_clicks: 140, results: 7 }),
    currency: 'USD',
    changes: [],
  });

  it('starts the story at the top of the funnel and quotes both CPMs', () => {
    expect(section.data.signature).toBe('auction_squeeze');
    expect(section.summary).toContain('delivery cost (CPM) is up 42.9%');
    expect(section.summary).toContain('5.00 USD against 7.14 USD');
    expect(section.next_step).toContain('Frequency and audience saturation');
  });

  it('does not claim the budget was unchanged, because it never read the budget', () => {
    expect(section.summary).not.toContain('same budget');
  });
});

describe('healthy scaling: the good news read', () => {
  // Spend up 40% and held there. The cost spike lasts three days and settles.
  const section = computeRootCause({
    days: [
      ...run(20, BASE),
      ...run(3, { spend: 140, impressions: 28_000, link_clicks: 280, results: 10 }, 20),
      ...run(7, { spend: 140, impressions: 28_000, link_clicks: 280, results: 14 }, 23),
    ],
    currency: 'USD',
    changes: [],
  });

  it('reports the scale up holding, and is a quiet section with no step to take', () => {
    expect(section.data.signature).toBe('healthy_scaling');
    expect(section.data.signal).toBe(false);
    expect(section.next_step).toBeUndefined();
    expect(section.data.spend_per_day_before).toBe(100);
    expect(section.data.spend_per_day_after).toBe(140);
    expect(section.data.spend_per_day_change_pct).toBe(40);
    expect(section.data.cost_per_result_after).toBe(10.94);
    expect(section.summary).toContain('That is a scale up that held');
  });

  it('survives the write path as a quiet row', () => {
    const written = enforceQuietSection({ key: 'root_cause', title: 't', status: 'complete', ...section });
    expect(written.next_step).toBeUndefined();
  });
});

describe('the generic read: name what moved, clear what did not', () => {
  const section = computeRootCause({
    // CPM DOWN a third (moved, but not the squeeze), interest flat, last step down.
    days: grid(BASE, { spend: 100, impressions: 30_000, link_clicks: 300, results: 7 }),
    currency: 'USD',
    changes: [receipt({ at: `${day(19)}T08:00:00Z`, kind: 'paused', objectName: 'Cold video 3' })],
  });

  it('names the moved steps with their directions and calls the flat one innocent', () => {
    expect(section.data.signature).toBe('generic');
    expect(section.summary).toContain('delivery cost (CPM) is down 33.3%');
    expect(section.summary).toContain('while interest in the ads (link CTR) held steady');
    expect(section.next_step).toContain('Start at the step that moved: delivery cost (CPM)');
  });

  it('quotes the receipt it found, with the date', () => {
    expect(section.summary).toContain('"Cold video 3" was paused on 20 Jul');
  });
});

// ---------------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------------

describe('the refusal matrix', () => {
  it('refuses under ten spending days, and advises nothing', () => {
    const section = computeRootCause({ days: run(9, BASE), currency: 'USD', changes: [] });
    expect(section.data.signal).toBe(false);
    expect(section.data.start_date).toBeNull();
    expect(section.next_step).toBeUndefined();
    expect(section.summary).toContain('9 days of account spend');
    expect(section.summary).toContain(`at least ${MIN_ACCOUNT_DAYS} days`);
  });

  it('counts one spending day as one day, not as one days', () => {
    const section = computeRootCause({
      days: [...run(1, BASE), ...run(20, { ...BASE, spend: 0 }, 1)],
      currency: 'USD',
      changes: [],
    });
    expect(section.summary).toContain('1 day of account spend');
    expect(section.summary).not.toContain('1 days');
  });

  it('refuses an account with spend and no result anywhere, rather than dividing by nothing', () => {
    const section = computeRootCause({
      days: run(20, { spend: 100, impressions: 20_000, link_clicks: 200, results: 0 }),
      currency: 'USD',
      changes: [],
    });
    expect(section.data.results_in_window).toBe(0);
    expect(section.summary).toContain('recorded no result on any of them');
    expect(section.next_step).toBeUndefined();
  });

  it('refuses when no day breaks against the week before it', () => {
    const section = computeRootCause({ days: run(30, BASE), currency: 'USD', changes: [] });
    expect(section.data.start_date).toBeNull();
    expect(section.data.break_ratio).toBe(BREAK_RATIO);
    expect(section.summary).toContain('never ran 30% or more above the week before');
    expect(section.next_step).toBeUndefined();
  });

  it('refuses when the cost moved and no single step moved with it', () => {
    // CPM +20%, interest -8%, last step -8%: multiplied out that is cost per
    // result +41.8%, and not one step of it clears the 25% bar on its own.
    const section = computeRootCause({
      days: [
        ...run(20, { spend: 5_000, impressions: 1_000_000, link_clicks: 10_000, results: 500 }),
        ...run(10, { spend: 7_500, impressions: 1_250_000, link_clicks: 11_500, results: 529 }, 20),
      ],
      currency: 'USD',
      changes: [],
    });
    expect(section.data.start_date).toBe(day(20));
    expect(section.data.signal).toBe(false);
    expect(section.next_step).toBeUndefined();
    expect(section.summary).toContain(`by ${Math.round(MOVE_THRESHOLD * 100)}% or more`);
    const stages = section.data.stages as Array<{ moved: boolean }>;
    expect(stages.every((s) => !s.moved)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The receipts
// ---------------------------------------------------------------------------

describe("the receipts: the account's own change log around the date", () => {
  const days = grid(BASE, { spend: 100, impressions: 14_000, link_clicks: 140, results: 7 });
  const at = (offset: number): string => `${day(offset)}T12:00:00Z`;

  it('takes three days either side and nothing on the fourth', () => {
    const section = computeRootCause({
      days,
      currency: 'USD',
      changes: [
        receipt({ at: at(16), kind: 'paused', objectName: 'four days early' }),
        receipt({ at: at(17), kind: 'paused', objectName: 'three days early' }),
        receipt({ at: at(23), kind: 'resumed', objectName: 'three days late' }),
        receipt({ at: at(24), kind: 'resumed', objectName: 'four days late' }),
      ],
    });
    expect(section.data.changes_near_date).toBe(2);
    const quoted = section.data.receipts as string[];
    expect(quoted.join(' | ')).toContain('three days early');
    expect(quoted.join(' | ')).toContain('three days late');
    expect(quoted.join(' | ')).not.toContain('four days');
  });

  it('quotes at most three and counts the rest, with the count reading as its own number', () => {
    const five = computeRootCause({
      days,
      currency: 'USD',
      changes: [20, 20, 21, 21, 22].map((offset, i) =>
        receipt({ at: at(offset), kind: 'paused', objectName: `ad ${i}` }),
      ),
    });
    expect(five.data.changes_near_date).toBe(5);
    expect((five.data.receipts as string[]).length).toBe(MAX_RECEIPTS);
    expect(five.summary).toContain('2 other logged changes sit inside the same 3 days');

    const four = computeRootCause({
      days,
      currency: 'USD',
      changes: [20, 20, 21, 21].map((offset, i) => receipt({ at: at(offset), kind: 'paused', objectName: `ad ${i}` })),
    });
    expect(four.summary).toContain('1 other logged change sits inside the same 3 days');
  });

  it('deduplicates two logged changes that say the same sentence', () => {
    const section = computeRootCause({
      days,
      currency: 'USD',
      changes: [
        receipt({ at: at(20), kind: 'paused', objectName: 'Cold video 3' }),
        receipt({ at: `${day(20)}T18:00:00Z`, kind: 'paused', objectName: 'Cold video 3' }),
      ],
    });
    expect((section.data.receipts as string[]).length).toBe(1);
  });

  it('names the person when the log named one, and never invents one when it did not', () => {
    const named = computeRootCause({
      days,
      currency: 'USD',
      changes: [receipt({ at: at(20), kind: 'budget_changed', actorName: 'Jane Doe' })],
    });
    expect(named.summary).toContain('the daily budget was changed on 21 Jul, by Jane Doe');
    const unnamed = computeRootCause({ days, currency: 'USD', changes: [receipt({ at: at(20), kind: 'paused' })] });
    expect(unnamed.summary).toContain('something in the account was paused on 21 Jul');
    expect(unnamed.summary).not.toContain(' by ');
  });
});

describe('an unreadable change log and an empty one are different findings', () => {
  const days = grid(BASE, { spend: 100, impressions: 14_000, link_clicks: 140, results: 7 });

  it("an empty log is the finding, and asks about the customer's own world", () => {
    const section = computeRootCause({ days, currency: 'USD', changes: [] });
    expect(section.data.change_log_read).toBe(true);
    expect(section.data.changes_near_date).toBe(0);
    expect(section.summary).toContain('Nothing changed on the ads side around that date');
    expect(section.summary).toContain('what happened in your own world on 21 Jul');
    expect((section.warnings ?? []).join(' ')).not.toContain('could not be read');
  });

  it('an unreadable log says so, and never says nothing changed', () => {
    const section = computeRootCause({ days, currency: 'USD', changes: null });
    expect(section.data.change_log_read).toBe(false);
    expect(section.summary).toContain("could not read this account's change log");
    expect(section.summary).not.toContain('Nothing changed on the ads side');
    expect((section.warnings ?? []).join(' ')).toContain('change history could not be read');
    expect(section.derivation).toContain('no change is claimed either way');
  });
});

describe('the two sources a receipt can come from', () => {
  it('keeps the budget figures and the object name off the generation seam', () => {
    const receipts = toChangeReceipts([
      {
        key: 'k1',
        at: '2026-07-21T09:00:00Z',
        kind: 'budget_increased',
        objectId: '123',
        objectName: 'Prospecting AU',
        objectType: 'AD_SET',
        fromBudget: 100,
        toBudget: 140,
        providerEventType: 'update_ad_set_budget',
      },
      // The same change arriving twice from two overlapping window slices.
      { key: 'k1', at: '2026-07-21T09:00:00Z', kind: 'budget_increased', objectId: '123', providerEventType: 'x' },
      { key: 'k2', at: '2026-07-22T09:00:00Z', kind: 'something_new_they_shipped', objectId: '9' },
    ]);
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({ kind: 'budget_increased', objectName: 'Prospecting AU', fromBudget: 100, toBudget: 140, actorName: null });
    // A kind outside the closed vocabulary is kept and not guessed at.
    expect(receipts[1]!.kind).toBe('other');
  });

  it('never calls a budget change an increase when the live log did not say which way', () => {
    const events: ActivityEvent[] = [
      { event_type: 'update_campaign_budget', event_time: '2026-07-21T09:00:00Z', actor_id: '1', actor_name: 'Jane Doe', application_id: null, application_name: null, object_type: 'CAMPAIGN' },
      { event_type: 'update_ad_set_run_status', event_time: '2026-07-21T10:00:00Z', actor_id: '1', actor_name: 'Jane Doe', application_id: null, application_name: null, object_type: 'AD_SET' },
      { event_type: 'ad_set_unpause', event_time: '2026-07-21T11:00:00Z', actor_id: null, actor_name: null, application_id: null, application_name: null, object_type: null },
    ];
    const receipts = receiptsFromActivityEvents(events);
    expect(receipts.map((r) => r.kind)).toEqual(['budget_changed', 'paused', 'resumed']);
    expect(receipts[0]!.actorName).toBe('Jane Doe');
    expect(receipts.every((r) => r.fromBudget === null && r.objectName === null)).toBe(true);
  });

  it('a budget change with no direction cannot be blamed for scale damage', () => {
    const section = computeRootCause({
      days: grid(BASE, { spend: 140, impressions: 28_000, link_clicks: 280, results: 10 }),
      currency: 'USD',
      changes: receiptsFromActivityEvents([
        { event_type: 'update_campaign_budget', event_time: `${day(20)}T09:00:00Z`, actor_id: null, actor_name: null, application_id: null, application_name: null, object_type: 'CAMPAIGN' },
      ]),
    });
    expect(section.data.signature).not.toBe('scale_damage');
  });
});

// ---------------------------------------------------------------------------
// The wiring, and the copy
// ---------------------------------------------------------------------------

describe('the section is wired where its siblings are', () => {
  it('sits in the order with a dash-free title, right after the change-history chapter', () => {
    const keys = SECTION_ORDER.map((s) => s.key);
    expect(keys).toContain('root_cause');
    expect(keys.indexOf('root_cause')).toBe(keys.indexOf('account_activity') + 1);
  });

  it('no title in the whole order carries a dash', () => {
    for (const s of SECTION_ORDER) {
      expect(s.title, s.key).not.toMatch(/[–—]/);
      expect(dedash(s.title)).toBe(s.title);
    }
  });

  it('contributes a settled work row only when it pinned a date', () => {
    const base = (data: Record<string, unknown>): WorkLedgerInputs => ({
      sections: { root_cause: { key: 'root_cause', title: 't', status: 'complete', data } },
      window: { anchored: false, anchorDate: day(29), coreStart: day(0), ninetyStart: day(0), sixMonthStart: day(0), lastSpendDate: null, daysSinceLastSpend: 0 },
      adsRead: 0,
      daysRead: 0,
      coreDaysCovered: 0,
      retiredAdsFound: 0,
      insightsRanked: 0,
      scorecardDimensions: 0,
    });
    expect(buildWorkLedger(base({ start_date: day(20), days_read: 30 })).map((r) => r.line)).toContain(
      'Pinned the day the biggest cost movement started across 30 days and read which funnel step moved with it',
    );
    expect(buildWorkLedger(base({ start_date: null, days_read: 30 })).map((r) => r.line)).not.toContain(
      'Pinned the day the biggest cost movement started across 30 days and read which funnel step moved with it',
    );
  });
});

describe('the copy sweep over everything this section generates', () => {
  const sections = [
    computeRootCause({
      days: grid(BASE, { spend: 140, impressions: 28_000, link_clicks: 280, results: 10 }),
      currency: 'USD',
      changes: [receipt({ at: `${day(20)}T09:00:00Z`, kind: 'budget_increased', objectName: 'Prospecting AU', fromBudget: 100, toBudget: 140 })],
    }),
    computeRootCause({ days: grid(BASE, { spend: 100, impressions: 20_000, link_clicks: 300, results: 7 }), currency: 'USD', changes: [] }),
    computeRootCause({ days: grid(BASE, { spend: 100, impressions: 20_000, link_clicks: 200, results: 7 }), currency: 'USD', changes: [] }),
    computeRootCause({ days: grid(BASE, { spend: 100, impressions: 14_000, link_clicks: 140, results: 7 }), currency: 'USD', changes: null }),
    computeRootCause({ days: grid(BASE, { spend: 100, impressions: 30_000, link_clicks: 300, results: 7 }), currency: 'USD', changes: [] }),
    computeRootCause({ days: run(9, BASE), currency: 'USD', changes: [] }),
    computeRootCause({ days: run(30, BASE), currency: 'USD', changes: [] }),
  ];

  it('writes no dash anywhere a customer reads', () => {
    for (const s of sections) {
      const strings = [s.summary, s.next_step ?? '', s.derivation ?? '', ...(s.warnings ?? []), ...((s.data.receipts as string[] | undefined) ?? [])];
      for (const text of strings) {
        expect(text).not.toMatch(/[–—]/);
        expect(dedash(text)).toBe(text);
      }
    }
  });

  it('never writes a plural count as a singular one or the other way round', () => {
    for (const s of sections) {
      const text = `${s.summary} ${s.next_step ?? ''} ${s.derivation ?? ''}`;
      expect(text).not.toMatch(/\b1 (?:days|results|changes)\b/);
      expect(text).not.toMatch(/\b(?:[02-9]|\d\d) (?:day|result|change) \b/);
    }
  });

  it('declares a signal on every one of them, and only carries a step when it has one', () => {
    for (const s of sections) {
      expect(typeof s.data.signal).toBe('boolean');
      if (s.data.signal === false) {
        expect(enforceQuietSection({ key: 'root_cause', title: 't', status: 'complete', ...s }).next_step).toBeUndefined();
      } else {
        expect(s.next_step, s.summary).toBeTruthy();
      }
    }
  });

  it('states its own arithmetic, including which click column it read', () => {
    const s = sections[0]!;
    expect(s.derivation).toContain('link clicks over impressions');
    expect(s.derivation).toContain(`${BREAK_RATIO} times the 7 days before it`);
    expect(s.derivation).toContain('carries none rather than a zero');
  });
});

describe('a pull with no click column at all', () => {
  const section = computeRootCause({
    days: [
      ...run(20, { spend: 100, impressions: 20_000, link_clicks: 0, results: 10 }),
      ...run(10, { spend: 100, impressions: 14_000, link_clicks: 0, results: 7 }, 20),
    ],
    currency: 'USD',
    changes: [],
  });

  it('reads delivery cost only, and says so instead of dividing by a zero nobody measured', () => {
    expect(section.data.click_basis).toBeNull();
    expect((section.data.stages as Array<{ stage: string }>).map((s) => s.stage)).toEqual(['delivery_cost']);
    expect((section.warnings ?? []).join(' ')).toContain('No click is recorded anywhere in this window');
    expect(section.derivation).toContain('left out rather than divided by a zero nobody measured');
  });

  it('falls back to all clicks and names them when that is what the rows carry', () => {
    const allClicks = computeRootCause({
      days: [
        ...run(20, { spend: 100, impressions: 20_000, link_clicks: 0, results: 10 }).map((d) => ({ ...d, clicks: 200 })),
        ...run(10, { spend: 100, impressions: 14_000, link_clicks: 0, results: 7 }, 20).map((d) => ({ ...d, clicks: 140 })),
      ],
      currency: 'USD',
      changes: [],
    });
    expect(allClicks.data.click_basis).toBe('all clicks');
    expect(allClicks.derivation).toContain('all clicks over impressions');
    expect((allClicks.data.stages as Array<{ label: string }>).map((s) => s.label)).toContain('all clicks becoming results');
  });
});
