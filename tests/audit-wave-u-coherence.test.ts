import { describe, expect, it } from 'vitest';
import { readAccountLens } from '../src/audit/account-model.js';
import { resolveAuditWindow } from '../src/audit/audit-window.js';
import { rankTopAds, readRetiredEarners } from '../src/audit/cold-creative-source.js';
import { buildColdRows, type RawAdDay } from '../src/audit/cold-source.js';
import {
  type AuditSection,
  deferHomepageAdvice,
  enforceQuietSection,
  lensBrief,
  workLineFor,
} from '../src/audit/magic-audit.js';
import { unifyCostWord } from '../src/audit/prose.js';
import {
  agingTopSpender,
  computeCohorts,
  computeConcentration,
  computeCostTrend,
  computeFatigue,
  costWordForLens,
  type PackAccountRow,
  type PackAdRow,
} from '../src/audit/report-pack.js';
import {
  type AdsetConfigLite,
  computeAudienceBreakdown,
  computeCreativeDiversity,
  computeLandingPages,
  computeLearningLimited,
  computePlacementBreakdown,
  computeSaturation,
  computeTargetingSplit,
  computeWhatsWorking,
  type DeadUrlCheck,
  type DemoInsightRow,
  type LandingAdRow,
  type PlacementInsightRow,
  type TargetingSpecLite,
  type WeeklyReachRow,
} from '../src/audit/report-pack-extra.js';
import { buildWorkLedger, type WorkLedgerInputs } from '../src/audit/work-ledger.js';

/**
 * The coherence wave (2026-08-21 reader test). Every case here is a sentence a
 * reader could hold against another sentence in the same report: two chapters
 * disagreeing about the same creative, two words for the same cost, an action
 * row under a chapter that found nothing, a protect list that named nobody.
 *
 * The anchor fixture is the same lead-gen account the reader test ran against:
 * leads, no purchase revenue, so kpiMode 'cpr' everywhere.
 */

const DAY = 86_400_000;
const dayISO = (i: number): string => new Date(Date.UTC(2026, 4, 1) + i * DAY).toISOString().slice(0, 10);

/** One ad's daily rows: constant spend, a lead count that may change at the halfway mark. */
function adRun(
  adId: string,
  name: string,
  days: number,
  spendPerDay: number,
  leadsPerDay: (dayIndex: number) => number,
  startDay = 0,
): PackAdRow[] {
  return Array.from({ length: days }, (_, i) => ({
    ad_id: adId,
    ad_name: name,
    adset_id: `set-${adId}`,
    date: dayISO(startDay + i),
    spend: spendPerDay,
    impressions: 5_000,
    purchases: 0,
    purchase_value: 0,
    results: 0,
    frequency: 1.8,
    hook_rate: 0.24,
    hold_rate: 0.11,
    leads: leadsPerDay(i),
  }));
}

// 90 days ending on day 89. The evergreen holds its cost per lead the whole way;
// the hero collapses in its second half and is the account's biggest spender.
const EVERGREEN_DAYS = 90;
const evergreenRows = adRun('ev', 'Quote Form v3', EVERGREEN_DAYS, 100, () => 5);
const heroRows = adRun('hero', 'Hero Video 4x5', EVERGREEN_DAYS, 300, (i) => (i < EVERGREEN_DAYS / 2 ? 10 : 2));

