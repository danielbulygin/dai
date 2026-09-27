import { describe, it, expect } from 'vitest';
import { runCost } from '../src/agents/sdk/run-cost.js';

/**
 * Regression, 2026-09-27. runAgentSDK resumes the Claude session and used to
 * report the result's `total_cost_usd` — the session's RUNNING total — as the
 * run's cost. The portal summed those, so a 49-message conversation that cost
 * $35.49 was metered as $1,008.40 and locked the workspace out at its $1,000
 * monthly cap. runCost reports one run's cost and says what the number measures.
 */

/** The first running totals that conversation actually reported. */
const RUNNING_TOTALS = [1.17605425, 1.554417, 2.70500625, 3.5821985, 4.9767655];

describe('runCost', () => {
  it('reports each run of a resumed conversation as its own cost, summing to the last total', () => {
    let baselineUsd = 0;
    let claudeSessionId: string | null = null;
    const reported = RUNNING_TOTALS.map((sdkTotalUsd) => {
      const cost = runCost({
        sdkTotalUsd,
        resumedClaudeSessionId: claudeSessionId,
        resultClaudeSessionId: 'claude-1',
        baselineUsd,
      });
      // What runAgentSDK persists after the run.
      claudeSessionId = 'claude-1';
      baselineUsd = sdkTotalUsd;
      return cost;
    });

    expect(reported.every((cost) => cost.scope === 'turn')).toBe(true);
    const total = reported.reduce((sum, cost) => sum + cost.costUsd, 0);
    expect(total).toBeCloseTo(4.9767655, 8);
    expect(reported[1].costUsd).toBeCloseTo(1.554417 - 1.17605425, 8);
  });

  it('reports a fresh session whole, as this run', () => {
    expect(
      runCost({ sdkTotalUsd: 1.18, resumedClaudeSessionId: null, resultClaudeSessionId: 'claude-1', baselineUsd: 0 }),
    ).toEqual({ costUsd: 1.18, scope: 'turn' });
  });

  it('reports a resume that came back as another session whole, as this run', () => {
    expect(
      runCost({ sdkTotalUsd: 0.4, resumedClaudeSessionId: 'claude-old', resultClaudeSessionId: 'claude-new', baselineUsd: 12 }),
    ).toEqual({ costUsd: 0.4, scope: 'turn' });
  });

  // A session resumed before sessions.total_cost was written has no baseline.
  // Subtracting nothing would charge its whole history once more, so the number
  // goes out labelled as a running total and the portal takes the difference.
  it('labels a resumed session with no known baseline as a running total', () => {
    expect(
      runCost({ sdkTotalUsd: 35.49, resumedClaudeSessionId: 'claude-1', resultClaudeSessionId: 'claude-1', baselineUsd: 0 }),
    ).toEqual({ costUsd: 35.49, scope: 'session_total' });
  });

  it('reports a total below the baseline whole, since it cannot be the same session', () => {
    expect(
      runCost({ sdkTotalUsd: 0.7, resumedClaudeSessionId: 'claude-1', resultClaudeSessionId: 'claude-1', baselineUsd: 5 }),
    ).toEqual({ costUsd: 0.7, scope: 'turn' });
  });

  it('treats a result with no session id as the session it resumed', () => {
    const cost = runCost({ sdkTotalUsd: 3, resumedClaudeSessionId: 'claude-1', resultClaudeSessionId: null, baselineUsd: 2 });
    expect(cost).toEqual({ costUsd: 1, scope: 'turn' });
  });

  it('never reports a non-finite cost', () => {
    const cost = runCost({ sdkTotalUsd: Number.NaN, resumedClaudeSessionId: null, resultClaudeSessionId: null, baselineUsd: Number.NaN });
    expect(cost).toEqual({ costUsd: 0, scope: 'turn' });
  });
});
