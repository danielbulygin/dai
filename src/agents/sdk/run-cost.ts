/**
 * What ONE runAgentSDK run cost, from the SDK's `total_cost_usd`.
 *
 * When a query resumes a Claude session, `total_cost_usd` on its result is the
 * running total for that whole session, not this run. Reporting it as the run's
 * cost made the portal's monthly chat budget sum running totals: a 49-message
 * conversation that cost $35.49 was metered as $1,008.40 and hit the $1,000 cap
 * (2026-09-27).
 *
 * The baseline is `sessions.total_cost`, which holds the SDK running total for
 * `sessions.claude_session_id` as of the last run (runAgentSDK writes it after
 * every run). The result says what it measures:
 *
 * - `turn`: this run alone — a fresh Claude session, a resume that came back
 *   as a different session, or a resume with a known baseline.
 * - `session_total`: the baseline is unknown (a session resumed before this
 *   column was written), so the number IS the running total and the consumer
 *   must take the difference itself. The portal does exactly that when it sees
 *   `cost_scope: "session_total"`, so an old conversation is never charged its
 *   whole history once more on the first run after this ships.
 */
export type RunCostScope = 'turn' | 'session_total';

export interface RunCost {
  costUsd: number;
  scope: RunCostScope;
}

export function runCost(input: {
  /** `total_cost_usd` from the SDK result. */
  sdkTotalUsd: number;
  /** The Claude session this run asked to resume, if any. */
  resumedClaudeSessionId: string | null;
  /** The Claude session the result reports. */
  resultClaudeSessionId: string | null;
  /** `sessions.total_cost`: the running total after the previous run. */
  baselineUsd: number;
}): RunCost {
  const sdkTotalUsd = Number.isFinite(input.sdkTotalUsd) ? input.sdkTotalUsd : 0;
  const baselineUsd = Number.isFinite(input.baselineUsd) ? input.baselineUsd : 0;

  const resumedSameSession =
    input.resumedClaudeSessionId !== null &&
    (input.resultClaudeSessionId === null ||
      input.resultClaudeSessionId === input.resumedClaudeSessionId);
  if (!resumedSameSession) return { costUsd: sdkTotalUsd, scope: 'turn' };

  if (baselineUsd <= 0) return { costUsd: sdkTotalUsd, scope: 'session_total' };

  // A running total cannot fall within one session; if it did, the session was
  // not the one the baseline describes, so the whole total is this run's.
  if (sdkTotalUsd < baselineUsd) return { costUsd: sdkTotalUsd, scope: 'turn' };
  return { costUsd: sdkTotalUsd - baselineUsd, scope: 'turn' };
}
