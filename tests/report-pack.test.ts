import { describe, it, expect } from 'vitest';
import {
  computeConcentration, computeFatigue, computeBudgetScatter, computeCohorts, computeCostTrend, computeDayOfWeek, kpiMode,
  computeHookCorrection, mergeAdPreviews,
  type PackAdRow, type PackAccountRow, type PlacementHookRow, type AdPreview, type FatigueAd, type ScatterDot,
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

  it('AD IDENTITY: every top_ads row carries its ad_id (the page links to the real ad)', () => {
    const rows = [
      ...adRows('a1', 'hero', 30, 700, () => 2),
      ...adRows('a2', 'second', 30, 100, () => 2),
    ];
    const s = computeConcentration(rows);
    const d = s.data as { top_ads: Array<{ ad_id: string; ad_name: string }> };
    expect(d.top_ads[0]).toMatchObject({ ad_id: 'a1', ad_name: 'hero' });
    expect(d.top_ads[1]).toMatchObject({ ad_id: 'a2', ad_name: 'second' });
    for (const a of d.top_ads) expect(a.ad_id.length).toBeGreaterThan(0);
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

  it('PRO-TRUST: fatiguing set reports its current daily burn in account currency', () => {
    const s = computeFatigue(
      [...adRows('f1', 'decayer', 60, 300, (i) => 3.0 - (1.8 * i) / 59), ...adRows('x', 'noise', 30, 100, () => 2)],
      1.0,
      'SEK',
    );
    const d = s.data as { fatiguing_daily_burn: number; currency?: string };
    expect(d.fatiguing_daily_burn).toBe(300); // the decayer spends 300/day, incl. its last 14 days
    expect(d.currency).toBe('SEK');
    expect(s.summary).toContain('SEK/day');
    expect(s.derivation).toContain('last 14 active days');
  });

  it('runway of exactly 1 day says "within a day", never "1 days"', () => {
    // steep decline: recent level just above breakeven, falling fast
    const s = computeFatigue([...adRows('f1', 'cliff', 60, 300, (i) => 3.0 - (1.9 * i) / 59), ...adRows('x', 'noise', 30, 100, () => 2)]);
    expect(s.summary).not.toMatch(/\b1 days\b/);
  });

  it('AD IDENTITY: every assessed fatigue row carries its ad_id', () => {
    const s = computeFatigue([
      ...adRows('e1', 'evergreen-hero', 80, 300, () => 2.5),
      ...adRows('f1', 'decayer', 60, 300, (i) => 3.0 - (1.8 * i) / 59),
    ]);
    expect(s.data.ads.length).toBeGreaterThanOrEqual(2);
    for (const ad of s.data.ads) expect(['e1', 'f1']).toContain(ad.ad_id);
    expect(s.data.ads.find((a) => a.ad_name === 'decayer')!.ad_id).toBe('f1');
  });

  it('FLOOR CAP: a very large account still assesses mid-size ads (NP regression)', () => {
    // Whale account: 90d × 50k/day = 4.5M total → uncapped 1% floor (45k)
    // excluded EVERY ad. The capped floor keeps a 6k-spend ad in scope.
    const s = computeFatigue([
      ...adRows('whale', 'whale-hero', 90, 50_000, () => 2),
      ...adRows('mid', 'mid-runner', 30, 200, () => 2),
    ]);
    expect((s.data.ads).find((a) => a.ad_name === 'mid-runner')).toBeDefined();
    expect((s.data.ads).length).toBeGreaterThanOrEqual(2);
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

  it('flat CPM = no action, honest, and NO invented cost figure', () => {
    const rows = Array.from({ length: 84 }, (_, i) => accRow(i, 9, 1.2));
    const s = computeCostTrend(rows, 'EUR');
    expect(s.summary).toContain('flat');
    expect((s.data as { cpm_extra_cost_recent?: number }).cpm_extra_cost_recent).toBeUndefined();
  });

  it('PRO-TRUST: rising CPM quantifies the drift as "same impressions, opening prices"', () => {
    const rows = Array.from({ length: 84 }, (_, i) => accRow(i, 8 + (6 * i) / 83, 1.5));
    const s = computeCostTrend(rows, 'EUR');
    const d = s.data as { cpm_extra_cost_recent?: number };
    expect(d.cpm_extra_cost_recent).toBeGreaterThan(0);
    expect(s.summary).toContain('EUR more than the same impressions');
    expect(s.derivation).toContain('opening prices');
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

  it('PRO-TRUST: every entry carries a derivation ("how we got this")', () => {
    const entries = buildScorecard({
      hooks: { value: 12, cohortValues: [18, 22, 25, 28, 30, 35], cohortLabel: 'the 6 accounts on our desk (last 7 days)' },
      concentration: { value: 65 }, freshness: { value: 8 }, cpmTrend: { value: 22 },
    });
    for (const e of entries) expect((e.derivation ?? '').length).toBeGreaterThan(20);
  });

  it('PRO-TRUST: a weak hook entry quantifies the gap in PEOPLE, never currency', () => {
    const entries = buildScorecard({
      hooks: { value: 12, cohortValues: [18, 22, 25, 28, 30, 35], cohortLabel: 'the 6 accounts on our desk (last 7 days)', impressions30: 1_000_000 },
    });
    const hooks = entries.find((e) => e.key === 'hooks')!;
    // cohort median (small-cohort quantile) 28% − you 12% = 16pp × 1M imps = 160,000 more people past 3s
    expect(hooks.quantified).toContain('160,000');
    expect(hooks.quantified).toContain('people');
    expect(hooks.quantified).not.toMatch(/[€$£]|EUR|SEK|USD/);
  });

  it('PRO-TRUST: a strong hook entry gets no gap line, and tiny gaps stay silent', () => {
    const strong = buildScorecard({
      hooks: { value: 35, cohortValues: [18, 22, 25, 28, 30, 33], cohortLabel: 'x accounts (last 7 days)', impressions30: 1_000_000 },
    });
    expect(strong.find((e) => e.key === 'hooks')!.quantified).toBeUndefined();
    const tiny = buildScorecard({
      hooks: { value: 24.9, cohortValues: [18, 22, 25, 28, 30, 33], cohortLabel: 'x accounts (last 7 days)', impressions30: 2_000 },
    });
    expect(tiny.find((e) => e.key === 'hooks')?.quantified).toBeUndefined();
  });
});

describe('hook-rate correction (rewarded video — binding ruling #5)', () => {
  const row = (platform: string, position: string, imps: number, views: number): PlacementHookRow => ({
    publisher_platform: platform, platform_position: position, impressions: imps, video_views: views,
  });

  it('corrects the hook rate DOWN when rewarded video is material', () => {
    const c = computeHookCorrection([
      row('facebook', 'feed', 80_000, 16_000), // 20% real
      row('audience_network', 'rewarded_video', 20_000, 19_000), // ~95% forced
    ])!;
    expect(c.material).toBe(true);
    expect(c.reported_pct).toBe(35);
    expect(c.corrected_pct).toBe(20);
    expect(c.forced_share_pct).toBe(20);
    expect(c.an_share_pct).toBe(20);
    expect(c.note).toContain('force the view');
  });

  it('immaterial forced share stays honest — no correction claimed', () => {
    const c = computeHookCorrection([
      row('facebook', 'feed', 99_000, 19_800),
      row('audience_network', 'rewarded_video', 1_000, 950),
    ])!;
    expect(c.material).toBe(false);
  });

  it('no forced views → says so; thin data → null', () => {
    const clean = computeHookCorrection([row('facebook', 'feed', 50_000, 10_000)])!;
    expect(clean.material).toBe(false);
    expect(clean.note).toContain('no correction');
    expect(computeHookCorrection([row('facebook', 'feed', 500, 100)])).toBeNull();
  });
});

describe('mergeAdPreviews (ad identity + visual enrichment — pure merge)', () => {
  const previews = new Map<string, AdPreview>([
    ['a1', { preview_link: 'https://fb.me/abc', thumbnail_url: 'https://cdn.fb.com/t1.jpg' }],
    ['a2', { preview_link: 'https://fb.me/def', thumbnail_url: null }],
  ]);

  it('writes preview_link + thumbnail_url onto matched rows; unmatched pass through unchanged', () => {
    const rows = [
      { ad_id: 'a1', ad_name: 'hero', spend: 700 },
      { ad_id: 'a3', ad_name: 'nomatch', spend: 100 },
    ];
    const out = mergeAdPreviews(rows, previews)!;
    expect(out[0]).toMatchObject({ ad_id: 'a1', spend: 700, preview_link: 'https://fb.me/abc', thumbnail_url: 'https://cdn.fb.com/t1.jpg' });
    expect(out[1]).toEqual({ ad_id: 'a3', ad_name: 'nomatch', spend: 100 }); // untouched — no invented fields
  });

  it('never writes null/empty values — a half-fetched preview only adds what it has', () => {
    const out = mergeAdPreviews([{ ad_id: 'a2', ad_name: 'x' }], previews)!;
    expect((out[0] as Record<string, unknown>).preview_link).toBe('https://fb.me/def');
    expect('thumbnail_url' in out[0]!).toBe(false);
  });

  it('does not mutate the input rows (section data stays intact on any failure path)', () => {
    const rows = [{ ad_id: 'a1', ad_name: 'hero' }];
    mergeAdPreviews(rows, previews);
    expect(rows[0]).toEqual({ ad_id: 'a1', ad_name: 'hero' });
  });

  it('tolerates rows without ad_id and undefined row sets', () => {
    const out = mergeAdPreviews([{ ad_name: 'legacy row, no id' } as { ad_id?: string }], previews)!;
    expect(out[0]).toEqual({ ad_name: 'legacy row, no id' });
    expect(mergeAdPreviews(undefined, previews)).toBeUndefined();
  });

  it('empty preview map is a no-op (the fail-soft Graph path)', () => {
    const rows = [{ ad_id: 'a1', ad_name: 'hero' }];
    const out = mergeAdPreviews(rows, new Map())!;
    expect(out).toEqual(rows);
  });
});

describe('creative fatigue — margin re-basing (stated-economics, 2026-07-04)', () => {
  // One decliner: ROAS 4.5 → 2.5 over 60 days. Halves: h1≈4.01, h2≈2.99
  // (trend ≈ −25.4%, genuinely declining); last-14-day level ≈ 2.72.
  const decliner = adRows('r1', 'rebase-me', 60, 300, (i) => 4.5 - (2.0 * i) / 59);

  it('a higher breakeven flags ads the 1.0× default calls stable (nearFloor re-bases)', () => {
    const at1 = computeFatigue(decliner);
    const at45 = computeFatigue(decliner, 2.22, 'GBP', 45);
    const a1 = (at1.data.ads as FatigueAd[]).find((a) => a.ad_id === 'r1')!;
    const a45 = (at45.data.ads as FatigueAd[]).find((a) => a.ad_id === 'r1')!;
    // recent ≈2.72: not near a 1.0× floor (stable), but well inside 1.5× of 2.22× (fatiguing)
    expect(a1.class).toBe('stable');
    expect(a45.class).toBe('fatiguing');
    expect((at45.data as { fatiguing_daily_burn: number }).fatiguing_daily_burn).toBe(300);
    expect((at1.data as { fatiguing_daily_burn: number }).fatiguing_daily_burn).toBe(0);
  });

  it('a higher breakeven shortens the runway — same decline, closer line', () => {
    const a1 = (computeFatigue(decliner).data.ads as FatigueAd[]).find((a) => a.ad_id === 'r1')!;
    const a45 = (computeFatigue(decliner, 2.22, 'GBP', 45).data.ads as FatigueAd[]).find((a) => a.ad_id === 'r1')!;
    expect(a1.days_to_breakeven).toBe(51); // (2.72 − 1.0) ÷ 0.034/day
    expect(a45.days_to_breakeven).toBe(15); // (2.72 − 2.22) ÷ 0.034/day
    expect(a45.days_to_breakeven!).toBeLessThan(a1.days_to_breakeven!);
  });

  it('ATTRIBUTION: with a stated margin the copy names the line AND whose margin it is', () => {
    const s = computeFatigue(decliner, 2.22, 'GBP', 45);
    expect(s.derivation).toContain('2.22× ROAS');
    expect(s.derivation).toContain('45% gross margin you gave us');
    expect(s.summary).toContain('crosses its 2.22× breakeven');
    const d = s.data as { breakeven_roas: number; gross_margin_pct?: number };
    expect(d.breakeven_roas).toBe(2.22);
    expect(d.gross_margin_pct).toBe(45);
  });

  it('ATTRIBUTION: without a margin the 1.0× default keeps its honest caveat', () => {
    const s = computeFatigue(decliner);
    expect(s.derivation).toContain('1.0× ROAS');
    expect(s.derivation).toContain('true breakeven is higher');
    expect(s.derivation).not.toContain('you gave us');
    const d = s.data as { breakeven_roas: number; gross_margin_pct?: number };
    expect(d.breakeven_roas).toBe(1.0);
    expect(d.gross_margin_pct).toBeUndefined();
  });

  it('LOW-FREQUENCY GUARD re-bases too: below the stated-margin line at freq<1.5 still warns, never kills', () => {
    const rows = [...adRows('p1', 'prospector', 40, 200, () => 2.0, 1.1), ...adRows('x', 'noise', 30, 100, () => 3)];
    // 2.0 ROAS is above a 1.0× line (no guard) but below the 2.22× stated line (guard fires)
    const at1 = (computeFatigue(rows).data.ads as FatigueAd[]).find((a) => a.ad_id === 'p1')!;
    expect(at1.low_frequency_acquisition_guard).toBe(false);
    const s45 = computeFatigue(rows, 2.22, 'GBP', 45);
    const a45 = (s45.data.ads as FatigueAd[]).find((a) => a.ad_id === 'p1')!;
    expect(a45.low_frequency_acquisition_guard).toBe(true);
    expect(s45.warnings?.some((w) => w.includes('low frequency'))).toBe(true);
  });

  it('EVERGREEN protection is unchanged by the re-based line: old + holding stays protected', () => {
    const s = computeFatigue(
      [...adRows('e1', 'evergreen-hero', 80, 300, () => 4.0), ...adRows('x', 'noise', 30, 100, () => 3)],
      2.22, 'GBP', 45,
    );
    const e = (s.data.ads as FatigueAd[]).find((a) => a.ad_id === 'e1')!;
    expect(e.class).toBe('evergreen');
  });
});

describe('budget scatter — colour = the fatigue diagnosis (anti-double-count contract)', () => {
  // Four ads over 30 days + one thin ad that must be dropped.
  const rows30: PackAdRow[] = [
    ...adRows('a1', 'evergreen-hero', 30, 700, () => 2.5, 1.3),
    ...adRows('a2', 'mover', 30, 200, () => 0.9, 2.0),
    ...adRows('a3', 'acquisition', 30, 150, () => 0.7, 1.1),
    ...adRows('a4', 'starved-winner', 30, 40, () => 3.0, 1.2),
    ...adRows('a5', 'thin-noise', 30, 5, () => 1.0, 1.5),
  ];
  // The fatigue diagnosis the scatter must MIRROR (never re-derive).
  const fat: Array<Pick<FatigueAd, 'ad_id' | 'class' | 'low_frequency_acquisition_guard'>> = [
    { ad_id: 'a1', class: 'evergreen', low_frequency_acquisition_guard: false },
    { ad_id: 'a2', class: 'fatiguing', low_frequency_acquisition_guard: false }, // unguarded → counted money → red
    { ad_id: 'a3', class: 'fatiguing', low_frequency_acquisition_guard: true }, // guarded → not counted → blue
  ];

  const dotsOf = (s: ReturnType<typeof computeBudgetScatter>) => new Map((s.data.dots as ScatterDot[]).map((d) => [d.ad_id, d]));

  it('red "move" dots are exactly the UNGUARDED fatiguing ads (the hero money, counted once)', () => {
    const s = computeBudgetScatter(rows30, fat);
    const d = dotsOf(s);
    expect(d.get('a2')!.klass).toBe('move');
    expect(s.data.move_count).toBe(1);
    // The guarded fatiguing ad is NEVER red — it is the not-counted acquisition set.
    expect(d.get('a3')!.klass).toBe('acquisition');
    expect(s.data.acquisition_count).toBe(1);
  });

  it('evergreen stays evergreen; ads with no fatigue verdict are neutral', () => {
    const d = dotsOf(computeBudgetScatter(rows30, fat));
    expect(d.get('a1')!.klass).toBe('evergreen');
    expect(d.get('a4')!.klass).toBe('neutral'); // not in the fatigue set
  });

  it('gold-rings a strong ad on a small share of budget, never a strong high-share ad', () => {
    const s = computeBudgetScatter(rows30, fat);
    const d = dotsOf(s);
    expect(d.get('a4')!.starved).toBe(true); // 3.0× on ~4% of spend
    expect(d.get('a1')!.starved).toBe(false); // 2.5× but ~64% of spend — already fed
    expect(s.data.starved_best_ad).toBe('starved-winner');
    expect(String(s.data.contrast)).toMatch(/starved-winner/);
  });

  it('carries spend, ROAS and averaged frequency per dot; drops thin ads below the floor', () => {
    const s = computeBudgetScatter(rows30, fat);
    const d = dotsOf(s);
    expect(d.get('a2')!.spend_30d).toBe(6000);
    expect(d.get('a2')!.roas_30d).toBeCloseTo(0.9, 5);
    expect(d.get('a2')!.avg_frequency).toBeCloseTo(2.0, 5);
    expect(d.has('a5')).toBe(false); // below the spend floor
    expect(s.data.ads_dropped_thin).toBe(1);
    expect(s.data.kpi_mode).toBe('roas');
  });

  it('re-based breakeven (stated margin) shifts what counts as "starved" strong', () => {
    // At a 2.22× line, the 2.5× evergreen is only ~1.13× the line — no longer
    // "well above" (needs 2×line = 4.44×), so nothing is starved-flagged as a
    // clear winner; the honest-default 1.0× line would flag more.
    const s = computeBudgetScatter(rows30, fat, 2.22, 'GBP', 45);
    const d = dotsOf(s);
    expect(d.get('a4')!.starved).toBe(false); // 3.0× < 2×2.22
    expect(String(s.derivation)).toMatch(/45% gross margin/);
  });

  it('cost-per-result mode emits cpr, no ROAS, and never invents a starved winner', () => {
    const cprRows: PackAdRow[] = [
      ...adRows('c1', 'lead-ad', 30, 300, () => 0, 1.4).map((r) => ({ ...r, purchase_value: 0, results: 10 })),
      ...adRows('c2', 'lead-ad-2', 30, 100, () => 0, 1.2).map((r) => ({ ...r, purchase_value: 0, results: 2 })),
    ];
    const s = computeBudgetScatter(cprRows, []);
    expect(s.data.kpi_mode).toBe('cpr');
    const d = (s.data.dots as ScatterDot[]).find((x) => x.ad_id === 'c1')!;
    expect(d.roas_30d).toBeNull();
    expect(d.cpr_30d).toBeCloseTo(30, 5); // 300/day ÷ 10 results
    expect(s.data.starved_best_ad).toBeUndefined();
  });
})
