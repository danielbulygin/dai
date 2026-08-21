import { describe, it, expect } from 'vitest';
import {
  computeLandingPages,
  computeWhatsWorking,
  computeAccountFacts,
  type LandingAdRow,
  type DeadUrlCheck,
} from '../src/audit/report-pack-extra.js';
import { buildScorecard, type ScorecardEntry } from '../src/audit/scorecard.js';

/**
 * Customer-simulation fixes on a live report (2026-08-21). The anchor fixture is
 * the lead-gen account the review ran against: 482 leads, 18.59 cost per lead,
 * ZERO purchases, `results` left at 0 by the bridged pull so the count rides in
 * `leads`, and therefore kpiMode 'cpr' everywhere.
 */

const LEADS = 482;
const LEAD_SPEND = 8_960; // 8,960 / 482 = 18.59 cost per lead

const leadRow = (adId: string, path: string | null, spend: number, leads: number): LandingAdRow => ({
  ad_id: adId,
  spend,
  purchases: 0,
  purchase_value: 0,
  leads,
  landing_page_path: path,
});

const check = (url: string, verdict: DeadUrlCheck['verdict'], burn: number, ads: string[]): DeadUrlCheck => ({
  url,
  verdict,
  status: verdict === 'dead' ? 404 : 200,
  daily_burn: burn,
  ads,
});

describe('computeLandingPages — the counted nouns agree with the count', () => {
  it('one destination reads singular, and the lead-gen KPI is cost per result', () => {
    const s = computeLandingPages(
      [leadRow('a', '/get-a-quote', LEAD_SPEND, LEADS)],
      [check('https://x.com/get-a-quote', 'ok', 0, ['a'])],
      'USD',
      'cpr',
    );
    expect(s.summary).toContain('1 destination carries the mapped spend');
    expect(s.summary).not.toContain('destinations carry');
    const d = s.data as { kpi_label: string; kpi_mode: string; paths: Array<{ path: string; kpi: number | null }> };
    expect(d.kpi_mode).toBe('cpr');
    expect(d.kpi_label).toBe('cost per result');
    expect(d.paths[0]!.kpi).toBeCloseTo(18.59, 2);
    expect(s.summary).toContain('cost per result 18.59');
  });

  it('two or more destinations keep the plural and the "biggest" framing', () => {
    const s = computeLandingPages(
      [leadRow('a', '/get-a-quote', 6_000, 340), leadRow('b', '/term-life', 2_960, 142)],
      [check('https://x.com/get-a-quote', 'ok', 0, ['a'])],
      'USD',
      'cpr',
    );
    expect(s.summary).toContain('2 destinations carry the mapped spend');
    expect(s.summary).toContain('biggest:');
  });

  it('one redirect bounces, several bounce', () => {
    const one = computeLandingPages(
      [leadRow('a', '/get-a-quote', LEAD_SPEND, LEADS)],
      [check('https://x.com/term-life', 'redirect_home', 0, ['a'])],
      'USD',
      'cpr',
    );
    expect(one.warnings?.some((w) => w.includes('1 destination bounces to the homepage'))).toBe(true);

    const many = computeLandingPages(
      [leadRow('a', '/get-a-quote', LEAD_SPEND, LEADS)],
      [check('https://x.com/term-life', 'redirect_home', 0, ['a']), check('https://x.com/whole-life', 'redirect_home', 0, ['b'])],
      'USD',
      'cpr',
    );
    expect(many.warnings?.some((w) => w.includes('2 destinations bounce to the homepage'))).toBe(true);
  });

  it('a single ad behind a dead URL is one ad, not "ads"', () => {
    const one = computeLandingPages(
      [leadRow('a', '/get-a-quote', LEAD_SPEND, LEADS)],
      [check('https://x.com/gone', 'dead', 40, ['a'])],
      'USD',
      'cpr',
    );
    expect(one.warnings?.some((w) => w.includes('pause the listed ad first'))).toBe(true);
    expect(one.next_step).toContain('Pause the ad pointing at the dead URL');
    expect(one.next_step).not.toContain('Pause the ads');

    const many = computeLandingPages(
      [leadRow('a', '/get-a-quote', LEAD_SPEND, LEADS)],
      [check('https://x.com/gone', 'dead', 40, ['a', 'b'])],
      'USD',
      'cpr',
    );
    expect(many.warnings?.some((w) => w.includes('pause the listed ads first'))).toBe(true);
    expect(many.next_step).toContain('Pause the ads pointing at the dead URL');
  });
});

