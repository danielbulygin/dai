/**
 * Macro-creep vitals — catching the slow drift (Loop 1, the Monday brief).
 *
 * Design: docs/factory/day-2026-08-08/macro-creep-design.md (tinkers repo).
 *
 * WHY THIS EXISTS: daily anomaly detection structurally cannot see a 2%/week
 * creep. It never breaches a day-vs-recent threshold, and a ROLLING baseline
 * creeps along with the metric — week-over-week stays green the whole way down
 * (the frog-boil). Daniel's ask, verbatim: "I don't want to stand there in a
 * few months and just then notice how some macro metrics have been creeping up
 * over time without us noticing."
 *
 * The fix, from Daniel's own rules on tape: a PINNED healthy baseline ("our
 * baseline should have been May" — a reference that does not roll with the
 * metric) plus proactive leading-indicator watching ("frequency creep… caught
 * proactively, not retrospectively").
 *
 * THE VITALS (per ad account, from account_daily):
 *   CPM (cost of attention) · daily reach (footprint; its decline IS the top of
 *   the funnel drying up — the Press signature) · frequency (audience wear) ·
 *   CTR (response) · spend (context, never a verdict — reach and frequency move
 *   mechanically with budget, so every vital is read AT its spend level).
 *
 * THE THREE READS: level vs the pinned baseline · the slope in %/week and how
 * long it has run · the chord (co-movement named as ONE diagnosis, not four
 * alerts).
 *
 * VOICE: numbers lead, meaning follows, a percentage never travels without its
 * absolute, periods are NAMED ("vs early May") and never relative ("yesterday").
 * Immaterial vitals collapse into one steady line. Under 1000 impressions/day
 * nothing is voiced at all — the arithmetic would be noise.
 *
 * MEMORY: a voiced creep becomes a `drift` insight in the ledger. Following
 * Mondays report its TRAJECTORY ("still climbing" / "plateaued" / "recovered —
 * closing it") instead of re-alarming. Rows are never deleted; a ledger failure
 * never costs the reader the block (fail-open).
 *
 * Everything from `weeklyAverages` down to `renderMacroPulse` is pure — rows in,
 * sentences out. All I/O lives in `fetchVitalsHistory`, `syncDriftInsights` and
 * `buildMacroPulse` (the entry point the brief wires, Mondays only).
 */

import { getSupabase } from '../integrations/supabase.js';
import { getDaiSupabase } from '../integrations/dai-supabase.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Constants — the design doc's numbers, in one place
// ---------------------------------------------------------------------------

/** The "now" window. 14 days averages away weekday structure without lag. */
export const CURRENT_WINDOW_DAYS = 14;
/** The pinned reference ends this far back. A quarter ago is far enough that a
 *  slow creep has actually moved, and near enough to be the same business. */
export const BASELINE_OFFSET_DAYS = 90;
/** Slope horizon: a quarter of weekly points. */
export const SLOPE_WEEKS = 12;
/** Fewer points than this and an OLS trend is a line through noise. */
const MIN_SLOPE_WEEKS = 4;
/** A week with fewer days than this is PARTIAL: fine to average, never to trend. */
const MIN_DAYS_FOR_FULL_WEEK = 4;
/** Materiality gate, arm 1: level vs baseline. Strictly greater. */
export const MATERIAL_LEVEL_PCT = 0.15;
/** Materiality gate, arm 2: a run this long… */
export const MATERIAL_RUN_WEEKS = 4;
/** …that has moved cumulatively more than this. Strictly greater. */
export const MATERIAL_RUN_PCT = 0.1;
/** Small-sample guard: below this the macro arithmetic is not readable. */
export const MIN_IMPRESSIONS_PER_DAY = 1000;
/** A chord member must have moved at least this much in the named direction. */
const CHORD_MEMBER_PCT = 0.1;
/** "Flat" for the chord's spend condition and for CTR's "response flat". */
const CHORD_FLAT_PCT = 0.1;
/** Below this the slope is not a direction, it is a plateau. */
const PLATEAU_SLOPE_PCT = 0.005;
/** 16 weeks: covers the baseline window start (asOf − 103) plus a full slope. */
const HISTORY_DAYS = 112;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One `account_daily` row, vitals only. Every metric is nullable on purpose:
 * the warehouse leaves reach/frequency/cpm/ctr NULL on days it could not read
 * them, and NULL is ABSENCE — coercing it to zero manufactures a crash in the
 * numbers that never happened (a review finding in this repo, 2026-08).
 */
export interface VitalsDay {
  date: string;
  spend: number | null;
  impressions: number | null;
  reach: number | null;
  frequency: number | null;
  clicks: number | null;
  ctr: number | null;
  cpm: number | null;
  fetched_at: string | null;
}

/** The pooled vital levels over any set of days. */
export interface VitalLevels {
  /** Days with data in the window (rows present, not calendar days). */
  days: number;
  spendPerDay: number | null;
  impressionsPerDay: number | null;
  /** Pooled: total spend / total impressions × 1000. */
  cpm: number | null;
  /** Mean of the days that reported reach. */
  reachPerDay: number | null;
  /** Pooled: total impressions / total reach. */
  frequency: number | null;
  /** Pooled: total clicks / total impressions, as a fraction. */
  ctr: number | null;
}

export interface WeekBucket extends VitalLevels {
  /** ISO week key, e.g. '2026-W32'. */
  isoWeek: string;
  /** The Monday of that ISO week, YYYY-MM-DD. */
  weekStart: string;
  /** Under MIN_DAYS_FOR_FULL_WEEK days of data — excluded from slope math. */
  partial: boolean;
}

/** The vitals that can be VOICED. Spend is context, never a verdict. */
export const VOICED_VITALS = ['cpm', 'reach', 'frequency', 'ctr'] as const;
export type VitalName = (typeof VOICED_VITALS)[number];

