import { describe, it, expect } from 'vitest';
import {
  buildInsightRules, buildSynthSystem, funnelDerived, vetConnection,
  type InsightGuardrails,
} from '../src/audit/magic-audit.js';
import { buildColdCreativeFacts, fallbackWinners, type TopAdsSummary } from '../src/audit/cold-creative-source.js';

/**
 * The customer-simulation round on a live regeneration, pinned.
 *
 * Every case here is a sentence the live report printed that the reader could
 * have disproved from the same payload: an insight calling the 47%-of-spend ad
 * fatiguing when the fatigue chapter classified a 1.3% ad, a leads-per-spend
 * rate printed as "Meta CPL 0.06 → 0.04", "more than every other ad combined"
 * about 225 of 483 leads, and a "ROAS 0" tile on an account that has never sold
 * anything online.
 */

const guardrails = (over: Partial<InsightGuardrails> = {}): InsightGuardrails => ({
  currency: 'USD',
  lens: 'lead_gen',
  totals30: { spend: 8_999, leads: 483, purchases: 0, results: 483 },
  fatigue: {
    kpi_mode: 'cpr',
    assessed_ads: 9,
    fatiguing: [{ ad_name: 'SB-Video-Calculator', stat: 'Meta CPL 41.20 USD', spend_30d: 117 }],
    declining_unconfirmed: ['ASH', 'SB-parents'],
    evergreen: ['SB-Image-Life cover calculator'],
    ...(over.fatigue ?? {}),
  },
  ...over,
});

describe('the lead-insight ranker may not overrule the sections', () => {
  it('hands the ranker the fatigue chapter\'s own verdict and forbids a second one', () => {
    const rules = buildInsightRules(guardrails());
    expect(rules).toContain('"SB-Video-Calculator" (Meta CPL 41.20 USD)');
    expect(rules).toContain('EVERGREEN: "SB-Image-Life cover calculator"');
    expect(rules).toContain('ONLY if it is on the FATIGUING list');
    expect(rules).toContain("the biggest spender's absence is not a hint");
    // The new middle class may be described, in its own words, and no further.
    expect(rules).toContain('DECLINING BUT NOT CONFIRMED: "ASH", "SB-parents"');
    expect(rules).toContain('never as fatiguing, past peak or worth cutting');
  });

  it('says plainly that no fatigue claim is allowed when nothing was classified', () => {
    const rules = buildInsightRules(guardrails({ fatigue: null }));
    expect(rules).toContain('No fatigue classification was produced');
    expect(rules).not.toContain('FATIGUING:');
  });

  it('a per-ad cost must be money from the facts, never a rate relabelled', () => {
    const rules = buildInsightRules(guardrails());
    expect(rules).toContain('Meta CPL 18.59 USD');
    expect(rules).toContain('is not a cost per result and may never be relabelled as one');
    expect(rules).toContain('you may not compute a percentage change');
  });

  it('every superlative is arithmetic against the account\'s own totals', () => {
    const rules = buildInsightRules(guardrails());
    expect(rules).toContain('leads 483');
    expect(rules).toContain('purchases 0');
    expect(rules).toContain('more than every other ad combined');
    expect(rules).toContain('drop the claim rather than softening it');
  });

  it('with no totals it asks for no arithmetic it cannot check', () => {
    expect(buildInsightRules(guardrails({ totals30: null }))).not.toContain('Account totals');
  });

  it('the auction figures travel with the ranker, and a CTR the account held is a recovery', () => {
    const rules = buildInsightRules(
      guardrails({ auction: { cpm_delta_pct: 23, ctr_delta_pct: -62, ctr_first: 2.2, ctr_last: 0.85, weeks: 14, verdict: 'creative_earning_worse_auctions' } }),
    );
    expect(rules).toContain('over 14 weeks');
    expect(rules).toContain('CPM 23%');
    expect(rules).toContain('link CTR -62%');
    // Both figures are weekly averages and must be named as such: the account's
    // "now" is its measured 30-day rate, which lives in the funnel chapter.
    // ONE basis for every click-rate figure in the report: the thirds averages.
    expect(rules).toContain('weekly averages: 2.2% over the first third of that window, 0.85% over the last third');
    expect(rules).toContain('call a weekly average a weekly average rather than "now"');
    expect(rules).toContain('do not recompute them');
    expect(rules).toContain('never as a new ceiling');
  });

  it('says nothing about the auction when nothing was measured', () => {
    expect(buildInsightRules(guardrails({ auction: null }))).not.toContain('cost-trend chapter');
    expect(buildInsightRules(guardrails({ auction: { cpm_delta_pct: null, ctr_delta_pct: null } }))).not.toContain('cost-trend chapter');
  });
});

