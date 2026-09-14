import { describe, expect, it } from 'vitest';
import { anchoredWindowBrief, anchoredWindowNote, anchorWindowWords, resolveAuditWindow } from '../src/audit/audit-window.js';
import { buildColdKnowledge, buildColdRows } from '../src/audit/cold-source.js';

const coverage = { since: '2026-06-14', until: '2026-09-14', requestedSince: '2026-03-16', complete: false };

describe('verified audit coverage and owner context', () => {
  it('keeps the covered range on both the report receipt and synthesis instructions', () => {
    const rows = buildColdRows({ adDays: [{ ad_id: 'ad_1', date_start: '2026-09-14', spend: '10', impressions: '100' }], asOf: '2026-09-14', readCoverage: coverage });
    expect(rows.window.readCoverage).toEqual(coverage);
    expect(anchoredWindowNote(rows.window)).toContain('2026-06-14 through 2026-09-14');
    expect(anchoredWindowBrief(rows.window)).toContain('Missing dates are unknown, not zero');
    expect(anchorWindowWords('Best ads in the last six months', rows.window)).toBe('Best ads in the verified period');
    expect(anchorWindowWords('Best ads over the six months', rows.window)).toBe('Best ads over the verified period');
  });
  it('preserves existing full-history and dormant-window wording', () => {
    const window = resolveAuditWindow({ asOf: '2026-09-14', lastSpendDate: '2026-09-14' });
    window.readCoverage = { ...coverage, complete: true };
    expect(anchoredWindowNote(window)).toBeNull();
    expect(anchorWindowWords('Six-month history', window)).toBe('Six-month history');
    const dormant = resolveAuditWindow({ asOf: '2026-09-14', lastSpendDate: '2026-08-01' });
    dormant.readCoverage = coverage;
    expect(anchoredWindowNote(dormant)).toContain('last spent on 1 Aug');
    expect(anchoredWindowNote(dormant)).toContain('Earlier history could not be verified');
  });
  it('cites current business answers as customer statements while keeping absent targets absent', () => {
    const text = buildColdKnowledge({ grossMarginPct: null, breakevenRoas: 1,
      interview: { what_you_sell: 'Alcohol-free drinks', judge_results: 'We use Ads Manager.' },
      customerFacts: ['Repeat purchases matter.'],
    });
    expect(text).toContain('Alcohol-free drinks');
    expect(text).toContain('We use Ads Manager.');
    expect(text).toContain('Repeat purchases matter.');
    expect(text).toContain('NO target');
    expect(text).toContain("owner's statements, not measured account results");
  });
});