describe('computeWhatsWorking — the protect list names what it protects', () => {
  const angles = [
    { angle: 'peace of mind', kpi: 18.59, spend_share_pct: 62, below_floor: false },
    { angle: 'price anchor', kpi: 41.2, spend_share_pct: 21, below_floor: false },
  ];
  const leadConcept = { angles, kpi_mode: 'cpr', kpi_label: 'cost per lead' };

  it('names the single evergreen ad, its spend, its age and the best angle with its labelled figure', () => {
    const s = computeWhatsWorking(
      {
        ads: [{ ad_name: 'Quote Form v3', spend_30d: LEAD_SPEND, in_window_age_days: 74, class: 'evergreen' }],
        kpi_mode: 'cpr',
      },
      leadConcept,
      [{ key: 'hooks', dimension: 'Hooks (3s view rate)', band: 'strong', position: 'Hooks (3s view rate) — top of the desk' }],
      'USD',
    );
    expect(s.summary).toContain('"Quote Form v3"');
    expect(s.summary).toContain('8,960 USD');
    expect(s.summary).toContain('74 days live');
    // cpr picks the LOWEST cost per lead as the proven angle, with its label.
    expect(s.summary).toContain('"peace of mind" is the proven angle (cost per lead 18.59 on 62% of spend)');
    expect(s.summary).toContain('evergreen'); // the word the fatigue rule owns
    expect(s.next_step).toContain('Quote Form v3');
    expect(s.next_step).toContain('NOT refresh');
    const d = s.data as {
      top_evergreen: { ad_name: string; spend: number; days_running: number | null; proof: string | null } | null;
      best_angle: { angle: string; kpi: number | null; spend_share_pct: number } | null;
    };
    expect(d.top_evergreen).toEqual({ ad_name: 'Quote Form v3', spend: LEAD_SPEND, days_running: 74, proof: null });
    expect(d.best_angle).toEqual({ angle: 'peace of mind', kpi: 18.59, spend_share_pct: 62 });
  });

  it('with several evergreens it names the biggest one by spend', () => {
    const s = computeWhatsWorking(
      {
        ads: [
          { ad_name: 'Quote Form v3', spend_30d: 2_000, in_window_age_days: 74, class: 'evergreen' },
          { ad_name: 'Family Cover UGC', spend_30d: 6_960, in_window_age_days: 91, class: 'evergreen' },
        ],
        kpi_mode: 'cpr',
      },
      leadConcept,
      [],
      'USD',
    );
    expect(s.summary).toContain('2 evergreen winners hold 8,960 USD');
    expect(s.summary).toContain('The biggest is "Family Cover UGC" at 6,960 USD, 91 days live');
    expect(s.next_step).toContain('Family Cover UGC');
    expect((s.data as { top_evergreen: { ad_name: string } }).top_evergreen.ad_name).toBe('Family Cover UGC');
  });

  it('an evergreen with no measured age still names the ad', () => {
    const s = computeWhatsWorking(
      { ads: [{ ad_name: 'Quote Form v3', spend_30d: LEAD_SPEND, class: 'evergreen' }] },
      undefined,
      [],
      'USD',
    );
    expect(s.summary).toContain('"Quote Form v3"');
    expect(s.summary).toContain('60+ days live');
  });

  it('an empty protect list is still stated as the finding', () => {
    const s = computeWhatsWorking(undefined, undefined, [], 'USD');
    expect(s.summary).toContain('that itself is the finding');
    expect((s.data as { freshness_withheld: boolean }).freshness_withheld).toBe(false);
  });
});