describe('the honesty rules ride every synthesis prompt', () => {
  const system = buildSynthSystem('', null);

  it('bans field names, unscoped creative claims and an invented form', () => {
    expect(system).toContain('Never quote a raw field name');
    expect(system).toContain('Video_spend_share is 0%');
    expect(system).toContain('never "every ad"');
    expect(system).toContain('landing_page_views above zero');
  });

  it('gives the weekend claim its baseline and the missing target one owner', () => {
    expect(system).toContain('two days of seven are 28.6%');
    expect(system).toContain('AT MOST ONCE');
    expect(system).toContain('"Funnel Diagnosis"');
  });

  it('carries the voice rules', () => {
    expect(system).toContain('plain operator language');
    expect(system).toContain('Never a "not X but Y" construction');
    expect(system).toContain('No metaphors, no analogies, no taglines');
  });
});

describe('the funnel figures speak the account\'s own grammar', () => {
  const leadGen = {
    spend: 8_999, impressions: 900_000, link_clicks: 9_000, landing_page_views: 6_500,
    leads: 483, purchases: 0, purchase_value: 0, complete_registrations: 0,
  };

  it('a lead-gen account gets no ROAS field at all, not a zero one', () => {
    const d = funnelDerived(leadGen, 'lead_gen');
    expect('roas' in d).toBe(false);
    expect('aov' in d).toBe(false);
    expect('cpa' in d).toBe(false);
    expect(d.cost_per_lead).toBeCloseTo(18.63, 2);
    expect(d.cost_per_link_click).toBeCloseTo(1, 2);
  });

  it('an account with no conversion at all still gets no purchase fields', () => {
    const d = funnelDerived({ ...leadGen, leads: 0 }, 'no_conversion_recorded');
    expect('roas' in d).toBe(false);
    expect(d.cost_per_lead).toBeNull();
  });

  it('an e-commerce account keeps ROAS, CPA and AOV exactly as before', () => {
    const d = funnelDerived(
      { spend: 10_000, impressions: 900_000, link_clicks: 9_000, purchases: 312, purchase_value: 41_000 },
      'ecommerce',
    );
    expect(d.roas).toBeCloseTo(4.1, 2);
    expect(d.cpa).toBeCloseTo(32.05, 2);
    expect(d.aov).toBeCloseTo(131.41, 2);
  });
});

describe('the cross-section connection is a join or it is nothing', () => {
  it('takes one sentence carrying a figure and two named sections', () => {
    expect(
      vetConnection({
        connection: 'The 61% of spend landing on the homepage is the same traffic the funnel loses at 4.2% lead rate.',
        sections: ['landing_pages', 'funnel_read'],
      }),
    ).toContain('61% of spend');
  });

  it('refuses a sentence from one section, a sentence with no number, and a stub', () => {
    expect(vetConnection({ connection: 'Spend is up 23% this month.', sections: ['cost_trends'] })).toBeNull();
    expect(vetConnection({ connection: 'The account is concentrated and the creative is old.', sections: ['a', 'b'] })).toBeNull();
    expect(vetConnection({ connection: 'Too short.', sections: ['a', 'b'] })).toBeNull();
    expect(vetConnection(null)).toBeNull();
    expect(vetConnection({})).toBeNull();
  });

  it('house punctuation applies to it like every other sentence', () => {
    const out = vetConnection({
      connection: 'CPM is up 23% — the CTR fell 62% over the same 14 weeks.',
      sections: ['cost_trends', 'creative_fatigue'],
    });
    expect(out).not.toMatch(/—/);
    expect(out).toContain('23%');
  });
});

describe('the cold creative read scopes itself to what it watched', () => {
  const summary: TopAdsSummary = {
    ads: [
      { ad_id: 'a1', ad_name: 'SB-Image-Calculator', spend: 2_400, roas: 0, purchases: 0, leads: 129, hook_rate: null, is_video: false },
      { ad_id: 'a2', ad_name: 'SB-Video-Testimonial', spend: 500, roas: 0, purchases: 0, leads: 25, hook_rate: 0.18, is_video: true },
    ],
    ads_with_spend: 9,
    total_spend: 8_999,
    top12_spend_share_pct: 100,
    video_spend_share_pct: 6,
  };

  it('states how many creatives were actually watched, and how many ads are in the facts', () => {
    const facts = buildColdCreativeFacts({
      accountName: 'Northline', currency: 'USD', summary,
      graphByAdId: new Map(), reads: [], unresolved: [],
    });
    expect(facts.creatives_watched).toBe(0);
    expect(facts.top_ads_in_facts).toBe(2);
    expect(facts.kpi).toContain('cost per lead');
  });

  it('a lead-gen ad\'s own number is money per lead, never a ROAS multiple', () => {
    const winners = fallbackWinners(summary, [], 4, 'USD');
    expect(winners[0]!.key_stat).toBe('Meta CPL 18.6 USD');
    expect(winners[1]!.key_stat).toBe('Meta CPL 20 USD');
    expect(JSON.stringify(winners)).not.toMatch(/roas/i);
  });
});
