/**
 * The audit's reading window, anchored to the account's own last spending day.
 *
 * Every "30d" verdict in the report used to end on the calendar day the audit
 * ran. That is right for an account spending today and wrong for every other
 * one: a connected account that stopped in July read as an account with no
 * ads, no winners, no concentration and no funnel, which is a report about our
 * calendar rather than about their business.
 *
 * So the window ENDS on the newest day the account actually spent money, and
 * the 30/90-day reads count back from there. An account that spent yesterday is
 * unaffected (the grace window), which is the point: a weekend lull must not
 * churn a live account's numbers.
 *
 * The six-month read stays on the calendar. It exists to place creative in
 * time ("this ad first went live in March"), and sliding it back with the
 * anchor would say an account has newer creative than it does.
 *
 * Pure: dates in, dates and words out. No clock, no network, no logging.
 */

/** The six-month read, in days. The one number the pull and the filter share. */
export const SIX_MONTH_DAYS = 183;

/** How stale the last spending day may be before the window anchors to it. */
export const ANCHOR_GRACE_DAYS = 3;

export interface AuditWindow {
  /** The calendar day the audit ran (YYYY-MM-DD, UTC). */
  asOf: string;
  /** Newest day the ACCOUNT spent money, or null when it never did. */
  lastSpendDate: string | null;
  /** The day every 30-day and 90-day figure in this report ends on. */
  anchorDate: string;
  /** True when the anchor is NOT today, i.e. the account is dormant. */
  anchored: boolean;
  /** Whole days between the last spending day and today, or null. */
  daysSinceLastSpend: number | null;
  /** First day of the core (30-day) window. */
  coreStart: string;
  /** First day of the 90-day window. */
  ninetyStart: string;
  /** First day of the six-month window. Calendar-anchored on purpose. */
  sixMonthStart: string;
}

const parseDay = (iso: string): number => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

const shiftDays = (iso: string, days: number): string => {
  const d = new Date(parseDay(iso));
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

const wholeDaysBetween = (from: string, to: string): number =>
  Math.round((parseDay(to) - parseDay(from)) / 86_400_000);

/**
 * The newest day the account put money into the auction. Account level on
 * purpose: one ad's last day is that ad's story, and the report's window is
 * the account's.
 */
export function lastSpendDateOf(
  rows: Array<{ date?: string | null; spend?: number | null }>,
): string | null {
  let latest: string | null = null;
  for (const r of rows) {
    if (!r.date || !(Number(r.spend) > 0)) continue;
    const d = String(r.date).slice(0, 10);
    if (latest === null || d > latest) latest = d;
  }
  return latest;
}

export function resolveAuditWindow(args: {
  asOf: string;
  lastSpendDate: string | null;
  graceDays?: number;
}): AuditWindow {
  const asOf = args.asOf.slice(0, 10);
  const grace = args.graceDays ?? ANCHOR_GRACE_DAYS;
  const lastSpendDate = args.lastSpendDate ? args.lastSpendDate.slice(0, 10) : null;
  const daysSinceLastSpend = lastSpendDate ? wholeDaysBetween(lastSpendDate, asOf) : null;
  // A last spending day inside the grace window (or somehow ahead of us) reads
  // exactly as it did before this existed.
  const anchored =
    lastSpendDate != null && daysSinceLastSpend != null && daysSinceLastSpend > grace;
  const anchorDate = anchored ? lastSpendDate! : asOf;
  return {
    asOf,
    lastSpendDate,
    anchorDate,
    anchored,
    daysSinceLastSpend,
    coreStart: shiftDays(anchorDate, 30),
    ninetyStart: shiftDays(anchorDate, 90),
    sixMonthStart: shiftDays(asOf, SIX_MONTH_DAYS),
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-07-20" → "20 Jul". The date form every window sentence uses. */
export function shortDay(iso: string): string {
  const d = new Date(parseDay(iso));
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/**
 * The one sentence the page states at the top when the window is anchored. It
 * has to name the date, because "the last 30 days" and "the 30 days ending
 * 20 Jul" are different claims and only one of them is true here.
 */
export function anchoredWindowNote(w: AuditWindow): string | null {
  if (!w.anchored || !w.lastSpendDate) return null;
  return (
    `This account last spent on ${shortDay(w.lastSpendDate)}. ` +
    'Every 30-day figure reads the 30 days ending there, not the calendar month just gone.'
  );
}

/**
 * The rule the synthesis gets, in the system prompt, so no section writes "in
 * the last 30 days" about a window that ended weeks ago. Null when the window
 * is today's, in which case the prompt is byte-identical to before.
 */
export function anchoredWindowBrief(w: AuditWindow): string | null {
  if (!w.anchored || !w.lastSpendDate) return null;
  const label = shortDay(w.anchorDate);
  return (
    `ANCHORED WINDOW (this account is not spending today): its last spending day was ${label}` +
    `${w.daysSinceLastSpend != null ? `, ${w.daysSinceLastSpend} days ago` : ''}. ` +
    'Every 30-day and 90-day figure you are given reads the window ENDING on that day. ' +
    `Wherever the facts or these instructions say "the last 30 days" or "the last 90 days", they mean ` +
    `"the 30 days ending ${label}" and "the 90 days ending ${label}". ` +
    `Never write "the last 30 days", "the past month", "currently", "right now" or "today" about these numbers. ` +
    `Write "the 30 days ending ${label}" or "the account's last 30 active days" instead. ` +
    `Where it matters to the reader, say plainly that the account has not spent since ${label}.`
  );
}

/**
 * Rewrite the calendar phrasing into the anchored phrasing inside a finished
 * string. Deterministic, idempotent, and a no-op when nothing is anchored, so
 * a live account's report comes out byte-identical.
 *
 * Only the two ACCOUNT windows are rewritten (30 and 90). An ad's own "last 14
 * days" is measured from its own last delivery day and is already anchored.
 */
export function anchorWindowWords(text: string, w: AuditWindow): string {
  if (!w.anchored || typeof text !== 'string' || text.length === 0) return text;
  const label = shortDay(w.anchorDate);
  return (
    text
      // "the last 30 days' spend" → "the spend in the 30 days ending 20 Jul"
      .replace(
        /\bthe last (30|90) days'\s+([A-Za-z]+)/g,
        (_m, days: string, noun: string) => `the ${noun} in the ${days} days ending ${label}`,
      )
      .replace(
        /\bthe last (30|90) days\b/g,
        (_m, days: string) => `the ${days} days ending ${label}`,
      )
  );
}
