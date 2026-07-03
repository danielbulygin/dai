import { describe, it, expect } from 'vitest';
import {
  computePlacementBreakdown,
  computeAudienceBreakdown,
  classifyTargeting,
  computeTargetingSplit,
  computeLearningLimited,
  computeSaturation,
  computeCreativeDiversity,
  computeCohortWave,
  computeWhatsWorking,
  computeLandingPages,
  computeAccountFacts,
  type PlacementInsightRow,
  type TargetingSpecLite,
  type WeeklyReachRow,
  type LandingAdRow,
} from '../src/audit/report-pack-extra.js';
import type { PackAdRow, AdsetConfigLite } from '../src/audit/report-pack.js';

/**
 * Session G pins (the full-report-set build):
 * - AN spend is FLAGGED, never silently blended (binding, design §2).
 * - Every read suppresses honestly on thin data instead of guessing.
 * - Learning-limited uses Meta's ~50 events/week bar and reads % of spend.
 * - Saturation needs BOTH freq up AND reach efficiency down — one alone is noise.
 * - Dead URLs: only hard failures alarm; inconclusive never does.
 */

const adRow = (adId: string, spend: number, value: number, over: Partial<PackAdRow> = {}): PackAdRow => ({
  ad_id: adId, ad_name: adId, date: '2026-06-15', spend, impressions: 10_000,
  purchases: 5, purchase_value: value, results: 5, frequency: 2, hook_rate: 25, hold_rate: 10, ...over,
});

describe('computePlacementBreakdown', () => {
  const row = (platform: string, position: string, spend: number, over: Partial<PlacementInsightRow> = {}): PlacementInsightRow => ({
    publisher_platform: platform, platform_position: position, spend, impressions: spend * 100,
    purchases: Math.round(spend / 50), purchase_value: spend * 2, leads: 0, ...over,
  });

  it('flags Audience Network spend + rewarded video share (binding)', () => {
    const s = computePlacementBreakdown(
      [row('facebook', 'feed', 5000), row('instagram', 'instagram_reels', 3000), row('audience_network', 'rewarded_video', 500)],
      'EUR',
    );
    expect(s.warnings?.some((w) => w.includes('Audience Network'))).toBe(true);
    expect(s.warnings?.some((w) => w.includes('rewarded video'))).toBe(true);
    expect((s.data as { audience_network_share_pct: number }).audience_network_share_pct).toBeGreaterThan(1);
  });

  it('celebrates a clean split without inventing a problem', () => {
    const s = computePlacementBreakdown([row('facebook', 'feed', 5000), row('instagram', 'feed', 3000)], 'EUR');
    expect(s.warnings).toBeUndefined();
    expect(s.summary).toContain('No meaningful Audience Network spend');
  });

  it('suppresses on thin spend', () => {
    const s = computePlacementBreakdown([row('facebook', 'feed', 20)], 'EUR');
    expect(s.warnings?.[0]).toContain('suppressed');
  });
});

describe('computeAudienceBreakdown', () => {
  it('names the underfunded best-returning age band (the design move)', () => {
    const demo = [
      { age: '25-34', gender: 'female', spend: 6000, impressions: 400_000, purchases: 100, purchase_value: 10_000, leads: 0 },
      { age: '35-44', gender: 'female', spend: 1500, impressions: 90_000, purchases: 60, purchase_value: 6_000, leads: 0 },
    ];
    const s = computeAudienceBreakdown(demo, [], 'EUR');
    expect(s.summary).toContain('35-44');
    expect(s.summary).toContain('underfunded');
  });
});

