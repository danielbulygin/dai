import { describe, it, expect } from 'vitest';
import {
  newRunState, assessConfidence, governWrite, noteToolOutcome,
  renderDeadEndNote, renderRefusal, failureText, lookupDeadEnd, resetDeadEndCache,
} from '../src/agents/sdk/loop-wiring.js';
import { detectSoftError } from '../src/agents/sdk/observe-after.js';
import type { DeadEndMatch } from '../src/agents/sdk/dead-end-match.js';

/**
 * Loop wiring — the Phase-1 integration layer that puts governor/dead-end-match
 * into the LIVE bridge. Mirrors tests/phase1-recovery.e2e.test.ts, but exercises
 * the actual wiring (run state, confidence escalation, refusals) instead of the
 * bare organs.
 */

const JVA_MATCH: DeadEndMatch = {
  row: {
    id: 'jva-outcome-sales',
    kind: 'tool_error',
    signal: 'OUTCOME_SALES launch rejected — LEAD invalid on a sales campaign (Meta error_subcode 2446814)',
    resolution: 'Relaunch with channel=minicourse (INITIATED_CHECKOUT).',
    status: 'open',
  },
  matchedOn: ['outcome_sales', '2446814'],
  reason: 'matched on outcome_sales, 2446814',
};

describe('loop-wiring — Governor gate', () => {
  it('reads pass untouched (no verdict, no state)', () => {
    const s = newRunState();
    expect(governWrite(s, 'mcp__ada-tools__get_client_performance')).toBeUndefined();
    expect(governWrite(s, 'lookup_dead_end')).toBeUndefined();
    expect(s.verdicts.length).toBe(0);
  });

  it('first-attempt write → try-then-show, executes (no refusal)', () => {
    const s = newRunState();
    const gate = governWrite(s, 'mcp__ada-tools__launch_ads')!;
    expect(gate.verdict.tier).toBe('try-then-show');
    expect(gate.refusal).toBeUndefined();
    expect(s.verdicts.length).toBe(1);
  });

  it('launch after a successful preview this run → auto-heal (probe→act)', () => {
    const s = newRunState();
    noteToolOutcome(s, 'mcp__ada-tools__preview_ad_launch', false);
    expect(s.previewSucceeded).toBe(true);
    const gate = governWrite(s, 'mcp__ada-tools__launch_ads')!;
    expect(gate.verdict.tier).toBe('auto-heal');
    expect(gate.refusal).toBeUndefined();
  });

  it('the JVA recovery: failed write + KB match → retry is auto-heal (documented fix)', () => {
    const s = newRunState();
    noteToolOutcome(s, 'mcp__ada-tools__launch_ads', true, JVA_MATCH);
    expect(assessConfidence(s, 'launch_ads')).toBe(0.9);
    const gate = governWrite(s, 'mcp__ada-tools__launch_ads')!;
    expect(gate.verdict.tier).toBe('auto-heal');
    expect(gate.refusal).toBeUndefined();
    // …and the match is recorded for the decision card / audit.
    expect(s.deadEndMatches.length).toBe(1);
    expect(s.deadEndMatches[0]!.deadEndId).toBe('jva-outcome-sales');
    // A successful retry clears the failure history.
    noteToolOutcome(s, 'mcp__ada-tools__launch_ads', false);
    expect(s.failures.has('launch_ads')).toBe(false);
  });

  it('unmatched failure → one cautious retry (try-then-show), then options + REFUSAL (stop hammering)', () => {
    const s = newRunState();
    noteToolOutcome(s, 'mcp__ada-tools__launch_ads', true, null);
    const retry1 = governWrite(s, 'mcp__ada-tools__launch_ads')!;
    expect(retry1.verdict.tier).toBe('try-then-show');
    expect(retry1.refusal).toBeUndefined();

    noteToolOutcome(s, 'mcp__ada-tools__launch_ads', true, null);
    const retry2 = governWrite(s, 'mcp__ada-tools__launch_ads')!;
    expect(retry2.verdict.tier).toBe('options');
    expect(retry2.refusal).toBeTruthy();
  });

  it('deletes are blocked with a refusal (never autonomous — mirrors the guard rail)', () => {
    const s = newRunState();
    const gate = governWrite(s, 'mcp__ada-tools__delete_learning')!;
    expect(gate.verdict.tier).toBe('blocked');
    expect(gate.refusal).toContain('forbidden');
  });

  it('dormant irreversible verbs (set_budget) → options + refusal even at high confidence', () => {
    const s = newRunState();
    // even a matched dead-end cannot make an irreversible verb auto-heal
    noteToolOutcome(s, 'mcp__ada-tools__set_budget', true, JVA_MATCH);
    const gate = governWrite(s, 'mcp__ada-tools__set_budget')!;
    expect(gate.verdict.tier).toBe('options');
    expect(gate.refusal).toBeTruthy();
  });
});

describe('loop-wiring — model-facing renderings', () => {
  it('refusal is a soft-failure JSON the loop observes (error + guidance)', () => {
    const s = newRunState();
    const gate = governWrite(s, 'mcp__ada-tools__delete_learning')!;
    const soft = detectSoftError(gate.refusal!);
    expect(soft).toBeTruthy();
    const parsed = JSON.parse(gate.refusal!) as { guidance: string; governor: { tier: string } };
    expect(parsed.governor.tier).toBe('blocked');
    expect(parsed.guidance.length).toBeGreaterThan(10);
  });

  it('dead-end note carries the documented fix + the honest-stop instruction', () => {
    const note = renderDeadEndNote(JVA_MATCH);
    expect(note).toContain('FAILURE-ORGAN MATCH');
    expect(note).toContain('channel=minicourse');
    expect(note).toContain('never claim success');
  });

  it('a matched row WITHOUT a resolution instructs reason-from-scratch, still honest', () => {
    const note = renderDeadEndNote({ ...JVA_MATCH, row: { ...JVA_MATCH.row, resolution: null } });
    expect(note).toContain('No documented fix yet');
    expect(note).toContain('never claim success');
  });

  it('failureText prefers the soft-error string, falls back to the raw result', () => {
    expect(failureText(JSON.stringify({ error: 'SafetyError subcode 2446814' }))).toBe('SafetyError subcode 2446814');
    expect(failureText('plain text blowup OUTCOME_SALES')).toBe('plain text blowup OUTCOME_SALES');
  });
});

describe('loop-wiring — failure-organ read is fail-soft', () => {
  it('without Supabase env, lookupDeadEnd returns null instead of throwing', async () => {
    resetDeadEndCache();
    const m = await lookupDeadEnd('SafetyError OUTCOME_SALES subcode 2446814');
    expect(m).toBeNull();
  });
});
