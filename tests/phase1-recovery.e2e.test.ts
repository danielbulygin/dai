import { describe, it, expect } from 'vitest';
import { surfaceWriteFailure } from '../src/agents/sdk/observe-after.js';
import { matchDeadEnd, type DeadEndRow } from '../src/agents/sdk/dead-end-match.js';
import { govern } from '../src/agents/sdk/governor.js';

/**
 * Phase 1 wedge — the JVA OUTCOME_SALES dead-end through the loop, end-to-end,
 * DETERMINISTICALLY (no live Meta). This is the proof of the whole thesis: the
 * loop OBSERVES the real failure, looks itself up in the failure organ, applies
 * the documented fix under the Governor, retries, and never streams a false
 * success. It composes the four pure pieces shipped in Phase 1:
 *   observe-after (surfaceWriteFailure) · failure organ (matchDeadEnd) · Governor
 *   (govern) · [the resolver fix is exercised in the Python suite].
 */

// The JVA dead-end as it lives in the ada_dead_ends KB.
const KB: DeadEndRow[] = [
  {
    id: 'jva-outcome-sales',
    kind: 'tool_error',
    signal: 'OUTCOME_SALES launch rejected — LEAD invalid on a sales campaign (Meta error_subcode 2446814)',
    resolution: 'Mini-course on an OUTCOME_SALES bank optimizes for INITIATED_CHECKOUT, not LEAD. Relaunch with channel=minicourse (channel_resolver auto-detects /mini-course).',
    status: 'open',
  },
];

// What /api/ada/launch returns on the dead-end (the soft-failure convention).
const FAILED_LAUNCH = JSON.stringify({
  error: 'SafetyError: Meta rejected a LEAD event on an OUTCOME_SALES campaign (error_subcode 2446814). HTTP 500.',
});
// What the relaunch returns after the fix (channel=minicourse → INITIATED_CHECKOUT).
const HEALTHY_RELAUNCH = JSON.stringify({ batch_id: 'b_jva_1', status: 'launched', ads: 12, channel: 'minicourse' });

describe('Phase 1 e2e — JVA dead-end recovers through the loop', () => {
  it('observes the failure → matches the KB → governs a retry → succeeds, never a false success', () => {
    // 1. The first launch fails. OBSERVE-AFTER: the loop SEES it as a failure,
    //    not a narratable success. (This is the bug we fixed.)
    const sawFailure = surfaceWriteFailure('launch_ads', FAILED_LAUNCH, false);
    expect(sawFailure).toBe(true);

    // 2. FAILURE ORGAN: the loop looks itself up before re-deciding.
    const match = matchDeadEnd(
      JSON.parse(FAILED_LAUNCH).error as string,
      KB,
    );
    expect(match).not.toBeNull();
    expect(match!.row.id).toBe('jva-outcome-sales');
    // The documented fix tells the loop what to do.
    expect(match!.row.resolution).toContain('channel=minicourse');
    expect(match!.row.resolution).toContain('INITIATED_CHECKOUT');

    // 3. GOVERNOR: the retry is a reversible, low-blast write and the fix is
    //    documented (high confidence) → auto-heal (Ada just does it, shows the
    //    receipt). Crucially it is NOT 'blocked' and NOT 'options'.
    const verdict = govern({ toolName: 'launch_ads', confidence: 0.9 });
    expect(verdict.tier).toBe('auto-heal');
    expect(verdict.reversibility).toBe('cheap-undo');

    // 4. The relaunch (channel=minicourse) succeeds — and observe-after confirms
    //    the recovery is REAL (no false success on the retry either).
    const retryFailed = surfaceWriteFailure('launch_ads', HEALTHY_RELAUNCH, false);
    expect(retryFailed).toBe(false);
  });

  it('an UNKNOWN failure is still observed (never a false success) and has no documented fix → honest stop', () => {
    const unknownFail = JSON.stringify({ error: 'Meta API rate limit hit (code 80004), please retry later.' });
    // Observe-after still flags it — the loop cannot pretend it worked.
    expect(surfaceWriteFailure('launch_ads', unknownFail, false)).toBe(true);
    // No KB match → the loop must reason from scratch / stop honestly, not auto-apply a wrong fix.
    expect(matchDeadEnd(JSON.parse(unknownFail).error as string, KB)).toBeNull();
  });

  it('a medium-confidence recovery downgrades to try-then-show (probe, then confirm)', () => {
    // If the loop is only medium-confident the documented fix applies here, it
    // probes/shows rather than silently auto-healing.
    expect(govern({ toolName: 'launch_ads', confidence: 0.6 }).tier).toBe('try-then-show');
  });
});