describe('the protect list reads the field the fatigue chapter actually emits', () => {
  const fatigue = computeFatigue([...evergreenRows, ...heroRows], 1.0, 'USD');

  it('classifies the steady ad as evergreen, on the row and in the count', () => {
    const d = fatigue.data as { ads: Array<{ ad_name: string; class: string }>; evergreen_count: number };
    expect(d.evergreen_count).toBe(1);
    expect(d.ads.find((a) => a.ad_name === 'Quote Form v3')?.class).toBe('evergreen');
    // The list the old protect read looked for was never on this wire.
    expect((fatigue.data as Record<string, unknown>).evergreen).toBeUndefined();
  });

  it('names that ad, its spend and the two figures that prove it', () => {
    const s = computeWhatsWorking(
      fatigue.data as Parameters<typeof computeWhatsWorking>[0],
      { angles: [], kpi_mode: 'cpr', kpi_label: 'cost per lead' },
      [],
      'USD',
    );
    expect(s.summary).toContain('"Quote Form v3"');
    expect(s.summary).toContain('days live');
    expect(s.summary).toMatch(/cost per lead \d+\.\d\d USD then \d+\.\d\d USD/);
    expect(s.next_step).toContain('Do NOT refresh "Quote Form v3" on a calendar');
    const d = s.data as { top_evergreen: { ad_name: string; proof: string | null } | null };
    expect(d.top_evergreen?.ad_name).toBe('Quote Form v3');
    expect(d.top_evergreen?.proof).toContain('cost per lead');
  });

  it('an evergreen that has stopped spending is not something to protect now', () => {
    const s = computeWhatsWorking(
      { ads: [{ ad_name: 'Old Winner', spend: 9_000, spend_30d: 0, in_window_age_days: 120, class: 'evergreen' }], kpi_mode: 'cpr' },
      undefined,
      [],
      'USD',
    );
    expect(s.summary).not.toContain('Old Winner');
    expect((s.data as { top_evergreen: unknown }).top_evergreen).toBeNull();
  });

  it('the empty branch still says which currency the report is in', () => {
    const s = computeWhatsWorking(undefined, undefined, [], 'EUR');
    expect((s.data as { currency: string }).currency).toBe('EUR');
  });

  it('uses the same word for a winner as the creative chips do', () => {
    const empty = computeWhatsWorking(undefined, undefined, [], 'EUR');
    const full = computeWhatsWorking(fatigue.data as Parameters<typeof computeWhatsWorking>[0], undefined, [], 'USD');
    for (const text of [empty.summary, full.summary]) {
      expect(text).toContain('winner');
      expect(text).not.toContain('clears the bar');
    }
  });
});

describe('the cadence read does not praise a rhythm the biggest spender is not in', () => {
  // Six months of ad-level history: enough for the cohort read to be graded.
  const rows180 = [
    ...Array.from({ length: 150 }, (_, i) => ({ ad_id: 'old', date: dayISO(i), spend: 50 })),
    ...Array.from({ length: 40 }, (_, i) => ({ ad_id: 'hero', date: dayISO(110 + i), spend: 300 })),
  ];

  it('reads a healthy rhythm when no top spender is on the way down', () => {
    const s = computeCohorts(rows180);
    expect(s.summary).toContain('a healthy refresh rhythm');
    expect((s.data as { signal: boolean }).signal).toBe(false);
    expect(s.next_step).toBeUndefined();
  });

  it('qualifies it, and names the ad, when fatigue flags the top spender', () => {
    const s = computeCohorts(rows180, {
      ads: [
        { ad_name: 'Hero Video 4x5', spend_30d: 9_000, class: 'fatiguing' },
        { ad_name: 'Quote Form v3', spend_30d: 3_000, class: 'evergreen' },
      ],
    });
    expect(s.summary).not.toContain('healthy refresh rhythm');
    expect(s.summary).toContain('"Hero Video 4x5"');
    expect(s.summary).toContain('fatiguing list');
    // The ask (and the deadline) stay with the fatigue chapter.
    expect(s.next_step).toBeUndefined();
    expect(s.summary).toContain('The fatigue chapter has the replacement deadline');
    expect((s.data as { signal: boolean }).signal).toBe(true);
  });

  it('a declining-but-unconfirmed top spender counts too, in its own word', () => {
    const s = computeCohorts(rows180, { ads: [{ ad_name: 'Hero Video 4x5', spend_30d: 9_000, class: 'declining_unconfirmed' }] });
    expect(s.summary).toContain("fatigue chapter's declining list");
  });

  it('a stable top spender leaves the read exactly as it was', () => {
    const plain = computeCohorts(rows180);
    const withStable = computeCohorts(rows180, { ads: [{ ad_name: 'Hero Video 4x5', spend_30d: 9_000, class: 'stable' }] });
    expect(withStable.summary).toBe(plain.summary);
    expect(agingTopSpender({ ads: [{ ad_name: 'x', spend_30d: 10, class: 'stable' }] })).toBeNull();
    expect(agingTopSpender({ ads: [{ ad_name: 'x', spend_30d: 0, class: 'fatiguing' }] })).toBeNull();
  });
});