export interface VitalRead {
  vital: VitalName;
  /** Current-window level (pooled), null when the window has no usable data. */
  level: number | null;
  /** The pinned baseline level. */
  baseline: number | null;
  /** (level − baseline) / baseline, as a fraction. */
  pctVsBaseline: number | null;
  /** OLS trend over the trailing full weeks, as a fraction per week. */
  slopePctPerWeek: number | null;
  /** How many weekly points the slope was fitted on. */
  weeksInSlope: number;
  /** Consecutive week-over-week steps in the same direction, most recent run. */
  consecutiveWeeks: number;
  /** Total move across that run, as a fraction. */
  cumulativePct: number | null;
  direction: 'up' | 'down' | 'flat';
  /** Passed the materiality gate (and the account is above the sample floor). */
  voiced: boolean;
  /** Which arm of the gate fired. */
  reason: 'level' | 'run' | null;
}

export interface MacroReads {
  /** Last complete day the read covers (YYYY-MM-DD). */
  asOf: string;
  currentWindow: { start: string; end: string; days: number };
  baselineWindow: {
    start: string;
    end: string;
    days: number;
    /** True when history was too short for the 90-days-back window. */
    fallback: boolean;
  };
  /** The named period, e.g. 'early May' — what the reader is compared against. */
  baselineLabel: string;
  /** Spend is always attached, never judged. */
  spend: { level: number | null; baseline: number | null; pctVsBaseline: number | null };
  impressionsPerDay: number | null;
  /** Below MIN_IMPRESSIONS_PER_DAY: nothing is voiced at all. */
  thin: boolean;
  vitals: VitalRead[];
}

export type ChordId = 'top-of-funnel-narrowing' | 'auction-inflation' | 'healthy-expansion';

export interface Chord {
  id: ChordId;
  /** Short noun phrase for the ledger's trajectory voice. */
  label: string;
  /** The one-line diagnosis, numbers included. */
  line: string;
  /** Vitals this chord explains — their individual lines are suppressed. */
  members: VitalName[];
  /** Vitals the diagnosis quotes as evidence — already said, so the steady
   *  line must not say them again. Not explained, just cited. */
  cites: VitalName[];
}

export interface PulseItem {
  /** Ledger key: a vital name, or 'chord:<id>'. Closures reuse their key. */
  key: string;
  kind: 'chord' | 'vital' | 'closure';
  vital?: VitalName;
  chordId?: ChordId;
  line: string;
  /** The number the ledger's trajectory records for this item. */
  level: number | null;
}

export interface RenderedPulse {
  header: string;
  /** The bullets: chords first, then individual vitals, then closures. */
  items: PulseItem[];
  /** The collapse-everything-immaterial line, in both of its forms. */
  steady: { line: string; collapsed: string } | null;
  /** Composed block. Recomputed by `syncDriftInsights` when it rewrites items. */
  lines: string[];
  /** The currency the block was rendered in — the rewrites need it too. */
  currency: string;
}

// ---------------------------------------------------------------------------
// Formatting (house style: money leads, percentages are only the meaning)
// ---------------------------------------------------------------------------

function money(value: number, currency: string, decimals = 0): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  } catch {
    return `${value.toFixed(decimals)} ${currency}`;
  }
}

/** '$9,700' reads slower than '$9.7k' when it is only context. */
function moneyCompact(value: number, currency: string): string {
  if (Math.abs(value) < 1000) return money(value, currency, 0);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    })
      .format(value)
      .replace('K', 'k');
  } catch {
    return `${(value / 1000).toFixed(1)}k ${currency}`;
  }
}

function compactNum(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trimZero((value / 1_000_000).toFixed(1))}M`;
  if (abs >= 10_000) return `${Math.round(value / 1000)}k`;
  if (abs >= 1000) return `${trimZero((value / 1000).toFixed(1))}k`;
  return Math.round(value).toLocaleString('en-US');
}

function trimZero(s: string): string {
  return s.replace(/\.0$/, '');
}

/** Signed, and never the bare '-0%' that reads as a bug. */
function pctStr(fraction: number): string {
  const pct = fraction * 100;
  let rounded = Math.abs(pct) < 10 ? Math.round(pct * 10) / 10 : Math.round(pct);
  if (Object.is(rounded, -0)) rounded = 0;
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

/** Magnitude only — the direction is carried by a word ("climbing"). */
function pctMagStr(fraction: number): string {
  const pct = Math.abs(fraction) * 100;
  return `${pct < 10 ? Math.round(pct * 10) / 10 : Math.round(pct)}%`;
}

const VITAL_LABEL: Record<VitalName, string> = {
  cpm: 'CPM',
  reach: 'Reach',
  frequency: 'Frequency',
  ctr: 'CTR',
};

const VITAL_SHORT: Record<VitalName, string> = {
  cpm: 'CPM',
  reach: 'reach',
  frequency: 'freq',
  ctr: 'CTR',
};

function vitalValue(vital: VitalName, value: number, currency: string): string {
  switch (vital) {
    case 'cpm':
      return money(value, currency, 2);
    case 'reach':
      return `${compactNum(value)}/day`;
    case 'frequency':
      return value.toFixed(2);
    case 'ctr':
      return `${(value * 100).toFixed(2)}%`;
  }
}

/** '2026-08-10' → 'Mon, Aug 10'. Same shape as the brief's dayLabel. */
export function dayLabel(dateStr: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${dateStr}T12:00:00Z`));
}

