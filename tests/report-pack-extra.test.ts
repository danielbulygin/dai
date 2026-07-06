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
  classifyDestination,
  computeAccountFacts,
  longestStillSpendingSpan,
  computeAccountActivity,
  categorizeActivityEvent,
  type PlacementInsightRow,
  type TargetingSpecLite,
  type WeeklyReachRow,
  type LandingAdRow,
  type ActivityEvent,
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

  it('counts a soft-404 as dead burn and names it in the warning', () => {
    const s = computeLandingPages(
      [row('a', '/products/x', 5000)],
      [
        { url: 'https://x.com/products/x', verdict: 'ok', status: 200, daily_burn: 0, ads: ['a'] },
        { url: 'https://x.com/products/gone', verdict: 'soft_404', status: 200, daily_burn: 40, ads: ['b'] },
      ],
      'EUR',
      'roas',
    );
    const d = s.data as { dead_count: number; soft_404_count: number; daily_burn: number };
    expect(d.dead_count).toBe(1);
    expect(d.soft_404_count).toBe(1);
    expect(d.daily_burn).toBe(40);
    expect(s.warnings?.some((w) => w.includes('soft-404'))).toBe(true);
  });

  it('surfaces the URL-check cap instead of truncating silently', () => {
    const s = computeLandingPages(
      [row('a', '/products/x', 5000)],
      [{ url: 'https://x.com/products/x', verdict: 'ok', status: 200, daily_burn: 0, ads: ['a'] }],
      'EUR',
      'roas',
      7,
    );
    expect((s.data as { unchecked_urls: number }).unchecked_urls).toBe(7);
    expect(s.warnings?.some((w) => w.includes('not fetched'))).toBe(true);
  });
});

