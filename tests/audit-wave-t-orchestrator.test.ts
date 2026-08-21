import { describe, it, expect } from 'vitest';
import { computeTargetGap, targetGapBrief, directionOf, buildInsightRules } from '../src/audit/magic-audit.js';
import { annotateWinnerDecay, decayIndex, type FatigueDecayRow } from '../src/audit/cold-creative-source.js';
import { collapseRepeat, extractPage, reconcileChecks, stripHtml, type MatchCheck } from '../src/audit/site-walk.js';

/**
 * Sim round two. The owner scored the report 4 of 5; these are the sentences the
 * buyer could still take apart. The gap to the owner's OWN target was never
 * priced, a winner was called cheap while its last fortnight ran 40% dearer, one
 * page quote was printed twice, and 19.57 against 19.63 was called "worse".
 */

describe('the target gap is money, computed here', () => {
  const gap = computeTargetGap({
    metric: 'cpl', target: 15, cpl: 18.67, leads30d: 483, currency: 'USD',
    ctrNow: 1.0, ctrRecoverable: 1.3,
  });

  it('prices the gap against the owner\'s own target, with the formula it used', () => {
    expect(gap).not.toBeNull();
    expect(gap!.monthly_over_target_usd).toBe(1773); // 483 x 3.67
    expect(gap!.formula).toBe('483 leads x (18.67 - 15.00)');
    expect(gap!.target).toBe(15);
    expect(gap!.cpl).toBe(18.67);
  });

  it('offers the recovery price only from a rate the account already held', () => {
    expect(gap!.recovery_cpl_usd).toBeCloseTo(14.36, 2);
    expect(gap!.recovery_formula).toBe('18.67 x (1 / 1.3)');
    expect(gap!.ctr_now_basis).toContain('last 30 days');
    expect(gap!.ctr_recoverable_basis).toContain('weekly average');

    const noHeldRate = computeTargetGap({ metric: 'cpl', target: 15, cpl: 18.67, leads30d: 483, currency: 'USD', ctrNow: 1.3, ctrRecoverable: 1.0 });
    expect(noHeldRate!.recovery_cpl_usd).toBeUndefined();
    expect(noHeldRate!.recovery_formula).toBeUndefined();
  });

  it('says nothing without a target, without leads, or when the account is already under it', () => {
    expect(computeTargetGap({ metric: null, target: null, cpl: 18.67, leads30d: 483, currency: 'USD' })).toBeNull();
    expect(computeTargetGap({ metric: 'cpl', target: 15, cpl: null, leads30d: 483, currency: 'USD' })).toBeNull();
    expect(computeTargetGap({ metric: 'cpl', target: 15, cpl: 18.67, leads30d: 0, currency: 'USD' })).toBeNull();
    expect(computeTargetGap({ metric: 'cpl', target: 20, cpl: 18.67, leads30d: 483, currency: 'USD' })).toBeNull();
  });

  it('the brief quotes the computed figures and forbids new arithmetic', () => {
    const brief = targetGapBrief(gap!);
    expect(brief).toContain('CPL 15.00 USD');
    expect(brief).toContain('1773 USD a month over their own target (483 leads x (18.67 - 15.00))');
    expect(brief).toContain('prices a lead near 14.36 USD');
    expect(brief).toContain('quote these figures verbatim');
    expect(brief).toContain('number one opportunity');
    expect(brief).toContain('a recovery of a rate they already achieved');
    expect(brief).not.toMatch(/—/);
  });

  it('the insight ranker gets the same gap as its number one rule', () => {
    const rules = buildInsightRules({ currency: 'USD', lens: 'lead_gen', totals30: null, fatigue: null, targetGap: gap });
    expect(rules).toContain('1773 USD a month over their own target');
    expect(rules).toContain('number one opportunity');
  });
});

describe('a direction word is computed, never inferred', () => {
  it('a cost that fell is better, and a 0.3% move is flat', () => {
    expect(directionOf(19.57, 19.63, 'lower_is_better')).toBe('flat');
    expect(directionOf(17.0, 22.0, 'lower_is_better')).toBe('better');
    expect(directionOf(23.81, 14.14, 'lower_is_better')).toBe('worse');
    expect(directionOf(3.2, 2.0, 'higher_is_better')).toBe('better');
    expect(directionOf(null, 19.63, 'lower_is_better')).toBeNull();
    expect(directionOf(19.57, 0, 'lower_is_better')).toBeNull();
  });
});