function addDays(dateStr: string, delta: number): string {
  const t = Date.parse(`${dateStr}T12:00:00Z`) + delta * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function localDateStr(instant: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}

/**
 * A period the reader can picture: 'early May', 'late April', 'mid June 2025'.
 * Seasonality is the reason this is named rather than dated — "vs early May"
 * lets a human apply what they know about May.
 */
function periodLabel(start: string, end: string, asOf: string): string {
  const mid = new Date(
    (Date.parse(`${start}T12:00:00Z`) + Date.parse(`${end}T12:00:00Z`)) / 2,
  );
  const day = mid.getUTCDate();
  const third = day <= 10 ? 'early' : day <= 20 ? 'mid' : 'late';
  const month = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(mid);
  const asOfYear = new Date(`${asOf}T12:00:00Z`).getUTCFullYear();
  const suffix = mid.getUTCFullYear() !== asOfYear ? ` ${mid.getUTCFullYear()}` : '';
  return `${third} ${month}${suffix}`;
}

// ---------------------------------------------------------------------------
// Data access — account_daily, paged (PostgREST caps at 1000 rows, silently)
// ---------------------------------------------------------------------------

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * ~16 weeks of account-level vitals, ascending. The columns the brief's own
 * `fetchAccountDaily` does not select are exactly the ones this module lives
 * on, so it owns its fetch rather than widening a shared one.
 */
export async function fetchVitalsHistory(
  clientId: string,
  sinceDateStr: string,
): Promise<VitalsDay[]> {
  const pageSize = 1000;
  const raw: Record<string, unknown>[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await getSupabase()
      .from('account_daily')
      .select('date, spend, impressions, reach, frequency, clicks, ctr, cpm, fetched_at')
      .eq('client_id', clientId)
      .gte('date', sinceDateStr)
      .order('date', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`account_daily vitals fetch failed: ${error.message}`);
    raw.push(...((data ?? []) as Record<string, unknown>[]));
    if (!data || data.length < pageSize) break;
  }
  return raw.map((r) => ({
    date: String(r.date),
    spend: numOrNull(r.spend),
    impressions: numOrNull(r.impressions),
    reach: numOrNull(r.reach),
    frequency: numOrNull(r.frequency),
    clicks: numOrNull(r.clicks),
    ctr: numOrNull(r.ctr),
    cpm: numOrNull(r.cpm),
    fetched_at: r.fetched_at ? String(r.fetched_at) : null,
  }));
}

// ---------------------------------------------------------------------------
// Pure core 1 — pooled aggregation and ISO-week buckets
// ---------------------------------------------------------------------------

function meanOf(values: number[]): number | null {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

/**
 * Pooled vitals over a set of days. Rates are POOLED (totals divided by
 * totals), never averages of daily rates — a €5 day and a €5000 day would
 * otherwise count the same. Rows missing an input are skipped for that vital
 * only; a day with no reach still contributes its CPM.
 *
 * Fallback: when the raw counts for a rate are absent everywhere in the window
 * but the warehouse stored the rate column itself, the unweighted mean of the
 * stored column is used rather than reporting nothing.
 */
export function aggregate(rows: VitalsDay[]): VitalLevels {
  const spends = rows.filter((r) => r.spend !== null).map((r) => r.spend!);
  const impr = rows.filter((r) => r.impressions !== null).map((r) => r.impressions!);
  const reach = rows.filter((r) => r.reach !== null).map((r) => r.reach!);

  const cpmRows = rows.filter((r) => r.impressions !== null && r.impressions > 0 && r.spend !== null);
  const cpmImpr = cpmRows.reduce((s, r) => s + r.impressions!, 0);
  const cpmSpend = cpmRows.reduce((s, r) => s + r.spend!, 0);

  const freqRows = rows.filter((r) => r.impressions !== null && r.reach !== null && r.reach > 0);
  const freqImpr = freqRows.reduce((s, r) => s + r.impressions!, 0);
  const freqReach = freqRows.reduce((s, r) => s + r.reach!, 0);

  const ctrRows = rows.filter((r) => r.clicks !== null && r.impressions !== null && r.impressions > 0);
  const ctrClicks = ctrRows.reduce((s, r) => s + r.clicks!, 0);
  const ctrImpr = ctrRows.reduce((s, r) => s + r.impressions!, 0);

  return {
    days: rows.length,
    spendPerDay: meanOf(spends),
    impressionsPerDay: meanOf(impr),
    cpm:
      cpmImpr > 0
        ? (cpmSpend / cpmImpr) * 1000
        : meanOf(rows.filter((r) => r.cpm !== null).map((r) => r.cpm!)),
    reachPerDay: meanOf(reach),
    frequency:
      freqReach > 0
        ? freqImpr / freqReach
        : meanOf(rows.filter((r) => r.frequency !== null).map((r) => r.frequency!)),
    ctr:
      ctrImpr > 0
        ? ctrClicks / ctrImpr
        : meanOf(rows.filter((r) => r.ctr !== null).map((r) => r.ctr!)),
  };
}

/** ISO week key + that week's Monday, both UTC-anchored at noon (DST-proof). */
export function isoWeekOf(dateStr: string): { key: string; monday: string } {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(d.getTime() - dow * 86_400_000);
  const thursday = new Date(monday.getTime() + 3 * 86_400_000);
  const year = thursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1, 12));
  const week = Math.floor((thursday.getTime() - jan1.getTime()) / (7 * 86_400_000)) + 1;
  return {
    key: `${year}-W${String(week).padStart(2, '0')}`,
    monday: monday.toISOString().slice(0, 10),
  };
}

/**
 * Daily rows → ISO-week buckets, ascending. Weekly averaging is what makes a
 * creep visible: it kills day noise and weekend structure, so the trend line is
 * the business rather than the calendar.
 */
export function weeklyAverages(rows: VitalsDay[]): WeekBucket[] {
  const buckets = new Map<string, { monday: string; rows: VitalsDay[] }>();
  for (const row of rows) {
    const { key, monday } = isoWeekOf(row.date);
    const b = buckets.get(key);
    if (b) b.rows.push(row);
    else buckets.set(key, { monday, rows: [row] });
  }
  return [...buckets.entries()]
    .sort((a, b) => a[1].monday.localeCompare(b[1].monday))
    .map(([key, b]) => ({
      isoWeek: key,
      weekStart: b.monday,
      partial: b.rows.length < MIN_DAYS_FOR_FULL_WEEK,
      ...aggregate(b.rows),
    }));
}

// ---------------------------------------------------------------------------
// Pure core 2 — the three reads
// ---------------------------------------------------------------------------

/**
 * OLS on ln(value) against the week index, returned as a compounding rate per
 * week. Logs rather than raw levels because a creep is multiplicative: a
 * 2%/week drift recovers as exactly 2%/week whatever the level it started at.
 */
