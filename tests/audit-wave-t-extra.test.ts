import { describe, it, expect } from 'vitest';
import { buildScorecard, type ScorecardEntry, type ScorecardInputs } from '../src/audit/scorecard.js';

/**
 * Second customer-simulation round on a live report (2026-08-21). The report
 * graded creative freshness a strength while two of the account's three biggest
 * spenders had a last-14-day cost per lead 25%+ worse than their own first half.
 * Freshness measures how RECENTLY creative launched, so a young-and-decaying
 * portfolio scores high on exactly the number that must not read as a strength:
 * the caller (which holds the fatigue rows) caps the band.
 */

const freshness = (f: NonNullable<ScorecardInputs['freshness']>): ScorecardEntry =>
  buildScorecard({ freshness: f }).find((e) => e.key === 'freshness')!;

const allStrings = (e: ScorecardEntry): string[] =>
  [e.position, e.lever, e.next_step, e.derivation ?? '', e.quantified ?? ''];

describe('scorecard freshness cap — a decaying portfolio never grades strong on recency', () => {
  const REASON = 'two of your three biggest spenders cost 25%+ more per lead in the last 14 days than in their own first half';

  it('a capped high value grades middle, not strong', () => {
    const e = freshness({ value: 62.4, capBand: 'middle', capReason: REASON });
    expect(e.band).toBe('middle');
    expect(e.value).toBe(62.4);
  });

  it('nothing in a capped entry reads as a strength', () => {
    for (const value of [40, 62.4, 88, 100]) {
      const e = freshness({ value, capBand: 'middle', capReason: REASON });
      expect(e.band).toBe('middle');
      for (const s of allStrings(e)) {
        expect(s, s).not.toMatch(/strength|healthy refresh|keep the cadence|genuine/i);
      }
    }
  });

  it('the capped wording follows from the cap, not from the value', () => {
    const high = freshness({ value: 88, capBand: 'middle', capReason: REASON });
    const mid = freshness({ value: 22, capBand: 'middle', capReason: REASON });
    // Same cap sentence either side of the strong threshold; only the number moves.
    expect(high.position).toContain('graded middle and no higher');
    expect(mid.position).toContain('graded middle and no higher');
    expect(high.position).toContain('88% of this month\'s spend');
    expect(mid.position).toContain('22% of this month\'s spend');
    expect(high.next_step).toBe(mid.next_step);
    expect(high.lever).toBe(mid.lever);
    // Neither one tells the reader to launch more before fixing what is live.
    expect(high.next_step).toContain('before briefing more');
    expect(high.next_step).not.toMatch(/nudge the launch cadence/i);
  });

  it('the caller\'s reason is carried verbatim into the position and the derivation', () => {
    const e = freshness({ value: 62.4, capBand: 'middle', capReason: REASON });
    expect(e.position).toContain(REASON);
    expect(e.derivation).toContain(REASON);
    expect(e.derivation).toContain('Held at middle whatever the share is');
  });

  it('a cap with no reason states the cap without inventing a cause', () => {
    const e = freshness({ value: 62.4, capBand: 'middle' });
    expect(e.band).toBe('middle');
    expect(e.position).toContain('the performance behind that spend does not support a higher grade');
    for (const s of allStrings(e)) expect(s, s).not.toContain('undefined');
  });

  it('a blank reason falls back rather than rendering an empty clause', () => {
    const e = freshness({ value: 62.4, capBand: 'middle', capReason: '   ' });
    expect(e.position).toContain('the performance behind that spend does not support a higher grade');
    expect(e.position).not.toMatch(/:\s*\./);
  });

  it('the cap is a CEILING: a value that already grades weak keeps its weak wording', () => {
    const capped = freshness({ value: 8, capBand: 'middle', capReason: REASON });
    const uncapped = freshness({ value: 8 });
    expect(capped.band).toBe('weak');
    expect(capped).toEqual(uncapped);
  });

  it('the capped entry sorts with the middle band, never last as the closing strength', () => {
    const entries = buildScorecard({
      freshness: { value: 88, capBand: 'middle', capReason: REASON },
      cpmTrend: { value: -22 },
    });
    expect(entries.map((e) => e.key)).toEqual(['freshness', 'cpm_trend']);
    expect(entries[entries.length - 1]!.band).toBe('strong');
    expect(entries[entries.length - 1]!.key).toBe('cpm_trend');
  });

  it('the cap touches nothing else on the scorecard', () => {
    const withCap = buildScorecard({ freshness: { value: 88, capBand: 'middle' }, cpmTrend: { value: -22 }, concentration: { value: 71 } });
    const without = buildScorecard({ freshness: { value: 88 }, cpmTrend: { value: -22 }, concentration: { value: 71 } });
    const others = (list: ScorecardEntry[]) => list.filter((e) => e.key !== 'freshness');
    expect(others(withCap)).toEqual(others(without));
  });
});

describe('scorecard freshness without a cap — byte-identical to before the cap existed', () => {
  it('a strong value keeps every string it had', () => {
    const e = freshness({ value: 62.4 });
    expect(e.band).toBe('strong');
    expect(e.position).toBe("Creative freshness — healthy refresh rhythm (62.4% of this month's spend on recent launches)");
    expect(e.lever).toBe('How quickly new creative earns budget.');
    expect(e.next_step).toBe('Keep the cadence.');
    expect(e.derivation).toBe(
      "The share of this month's spend on creatives that first spent in the last ~2 months — full method in the launch-cohorts report below.",
    );
  });

  it('a middle value keeps every string it had', () => {
    const e = freshness({ value: 22 });
    expect(e.band).toBe('middle');
    expect(e.position).toBe('Creative freshness — modest refresh rhythm (22%)');
    expect(e.next_step).toBe('Nudge the launch cadence up; watch the cohort chart month over month.');
    expect(e.lever).toBe('How quickly new creative earns budget.');
  });

  it('a weak value keeps every string it had', () => {
    const e = freshness({ value: 8 });
    expect(e.band).toBe('weak');
    expect(e.position).toBe('Creative freshness — the account is living off old creative (8% of spend on recent launches)');
    expect(e.next_step).toBe('Set a monthly launch quota — the fatigue cliff builds exactly here.');
  });

  it('an explicitly undefined cap is the same entry as no cap at all', () => {
    expect(freshness({ value: 62.4, capBand: undefined, capReason: undefined })).toEqual(freshness({ value: 62.4 }));
  });
});
