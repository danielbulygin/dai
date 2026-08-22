import { shortDay } from './audit-window.js';
import { resultOf } from './report-pack.js';

/**
 * The account against its own best month.
 *
 * The cross-account cost benchmark was dropped on purpose: another account's
 * cost per result is another account's offer, market and margin, so a number
 * built from it grades a business we never read. The account's OWN best 30-day
 * stretch has none of that problem. It is the same offer, the same pixel and
 * the same currency, and it already happened, which is what makes it a target
 * a reader cannot argue with.
 *
 * Deterministic on purpose: every sentence here traces to arithmetic over the
 * daily rows, and the floors that decide which stretch may be called "best"
 * are stated in the derivation rather than hidden in the code. Pure: rows in,
 * read out. No clock, no network, no logging.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One account day. Structurally what `PackAccountRow` already is. */
export interface OwnBestDayRow {
  date: string;
  spend: number;
  results?: number | null;
  purchases?: number | null;
  leads?: number | null;
}

/** One ad day, for naming what carried the best stretch. */
export interface OwnBestAdRow {
  ad_id: string;
  ad_name?: string | null;
  date: string;
  spend: number;
}

export interface OwnBestMonthInputs {
  /** The longest daily ACCOUNT series the pull holds. */
  days: OwnBestDayRow[];
  /**
   * Ad-level days covering the same span, where the pull carries them. Without
   * them the read still runs and simply never names what carried the stretch:
   * an unnamed ad is a missing sentence, an invented one is a wrong receipt.
   */
  ads?: OwnBestAdRow[];
  currency: string;
  /** The one result word this report uses, e.g. 'lead' or 'result'. */
  resultNoun: string;
  /** The window's last day. Rows after it belong to a window this does not cover. */
  anchorDate?: string | null;
}

// ---------------------------------------------------------------------------
// The rules, stated as numbers so a reader can argue with them
// ---------------------------------------------------------------------------

/** The stretch length compared. One month, because that is how budgets are read. */
export const WINDOW_DAYS = 30;
/** Below this many spending days there is no second month to compare against. */
export const MIN_SPEND_DAYS = 60;
/** A stretch with fewer results than this has a cost per result made of noise. */
export const MIN_WINDOW_RESULTS = 20;
/**
 * The spend floor a stretch must clear, in account currency, applied as the
 * SMALLER of half the current stretch's spend and this number: a lucky cheap
 * week at a tenth of today's budget would otherwise set an unbeatable record
 * the account never actually ran at.
 */
export const MIN_WINDOW_SPEND = 500;
/** Cost per result this far above the best stretch is a finding, not noise. */
export const BEATABLE_GAP = 0.2;
/** This many shared days means the best stretch IS the one being lived in. */
export const BEST_IS_NOW_OVERLAP_DAYS = 15;
/**
 * Stretches starting this far apart cross seasons, so the gap gets a
 * qualifying clause. Longer than any 90-day series can produce, which is the
 * point: the clause is for the day this read is fed a six-month series.
 */
export const SEASON_GAP_DAYS = 120;
/** At most this many ads are named as carrying the best stretch. */
export const MAX_CARRIED_ADS = 2;

// ---------------------------------------------------------------------------
// Small helpers, the same shapes as the rest of the pack
// ---------------------------------------------------------------------------

const r1 = (v: number): number => Math.round(v * 10) / 10;
const r2 = (v: number): number => Math.round(v * 100) / 100;
const money = (v: number, currency: string): string =>
  `${Math.round(v).toLocaleString('en-US')}${currency ? ` ${currency}` : ''}`;
/** Two decimals kept: a cost per result of 18.59 must not read as 19. */
const moneyExact = (v: number, currency: string): string =>
  `${v.toFixed(2)}${currency ? ` ${currency}` : ''}`;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
/** "1 more lead", "150 more leads" — the count sits before the word, never after it. */
const moreOf = (n: number, word: string): string => `${n} more ${word}${n === 1 ? '' : 's'}`;
const dayNumber = (isoDay: string): number => Math.floor(Date.parse(`${isoDay.slice(0, 10)}T00:00:00Z`) / 86_400_000);
const isoOf = (dayNo: number): string => new Date(dayNo * 86_400_000).toISOString().slice(0, 10);
const trunc = (name: string): string => (name.length > 48 ? name.slice(0, 48) : name);
const upperFirst = (s: string): string => (s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s);

