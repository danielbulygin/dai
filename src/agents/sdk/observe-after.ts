/**
 * Observe-after (Ada 2.0 Phase 1) — the structural fix for "streams success on a
 * dead-end."
 *
 * Most dai tools report failure by RETURNING `{"error": …}` JSON (or a batch
 * `summary.failed > 0`) instead of throwing, so the agent can read the details.
 * `detectSoftError` is the registry-wide convention for spotting that. The
 * audit log already uses it. The problem the loop has is the NEXT step: today a
 * detected soft-failure still reaches the model as a *non-error* tool result
 * (isError=false), so a failed WRITE — a `launch_ads` 500 / Meta SafetyError —
 * gets narrated as "done." That is the blindness.
 *
 * `surfaceWriteFailure` is the fix: for a WRITE that hit a wall, flip the result
 * to isError=true while keeping the full error JSON as the content. The model
 * then both SEES the details (to look the dead-end up and recover) AND knows the
 * write failed (so it cannot claim success). READ tools are untouched — an
 * `{error}` in a read is data the model reasons about, not a failed action.
 *
 * Scoped to the Meta write mutations for the JVA wedge; widen to the full write
 * set later (invariant #2: nothing returns success without the loop observing
 * the real result). Pure + dependency-free, so it unit-tests in isolation.
 */

/**
 * Detect the registry-wide soft-failure convention in a tool's string result: a
 * JSON object with a truthy top-level `error`, or a `summary.failed` count above
 * zero (batch tools like upload_to_media_library). Returns the error string for
 * the audit log, or undefined when the result looks healthy. Deliberately
 * conservative: anything unparseable counts as healthy.
 */
export function detectSoftError(result: string): string | undefined {
  if (!result || result[0] !== '{') return undefined;
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (typeof parsed.error === 'string' && parsed.error.length > 0) {
      return parsed.error;
    }
    const summary = parsed.summary as Record<string, unknown> | undefined;
    if (summary && typeof summary.failed === 'number' && summary.failed > 0) {
      return `summary.failed=${summary.failed} of ${summary.total ?? '?'}`;
    }
  } catch {
    // Not JSON — plain-text results are never soft failures.
  }
  return undefined;
}

/**
 * Write tools whose soft-failures must surface to the model as errors. Scoped to
 * the Meta write mutations for the JVA wedge (where a silent 500 is the danger).
 * Widen toward the guard's full PRODUCTION_WRITES set once proven.
 */
export const OBSERVE_AFTER_WRITE_TOOLS = new Set<string>([
  'launch_ads', 'upload_to_media_library', 'set_adset_marker', 'pause_launch',
]);

/** True if this tool's result must reach the model as a failure (isError=true). */
export function surfaceWriteFailure(bareName: string, result: string, isError: boolean): boolean {
  if (isError) return true; // a thrown error is already a failure
  if (!OBSERVE_AFTER_WRITE_TOOLS.has(bareName)) return isError; // reads/other tools unchanged
  return detectSoftError(result) !== undefined;
}
