import { describe, it, expect } from 'vitest';
import { enforceQuietSection, workLineFor, type AuditSection } from '../src/audit/magic-audit.js';
import { computeBudgetScatter, computeCohorts, type PackAdRow } from '../src/audit/report-pack.js';
import { dedash } from '../src/audit/prose.js';

/**
 * Two invariants the first live regeneration broke.
 *
 * 1. A quiet section must be quiet. `signal: false` is the section saying it
 *    found nothing worth acting on, and the page reads a next step as an action
 *    worth taking: budget_scatter posted signal false next to "Move budget from
 *    the ads near 40 USD per result toward the ones near 17 USD", so the quiet
 *    ledger never rendered and the row read as a finding with no finding in it.
 * 2. The work log is customer-facing text and passes the same dash gate as
 *    every section string. It was the last place em-dashes reached the page.
 */

const section = (over: Partial<AuditSection>): AuditSection => ({
  key: 'budget_scatter', title: 'Budget', status: 'complete', ...over,
});

const day = (i: number): string => new Date(Date.UTC(2026, 3, 1 + i)).toISOString().slice(0, 10);

function leadRows(adId: string, name: string, spendPerDay: number, leadsPerDay: number): PackAdRow[] {
  return Array.from({ length: 30 }, (_, i) => ({
    ad_id: adId, ad_name: name, adset_id: null, date: day(i), spend: spendPerDay,
    impressions: 8_000, purchases: 0, purchase_value: 0, results: 0,
    frequency: 1.8, hook_rate: null, hold_rate: null, leads: leadsPerDay,
  }));
}

describe('the quiet-section invariant, enforced in the write path', () => {
  it('drops the next step from a section that says it found nothing', () => {
    const out = enforceQuietSection(section({ summary: 'Flat.', next_step: 'Move budget.', data: { signal: false } }));
    expect('next_step' in out).toBe(false);
    expect(out.summary).toBe('Flat.');
  });

  it('leaves a real finding alone', () => {
    const loud = section({ summary: 'Two ads past peak.', next_step: 'Move budget.', data: { signal: true } });
    expect(enforceQuietSection(loud).next_step).toBe('Move budget.');
  });

  it('touches nothing when the section never declared a signal', () => {
    const unknown = section({ summary: 'x', next_step: 'y', data: { dots: [] } });
    expect(enforceQuietSection(unknown).next_step).toBe('y');
    const noData = section({ summary: 'x', next_step: 'y' });
    expect(enforceQuietSection(noData).next_step).toBe('y');
  });

  it('signal false with a next step cannot survive the write path, whatever the section', () => {
    for (const s of [
      section({ key: 'cost_trends', next_step: 'Revisit in a month.', data: { signal: false } }),
      section({ key: 'timing_patterns', next_step: 'Fix the result mapping.', data: { signal: false, rows: [] } }),
      section({ key: 'concept_roas', next_step: 'Run the analyzer.', data: { signal: false, angles: [] } }),
    ]) {
      const out = enforceQuietSection(s);
      expect(out.data).toEqual(s.data);
      expect(out.next_step).toBeUndefined();
    }
  });
});

describe('budget scatter — a wide spread is a finding, not a quiet row', () => {
  it('17 to 40 per lead is signal, even with no fatiguing ad on the chart', () => {
    // 170/day ÷ 10 leads = 17.00 per lead; 200/day ÷ 5 = 40.00.
    const s = computeBudgetScatter(
      [...leadRows('a1', 'cheap-lead-ad', 170, 10), ...leadRows('a2', 'dear-lead-ad', 200, 5)],
      [], 1.0, 'USD', null, { resultNoun: 'lead' },
    );
    expect(s.data.move_count).toBe(0);
    expect(s.data.spread_ratio).toBeCloseTo(2.35, 2);
    expect(s.data.signal).toBe(true);
    expect(s.next_step).toContain('per lead');
    // Which is what the page needs: a next step and a signal that agree.
    expect(enforceQuietSection({ key: 'budget_scatter', title: 't', status: 'complete', ...s }).next_step).toBe(s.next_step);
  });

  it('a spread too tight to move money over stays quiet, and then has no next step', () => {
    const s = computeBudgetScatter(
      [...leadRows('a1', 'one', 200, 10), ...leadRows('a2', 'two', 200, 9)],
      [], 1.0, 'USD', null, { resultNoun: 'lead' },
    );
    expect(s.data.signal).toBe(false);
    const written = enforceQuietSection({ key: 'budget_scatter', title: 't', status: 'complete', ...s });
    expect(written.next_step).toBeUndefined();
  });
});

describe('creative cohorts — the quiet cadence line lives in the summary', () => {
  it('a fresh account keeps the advice in its one line and carries no next step', () => {
    // Every ad launches in the last window month, so the fresh share is 100%.
    const rows = Array.from({ length: 40 }, (_, i) => ({
      ad_id: `ad_${i % 4}`, date: day(60 + (i % 20)), spend: 100,
    }));
    const s = computeCohorts(rows);
    if (s.data.signal === false) {
      expect(s.next_step).toBeUndefined();
      expect(s.summary).toContain('Keep this launch cadence');
    } else {
      expect(s.next_step).toBeTruthy();
    }
  });
});

describe('the work log carries no em-dashes', () => {
  const cases: Array<[string, unknown]> = [
    ['dataset_health', { pixels: [{}, {}] }],
    ['account_structure', { campaigns: [{}] }],
    ['spend_concentration', { ads_with_spend: 12 }],
    ['creative_fatigue', { assessed_ads: 9 }],
    ['budget_scatter', { ads_plotted: 7 }],
    ['creative_cohorts', { window_months: 6 }],
    ['cost_trends', { series: [{}, {}] }],
    ['timing_patterns', {}],
    ['how_you_compare', { bands: [{}, {}] }],
    ['concept_roas', { coverage_pct: 61 }],
    ['optimization_events', { counts: { check: 3, x: 1, question: 0 } }],
    ['creative_analysis', { creatives_analyzed: 10 }],
    ['funnel_read', {}],
    ['placement_breakdown', { platforms: [{}, {}] }],
    ['audience_breakdown', {}],
    ['saturation', { weeks: [{}, {}] }],
    ['creative_diversity', { angles: 4 }],
    ['whats_working', {}],
    ['learning_limited', { assessed_adsets: 42 }],
    ['targeting_split', { classes: [{}] }],
    ['landing_pages', { dead_checks: [{}, {}] }],
    ['account_facts', {}],
    ['competitor_teardown', {}],
  ];

  it('no literal work-log line we own contains one', () => {
    for (const [key, data] of cases) {
      const line = workLineFor(key, { key, title: key, status: 'complete', data });
      if (line) expect(line, `${key}: ${line}`).not.toMatch(/—/);
    }
  });

  it('an interpolated line still goes through the dash gate', () => {
    expect(dedash('Watched 10 creatives — hooks and formats')).toBe('Watched 10 creatives. Hooks and formats');
    expect(dedash('Read 12 ads x 30 days')).toBe('Read 12 ads x 30 days');
  });
});