// ---------------------------------------------------------------------------
// The series: one row per calendar day, gaps filled with zeros
// ---------------------------------------------------------------------------

export interface SeriesDay {
  date: string;
  spend: number;
  results: number;
}

/**
 * The account's days, one per calendar day from the first row to the last, a
 * day the pull never carried counting as a day with no spend and no result.
 * The alternative is sliding over row indexes, which would call 30 rows spread
 * across four months a "30-day stretch".
 */
export function buildSeries(days: OwnBestDayRow[], anchorDate?: string | null): SeriesDay[] {
  const byDay = new Map<number, SeriesDay>();
  for (const row of days) {
    if (typeof row.date !== 'string' || row.date.length < 10) continue;
    const date = row.date.slice(0, 10);
    if (anchorDate && date > anchorDate.slice(0, 10)) continue;
    const key = dayNumber(date);
    if (!Number.isFinite(key)) continue;
    const held = byDay.get(key) ?? { date, spend: 0, results: 0 };
    held.spend += typeof row.spend === 'number' && Number.isFinite(row.spend) ? row.spend : 0;
    held.results += resultOf(row);
    byDay.set(key, held);
  }
  const keys = [...byDay.keys()].sort((a, b) => a - b);
  if (keys.length === 0) return [];
  const out: SeriesDay[] = [];
  for (let d = keys[0]!; d <= keys[keys.length - 1]!; d += 1) {
    out.push(byDay.get(d) ?? { date: isoOf(d), spend: 0, results: 0 });
  }
  return out;
}

interface WindowRead {
  /** Index of the stretch's first day in the series. */
  start: number;
  startDate: string;
  endDate: string;
  spend: number;
  results: number;
  /** Spend over results, infinite on a stretch with no result at all. */
  costPerResult: number;
}

const readWindow = (series: SeriesDay[], start: number): WindowRead | null => {
  const slice = series.slice(start, start + WINDOW_DAYS);
  if (slice.length < WINDOW_DAYS) return null;
  const spend = slice.reduce((a, d) => a + d.spend, 0);
  const results = slice.reduce((a, d) => a + d.results, 0);
  return {
    start,
    startDate: slice[0]!.date,
    endDate: slice[slice.length - 1]!.date,
    spend,
    results,
    costPerResult: results > 0 ? spend / results : Number.POSITIVE_INFINITY,
  };
};

/**
 * The cheapest 30-day stretch clearing both floors. A tie keeps the EARLIEST
 * stretch, so the same series always names the same month.
 */
export function findBestWindow(series: SeriesDay[], spendFloor: number): WindowRead | null {
  let best: WindowRead | null = null;
  for (let i = 0; i + WINDOW_DAYS <= series.length; i += 1) {
    const w = readWindow(series, i);
    if (!w) continue;
    if (w.results < MIN_WINDOW_RESULTS || w.spend < spendFloor) continue;
    if (!best || w.costPerResult < best.costPerResult) best = w;
  }
  return best;
}

// ---------------------------------------------------------------------------
// What carried the best stretch
// ---------------------------------------------------------------------------

export interface CarriedAd {
  ad_id: string;
  name: string;
  spend_in_best: number;
  /** Share of the best stretch's ad-level spend, as a %. */
  share_pct: number;
  spend_in_current: number;
  still_spending: boolean;
}

/**
 * The one or two ads carrying the most spend inside the best stretch, and
 * whether each is still spending now. An ad the pull gave no name is skipped
 * rather than printed as an id: an id in a sentence is a receipt nobody can
 * check.
 */