describe('one chapter owns the homepage advice', () => {
  const rows: LandingAdRow[] = [
    { ad_id: 'a1', spend: 6_000, purchases: 0, purchase_value: 0, leads: 300, landing_page_path: '/' },
    { ad_id: 'a2', spend: 900, purchases: 0, purchase_value: 0, leads: 40, landing_page_path: '/quote' },
  ];
  const checks: DeadUrlCheck[] = [
    { url: 'https://example.com/', verdict: 'ok', status: 200, daily_burn: 0, ads: ['a1'] },
    { url: 'https://example.com/quote', verdict: 'ok', status: 200, daily_burn: 0, ads: ['a2'] },
  ];
  const landing = (): AuditSection => {
    const s = computeLandingPages(rows, checks, 'USD', 'cpr');
    return { key: 'landing_pages', title: 'Landing Pages', status: 'complete', ...s };
  };
  const walk = (verdict: string): AuditSection => ({
    key: 'message_match',
    title: 'Ad Promise vs Landing Page',
    status: 'complete',
    data: { verdict },
  });

  it('the landing chapter asks for the move while nothing else has read the page', () => {
    const s = landing();
    expect(s.next_step).toContain('Move the homepage traffic');
    expect((s.data as { homepage_advice?: boolean }).homepage_advice).toBe(true);
    expect(deferHomepageAdvice(s, undefined)).toBe(s);
    expect(deferHomepageAdvice(s, walk('inconclusive'))).toBe(s);
  });

  it('and hands the call over once the ad-promise chapter has a verdict', () => {
    for (const verdict of ['mismatch', 'partial', 'matched']) {
      const out = deferHomepageAdvice(landing(), walk(verdict));
      expect(out.next_step).toBeUndefined();
      expect(out.summary).toContain('"Ad Promise vs Landing Page" chapter, which owns that call');
      expect((out.data as { homepage_advice_deferred_to?: string }).homepage_advice_deferred_to).toBe('message_match');
    }
  });

  it('a dead URL is a different finding and keeps its own action row', () => {
    const dead: DeadUrlCheck[] = [
      { url: 'https://example.com/', verdict: 'dead', status: 404, daily_burn: 200, ads: ['a1'] },
      { url: 'https://example.com/quote', verdict: 'ok', status: 200, daily_burn: 0, ads: ['a2'] },
    ];
    const s = computeLandingPages(rows, dead, 'USD', 'cpr');
    expect(s.next_step).toContain('Pause the ad');
    expect((s.data as { homepage_advice?: boolean }).homepage_advice).toBeUndefined();
    const section: AuditSection = { key: 'landing_pages', title: 'Landing Pages', status: 'complete', ...s };
    expect(deferHomepageAdvice(section, walk('mismatch'))).toBe(section);
  });
});

describe('the auction chapter tells one click-rate story', () => {
  const accRow = (i: number, cpm: number, ctr: number): PackAccountRow => ({
    date: new Date(Date.UTC(2026, 4, 1) + i * DAY).toISOString().slice(0, 10),
    spend: Math.round((100_000 / 1000) * cpm),
    impressions: 100_000,
    clicks: Math.round(100_000 * (ctr / 100)),
    link_clicks: Math.round(100_000 * (ctr / 100)),
    purchases: 0,
    purchase_value: 0,
    results: 0,
    leads: 52,
  });
  const s = computeCostTrend(
    Array.from({ length: 98 }, (_, i) => accRow(i, 9 + (2.1 * i) / 97, 1.3 - (0.78 * i) / 97)),
    'USD',
  );

  it('quotes the thirds averages and nothing else', () => {
    const d = s.data as { cpm_chart_delta_pct: number; ctr_chart_delta_pct: number; delta_basis: string };
    expect(d.delta_basis).toBe('thirds_average');
    expect(s.summary).toContain('every percentage in this chapter is that same comparison');
    // Both bases stay on the wire; only one of them is allowed in a sentence.
    expect(typeof d.cpm_chart_delta_pct).toBe('number');
    expect(s.summary).not.toContain(`${d.cpm_chart_delta_pct}%`);
    expect(s.summary).not.toContain(`${d.ctr_chart_delta_pct}%`);
  });

  it('still names the basis it did quote, so a reader can check it', () => {
    const d = s.data as { delta_first_weeks: number; delta_last_weeks: number };
    expect(s.summary).toContain(`averaging the first ${d.delta_first_weeks} weeks against the last ${d.delta_last_weeks}`);
  });
});

