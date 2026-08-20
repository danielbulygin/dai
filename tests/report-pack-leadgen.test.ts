import { describe, it, expect } from 'vitest';
import {
  computeFatigue, computeBudgetScatter, computeDayOfWeek, resultOf,
  type PackAdRow, type PackAccountRow, type FatigueAd, type ScatterDot,
} from '../src/audit/report-pack.js';

/**
 * The lead-gen fixtures. The anchor case is a life-insurance account: 482 leads,
 * 18.59 cost per lead, ZERO purchases, and `results` left at 0 by the bridged
 * pull. Before the resultOf fallback these three sections read that account as
 * "every ad flat at 0.00" (fatigue), "every dot at 0" (scatter) and "cost per
 * result 2,605" (weekday, which was really that weekday's raw spend).
 */

const day = (i: number): string => new Date(Date.UTC(2026, 3, 1 + i)).toISOString().slice(0, 10);

/** One lead-gen ad-day: no purchases, no purchase value, results unmapped. */
function leadRows(
  adId: string,
  name: string,
  days: number,
  spendPerDay: number,
  leadsByDay: (i: number) => number,
  freq = 1.8,
): PackAdRow[] {
  return Array.from({ length: days }, (_, i) => ({
    ad_id: adId, ad_name: name, date: day(i), spend: spendPerDay,
    impressions: 8_000, purchases: 0, purchase_value: 0, results: 0,
    frequency: freq, hook_rate: null, hold_rate: null, leads: leadsByDay(i),
  }));
}

describe('resultOf — the ONE fallback', () => {
  it('prefers a mapped result, then purchases, then lead actions', () => {
    expect(resultOf({ results: 7, purchases: 3, leads: 2 })).toBe(7);
    expect(resultOf({ results: 0, purchases: 3, leads: 2 })).toBe(3);
    expect(resultOf({ results: 0, purchases: 0, leads: 12 })).toBe(12);
    expect(resultOf({ results: 0, purchases: 0, leads: 0 })).toBe(0);
    expect(resultOf({ results: null, purchases: null, leads: null })).toBe(0);
    expect(resultOf({})).toBe(0);
  });
});

describe('fatigue on a lead-gen account', () => {
  // Leads per spend halves across the run: 0.06 → 0.03 per unit of spend.
  const decliner = leadRows('f1', 'lead-decayer', 60, 200, (i) => (i < 30 ? 12 : 6));

  it('reads the trend from leads per spend, not from an unmapped results column', () => {
    const s = computeFatigue(decliner);
    const ad = (s.data.ads as FatigueAd[]).find((a) => a.ad_id === 'f1')!;
    expect(s.data.kpi_mode).toBe('cpr');
    // 12 leads on 200 spend = 0.06/unit; 6 leads on 200 = 0.03/unit.
    expect(ad.kpi_first_half).toBeCloseTo(0.06, 4);
    expect(ad.kpi_second_half).toBeCloseTo(0.03, 4);
    expect(ad.trend_pct).toBeCloseTo(-50, 1);
    expect(ad.class).toBe('fatiguing');
  });

  it('a 60-day ad whose leads hold is evergreen, and never 0.00-flat', () => {
    const s = computeFatigue(leadRows('e1', 'lead-evergreen', 70, 200, () => 10));
    const ad = (s.data.ads as FatigueAd[]).find((a) => a.ad_id === 'e1')!;
    expect(ad.kpi_recent).toBeCloseTo(0.05, 4);
    expect(ad.trend_pct).toBe(0);
    expect(ad.class).toBe('evergreen');
  });

  it('an ad with no purchases AND no leads is suppressed, never plotted as a 0.00 trend', () => {
    const s = computeFatigue([
      ...decliner,
      ...leadRows('n1', 'no-result-spender', 40, 200, () => 0),
    ]);
    expect((s.data.ads as FatigueAd[]).find((a) => a.ad_id === 'n1')).toBeUndefined();
    expect(s.data.ads_suppressed_no_results).toBe(1);
    expect(s.warnings?.join(' ')).toContain('no mapped result');
  });
});

