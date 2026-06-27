import { describe, it, expect } from 'vitest';
import { matchDeadEnd, distinctiveTokens, type DeadEndRow } from '../src/agents/sdk/dead-end-match.js';

// The JVA dead-end as it lives in the ada_dead_ends KB.
const JVA_ROW: DeadEndRow = {
  id: 'jva-outcome-sales',
  kind: 'tool_error',
  signal: 'OUTCOME_SALES launch rejected — LEAD invalid on a sales campaign (Meta error_subcode 2446814)',
  resolution: 'Mini-course on an OUTCOME_SALES bank optimizes for INITIATED_CHECKOUT, not LEAD. Relaunch with channel=minicourse.',
  status: 'open',
};
const OTHER_ROW: DeadEndRow = {
  id: 'voice-qc-timeout',
  kind: 'timeout',
  signal: 'qc_copy timed out after 120000ms (serial Opus calls)',
  status: 'open',
};

const JVA_ERROR =
  'SafetyError: Meta rejected a LEAD event on an OUTCOME_SALES campaign (error_subcode 2446814). HTTP 500.';

describe('failure organ — matchDeadEnd', () => {
  it('THE wedge: matches the JVA launch error to its dead-end row (via subcode + identifiers)', () => {
    const m = matchDeadEnd(JVA_ERROR, [OTHER_ROW, JVA_ROW]);
    expect(m).not.toBeNull();
    expect(m!.row.id).toBe('jva-outcome-sales');
    expect(m!.matchedOn).toEqual(expect.arrayContaining(['2446814', 'outcome_sales', 'lead']));
    expect(m!.row.resolution).toContain('INITIATED_CHECKOUT');
  });

  it('a single shared distinctive code (the Meta subcode) is enough', () => {
    const m = matchDeadEnd('Some other phrasing entirely, code 2446814', [JVA_ROW]);
    expect(m?.row.id).toBe('jva-outcome-sales');
    expect(m?.matchedOn).toContain('2446814');
  });

  it('returns null when nothing distinctive matches', () => {
    expect(matchDeadEnd('A totally unrelated network blip', [JVA_ROW, OTHER_ROW])).toBeNull();
  });

  it('returns null for an error with no distinctive tokens', () => {
    expect(matchDeadEnd('it broke', [JVA_ROW])).toBeNull();
  });

  it('skips dismissed rows (a retired dead-end is not applied)', () => {
    const dismissed = { ...JVA_ROW, status: 'dismissed' };
    expect(matchDeadEnd(JVA_ERROR, [dismissed])).toBeNull();
  });

  it('picks the row with the MOST shared distinctive tokens', () => {
    const weak: DeadEndRow = { kind: 'error', signal: 'something with LEAD only', status: 'open' };
    const m = matchDeadEnd(JVA_ERROR, [weak, JVA_ROW]);
    expect(m!.row.id).toBe('jva-outcome-sales'); // shares 3 tokens vs weak's 1
  });

  it('distinctiveTokens extracts subcodes + ALL-CAPS identifiers, ignores prose', () => {
    const t = distinctiveTokens(JVA_ERROR);
    expect(t).toContain('2446814');
    expect(t).toContain('outcome_sales');
    expect(t).toContain('lead');
    expect(t).not.toContain('rejected'); // prose is ignored
  });
});
