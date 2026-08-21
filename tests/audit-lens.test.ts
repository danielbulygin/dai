import { describe, it, expect } from 'vitest';
import { readAccountLens, type AccountModelInputs } from '../src/audit/account-model.js';
import { LENS_DEPENDENT_SECTIONS, lensSkipReason, lensBrief, buildSynthSystem, funnelStages } from '../src/audit/magic-audit.js';
import { computeBudgetScatter, type PackAdRow, type ScatterDot } from '../src/audit/report-pack.js';

/**
 * The lens: one classification of the account's own 30-day event mix, STATED on
 * the page and enforced on the sections that need a conversion grammar.
 *
 * The anchor case is a life-insurance account: 482 leads, 18.59 cost per lead,
 * zero purchases. Read through an e-commerce lens it printed a ROAS it never
 * had and a breakeven line it cannot cross. Read through its own lens it has a
 * cost per lead and nothing else.
 */

const totals30 = (over: Partial<AccountModelInputs['totals30']> = {}): AccountModelInputs['totals30'] => ({
  spend: 8_960, impressions: 900_000, purchases: 0, purchase_value: 0, leads: 0,
  complete_registrations: 0, add_to_carts: 0, checkouts_initiated: 0, content_views: 0,
  ...over,
});

const LEAD_GEN = totals30({ leads: 482, spend: 8_960 });
const ECOM = totals30({ purchases: 312, purchase_value: 41_000, add_to_carts: 1_204, checkouts_initiated: 640, content_views: 9_000 });
const MIXED = totals30({ leads: 482, purchases: 40, purchase_value: 6_000, add_to_carts: 300 });
const NO_CONVERSION = totals30();

const day = (i: number): string => new Date(Date.UTC(2026, 3, 1 + i)).toISOString().slice(0, 10);

/** One ad-day. `leads` carries the lead-gen result; purchase value the e-com one. */
function adRows(
  adId: string, name: string, days: number, spendPerDay: number,
  over: Partial<PackAdRow> = {},
): PackAdRow[] {
  return Array.from({ length: days }, (_, i) => ({
    ad_id: adId, ad_name: name, adset_id: null, date: day(i), spend: spendPerDay,
    impressions: 8_000, purchases: 0, purchase_value: 0, results: 0,
    frequency: 1.8, hook_rate: null, hold_rate: null, leads: 0,
    ...over,
  }));
}

/** Everything a reader actually reads. Field NAMES are machine keys, not prose. */
const proseOf = (s: { summary?: string; next_step?: string; warnings?: string[]; derivation?: string }): string =>
  [s.summary, s.next_step, s.derivation, ...(s.warnings ?? [])].filter(Boolean).join(' ');

describe('readAccountLens — the lens is stated, with the account\'s own numbers', () => {
  it('the anchor lead-gen account reads as lead generation and says why', () => {
    const lens = readAccountLens(LEAD_GEN);
    expect(lens.lens).toBe('lead_gen');
    expect(lens.read_as).toBe('Read as: lead generation. Inferred from 482 lead events and zero purchases in the last 30 days.');
    expect(lens.read_as).not.toMatch(/—/);
  });

  it('an e-commerce account reads as e-commerce, with purchases and carts', () => {
    const lens = readAccountLens(ECOM);
    expect(lens.lens).toBe('ecommerce');
    expect(lens.read_as).toContain('312 purchases with revenue');
    expect(lens.read_as).toContain('1,204 add-to-cart events');
  });

  it('purchases without cart events stay a PURCHASE account, never broken tracking', () => {
    const lens = readAccountLens(totals30({ purchases: 312, purchase_value: 41_000 }));
    expect(lens.lens).toBe('ecommerce');
    expect(lens.read_as).toContain('no add-to-cart or checkout events');
  });

  it('leads AND purchase revenue read as mixed; neither reads as unknown', () => {
    expect(readAccountLens(MIXED).lens).toBe('mixed');
    expect(readAccountLens(MIXED).read_as).toContain('482 lead events');
    expect(readAccountLens(NO_CONVERSION).lens).toBe('unknown');
    expect(readAccountLens(NO_CONVERSION).read_as).toContain('no conversion recorded');
  });
});

describe('lens refusals — a grammar we do not have is never guessed', () => {
  it('mixed and unknown accounts skip the sections that need one grammar', () => {
    expect(LENS_DEPENDENT_SECTIONS).toEqual(['budget_scatter', 'concept_roas']);
    expect(lensSkipReason('mixed')).toContain('both leads and purchase revenue');
    expect(lensSkipReason('unknown')).toContain('no purchases and no leads');
  });

  it('a readable lens skips nothing at all', () => {
    expect(lensSkipReason('lead_gen')).toBeNull();
    expect(lensSkipReason('ecommerce')).toBeNull();
  });

  it('the sections that read the same in either grammar are NOT on the skip list', () => {
    for (const key of ['cost_trends', 'spend_concentration', 'timing_patterns', 'creative_cohorts', 'saturation', 'funnel_read']) {
      expect(LENS_DEPENDENT_SECTIONS).not.toContain(key);
    }
  });
});

describe('the synthesis prompt carries the lens as a rule', () => {
  it('a lead-gen brief forbids the four words the account does not have', () => {
    const brief = lensBrief(readAccountLens(LEAD_GEN));
    expect(brief).toContain('cost per lead');
    expect(brief).toMatch(/Do NOT write ROAS, revenue, breakeven/);
    expect(buildSynthSystem('', null, readAccountLens(LEAD_GEN))).toContain('ACCOUNT LENS');
  });

  it('an e-commerce brief keeps ROAS, and a mixed one refuses to total the two', () => {
    expect(lensBrief(readAccountLens(ECOM))).toContain('Meta ROAS');
    expect(lensBrief(readAccountLens(MIXED))).toContain('Never add the two together');
  });

  it('without a lens the prompt is exactly what it was before', () => {
    expect(buildSynthSystem('', null)).toBe(buildSynthSystem('', null, null));
    expect(buildSynthSystem('', null)).not.toContain('ACCOUNT LENS');
  });
});