describe('one cost word per audit', () => {
  it('the lens picks it once, and refuses to pick one it cannot', () => {
    expect(costWordForLens('lead_gen')).toBe('cost per lead');
    expect(costWordForLens('ecommerce')).toBe('Meta CPA');
    expect(costWordForLens('mixed')).toBeNull();
    expect(costWordForLens('unknown')).toBeNull();
    expect(costWordForLens(null)).toBeNull();
  });

  it('rewrites every variant of the same number into that one word', () => {
    const text = 'Meta CPL 18.59 USD on the hero, a cost per result of 22.10 on the rest, and CPL 30.00 on the new test.';
    const out = unifyCostWord(text, 'cost per lead');
    // Capitalised where it opens the sentence, lower case inside one.
    expect(out).toBe(
      'Cost per lead 18.59 USD on the hero, a cost per lead of 22.10 on the rest, and cost per lead 30.00 on the new test.',
    );
    expect(out).not.toMatch(/\bCPL\b/);
    expect(out).not.toContain('cost per result');
  });

  it('capitalises it at the start of a sentence and leaves it alone mid-sentence', () => {
    expect(unifyCostWord('CPL is 18.59. CPL held.', 'cost per lead')).toBe('Cost per lead is 18.59. Cost per lead held.');
    expect(unifyCostWord('The CPL is 18.59.', 'cost per lead')).toBe('The cost per lead is 18.59.');
  });

  it('is idempotent, and a no-op when the lens could not pick a word', () => {
    const once = unifyCostWord('Meta CPL 18.59', 'cost per lead');
    expect(unifyCostWord(once, 'cost per lead')).toBe(once);
    expect(unifyCostWord('Meta CPL 18.59', null)).toBe('Meta CPL 18.59');
  });

  it('is stated as a rule to the synthesis, in the lens brief', () => {
    const leadGen = lensBrief(readAccountLens({ spend: 5_577, impressions: 1, purchases: 0, purchase_value: 0, leads: 300, complete_registrations: 0, add_to_carts: 0, checkouts_initiated: 0, content_views: 0 }));
    expect(leadGen).toContain('COST WORD');
    expect(leadGen).toContain('"cost per lead"');
  });
});

describe('plain words instead of key-man risk', () => {
  const rows = [
    ...adRun('a1', 'hero', 30, 700, () => 2),
    ...adRun('a2', 'second', 30, 100, () => 2),
    ...adRun('a3', 'third', 30, 100, () => 2),
    ...adRun('a4', 'fourth', 30, 50, () => 2),
  ];
  const s = computeConcentration(rows);

  it('says what actually happens instead, in every string it writes', () => {
    const strings = [s.summary, s.next_step ?? '', s.derivation ?? '', ...(s.warnings ?? [])];
    for (const str of strings) expect(str.toLowerCase()).not.toContain('key-man');
    expect(s.summary).toContain('one ad carries the account');
    expect((s.data as { band: string }).band).toBe('high');
  });
});

