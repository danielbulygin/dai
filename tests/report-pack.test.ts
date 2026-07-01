import { describe, it, expect } from 'vitest';
import {
  computeConcentration, computeFatigue, computeCohorts, computeCostTrend, computeDayOfWeek, kpiMode,
  type PackAdRow, type PackAccountRow,
} from '../src/audit/report-pack.js';
import { buildScorecard, cohortPosition } from '../src/audit/scorecard.js';

/**
 * The fast tier's BINDING rules (design spec 2026-06-25), pinned:
 * fatigue = ROAS trend never age (evergreen protected) · low-frequency
 * below-breakeven = acquisition guard, never a kill call · statistical floors ·
 * a Next step on every report · honest suppression when data is thin.
 */

const day = (i: number): string => {
  const d = new Date(Date.UTC(2026, 3, 1 + i)); // Apr 1 + i
  return d.toISOString().slice(0, 10);
};

function adRows(adId: string, name: string, days: number, spendPerDay: number, roasByDay: (i: number) => number, freq = 2.0): PackAdRow[] {
  return Array.from({ length: days }, (_, i) => ({
    ad_id: adId, ad_name: name, date: day(i), spend: spendPerDay,
    impressions: 10_000, purchases: 5, purchase_value: spendPerDay * roasByDay(i),
    results: 5, frequency: freq, hook_rate: 25, hold_rate: 10,
  }));
}

describe('kpiMode', () => {
  it('roas when purchase value exists, cpr otherwise', () => {
    expect(kpiMode([{ purchase_value: 100, results: 3 }])).toBe('roas');
    expect(kpiMode([{ purchase_value: 0, results: 3 }])).toBe('cpr');
  });
});

describe('spend concentration', () => {
  it('flags key-man risk and gives the benchmark band', () => {
    const rows = [
      ...adRows('a1', 'hero', 30, 700, () => 2),
      ...adRows('a2', 'second', 30, 100, () => 2),
      ...adRows('a3', 'third', 30, 100, () => 2),
      ...adRows('a4', 'fourth', 30, 50, () => 2),
      ...adRows('a5', 'fifth', 30, 50, () => 2),
    ];
    const s = computeConcentration(rows);
    const d = s.data as { top1_share_pct: number; top3_share_pct: number; band: string };
    expect(d.top1_share_pct).toBe(70);
    expect(d.band).toBe('high');
    expect(s.summary).toContain('70%');
    expect(s.next_step.length).toBeGreaterThan(10);
  });

  it('thin base carries a warning, not a confident read', () => {
    const s = computeConcentration(adRows('a1', 'only', 5, 20, () => 2));
    expect(s.warnings?.[0]).toContain('Thin base');
  });
});

describe('creative fatigue — the binding rules', () => {
  it('EVERGREEN: old + stable + good is protected, never flagged', () => {
    const s = computeFatigue([...adRows('e1', 'evergreen-hero', 80, 300, () => 2.5), ...adRows('x', 'noise', 30, 100, () => 2)]);
    const ad = (s.data.ads).find((a) => a.ad_name === 'evergreen-hero')!;
    expect(ad.class).toBe('evergreen');
    expect(s.summary).toContain('do not "refresh"');
  });

  it('FATIGUING: a real ROAS decline is flagged with a runway to breakeven', () => {
    // 3.0 falling toward 1.2 across 60 days
    const s = computeFatigue([...adRows('f1', 'decayer', 60, 300, (i) => 3.0 - (1.8 * i) / 59), ...adRows('x', 'noise', 30, 100, () => 2)]);
    const ad = (s.data.ads).find((a) => a.ad_name === 'decayer')!;
    expect(ad.class).toBe('fatiguing');
    expect(ad.days_to_breakeven).not.toBeNull();
    expect(ad.days_to_breakeven!).toBeGreaterThan(0);
    expect(s.next_step).toContain('replacements');
  });

  it('LOW-FREQUENCY GUARD: below breakeven at freq<1.5 warns "likely acquisition", never a kill call', () => {
    const s = computeFatigue([...adRows('p1', 'prospector', 40, 200, () => 0.8, 1.1), ...adRows('x', 'noise', 30, 100, () => 2)]);
    const ad = (s.data.ads).find((a) => a.ad_name === 'prospector')!;
    expect(ad.low_frequency_acquisition_guard).toBe(true);
    expect((s.warnings ?? []).join(' ')).toContain("Don't kill on ROAS alone");
  });

  it('statistical floor: a 5-day blip is not assessed', () => {
    const s = computeFatigue([...adRows('b1', 'blip', 5, 50, () => 0.2), ...adRows('x', 'anchor', 30, 500, () => 2)]);
    expect((s.data.ads).find((a) => a.ad_name === 'blip')).toBeUndefined();
  });
});

