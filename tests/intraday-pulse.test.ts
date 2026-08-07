/**
 * The intraday pulse — regression cases.
 *
 * The product promise is narrow and easy to break: Ada speaks between briefs
 * ONLY when something event-worthy happened today, says it as an event and
 * never as a day verdict, and never says the same thing twice. Each test below
 * pins one of those.
 *
 * Everything here runs against the pure layer (rows + params in, claims out) —
 * no warehouse, no Slack, no ledger.
 */

import { describe, expect, it } from 'vitest';
import {
  accountClock,
  accountHour,
  accountToday,
  buildAccountEvents,
  detectAccountDark,
  detectMoneyOut,
  pulseKey,
  renderPulse,
  type AccountPulseInput,
} from '../src/monitoring/intraday-pulse.js';

const TODAY = '2026-08-07';
const YESTERDAY = '2026-08-06';
const NY = 'America/New_York';

function ad(
  date: string,
  adId: string,
  spend: number,
  purchases: number,
): AccountPulseInput['ads'][number] {
  return {
    date,
    ad_id: adId,
    ad_name: adId,
    adset_id: 's1',
    campaign_id: 'c1',
    spend,
    impressions: 1000,
    link_clicks: 20,
    hook_rate: 0.2,
    frequency: 1.2,
    content_views: 0,
    purchases,
    results: null,
  };
}

