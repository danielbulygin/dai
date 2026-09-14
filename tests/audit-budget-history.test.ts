import { describe, expect, it } from 'vitest';
import { computeBudgetHistory, withBudgetHistory } from '../src/audit/budget-history.js';
import { toChangeReceipts } from '../src/audit/tinkers-reads.js';
import type { ChangeReceipt } from '../src/audit/root-cause.js';

const edit = (at: string, fromBudget: number, toBudget: number, objectId = 'set_1'): ChangeReceipt => ({
  at, fromBudget, toBudget, objectId, objectName: 'Broad', objectType: 'CAMPAIGN', actorName: null,
  kind: toBudget > fromBudget ? 'budget_increased' : 'budget_decreased',
});
const run = (changes: ChangeReceipt[] | null, partial = false) => computeBudgetHistory({
  changes, partial, asOf: '2026-09-14', windowDays: 90, currency: 'EUR',
});
const repeated = [
  edit('2026-09-10T09:00:00Z', 200, 300),
  edit('2026-09-12T09:00:00Z', 300, 390),
  edit('2026-09-14T07:14:56Z', 390, 300),
  edit('2026-09-14T16:01:20Z', 300, 350),
];

describe('budget history', () => {
  it('measures repeated substantial edits and reversals without inventing learning resets', () => {
    const result = run(repeated);
    expect(result.data).toMatchObject({
      signal: true, partial: false, total_edits: 4, total_edits_30d: 4, substantial_edits: 3,
      objects_with_repeated_substantial_edits: 1, objects_with_repeated_substantial_edits_30d: 1,
      direction_reversals_within_48h: 2, learning_resets_confirmed: null, learning_state_history_available: false,
    });
    expect(result.data.entities).toMatchObject([{
      object_id: 'set_1', shortest_gap_hours: 8.8,
      peak_7d: { edits: 4, substantial_edits: 3 },
      recent_examples: [
        { from_budget: 200, to_budget: 300, change_pct: 50 },
        { from_budget: 300, to_budget: 390, change_pct: 30 },
        { from_budget: 390, to_budget: 300, change_pct: -23.1 },
        { from_budget: 300, to_budget: 350, change_pct: 16.7 },
      ],
    }]);
    expect(result.warnings?.join(' ')).toContain('cannot confirm or count learning resets');
    expect(result.next_step).toContain('budget and a review window');
  });

  it('does not mistake small daily edits or one isolated large edit for repeated substantial edits', () => {
    const result = run([
      edit('2026-09-01', 100, 200), edit('2026-09-10', 200, 210),
      edit('2026-09-11', 210, 215), edit('2026-09-12', 215, 220),
    ]);
    expect(result.data).toMatchObject({ total_edits: 4, substantial_edits: 1, signal: false });
    expect(result.next_step).toBeUndefined();
  });

  it('groups by object identity, not a shared name, and deduplicates equivalent timestamps', () => {
    const rows = toChangeReceipts(repeated.map((row, i) => ({ ...row, objectId: `set_${i}` })));
    expect(rows[0]?.objectId).toBe('set_0');
    expect(run(rows).data).toMatchObject({ objects_with_edits: 4, signal: false });
    expect(run([...repeated, { ...repeated[0]!, at: '2026-09-10T11:00:00+02:00' }]).data.total_edits).toBe(4);
  });

  it('keeps amounts with zero as an edit without an infinite percentage, and excludes no-ops and out-of-window rows', () => {
    const result = run([
      edit('2026-09-14', 0, 100), edit('2026-09-14', 100, 100),
      edit('2026-09-15', 100, 200), edit('2026-05-01', 100, 200),
    ]);
    expect(result.data).toMatchObject({ total_edits: 1, substantial_edits: 0, signal: false });
    expect(result.data.entities).toMatchObject([{ recent_examples: [{ change_pct: null }] }]);
  });

  it('keeps partial, malformed and unavailable evidence distinct from an empty complete read', () => {
    expect(run(null).data).toMatchObject({ available: false, partial: true });
    const partial = run([], true);
    expect(partial.summary).toContain('missing history prevents a clean conclusion');
    expect(run([{ ...repeated[0]!, objectId: null }]).data).toMatchObject({ total_edits: 0, unreadable_changes: 1, partial: true });
    expect(run([]).data).toMatchObject({ total_edits: 0, available: true, partial: false });
  });

  it('distinguishes old recurrence from the last 30 days and retains evidence when enriching learning', () => {
    const old = run(repeated.map((row) => ({ ...row, at: row.at.replace('2026-09', '2026-07') })));
    expect(old.data).toMatchObject({ signal: true, objects_with_repeated_substantial_edits_30d: 0 });
    const enriched = withBudgetHistory({ summary: 'Weekly event volume is low.', next_step: 'Consider consolidation.', data: { signal: true } }, run(repeated));
    expect(enriched.summary).toContain('4 budget edits');
    expect(enriched.next_step).toContain('Do not consolidate solely');
    expect(enriched.data.budget_history).toMatchObject({ total_edits: 4, learning_resets_confirmed: null });
  });
});
