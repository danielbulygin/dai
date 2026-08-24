import { describe, it, expect } from 'vitest';
import {
  ANCHOR_GRACE_DAYS,
  anchoredWindowBrief,
  anchoredWindowNote,
  anchorWindowWords,
  lastSpendDateOf,
  resolveAuditWindow,
  SIX_MONTH_DAYS,
} from '../src/audit/audit-window.js';
import { buildColdRows, type ColdRows, type RawAdDay } from '../src/audit/cold-source.js';
import { readRetiredEarners } from '../src/audit/cold-creative-source.js';
import { computeConcentration } from '../src/audit/report-pack.js';
import { mapDeepStrings } from '../src/audit/prose.js';
import { buildSynthSystem, coldRecognition, summarizeDataWindow } from '../src/audit/magic-audit.js';

/**
 * The audit's window used to end on the day the run happened, so an account
 * that stopped spending in July read as an account with nothing in it. These
 * fixtures are the two accounts that matter: one dormant, one live.
 *
 * The live one is the guard rail. Its numbers and its words must come out
 * exactly as they did before any of this existed, because anchoring is only
 * allowed to change the report of an account it is true about.
 */

const ASOF = '2026-08-20';

const shift = (from: string, days: number): string => {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

function adDay(adId: string, date: string, spend: number): RawAdDay {
  return {
    ad_id: adId,
    ad_name: `ad-${adId}`,
    adset_id: `set-${adId}`,
    date_start: date,
    spend: String(spend),
    impressions: '10000',
    clicks: '200',
    frequency: '1.8',
    actions: [
      { action_type: 'lead', value: '4' },
      { action_type: 'link_click', value: '180' },
      { action_type: 'landing_page_view', value: '150' },
    ],
    action_values: [],
  };
}

/** One ad's run, one row per day, inclusive of both ends. */
function run(adId: string, from: string, to: string, spendPerDay: number): RawAdDay[] {
  const out: RawAdDay[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(adDay(adId, d.toISOString().slice(0, 10), spendPerDay));
  }
  return out;
}

// A dormant account: it ran hard through June and July, stopped on 20 Jul, and
// ran a different set of ads back in May. Today is 20 Aug, so the calendar's
// "last 30 days" holds nothing at all.
const DORMANT_LAST_SPEND = '2026-07-20';
const dormantAdDays: RawAdDay[] = [
  ...run('summer', '2026-06-25', DORMANT_LAST_SPEND, 100),
  ...run('spring', '2026-05-01', '2026-05-20', 60),
];

// A live account: spending yesterday, which is inside the grace window.
const freshAdDays: RawAdDay[] = [
  ...run('now', shift(ASOF, 20), shift(ASOF, 1), 100),
  ...run('older', shift(ASOF, 120), shift(ASOF, 100), 40),
];

describe('resolveAuditWindow', () => {
  it('anchors to the last spending day once it is past the grace window', () => {
    const w = resolveAuditWindow({ asOf: ASOF, lastSpendDate: DORMANT_LAST_SPEND });
    expect(w.anchored).toBe(true);
    expect(w.anchorDate).toBe(DORMANT_LAST_SPEND);
    expect(w.daysSinceLastSpend).toBe(31);
    expect(w.coreStart).toBe('2026-06-20');
    expect(w.ninetyStart).toBe('2026-04-21');
    // The six-month read stays on the calendar: it places creative in time.
    expect(w.sixMonthStart).toBe(shift(ASOF, SIX_MONTH_DAYS));
  });

  it('leaves a lull inside the grace window exactly as it was', () => {
    const inGrace = resolveAuditWindow({ asOf: ASOF, lastSpendDate: shift(ASOF, ANCHOR_GRACE_DAYS) });
    expect(inGrace.anchored).toBe(false);
    expect(inGrace.anchorDate).toBe(ASOF);
    expect(inGrace.coreStart).toBe(shift(ASOF, 30));

    const oneDayPast = resolveAuditWindow({ asOf: ASOF, lastSpendDate: shift(ASOF, ANCHOR_GRACE_DAYS + 1) });
    expect(oneDayPast.anchored).toBe(true);
  });

  it('never anchors an account that has spent nothing at all', () => {
    const w = resolveAuditWindow({ asOf: ASOF, lastSpendDate: null });
    expect(w.anchored).toBe(false);
    expect(w.anchorDate).toBe(ASOF);
  });

  it('reads the last spending day off the rows, ignoring days that only served impressions', () => {
    expect(
      lastSpendDateOf([
        { date: '2026-07-20', spend: 12 },
        { date: '2026-08-02', spend: 0 },
        { date: '2026-07-01', spend: 40 },
      ]),
    ).toBe('2026-07-20');
    expect(lastSpendDateOf([{ date: '2026-08-02', spend: 0 }])).toBeNull();
  });
});

describe('a dormant account gets a report about the days it actually ran', () => {
  const rows: ColdRows = buildColdRows({ asOf: ASOF, adDays: dormantAdDays });

  it('fills the 30-day verdicts from the anchored window instead of an empty month', () => {
    expect(rows.window.anchored).toBe(true);
    expect(rows.window.lastSpendDate).toBe(DORMANT_LAST_SPEND);
    // Before anchoring, all three of these were empty and every 30d verdict
    // downstream of them said the account had nothing in it.
    expect(rows.accFull30.length).toBeGreaterThan(0);
    expect(rows.landing30.length).toBeGreaterThan(0);
    expect(rows.daysCovered).toBe(26);
    for (const r of rows.accFull30) {
      expect(r.date >= rows.window.coreStart).toBe(true);
      expect(r.date <= rows.window.anchorDate).toBe(true);
    }
  });

  it('keeps the anchored window off the ads that stopped before it', () => {
    expect(rows.landing30.map((l) => l.ad_id)).toEqual(['summer']);
    // The 90-day read is anchored too, so May is inside it and August is not.
    expect(new Set(rows.packRows90.map((r) => r.ad_id))).toEqual(new Set(['summer', 'spring']));
    for (const r of rows.packRows90) expect(r.date <= rows.window.anchorDate).toBe(true);
  });

  it('states the date in the recognition strip, in words and in fields', () => {
    const read = coldRecognition(
      { userId: 'u', accessToken: null, adAccountId: 'act_1', accountName: 'A', currency: 'EUR', rows },
      'EUR',
    );
    expect(read).not.toBeNull();
    const r = read!.recognition;
    expect(r.last_spend_date).toBe(DORMANT_LAST_SPEND);
    expect(r.window_anchored).toBe(true);
    expect(r.window_end).toBe(DORMANT_LAST_SPEND);
    expect(r.window_start).toBe('2026-06-20');
    expect(r.window_note).toBe(
      'This account last spent on 20 Jul. Every 30-day figure reads the 30 days ending there, not the calendar month just gone.',
    );
  });

  it('names the window in the data-window label the page prints once', () => {
    const label = summarizeDataWindow(
      rows.accFull30.map((r) => r.date),
      30,
      rows.window.anchorDate,
    );
    expect(label.windowLabel).toBe('26 of the 30 days ending 20 Jul carry data');
    expect(label.caveat).toBeNull();
  });

  it('tells every synthesis which days its numbers cover', () => {
    const brief = anchoredWindowBrief(rows.window);
    expect(brief).toContain('ANCHORED WINDOW');
    expect(brief).toContain('the 30 days ending 20 Jul');
    expect(brief).toContain('31 days ago');
    expect(buildSynthSystem('', null, null, brief)).toContain('ANCHORED WINDOW');
  });

  it('rewrites the calendar phrasing inside a finished verdict', () => {
    const section = computeConcentration(rows.packRows90.filter((r) => r.date >= rows.window.coreStart));
    const anchored = mapDeepStrings(section, (text) => anchorWindowWords(text, rows.window));
    expect(section.summary).toContain("the last 30 days' spend");
    expect(anchored.summary).toContain('the spend in the 30 days ending 20 Jul');
    expect(anchored.summary).not.toContain('the last 30 days');
    expect(anchored.derivation).toContain('across the 30 days ending 20 Jul');
    // The numbers are the section's own, untouched.
    expect(anchored.data).toEqual(section.data);
  });

  it('states the note as one sentence with the date in it', () => {
    expect(anchoredWindowNote(rows.window)).toContain('last spent on 20 Jul');
  });
});

describe('a live account reads exactly as it always did', () => {
  const rows: ColdRows = buildColdRows({ asOf: ASOF, adDays: freshAdDays });

  it('does not anchor, and windows on the calendar', () => {
    expect(rows.window.anchored).toBe(false);
    expect(rows.window.anchorDate).toBe(ASOF);
    expect(rows.window.coreStart).toBe(shift(ASOF, 30));
    expect(rows.window.ninetyStart).toBe(shift(ASOF, 90));
  });

  it('windows the row sets on the calendar cuts, as before', () => {
    const cut30 = shift(ASOF, 30);
    const cut90 = shift(ASOF, 90);
    expect(rows.accFull30.map((r) => r.date)).toEqual(
      [...new Set(freshAdDays.map((r) => r.date_start!))].filter((d) => d >= cut30).sort(),
    );
    expect(new Set(rows.packRows90.map((r) => r.date))).toEqual(
      new Set(freshAdDays.map((r) => r.date_start!).filter((d) => d >= cut90)),
    );
    expect(rows.landing30.map((l) => l.ad_id)).toEqual(['now']);
  });

  it('says nothing about a window, anywhere', () => {
    const read = coldRecognition(
      { userId: 'u', accessToken: null, adAccountId: 'act_1', accountName: 'A', currency: 'EUR', rows },
      'EUR',
    );
    expect(read!.recognition.window_anchored).toBe(false);
    expect(read!.recognition.window_note).toBeUndefined();
    expect(anchoredWindowNote(rows.window)).toBeNull();
    expect(anchoredWindowBrief(rows.window)).toBeNull();
    // The prompt is the prompt it was before the window existed.
    expect(buildSynthSystem('', null, null, anchoredWindowBrief(rows.window))).toBe(buildSynthSystem('', null));
  });

  it('leaves every finished string byte-identical', () => {
    const section = computeConcentration(rows.packRows90.filter((r) => r.date >= rows.window.coreStart));
    expect(mapDeepStrings(section, (t) => anchorWindowWords(t, rows.window))).toEqual(section);
    expect(anchorWindowWords("Your top ad takes 40% of the last 30 days' spend", rows.window)).toBe(
      "Your top ad takes 40% of the last 30 days' spend",
    );
    expect(summarizeDataWindow(rows.accFull30.map((r) => r.date), 30, null).windowLabel).toBe(
      '20 of the last 30 days carry data',
    );
  });
});

describe('the six-month creative inventory', () => {
  const rows: ColdRows = buildColdRows({ asOf: ASOF, adDays: dormantAdDays });

  it('keeps an ad that earned before the core window, with its own dates', () => {
    const spring = rows.sixMonthAds.find((a) => a.ad_id === 'spring')!;
    expect(spring.spend_core).toBe(0);
    expect(spring.spend).toBe(20 * 60);
    expect(spring.first_spend_date).toBe('2026-05-01');
    expect(spring.last_spend_date).toBe('2026-05-20');
    expect(spring.spend_days).toBe(20);
    // And the ad that is inside the window is marked as inside it.
    expect(rows.sixMonthAds.find((a) => a.ad_id === 'summer')!.spend_core).toBeGreaterThan(0);
  });

  it('reports it as earned before, not running now', () => {
    const retired = readRetiredEarners(rows.sixMonthAds, { anchorDate: rows.window.anchorDate });
    expect(retired.count).toBe(1);
    expect(retired.spend).toBe(1200);
    const ad = retired.ads[0]!;
    expect(ad.ad_name).toBe('ad-spring');
    expect(ad.cpl).toBe(15); // 1200 spend / 80 leads
    expect(ad.roas).toBeNull(); // the account records no revenue, so no return is claimed
    expect(ad.days_since_spend).toBe(61);
  });

  it('drops the ads too small to be a finding, and never counts a live one', () => {
    const withNoise = buildColdRows({
      asOf: ASOF,
      adDays: [...dormantAdDays, adDay('crumb', '2026-05-05', 1)],
    });
    const retired = readRetiredEarners(withNoise.sixMonthAds, { anchorDate: withNoise.window.anchorDate });
    expect(retired.ads.map((a) => a.ad_id)).toEqual(['spring']);
    expect(retired.ads.some((a) => a.ad_id === 'summer')).toBe(false);
  });

  it('names an ad that stopped spending months ago, from the whole pull', () => {
    expect(rows.adNames['spring']).toBe('ad-spring');
  });

  it('finds nothing to retire on an account whose ads are all still running', () => {
    const live = buildColdRows({ asOf: ASOF, adDays: run('now', shift(ASOF, 10), shift(ASOF, 1), 100) });
    expect(readRetiredEarners(live.sixMonthAds, { anchorDate: live.window.anchorDate }).count).toBe(0);
  });
});

describe('the deep-dormant six-month slide', () => {
  it('keeps the calendar six months while the account is lightly dormant', () => {
    const w = resolveAuditWindow({ asOf: '2026-08-24', lastSpendDate: '2026-06-01' });
    expect(w.anchored).toBe(true);
    expect(w.sixMonthStart).toBe('2026-02-22');
  });

  it('slides the six-month read to the anchor once the silence outlasts the window', () => {
    const w = resolveAuditWindow({ asOf: '2026-08-24', lastSpendDate: '2025-05-10' });
    expect(w.anchored).toBe(true);
    expect(w.anchorDate).toBe('2025-05-10');
    expect(w.sixMonthStart).toBe('2024-11-08');
  });

  it('an account that never spent keeps every window on the calendar', () => {
    const w = resolveAuditWindow({ asOf: '2026-08-24', lastSpendDate: null });
    expect(w.anchored).toBe(false);
    expect(w.sixMonthStart).toBe('2026-02-22');
  });
});