export function carriedBy(
  ads: OwnBestAdRow[],
  best: { startDate: string; endDate: string },
  current: { startDate: string; endDate: string },
): CarriedAd[] {
  const inBest = new Map<string, { name: string | null; spend: number }>();
  const inCurrent = new Map<string, number>();
  let bestTotal = 0;
  for (const row of ads) {
    if (typeof row.ad_id !== 'string' || typeof row.date !== 'string' || row.date.length < 10) continue;
    const date = row.date.slice(0, 10);
    const spend = typeof row.spend === 'number' && Number.isFinite(row.spend) ? row.spend : 0;
    if (date >= best.startDate && date <= best.endDate) {
      const held = inBest.get(row.ad_id) ?? { name: null, spend: 0 };
      held.spend += spend;
      if (!held.name && typeof row.ad_name === 'string' && row.ad_name.trim().length > 0) held.name = row.ad_name.trim();
      inBest.set(row.ad_id, held);
      bestTotal += spend;
    }
    if (date >= current.startDate && date <= current.endDate) {
      inCurrent.set(row.ad_id, (inCurrent.get(row.ad_id) ?? 0) + spend);
    }
  }
  return [...inBest.entries()]
    .filter(([, v]) => v.name !== null && v.spend > 0)
    .sort((a, b) => b[1].spend - a[1].spend || a[0].localeCompare(b[0]))
    .slice(0, MAX_CARRIED_ADS)
    .map(([ad_id, v]) => {
      const spendNow = inCurrent.get(ad_id) ?? 0;
      return {
        ad_id,
        name: trunc(v.name!),
        spend_in_best: Math.round(v.spend),
        share_pct: bestTotal > 0 ? r1((v.spend / bestTotal) * 100) : 0,
        spend_in_current: Math.round(spendNow),
        still_spending: spendNow > 0,
      };
    });
}

