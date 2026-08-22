import { shortDay } from './audit-window.js';
import { resultOf, type PackSection } from './report-pack.js';

/**
 * The story behind the biggest move: when it started, which step of the funnel
 * moved with it, what the account's own change log says was done around that
 * date, and what to do next.
 *
 * Every other chapter answers "what". Dan's method (taught on the 2026-07-27
 * Nina call) is that movement is half a finding: the day it started is the join
 * key for everything else, the steps that stayed FLAT localize the cause as
 * precisely as the ones that moved, and the account's own change history around
 * that date is the difference between a guess and a receipt.
 *
 * Deterministic on purpose. This text sits under a customer-facing headline and
 * an LLM pass here would be the one place invented specifics could reach it, so
 * every sentence traces to arithmetic over the rows above it. Pure: rows in,
 * section out. No clock, no network, no logging.
 *
 * Frequency is deliberately NOT read here. Account-level frequency cannot be
 * summed from per ad set or per ad rows without counting the same person once
 * per ad set, and understating frequency invents headroom the account does not
 * have. That is the same rule the saturation chapter is planned behind.
 */

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One account day. Structurally what `PackAccountRow` already is. */
export interface RootCauseDayRow {
  date: string;
  spend: number;
  impressions: number;
  /** The click basis this report prefers, where the pull carries it. */
  link_clicks?: number | null;
  /** All clicks, the fallback basis. Named in the derivation when it is used. */
  clicks?: number | null;
  results?: number | null;
  purchases?: number | null;
  leads?: number | null;
}

/**
 * What somebody did to the account, in the closed vocabulary the change history
 * normalizes into, plus `budget_changed` for a source that records that a
 * budget moved without recording which way, and `other` for a change we keep
 * but cannot name. A kind is a claim about what a person did, so a change that
 * cannot be placed is carried as `other` rather than guessed into a story.
 */
export type ReceiptKind =
  | 'paused'
  | 'resumed'
  | 'budget_increased'
  | 'budget_decreased'
  | 'budget_changed'
  | 'other';

export interface ChangeReceipt {
  /** ISO-8601 timestamp of the change. */
  at: string;
  kind: ReceiptKind;
  objectName: string | null;
  objectType: string | null;
  /** Major currency units, budget changes only. */
  fromBudget: number | null;
  toBudget: number | null;
  /** The person or tool behind it, where the source names one. */
  actorName: string | null;
}

export interface RootCauseInputs {
  /** The longest daily account history the pull holds. */
  days: RootCauseDayRow[];
  currency: string;
  /**
   * The account's own change log, or NULL when the read could not be served.
   * Null and empty are different findings and the section says different
   * sentences about them: "nothing changed" and "I cannot see what changed"
   * collapsing into one is a fabricated receipt.
   */
  changes: ChangeReceipt[] | null;
  /** The window's last day. Rows after it belong to a window this does not cover. */
  anchorDate?: string | null;
}

// ---------------------------------------------------------------------------
// The rules, stated as numbers so a reader can argue with them
// ---------------------------------------------------------------------------

/** Below this many spending days there is not enough series to pin a date on. */
export const MIN_ACCOUNT_DAYS = 10;
/** A break: the trailing 3 days average at least this multiple of the 7 before. */
export const BREAK_RATIO = 1.3;
/** How far a funnel step has to move before it is named as having moved. */
export const MOVE_THRESHOLD = 0.25;
/** How near the start date a change has to be to count as a receipt. */
export const RECEIPT_WINDOW_DAYS = 3;
/** At most this many receipts are quoted; the rest are counted, never listed. */
export const MAX_RECEIPTS = 3;
/** Cost per result rising this much after a budget move is scale damage. */
export const SCALE_DAMAGE_COST_RISE = 0.3;
/** Daily spend up this much is a scale up rather than drift. */
export const HEALTHY_SPEND_RISE = 0.3;
/** Cost per result inside this band of where it was counts as held. */
export const HEALTHY_COST_BAND = 0.15;

