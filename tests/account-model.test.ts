import { describe, it, expect } from 'vitest';
import { buildAccountModel, classifyBusinessModel, mergeAccountModel, type AccountModelInputs } from '../src/audit/account-model.js';
import { computeConceptRoas, computeOptimizationEvents, buildProvisionalInsights, type PackAdRow, type AdsetConfigLite } from '../src/audit/report-pack.js';

/**
 * Session D pins:
 * - business-model classification is the load-bearing inference (BFM lesson):
 *   purchases WITHOUT funnel events must NOT read as clean ecommerce, and the
 *   ambiguity becomes an open question, never a confident guess.
 * - human_stated facts survive re-inference (the whole point of "correct us").
 * - concept ROAS: discount angle at the top → warning, never "do more discounts".
 * - optimization events: soft goals with real conversion volume → X; thin
 *   volume → "?" (never guess intent).
 * - provisional insights come from real fast-tier numbers and are flagged.
 */

const baseTotals = {
  spend: 20_000, impressions: 2_000_000, purchases: 400, purchase_value: 60_000,
  leads: 0, complete_registrations: 0, add_to_carts: 1_800, checkouts_initiated: 900, content_views: 5_000,
};

const baseInputs = (over: Partial<AccountModelInputs> = {}): AccountModelInputs => ({
  currency: 'EUR',
  observedAt: '2026-07-03T00:00:00Z',
  totals30: { ...baseTotals },
  adsWithSpend30: 42,
  videoSpendSharePct: 70,
  campaigns: [{ name: 'Main', spend: 15_000 }, { name: 'Test', spend: 5_000 }],
  markets: [{ market: 'DE', spend: 16_000 }, { market: 'AT', spend: 4_000 }],
  landingPaths: [{ path: '/products/x', spend: 9_000 }, { path: '/collections/y', spend: 6_000 }],
  ...over,
});

describe('classifyBusinessModel', () => {
  it('ecommerce when revenue + funnel events', () => {
    const r = classifyBusinessModel(baseTotals);
    expect(r.model).toBe('ecommerce');
    expect(r.confidence).toBeGreaterThan(0.8);
    expect(r.question).toBeNull();
  });

  it('the BFM shape: purchases with NO funnel events → low confidence + open question, never "broken tracking"', () => {
    const r = classifyBusinessModel({ ...baseTotals, add_to_carts: 0, checkouts_initiated: 0 });
    expect(r.model).toContain('app subscription or offsite');
    expect(r.confidence).toBeLessThanOrEqual(0.5);
    expect(r.question?.key).toBe('business_model');
  });

  it('lead_gen when leads dominate', () => {
    const r = classifyBusinessModel({ ...baseTotals, purchases: 5, purchase_value: 0, leads: 900, add_to_carts: 0, checkouts_initiated: 0 });
    expect(r.model).toBe('lead_gen');
  });

  it('no signal → unknown with a question, confidence floor', () => {
    const r = classifyBusinessModel({ ...baseTotals, purchases: 0, purchase_value: 0, leads: 0, add_to_carts: 0, checkouts_initiated: 0 });
    expect(r.model).toBe('unknown');
    expect(r.confidence).toBeLessThan(0.3);
    expect(r.question).not.toBeNull();
  });
});

describe('buildAccountModel', () => {
  it('every fact carries provenance + confidence + observed_at; target is ALWAYS an open question', () => {
    const m = buildAccountModel(baseInputs());
    expect(m.facts.length).toBeGreaterThanOrEqual(6);
    for (const f of m.facts) {
      expect(f.source).toBeTruthy();
      expect(f.confidence).toBeGreaterThan(0);
      expect(f.confidence).toBeLessThanOrEqual(1);
      expect(f.observed_at).toBe('2026-07-03T00:00:00Z');
    }
    expect(m.open_questions.some((q) => q.key === 'target')).toBe(true);
  });

  it('markets and destinations render as shares of spend', () => {
    const m = buildAccountModel(baseInputs());
    const markets = m.facts.find((f) => f.key === 'markets');
    expect(markets?.value).toContain('DE (80%)');
    const dest = m.facts.find((f) => f.key === 'top_destinations');
    expect(dest?.value).toContain('/products/x');
  });

  it('optimization goals fact only when the adset read succeeded', () => {
    const without = buildAccountModel(baseInputs());
    expect(without.facts.find((f) => f.key === 'optimization_goals')).toBeUndefined();
    const withGoals = buildAccountModel(baseInputs({ optimizationGoals: [{ goal: 'OFFSITE_CONVERSIONS → PURCHASE', spend: 18_000 }] }));
    expect(withGoals.facts.find((f) => f.key === 'optimization_goals')?.value).toContain('PURCHASE');
  });
});