export function slopePctPerWeek(values: Array<number | null>): number | null {
  const pts: Array<[number, number]> = [];
  values.forEach((v, i) => {
    if (v !== null && v > 0) pts.push([i, Math.log(v)]);
  });
  if (pts.length < MIN_SLOPE_WEEKS) return null;
  const n = pts.length;
  const meanX = pts.reduce((s, p) => s + p[0], 0) / n;
  const meanY = pts.reduce((s, p) => s + p[1], 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of pts) {
    num += (x - meanX) * (y - meanY);
    den += (x - meanX) ** 2;
  }
  if (den === 0) return null;
  return Math.exp(num / den) - 1;
}

/**
 * The most recent run of week-over-week moves in one direction. Duration is
 * what separates a creep from a wobble — "for 9 weeks" is the whole point.
 */
export function consecutiveRun(values: Array<number | null>): {
  steps: number;
  direction: 'up' | 'down' | 'flat';
  cumulativePct: number | null;
} {
  const series = values.filter((v): v is number => v !== null && v > 0);
  if (series.length < 2) return { steps: 0, direction: 'flat', cumulativePct: null };
  const last = series[series.length - 1]!;
  const prev = series[series.length - 2]!;
  if (last === prev) return { steps: 0, direction: 'flat', cumulativePct: null };
  const sign = last > prev ? 1 : -1;
  let steps = 1;
  for (let i = series.length - 2; i > 0; i -= 1) {
    const d = series[i]! - series[i - 1]!;
    if (d === 0 || Math.sign(d) !== sign) break;
    steps += 1;
  }
  const start = series[series.length - 1 - steps]!;
  return {
    steps,
    direction: sign > 0 ? 'up' : 'down',
    cumulativePct: start > 0 ? last / start - 1 : null,
  };
}

export interface VitalReadOptions {
  /** Last complete day (YYYY-MM-DD). Defaults to the newest row's date. */
  asOf?: string;
  currentWindowDays?: number;
  /** The pinned reference window ENDS this many days before asOf. */
  baselineOffsetDays?: number;
  slopeWeeks?: number;
}

const WEEK_VALUE: Record<VitalName, (w: WeekBucket) => number | null> = {
  cpm: (w) => w.cpm,
  reach: (w) => w.reachPerDay,
  frequency: (w) => w.frequency,
  ctr: (w) => w.ctr,
};

const LEVEL_VALUE: Record<VitalName, (l: VitalLevels) => number | null> = {
  cpm: (l) => l.cpm,
  reach: (l) => l.reachPerDay,
  frequency: (l) => l.frequency,
  ctr: (l) => l.ctr,
};

/**
 * Level vs the PINNED baseline, the slope, and the run — per vital.
 *
 * Takes both the daily rows and the week buckets: levels are day-windows (a
 * 14-day window does not tile onto ISO weeks), trends are week-series. The
 * buckets are passed in rather than recomputed so the caller owns the bucketing
 * and tests can inject one.
 */
export function vitalReads(
  rows: VitalsDay[],
  weeks: WeekBucket[],
  opts: VitalReadOptions = {},
): MacroReads {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const asOf = opts.asOf ?? sorted[sorted.length - 1]?.date ?? new Date().toISOString().slice(0, 10);
  const windowDays = opts.currentWindowDays ?? CURRENT_WINDOW_DAYS;
  const offset = opts.baselineOffsetDays ?? BASELINE_OFFSET_DAYS;
  const slopeWeeks = opts.slopeWeeks ?? SLOPE_WEEKS;

  const curEnd = asOf;
  const curStart = addDays(asOf, -(windowDays - 1));

  let baseEnd = addDays(asOf, -offset);
  let baseStart = addDays(baseEnd, -(windowDays - 1));
  let fallback = false;
  const firstDate = sorted[0]?.date;
  if (firstDate && baseStart < firstDate) {
    // History is shorter than the pin. Use the OLDEST same-length window we
    // actually have and say so — never silently compare against a short window.
    baseStart = firstDate;
    baseEnd = addDays(baseStart, windowDays - 1);
    fallback = true;
  }
  /** Overlapping windows would compare a period against itself. */
  const baselineUsable = baseEnd < curStart;

  const inWindow = (start: string, end: string): VitalsDay[] =>
    sorted.filter((r) => r.date >= start && r.date <= end);

  const current = aggregate(inWindow(curStart, curEnd));
  const baseline = baselineUsable ? aggregate(inWindow(baseStart, baseEnd)) : null;

  const baselineLabel = baselineUsable
    ? `${periodLabel(baseStart, baseEnd, asOf)}${fallback ? ` (the oldest ${windowDays} days on file)` : ''}`
    : 'no comparable earlier period';

  const impressionsPerDay = current.impressionsPerDay;
  const thin = impressionsPerDay === null || impressionsPerDay < MIN_IMPRESSIONS_PER_DAY;

  // Only FULL weeks up to asOf feed the trend — a 2-day stub week would read as
  // a cliff. Newest last.
  const trendWeeks = weeks
    .filter((w) => !w.partial && w.weekStart <= asOf)
    .slice(-slopeWeeks);

  const vitals: VitalRead[] = VOICED_VITALS.map((vital) => {
    const level = LEVEL_VALUE[vital](current);
    const base = baseline ? LEVEL_VALUE[vital](baseline) : null;
    const pct = level !== null && base !== null && base > 0 ? level / base - 1 : null;
    const series = trendWeeks.map((w) => WEEK_VALUE[vital](w));
    const slope = slopePctPerWeek(series);
    const run = consecutiveRun(series);

    const levelGate = pct !== null && Math.abs(pct) > MATERIAL_LEVEL_PCT;
    const runGate =
      run.steps >= MATERIAL_RUN_WEEKS &&
      run.cumulativePct !== null &&
      Math.abs(run.cumulativePct) > MATERIAL_RUN_PCT;

    const direction: VitalRead['direction'] =
      pct !== null && Math.abs(pct) > 0.005
        ? pct > 0
          ? 'up'
          : 'down'
        : run.direction;

    return {
      vital,
      level,
      baseline: base,
      pctVsBaseline: pct,
      slopePctPerWeek: slope,
      weeksInSlope: series.filter((v) => v !== null && v > 0).length,
      consecutiveWeeks: run.steps,
      cumulativePct: run.cumulativePct,
      direction,
      voiced: !thin && level !== null && (levelGate || runGate),
      reason: !thin && level !== null ? (levelGate ? 'level' : runGate ? 'run' : null) : null,
    };
  });

  const baseSpend = baseline?.spendPerDay ?? null;
  return {
    asOf,
    currentWindow: { start: curStart, end: curEnd, days: current.days },
    baselineWindow: {
      start: baseStart,
      end: baseEnd,
      days: baseline?.days ?? 0,
      fallback,
    },
    baselineLabel,
    spend: {
      level: current.spendPerDay,
      baseline: baseSpend,
      pctVsBaseline:
        current.spendPerDay !== null && baseSpend !== null && baseSpend > 0
          ? current.spendPerDay / baseSpend - 1
          : null,
    },
    impressionsPerDay,
    thin,
    vitals,
  };
}

