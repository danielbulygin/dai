import type { AuditSection } from './magic-audit.js';
import type { AuditWindow } from './audit-window.js';
import { shortDay } from './audit-window.js';

/**
 * The settled summary of the work this audit actually did.
 *
 * `work_log` is the live feed: timestamped lines that appear while the run is
 * cooking. This is the other half, and it is what the page shows once the
 * report is finished, so it is deterministic, compact and ordered by what a
 * reader cares about rather than by when it happened.
 *
 * The hard rule: every row is derived from evidence the run left behind. A
 * skipped walker means no "opened your page" row, and a section that errored
 * contributes nothing. We never claim work we cannot point at.
 *
 * Pure: sections and counts in, rows out. No clock, no network, no logging.
 */

export interface WorkRow {
  /** One line, plain operator language, carrying its own number. */
  line: string;
  /** That number, so the page can render it as a figure beside the line. */
  n: number;
}

export const MAX_WORK_ROWS = 14;

export interface WorkLedgerInputs {
  sections: Record<string, AuditSection>;
  window: AuditWindow;
  /** Distinct ads seen anywhere in the six-month read. */
  adsRead: number;
  /** Distinct days of ad-level history the pull covered. */
  daysRead: number;
  /** Distinct days inside the core window that carry delivery rows. */
  coreDaysCovered: number;
  /** Ads that spent earlier in the six months and nothing in the core window. */
  retiredAdsFound: number;
  /** How many lead insights the ranking published. */
  insightsRanked: number;
  /** How many scorecard dimensions were graded. */
  scorecardDimensions: number;
}

const complete = (s: AuditSection | undefined): boolean => s?.status === 'complete';

const dataOf = (s: AuditSection | undefined): Record<string, unknown> =>
  complete(s) && typeof s!.data === 'object' && s!.data !== null ? (s!.data as Record<string, unknown>) : {};

const countOf = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

const numOf = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * The rows, in reading order. Each candidate states its own condition, so a
 * row is absent exactly when the work behind it did not happen.
 */
export function buildWorkLedger(inp: WorkLedgerInputs): WorkRow[] {
  const s = inp.sections;
  const rows: WorkRow[] = [];
  const push = (n: number, line: string): void => {
    if (n > 0) rows.push({ n, line });
  };

  push(inp.adsRead, `Read ${inp.adsRead} ads across ${inp.daysRead} days of delivery history`);
  push(
    inp.coreDaysCovered,
    inp.window.anchored
      ? `Measured the 30 days ending ${shortDay(inp.window.anchorDate)}, the account's last active month, day by day`
      : `Measured the last 30 days of delivery day by day`,
  );
  push(inp.retiredAdsFound, `Found ${inp.retiredAdsFound} ads that earned earlier and are not running now`);

  const fatigue = dataOf(s['creative_fatigue']);
  push(numOf(fatigue.assessed_ads), `Ran fatigue and runway trends on ${numOf(fatigue.assessed_ads)} ads`);

  const conc = dataOf(s['spend_concentration']);
  push(numOf(conc.ads_with_spend), `Measured how the budget concentrates across ${numOf(conc.ads_with_spend)} ads`);

  const scatter = dataOf(s['budget_scatter']);
  // A lead-gen account has no return, and the chart it is describing has a cost
  // axis. The axis the section actually plotted decides the word.
  const scatterAxis =
    scatter.y_axis === 'cost_per_result' || scatter.kpi_mode === 'cpr'
      ? `cost per ${typeof scatter.result_noun === 'string' && scatter.result_noun.length > 0 ? scatter.result_noun : 'result'}`
      : 'return';
  push(numOf(scatter.ads_plotted), `Plotted spend against ${scatterAxis} for ${numOf(scatter.ads_plotted)} ads`);

  const creative = dataOf(s['creative_analysis']);
  push(numOf(creative.creatives_analyzed), `Watched ${numOf(creative.creatives_analyzed)} creatives frame by frame`);
  const copyRead = countOf(creative.media_resolution);
  if (numOf(creative.creatives_analyzed) === 0) push(copyRead, `Read the copy on ${copyRead} top-spending ads`);

  const cohorts = dataOf(s['creative_cohorts']);
  push(numOf(cohorts.window_months), `Rebuilt ${numOf(cohorts.window_months)} months of creative launch cohorts`);

  const trends = dataOf(s['cost_trends']);
  push(countOf(trends.series), `Read ${countOf(trends.series)} weeks of auction cost history`);

  const landing = dataOf(s['landing_pages']);
  push(countOf(landing.dead_checks), `Fetched ${countOf(landing.dead_checks)} landing destinations to see if they load`);

  const walk = dataOf(s['message_match']);
  const page = walk.page as { url?: unknown } | undefined;
  if (typeof page?.url === 'string' && page.url.length > 0) {
    rows.push({ n: 1, line: 'Opened your landing page and read what it promises' });
  }

  const activity = dataOf(s['account_activity']);
  push(numOf(activity.total_window), `Read ${numOf(activity.total_window)} logged changes to the account`);

  // The story's row is the pinned date, so a read that could not pin one
  // contributes nothing: the ledger never claims work it cannot point at.
  const rootCause = dataOf(s['root_cause']);
  if (typeof rootCause.start_date === 'string' && rootCause.start_date.length > 0) {
    push(
      numOf(rootCause.days_read),
      `Pinned the day the biggest cost movement started across ${numOf(rootCause.days_read)} days and read which funnel step moved with it`,
    );
  }

  const facts = dataOf(s['account_facts']);
  push(countOf(facts.facts), `Pulled ${countOf(facts.facts)} facts about the account's own texture`);

  const checksRun = Object.values(s).filter((sec) => sec.status === 'complete').length;
  push(checksRun, `Ran ${checksRun} checks over the account end to end`);
  push(inp.scorecardDimensions, `Graded ${inp.scorecardDimensions} dimensions against the accounts on our desk`);
  push(inp.insightsRanked, `Ranked everything found and kept the ${inp.insightsRanked} that matter most`);

  return rows.slice(0, MAX_WORK_ROWS);
}
