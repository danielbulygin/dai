import { describe, it, expect } from 'vitest';
import { buildColdKnowledge } from '../src/audit/cold-source.js';

/**
 * Goal anchoring: the target in the report is the OWNER'S OWN, and "no target
 * set" may only appear when they gave us neither a funnel goal nor an account
 * target. The absent case is pinned byte for byte, because an audit for a lead
 * who told us nothing must read exactly as it did before this wiring existed.
 */

const ABSENT =
  "The owner gave us NO target, margin, or breakeven. NEVER invent, assume, or imply one. " +
  "Anchor judgments to the account's own observed figures and, where a target would matter, say plainly " +
  "that no target has been set yet. No other client history is available — this is a first-time audit of " +
  'a freshly connected account.';

describe('a stated target is cited as the owner\'s own', () => {
  it('a funnel answer is "at signup", with the in-text attribution rule', () => {
    const k = buildColdKnowledge({ goalMetric: 'cpl', goalValue: 40, goalSource: 'signup', grossMarginPct: null, breakevenRoas: 1.0 });
    expect(k).toContain('The account owner set this target themselves at signup: CPL of 40.');
    expect(k).toContain('the CPL 40 target you set when you connected');
    expect(k).not.toContain('no target has been set yet');
  });

  it('the same number on the ad account says so, and still says "your stated target"', () => {
    const k = buildColdKnowledge({ goalMetric: 'cpl', goalValue: 40, goalSource: 'account', grossMarginPct: null, breakevenRoas: 1.0 });
    expect(k).toContain('set this target themselves on their ad account: CPL of 40.');
    expect(k).toContain('"your stated target of 40 CPL"');
    expect(k).not.toContain('no target has been set yet');
  });

  it('an unstated source reads exactly like the signup wording it always did', () => {
    expect(buildColdKnowledge({ goalMetric: 'cpa', goalValue: 30, grossMarginPct: null, breakevenRoas: 1.0 })).toBe(
      buildColdKnowledge({ goalMetric: 'cpa', goalValue: 30, goalSource: 'signup', grossMarginPct: null, breakevenRoas: 1.0 }),
    );
  });

  it('a margin still drives the breakeven derivation, cited as theirs', () => {
    const k = buildColdKnowledge({ goalMetric: 'roas', goalValue: 3, goalSource: 'signup', grossMarginPct: 62, breakevenRoas: 1.61 });
    expect(k).toContain('gross margin at signup: 62%');
    expect(k).toContain('true breakeven at 1.61x ROAS');
    expect(k).toContain('at your stated 62% margin');
  });
});

describe('told nothing, the knowledge string is byte-identical to today', () => {
  it('no goal, no margin, no interview', () => {
    expect(buildColdKnowledge({ goalMetric: null, goalValue: null, grossMarginPct: null, breakevenRoas: 1.0 })).toBe(ABSENT);
  });

  it('an empty or all-null interview adds nothing at all', () => {
    for (const interview of [
      null,
      undefined,
      { who_runs_ads: null, pain_point: null, tried: [], agency_fee: null },
      { who_runs_ads: '  ', pain_point: '', tried: ['', ' '], agency_fee: null },
    ]) {
      expect(
        buildColdKnowledge({ goalMetric: null, goalValue: null, goalSource: null, grossMarginPct: null, breakevenRoas: 1.0, interview }),
      ).toBe(ABSENT);
    }
  });
});

describe('the owner\'s own words ride along, attributed', () => {
  it('quotes every answer they gave and never claims we measured it', () => {
    const k = buildColdKnowledge({
      goalMetric: 'cpl',
      goalValue: 40,
      goalSource: 'signup',
      grossMarginPct: 62,
      breakevenRoas: 1.61,
      interview: {
        who_runs_ads: 'an agency on a monthly retainer',
        pain_point: 'leads come in but nobody buys',
        tried: ['lookalikes', 'a new landing page'],
        agency_fee: '2,000 a month',
      },
    });
    expect(k).toContain('in their own words');
    expect(k).toContain('who runs the ads today: "an agency on a monthly retainer"');
    expect(k).toContain('what hurts most right now: "leads come in but nobody buys"');
    expect(k).toContain('what they pay for ads management: "2,000 a month"');
    expect(k).toContain('what they have already tried: "lookalikes, a new landing page"');
    expect(k).toContain('Cite any of it as what THEY said, never as something we measured');
  });

  it('one answer is enough, and the missing ones are not mentioned', () => {
    const k = buildColdKnowledge({
      goalMetric: null, goalValue: null, grossMarginPct: null, breakevenRoas: 1.0,
      interview: { who_runs_ads: null, pain_point: 'the cost per lead doubled', tried: [], agency_fee: null },
    });
    expect(k).toContain('what hurts most right now: "the cost per lead doubled"');
    expect(k).not.toContain('who runs the ads today');
    expect(k).not.toContain('already tried');
    // Nothing stated about money still means nothing invented about money.
    expect(k).toContain('NEVER invent, assume, or imply one');
  });
});