describe('a section either carries a real ask or reads as clean', () => {
  const quietOf = (section: { summary: string; next_step?: string; data: Record<string, unknown> }): AuditSection =>
    enforceQuietSection({ key: 'k', title: 't', status: 'complete', ...section });

  it('a sane placement split asks for nothing', () => {
    const rows: PlacementInsightRow[] = [
      { publisher_platform: 'facebook', platform_position: 'feed', spend: 6_000, impressions: 900_000, purchases: 0, purchase_value: 0, leads: 300 },
      { publisher_platform: 'instagram', platform_position: 'feed', spend: 3_000, impressions: 400_000, purchases: 0, purchase_value: 0, leads: 120 },
    ];
    const s = computePlacementBreakdown(rows, 'USD');
    expect(s.next_step).toBeUndefined();
    expect((s.data as { signal: boolean }).signal).toBe(false);
    expect(quietOf(s).next_step).toBeUndefined();
  });

  it('Audience Network taking a real slice of budget still gets its ask', () => {
    const rows: PlacementInsightRow[] = [
      { publisher_platform: 'facebook', platform_position: 'feed', spend: 6_000, impressions: 900_000, purchases: 0, purchase_value: 0, leads: 300 },
      { publisher_platform: 'audience_network', platform_position: 'classic', spend: 1_500, impressions: 900_000, purchases: 0, purchase_value: 0, leads: 20 },
    ];
    const s = computePlacementBreakdown(rows, 'USD');
    expect(s.next_step).toContain('Audience Network is');
    expect((s.data as { signal: boolean }).signal).toBe(true);
  });

  it('budget already following the best-returning cells says nothing with no number in it', () => {
    const demo: DemoInsightRow[] = [
      { age: '25-34', gender: 'female', spend: 6_000, impressions: 800_000, purchases: 0, purchase_value: 0, leads: 400 },
      { age: '35-44', gender: 'female', spend: 2_000, impressions: 300_000, purchases: 0, purchase_value: 0, leads: 40 },
    ];
    const s = computeAudienceBreakdown(demo, [], 'USD');
    expect(s.next_step).toBeUndefined();
    expect((s.data as { signal: boolean }).signal).toBe(false);
    // The old line here was a banned phrase, which is how it was found.
    expect(JSON.stringify(s)).not.toContain('nothing to force here');
  });

  it('a current-era targeting split carries no action row', () => {
    const broad = (id: string): TargetingSpecLite => ({
      adset_id: id,
      adset_name: `Broad ${id}`,
      effective_status: 'ACTIVE',
      advantage_audience: false,
      has_custom_audiences: false,
      has_lookalikes: false,
      has_interests: false,
      age_min: null,
      age_max: null,
      genders: null,
    });
    const specs: TargetingSpecLite[] = [broad('s1'), broad('s2')];
    const spend = new Map([['s1', 5_000], ['s2', 3_000]]);
    const kpi = new Map([['s1', { value: 0, results: 250 }], ['s2', { value: 0, results: 150 }]]);
    const s = computeTargetingSplit(specs, spend, kpi, adRun('a', 'a', 5, 100, () => 5), 'USD');
    expect(s.next_step).toBeUndefined();
    expect((s.data as { signal: boolean }).signal).toBe(false);
  });

  it('every ad set clearing the learning bar is the chapter reading clean', () => {
    const adsets: AdsetConfigLite[] = [
      { adset_id: 's1', adset_name: 'Broad', optimization_goal: 'OFFSITE_CONVERSIONS', custom_event_type: 'LEAD', effective_status: 'ACTIVE' },
      { adset_id: 's2', adset_name: 'Broad 2', optimization_goal: 'OFFSITE_CONVERSIONS', custom_event_type: 'LEAD', effective_status: 'ACTIVE' },
    ];
    const weekly = new Map([['s1', 120], ['s2', 90]]);
    const spend = new Map([['s1', 4_000], ['s2', 3_000]]);
    const clean = computeLearningLimited(adsets, weekly, spend, 'USD');
    expect(clean.next_step).toBeUndefined();
    expect((clean.data as { signal: boolean }).signal).toBe(false);

    const starved = computeLearningLimited(adsets, new Map([['s1', 10], ['s2', 90]]), spend, 'USD');
    expect(starved.next_step).toContain('Consolidate');
    expect((starved.data as { signal: boolean }).signal).toBe(true);
  });

  it('headroom left in the audience is clean, a squeeze is a finding', () => {
    const flat: WeeklyReachRow[] = Array.from({ length: 12 }, (_, i) => ({
      week: dayISO(i * 7),
      reach: 100_000,
      impressions: 180_000,
      spend: 2_000,
    }));
    const s = computeSaturation(flat, 'USD');
    expect(s.next_step).toBeUndefined();
    expect((s.data as { signal: boolean }).signal).toBe(false);
  });

  it('a workable angle spread is clean, a fragile one is a finding', () => {
    const rows = [
      ...adRun('a1', 'one', 10, 100, () => 5),
      ...adRun('a2', 'two', 10, 100, () => 5),
      ...adRun('a3', 'three', 10, 100, () => 5),
    ];
    const spread = computeCreativeDiversity(
      rows,
      new Map([['a1', 'education'], ['a2', 'price'], ['a3', 'proof']]),
      'USD',
    );
    expect(spread.next_step).toBeUndefined();
    expect((spread.data as { signal: boolean }).signal).toBe(false);

    const fragile = computeCreativeDiversity(rows, new Map([['a1', 'education'], ['a2', 'education'], ['a3', 'education']]), 'USD');
    expect(fragile.next_step).toContain('Brief 2 genuinely different angles');
    expect((fragile.data as { signal: boolean }).signal).toBe(true);
  });

  it('a healthy concentration spread keeps its reading and drops the reminder', () => {
    const rows = Array.from({ length: 8 }, (_, i) => adRun(`a${i}`, `ad ${i}`, 30, 100, () => 5)).flat();
    const s = computeConcentration(rows);
    expect((s.data as { band: string }).band).toBe('healthy');
    expect(s.next_step).toBeUndefined();
    expect(s.summary).toContain('healthy spread');
  });
});