describe('targeting classification', () => {
  const spec = (over: Partial<TargetingSpecLite>): TargetingSpecLite => ({
    adset_id: 's1', adset_name: 'set', effective_status: 'ACTIVE', advantage_audience: false,
    has_custom_audiences: false, has_lookalikes: false, has_interests: false,
    age_min: null, age_max: null, genders: null, ...over,
  });

  it('classifies by the fixed priority rule', () => {
    expect(classifyTargeting(spec({ advantage_audience: true, has_interests: true }))).toBe('Advantage+ audience');
    expect(classifyTargeting(spec({ has_custom_audiences: true }))).toBe('Retargeting (custom audiences)');
    expect(classifyTargeting(spec({ has_custom_audiences: true, has_lookalikes: true }))).toBe('Lookalike');
    expect(classifyTargeting(spec({ has_interests: true }))).toBe('Interest-targeted');
    expect(classifyTargeting(spec({}))).toBe('Broad');
  });

  it('warns on gender restriction and heavy interest spend', () => {
    const specs = [
      spec({ adset_id: 'a', has_interests: true, genders: 'female' }),
      spec({ adset_id: 'b' }),
    ];
    const spend = new Map([['a', 3000], ['b', 2000]]);
    const kpi = new Map([['a', { value: 6000, results: 50 }], ['b', { value: 5000, results: 40 }]]);
    const s = computeTargetingSplit(specs, spend, kpi, [adRow('x', 100, 200)], 'EUR');
    expect(s.warnings?.some((w) => w.includes('gender'))).toBe(true);
    expect(s.next_step).toContain('broad');
  });
});

describe('computeLearningLimited', () => {
  const adset = (id: string, status = 'ACTIVE'): AdsetConfigLite => ({
    adset_id: id, adset_name: `set-${id}`, optimization_goal: 'OFFSITE_CONVERSIONS',
    custom_event_type: 'PURCHASE', effective_status: status,
  });

  it('reads % of spend below the 50/week bar', () => {
    const adsets = [adset('a'), adset('b'), adset('c', 'PAUSED')];
    const weekly = new Map([['a', 80], ['b', 10]]);
    const spend = new Map([['a', 6000], ['b', 4000], ['c', 9999]]);
    const s = computeLearningLimited(adsets, weekly, spend, 'EUR');
    const d = s.data as { starved_count: number; starved_spend_share_pct: number };
    expect(d.starved_count).toBe(1); // paused set doesn't count
    expect(d.starved_spend_share_pct).toBe(40);
    expect(s.next_step).toContain('Consolidate');
  });

  it('clean account reads clean', () => {
    const s = computeLearningLimited([adset('a')], new Map([['a', 120]]), new Map([['a', 5000]]), 'EUR');
    expect(s.summary).toContain('clear');
  });
});

describe('computeSaturation', () => {
  const week = (i: number, reach: number, imps: number, spend = 1000): WeeklyReachRow => ({
    week: `2026-W${10 + i}`, reach, impressions: imps, spend,
  });

  it('needs BOTH rising frequency AND falling reach efficiency', () => {
    // freq up 50%, reach/spend down ~33% → saturating
    const sat = computeSaturation(
      [...Array.from({ length: 6 }, (_, i) => week(i, 30_000, 60_000)), ...Array.from({ length: 6 }, (_, i) => week(6 + i, 20_000, 60_000))],
      'EUR',
    );
    expect((sat.data as { saturating: boolean }).saturating).toBe(true);

    // freq up but reach efficiency also up (spend fell) → NOT saturating
    const ok = computeSaturation(
      [...Array.from({ length: 6 }, (_, i) => week(i, 30_000, 60_000, 2000)), ...Array.from({ length: 6 }, (_, i) => week(6 + i, 28_000, 70_000, 1000))],
      'EUR',
    );
    expect((ok.data as { saturating: boolean }).saturating).toBe(false);
  });

  it('suppresses under 8 weeks', () => {
    const s = computeSaturation([week(1, 1000, 2000)], 'EUR');
    expect(s.warnings?.[0]).toContain('suppressed');
  });
});

describe('computeCreativeDiversity', () => {
  it('reads fragility when one angle dominates', () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => adRow(`a${i}`, 1000, 2000)),
      ...Array.from({ length: 2 }, (_, i) => adRow(`b${i}`, 100, 200)),
    ];
    const angles = new Map<string, string>([
      ...Array.from({ length: 8 }, (_, i) => [`a${i}`, 'education'] as [string, string]),
      ...Array.from({ length: 2 }, (_, i) => [`b${i}`, 'benefit'] as [string, string]),
    ]);
    const s = computeCreativeDiversity(rows, angles, 'EUR');
    expect(s.summary).toContain('concentrated');
    expect(s.next_step).toContain('different angles');
  });
});

