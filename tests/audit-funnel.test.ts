import { describe, it, expect } from 'vitest';
import { funnelStages } from '../src/audit/magic-audit.js';
import { buildColdCreativeFacts, type GraphCreativeLite, type TopAdsSummary } from '../src/audit/cold-creative-source.js';

/**
 * The funnel is the account's own event chain, not a fixed e-commerce one. An
 * e-com account keeps the six stages it always had; a lead-gen account gets the
 * stages it actually records, because printing "Add to cart 0 / Checkout 0" on
 * a life-insurance account invited the synthesis to diagnose a cart collapse on
 * an account with no cart.
 */

const totals = (over: Record<string, number>): Record<string, number> => ({
  spend: 9000, impressions: 900_000, clicks: 12_000, link_clicks: 9_000,
  content_views: 0, add_to_carts: 0, checkouts_initiated: 0,
  purchases: 0, purchase_value: 0, leads: 0, complete_registrations: 0,
  results: 0, landing_page_views: 0,
  ...over,
});

describe('funnelStages', () => {
  it('REGRESSION: an account with purchases keeps the six-stage e-commerce chain', () => {
    const f = funnelStages(
      totals({ content_views: 40_000, add_to_carts: 3_000, checkouts_initiated: 1_200, purchases: 400, purchase_value: 32_000 }),
      'EUR',
    );
    expect(f.kind).toBe('ecommerce');
    expect(f.stages.map((s) => s.stage)).toEqual([
      'Impressions', 'Link clicks', 'Content views', 'Add to cart', 'Checkout initiated', 'Purchases',
    ]);
    expect(f.stages[0]!.rate_from_prev).toBeNull();
    expect(f.stages[1]!.rate_from_prev).toBeCloseTo(1, 5); // 9k of 900k impressions
    expect(f.note).toBeUndefined();
  });

  it('a lead-gen account gets impressions, clicks, landing page views and leads — no cart', () => {
    const f = funnelStages(totals({ landing_page_views: 6_300, leads: 482 }), 'USD');
    expect(f.kind).toBe('lead_gen');
    expect(f.stages.map((s) => s.stage)).toEqual(['Impressions', 'Link clicks', 'Landing page views', 'Leads']);
    expect(f.stages.map((s) => s.stage)).not.toContain('Add to cart');
    expect(f.stages[2]!.rate_from_prev).toBeCloseTo(70, 5); // 6,300 of 9,000 clicks
    expect(f.stages[3]!.value).toBe(482);
  });

  it('leaves out a landing-page-view stage it cannot see (warehouse rows have no such column)', () => {
    const f = funnelStages(totals({ leads: 482 }), 'USD');
    expect(f.stages.map((s) => s.stage)).toEqual(['Impressions', 'Link clicks', 'Leads']);
  });

  it('adds registrations only when they are a distinct step from the lead', () => {
    const both = funnelStages(totals({ leads: 400, complete_registrations: 120 }), 'USD');
    expect(both.stages.map((s) => s.stage)).toContain('Registrations');
    const same = funnelStages(totals({ leads: 400, complete_registrations: 400 }), 'USD');
    expect(same.stages.map((s) => s.stage)).not.toContain('Registrations');
  });

  it('no purchases and no leads stops at the click and says the conversion is off-platform', () => {
    const f = funnelStages(totals({}), 'USD');
    expect(f.kind).toBe('no_conversion_recorded');
    expect(f.stages.map((s) => s.stage)).toEqual(['Impressions', 'Link clicks']);
    expect(f.note).toContain('no purchases and no leads');
    expect(f.note).toContain('off-platform');
  });
});

describe('creative facts on a lead-gen account', () => {
  const leadGenSummary: TopAdsSummary = {
    ads: [
      { ad_id: '1', ad_name: 'Form-hook-A', spend: 5_577, roas: 0, purchases: 0, leads: 300, hook_rate: null, is_video: false },
      { ad_id: '2', ad_name: 'Form-hook-B', spend: 2_000, roas: 0, purchases: 0, leads: 40, hook_rate: null, is_video: false },
    ],
    ads_with_spend: 2,
    total_spend: 7_577,
    top12_spend_share_pct: 100,
    video_spend_share_pct: 0,
  };

  it('sends the cost per lead as the ad\'s number and never a ROAS of 0', () => {
    const facts = buildColdCreativeFacts({
      accountName: 'Acme Life', currency: 'USD', summary: leadGenSummary,
      graphByAdId: new Map<string, GraphCreativeLite>(), reads: [], unresolved: [],
    }) as { kpi: string; top_ads: Array<Record<string, unknown>> };
    expect(facts.kpi).toContain('cost per lead');
    expect(facts.top_ads[0]!.roas).toBeUndefined();
    expect(facts.top_ads[0]!.cpl).toBeCloseTo(18.59, 2);
    expect(facts.top_ads[1]!.cpl).toBeCloseTo(50, 2);
    expect(JSON.stringify(facts)).not.toContain('"roas"');
  });

  it('an account with purchases still sends ROAS', () => {
    const facts = buildColdCreativeFacts({
      accountName: 'Acme Shop', currency: 'EUR',
      summary: {
        ...leadGenSummary,
        ads: [{ ad_id: '1', ad_name: 'UGC-A', spend: 900, roas: 3.4, purchases: 40, leads: 0, hook_rate: 0.31, is_video: true }],
      },
      graphByAdId: new Map<string, GraphCreativeLite>(), reads: [], unresolved: [],
    }) as { kpi: string; top_ads: Array<Record<string, unknown>> };
    expect(facts.kpi).toBe('Meta ROAS');
    expect(facts.top_ads[0]!.roas).toBe(3.4);
    expect(facts.top_ads[0]!.cpl).toBeUndefined();
  });
});