describe('classifyDestination', () => {
  it('hard 404/410 is dead', () => {
    expect(classifyDestination('https://x.com/p', 'https://x.com/p', 404, '').verdict).toBe('dead');
    expect(classifyDestination('https://x.com/p', 'https://x.com/p', 410, '').verdict).toBe('dead');
  });

  it('HTTP 200 with a not-found body is soft_404 (EN + DE)', () => {
    expect(classifyDestination('https://x.com/p', 'https://x.com/p', 200, '<title>Page not found</title>').verdict).toBe('soft_404');
    expect(classifyDestination('https://x.de/p', 'https://x.de/p', 200, '<title>Seite nicht gefunden</title>').verdict).toBe('soft_404');
  });

  it('a healthy product page is ok', () => {
    expect(classifyDestination('https://x.com/p', 'https://x.com/p', 200, '<title>Great Product</title>Add to cart').verdict).toBe('ok');
  });

  it('deep page redirected to the same-host homepage is redirect_home', () => {
    expect(classifyDestination('https://x.com/products/gone', 'https://www.x.com/', 200, '<title>Home</title>').verdict).toBe('redirect_home');
  });

  it('cross-domain redirect to a homepage is NOT redirect_home', () => {
    expect(classifyDestination('https://x.com/products/a', 'https://y.com/', 200, '<title>Other</title>').verdict).toBe('ok');
  });

  it('429/403 bot gates are inconclusive, never dead', () => {
    expect(classifyDestination('https://x.com/p', 'https://x.com/p', 429, '').verdict).toBe('inconclusive');
    expect(classifyDestination('https://x.com/p', 'https://x.com/p', 403, '').verdict).toBe('inconclusive');
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

describe('computeLearningLimited — count-scope reconciliation (founder-sim debt, 2026-07-04)', () => {
  const adset = (id: string, status = 'ACTIVE'): AdsetConfigLite => ({
    adset_id: id, adset_name: `set-${id}`, optimization_goal: 'OFFSITE_CONVERSIONS',
    custom_event_type: 'PURCHASE', effective_status: status,
  });

  it('assessed_adsets is the FULL population even though data.rows is display-capped at 15', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `s${i}`);
    const s = computeLearningLimited(
      ids.map((id) => adset(id)),
      new Map(ids.map((id) => [id, 100])),
      new Map(ids.map((id) => [id, 1000])),
      'EUR',
    );
    const d = s.data as { rows: unknown[]; assessed_adsets: number; spending_adsets_30d: number; inactive_spenders_excluded: number };
    expect(d.rows).toHaveLength(15); // display cap
    expect(d.assessed_adsets).toBe(20); // the honest count — work log reads THIS
    expect(d.spending_adsets_30d).toBe(20);
    expect(d.inactive_spenders_excluded).toBe(0);
    expect(s.summary).toContain('All 20 currently active ad sets');
  });

  it('a spender that is no longer active is bridged inline, not silently dropped', () => {
    const s = computeLearningLimited(
      [adset('a'), adset('b'), adset('c', 'PAUSED')],
      new Map([['a', 10], ['b', 10]]),
      new Map([['a', 6000], ['b', 4000], ['c', 9999]]),
      'EUR',
    );
    const d = s.data as { assessed_adsets: number; spending_adsets_30d: number; inactive_spenders_excluded: number };
    expect(d.assessed_adsets).toBe(2);
    expect(d.spending_adsets_30d).toBe(3);
    expect(d.inactive_spenders_excluded).toBe(1);
    expect(s.summary).toContain('2 of the 2 currently active ad sets');
    expect(s.summary).toContain('(3 ad sets spent in the last 30 days; 1 is no longer active');
    expect(s.derivation).toContain('judged in the optimization report, not here');
  });

  it('all-active population carries no bridge noise', () => {
    const s = computeLearningLimited([adset('a')], new Map([['a', 120]]), new Map([['a', 5000]]), 'EUR');
    expect(s.summary).not.toContain('no longer active');
  });
});

describe('longestStillSpendingSpan — the shared account-side ad-age number', () => {
  const d = (i: number) => `2026-06-${String(i).padStart(2, '0')}`;
  const row = (adId: string, date: string, spend = 100): Pick<PackAdRow, 'ad_id' | 'date' | 'spend'> => ({ ad_id: adId, date, spend });

  it('returns the longest first→last span among ads still delivering in the final 7 days', () => {
    const rows = [
      row('veteran', d(1)), row('veteran', d(28)), // 27-day span, still spending
      row('retired', d(1)), row('retired', d(10)), // longer? no — 9 days, and retired anyway
      row('young', d(25)), row('young', d(28)),
    ];
    expect(longestStillSpendingSpan(rows)).toEqual({ adId: 'veteran', first: d(1), spanDays: 27 });
  });

  it('an ad that stopped delivering >7 days before the window end never wins', () => {
    const rows = [
      row('dead-veteran', d(1)), row('dead-veteran', d(15)), // 14-day span but retired
      row('live', d(20)), row('live', d(28)),
    ];
    expect(longestStillSpendingSpan(rows)).toEqual({ adId: 'live', first: d(20), spanDays: 8 });
  });

  it('empty input → null', () => {
    expect(longestStillSpendingSpan([])).toBeNull();
  });

  it('computeAccountFacts cites the SAME number (the two sections can never disagree)', () => {
    const rows: Array<Pick<PackAdRow, 'ad_id' | 'date' | 'spend'>> = [];
    for (let i = 1; i <= 28; i++) rows.push({ ad_id: 'veteran', date: d(i), spend: 100 } as PackAdRow);
    for (let i = 20; i <= 28; i++) rows.push({ ad_id: 'young', date: d(i), spend: 50 } as PackAdRow);
    const span = longestStillSpendingSpan(rows)!.spanDays; // 27 — under the 30d fact floor
    expect(span).toBe(27);
    // stretch veteran past the floor and assert the fact quotes the helper's number
    rows.push({ ad_id: 'veteran', date: '2026-07-05', spend: 100 } as PackAdRow);
    const s = computeAccountFacts({ rows180: rows, adNames: new Map(), partnershipSpendPct: null, currency: 'EUR' });
    const expected = longestStillSpendingSpan(rows)!.spanDays;
    const fact = (s.data as { facts: Array<{ fact: string }> }).facts.find((f) => f.fact.includes('longest-running'))!;
    expect(fact.fact).toContain(`live ${expected} days`);
  });
});

// ---------------------------------------------------------------------------
// Account activity / change history (2026-07-06)
// ---------------------------------------------------------------------------

describe('categorizeActivityEvent', () => {
  it('maps Meta event_types into human categories, specific signals first', () => {
    // targeting beats the ad_set/campaign structure signal
    expect(categorizeActivityEvent('update_ad_set_target_spec')).toBe('targeting');
    // budget beats the campaign structure signal
    expect(categorizeActivityEvent('update_campaign_budget')).toBe('budget');
    expect(categorizeActivityEvent('update_ad_set_bid_amount')).toBe('budget');
    // run-status flips are pauses/unpauses
    expect(categorizeActivityEvent('update_ad_set_run_status')).toBe('status');
    expect(categorizeActivityEvent('update_campaign_run_status')).toBe('status');
    // ad-account enable/disable is account-level, not a campaign pause
    expect(categorizeActivityEvent('ad_account_update_status')).toBe('account');
    // creative uploads/edits
    expect(categorizeActivityEvent('create_ad')).toBe('creative');
    expect(categorizeActivityEvent('add_images')).toBe('creative');
    expect(categorizeActivityEvent('update_ad_creative')).toBe('creative');
    // plain structure
    expect(categorizeActivityEvent('create_ad_set')).toBe('structure');
    expect(categorizeActivityEvent('create_campaign')).toBe('structure');
    // account-level
    expect(categorizeActivityEvent('ad_account_add_user_to_role')).toBe('account');
    // unknown -> other (never dropped)
    expect(categorizeActivityEvent('some_future_event_meta_invents')).toBe('other');
  });
});

describe('computeAccountActivity', () => {
  const ev = (type: string, daysAgo: number, over: Partial<ActivityEvent> = {}): ActivityEvent => ({
    event_type: type,
    event_time: new Date(Date.parse('2026-07-06T12:00:00Z') - daysAgo * 86400_000).toISOString(),
    actor_id: '100',
    actor_name: 'Agency User',
    application_id: '200',
    application_name: 'Ads Manager',
    object_type: 'AD',
    ...over,
  });
  const asOf = '2026-07-06T12:00:00Z';

  it('treats an empty log as an honest "untouched account" finding', () => {
    const s = computeAccountActivity({ events: [], currency: 'EUR', monthlyRetainer: null, asOf });
    const d = s.data as Record<string, unknown>;
    expect(d.no_activity).toBe(true);
    expect(d.total_window).toBe(0);
    expect(d.days_since_last_change).toBeNull();
    expect(s.summary).toContain('no recorded account changes');
    // never claims a cost with no retainer
    expect(d.cost_per_change_30d).toBeNull();
  });

  it('counts 30d vs window, per-week rate, and category breakdown', () => {
    const s = computeAccountActivity({
      events: [
        ev('create_ad', 2),
        ev('add_images', 5),
        ev('update_campaign_budget', 10),
        ev('update_ad_set_run_status', 40), // outside 30d, inside 90d
        ev('update_ad_set_target_spec', 80),
      ],
      currency: 'EUR',
      monthlyRetainer: null,
      asOf,
    });
    const d = s.data as Record<string, unknown>;
    expect(d.total_window).toBe(5);
    expect(d.total_30d).toBe(3);
    expect(d.actions_per_week).toBeCloseTo(5 / (90 / 7), 1);
    const cats = d.by_category as Array<{ category: string; count: number }>;
    expect(cats.find((c) => c.category === 'creative')!.count).toBe(2);
    expect(cats.find((c) => c.category === 'budget')!.count).toBe(1);
    expect(cats.find((c) => c.category === 'targeting')!.count).toBe(1);
  });

  it('aggregates who acted and flags when nobody is a named person', () => {
    const named = computeAccountActivity({
      events: [ev('create_ad', 1), ev('add_images', 3), ev('create_ad', 2, { actor_id: '999', actor_name: 'Other Person' })],
      currency: 'EUR',
      monthlyRetainer: null,
      asOf,
    });
    const nd = named.data as Record<string, unknown>;
    // Agency User acted twice, Other Person once → Agency User leads
    expect((nd.by_actor as Array<{ actor_name: string }>)[0]!.actor_name).toBe('Agency User');
    expect(nd.named_actor_count).toBe(2);

    const anon = computeAccountActivity({
      events: [ev('create_ad', 1, { actor_id: null, actor_name: null })],
      currency: 'EUR',
      monthlyRetainer: null,
      asOf,
    });
    expect(anon.warnings?.some((w) => w.includes('named person'))).toBe(true);
    expect((anon.data as { named_actor_count: number }).named_actor_count).toBe(0);
  });

  it('measures the longest zero-change streak and days since last change', () => {
    // changes 60 and 20 days ago -> a ~39-day interior gap; last change 20d ago
    const s = computeAccountActivity({
      events: [ev('create_ad', 60), ev('create_ad', 20)],
      currency: 'EUR',
      monthlyRetainer: null,
      asOf,
    });
    const d = s.data as Record<string, unknown>;
    expect(d.days_since_last_change).toBe(20);
    expect(d.longest_zero_streak_days).toBe(39);
  });

  it('derives cost-per-change only when a retainer is supplied', () => {
    const events = [ev('create_ad', 1), ev('create_ad', 2), ev('create_ad', 3), ev('create_ad', 4)];
    const withRetainer = computeAccountActivity({ events, currency: 'EUR', monthlyRetainer: 4000, asOf });
    expect((withRetainer.data as { cost_per_change_30d: number }).cost_per_change_30d).toBe(1000);
    expect(withRetainer.summary).toContain('per logged change');

    const without = computeAccountActivity({ events, currency: 'EUR', monthlyRetainer: null, asOf });
    expect((without.data as { cost_per_change_30d: number | null }).cost_per_change_30d).toBeNull();
    expect(without.summary).not.toContain('per logged change');
  });

  it('flags a partial pull so counts are read as a floor', () => {
    const s = computeAccountActivity({ events: [ev('create_ad', 1)], currency: 'EUR', monthlyRetainer: null, partial: true, asOf });
    expect(s.warnings?.some((w) => w.includes('floor'))).toBe(true);
    expect((s.data as { partial: boolean }).partial).toBe(true);
  });
});
