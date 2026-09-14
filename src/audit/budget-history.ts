import type { PackSection } from './report-pack.js';
import type { ChangeReceipt } from './root-cause.js';

const DAY = 86_400_000;
const LARGE_MOVE_PCT = 20;
const round = (value: number) => Math.round(value * 10) / 10;
const RESET_LIMIT = 'Budget edits can disrupt delivery and learning. This history does not include recorded learning-state transitions, so it cannot confirm or count learning resets or prove that the edits caused a performance decline.';

interface BudgetEdit {
  at: string;
  from_budget: number;
  to_budget: number;
  change_pct: number | null;
  substantial: boolean;
}

interface BudgetEntity {
  object_id: string;
  object_name: string | null;
  object_type: string | null;
  edits: number;
  edits_30d: number;
  substantial_edits: number;
  substantial_edits_30d: number;
  edit_days: number;
  direction_reversals_within_48h: number;
  shortest_gap_hours: number | null;
  repeated_substantial_edits: boolean;
  repeated_substantial_edits_30d: boolean;
  peak_7d: { since: string; until: string; edits: number; substantial_edits: number };
  peak_7d_examples: BudgetEdit[];
  recent_peak_7d: { since: string; until: string; edits: number; substantial_edits: number } | null;
  recent_peak_7d_examples: BudgetEdit[];
  recent_examples: BudgetEdit[];
}

export interface BudgetHistoryInput {
  changes: readonly ChangeReceipt[] | null;
  asOf: string;
  windowDays: number;
  currency: string;
  partial: boolean;
}

