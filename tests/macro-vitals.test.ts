/**
 * Macro-creep vitals — the cases that protect the frog-boil detector.
 *
 * What these exist to defend:
 *   1. NULL is absence. A day the warehouse could not read reach must never be
 *      averaged in as a zero — that manufactures a collapse that never happened.
 *   2. The baseline is PINNED. A rolling reference creeps with the metric and
 *      the whole module becomes a very expensive way to always say "steady".
 *   3. Duration is the signal. A 2%/week creep must recover as ~2%/week, and
 *      "for 9 weeks" must be counted, not estimated.
 *   4. One diagnosis, not four alerts. A chord owns its member vitals' lines.
 *   5. Silence is a feature: a steady account gets ONE line, and an account
 *      under the sample floor gets none at all.
 *   6. Voice: currency amounts lead, a percentage never travels alone, periods
 *      are named, and no line says "yesterday" or "today".
 *   7. Memory: a creep is flagged once and reported as a trajectory after that;
 *      a ledger outage costs the reader nothing.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// A fake PostgREST that both the warehouse and the ledger client speak
// ---------------------------------------------------------------------------

const { db, fakeFrom } = vi.hoisted(() => {
  const db = {
    accountDaily: [] as Array<Record<string, unknown>>,
    insights: [] as Array<Record<string, unknown>>,
    inserted: [] as Array<Record<string, unknown>>,
    updates: [] as Array<{ id: string; patch: Record<string, unknown> }>,
    failReads: false,
    failWrites: false,
    reset() {
      db.accountDaily = [];
      db.insights = [];
      db.inserted = [];
      db.updates = [];
      db.failReads = false;
      db.failWrites = false;
    },
  };

  const fakeFrom = (table: string) => {
    const filters: Array<{ op: string; col: string; val: unknown }> = [];
    let mode: 'select' | 'insert' | 'update' = 'select';
    let payload: Record<string, unknown> | Array<Record<string, unknown>> | null = null;
    let range: [number, number] | null = null;

    const store = () => (table === 'account_daily' ? db.accountDaily : db.insights);
    const matches = (r: Record<string, unknown>): boolean =>
      filters.every(({ op, col, val }) => {
        const v = r[col];
        if (op === 'eq') return v === val;
        if (op === 'gte') return String(v) >= String(val);
        if (op === 'lte') return String(v) <= String(val);
        return true;
      });

    const exec = async (): Promise<{ data: unknown; error: { message: string } | null }> => {
      if (mode === 'insert') {
        if (db.failWrites) return { data: null, error: { message: 'insert blew up' } };
        const rows = Array.isArray(payload) ? payload : [payload!];
        for (const r of rows) {
          db.inserted.push(r);
          db.insights.push({
            id: `ins-${db.insights.length + 1}`,
            status: 'active',
            trajectory: [],
            derived_at: '2026-08-09T06:00:00.000Z',
            ...r,
          });
        }
        return { data: null, error: null };
      }
      if (mode === 'update') {
        if (db.failWrites) return { data: null, error: { message: 'update blew up' } };
        for (const r of store().filter(matches)) {
          db.updates.push({ id: String(r.id), patch: payload as Record<string, unknown> });
          Object.assign(r, payload);
        }
        return { data: null, error: null };
      }
      if (db.failReads) return { data: null, error: { message: 'read blew up' } };
      let out = store().filter(matches);
      if (table === 'account_daily') {
        out = [...out].sort((a, b) => String(a.date).localeCompare(String(b.date)));
      }
      if (range) out = out.slice(range[0], range[1] + 1);
      return { data: out, error: null };
    };

    const q = {
      select: () => q,
      insert: (p: Array<Record<string, unknown>>) => {
        mode = 'insert';
        payload = p;
        return q;
      },
      update: (p: Record<string, unknown>) => {
        mode = 'update';
        payload = p;
        return q;
      },
      eq: (col: string, val: unknown) => {
        filters.push({ op: 'eq', col, val });
        return q;
      },
      gte: (col: string, val: unknown) => {
        filters.push({ op: 'gte', col, val });
        return q;
      },
      lte: (col: string, val: unknown) => {
        filters.push({ op: 'lte', col, val });
        return q;
      },
      order: () => q,
      limit: () => q,
      range: (a: number, b: number) => {
        range = [a, b];
        return q;
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => exec().then(res, rej),
    };
    return q;
  };

  return { db, fakeFrom };
});

vi.mock('../src/integrations/supabase.js', () => ({ getSupabase: () => ({ from: fakeFrom }) }));
vi.mock('../src/integrations/dai-supabase.js', () => ({ getDaiSupabase: () => ({ from: fakeFrom }) }));

import {
  aggregate,
  buildMacroPulse,
  consecutiveRun,
  detectChords,
  fetchVitalsHistory,
  isoWeekOf,
  renderMacroPulse,
  slopePctPerWeek,
  syncDriftInsights,
  vitalReads,
  weeklyAverages,
  type VitalName,
  type VitalsDay,
} from '../src/monitoring/macro-vitals.js';

// ---------------------------------------------------------------------------
// Synthetic accounts
// ---------------------------------------------------------------------------

/** A Sunday: the last complete day of a Monday-morning read. */
const ASOF = '2026-08-09';