describe('budget scatter on a lead-gen account', () => {
  // 185.9/day over 30 days = 5,577 spend; 10 leads/day = 300 leads → CPL 18.59.
  const rows30: PackAdRow[] = [
    ...leadRows('a1', 'anchor-lead-ad', 30, 185.9, () => 10),
    ...leadRows('a2', 'pricier-lead-ad', 30, 200, () => 4),
    ...leadRows('a3', 'no-result-spender', 30, 300, () => 0),
  ];

  it('every dot carries the account\'s real cost per lead', () => {
    const s = computeBudgetScatter(rows30, []);
    const dots = new Map((s.data.dots as ScatterDot[]).map((d) => [d.ad_id, d]));
    expect(s.data.kpi_mode).toBe('cpr');
    expect(dots.get('a1')!.cpr_30d).toBeCloseTo(18.59, 2);
    expect(dots.get('a1')!.roas_30d).toBeNull();
    expect(dots.get('a2')!.cpr_30d).toBeCloseTo(50, 2);
  });

  it('an ad with no mapped result gets NO dot, and the count says so', () => {
    const s = computeBudgetScatter(rows30, []);
    const dots = s.data.dots as ScatterDot[];
    expect(dots.find((d) => d.ad_id === 'a3')).toBeUndefined();
    expect(s.data.dots_suppressed_no_results).toBe(1);
    expect(s.warnings?.join(' ')).toContain('no mapped result');
  });

  it('states the cost-per-result spread and a next step that moves money', () => {
    const s = computeBudgetScatter(rows30, [], 1.0, 'USD');
    expect(s.summary).toContain('cost per result');
    expect(s.summary).toMatch(/19 USD/); // rounded low end of the spread
    expect(s.next_step).toMatch(/per result/);
    expect(s.next_step).not.toContain('broadly tracking return');
  });
});

describe('day of week on a lead-gen account', () => {
  const accRows = (leadsFor: (dow: number) => number): PackAccountRow[] =>
    Array.from({ length: 91 }, (_, i) => {
      const dow = new Date(day(i) + 'T00:00:00Z').getUTCDay();
      return {
        date: day(i), spend: 100, impressions: 40_000, link_clicks: 400,
        purchases: 0, purchase_value: 0, results: 0, leads: leadsFor(dow),
      };
    });

  it('cost per result is spend over leads, never the weekday spend itself', () => {
    // Tuesdays book 2 leads on the same 100 spend (50.00), every other day 5 (20.00).
    const s = computeDayOfWeek(accRows((dow) => (dow === 2 ? 2 : 5)));
    const d = s.data as { kpi_mode: string; rows: Array<{ day: string; kpi: number | null }>; best_day: string; worst_day: string; gap_pct: number };
    expect(d.kpi_mode).toBe('cpr');
    const tue = d.rows.find((r) => r.day === 'Tuesday')!;
    const mon = d.rows.find((r) => r.day === 'Monday')!;
    expect(mon.kpi).toBeCloseTo(20, 5); // 13 days × 100 spend ÷ 65 leads
    expect(tue.kpi).toBeCloseTo(50, 5);
    // The old `results || 1` divisor returned the weekday's summed spend (1300).
    expect(mon.kpi).not.toBe(1300);
    expect(d.worst_day).toBe('Tuesday');
    expect(d.best_day).not.toBe('Tuesday');
    expect(d.gap_pct).toBeCloseTo(150, 0);
  });

  it('a weekday with no mapped result is left out of the comparison, not scored', () => {
    const s = computeDayOfWeek(accRows((dow) => (dow === 0 ? 0 : 5)));
    const d = s.data as { rows: Array<{ day: string; kpi: number | null }>; days_suppressed_no_results?: number; best_day: string };
    expect(d.rows.find((r) => r.day === 'Sunday')!.kpi).toBeNull();
    expect(d.days_suppressed_no_results).toBe(1);
    expect(d.best_day).not.toBe('Sunday');
    expect(s.warnings?.join(' ')).toContain('no mapped result');
  });

  it('an account with no mapped result at all gets the honest suppression, not raw spend', () => {
    const s = computeDayOfWeek(accRows(() => 0));
    const d = s.data as { days_suppressed_no_results?: number; signal: boolean };
    expect(d.days_suppressed_no_results).toBe(7);
    expect(d.signal).toBe(false);
    expect(s.summary).toContain('no honest weekday');
    expect(s.next_step).toContain('result mapping');
  });
});