// ---------------------------------------------------------------------------
// Pure core 3 — the chords (one diagnosis, not four alerts)
// ---------------------------------------------------------------------------

function readOf(reads: MacroReads, vital: VitalName): VitalRead | undefined {
  return reads.vitals.find((v) => v.vital === vital);
}

/** Moved at least `minPct` in the named direction — by level, or by a run. */
function moved(read: VitalRead | undefined, dir: 'up' | 'down', minPct = CHORD_MEMBER_PCT): boolean {
  if (!read || read.level === null) return false;
  const sign = dir === 'up' ? 1 : -1;
  if (read.pctVsBaseline !== null && sign * read.pctVsBaseline >= minPct) return true;
  return (
    read.consecutiveWeeks >= 3 &&
    read.cumulativePct !== null &&
    sign * read.cumulativePct >= minPct
  );
}

/** Held its level — the "response flat" half of the auction-inflation read. */
function flat(read: VitalRead | undefined, maxPct = CHORD_FLAT_PCT): boolean {
  if (!read || read.level === null || read.pctVsBaseline === null) return false;
  return Math.abs(read.pctVsBaseline) <= maxPct;
}

function withPct(read: VitalRead, currency: string, baselineLabel?: string): string {
  const value = read.level !== null ? vitalValue(read.vital, read.level, currency) : 'n/a';
  const against = baselineLabel ? ` vs ${baselineLabel}` : '';
  const pct = read.pctVsBaseline !== null ? ` (${pctStr(read.pctVsBaseline)}${against})` : '';
  return `${VITAL_SHORT[read.vital]} ${value}${pct}`;
}

function spendClause(reads: MacroReads, currency: string): string {
  const { level, baseline, pctVsBaseline } = reads.spend;
  if (level === null) return 'spend not on file for the window';
  if (baseline === null) return `on ${moneyCompact(level, currency)}/day spend (no baseline spend on file)`;
  const word =
    pctVsBaseline === null || Math.abs(pctVsBaseline) <= 0.05
      ? 'flat'
      : pctVsBaseline > 0
        ? 'up'
        : 'down';
  return `on ${moneyCompact(level, currency)}/day spend vs ${moneyCompact(baseline, currency)} (${word})`;
}

/**
 * The three named co-movement patterns from the design. A chord OWNS the vitals
 * it explains: their individual lines are suppressed, because "reach down,
 * frequency up, CPM up" told as three alerts is three times the noise and none
 * of the meaning.
 *
 * Currency is needed because the diagnosis quotes the numbers; it defaults to
 * the house default so the function stays callable as `detectChords(reads)`.
 */
export function detectChords(reads: MacroReads, currency = 'EUR'): Chord[] {
  if (reads.thin) return [];
  const cpm = readOf(reads, 'cpm');
  const reach = readOf(reads, 'reach');
  const freq = readOf(reads, 'frequency');
  const ctr = readOf(reads, 'ctr');
  const spendPct = reads.spend.pctVsBaseline;
  const chords: Chord[] = [];

  // 1. The Press signature: fewer people, seen more often, at a higher price —
  //    while the budget did not shrink. Top of funnel narrowing.
  const spendHeldUp = spendPct === null || spendPct >= -CHORD_FLAT_PCT;
  if (
    moved(reach, 'down') &&
    moved(freq, 'up') &&
    moved(cpm, 'up') &&
    spendHeldUp &&
    [reach, freq, cpm].some((r) => r?.voiced)
  ) {
    chords.push({
      id: 'top-of-funnel-narrowing',
      label: 'top-of-funnel narrowing',
      line:
        `Top of funnel narrowing — re-buying the same people at rising cost: ` +
        `${withPct(reach!, currency, reads.baselineLabel)} while ${withPct(freq!, currency)} and ` +
        `${withPct(cpm!, currency)} climb, ${spendClause(reads, currency)}.`,
      members: ['reach', 'frequency', 'cpm'],
      cites: [],
    });
  }

  // 2. Price up, response unchanged, footprint intact → the market moved, not us.
  if (
    !chords.length &&
    cpm?.voiced &&
    moved(cpm, 'up') &&
    flat(ctr) &&
    !moved(reach, 'down') &&
    !moved(freq, 'up')
  ) {
    chords.push({
      id: 'auction-inflation',
      label: 'auction inflation',
      line:
        `Auction inflation — the market got dearer, not the account: ` +
        `${withPct(cpm, currency, reads.baselineLabel)} while ${withPct(ctr!, currency)} and ` +
        `${withPct(reach!, currency)} held, ${spendClause(reads, currency)}.`,
      members: ['cpm'],
      cites: ['ctr', 'reach'],
    });
  }

  // 3. Wins get named too: more people, cheaper, seen less often.
  if (
    !chords.length &&
    moved(reach, 'up') &&
    moved(cpm, 'down') &&
    moved(freq, 'down') &&
    [reach, freq, cpm].some((r) => r?.voiced)
  ) {
    chords.push({
      id: 'healthy-expansion',
      label: 'healthy expansion',
      line:
        `Healthy expansion — a wider, cheaper audience: ` +
        `${withPct(reach!, currency, reads.baselineLabel)} with ${withPct(cpm!, currency)} and ` +
        `${withPct(freq!, currency)} falling, ${spendClause(reads, currency)}.`,
      members: ['reach', 'cpm', 'frequency'],
      cites: [],
    });
  }

  return chords;
}