/** The carried-by sentences, empty when no ad could be named. */
function carriedSentences(carried: CarriedAd[], currentEnd: string, currency: string): string[] {
  if (carried.length === 0) return [];
  const names = carried.map((a) => `"${a.name}"`);
  const share = carried.reduce((a, c) => a + c.share_pct, 0);
  const who =
    carried.length === 1
      ? `${plural(1, 'ad')} carried that stretch: ${names[0]}, ${r1(carried[0]!.share_pct)}% of its ad spend.`
      : `${plural(carried.length, 'ad')} carried that stretch: ${names.join(' and ')}, ${r1(share)}% of its ad spend between them.`;
  const stopped = carried.filter((a) => !a.still_spending);
  const window = `the ${WINDOW_DAYS} days ending ${shortDay(currentEnd)}`;
  let now: string;
  if (stopped.length === 0) {
    now =
      carried.length === 1
        ? `It is still spending in ${window}, ${money(carried[0]!.spend_in_current, currency)} of it.`
        : `Both are still spending in ${window}.`;
  } else if (stopped.length === carried.length) {
    now =
      carried.length === 1
        ? `It has spent nothing in ${window}.`
        : `Neither of them has spent anything in ${window}.`;
  } else {
    now = `${stopped.map((a) => `"${a.name}"`).join(' and ')} has spent nothing in ${window}.`;
  }
  return [who, now];
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

export type OwnBestCase = 'beatable' | 'holding' | 'best_is_now';
export type OwnBestRefusal = 'series_too_short' | 'no_candidate_window' | 'no_current_results';

export interface OwnBestMonthRead {
  /** Null when the read refused. */
  case: OwnBestCase | null;
  refusal: OwnBestRefusal | null;
  /** The sentences this half contributes to the chapter. Always populated. */
  summary: string;
  /** Only on the case that has a real step. */
  next_step: string | null;
  /** True only where the account is measurably behind its own best month. */
  signal: boolean;
  /** The payload, published under `own_best`. */
  data: Record<string, unknown>;
  derivation: string;
  warnings: string[];
}

const refuse = (
  refusal: OwnBestRefusal,
  summary: string,
  warning: string,
  data: Record<string, unknown>,
  derivation: string,
): OwnBestMonthRead => ({
  case: null,
  refusal,
  summary,
  next_step: null,
  signal: false,
  data: { case: null, refusal, ...data },
  derivation,
  warnings: [warning],
});

export function computeOwnBestMonth(inp: OwnBestMonthInputs): OwnBestMonthRead {
  const noun = inp.resultNoun?.trim() || 'result';
  const currency = inp.currency ?? '';
  const series = buildSeries(inp.days, inp.anchorDate);
  const spendDays = series.filter((d) => d.spend > 0).length;
  const floorsLine =
    `A stretch may only be called the best one if it carries at least ${plural(MIN_WINDOW_RESULTS, noun)} and at least ` +
    `the smaller of half the current stretch's spend and ${money(MIN_WINDOW_SPEND, currency)}. ` +
    `Without those floors a quiet week at a tenth of today's budget would set a record the account never ran at.`;

  if (spendDays < MIN_SPEND_DAYS) {
    return refuse(
      'series_too_short',
      `This read holds ${plural(spendDays, 'day')} of account spend. Measuring a month against the account's own best month needs at least ${MIN_SPEND_DAYS} spending days, so that there are two separate months to compare.`,
      `Only ${spendDays} spending days in the daily series, under the ${MIN_SPEND_DAYS} needed for two comparable months, so no own-best-month comparison is claimed.`,
      { days_read: series.length, days_with_spend: spendDays },
      `The daily account series holds ${plural(series.length, 'day')}, ${spendDays} of them with spend. Two separate ${WINDOW_DAYS}-day stretches cannot be cut from that.`,
    );
  }

  const current = readWindow(series, series.length - WINDOW_DAYS)!;
  const spendFloor = Math.min(current.spend / 2, MIN_WINDOW_SPEND);

  if (current.results <= 0) {
    return refuse(
      'no_current_results',
      `The ${WINDOW_DAYS} days ending ${shortDay(current.endDate)} record no ${noun}, so there is no current cost per ${noun} to hold against the account's own best month.`,
      `The current ${WINDOW_DAYS}-day stretch records no result, so there is nothing to compare against a best stretch.`,
      { days_read: series.length, days_with_spend: spendDays, current_window_end: current.endDate, current_results: 0 },
      `The current stretch is the newest ${WINDOW_DAYS} days of the series, ending ${shortDay(current.endDate)}. It records no ${noun}, and a cost per ${noun} cannot be divided out of nothing.`,
    );
  }

  const best = findBestWindow(series, spendFloor);
  if (!best) {
    return refuse(
      'no_candidate_window',
      `No ${WINDOW_DAYS}-day stretch in this read clears the floor of ${plural(MIN_WINDOW_RESULTS, noun)} and ${money(spendFloor, currency)} of spend, so there is no month in this account's own history solid enough to call its best.`,
      `No ${WINDOW_DAYS}-day stretch met the ${MIN_WINDOW_RESULTS} result and ${Math.round(spendFloor)} spend floors, so no best month is named.`,
      {
        days_read: series.length,
        days_with_spend: spendDays,
        current_window_end: current.endDate,
        min_results: MIN_WINDOW_RESULTS,
        min_spend: Math.round(spendFloor),
      },
      `Every ${WINDOW_DAYS}-day stretch of the ${plural(series.length, 'day')} in this read was measured. ${floorsLine} None of them cleared both.`,
    );
  }

  const overlapDays = Math.max(
    0,
    Math.min(best.start, current.start) + WINDOW_DAYS - Math.max(best.start, current.start),
  );
  const gap = best.costPerResult > 0 ? current.costPerResult / best.costPerResult - 1 : 0;
  const extraSameMoney = Math.floor(current.spend / best.costPerResult - current.results);
  const startsApart = dayNumber(current.startDate) - dayNumber(best.startDate);
  const crossesSeasons = startsApart >= SEASON_GAP_DAYS;
  const carried = carriedBy(inp.ads ?? [], best, current);

  const bestRun = `${shortDay(best.startDate)} to ${shortDay(best.endDate)}`;
  const currentWindow = `the ${WINDOW_DAYS} days ending ${shortDay(current.endDate)}`;

  const data: Record<string, unknown> = {
    days_read: series.length,
    days_with_spend: spendDays,
    result_noun: noun,
    currency,
    window_days: WINDOW_DAYS,
    best_window: {
      start: best.startDate,
      end: best.endDate,
      spend: Math.round(best.spend),
      results: Math.round(best.results),
      cost_per_result: r2(best.costPerResult),
    },
    current_window: {
      start: current.startDate,
      end: current.endDate,
      spend: Math.round(current.spend),
      results: Math.round(current.results),
      cost_per_result: r2(current.costPerResult),
    },
    gap_pct: r1(gap * 100),
    overlap_days: overlapDays,
    extra_results_same_money: extraSameMoney >= 1 ? extraSameMoney : null,
    carried_by: carried,
    crosses_seasons: crossesSeasons,
    days_between_window_starts: startsApart,
    min_results: MIN_WINDOW_RESULTS,
    min_spend: Math.round(spendFloor),
    beatable_gap_pct: Math.round(BEATABLE_GAP * 100),
  };

  const derivation =
    `Every ${WINDOW_DAYS}-day stretch of the ${plural(series.length, 'day')} of daily account history in this read was ` +
    `measured, stepping one day at a time, ${spendDays} of them with spend. ` +
    `A stretch's cost per ${noun} is its whole spend over its whole ${noun} count, never an average of daily ones. ${floorsLine} ` +
    `The best stretch is the cheapest one left, and a tie keeps the earlier one. ` +
    `The current stretch is the newest ${WINDOW_DAYS} days, ending ${shortDay(current.endDate)}. ` +
    `The gap is the current cost per ${noun} over the best one, minus one. ` +
    `The same-money figure divides the current stretch's spend by the best stretch's cost per ${noun} and rounds down. ` +
    `A best stretch sharing ${BEST_IS_NOW_OVERLAP_DAYS} days or more with the current one is read as the account already ` +
    `being in its best month, and stretches starting ${SEASON_GAP_DAYS} days or more apart get a seasonal caveat.`;

  // The best month is the one being lived in.
  if (overlapDays >= BEST_IS_NOW_OVERLAP_DAYS) {
    return {
      case: 'best_is_now',
      refusal: null,
      summary:
        `Your best 30 days are the ones you are in. The stretch ending ${shortDay(best.endDate)} bought ` +
        `${plural(Math.round(best.results), noun)} at ${moneyExact(best.costPerResult, currency)} each, and no earlier ` +
        `30 days in this read did better on cost per ${noun}.`,
      next_step: null,
      signal: false,
      data: { case: 'best_is_now', refusal: null, ...data },
      derivation,
      warnings: [],
    };
  }

  // The account has already proven a cheaper month than the one it is running.
  if (gap >= BEATABLE_GAP) {
    const parts: string[] = [
      `Your best 30 days in this read ran ${bestRun}: ${plural(Math.round(best.results), noun)} at ` +
        `${moneyExact(best.costPerResult, currency)} each on ${money(best.spend, currency)} of spend.`,
      `${upperFirst(currentWindow)} are running at ${moneyExact(current.costPerResult, currency)} per ${noun}, ` +
        `${r1(gap * 100)}% more.`,
    ];
    if (extraSameMoney >= 1) {
      parts.push(
        `At the best stretch's cost, the ${money(current.spend, currency)} you spent in those 30 days would have bought ` +
          `${moreOf(extraSameMoney, noun)} for the same money.`,
      );
    }
    parts.push(...carriedSentences(carried, current.endDate, currency));
    if (crossesSeasons) {
      parts.push(
        `Those two stretches start ${plural(startsApart, 'day')} apart, so the comparison crosses seasons and part of the gap may be the calendar rather than the ads.`,
      );
    }
    const names = carried.map((a) => `"${a.name}"`).join(' and ');
    return {
      case: 'beatable',
      refusal: null,
      summary: parts.join(' '),
      next_step:
        (carried.length > 0
          ? `Start from what that stretch ran rather than from scratch: ${names} ${carried.length === 1 ? 'was' : 'were'} carrying it, so the angle and the offer behind ${carried.length === 1 ? 'it' : 'them'} are the first thing to put back in market. `
          : `Start from what the account ran between ${shortDay(best.startDate)} and ${shortDay(best.endDate)} rather than from scratch. `) +
        `Your own history is the proof that ${moneyExact(best.costPerResult, currency)} per ${noun} is reachable in this account.`,
      signal: true,
      data: { case: 'beatable', refusal: null, ...data },
      derivation,
      warnings: [],
    };
  }

  // Running at or near its own proven best.
  const holdingRead =
    gap <= 0
      ? `${upperFirst(currentWindow)} are running at ${moneyExact(current.costPerResult, currency)} per ${noun}, below every ` +
        `earlier 30-day stretch in this read that carries at least ${plural(MIN_WINDOW_RESULTS, noun)}. ` +
        `The account's own history holds no cheaper month to aim at.`
      : `Your best 30 days in this read ran ${bestRun} at ${moneyExact(best.costPerResult, currency)} per ${noun}, and ` +
        `${currentWindow} are running at ${moneyExact(current.costPerResult, currency)}, ${r1(gap * 100)}% above it. ` +
        `This account is inside ${Math.round(BEATABLE_GAP * 100)}% of its own proven best, so its own history holds no cheaper month to aim at.`;
  return {
    case: 'holding',
    refusal: null,
    summary: holdingRead,
    next_step: null,
    signal: false,
    data: { case: 'holding', refusal: null, ...data },
    derivation,
    warnings: [],
  };
}
