/**
 * The failure organ — read side (Ada 2.0 Phase 1).
 *
 * When a write hits a wall (observe-after now surfaces it as a real error), the
 * loop should "look itself up first": is this a failure we've already seen and
 * documented? If so, apply the documented fix and retry (the cheap, safe fast
 * path). If not, reason from scratch — and write the new row (§4.5).
 *
 * `matchDeadEnd` is the pure, deterministic matcher over `ada_dead_ends` rows.
 * It keys on DISTINCTIVE tokens — Meta error subcodes (e.g. 2446814) and
 * ALL-CAPS identifiers (OUTCOME_SALES, LEAD, INITIATED_CHECKOUT) — because those
 * are the parts of an error string that actually identify the failure class;
 * free prose around them is noise. The row with the most shared distinctive
 * tokens wins; dismissed rows and empty-signal rows are skipped. Pure so it
 * unit-tests in isolation; the thin Supabase fetch wraps it.
 */

/** A row from the ada_dead_ends KB (subset relevant to matching + applying). */
export interface DeadEndRow {
  id?: string;
  kind: string; // error | timeout | blocked | capability_gap | tool_error | unknown
  signal: string | null; // the error phrase/string that flags this failure class
  resolution?: string | null; // the documented fix to apply
  status?: string | null; // open | diagnosing | building | fixed | dismissed
  client_code?: string | null;
}

export interface DeadEndMatch {
  row: DeadEndRow;
  /** The distinctive tokens that matched — for the audit log / decision card. */
  matchedOn: string[];
  reason: string;
}

/**
 * Distinctive tokens in an error/signal string: numeric codes (≥4 digits, e.g.
 * Meta subcodes) and ALL-CAPS identifiers (OUTCOME_SALES, LEAD). Lowercased for
 * comparison. Free prose / mixed-case words (SafetyError, "rejected") are
 * deliberately ignored — they don't identify a failure class.
 */
export function distinctiveTokens(s: string): Set<string> {
  const caps = s.match(/[A-Z][A-Z0-9_]{3,}/g) ?? [];
  const nums = s.match(/\d{4,}/g) ?? [];
  return new Set([...caps, ...nums].map((t) => t.toLowerCase()));
}

function isApplicable(row: DeadEndRow): boolean {
  return (row.status ?? 'open').toLowerCase() !== 'dismissed';
}

/**
 * Find the best applicable dead-end match for an error string, or null.
 * The match must share at least one distinctive token with the row's signal.
 */
export function matchDeadEnd(errorText: string, rows: DeadEndRow[]): DeadEndMatch | null {
  if (!errorText) return null;
  const eTok = distinctiveTokens(errorText);
  if (eTok.size === 0) return null; // nothing distinctive to key on

  let best: DeadEndRow | null = null;
  let bestShared: string[] = [];
  for (const row of rows) {
    if (!isApplicable(row) || !(row.signal ?? '').trim()) continue;
    const shared = [...distinctiveTokens(row.signal!)].filter((t) => eTok.has(t));
    if (shared.length > bestShared.length) {
      best = row;
      bestShared = shared;
    }
  }
  if (!best || bestShared.length === 0) return null;
  return { row: best, matchedOn: bestShared, reason: `matched on ${bestShared.join(', ')}` };
}