describe('computeWhatsWorking — a short window cannot produce a freshness strength', () => {
  const scorecard = [
    { key: 'freshness', dimension: 'Creative freshness', band: 'strong', position: 'Creative freshness — healthy refresh rhythm (100%)' },
    { key: 'hooks', dimension: 'Hooks (3s view rate)', band: 'strong', position: 'Hooks (3s view rate) — top of the desk' },
  ];

  it('drops the freshness strength and the cohort-derived protect entry when the window is flagged short', () => {
    const s = computeWhatsWorking(undefined, undefined, scorecard, 'USD', { window_too_short: true, days_covered: 65 });
    const d = s.data as {
      strong_dimensions: Array<{ dimension: string }>;
      freshness_withheld: boolean;
      cohort_days_covered: number | null;
    };
    expect(d.strong_dimensions.map((x) => x.dimension)).toEqual(['Hooks (3s view rate)']);
    expect(d.freshness_withheld).toBe(true);
    expect(d.cohort_days_covered).toBe(65);
    expect(s.summary).toContain('1 benchmarked dimension in the strong band');
    expect(s.summary.toLowerCase()).not.toContain('freshness');
    expect(s.derivation).toContain('65 days');
  });

  it('keeps freshness when the window is not flagged', () => {
    const s = computeWhatsWorking(undefined, undefined, scorecard, 'USD');
    expect(s.summary).toContain('2 benchmarked dimensions in the strong band');
    expect((s.data as { freshness_withheld: boolean }).freshness_withheld).toBe(false);
    expect((s.data as { cohort_days_covered: number | null }).cohort_days_covered).toBe(null);
  });

  it('recognises the freshness dimension even when the entry carries no key', () => {
    const s = computeWhatsWorking(
      undefined,
      undefined,
      [{ dimension: 'Creative freshness', band: 'strong', position: 'Creative freshness — 100%' }],
      'USD',
      { window_too_short: true, days_covered: 65 },
    );
    expect(s.summary).toContain('that itself is the finding');
    expect((s.data as { freshness_withheld: boolean }).freshness_withheld).toBe(true);
  });

  it('a lead-gen protect list keeps the evergreen and the angle while the freshness grading goes', () => {
    const s = computeWhatsWorking(
      {
        ads: [{ ad_name: 'Quote Form v3', spend_30d: LEAD_SPEND, in_window_age_days: 74, class: 'evergreen' }],
        kpi_mode: 'cpr',
      },
      { angles: [{ angle: 'peace of mind', kpi: 18.59, spend_share_pct: 62, below_floor: false }], kpi_mode: 'cpr', kpi_label: 'cost per lead' },
      [{ key: 'freshness', dimension: 'Creative freshness', band: 'strong', position: 'Creative freshness — 100%' }],
      'USD',
      { window_too_short: true, days_covered: 65 },
    );
    expect(s.summary).toContain('"Quote Form v3"');
    expect(s.summary).toContain('cost per lead 18.59');
    expect(s.summary).not.toContain('benchmarked dimension');
    expect((s.data as { strong_dimensions: unknown[] }).strong_dimensions).toEqual([]);
  });
});