describe('budget scatter — the e-commerce account keeps its ROAS framing', () => {
  const rows30: PackAdRow[] = [
    ...adRows('e1', 'ecom-winner', 30, 400, { purchase_value: 1_200, purchases: 12 }),
    ...adRows('e2', 'ecom-laggard', 30, 300, { purchase_value: 210, purchases: 2 }),
  ];

  it('plots ROAS, names the breakeven line and keeps the margin fields', () => {
    const s = computeBudgetScatter(rows30, [], 2.22, 'GBP', 45);
    expect(s.data.kpi_mode).toBe('roas');
    expect(s.data.y_axis).toBe('roas');
    expect(s.data.y_axis_label).toBe('ROAS');
    expect(s.data.breakeven_roas).toBe(2.22);
    expect(s.data.gross_margin_pct).toBe(45);
    expect((s.data.dots as ScatterDot[])[0]!.roas_30d).toBeCloseTo(3, 5);
    expect(proseOf(s)).toContain('ROAS');
    expect(proseOf(s)).toContain('2.22× — your breakeven at the 45% gross margin');
    expect(s.data.cpr_line).toBeUndefined();
    expect(s.data.result_noun).toBeUndefined();
  });

  it('the six-stage funnel still belongs to an account that records purchases', () => {
    const f = funnelStages(
      { impressions: 900_000, link_clicks: 9_000, content_views: 6_000, add_to_carts: 1_204, checkouts_initiated: 640, purchases: 312 },
      'GBP',
    );
    expect(f.kind).toBe('ecommerce');
    expect(f.stages.map((s) => s.stage)).toEqual([
      'Impressions', 'Link clicks', 'Content views', 'Add to cart', 'Checkout initiated', 'Purchases',
    ]);
  });
});

describe('budget scatter — the lead-gen account is read in cost per lead', () => {
  // 185.9/day over 30 days = 5,577 spend; 10 leads/day = 300 leads → CPL 18.59.
  const rows30: PackAdRow[] = [
    ...adRows('a1', 'anchor-lead-ad', 30, 185.9, { leads: 10 }),
    ...adRows('a2', 'pricier-lead-ad', 30, 200, { leads: 4 }),
    ...adRows('a3', 'mid-lead-ad', 30, 150, { leads: 5 }),
    ...adRows('a4', 'dear-lead-ad', 30, 120, { leads: 2 }),
  ];
  const leadLens = { resultNoun: 'lead' as const };

  it('the y axis is a cost per lead, and no purchase field is emitted', () => {
    const s = computeBudgetScatter(rows30, [], 1.0, 'USD', null, leadLens);
    expect(s.data.kpi_mode).toBe('cpr');
    expect(s.data.y_axis).toBe('cost_per_result');
    expect(s.data.y_axis_label).toBe('Cost per lead');
    expect(s.data.result_noun).toBe('lead');
    expect(s.data.breakeven_roas).toBeUndefined();
    expect(s.data.gross_margin_pct).toBeUndefined();
    const dots = new Map((s.data.dots as ScatterDot[]).map((d) => [d.ad_id, d]));
    expect(dots.get('a1')!.cpr_30d).toBeCloseTo(18.59, 2);
    expect(dots.get('a1')!.roas_30d).toBeNull();
  });

  it('no ROAS, breakeven or revenue word survives anywhere in the prose', () => {
    const s = computeBudgetScatter(rows30, [], 1.0, 'USD', null, leadLens);
    expect(proseOf(s)).not.toMatch(/roas|breakeven|revenue|1\.0×|earning/i);
    expect(proseOf(s)).toContain('cost per lead');
  });

  it('with no stated target the line is the account\'s own average', () => {
    const s = computeBudgetScatter(rows30, [], 1.0, 'USD', null, leadLens);
    // 655.9/day over 30 days ÷ 21 leads/day = 31.23 per lead across the plotted ads.
    expect(s.data.cpr_average).toBeCloseTo(31.23, 2);
    expect(s.data.cpr_line_source).toBe('account_average');
    expect(proseOf(s)).toContain("this account's own average of 31 USD per lead");
    expect(s.data.cpr_target).toBeUndefined();
  });

  it('a stated target is the line, cited as the owner\'s own', () => {
    const s = computeBudgetScatter(rows30, [], 1.0, 'USD', null, { ...leadLens, costTarget: { metric: 'cpl', value: 40 } });
    expect(s.data.cpr_line).toBe(40);
    expect(s.data.cpr_line_source).toBe('owner_target');
    expect(s.data.cpr_target).toEqual({ metric: 'cpl', value: 40, source: 'owner' });
    expect(proseOf(s)).toContain('your stated target of 40 USD per lead');
    // 18.59 is 25%+ under the 40 target on a below-median share of spend.
    expect(s.data.starved_best_ad).toBe('anchor-lead-ad');
    expect(s.next_step).toContain('buying a lead for 19 USD');
  });

  it('without a target or a target-worthy noun it still refuses to say ROAS', () => {
    const s = computeBudgetScatter(rows30.slice(0, 60), [], 1.0, 'USD');
    expect(s.data.y_axis).toBe('cost_per_result');
    expect(s.data.result_noun).toBe('result');
    expect(proseOf(s)).not.toMatch(/roas|breakeven/i);
  });
});