describe('mergeAccountModel', () => {
  it('human_stated facts survive re-inference and answer their open question', () => {
    const fresh = buildAccountModel(baseInputs({ totals30: { ...baseTotals, add_to_carts: 0, checkouts_initiated: 0 } }));
    expect(fresh.open_questions.some((q) => q.key === 'business_model')).toBe(true);
    const prev = {
      facts: [{
        key: 'business_model', label: 'Business model', value: 'app subscription (stated by founder)',
        source: 'human_stated' as const, confidence: 1, observed_at: '2026-07-01T00:00:00Z',
      }],
    };
    const merged = mergeAccountModel(prev, fresh);
    const bm = merged.facts.find((f) => f.key === 'business_model');
    expect(bm?.source).toBe('human_stated');
    expect(bm?.value).toContain('stated by founder');
    expect(merged.business_model).toContain('stated by founder');
    expect(merged.open_questions.some((q) => q.key === 'business_model')).toBe(false);
  });

  it('human_stated facts with no fresh counterpart still survive', () => {
    const fresh = buildAccountModel(baseInputs());
    const prev = {
      facts: [{
        key: 'margin', label: 'Margin', value: '68% contribution margin',
        source: 'human_stated' as const, confidence: 1, observed_at: '2026-07-01T00:00:00Z',
      }],
    };
    const merged = mergeAccountModel(prev, fresh);
    expect(merged.facts.find((f) => f.key === 'margin')?.value).toContain('68%');
  });
});

// ---------------------------------------------------------------------------

const adRow = (adId: string, spend: number, value: number, over: Partial<PackAdRow> = {}): PackAdRow => ({
  ad_id: adId, ad_name: adId, date: '2026-06-15', spend, impressions: 10_000,
  purchases: 5, purchase_value: value, results: 5, frequency: 2, hook_rate: 25, hold_rate: 10, ...over,
});

describe('computeConceptRoas', () => {
  it('suppresses on thin angle coverage instead of guessing', () => {
    const rows = [adRow('a', 1000, 2000), adRow('b', 1000, 1500)];
    const s = computeConceptRoas(rows, new Map([['a', 'UGC testimonial']]));
    // 50% coverage but only 1 angle → suppressed
    expect(s.data.angles).toEqual([]);
    expect(s.warnings?.[0]).toContain('suppressed');
  });

  it('discount angle on top → warning, never "scale discounts" (binding)', () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => adRow(`d${i}`, 500, 2500)),   // discount: ROAS 5
      ...Array.from({ length: 5 }, (_, i) => adRow(`u${i}`, 1000, 2000)),  // ugc: ROAS 2
    ];
    const angles = new Map<string, string>([
      ...Array.from({ length: 5 }, (_, i) => [`d${i}`, 'Discount / offer'] as [string, string]),
      ...Array.from({ length: 5 }, (_, i) => [`u${i}`, 'UGC testimonial'] as [string, string]),
    ]);
    const s = computeConceptRoas(rows, angles);
    expect(s.data.discount_flag).toBe(true);
    expect(s.warnings?.some((w) => w.includes('NOT a green light'))).toBe(true);
    expect(s.next_step).toContain('NON-discount');
  });

  it('underfunded winner named in the next step', () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => adRow(`big${i}`, 1000, 1800)),  // big budget, ROAS 1.8
      ...Array.from({ length: 5 }, (_, i) => adRow(`win${i}`, 300, 1200)),   // small budget, ROAS 4
    ];
    const angles = new Map<string, string>([
      ...Array.from({ length: 5 }, (_, i) => [`big${i}`, 'Problem-solution'] as [string, string]),
      ...Array.from({ length: 5 }, (_, i) => [`win${i}`, 'Founder story'] as [string, string]),
    ]);
    const s = computeConceptRoas(rows, angles);
    expect(s.next_step).toContain('Founder story');
    expect(s.next_step).toContain('out-earns');
  });
});