describe('creative cohorts', () => {
  it('stacks monthly spend by launch cohort and reads freshness', () => {
    const may = (i: number) => ({ ad_id: 'old', date: `2026-05-${String(i + 1).padStart(2, '0')}`, spend: 100 });
    const june = (i: number) => ({ ad_id: 'old', date: `2026-06-${String(i + 1).padStart(2, '0')}`, spend: 80 });
    const juneNew = (i: number) => ({ ad_id: 'new', date: `2026-06-${String(i + 10).padStart(2, '0')}`, spend: 120 });
    const s = computeCohorts([...Array.from({ length: 20 }, (_, i) => may(i)), ...Array.from({ length: 20 }, (_, i) => june(i)), ...Array.from({ length: 15 }, (_, i) => juneNew(i))]);
    const d = s.data as { fresh_cohort_share_pct: number; series: Array<{ month: string; cohorts: Array<{ cohort: string; share_pct: number }> }> };
    // June spend: old cohort (launched at window start → "or earlier") 1600, new (launched June) 1800.
    const june2 = d.series.find((m) => m.month === '2026-06')!;
    expect(june2.cohorts.length).toBe(2);
    const newShare = june2.cohorts.find((c) => c.cohort === '2026-06')!.share_pct;
    expect(newShare).toBeGreaterThan(50);
    expect(d.fresh_cohort_share_pct).toBeGreaterThan(50);
    expect(june2.cohorts.some((c) => c.cohort.includes('or earlier'))).toBe(true);
  });
});

describe('cost trend', () => {
  const accRow = (i: number, cpm: number, ctr: number): PackAccountRow => ({
    date: day(i), spend: (cpm * 100_000) / 1000, impressions: 100_000,
    link_clicks: Math.round(100_000 * (ctr / 100)), purchases: 10, purchase_value: 500, results: 10,
  });

  it('CPM up + CTR down reads as a creative problem, with the next step saying so', () => {
    const rows = Array.from({ length: 84 }, (_, i) => accRow(i, 8 + (6 * i) / 83, 1.6 - (0.8 * i) / 83));
    const s = computeCostTrend(rows);
    expect(s.summary).toContain('creative');
    expect(s.next_step).toContain('creative problem');
  });

  it('flat CPM = no action, honest', () => {
    const rows = Array.from({ length: 84 }, (_, i) => accRow(i, 9, 1.2));
    const s = computeCostTrend(rows);
    expect(s.summary).toContain('flat');
  });

  it('under 4 weeks is suppressed, not guessed', () => {
    const s = computeCostTrend(Array.from({ length: 10 }, (_, i) => accRow(i, 9, 1.2)));
    expect(s.warnings?.[0]).toContain('suppressed');
  });
});

describe('day of week', () => {
  it('finds the strongest day with an honest daily-granularity label', () => {
    const rows: PackAccountRow[] = Array.from({ length: 91 }, (_, i) => {
      const dow = new Date(day(i) + 'T00:00:00Z').getUTCDay();
      const roas = dow === 0 ? 3.2 : 1.8; // Sundays strong
      return { date: day(i), spend: 100, impressions: 50_000, link_clicks: 600, purchases: 4, purchase_value: 100 * roas, results: 4 };
    });
    const s = computeDayOfWeek(rows);
    const d = s.data as { best_day: string };
    expect(d.best_day).toBe('Sunday');
    expect(s.summary).toContain('day-of-week, not dayparting');
    expect(s.next_step.length).toBeGreaterThan(10);
  });

  it('suppresses on a thin window', () => {
    const s = computeDayOfWeek(Array.from({ length: 20 }, (_, i) => ({ date: day(i), spend: 100, impressions: 1000, link_clicks: 10, purchases: 1, purchase_value: 150, results: 1 })));
    expect(s.warnings?.[0]).toContain('suppressed');
  });
});

describe('scorecard', () => {
  it('cohortPosition places a value in a small cohort', () => {
    const pos = cohortPosition(10, [5, 8, 12, 20, 30]);
    expect(pos.median).toBe(12);
    expect(pos.pctile).toBe(50);
  });

  it('worst-first ordering, strength last, dimension name before the band', () => {
    const entries = buildScorecard({
      hooks: { value: 12, cohortValues: [18, 22, 25, 28, 30, 35], cohortLabel: 'the 6 accounts on our desk (last 7 days)' },
      concentration: { value: 30 },
      freshness: { value: 8 },
    });
    expect(entries[0]!.band).toBe('weak');
    expect(entries[entries.length - 1]!.band).toBe('strong');
    // Francis rule: dimension first in the position string
    expect(entries.find((e) => e.key === 'hooks')!.position.startsWith('Hooks')).toBe(true);
    expect(entries.find((e) => e.key === 'hooks')!.cohort!.label).toContain('accounts on our desk');
  });

  it('an undefended benchmark (cohort < 5) is dropped, not faked', () => {
    const entries = buildScorecard({ hooks: { value: 12, cohortValues: [18, 22], cohortLabel: 'x' } });
    expect(entries.find((e) => e.key === 'hooks')).toBeUndefined();
  });

  it('every entry carries a next step and a section link', () => {
    const entries = buildScorecard({ concentration: { value: 65 }, freshness: { value: 50 }, cpmTrend: { value: 22 } });
    for (const e of entries) {
      expect(e.next_step.length).toBeGreaterThan(5);
      expect(e.section_key.length).toBeGreaterThan(3);
    }
  });
});