/** Vitals whose individual line a chord has taken over. */
export function suppressedVitals(chords: Chord[]): Set<VitalName> {
  const out = new Set<VitalName>();
  for (const c of chords) for (const m of c.members) out.add(m);
  return out;
}

/** Vitals a chord already put a number on — never repeated in the steady line. */
export function citedVitals(chords: Chord[]): Set<VitalName> {
  const out = suppressedVitals(chords);
  for (const c of chords) for (const m of c.cites) out.add(m);
  return out;
}

// ---------------------------------------------------------------------------
// Pure core 4 — the rendered block
// ---------------------------------------------------------------------------

function trendClause(read: VitalRead): string {
  const slope = read.slopePctPerWeek;
  // No slope is not the same as a flat slope: too few full weeks on file means
  // the RATE is unknown, and the line must not imply otherwise.
  if (slope === null) {
    return read.consecutiveWeeks >= 2
      ? `${read.direction === 'down' ? 'falling' : 'climbing'} ${read.consecutiveWeeks} weeks running (too few full weeks on file for a rate)`
      : '';
  }
  if (Math.abs(slope) < PLATEAU_SLOPE_PCT) {
    return read.consecutiveWeeks >= MATERIAL_RUN_WEEKS
      ? `flat week to week, but ${read.consecutiveWeeks} weeks of drift behind it`
      : '';
  }
  const word = slope > 0 ? 'climbing' : 'falling';
  if (read.consecutiveWeeks >= 2) {
    return `${word} ~${pctMagStr(slope)}/week for ${read.consecutiveWeeks} weeks`;
  }
  return `${word} ~${pctMagStr(slope)}/week across the last ${read.weeksInSlope} weeks`;
}

function vitalLine(read: VitalRead, reads: MacroReads, currency: string): string {
  const value = vitalValue(read.vital, read.level!, currency);
  const parts: string[] = [`${VITAL_LABEL[read.vital]} ${value}`];
  const tail: string[] = [];
  if (read.pctVsBaseline !== null && read.baseline !== null) {
    tail.push(
      `${pctStr(read.pctVsBaseline)} vs ${reads.baselineLabel.split(' (')[0]} (${vitalValue(read.vital, read.baseline, currency)})`,
    );
  }
  const trend = trendClause(read);
  if (trend) tail.push(trend);
  const head = tail.length ? `${parts[0]} — ${tail.join(', ')}` : parts[0]!;
  const { level, baseline } = reads.spend;
  if (level === null) return head;
  const spendCtx =
    baseline !== null
      ? `${moneyCompact(level, currency)}/day vs ${moneyCompact(baseline, currency)}`
      : `${moneyCompact(level, currency)}/day`;
  return `${head} · spend context: ${spendCtx}`;
}

function steadySummary(reads: MacroReads, vitals: VitalRead[], currency: string): string {
  return vitals
    .filter((v) => v.level !== null)
    .map((v) => `${VITAL_SHORT[v.vital]} ${vitalValue(v.vital, v.level!, currency)}`)
    .join(' · ');
}

/** header + bullets, or the single collapsed line when nothing is happening. */
export function pulseLines(rendered: RenderedPulse): string[] {
  if (!rendered.items.length) return rendered.steady ? [rendered.steady.collapsed] : [];
  const out = [rendered.header, ...rendered.items.map((i) => `• ${i.line}`)];
  if (rendered.steady) out.push(`• ${rendered.steady.line}`);
  return out;
}

/**
 * The Macro pulse block.
 *
 * Order is the argument: chords first (one diagnosis beats four alerts), then
 * the individual vitals a chord did not already explain, then everything
 * immaterial collapsed into a single steady line. A quiet account produces ONE
 * line total — the whole block earns its place by being short when there is
 * nothing to say.
 */
export function renderMacroPulse(
  reads: MacroReads,
  chords: Chord[],
  currency: string,
  baselineLabel: string,
): RenderedPulse {
  const header = `Macro pulse (${reads.currentWindow.days || CURRENT_WINDOW_DAYS}d vs ${baselineLabel}, spend-context attached):`;
  const empty: RenderedPulse = { header, items: [], steady: null, lines: [], currency };

  // Small-sample guard: under 1000 impressions/day the arithmetic is noise, so
  // nothing at all is voiced — including the steady line, which would be a
  // confident-sounding number built on nothing.
  if (reads.thin) return empty;
  if (reads.vitals.every((v) => v.level === null)) return empty;

  const suppressed = suppressedVitals(chords);
  const items: PulseItem[] = chords.map((c) => ({
    key: `chord:${c.id}`,
    kind: 'chord' as const,
    chordId: c.id,
    line: c.line,
    level: readOf(reads, c.members[0]!)?.level ?? null,
  }));

  const voicedVitals = reads.vitals.filter((v) => v.voiced && !suppressed.has(v.vital));
  for (const v of voicedVitals) {
    items.push({
      key: v.vital,
      kind: 'vital',
      vital: v.vital,
      line: vitalLine(v, reads, currency),
      level: v.level,
    });
  }

  const cited = citedVitals(chords);
  const restVitals = reads.vitals.filter(
    (v) => v.level !== null && !v.voiced && !cited.has(v.vital),
  );
  const spendTail =
    reads.spend.level !== null ? `, at ${moneyCompact(reads.spend.level, currency)}/day spend` : '';
  const steady = restVitals.length
    ? {
        line: `Everything else steady: ${steadySummary(reads, restVitals, currency)}${spendTail}.`,
        collapsed: `Macro pulse (${reads.currentWindow.days}d vs ${baselineLabel}): vitals steady — ${steadySummary(reads, restVitals, currency)}${spendTail}.`,
      }
    : null;

  const rendered: RenderedPulse = { header, items, steady, lines: [], currency };
  rendered.lines = pulseLines(rendered);
  return rendered;
}

// ---------------------------------------------------------------------------
// Ledger memory — the drift insight and its trajectory (no re-alarming)
// ---------------------------------------------------------------------------

interface DriftRow {
  id: string;
  claim: string;
  evidence: Record<string, unknown> | null;
  trajectory: unknown;
  derived_at: string;
}

