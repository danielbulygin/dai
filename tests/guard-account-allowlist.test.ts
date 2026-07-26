import { describe, it, expect } from 'vitest';
import { decide, defaultPolicy } from '../src/agents/sdk/guard.js';

/**
 * REGRESSION GUARD for the 2026-07-26 dead-code bug.
 *
 * The account allow-list check for launch verbs used to sit BELOW the
 * PRODUCTION_WRITES branch. That branch matches launch verbs, so the account check
 * was unreachable whenever allowProductionWrites was on: the guard approved a
 * launch aimed at any client, and a launch with no client named at all.
 *
 * Nothing was ever exposed (SafeMetaAPI resolves the account from the client's own
 * config and refuses an unknown client), but the guard advertised a protection it
 * did not provide. These tests exist so ordering cannot silently regress — a
 * reordering that breaks this is invisible in review and invisible at runtime.
 *
 * The requirement being protected (Dan, 2026-07-26): "Ada is read only for all the
 * new accounts, but I would love for Ada to be able to operate in the test account."
 */
const productionPolicy = (testClientCodes: string[] = ['AOT']) =>
  defaultPolicy({
    allowProductionWrites: true,
    allowPausedLaunch: true,
    allowMediaUpload: true,
    allowTestMutations: true,
    testClientCodes,
  });

describe('guard: account allow-list is reachable in production mode', () => {
  it('allows a launch into the allow-listed test account', () => {
    const d = decide('launch_ads', { client_code: 'AOT' }, productionPolicy());
    expect(d.decision).toBe('allow');
  });

  it.each([
    ['MTN', 'Matrinova — the account explicitly off limits'],
    ['BRAINFM', 'another agency client'],
    ['SLB', 'a client that IS launch-configured but is not the test account'],
  ])('denies a launch into %s (%s)', (clientCode) => {
    const d = decide('launch_ads', { client_code: clientCode }, productionPolicy());
    expect(d.decision).toBe('deny');
    expect(d.reason).toContain('not in the allowed account list');
  });

  it('denies a raw ad account id passed as the client code', () => {
    const d = decide(
      'launch_ads',
      { client_code: 'act_1001019312442535' },
      productionPolicy(),
    );
    expect(d.decision).toBe('deny');
  });

  it('applies to every launch verb, not just launch_ads', () => {
    for (const tool of ['launch_ads', 'pause_launch', 'set_adset_marker']) {
      const d = decide(tool, { client_code: 'MTN' }, productionPolicy());
      expect(d.decision, `${tool} should be denied for MTN`).toBe('deny');
    }
  });

  it('still denies deletes, above every allow branch', () => {
    const d = decide('delete_campaign', { client_code: 'AOT' }, productionPolicy());
    expect(d.decision).toBe('deny');
    expect(d.reason).toContain('delete tool hard-blocked');
  });

  it('still denies tools that are not on the allow-list at all', () => {
    for (const tool of ['update_adset_budget', 'set_ad_status', 'create_campaign']) {
      expect(decide(tool, { client_code: 'AOT' }, productionPolicy()).decision).toBe('deny');
    }
  });

  /**
   * KNOWN LIMITATION, deliberately asserted so it is not mistaken for a fix.
   *
   * launch_ads/pause_launch carry a batch_id, not a client_code, so the guard has
   * nothing to match on — it is a pure sync function and cannot look the batch up.
   * A batch-based launch therefore still passes the guard, and the account is
   * enforced downstream by SafeMetaAPI resolving it from the batch's client config.
   *
   * If this ever needs to be enforced IN the guard, the batch row must be resolved
   * to a client_code before the check. Until then, the guard is not the only thing
   * standing between Ada and another client's account, and should not be described
   * as though it were.
   */
  it('does NOT catch a launch with no client code — enforced downstream instead', () => {
    const d = decide('launch_ads', { batch_id: 'abc-123' }, productionPolicy());
    expect(d.decision).toBe('allow');
  });
});