/** Recurrence is an analysis rule, never a claim about Meta's reset threshold. */
export function computeBudgetHistory(input: BudgetHistoryInput): PackSection {
  const end = Date.parse(`${input.asOf}T00:00:00Z`) + DAY;
  const start = end - input.windowDays * DAY;
  const recentStart = end - 30 * DAY;
  const basis = {
    window_days: input.windowDays,
    since: new Date(start).toISOString().slice(0, 10),
    until: input.asOf,
    currency: input.currency,
    substantial_change_analysis_threshold_pct: LARGE_MOVE_PCT,
    recurrence_rule: 'At least 3 budget edits, including at least 2 moves of 20% or more, on the same object within 7 days. This is an audit screening rule, not a Meta learning-reset rule.',
    learning_resets_confirmed: null,
    learning_state_history_available: false,
  };
  if (input.changes === null) {
    return {
      summary: 'Budget change history could not be read. Learning disruption from repeated edits could not be assessed.',
      data: { ...basis, available: false, partial: true, signal: false },
      warnings: [RESET_LIMIT],
    };
  }

  const groups = new Map<string, { receipt: ChangeReceipt; edits: BudgetEdit[] }>();
  const seen = new Set<string>();
  let unreadable = 0;
  for (const change of input.changes) {
    if (!['budget_increased', 'budget_decreased', 'budget_changed'].includes(change.kind)) continue;
    const at = Date.parse(change.at);
    if (!Number.isFinite(at)) { unreadable += 1; continue; }
    if (at < start || at >= end) continue;
    const from = change.fromBudget;
    const to = change.toBudget;
    if (!change.objectId || from == null || to == null || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < 0) {
      unreadable += 1;
      continue;
    }
    if (from === to) continue;
    const key = `${change.objectId}|${at}|${from}|${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const percent = from > 0 ? ((to - from) / from) * 100 : null;
    const group = groups.get(change.objectId) ?? { receipt: change, edits: [] };
    group.edits.push({
      at: new Date(at).toISOString(), from_budget: from, to_budget: to,
      change_pct: percent === null ? null : round(percent),
      substantial: percent !== null && Math.abs(percent) >= LARGE_MOVE_PCT - 1e-8,
    });
    groups.set(change.objectId, group);
  }

  const entities: BudgetEntity[] = [];
  for (const [id, group] of groups) {
    const edits = group.edits.sort((a, b) => a.at.localeCompare(b.at));
    let reversals = 0;
    let shortestGap: number | null = null;
    let recurring = false;
    let recurringRecent = false;
    let peakStart = 0;
    let peakEnd = 0;
    let peakLarge = -1;
    let recentPeakStart = 0;
    let recentPeakEnd = -1;
    let recentPeakLarge = -1;
    const largePrefix = [0];
    for (const edit of edits) largePrefix.push(largePrefix[largePrefix.length - 1]! + Number(edit.substantial));
    const firstRecent = edits.findIndex((edit) => Date.parse(edit.at) >= recentStart);
    let left = 0;
    for (let i = 0; i < edits.length; i += 1) {
      const edit = edits[i]!;
      const previous = edits[i - 1];
      if (previous) {
        const gap = (Date.parse(edit.at) - Date.parse(previous.at)) / 3_600_000;
        shortestGap = shortestGap === null ? gap : Math.min(shortestGap, gap);
        if (gap <= 48 && Math.sign(edit.to_budget - edit.from_budget) !== Math.sign(previous.to_budget - previous.from_budget)) reversals += 1;
      }
      while (Date.parse(edit.at) - Date.parse(edits[left]!.at) >= 7 * DAY) left += 1;
      const count = i - left + 1;
      const large = largePrefix[i + 1]! - largePrefix[left]!;
      if (large > peakLarge || (large === peakLarge && count >= peakEnd - peakStart + 1)) {
        peakStart = left;
        peakEnd = i;
        peakLarge = large;
      }
      if (count >= 3 && large >= 2) recurring = true;
      if (firstRecent >= 0 && i >= firstRecent) {
        const recentLeft = Math.max(left, firstRecent);
        const recentCount = i - recentLeft + 1;
        const recentLarge = largePrefix[i + 1]! - largePrefix[recentLeft]!;
        if (recentCount >= 3 && recentLarge >= 2) recurringRecent = true;
        if (recentLarge > recentPeakLarge || (recentLarge === recentPeakLarge && recentCount >= recentPeakEnd - recentPeakStart + 1)) {
          recentPeakStart = recentLeft;
          recentPeakEnd = i;
          recentPeakLarge = recentLarge;
        }
      }
    }
    const peak = edits.slice(peakStart, peakEnd + 1);
    const recentPeak = recentPeakEnd < 0 ? [] : edits.slice(recentPeakStart, recentPeakEnd + 1);
    const recent = edits.filter((edit) => Date.parse(edit.at) >= recentStart);
    entities.push({
      object_id: id, object_name: group.receipt.objectName, object_type: group.receipt.objectType,
      edits: edits.length, edits_30d: recent.length,
      substantial_edits: edits.filter((edit) => edit.substantial).length,
      substantial_edits_30d: recent.filter((edit) => edit.substantial).length,
      edit_days: new Set(edits.map((edit) => edit.at.slice(0, 10))).size,
      direction_reversals_within_48h: reversals,
      shortest_gap_hours: shortestGap === null ? null : round(shortestGap),
      repeated_substantial_edits: recurring, repeated_substantial_edits_30d: recurringRecent,
      peak_7d: { since: peak[0]!.at, until: peak[peak.length - 1]!.at, edits: peak.length, substantial_edits: peakLarge },
      peak_7d_examples: peak.filter((edit) => edit.substantial).slice(-6),
      recent_peak_7d: recentPeak.length ? { since: recentPeak[0]!.at, until: recentPeak[recentPeak.length - 1]!.at, edits: recentPeak.length, substantial_edits: recentPeakLarge } : null,
      recent_peak_7d_examples: recentPeak.filter((edit) => edit.substantial).slice(-6),
      recent_examples: edits.slice(-6),
    });
  }
  entities.sort((a, b) => Number(b.repeated_substantial_edits_30d) - Number(a.repeated_substantial_edits_30d) ||
    Number(b.repeated_substantial_edits) - Number(a.repeated_substantial_edits) ||
    (b.recent_peak_7d?.substantial_edits ?? 0) - (a.recent_peak_7d?.substantial_edits ?? 0) ||
    b.peak_7d.substantial_edits - a.peak_7d.substantial_edits || b.edits - a.edits);
  const total = entities.reduce((sum, entity) => sum + entity.edits, 0);
  const recentTotal = entities.reduce((sum, entity) => sum + entity.edits_30d, 0);
  const largeTotal = entities.reduce((sum, entity) => sum + entity.substantial_edits, 0);
  const flagged = entities.filter((entity) => entity.repeated_substantial_edits);
  const flaggedRecent = entities.filter((entity) => entity.repeated_substantial_edits_30d);
  const partial = input.partial || unreadable > 0;
  const top = flagged[0];
  const topWindow = top?.repeated_substantial_edits_30d ? top.recent_peak_7d! : top?.peak_7d;
  const countSummary = `${partial ? 'At least ' : ''}${total} budget edits were recorded across ${entities.length} campaign or ad-set objects in the ${input.windowDays}-day history ending ${input.asOf}; ${recentTotal} were in the last 30 days. ${largeTotal} moves were at least ${LARGE_MOVE_PCT}% of the previous budget.`;
  const patternSummary = top && topWindow
    ? `${flagged.length} objects had repeated substantial edits within a 7-day period, including ${flaggedRecent.length} in the last 30 days. "${top.object_name ?? top.object_id}" had ${topWindow.edits} edits from ${topWindow.since.slice(0, 10)} to ${topWindow.until.slice(0, 10)}, including ${topWindow.substantial_edits} moves of at least ${LARGE_MOVE_PCT}%. Repeated changes are a delivery-stability and learning-disruption risk.`
    : partial
      ? 'The retrieved edits did not meet the recurrence rule; missing history prevents a clean conclusion.'
      : 'The retrieved history did not meet the repeated-substantial-edit screening rule. This does not establish whether learning resets occurred.';
  return {
    summary: `${countSummary} ${patternSummary}`.trim(),
    ...(flagged.length ? {
      next_step: 'Review the dated budget changes with the account operator. For ad sets still running, agree on a budget and a review window, avoid repeated increases and cuts inside that window, and check Meta learning status and comparable results before the next edit. Do not consolidate solely from a low weekly event average without checking this change history.',
    } : {}),
    data: {
      ...basis, available: true, partial, unreadable_changes: unreadable, signal: flagged.length > 0,
      total_edits: total, total_edits_30d: recentTotal, substantial_edits: largeTotal,
      objects_with_edits: entities.length, objects_with_repeated_substantial_edits: flagged.length,
      objects_with_repeated_substantial_edits_30d: flaggedRecent.length,
      direction_reversals_within_48h: entities.reduce((sum, entity) => sum + entity.direction_reversals_within_48h, 0),
      entities: entities.slice(0, 10),
    },
    warnings: [RESET_LIMIT, ...(partial ? ['Budget history is incomplete. Counts are minimum observed counts; an empty or quiet portion is not evidence that no changes occurred.'] : [])],
    derivation: 'Read budget-category activity separately from the general status log. Decode both budget amounts, deduplicate dated receipts, and group by provider object ID. Measure percentage moves against the previous positive budget, rolling 7-day recurrence and direction reversals within 48 hours. A move from zero has no defined percentage and is counted as an edit only. Display the top 10 objects; totals include all readable objects. Actor identity and learning-state transitions are unavailable.',
  };
}

export function withBudgetHistory(section: PackSection, history: PackSection): PackSection {
  const signal = history.data.signal === true;
  const missingGeneralEvents = section.data.no_activity === true && Number(history.data.total_edits ?? 0) > 0;
  return {
    ...section,
    summary: missingGeneralEvents ? history.summary : signal ? `${history.summary} ${section.summary}` : section.summary,
    ...(signal || missingGeneralEvents ? { next_step: history.next_step } : {}),
    data: { ...section.data, ...(missingGeneralEvents ? { no_activity: false, general_activity_partial: true } : {}), signal: signal || section.data.signal === true, budget_history: history.data },
    warnings: [...(section.warnings ?? []), ...(!history.data.available ? [history.summary] : []), ...(history.warnings ?? [])],
    derivation: [section.derivation, history.derivation].filter(Boolean).join(' '),
  };
}