/** Candidate start days scanned, the most recent stretch of the series. */
const SCAN_DAYS = 14;
/** Days of history each candidate is measured against. */
const HISTORY_DAYS = 7;
/** Days averaged from the candidate day forward. */
const TRAILING_DAYS = 3;
/** Below this many days before the date there is nothing to compare against. */
const MIN_BEFORE_DAYS = 3;

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
const num = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const dayNumber = (isoDay: string): number => Math.floor(Date.parse(`${isoDay.slice(0, 10)}T00:00:00Z`) / 86_400_000);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

const sum = (rows: RootCauseDayRow[], of: (d: RootCauseDayRow) => number): number =>
  rows.reduce((a, d) => a + of(d), 0);

/** Relative change, after against before. Null when there is no base to divide by. */
const rel = (before: number | null, after: number | null): number | null =>
  before !== null && after !== null && before > 0 ? (after - before) / before : null;

const dirWord = (change: number): string => `${change > 0 ? 'up' : 'down'} ${r1(Math.abs(change) * 100)}%`;

/** Daily cost per result. Null on a day with no result, never a fake zero. */
const costPerResult = (d: RootCauseDayRow): number | null => {
  const results = resultOf(d);
  return results > 0 ? d.spend / results : null;
};

const mean = (values: Array<number | null>): number | null => {
  const known = values.filter((v): v is number => v !== null);
  return known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : null;
};

// ---------------------------------------------------------------------------
// 1. WHEN — the start date, which is the join key for everything else
// ---------------------------------------------------------------------------

/**
 * The first day, scanning the most recent candidates, whose own trailing 3-day
 * mean cost per result sits at least `BREAK_RATIO` above the mean of the 7 days
 * before it. Null when the series has no clean break, and then the section
 * refuses: a vague story about an unpinned date is worse than no story.
 */