describe('computeOptimizationEvents', () => {
  const adsets: AdsetConfigLite[] = [
    { adset_id: 's1', adset_name: 'Prospecting', optimization_goal: 'OFFSITE_CONVERSIONS', custom_event_type: 'PURCHASE', effective_status: 'ACTIVE' },
    { adset_id: 's2', adset_name: 'Traffic push', optimization_goal: 'LINK_CLICKS', custom_event_type: null, effective_status: 'ACTIVE' },
    { adset_id: 's3', adset_name: 'ATC warm', optimization_goal: 'OFFSITE_CONVERSIONS', custom_event_type: 'ADD_TO_CART', effective_status: 'ACTIVE' },
  ];
  const spend = new Map([['s1', 5000], ['s2', 2000], ['s3', 1500]]);

  it('the 1-check / 2-X panel: purchase → check, soft + mid-funnel → X when volume is real', () => {
    const s = computeOptimizationEvents(adsets, spend, { purchases: 400, leads: 0, purchase_value: 60_000 });
    const counts = s.data.counts as { check: number; x: number; question: number };
    expect(counts.check).toBe(1);
    expect(counts.x).toBe(2);
    expect(s.summary).toContain('WRONG event');
    expect(s.next_step).toContain('learning reset');
  });

  it('thin conversion volume downgrades X to "?" — a deliberate choice, not an error', () => {
    const s = computeOptimizationEvents(adsets, spend, { purchases: 20, leads: 0, purchase_value: 900 });
    const counts = s.data.counts as { check: number; x: number; question: number };
    expect(counts.x).toBe(0);
    expect(counts.question).toBe(2);
  });

  it('lead-gen account: LEAD optimization is correct', () => {
    const leadSets: AdsetConfigLite[] = [
      { adset_id: 'l1', adset_name: 'Leads', optimization_goal: 'OFFSITE_CONVERSIONS', custom_event_type: 'LEAD', effective_status: 'ACTIVE' },
    ];
    const s = computeOptimizationEvents(leadSets, new Map([['l1', 3000]]), { purchases: 2, leads: 500, purchase_value: 0 });
    const counts = s.data.counts as { check: number; x: number; question: number };
    expect(counts.check).toBe(1);
    expect(counts.x).toBe(0);
  });

  it('zero-spend adsets are excluded; empty read is an honest suppression', () => {
    const s = computeOptimizationEvents(adsets, new Map(), { purchases: 400, leads: 0, purchase_value: 60_000 });
    expect((s.data.rows as unknown[]).length).toBe(0);
    expect(s.warnings?.[0]).toContain('suppressed');
  });
});

describe('buildProvisionalInsights', () => {
  const scorecard = [
    { dimension: 'Hooks', band: 'weak', position: 'Hooks — bottom of the cohort', lever: 'The first 3 seconds.', next_step: 'New openings.', section_key: 'creative_analysis' },
    { dimension: 'Hold', band: 'strong', position: 'Hold — top of the cohort', lever: 'Keeps watchers.', next_step: 'Protect it.', section_key: 'creative_analysis' },
  ];

  it('worst dimension + fatiguing runway + concentration, all flagged provisional', () => {
    const fatigue = {
      ads: [{
        ad_name: 'Hero UGC', spend: 8000, in_window_age_days: 70, kpi_first_half: 2.4, kpi_second_half: 1.4,
        kpi_recent: 1.3, trend_pct: -42, avg_frequency: 2.8, class: 'fatiguing' as const, days_to_breakeven: 19, low_frequency_acquisition_guard: false,
      }],
    };
    const conc = { top3_share_pct: 71, band: 'high', top_ads: [{ ad_name: 'Hero UGC', share_pct: 44 }] };
    const out = buildProvisionalInsights(scorecard, fatigue, conc);
    expect(out).toHaveLength(3);
    expect(out.every((i) => i.provisional)).toBe(true);
    expect(out[0]!.headline).toContain('Hooks');
    expect(out[1]!.headline).toContain('19 days');
    expect(out[2]!.headline).toContain('71%');
  });

  it('healthy account falls back to strengths — the strip still says something real', () => {
    const healthy = [{ ...scorecard[1]! }];
    const out = buildProvisionalInsights(healthy, { ads: [] }, { top3_share_pct: 22, band: 'healthy', top_ads: [] });
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.severity).toBe('opportunity');
  });
});