function input(over: Partial<AccountPulseInput> = {}): AccountPulseInput {
  return {
    clientCode: 'BFM',
    pilotName: 'Brain.fm',
    accountLabel: 'Brain.fm',
    adAccountId: 'act_123',
    currency: 'USD',
    today: TODAY,
    yesterday: YESTERDAY,
    asOfLocal: '13:40',
    hourLocal: 13,
    ads: [],
    newAds: [],
    expectedCpa: 40,
    yesterdaySpend: 1200,
    todaySpend: 500,
    todayDataPresent: true,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe('the account-local clock (never the server clock)', () => {
  it('today and the wall clock are the ACCOUNT\'s, not the server\'s', () => {
    // 02:10 UTC Aug 7 is still 22:10 on Aug 6 in New York.
    const t = new Date('2026-08-07T02:10:00Z');
    expect(accountToday(NY, t)).toBe('2026-08-06');
    expect(accountToday('Europe/Berlin', t)).toBe('2026-08-07');
    expect(accountClock(NY, t)).toBe('22:10');
    expect(accountHour(NY, t)).toBe(22);
  });

  it('the 13:40 Berlin pulse is still morning in New York', () => {
    const t = new Date('2026-08-07T11:40:00Z'); // 13:40 Berlin
    expect(accountHour('Europe/Berlin', t)).toBe(13);
    expect(accountHour(NY, t)).toBe(7);
  });
});

describe('rule 1 — a new ad started spending today', () => {
  it('fires, names the money so far, and opens the watch story', () => {
    const events = buildAccountEvents(
      input({
        newAds: [{ adId: 'a1', adName: 'Sleep Hook v3', spend: 124, results: 0 }],
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('new-ad');
    expect(events[0]!.line).toBe(
      '🚀 "Sleep Hook v3" started spending on Brain.fm — $124 so far. Watch opened; first read in the morning brief.',
    );
    expect(events[0]!.evidence).toMatchObject({ date: TODAY, event: 'new-ad', spend: 124 });
  });

  it('an ad announced as new is not also scolded in the same message', () => {
    // Same ad: brand new AND already 3× the $40 target with nothing back.
    const events = buildAccountEvents(
      input({
        newAds: [{ adId: 'a1', adName: 'Sleep Hook v3', spend: 124, results: 0 }],
        ads: [ad(TODAY, 'a1', 124, 0)],
      }),
    );
    expect(events.map((e) => e.kind)).toEqual(['new-ad']);
  });

  it('a launch too small to matter is not an event (the £0.05 ping)', () => {
    // Live rehearsal, PL 2026-07-22: a new ad with 5p of spend on a £1,013 day.
    const events = buildAccountEvents(
      input({
        currency: 'GBP',
        todaySpend: 1013,
        newAds: [{ adId: 'a1', adName: 'IN-HOUSEx0017_v1', spend: 0.05, results: 0 }],
      }),
    );
    expect(events).toHaveLength(0);
    // The same launch, once it is really delivering.
    expect(
      buildAccountEvents(
        input({
          currency: 'GBP',
          todaySpend: 1013,
          newAds: [{ adId: 'a1', adName: 'IN-HOUSEx0017_v1', spend: 30, results: 0 }],
        }),
      ),
    ).toHaveLength(1);
  });

  it('one creative duplicated across ad sets is ONE line with the summed money', () => {
    const events = buildAccountEvents(
      input({
        todaySpend: 4000,
        newAds: [
          { adId: 'z9', adName: 'Hook A', spend: 30, results: 0 },
          { adId: 'a1', adName: 'Hook A', spend: 20, results: 1 },
          { adId: 'm5', adName: 'Hook A', spend: 10, results: 0 },
        ],
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.line).toContain('"Hook A" (3 ad sets)');
    expect(events[0]!.line).toContain('$60 so far');
    // Primary id is the smallest, so the dedupe key cannot flip between pulses.
    expect(events[0]!.entityId).toBe('a1');
    expect(events[0]!.evidence.ad_ids).toEqual(['a1', 'm5', 'z9']);
    // Per-ad detail survives for the per-ad launch watches.
    expect(events[0]!.evidence.members).toEqual([
      { ad_id: 'z9', spend: 30, results: 0 },
      { ad_id: 'a1', spend: 20, results: 1 },
      { ad_id: 'm5', spend: 10, results: 0 },
    ]);
  });

  it('once the 🚀 line is spent, a burning launch becomes a money-out event', () => {
    const events = buildAccountEvents(
      input({
        newAds: [{ adId: 'a1', adName: 'Sleep Hook v3', spend: 124, results: 0 }],
        ads: [ad(TODAY, 'a1', 124, 0)],
        alreadyPinged: new Set([pulseKey('a1', 'new-ad')]),
      }),
    );
    expect(events.map((e) => e.kind)).toEqual(['money-out']);
  });
});

describe('rule 2 — money out, nothing back (intraday)', () => {
  it('respects the reference: under 2× is quiet, over 2× speaks, and it names the target', () => {
    const under = detectMoneyOut({
      ads: [ad(TODAY, 'a1', 79, 0)],
      today: TODAY,
      expectedCpa: 40,
    });
    expect(under).toHaveLength(0);

    const over = detectMoneyOut({
      ads: [ad(TODAY, 'a1', 88, 0)],
      today: TODAY,
      expectedCpa: 40,
    });
    expect(over).toHaveLength(1);
    expect(over[0]!.multiple).toBeCloseTo(2.2, 5);

    const line = buildAccountEvents(input({ ads: [ad(TODAY, 'a1', 88, 0)] }))[0]!.line;
    expect(line).toContain('$88 spent, nothing back');
    expect(line).toContain('2.2× your $40 target');
    expect(line).toContain('Worth a look before more follows.');
  });

  it('no reference on file → the check is skipped, never guessed', () => {
    expect(
      detectMoneyOut({ ads: [ad(TODAY, 'a1', 900, 0)], today: TODAY, expectedCpa: null }),
    ).toHaveLength(0);
    expect(
      buildAccountEvents(input({ ads: [ad(TODAY, 'a1', 900, 0)], expectedCpa: null })),
    ).toHaveLength(0);
  });

  it('respects the 3-day lookback: a recent purchase silences it, an old one does not', () => {
    const converted = detectMoneyOut({
      ads: [ad('2026-08-05', 'a1', 120, 1), ad(TODAY, 'a1', 200, 0)],
      today: TODAY,
      expectedCpa: 40,
    });
    expect(converted).toHaveLength(0);

    // 2026-08-03 is 4 days back — outside the 3-day window.
    const stale = detectMoneyOut({
      ads: [ad('2026-08-03', 'a1', 120, 5), ad(TODAY, 'a1', 200, 0)],
      today: TODAY,
      expectedCpa: 40,
    });
    expect(stale).toHaveLength(1);
    expect(stale[0]!.priorPurchases).toBe(0);
  });

  it('a purchase TODAY silences it, however much has been spent', () => {
    expect(
      detectMoneyOut({ ads: [ad(TODAY, 'a1', 900, 1)], today: TODAY, expectedCpa: 40 }),
    ).toHaveLength(0);
  });

  it('judges the CREATIVE, not the ad id: copies pool their money and their results', () => {
    // Live rehearsal, BFM 2026-07-22: "2607_AnimatedSpeech_HookA" existed three
    // times and produced three near-identical lines. One creative, one line.
    const copies = [
      ad(TODAY, 'z9', 549, 0),
      ad(TODAY, 'm5', 217, 0),
      ad(TODAY, 'a1', 127, 0),
    ].map((r) => ({ ...r, ad_name: '2607_AnimatedSpeech_HookA' }));

    const hits = detectMoneyOut({ ads: copies, today: TODAY, expectedCpa: 40 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.adId).toBe('a1'); // smallest id → stable dedupe key
    expect(hits[0]!.adIds).toEqual(['a1', 'm5', 'z9']);
    expect(hits[0]!.spendToday).toBe(893);
    expect(hits[0]!.multiple).toBeCloseTo(22.325, 3);

    const line = buildAccountEvents(input({ ads: copies }))[0]!.line;
    expect(line).toContain('$893 spent, nothing back');
    expect(line).toContain('"2607_AnimatedSpeech_HookA" (3 ad sets)');

    // A converting copy pays for its siblings — the creative is not scolded.
    const withOneWinner = [...copies.slice(0, 2), { ...copies[2]!, purchases: 2 }];
    expect(
      detectMoneyOut({ ads: withOneWinner, today: TODAY, expectedCpa: 40 }),
    ).toHaveLength(0);
  });
});

describe('rule 3 — the account went dark', () => {
  const ok = {
    yesterdaySpend: 1200,
    todaySpend: 0,
    todayDataPresent: true,
    hourLocal: 13,
  };

  it('needs yesterday-spend AND zero today AND past noon', () => {
    expect(detectAccountDark(ok)).toBe(true);
    expect(detectAccountDark({ ...ok, hourLocal: 11 })).toBe(false); // too early to judge silence
    expect(detectAccountDark({ ...ok, yesterdaySpend: 0 })).toBe(false); // nothing was running
    expect(detectAccountDark({ ...ok, todaySpend: 12 })).toBe(false); // it is delivering
  });

  it('no rows at all is a sync gap, never a delivery claim', () => {
    expect(detectAccountDark({ ...ok, todayDataPresent: false })).toBe(false);
  });

  it('the line hedges — it never declares the account paused', () => {
    const events = buildAccountEvents(input({ todaySpend: 0, hourLocal: 13 }));
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('account-dark');
    expect(events[0]!.entityId).toBe('act_123');
    expect(events[0]!.line).toBe(
      '🌑 Brain.fm spent $1,200 yesterday but has no delivery recorded so far today (as of 13:40 local) — either paused deliberately or worth checking.',
    );
  });
});

describe('dedupe — the second pulse of the day repeats nothing', () => {
  it('skips every event already on the ledger for this account-local day', () => {
    const base = input({
      newAds: [{ adId: 'a1', adName: 'New One', spend: 60, results: 0 }],
      ads: [ad(TODAY, 'a2', 200, 0)],
    });
    expect(buildAccountEvents(base).map((e) => e.kind)).toEqual(['new-ad', 'money-out']);

    const second = buildAccountEvents({
      ...base,
      alreadyPinged: new Set([pulseKey('a1', 'new-ad'), pulseKey('a2', 'money-out')]),
    });
    expect(second).toHaveLength(0);
    expect(renderPulse(second, new Date('2026-08-07T11:40:00Z'))).toBe('');
  });
});

describe('silence and framing', () => {
  it('a quiet account produces no events and no text', () => {
    const events = buildAccountEvents(input({ ads: [ad(TODAY, 'a1', 50, 2)] }));
    expect(events).toHaveLength(0);
    expect(renderPulse(events, new Date('2026-08-07T11:40:00Z'))).toBe('');
  });

  it('every line is a partial-day claim ("so far"), never a day verdict', () => {
    const events = [
      ...buildAccountEvents(
        input({
          newAds: [{ adId: 'a1', adName: 'New One', spend: 60, results: 0 }],
          ads: [ad(TODAY, 'a2', 200, 0)],
        }),
      ),
      ...buildAccountEvents(
        input({
          clientCode: 'PL',
          pilotName: 'Press London',
          accountLabel: 'PL3',
          adAccountId: 'act_999',
          currency: 'GBP',
          todaySpend: 0,
          hourLocal: 14,
          asOfLocal: '14:05',
        }),
      ),
    ];
    expect(events).toHaveLength(3);
    for (const e of events) {
      expect(e.line).toContain('so far');
      // A day verdict would grade the day ("CPA — inside your happy band").
      expect(e.line).not.toContain('CPA —');
      expect(e.line.toLowerCase()).not.toContain('yesterday:');
    }

    const text = renderPulse(events, new Date('2026-08-07T11:40:00Z'));
    expect(text.startsWith('⚡ *Intraday pulse* — Friday, August 7')).toBe(true);
    expect(text).toContain('*Brain.fm*');
    expect(text).toContain('*Press London — PL3*');
    expect(text).toContain('£1,200'); // per-account currency, never hardcoded
  });
});