function driftNoun(read: VitalRead): string {
  const up = read.direction === 'up';
  switch (read.vital) {
    case 'cpm':
      return up ? 'CPM creep' : 'CPM drop';
    case 'reach':
      return up ? 'reach expansion' : 'reach decline';
    case 'frequency':
      return up ? 'frequency creep' : 'frequency drop';
    case 'ctr':
      return up ? 'CTR lift' : 'CTR slide';
  }
}

function firstSeenLabel(row: DriftRow): string {
  const stored = row.evidence?.first_seen;
  const date =
    typeof stored === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(stored)
      ? stored
      : (row.derived_at ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? dayLabel(date) : 'an earlier Monday';
}

function labelOf(row: DriftRow, fallback: string): string {
  const stored = row.evidence?.label;
  return typeof stored === 'string' && stored ? stored : fallback;
}

/** "still climbing, +2.1%/week" — the trajectory verb for a live drift. */
function trajectoryVoice(read: VitalRead | null, reads: MacroReads, currency: string, row: DriftRow, key: string): string {
  const when = firstSeenLabel(row);
  const noun = labelOf(row, key);
  if (!read || read.level === null) {
    return `The ${noun} flagged ${when}: no readable delivery this week — carried forward, not closed.`;
  }
  const value = vitalValue(read.vital, read.level, currency);
  const base =
    read.baseline !== null
      ? ` vs ${vitalValue(read.vital, read.baseline, currency)} in ${reads.baselineLabel.split(' (')[0]}`
      : '';
  const pct = read.pctVsBaseline !== null ? ` (${pctStr(read.pctVsBaseline)})` : '';
  const slope = read.slopePctPerWeek;
  if (slope === null || Math.abs(slope) < PLATEAU_SLOPE_PCT) {
    return `The ${noun} flagged ${when}: plateaued — ${VITAL_LABEL[read.vital]} ${value}${base}${pct}, flat week to week.`;
  }
  const word = slope > 0 ? 'still climbing' : 'still falling';
  return `The ${noun} flagged ${when}: ${word}, ${pctStr(slope)}/week — ${VITAL_LABEL[read.vital]} ${value}${base}${pct}.`;
}

function chordTrajectoryVoice(chord: Chord, row: DriftRow): string {
  return `The ${labelOf(row, chord.label)} flagged ${firstSeenLabel(row)}: still holding. ${chord.line}`;
}

function closureLine(
  row: DriftRow,
  key: string,
  reads: MacroReads,
  currency: string,
): string {
  const when = firstSeenLabel(row);
  const noun = labelOf(row, key.startsWith('chord:') ? key.slice(6).replace(/-/g, ' ') : key);
  const read = VOICED_VITALS.includes(key as VitalName) ? readOf(reads, key as VitalName) : undefined;
  if (read && read.level !== null) {
    const value = vitalValue(read.vital, read.level, currency);
    const base =
      read.baseline !== null
        ? ` vs ${vitalValue(read.vital, read.baseline, currency)} in ${reads.baselineLabel.split(' (')[0]}`
        : '';
    return `The ${noun} flagged ${when}: recovered — ${VITAL_LABEL[read.vital]} ${value}${base}. Closing it.`;
  }
  const others = reads.vitals
    .filter((v) => v.level !== null)
    .map((v) => `${VITAL_SHORT[v.vital]} ${vitalValue(v.vital, v.level!, currency)}`)
    .join(' · ');
  return `The ${noun} flagged ${when}: no longer holding${others ? ` — ${others}` : ''}. Closing it.`;
}

function currentLevelFor(key: string, reads: MacroReads): number | null {
  if (VOICED_VITALS.includes(key as VitalName)) return readOf(reads, key as VitalName)?.level ?? null;
  return null;
}

/**
 * The no-re-alarming half.
 *
 * For every voiced vital and chord: open a `drift` insight the first time, and
 * from then on append to its trajectory and REPHRASE the line as a follow-up
 * ("the CPM creep flagged Mon, Aug 11: still climbing, +2.1%/week") — the same
 * finding restated at full volume every Monday is how a reader learns to skim.
 * A drift that stops gating is resolved and gets ONE closure line, because
 * "it's fixed" is the half that earns trust.
 *
 * Rows are never deleted. Any ledger error is logged and the ORIGINAL lines are
 * returned — the block reaching the reader outranks the bookkeeping.
 *
 * Mutates `rendered` in place (items + lines) and returns the composed lines.
 */
export async function syncDriftInsights(
  clientCode: string,
  adAccountId: string | null,
  reads: MacroReads,
  chords: Chord[],
  rendered: RenderedPulse,
): Promise<string[]> {
  const original = [...rendered.lines];
  if (!rendered.items.length && reads.thin) return original;
  try {
    const dai = getDaiSupabase();
    let query = dai
      .from('ada_insights')
      .select('id, claim, evidence, trajectory, derived_at, entity_id')
      .eq('client_code', clientCode)
      .eq('entity_level', 'account')
      .eq('kind', 'drift')
      .eq('status', 'active');
    if (adAccountId) query = query.eq('ad_account_id', adAccountId);
    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const openByKey = new Map<string, DriftRow>();
    for (const raw of (data ?? []) as Array<Record<string, unknown>>) {
      const evidence = (raw.evidence ?? null) as Record<string, unknown> | null;
      const key = typeof evidence?.vital === 'string' ? evidence.vital : null;
      if (!key || openByKey.has(key)) continue;
      openByKey.set(key, {
        id: String(raw.id),
        claim: String(raw.claim ?? ''),
        evidence,
        trajectory: raw.trajectory,
        derived_at: String(raw.derived_at ?? ''),
      });
    }

    const now = new Date().toISOString();
    const inserts: Array<Record<string, unknown>> = [];
    const voicedKeys = new Set<string>();

    for (const item of rendered.items) {
      if (item.kind === 'closure') continue;
      voicedKeys.add(item.key);
      const read = item.vital ? (readOf(reads, item.vital) ?? null) : null;
      const chord = item.chordId ? chords.find((c) => c.id === item.chordId) : undefined;
      const existing = openByKey.get(item.key);

      if (existing) {
        // Second Monday onwards: trajectory voice, not a fresh alarm.
        item.line = chord
          ? chordTrajectoryVoice(chord, existing)
          : trajectoryVoice(read, reads, rendered.currency, existing, item.key);
        const trajectory = Array.isArray(existing.trajectory) ? [...existing.trajectory] : [];
        trajectory.push({ date: reads.asOf, value: item.level, verdict: 'confirmed' });
        const { error: updateError } = await dai
          .from('ada_insights')
          .update({ trajectory, last_checked_at: now, status: 'active' })
          .eq('id', existing.id);
        if (updateError) {
          logger.error({ err: updateError.message, id: existing.id }, 'drift trajectory update failed');
        }
        continue;
      }

      inserts.push({
        client_code: clientCode,
        ad_account_id: adAccountId,
        entity_level: 'account',
        entity_id: adAccountId,
        kind: 'drift',
        claim: item.line,
        evidence: {
          vital: item.key,
          label: chord ? chord.label : read ? driftNoun(read) : item.key,
          first_seen: reads.asOf,
          level: item.level,
          baseline: read?.baseline ?? null,
          baseline_label: reads.baselineLabel,
          pct_vs_baseline: read?.pctVsBaseline ?? null,
          slope_pct_per_week: read?.slopePctPerWeek ?? null,
          weeks_running: read?.consecutiveWeeks ?? null,
          ...(chord ? { chord: chord.id, members: chord.members } : {}),
        },
        recheck: {
          metric: 'macro_drift',
          vital: item.key,
          scope: { client_code: clientCode, ad_account_id: adAccountId },
          note: 'recompute level + slope next Monday; report the trajectory, never re-alarm',
        },
        source: 'loop-1-brief',
      });
    }

    if (inserts.length) {
      const { error: insertError } = await dai.from('ada_insights').insert(inserts);
      if (insertError) logger.error({ err: insertError.message }, 'drift insight insert failed');
    }

    // Drifts that no longer gate: closed, once, out loud.
    const closures: PulseItem[] = [];
    for (const [key, row] of openByKey) {
      if (voicedKeys.has(key)) continue;
      const value = currentLevelFor(key, reads);
      const trajectory = Array.isArray(row.trajectory) ? [...row.trajectory] : [];
      trajectory.push({ date: reads.asOf, value, verdict: 'resolved' });
      const { error: closeError } = await dai
        .from('ada_insights')
        .update({
          trajectory,
          last_checked_at: now,
          status: 'resolved',
          resolved_at: now,
        })
        .eq('id', row.id);
      if (closeError) {
        logger.error({ err: closeError.message, id: row.id }, 'drift closure update failed');
        continue;
      }
      closures.push({
        key,
        kind: 'closure',
        line: closureLine(row, key, reads, rendered.currency),
        level: value,
      });
    }
    rendered.items.push(...closures);
    rendered.lines = pulseLines(rendered);
    return rendered.lines;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), clientCode },
      'drift ledger sync failed — macro pulse posts without its memory',
    );
    rendered.lines = original;
    return original;
  }
}