describe('buildScorecard — a dimension the caller omits is never invented', () => {
  it('no inputs at all is an empty scorecard, not a set of defaults', () => {
    expect(buildScorecard({})).toEqual([]);
  });

  it('omitting freshness produces no freshness entry and no strength grading from it', () => {
    const entries = buildScorecard({ concentration: { value: 65 }, cpmTrend: { value: 23 } });
    expect(entries.find((e) => e.key === 'freshness')).toBeUndefined();
    expect(entries.some((e) => e.section_key === 'creative_cohorts')).toBe(false);
    expect(entries.some((e) => e.dimension.toLowerCase().includes('freshness'))).toBe(false);
    for (const e of entries) {
      expect(e.position.toLowerCase()).not.toContain('freshness');
      expect(e.next_step).not.toContain('strength');
    }
  });

  it('an explicitly undefined freshness behaves exactly like omitting it', () => {
    const omitted = buildScorecard({ concentration: { value: 30 } });
    const explicit = buildScorecard({ concentration: { value: 30 }, freshness: undefined });
    expect(explicit).toEqual(omitted);
    expect(explicit.map((e) => e.key)).toEqual(['concentration']);
  });

  it('a supplied freshness still grades, so the drop is the caller\'s decision only', () => {
    const entries = buildScorecard({ freshness: { value: 8 } });
    expect(entries.map((e) => e.key)).toEqual(['freshness']);
    expect(entries[0]!.band).toBe('weak');
  });
});

describe('buildScorecard — the cost trajectory states the figure it was given', () => {
  const cpm = (value: number): ScorecardEntry => buildScorecard({ cpmTrend: { value } }).find((e) => e.key === 'cpm_trend')!;
  const numbersIn = (s: string): string[] => s.match(/-?\d+(?:\.\d+)?/g) ?? [];

  it('+23 never reads as flat and never turns into another number', () => {
    const e = cpm(23);
    expect(e.value).toBe(23);
    expect(e.band).toBe('weak');
    expect(e.position).toContain('CPM up 23% over the window');
    expect(e.position.toLowerCase()).not.toContain('flat');
    expect(e.position.toLowerCase()).not.toContain('falling');
    expect(numbersIn(e.position)).toEqual(['23']);
  });

  it('a fractional value is carried unchanged, never re-rounded', () => {
    const e = cpm(6.94);
    expect(e.value).toBe(6.94);
    expect(e.position).toContain('6.94%');
    expect(e.position).not.toContain('6.9%');
  });

  it('the flat band matches the cost section\'s own plus/minus 10% verdict', () => {
    expect(cpm(6.9).position.toLowerCase()).toContain('flat');
    expect(cpm(10).position.toLowerCase()).toContain('flat');
    expect(cpm(-10).position.toLowerCase()).toContain('flat');
    expect(cpm(10.1).position).toContain('CPM up 10.1%');
    expect(cpm(10.1).band).toBe('weak');
    expect(cpm(-22).position).toContain('CPM down 22% over the window');
    expect(cpm(-22).band).toBe('strong');
    expect(cpm(-22).position.toLowerCase()).not.toContain('flat');
  });

  it('the derivation says the figure came from the cost report rather than a second calculation', () => {
    expect(cpm(23).derivation).toContain('carried here unchanged');
  });
});