describe('computeCohortWave', () => {
  it('attributes each month\'s spend to launch cohorts', () => {
    const rows = [
      { ad_id: 'old', date: '2026-04-10', spend: 100 },
      { ad_id: 'old', date: '2026-06-10', spend: 200 },
      { ad_id: 'new', date: '2026-06-12', spend: 300 },
    ];
    const wave = computeCohortWave(rows);
    const june = wave.find((m) => m.month === '2026-06')!;
    expect(june.cohorts).toEqual([
      { cohort: '2026-04', spend: 200 },
      { cohort: '2026-06', spend: 300 },
    ]);
  });
});

describe('computeWhatsWorking', () => {
  it('assembles the protect list and forbids calendar refreshes (evergreen rule)', () => {
    const s = computeWhatsWorking(
      { evergreen: [{ ad_name: 'hero', spend: 9000, days_running: 80 }] },
      { angles: [{ angle: 'education', kpi: 3.2, spend_share_pct: 40, below_floor: false }], kpi_mode: 'roas', kpi_label: 'Meta ROAS' },
      [{ dimension: 'Hooks', band: 'strong', position: 'top quartile' }],
      'EUR',
    );
    expect(s.summary).toContain('evergreen');
    expect(s.next_step).toContain('NOT refresh');
  });

  it('an empty protect list is stated as the finding, not padded', () => {
    const s = computeWhatsWorking(undefined, undefined, [], 'EUR');
    expect(s.summary).toContain('that itself is the finding');
  });
});

describe('computeLandingPages', () => {
  const row = (adId: string, path: string | null, spend: number): LandingAdRow => ({
    ad_id: adId, spend, purchases: Math.round(spend / 100), purchase_value: spend * 2, leads: 0, landing_page_path: path,
  });

  it('ranks paths + totals the dead burn; inconclusive never alarms', () => {
    const s = computeLandingPages(
      [row('a', '/products/x', 5000), row('b', '/', 1000), row('c', '/products/y', 2000)],
      [
        { url: 'https://x.com/products/x', verdict: 'ok', status: 200, daily_burn: 0, ads: ['a'] },
        { url: 'https://x.com/products/y', verdict: 'dead', status: 404, daily_burn: 66, ads: ['c'] },
        { url: 'https://x.com/products/z', verdict: 'inconclusive', status: 429, daily_burn: 33, ads: ['d'] },
      ],
      'EUR',
      'roas',
    );
    const d = s.data as { dead_count: number; daily_burn: number; paths: Array<{ path: string }> };
    expect(d.dead_count).toBe(1);
    expect(d.daily_burn).toBe(66); // inconclusive burn NOT counted
    expect(s.warnings?.some((w) => w.includes('DEAD'))).toBe(true);
    expect(s.warnings?.some((w) => w.includes('homepage'))).toBe(true);
    expect(s.next_step).toContain('Pause');
  });
});

describe('computeAccountFacts', () => {
  it('surfaces the longest-running still-spending ad', () => {
    const rows = [
      ...Array.from({ length: 120 }, (_, i) => ({
        ad_id: 'veteran',
        date: new Date(Date.UTC(2026, 2, 1) + i * 86400_000).toISOString().slice(0, 10),
        spend: 50,
      })),
      { ad_id: 'newbie', date: '2026-06-28', spend: 500 },
    ];
    const s = computeAccountFacts({ rows180: rows, adNames: new Map([['veteran', 'Hero Ad']]), partnershipSpendPct: 12, currency: 'EUR' });
    const facts = (s.data as { facts: Array<{ fact: string }> }).facts;
    expect(facts.some((f) => f.fact.includes('longest-running'))).toBe(true);
    expect(facts.some((f) => f.fact.includes('partnership'))).toBe(true);
  });
});