// ---------------------------------------------------------------------------
// Entry point — what the Monday brief calls
// ---------------------------------------------------------------------------

export interface MacroPulseClient {
  id: string;
  code: string;
  ad_account_id: string | null;
  currency: string | null;
  /** Account-local timezone; the read window is the ACCOUNT's days, not UTC. */
  timezone?: string | null;
}

/**
 * Build one account's Macro pulse block.
 *
 * Returns null — and logs why — on any data failure or on an account too small
 * to read. The caller drops the section: a macro block that cannot be trusted
 * is worse than no macro block.
 *
 * Cadence is the CALLER's decision (Mondays). This function does nothing until
 * it is called; macro truth changes weekly, and daily voicing would train
 * everyone to skim past it.
 */
export async function buildMacroPulse(
  client: MacroPulseClient,
  opts: { now?: Date; writeToLedger?: boolean } = {},
): Promise<{ lines: string[]; voicedCount: number } | null> {
  const now = opts.now ?? new Date();
  const writeToLedger = opts.writeToLedger ?? true;
  const tz = client.timezone ?? 'Europe/Berlin';
  const currency = client.currency ?? 'EUR';
  const asOf = localDateStr(new Date(now.getTime() - 86_400_000), tz);
  const since = addDays(asOf, -(HISTORY_DAYS - 1));

  let rows: VitalsDay[];
  try {
    rows = await fetchVitalsHistory(client.id, since);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), code: client.code },
      'macro pulse skipped — vitals history unavailable',
    );
    return null;
  }
  try {
    return await composeMacroPulse(client, rows, asOf, currency, writeToLedger);
  } catch (err) {
    // The brief must survive this module having a bad day.
    logger.error(
      { err: err instanceof Error ? err.message : String(err), code: client.code },
      'macro pulse skipped — composition failed',
    );
    return null;
  }
}

async function composeMacroPulse(
  client: MacroPulseClient,
  rows: VitalsDay[],
  asOf: string,
  currency: string,
  writeToLedger: boolean,
): Promise<{ lines: string[]; voicedCount: number } | null> {
  if (!rows.length) {
    logger.info({ code: client.code, asOf }, 'macro pulse skipped — no account_daily rows');
    return null;
  }

  const weeks = weeklyAverages(rows);
  const reads = vitalReads(rows, weeks, { asOf });
  if (reads.thin) {
    logger.info(
      { code: client.code, impressionsPerDay: reads.impressionsPerDay },
      'macro pulse skipped — under the 1000 impressions/day reading floor',
    );
    return null;
  }

  const chords = detectChords(reads, currency);
  const rendered = renderMacroPulse(reads, chords, currency, reads.baselineLabel);
  if (!rendered.lines.length) {
    logger.info({ code: client.code }, 'macro pulse skipped — no readable vitals in the window');
    return null;
  }

  const lines = writeToLedger
    ? await syncDriftInsights(client.code, client.ad_account_id, reads, chords, rendered)
    : rendered.lines;

  return { lines, voicedCount: rendered.items.length };
}