describe('computeAccountFacts — every sentence carries its own window, named ONE way', () => {
  const dayISO = (i: number): string => new Date(Date.UTC(2026, 3, 1) + i * 86_400_000).toISOString().slice(0, 10);
  /** A lead-gen account with 139 days of visible history: 200/day on the hero, a late test at 20/day. */
  const leadHistory = (spanDays: number) => [
    ...Array.from({ length: spanDays }, (_, i) => ({ ad_id: 'lead-hero', date: dayISO(i), spend: 200 })),
    ...Array.from({ length: 20 }, (_, i) => ({ ad_id: 'lead-test', date: dayISO(spanDays - 20 + i), spend: 20 })),
  ];

  it('states the REAL span, not a hardcoded six months', () => {
    const s = computeAccountFacts({
      rows180: leadHistory(139),
      adNames: new Map([['lead-hero', 'Quote Form v3']]),
      partnershipSpendPct: 12,
      currency: 'USD',
    });
    const d = s.data as { window_days: number; delivery_days: number; window_start: string; window_end: string };
    expect(d.window_days).toBe(139);
    expect(d.delivery_days).toBe(139);
    expect(d.window_start).toBe(dayISO(0));
    expect(d.window_end).toBe(dayISO(138));
    expect(s.summary).toContain('the 139 days we can read');
    expect(s.derivation).toContain('the 139 days we can read');
    expect(s.derivation).not.toContain('~6 months');
  });

  it('the daily average divides THIS window\'s spend by THIS window\'s day count', () => {
    const s = computeAccountFacts({ rows180: leadHistory(139), adNames: new Map(), partnershipSpendPct: null, currency: 'USD' });
    const d = s.data as { window_days: number; window_spend: number; daily_avg: number; facts: Array<{ fact: string; detail: string }> };
    // 139 days x 200 + 20 days x 20 = 28,200 over 139 days = 202.9/day.
    expect(d.window_spend).toBe(28_200);
    expect(d.window_days).toBe(139);
    expect(d.daily_avg).toBe(203);
    // The invariant the live page broke: the two halves must reconcile.
    expect(Math.abs(d.daily_avg * d.window_days - d.window_spend)).toBeLessThanOrEqual(d.window_days);
    const avgLine = d.facts.find((f) => f.detail.includes('Daily average'))!;
    expect(avgLine.detail).toContain('203 USD');
    expect(avgLine.detail).toContain('28,200 USD across the 139 days we can read');
  });

  it('every fact names the window it was measured over', () => {
    const s = computeAccountFacts({
      rows180: leadHistory(139),
      adNames: new Map([['lead-hero', 'Quote Form v3']]),
      partnershipSpendPct: 12,
      currency: 'USD',
    });
    const facts = (s.data as { facts: Array<{ fact: string }> }).facts;
    expect(facts.length).toBeGreaterThanOrEqual(5);
    for (const f of facts) {
      expect(f.fact, f.fact).toMatch(/139 days|last 30 days/);
    }
    expect(facts.some((f) => f.fact.includes('live 138 days, out of the 139 days we can read, and it is still spending'))).toBe(true);
    expect(facts.some((f) => f.fact.includes("of the last 30 days' spend runs on creative that first went live"))).toBe(true);
    expect(facts.some((f) => f.fact.includes("12% of the last 30 days' spend runs through partnership"))).toBe(true);
    expect(facts.some((f) => f.fact.includes('in the 139 days we can read; '))).toBe(true);
  });

  it('a long window still states DAYS, never a month count (the live section named one window three ways)', () => {
    const s = computeAccountFacts({ rows180: leadHistory(180), adNames: new Map(), partnershipSpendPct: null, currency: 'USD' });
    expect((s.data as { window_days: number }).window_days).toBe(180);
    const facts = (s.data as { facts: Array<{ fact: string }>; }).facts;
    const section = [s.summary, s.next_step, s.derivation ?? '', ...facts.flatMap((f) => [f.fact, f.detail])].join(' ');
    expect(section).toContain('the 180 days we can read');
    expect(section).not.toMatch(/six months|months|month window|month-window/i);
    // "90 days ago" and "the last 30 days" are OTHER windows and stay as they are.
    expect(section).toContain('90 days ago');
  });

  it('the long window is named the SAME way in every sentence of the section', () => {
    const s = computeAccountFacts({
      rows180: leadHistory(179),
      adNames: new Map([['lead-hero', 'Quote Form v3']]),
      partnershipSpendPct: 12,
      currency: 'USD',
    });
    expect((s.data as { window_days: number }).window_days).toBe(179);
    const facts = (s.data as { facts: Array<{ fact: string }> }).facts;
    const strings = [s.summary, s.next_step ?? '', s.derivation ?? '', ...facts.flatMap((f) => [f.fact, f.detail])];
    for (const str of strings) {
      expect(str, str).not.toMatch(/months?\b/i);
      // every mention of the long span uses the one phrase
      if (/179/.test(str)) expect(str, str).toContain('the 179 days we can read');
    }
    expect(strings.join(' ')).toContain('the 179 days we can read');
  });
});