describe('a winner carries its own decay', () => {
  const rows: FatigueDecayRow[] = [
    { ad_id: 'a1', ad_name: 'SB-parents', cpl_first_half: 14.14, cpl_last_14: 23.81 },
    { ad_id: 'a2', ad_name: 'ASH', cpl_first_half: 16.68, cpl_last_14: 17.2 },
    { ad_id: 'a3', ad_name: 'Twins', cpl_first_half: 20, cpl_last_14: 20 },
    { ad_id: 'a4', ad_name: 'Twins', cpl_first_half: 40, cpl_last_14: 10 },
  ];

  it('indexes by name, drops a name two ads share, and computes the decay', () => {
    const index = decayIndex(rows);
    expect(index.get('SB-parents')!.decay_pct).toBeCloseTo(68.4, 1);
    expect(index.get('ASH')!.decay_pct).toBeCloseTo(3.1, 1);
    expect(index.has('Twins')).toBe(false);
  });

  it('appends the two figures to a decaying winner and leaves the others alone', () => {
    const index = decayIndex(rows);
    const winners = [
      { ad_name: 'SB-parents', why: 'Cheapest lead in the account.' },
      { ad_name: 'ASH', why: 'Steady performer.' },
      { ad_name: 'Twins', why: 'Unattributable.' },
    ];
    const out = annotateWinnerDecay(winners, index, 'USD');
    expect(out[0]!.why).toBe('Cheapest lead in the account. It averaged 14.14 USD per lead over the first half of its run and its last fortnight runs 23.81 USD.');
    expect(out[1]!.why).toBe('Steady performer.');
    expect(out[2]!.why).toBe('Unattributable.');
  });

  it('does not repeat a figure the model already stated', () => {
    const out = annotateWinnerDecay(
      [{ ad_name: 'SB-parents', why: 'Its last fortnight runs 23.81 per lead.' }],
      decayIndex(rows),
      'USD',
    );
    expect(out[0]!.why).toBe('Its last fortnight runs 23.81 per lead.');
  });
});

describe('the walker prints a page quote once', () => {
  it('collapses a phrase the markup carries twice', () => {
    expect(collapseRepeat('$2,000,000 Life Cover from $1 /day$2,000,000 Life Cover from $1 /day')).toBe('$2,000,000 Life Cover from $1 /day');
    expect(collapseRepeat('Life cover from 12 USD Life cover from 12 USD')).toBe('Life cover from 12 USD');
    expect(collapseRepeat('Cover your family')).toBe('Cover your family');
    expect(collapseRepeat('Go go')).toBe('Go go');
  });

  it('the extracted headline is the phrase, not the phrase twice', () => {
    const html = '<html><head><title>Northline</title></head><body><h1><span class="sr-only">$2,000,000 Life Cover from $1 /day</span>$2,000,000 Life Cover from $1 /day</h1><p>' + 'Terms apply to every policy. '.repeat(12) + '</p></body></html>';
    expect(extractPage(html).headline).toBe('$2,000,000 Life Cover from $1 /day');
  });

  it('two promises landing on the same page line count once', () => {
    const text = stripHtml('<html><body><p>See your personalised rate in 60 seconds. No medical exam for most applicants.</p></body></html>');
    const deterministic: MatchCheck[] = [];
    const out = reconcileChecks(
      deterministic,
      [
        { promise: 'a rate in 60 seconds', found_on_page: true, page_evidence: 'See your personalised rate in 60 seconds' },
        { promise: 'a personalised quote', found_on_page: true, page_evidence: 'See your personalised rate in 60 seconds' },
        { promise: 'no medical exam', found_on_page: true, page_evidence: 'No medical exam for most applicants' },
      ],
      text,
    );
    expect(out.map((c) => c.promise)).toEqual(['a rate in 60 seconds', 'no medical exam']);
  });

  it('a deterministic check\'s evidence line also blocks a duplicate from the read', () => {
    const text = stripHtml('<html><body><p>Use code SAVE20 for 20% off your first year of cover today.</p></body></html>');
    const out = reconcileChecks(
      [{ promise: 'code SAVE20', found_on_page: true, page_evidence: 'code SAVE20 for 20% off', source: 'deterministic' }],
      [{ promise: '20% off', found_on_page: true, page_evidence: 'code SAVE20 for 20% off' }],
      text,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.source).toBe('deterministic');
  });
});
