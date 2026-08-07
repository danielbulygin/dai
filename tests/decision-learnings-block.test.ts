import { describe, it, expect } from 'vitest';
import { renderDecisionLearningsBlock } from '../scripts/ada-console-assist.js';

/**
 * Loop 4 — "decisions carry forward". The block that puts a client's most
 * recent decision-learnings in front of Ada BEFORE she drafts a proposal, so a
 * rejection with a reason ("we never scale that fast") shapes the next
 * suggestion instead of dying with the session.
 *
 * Only the pure renderer is exercised here; the fetch is fail-open and lives
 * against Supabase.
 */
describe('renderDecisionLearningsBlock', () => {
  const learnings = [
    { id: 'l1', created_at: '2026-08-06T09:14:00.000Z', content: 'Daniel: "we never scale a set more than 20% a day, it resets learning"' },
    { id: 'l2', created_at: '2026-08-04T17:02:11.000Z', content: 'CBO only on this account — Nina rejected per-ad-set budgets' },
  ];

  it('renders one dated line per learning under the decisions heading', () => {
    const block = renderDecisionLearningsBlock(learnings);
    expect(block).toContain('### DECISIONS DANIEL/NINA HAVE ALREADY MADE (apply these before proposing)');
    expect(block).toContain('- 2026-08-06 · Daniel: "we never scale a set more than 20% a day, it resets learning"');
    expect(block).toContain('- 2026-08-04 · CBO only on this account — Nina rejected per-ad-set budgets');
    // The standing rule: a reasoned rejection is not re-proposed.
    expect(block).toContain('Never re-propose something rejected here');
  });

  it('returns empty string for no learnings, so the caller drops the block', () => {
    expect(renderDecisionLearningsBlock([])).toBe('');
    // Blank content is not a decision.
    expect(renderDecisionLearningsBlock([{ id: 'x', created_at: '2026-08-06T09:14:00.000Z', content: '   ' }])).toBe('');
  });

  it('names the customer, not our team, on the portal surface', () => {
    const block = renderDecisionLearningsBlock(learnings, 'THIS CUSTOMER HAS');
    expect(block).toContain('### DECISIONS THIS CUSTOMER HAS ALREADY MADE');
    expect(block).not.toContain('DANIEL');
  });

  it('is one line per entry: newlines collapse, long text truncates', () => {
    const block = renderDecisionLearningsBlock([
      { id: 'l1', created_at: '2026-08-06T09:14:00.000Z', content: `line one\nline two\n\nline three` },
      { id: 'l2', created_at: '2026-08-05T09:14:00.000Z', content: 'x'.repeat(400) },
    ]);
    expect(block).toContain('- 2026-08-06 · line one line two line three');
    const long = block.split('\n').find((l) => l.includes('xxx'))!;
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThan(270);
  });

  it('dedupes repeated decisions, caps at 8, and survives a missing date', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `l${i}`, created_at: `2026-08-${String(20 - i).padStart(2, '0')}T00:00:00.000Z`, content: `decision ${i}`,
    }));
    const block = renderDecisionLearningsBlock([
      ...many,
      { id: 'dupe', created_at: '2026-08-01T00:00:00.000Z', content: 'DECISION 0' },
    ]);
    expect(block.split('\n').filter((l) => l.startsWith('- ')).length).toBe(8);
    expect(block).not.toContain('DECISION 0');

    const undated = renderDecisionLearningsBlock([{ id: 'u', created_at: '', content: 'no date on this one' }]);
    expect(undated).toContain('- (undated) · no date on this one');
  });
});