function addDays(dateStr: string, delta: number): string {
  return new Date(Date.parse(`${dateStr}T12:00:00Z`) + delta * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function day(date: string, o: Partial<VitalsDay> = {}): VitalsDay {
  return {
    date,
    spend: 1000,
    impressions: 100_000,
    reach: 50_000,
    frequency: null,
    clicks: 1000,
    ctr: null,
    cpm: null,
    fetched_at: null,
    ...o,
  };
}

/** Levels in, one day's raw counts out (reach × freq = impressions). */
function vd(reach: number, freq: number, cpm: number, ctr: number): Partial<VitalsDay> {
  const impressions = Math.round(reach * freq);
  return {
    impressions,
    reach,
    spend: (cpm * impressions) / 1000,
    clicks: Math.round(ctr * impressions),
  };
}

/** `daysAgo` 0 = ASOF. Oldest row first, like the warehouse returns them. */
function rowsFor(
  days: number,
  f: (daysAgo: number) => Partial<VitalsDay>,
  asOf = ASOF,
): VitalsDay[] {
  const out: VitalsDay[] = [];
  for (let d = days - 1; d >= 0; d -= 1) out.push(day(addDays(asOf, -d), f(d)));
  return out;
}

interface Levels {
  reach: number;
  freq: number;
  cpm: number;
  ctr: number;
}

/**
 * A 16-week account that slides linearly from `base` (a quarter ago) to `now`
 * (today), which is what a real creep looks like — no step changes.
 */
function drifting(base: Levels, now: Levels, days = 112): VitalsDay[] {
  const at = (d: number): Partial<VitalsDay> => {
    const t = Math.min(1, Math.max(0, (90 - d) / 90));
    const mix = (a: number, b: number): number => a + (b - a) * t;
    return vd(mix(base.reach, now.reach), mix(base.freq, now.freq), mix(base.cpm, now.cpm), mix(base.ctr, now.ctr));
  };
  return rowsFor(days, at);
}

const HEALTHY: Levels = { reach: 84_000, freq: 1.8, cpm: 9.0, ctr: 0.012 };

function readsFor(rows: VitalsDay[]) {
  return vitalReads(rows, weeklyAverages(rows), { asOf: ASOF });
}

function pulseFor(rows: VitalsDay[], currency = 'USD') {
  const reads = readsFor(rows);
  const chords = detectChords(reads, currency);
  const rendered = renderMacroPulse(reads, chords, currency, reads.baselineLabel);
  return { reads, chords, rendered };
}

function vitalOf(reads: ReturnType<typeof readsFor>, name: VitalName) {
  return reads.vitals.find((v) => v.vital === name)!;
}

beforeEach(() => db.reset());

// ---------------------------------------------------------------------------
// 1. Weekly buckets
// ---------------------------------------------------------------------------

describe('weeklyAverages', () => {
  it('buckets by ISO week, flags short weeks partial, and never reads NULL as zero', () => {
    // Two complete weeks plus a 2-day stub. Inside week 1, two days report
    // spend but no impressions and no reach — absence, not zeros.
    const week1 = [
      ...['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24'].map((d) =>
        day(d, { spend: 1000, impressions: 100_000, reach: 50_000 }),
      ),
      ...['2026-07-25', '2026-07-26'].map((d) =>
        day(d, { spend: 5000, impressions: null, reach: null }),
      ),
    ];
    const week2 = ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02'].map(
      (d) => day(d, { spend: 1200, impressions: 100_000, reach: 40_000 }),
    );
    const stub = ['2026-08-03', '2026-08-04'].map((d) => day(d, { spend: 900, impressions: 90_000 }));

    const weeks = weeklyAverages([...week1, ...week2, ...stub]);

    expect(weeks.map((w) => w.isoWeek)).toEqual(['2026-W30', '2026-W31', '2026-W32']);
    expect(weeks.map((w) => w.weekStart)).toEqual(['2026-07-20', '2026-07-27', '2026-08-03']);
    expect(weeks.map((w) => w.partial)).toEqual([false, false, true]);

    // Pooled CPM ignores the two impression-less days entirely: 5×€1000 over
    // 5×100k impressions = €10. Counting their €5000 would have said €20.
    expect(weeks[0]!.cpm).toBeCloseTo(10, 6);
    // Reach is the mean of the days that HAVE reach, not of all seven.
    expect(weeks[0]!.reachPerDay).toBeCloseTo(50_000, 6);
    expect(weeks[0]!.days).toBe(7);
    // Spend/day still counts every day that reported spend.
    expect(weeks[0]!.spendPerDay).toBeCloseTo((5 * 1000 + 2 * 5000) / 7, 6);
  });

  it('pools frequency and CTR over the days that have both inputs, with a stored-column fallback', () => {
    const rows = [
      ...['2026-07-20', '2026-07-21', '2026-07-22'].map((d) =>
        day(d, { impressions: 100_000, reach: 50_000, clicks: 1200 }),
      ),
      // Reach missing: contributes to CTR, not to frequency.
      ...['2026-07-23', '2026-07-24'].map((d) =>
        day(d, { impressions: 100_000, reach: null, clicks: 800 }),
      ),
    ];
    const [week] = weeklyAverages(rows);
    expect(week!.frequency).toBeCloseTo(300_000 / 150_000, 6); // 2.0, not 500k/150k
    expect(week!.ctr).toBeCloseTo((3 * 1200 + 2 * 800) / 500_000, 9);

    // Fallback: no raw counts anywhere, but the warehouse stored the rates.
    const stored = aggregate([
      day('2026-07-20', { impressions: null, reach: null, clicks: null, cpm: 11, ctr: 0.02, frequency: 1.5 }),
      day('2026-07-21', { impressions: null, reach: null, clicks: null, cpm: 13, ctr: 0.03, frequency: 2.5 }),
    ]);
    expect(stored.cpm).toBeCloseTo(12, 6);
    expect(stored.ctr).toBeCloseTo(0.025, 9);
    expect(stored.frequency).toBeCloseTo(2, 6);
    expect(stored.impressionsPerDay).toBeNull();
  });

  it('numbers ISO weeks the way the calendar does', () => {
    expect(isoWeekOf('2026-01-01')).toEqual({ key: '2026-W01', monday: '2025-12-29' });
    expect(isoWeekOf('2026-08-09')).toEqual({ key: '2026-W32', monday: '2026-08-03' });
  });
});

// ---------------------------------------------------------------------------
// 2. The pinned baseline
// ---------------------------------------------------------------------------

describe('vitalReads — the pinned baseline', () => {
  it('compares against the named window 90 days back, and does not let it roll', () => {
    // €9.00 CPM all quarter, then 30 days at €12.42. A ROLLING baseline would
    // have crept up with it and reported "steady" — the frog-boil.
    const rows = rowsFor(112, (d) => (d <= 29 ? vd(84_000, 1.8, 12.42, 0.012) : vd(84_000, 1.8, 9.0, 0.012)));
    const reads = readsFor(rows);

    expect(reads.baselineWindow).toMatchObject({ start: '2026-04-28', end: '2026-05-11', fallback: false });
    expect(reads.baselineLabel).toBe('early May');
    const cpm = vitalOf(reads, 'cpm');
    expect(cpm.level).toBeCloseTo(12.42, 6);
    expect(cpm.baseline).toBeCloseTo(9.0, 6);
    expect(cpm.pctVsBaseline).toBeCloseTo(0.38, 4);
    expect(cpm.voiced).toBe(true);
    expect(cpm.reason).toBe('level');
  });

  it('falls back to the oldest same-length window when history is short, and says so', () => {
    const rows = rowsFor(40, (d) => (d <= 13 ? vd(84_000, 1.8, 12.0, 0.012) : vd(84_000, 1.8, 10.0, 0.012)));
    const reads = readsFor(rows);
    expect(reads.baselineWindow).toMatchObject({ start: '2026-07-01', end: '2026-07-14', fallback: true });
    expect(reads.baselineLabel).toBe('early July (the oldest 14 days on file)');
    expect(vitalOf(reads, 'cpm').baseline).toBeCloseTo(10, 6);
  });
});

// ---------------------------------------------------------------------------
// 3. Slope + duration
// ---------------------------------------------------------------------------

describe('the slope', () => {
  it('recovers a 2%/week creep over 10 weeks as ~2%/week', () => {
    const weekly = Array.from({ length: 10 }, (_, i) => 10 * 1.02 ** i);
    expect(slopePctPerWeek(weekly)!).toBeCloseTo(0.02, 6);

    // …and end to end, from daily rows: week k back from ASOF, oldest first.
    const rows = rowsFor(70, (d) => {
      const weeksBack = Math.floor(d / 7);
      const cpm = 10 * 1.02 ** (9 - weeksBack);
      return vd(84_000, 1.8, cpm, 0.012);
    });
    const cpm = vitalOf(readsFor(rows), 'cpm');
    expect(cpm.slopePctPerWeek!).toBeCloseTo(0.02, 3);
    expect(cpm.weeksInSlope).toBe(10);
    expect(cpm.consecutiveWeeks).toBe(9);
  });

  it('counts the current run of week-over-week moves, and stops at the turn', () => {
    expect(consecutiveRun([10, 10.5, 11, 11.5, 12])).toMatchObject({ steps: 4, direction: 'up' });
    expect(consecutiveRun([10, 10.5, 11, 11.5, 12]).cumulativePct).toBeCloseTo(0.2, 9);
    // A single down step ends an otherwise long climb.
    expect(consecutiveRun([10, 11, 12, 13, 12.9])).toMatchObject({ steps: 1, direction: 'down' });
    // Nulls are absences, not turning points.
    expect(consecutiveRun([10, null, 11, 12])).toMatchObject({ steps: 2, direction: 'up' });
    expect(consecutiveRun([10])).toMatchObject({ steps: 0, direction: 'flat', cumulativePct: null });
    expect(slopePctPerWeek([10, 11, 12])).toBeNull(); // three points is not a trend
  });
});

// ---------------------------------------------------------------------------
// 4. The chords
// ---------------------------------------------------------------------------

describe('the chords', () => {
  it('names top-of-funnel narrowing and takes over its members` lines', () => {
    // The Press signature: fewer people, seen more often, at a higher price,
    // with the budget still rising.
    const rows = drifting(HEALTHY, { reach: 61_000, freq: 2.4, cpm: 12.4, ctr: 0.012 });
    const { chords, rendered, reads } = pulseFor(rows);

    expect(chords.map((c) => c.id)).toEqual(['top-of-funnel-narrowing']);
    expect(chords[0]!.line).toBe(
      'Top of funnel narrowing — re-buying the same people at rising cost: ' +
        'reach 63k/day (-25% vs early May) while freq 2.36 (+31%) and CPM $12.15 (+35%) climb, ' +
        'on $1.8k/day spend vs $1.4k (up).',
    );

    // Three alerts collapsed into one diagnosis: no reach/freq/CPM bullet.
    const vitalItems = rendered.items.filter((i) => i.kind === 'vital').map((i) => i.vital);
    expect(vitalItems).not.toContain('reach');
    expect(vitalItems).not.toContain('frequency');
    expect(vitalItems).not.toContain('cpm');
    expect(rendered.lines[1]).toMatch(/^• Top of funnel narrowing/);
    // CTR held, so it lands in the steady line rather than vanishing.
    expect(rendered.steady!.line).toMatch(/CTR 1\.20%/);
    expect(vitalOf(reads, 'reach').voiced).toBe(true);
  });

  it('names auction inflation when only the price moved', () => {
    const rows = drifting(HEALTHY, { reach: 84_000, freq: 1.8, cpm: 12.4, ctr: 0.0118 });
    const { chords, rendered } = pulseFor(rows);
    expect(chords.map((c) => c.id)).toEqual(['auction-inflation']);
    expect(chords[0]!.line).toMatch(/the market got dearer, not the account/);
    expect(chords[0]!.line).toMatch(/CPM \$12\.15 \(\+35% vs early May\)/);
    expect(chords[0]!.line).toMatch(/CTR 1\.18% \(-1\.5%\) and reach 84k\/day \(0%\) held/);
    expect(rendered.items.filter((i) => i.vital === 'cpm')).toHaveLength(0);
    // The chord already put numbers on CTR and reach — the steady line must
    // not say them a second time.
    expect(rendered.steady!.line).toBe('Everything else steady: freq 1.80, at $1.8k/day spend.');
  });

  it('names healthy expansion — wins get said out loud', () => {
    const rows = drifting(HEALTHY, { reach: 110_000, freq: 1.5, cpm: 7.2, ctr: 0.012 });
    const { chords, rendered } = pulseFor(rows);
    expect(chords.map((c) => c.id)).toEqual(['healthy-expansion']);
    expect(chords[0]!.line).toMatch(/a wider, cheaper audience/);
    expect(chords[0]!.line).toMatch(/reach 108k\/day \(\+29% vs early May\)/);
    expect(chords[0]!.line).toMatch(/CPM \$7\.33 \(-19%\) and freq 1\.52 \(-15%\) falling/);
    expect(rendered.items.filter((i) => i.kind === 'vital')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Silence
// ---------------------------------------------------------------------------

describe('when there is nothing to say', () => {
  it('collapses a steady account into exactly one line', () => {
    // ±1% week-alternating noise: nothing gated, no run longer than a week.
    const rows = rowsFor(112, (d) => {
      const wobble = Math.floor(d / 7) % 2 === 0 ? 1.01 : 0.99;
      return vd(84_000 * wobble, 1.8, 9.0 * wobble, 0.012);
    });
    const { rendered, chords } = pulseFor(rows);

    expect(chords).toHaveLength(0);
    expect(rendered.items).toHaveLength(0);
    expect(rendered.lines).toHaveLength(1);
    expect(rendered.lines[0]).toMatch(/^Macro pulse \(14d vs early May\): vitals steady — /);
    expect(rendered.lines[0]).toMatch(/CPM \$/);
    expect(rendered.lines[0]).toMatch(/reach /);
    expect(rendered.lines[0]).toMatch(/freq /);
    expect(rendered.lines[0]).toMatch(/CTR /);
    expect(rendered.lines[0]).toMatch(/\/day spend\.$/);
  });

  it('voices nothing at all under 1000 impressions/day', () => {
    // A real 40% CPM climb — but on 500 impressions a day it is arithmetic
    // noise, and a confident line about it would be a lie with a number in it.
    const rows = rowsFor(112, (d) => (d <= 13 ? vd(400, 1.25, 14.0, 0.012) : vd(400, 1.25, 10.0, 0.012)));
    const { reads, chords, rendered } = pulseFor(rows);
    expect(reads.impressionsPerDay).toBeLessThan(1000);
    expect(reads.thin).toBe(true);
    expect(reads.vitals.every((v) => !v.voiced)).toBe(true);
    expect(chords).toHaveLength(0);
    expect(rendered.lines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. The materiality gate, at its edges
// ---------------------------------------------------------------------------

describe('the materiality gate', () => {
  const stepped = (currentCpm: number): VitalsDay[] =>
    rowsFor(112, (d) => (d <= 13 ? vd(84_000, 1.8, currentCpm, 0.012) : vd(84_000, 1.8, 10.0, 0.012)));

  it('needs MORE than 15% off the baseline, not exactly 15%', () => {
    expect(vitalOf(readsFor(stepped(11.5)), 'cpm').pctVsBaseline).toBeCloseTo(0.15, 6);
    expect(vitalOf(readsFor(stepped(11.5)), 'cpm').voiced).toBe(false);
    const over = vitalOf(readsFor(stepped(11.6)), 'cpm');
    expect(over.voiced).toBe(true);
    expect(over.reason).toBe('level');
  });

  it('voices a 4-week run only once it has moved more than 10% cumulatively', () => {
    // A dip, then a steady climb back: the level gate stays quiet (the current
    // window is BELOW the baseline), so only the run arm can fire.
    const run = (total: number): VitalsDay[] =>
      rowsFor(112, (d) => {
        const k = Math.floor(d / 7); // weeks back; 0 = the most recent week
        const cpm = k >= 5 ? 10.0 : 8.9 * (1 + total) ** ((4 - k) / 4);
        return vd(84_000, 1.8, cpm, 0.012);
      });

    const weak = vitalOf(readsFor(run(0.095)), 'cpm');
    expect(weak.consecutiveWeeks).toBe(4);
    expect(weak.cumulativePct!).toBeCloseTo(0.095, 6);
    expect(Math.abs(weak.pctVsBaseline!)).toBeLessThan(0.15);
    expect(weak.voiced).toBe(false);

    const strong = vitalOf(readsFor(run(0.12)), 'cpm');
    expect(strong.consecutiveWeeks).toBe(4);
    expect(strong.cumulativePct!).toBeCloseTo(0.12, 6);
    expect(strong.voiced).toBe(true);
    expect(strong.reason).toBe('run');

    // Three weeks is not a run, however far it moved.
    const short = vitalOf(
      readsFor(
        rowsFor(112, (d) => {
          const k = Math.floor(d / 7);
          const cpm = k >= 4 ? 10.0 : 8.6 * 1.2 ** ((3 - k) / 3);
          return vd(84_000, 1.8, cpm, 0.012);
        }),
      ),
      'cpm',
    );
    expect(short.consecutiveWeeks).toBe(3);
    expect(short.voiced).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Voice
// ---------------------------------------------------------------------------

describe('the rendered block', () => {
  const rows = drifting(HEALTHY, { reach: 88_000, freq: 1.85, cpm: 12.4, ctr: 0.0075 });

  it('leads with the currency amount, never lets a percentage travel alone, and names the period', () => {
    const { rendered } = pulseFor(rows, 'USD');
    expect(rendered.lines[0]).toBe('Macro pulse (14d vs early May, spend-context attached):');

    const cpmLine = rendered.items.find((i) => i.vital === 'cpm')!.line;
    expect(cpmLine).toBe(
      'CPM $12.15 — +35% vs early May ($9.00), climbing ~2.5%/week for 11 weeks · spend context: $2.0k/day vs $1.4k',
    );

    for (const line of rendered.lines.slice(1)) {
      // Every percentage sits next to an absolute value, and the money leads.
      if (line.includes('%')) expect(line).toMatch(/[$][\d.,]+|[\d.,]+k\/day|\d+\.\d{2}/);
      expect(line).not.toMatch(/\byesterday\b|\btoday\b/i);
    }
    // The CTR slide earns its own line; nothing relative, nothing bare.
    const ctrLine = rendered.items.find((i) => i.vital === 'ctr')!.line;
    expect(ctrLine).toMatch(/^CTR 0\.78% — -35% vs early May \(1\.20%\), falling ~[0-9.]+%\/week for \d+ weeks/);
    expect(ctrLine).toContain('spend context:');
  });

  it('respects the account currency', () => {
    const { rendered } = pulseFor(rows, 'EUR');
    expect(rendered.items.find((i) => i.vital === 'cpm')!.line).toContain('€12.15');
  });
});

// ---------------------------------------------------------------------------
// 8. Data access
// ---------------------------------------------------------------------------

describe('fetchVitalsHistory', () => {
  it('pages past the silent 1000-row PostgREST cap and keeps NULLs null', () => {
    db.accountDaily = Array.from({ length: 1500 }, (_, i) => ({
      client_id: 'c1',
      date: addDays('2022-01-01', i),
      spend: 100,
      impressions: 10_000,
      reach: i % 2 === 0 ? null : 5000,
      frequency: null,
      clicks: 120,
      ctr: null,
      cpm: null,
      fetched_at: null,
    }));
    db.accountDaily.push({ client_id: 'other', date: '2022-01-01', spend: 999, impressions: 1 });

    return fetchVitalsHistory('c1', '2022-01-01').then((rows) => {
      expect(rows).toHaveLength(1500);
      expect(rows[0]!.date).toBe('2022-01-01');
      expect(rows[0]!.reach).toBeNull();
      expect(rows[1]!.reach).toBe(5000);
      expect(rows.every((r) => r.spend === 100)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 9. Ledger memory
// ---------------------------------------------------------------------------

describe('syncDriftInsights', () => {
  // CPM up hard, CTR down hard, reach up a little: no chord fits, so both
  // vitals get their own line — and their own ledger row.
  const rows = drifting(HEALTHY, { reach: 88_000, freq: 1.85, cpm: 12.4, ctr: 0.0075 });

  it('opens one drift insight per voiced vital the first time, leaving the lines alone', async () => {
    const { reads, chords, rendered } = pulseFor(rows);
    const before = [...rendered.lines];
    const lines = await syncDriftInsights('BFM', 'act_1', reads, chords, rendered);

    expect(lines).toEqual(before);
    expect(db.inserted).toHaveLength(2);
    const cpmRow = db.inserted.find(
      (r) => (r.evidence as Record<string, unknown>).vital === 'cpm',
    )!;
    expect(cpmRow).toMatchObject({
      client_code: 'BFM',
      ad_account_id: 'act_1',
      entity_level: 'account',
      kind: 'drift',
      source: 'loop-1-brief',
    });
    expect(cpmRow.claim).toContain('CPM $12.15');
    expect(cpmRow.evidence).toMatchObject({
      vital: 'cpm',
      label: 'CPM creep',
      first_seen: '2026-08-09',
      baseline_label: 'early May',
    });
    const ev = cpmRow.evidence as Record<string, number>;
    expect(ev.level).toBeCloseTo(12.155, 3);
    expect(ev.baseline).toBeCloseTo(9.0, 4);
    expect(ev.pct_vs_baseline).toBeCloseTo(0.3506, 3);
    expect(ev.slope_pct_per_week).toBeGreaterThan(0);
    expect(ev.weeks_running).toBeGreaterThanOrEqual(4);
    expect(cpmRow.recheck).toMatchObject({ metric: 'macro_drift', vital: 'cpm' });
  });

  it('reports a known creep as a trajectory instead of re-alarming', async () => {
    db.insights.push({
      id: 'drift-1',
      client_code: 'BFM',
      ad_account_id: 'act_1',
      entity_level: 'account',
      kind: 'drift',
      status: 'active',
      claim: 'CPM $11.10 — +23% vs early May ($9.00)',
      evidence: { vital: 'cpm', label: 'CPM creep', first_seen: '2026-08-02' },
      trajectory: [{ date: '2026-08-02', value: 11.1, verdict: 'confirmed' }],
      derived_at: '2026-08-03T06:00:00.000Z',
    });

    const { reads, chords, rendered } = pulseFor(rows);
    const lines = await syncDriftInsights('BFM', 'act_1', reads, chords, rendered);

    const cpmLine = lines.find((l) => l.includes('CPM creep'))!;
    expect(cpmLine).toMatch(/^• The CPM creep flagged Sun, Aug 2: still climbing, \+[0-9.]+%\/week — CPM \$12\.15 vs \$9\.00 in early May \(\+35%\)\.$/);
    // …and it is not re-inserted, only re-checked.
    expect(db.inserted.some((r) => (r.evidence as Record<string, unknown>).vital === 'cpm')).toBe(false);
    const update = db.updates.find((u) => u.id === 'drift-1')!;
    expect(update.patch.status).toBe('active');
    expect(update.patch.last_checked_at).toBeTruthy();
    expect(update.patch.trajectory).toHaveLength(2);
    expect((update.patch.trajectory as Array<Record<string, unknown>>)[1]).toMatchObject({
      date: '2026-08-09',
      verdict: 'confirmed',
    });
  });

  it('closes a drift that no longer gates with one closure line, and never deletes the row', async () => {
    db.insights.push({
      id: 'drift-freq',
      client_code: 'BFM',
      ad_account_id: 'act_1',
      entity_level: 'account',
      kind: 'drift',
      status: 'active',
      claim: 'Frequency 2.60 — +44% vs early May (1.80)',
      evidence: { vital: 'frequency', label: 'frequency creep', first_seen: '2026-08-02' },
      trajectory: [],
      derived_at: '2026-08-03T06:00:00.000Z',
    });

    const { reads, chords, rendered } = pulseFor(rows);
    const lines = await syncDriftInsights('BFM', 'act_1', reads, chords, rendered);

    const closure = lines.find((l) => l.includes('frequency creep'))!;
    expect(closure).toMatch(
      /^• The frequency creep flagged Sun, Aug 2: recovered — Frequency 1\.85 vs 1\.80 in early May\. Closing it\.$/,
    );
    const update = db.updates.find((u) => u.id === 'drift-freq')!;
    expect(update.patch.status).toBe('resolved');
    expect(update.patch.resolved_at).toBeTruthy();
    expect((update.patch.trajectory as Array<Record<string, unknown>>)[0]).toMatchObject({
      date: '2026-08-09',
      verdict: 'resolved',
    });
    expect(db.insights.find((r) => r.id === 'drift-freq')).toBeTruthy(); // never deleted
  });

  it('fails open: a ledger outage costs the reader nothing', async () => {
    db.failReads = true;
    const { reads, chords, rendered } = pulseFor(rows);
    const before = [...rendered.lines];
    const lines = await syncDriftInsights('BFM', 'act_1', reads, chords, rendered);
    expect(lines).toEqual(before);
    expect(db.inserted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 10. The entry point
// ---------------------------------------------------------------------------

describe('buildMacroPulse', () => {
  const seed = (rows: VitalsDay[]): void => {
    db.accountDaily = rows.map((r) => ({ client_id: 'client-uuid', ...r }));
  };
  const client = {
    id: 'client-uuid',
    code: 'BFM',
    ad_account_id: 'act_1',
    currency: 'USD',
    timezone: 'UTC',
  };
  // Monday morning; the read covers through Sunday.
  const MONDAY = new Date('2026-08-10T07:00:00.000Z');

  it('builds the block end to end and writes its memory', async () => {
    seed(drifting(HEALTHY, { reach: 61_000, freq: 2.4, cpm: 12.4, ctr: 0.012 }));
    const out = await buildMacroPulse(client, { now: MONDAY });
    expect(out).not.toBeNull();
    expect(out!.lines[0]).toBe('Macro pulse (14d vs early May, spend-context attached):');
    expect(out!.lines[1]).toMatch(/^• Top of funnel narrowing/);
    expect(out!.voicedCount).toBe(1);
    expect(db.inserted).toHaveLength(1);
    expect((db.inserted[0]!.evidence as Record<string, unknown>).vital).toBe(
      'chord:top-of-funnel-narrowing',
    );
  });

  it('leaves the ledger alone on a dry run', async () => {
    seed(drifting(HEALTHY, { reach: 61_000, freq: 2.4, cpm: 12.4, ctr: 0.012 }));
    const out = await buildMacroPulse(client, { now: MONDAY, writeToLedger: false });
    expect(out!.lines.length).toBeGreaterThan(1);
    expect(db.inserted).toHaveLength(0);
    expect(db.updates).toHaveLength(0);
  });

  it('returns null — and never a guess — when the data will not support a read', async () => {
    seed([]);
    expect(await buildMacroPulse(client, { now: MONDAY })).toBeNull();

    seed(drifting(HEALTHY, { reach: 61_000, freq: 2.4, cpm: 12.4, ctr: 0.012 }));
    db.failReads = true;
    expect(await buildMacroPulse(client, { now: MONDAY })).toBeNull();

    db.failReads = false;
    seed(rowsFor(112, () => vd(400, 1.25, 10.0, 0.012))); // under the sample floor
    expect(await buildMacroPulse(client, { now: MONDAY })).toBeNull();
  });
});