export function pinStartDate(days: RootCauseDayRow[]): string | null {
  const values = days.map(costPerResult);
  for (let i = Math.max(HISTORY_DAYS, days.length - SCAN_DAYS); i < days.length - 1; i += 1) {
    const before = mean(values.slice(Math.max(0, i - HISTORY_DAYS), i));
    const after = mean(values.slice(i, Math.min(days.length, i + TRAILING_DAYS)));
    if (before !== null && after !== null && before > 0 && after / before >= BREAK_RATIO) {
      return days[i]!.date;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2. Which step moved, and which stayed flat
// ---------------------------------------------------------------------------

interface ClickBasis {
  of: (d: RootCauseDayRow) => number;
  /** What the clicks are, in the words the section uses. */
  word: string;
}

/**
 * Which click column the rows actually carry, decided once over the whole
 * window so the before and after halves can never be read off different
 * columns. Null when nothing recorded a click at all, and then both click
 * steps are left out rather than divided by a zero the pull never measured.
 */
function clickBasisOf(days: RootCauseDayRow[]): ClickBasis | null {
  if (sum(days, (d) => num(d.link_clicks)) > 0) return { of: (d) => num(d.link_clicks), word: 'link clicks' };
  if (sum(days, (d) => num(d.clicks)) > 0) return { of: (d) => num(d.clicks), word: 'all clicks' };
  return null;
}

interface StageRead {
  /** Stable id, joined on by the page. */
  stage: string;
  label: string;
  before: number | null;
  after: number | null;
  change: number | null;
  moved: boolean;
}

function buildStages(before: RootCauseDayRow[], after: RootCauseDayRow[], basis: ClickBasis | null): StageRead[] {
  const rate = (
    rows: RootCauseDayRow[],
    numerator: (d: RootCauseDayRow) => number,
    denominator: (d: RootCauseDayRow) => number,
  ): number | null => {
    const den = sum(rows, denominator);
    return den > 0 ? sum(rows, numerator) / den : null;
  };

  const defs: Array<{ stage: string; label: string; of: (rows: RootCauseDayRow[]) => number | null }> = [
    {
      stage: 'delivery_cost',
      label: 'delivery cost (CPM)',
      of: (rows) => rate(rows, (d) => d.spend * 1000, (d) => d.impressions),
    },
  ];
  if (basis) {
    defs.push(
      {
        stage: 'interest',
        label: basis.word === 'link clicks' ? 'interest in the ads (link CTR)' : 'interest in the ads (CTR on all clicks)',
        of: (rows) => rate(rows, basis.of, (d) => d.impressions),
      },
      {
        stage: 'clicks_to_results',
        label: `${basis.word} becoming results`,
        of: (rows) => rate(rows, (d) => resultOf(d), basis.of),
      },
    );
  }

  return defs.map(({ stage, label, of }) => {
    const b = of(before);
    const a = of(after);
    const change = rel(b, a);
    return { stage, label, before: b, after: a, change, moved: change !== null && Math.abs(change) >= MOVE_THRESHOLD };
  });
}

// ---------------------------------------------------------------------------
// 3. The receipts — what the account's own change log says was done
// ---------------------------------------------------------------------------

const trunc = (name: string): string => (name.length > 48 ? name.slice(0, 48) : name);

/**
 * What the change was done TO, and only when the log named it. A level guessed
 * from an event name is how a receipt ends up citing the wrong thing: the
 * provider's own historical vocabulary disagrees with itself about what an ad
 * set is called, so an unnamed object stays unnamed.
 */
function subjectOf(receipt: ChangeReceipt): string | null {
  return receipt.objectName ? `"${trunc(receipt.objectName)}"` : null;
}

export function receiptSentence(receipt: ChangeReceipt, currency: string): string {
  const when = shortDay(receipt.at.slice(0, 10));
  const thing = subjectOf(receipt);
  const move =
    receipt.fromBudget !== null && receipt.toBudget !== null
      ? ` from ${money(receipt.fromBudget, currency)} to ${money(receipt.toBudget, currency)}`
      : '';
  const on = thing ? ` on ${thing}` : '';
  let sentence: string;
  switch (receipt.kind) {
    case 'paused':
      sentence = `${thing ?? 'something in the account'} was paused on ${when}`;
      break;
    case 'resumed':
      sentence = `${thing ?? 'something in the account'} was restarted on ${when}`;
      break;
    case 'budget_increased':
      sentence = `the daily budget${on} went up${move} on ${when}`;
      break;
    case 'budget_decreased':
      sentence = `the daily budget${on} came down${move} on ${when}`;
      break;
    case 'budget_changed':
      sentence = `the daily budget${on} was changed${move} on ${when}`;
      break;
    default:
      sentence = `${thing ?? 'something in the account'} was changed on ${when}`;
  }
  return receipt.actorName ? `${sentence}, by ${receipt.actorName}` : sentence;
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

export type RootCauseSignature =
  | 'scale_damage'
  | 'bad_traffic'
  | 'measurement_or_site'
  | 'auction_squeeze'
  | 'healthy_scaling'
  | 'generic';

/**
 * The changes inside the window that the section counted and did not quote.
 * One of them is a change that "sits" and two are changes that "sit": a count
 * that reads as the wrong number is the cheapest way to lose a reader's trust
 * in every other number on the page.
 */
function unquotedLine(count: number): string {
  if (count <= 0) return '';
  return ` ${plural(count, 'other logged change')} ${count === 1 ? 'sits' : 'sit'} inside the same ${RECEIPT_WINDOW_DAYS} days.`;
}

/** The shape every refusal takes: what we could not do, and no advice about it. */
function noStory(summary: string, warning: string, data: Record<string, unknown>): PackSection {
  return { summary, data: { signal: false, ...data }, warnings: [warning] };
}

export function computeRootCause(inp: RootCauseInputs): PackSection {
  const anchor = inp.anchorDate ?? null;
  const days = [...inp.days]
    .filter((d) => typeof d.date === 'string' && d.date.length >= 10 && (!anchor || d.date <= anchor))
    .sort((a, b) => a.date.localeCompare(b.date));
  const spendDays = days.filter((d) => d.spend > 0).length;
  const changeLogRead = inp.changes !== null;

  if (spendDays < MIN_ACCOUNT_DAYS) {
    return noStory(
      `This read holds ${plural(spendDays, 'day')} of account spend. Telling the story behind a movement means pinning the day it started, and that needs at least ${MIN_ACCOUNT_DAYS} days of daily history to compare against.`,
      'Too few spending days to pin a start date, so the read is left out rather than guessed at.',
      { days_read: days.length, days_with_spend: spendDays, start_date: null },
    );
  }

  const totalResults = sum(days, (d) => resultOf(d));
  if (totalResults === 0) {
    return noStory(
      `This account spent on ${plural(spendDays, 'day')} in the read and recorded no result on any of them, so there is no cost per result whose movement could be traced.`,
      'No result is recorded anywhere in the window, so there is no cost per result to pin a movement in.',
      { days_read: days.length, days_with_spend: spendDays, start_date: null, results_in_window: 0 },
    );
  }

  const startDate = pinStartDate(days);
  const startIdx = startDate ? days.findIndex((d) => d.date === startDate) : -1;
  const before = startIdx > 0 ? days.slice(Math.max(0, startIdx - HISTORY_DAYS), startIdx) : [];
  const after = startIdx >= 0 ? days.slice(startIdx) : [];
  if (!startDate || before.length < MIN_BEFORE_DAYS || after.length < 1) {
    return noStory(
      `Cost per result never ran ${Math.round((BREAK_RATIO - 1) * 100)}% or more above the week before it in this read, so there is no single movement to tell the story of.`,
      `No day in the read clears the break bar of ${BREAK_RATIO} times the week before it, so no start date is claimed.`,
      { days_read: days.length, days_with_spend: spendDays, start_date: null, break_ratio: BREAK_RATIO },
    );
  }

  const basis = clickBasisOf(days);
  const stages = buildStages(before, after, basis);
  const stageOf = (stage: string): StageRead | undefined => stages.find((s) => s.stage === stage);
  const cpm = stageOf('delivery_cost');
  const ctr = stageOf('interest');
  const lastStage = stageOf('clicks_to_results');
  const movedStages = stages.filter((s) => s.moved);
  const flatStages = stages.filter((s) => !s.moved && s.change !== null);

  const costOver = (rows: RootCauseDayRow[]): number | null => {
    const results = sum(rows, (d) => resultOf(d));
    return results > 0 ? sum(rows, (d) => d.spend) / results : null;
  };
  const costBefore = costOver(before);
  const costAfter = costOver(after);
  const costChange = rel(costBefore, costAfter);
  const spendBefore = sum(before, (d) => d.spend) / before.length;
  const spendAfter = sum(after, (d) => d.spend) / after.length;
  const spendChange = rel(spendBefore, spendAfter);

  // The ledger, within RECEIPT_WINDOW_DAYS either side of the pinned date.
  const startDay = dayNumber(startDate);
  const near = (inp.changes ?? []).filter(
    (c) => typeof c.at === 'string' && Math.abs(dayNumber(c.at) - startDay) <= RECEIPT_WINDOW_DAYS,
  );
  const receipts = [...new Set(near.map((c) => receiptSentence(c, inp.currency)))].slice(0, MAX_RECEIPTS);
  const budgetRaised = near.some((c) => c.kind === 'budget_increased');
  const ledgerEmpty = changeLogRead && near.length === 0;

  const opener = `The biggest move in cost per result starts around ${shortDay(startDate)}.`;
  const costLine =
    costBefore !== null && costAfter !== null && costChange !== null
      ? `Cost per result is ${dirWord(costChange)} since then, ${moneyExact(costBefore, inp.currency)} against ${moneyExact(costAfter, inp.currency)}.`
      : null;

  let signature: RootCauseSignature;
  let read: string;
  let nextStep: string | null;
  let signal = true;

  if (budgetRaised && costChange !== null && costChange >= SCALE_DAMAGE_COST_RISE) {
    signature = 'scale_damage';
    read =
      `The budget moved right there, and cost per result is ${dirWord(costChange)} since, ` +
      `${moneyExact(costBefore!, inp.currency)} against ${moneyExact(costAfter!, inp.currency)}. ` +
      `Asking the auction for more of the same audience is what makes it charge more, so the new spend level is the thing that changed.`;
    nextStep =
      `Give the new spend level 7 full days, then read cost per result over just those days. ` +
      `If it is still above the ${moneyExact(costBefore!, inp.currency)} you were paying before, step the budget back down to where it was.`;
  } else if (
    ctr?.change != null && ctr.change >= MOVE_THRESHOLD &&
    lastStage?.change != null && lastStage.change <= -MOVE_THRESHOLD
  ) {
    signature = 'bad_traffic';
    read =
      `More people click (${ctr.label} ${dirWord(ctr.change)}) and fewer of those clicks become results (${dirWord(lastStage.change)}). ` +
      `The extra traffic is the wrong traffic: something changed who the ads attract, not how many.` +
      (costLine ? ` ${costLine}` : '');
    nextStep =
      `Compare the ads that launched around ${shortDay(startDate)} against the older ones on cost per result, not on clicks. ` +
      `Clicks are the metric that lies here.`;
  } else if (
    lastStage?.change != null && lastStage.change <= -MOVE_THRESHOLD &&
    cpm && !cpm.moved && ctr && !ctr.moved && ledgerEmpty
  ) {
    signature = 'measurement_or_site';
    read =
      `Delivery cost and interest in the ads both held steady, and only the last step moved: ${lastStage.label} is ${dirWord(lastStage.change)}. ` +
      `Nothing was touched on the ads side around that date either. When everything upstream is flat and nobody changed anything, that is as often a measurement change as a real change in what people do.`;
    nextStep = `Check what changed on the site and in the tracking around ${shortDay(startDate)} before changing any ads.`;
  } else if (cpm?.change != null && cpm.change >= MOVE_THRESHOLD) {
    signature = 'auction_squeeze';
    read =
      `The move starts at the top: delivery cost (CPM) is ${dirWord(cpm.change)}, ` +
      `${moneyExact(cpm.before!, inp.currency)} against ${moneyExact(cpm.after!, inp.currency)} per thousand impressions, ` +
      `so every person you reach costs more before anything else in the funnel happens.` +
      (costLine ? ` ${costLine}` : '');
    nextStep =
      `This is an auction and audience story before it is a creative one. Frequency and audience saturation are the first two things to rule out.`;
  } else if (
    spendChange !== null && spendChange >= HEALTHY_SPEND_RISE &&
    costChange !== null && Math.abs(costChange) <= HEALTHY_COST_BAND
  ) {
    signature = 'healthy_scaling';
    signal = false;
    read =
      `It did not last. Daily spend is ${dirWord(spendChange)} since then, ${money(spendBefore, inp.currency)} a day against ${money(spendAfter, inp.currency)} a day, ` +
      `and over the whole stretch cost per result held inside ${Math.round(HEALTHY_COST_BAND * 100)}% of where it was, ` +
      `${moneyExact(costBefore!, inp.currency)} against ${moneyExact(costAfter!, inp.currency)}. That is a scale up that held.`;
    nextStep = null;
  } else if (movedStages.length > 0) {
    signature = 'generic';
    read =
      `${movedStages.map((s) => `${s.label} is ${dirWord(s.change!)}`).join(', ')}` +
      (flatStages.length > 0 ? `, while ${flatStages.map((s) => s.label).join(' and ')} held steady` : '') +
      '.' +
      (costLine ? ` ${costLine}` : '');
    nextStep = `Start at the step that moved: ${movedStages[0]!.label}. The steps that held steady are innocent.`;
  } else {
    return noStory(
      `Cost per result moved around ${shortDay(startDate)}, and no step of the funnel moved with it by ${Math.round(MOVE_THRESHOLD * 100)}% or more. ` +
        `Nothing in delivery, clicks or conversion is far enough out of line to name as the cause.`,
      `No funnel step moved by ${Math.round(MOVE_THRESHOLD * 100)}% or more across the date, so no cause is named.`,
      {
        days_read: days.length,
        days_with_spend: spendDays,
        start_date: startDate,
        stages: stages.map((s) => ({
          stage: s.stage,
          label: s.label,
          change_pct: s.change === null ? null : r1(s.change * 100),
          moved: s.moved,
        })),
      },
    );
  }

  const ledgerLine = !changeLogRead
    ? `We could not read this account's change log, so nothing here says whether anybody touched the ads around that date.`
    : receipts.length > 0
      ? `Around that date, on the ads side: ${receipts.join('; ')}.` + unquotedLine(near.length - receipts.length)
      : `Nothing changed on the ads side around that date: no pauses, no restarts, no budget moves. ` +
        `Worth asking what happened in your own world on ${shortDay(startDate)}: a sale ending, a price change, a site update.`;

  const warnings: string[] = [];
  if (!changeLogRead) {
    warnings.push(
      `This account's change history could not be read, so this story says what moved and never whether somebody moved it.`,
    );
  }
  if (!basis) {
    warnings.push(
      `No click is recorded anywhere in this window, so the two click steps are left out and the read covers delivery cost only.`,
    );
  }

  return {
    summary: `${opener} ${read} ${ledgerLine}`,
    ...(nextStep ? { next_step: nextStep } : {}),
    data: {
      signal,
      signature,
      days_read: days.length,
      days_with_spend: spendDays,
      start_date: startDate,
      before_days: before.length,
      after_days: after.length,
      currency: inp.currency,
      click_basis: basis?.word ?? null,
      cost_per_result_before: costBefore === null ? null : r2(costBefore),
      cost_per_result_after: costAfter === null ? null : r2(costAfter),
      cost_per_result_change_pct: costChange === null ? null : r1(costChange * 100),
      spend_per_day_before: Math.round(spendBefore),
      spend_per_day_after: Math.round(spendAfter),
      spend_per_day_change_pct: spendChange === null ? null : r1(spendChange * 100),
      stages: stages.map((s) => ({
        stage: s.stage,
        label: s.label,
        before: s.before === null ? null : r2(s.before),
        after: s.after === null ? null : r2(s.after),
        change_pct: s.change === null ? null : r1(s.change * 100),
        moved: s.moved,
      })),
      moved_stages: movedStages.length,
      change_log_read: changeLogRead,
      changes_near_date: near.length,
      receipts,
      break_ratio: BREAK_RATIO,
      move_threshold_pct: Math.round(MOVE_THRESHOLD * 100),
      receipt_window_days: RECEIPT_WINDOW_DAYS,
    },
    warnings: warnings.length > 0 ? warnings : undefined,
    derivation:
      `Each day of the ${plural(days.length, 'day')} in this read is one account row: spend, impressions, ` +
      `${basis ? basis.word : 'clicks where the pull carries them'} and results. ` +
      `A day's cost per result is its spend over its results, and a day with no result carries none rather than a zero, which would read as a free day. ` +
      `The start date is the first day whose own ${TRAILING_DAYS} days average at least ${BREAK_RATIO} times the ${HISTORY_DAYS} days before it, scanning the last ${SCAN_DAYS} candidate days. ` +
      `Each step is then summed over the ${plural(before.length, 'day')} before that date and the ${plural(after.length, 'day')} from it: ` +
      `delivery cost is spend over impressions times a thousand` +
      (basis
        ? `, interest is ${basis.word} over impressions, and the last step is results over ${basis.word}. `
        : `. No click is recorded in this window, so the two click steps are left out rather than divided by a zero nobody measured. `) +
      `A step counts as moved at ${Math.round(MOVE_THRESHOLD * 100)}% either way. ` +
      (changeLogRead
        ? `The account's own change log is read within ${RECEIPT_WINDOW_DAYS} days either side of the start date, deduplicated, and at most ${MAX_RECEIPTS} changes are quoted.`
        : `The account's change log could not be read for this account, so no change is claimed either way.`),
  };
}