describe('the work receipt names the axis it actually plotted', () => {
  const section = (key: string, over: Partial<AuditSection> = {}): AuditSection => ({
    key,
    title: key,
    status: 'complete',
    ...over,
  });
  const base = (sections: Record<string, AuditSection>): WorkLedgerInputs => ({
    sections,
    window: resolveAuditWindow({ asOf: '2026-08-20', lastSpendDate: '2026-08-19' }),
    adsRead: 0,
    daysRead: 0,
    coreDaysCovered: 0,
    retiredAdsFound: 0,
    insightsRanked: 0,
    scorecardDimensions: 0,
  });

  it('says cost per lead on a lead-gen account, where there is no return', () => {
    const scatter = section('budget_scatter', {
      data: { ads_plotted: 8, kpi_mode: 'cpr', y_axis: 'cost_per_result', result_noun: 'lead' },
    });
    expect(buildWorkLedger(base({ budget_scatter: scatter })).map((r) => r.line)).toContain(
      'Plotted spend against cost per lead for 8 ads',
    );
    expect(workLineFor('budget_scatter', scatter)).toBe('Plotted spend against cost per lead for 8 ads');
  });

  it('falls back to the plain noun when the lens never named one', () => {
    const scatter = section('budget_scatter', { data: { ads_plotted: 3, kpi_mode: 'cpr', y_axis: 'cost_per_result' } });
    expect(workLineFor('budget_scatter', scatter)).toBe('Plotted spend against cost per result for 3 ads');
  });

  it('keeps the return wording on an account that has one', () => {
    const scatter = section('budget_scatter', { data: { ads_plotted: 12, kpi_mode: 'roas', y_axis: 'roas' } });
    expect(buildWorkLedger(base({ budget_scatter: scatter })).map((r) => r.line)).toContain(
      'Plotted spend against return for 12 ads',
    );
    expect(workLineFor('budget_scatter', scatter)).toBe('Plotted spend against return for 12 ads');
  });
});

describe('the creative read is selected from the anchored window, not the calendar', () => {
  const ASOF = '2026-08-20';
  const LAST_SPEND = '2026-07-20';
  const raw = (adId: string, date: string, spend: number): RawAdDay => ({
    ad_id: adId,
    ad_name: `ad-${adId}`,
    adset_id: `set-${adId}`,
    date_start: date,
    spend: String(spend),
    impressions: '10000',
    clicks: '200',
    frequency: '1.8',
    actions: [{ action_type: 'lead', value: '4' }],
    action_values: [],
  });
  const run = (adId: string, from: string, to: string, spendPerDay: number): RawAdDay[] => {
    const out: RawAdDay[] = [];
    for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
      out.push(raw(adId, d.toISOString().slice(0, 10), spendPerDay));
    }
    return out;
  };
  // Dormant: it ran hard into 20 Jul and stopped. The calendar's last 30 days
  // hold nothing at all, which used to mean no creative was read.
  const rows = buildColdRows({
    asOf: ASOF,
    adDays: [
      ...run('summer', '2026-06-25', LAST_SPEND, 200),
      ...run('summer-b', '2026-07-01', LAST_SPEND, 90),
      ...run('spring', '2026-05-01', '2026-05-20', 300),
    ],
  });

  it('anchors the core window to the last day the account itself spent', () => {
    expect(rows.window.anchored).toBe(true);
    expect(rows.window.anchorDate).toBe(LAST_SPEND);
  });

  it('still has top creatives to analyse, ranked by spend inside that window', () => {
    const core = rows.packRows90.filter((r) => r.date >= rows.window.coreStart && r.date <= rows.window.anchorDate);
    const top = rankTopAds(core, 10);
    expect(top.ads.length).toBe(2);
    expect(top.ads.map((a) => a.ad_id)).toEqual(['summer', 'summer-b']);
    expect(top.ads[0]!.spend).toBeGreaterThan(0);
    // The calendar-30-days selection this replaced: nothing to read at all.
    const calendarCore = rows.packRows90.filter((r) => r.date >= '2026-07-21');
    expect(rankTopAds(calendarCore, 10).ads).toHaveLength(0);
  });

  it('the earned-before split is measured against the same anchored window', () => {
    const retired = readRetiredEarners(rows.sixMonthAds, { anchorDate: rows.window.anchorDate });
    expect(retired.ads.map((a) => a.ad_id)).toEqual(['spring']);
    // The ads still running in the anchored window are never "earned before".
    for (const ad of retired.ads) expect(ad.last_spend_date! < rows.window.coreStart).toBe(true);
  });
});
