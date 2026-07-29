import { describe, it, expect } from 'vitest';
import { decide, defaultPolicy, readCampaignIds } from '../src/agents/sdk/guard.js';

/**
 * CAMPAIGN FENCE (card 48, 2026-07-29).
 *
 * Matrinova's explicit ask on the 2026-07-27 call: Ada works ONLY inside
 * [MD Managed] (52618241758539); the media buyer's [TM - MD] campaigns are off
 * limits. Until this fence, the only thing enforcing that was people
 * remembering it. The fence lives in decide() BEFORE every write allow-list,
 * keyed on clients.allowed_campaign_ids:
 *
 *   - key absent        → no fence configured (behavior unchanged)
 *   - empty list / null → NO writes anywhere in that client's account
 *   - non-empty list    → any write naming a campaign outside it is denied
 *
 * Reads are never fenced: a customer may LOOK at every campaign, including the
 * media buyer's — they just cannot make Ada touch them.
 */

const MD_MANAGED = '52618241758539';
const TM_MD = '120999999999999999';
const SANDBOX = '120220277252270225';

const policy = (
  allowedCampaignsByClient: Record<string, string[] | null>,
  testClientCodes: string[] = ['AOTUS', 'MTR'],
) =>
  defaultPolicy({
    allowProductionWrites: true,
    allowPausedLaunch: true,
    allowMediaUpload: true,
    allowTestMutations: true,
    testClientCodes,
    allowedCampaignsByClient,
  });

describe('campaign fence: writes stay inside the allowed campaign', () => {
  it('allows a launch naming the allowed campaign', () => {
    const d = decide(
      'launch_ads',
      { client_code: 'MTR', campaign_id: MD_MANAGED },
      policy({ MTR: [MD_MANAGED] }),
    );
    expect(d.decision).toBe('allow');
  });

  it('denies a launch naming the media buyer\'s campaign', () => {
    const d = decide(
      'launch_ads',
      { client_code: 'MTR', campaign_id: TM_MD },
      policy({ MTR: [MD_MANAGED] }),
    );
    expect(d.decision).toBe('deny');
    expect(d.reason).toContain('campaign fence');
  });

  it('denies when the campaign hides in a nested object', () => {
    const d = decide(
      'launch_ads',
      { client_code: 'MTR', adset: { campaign_id: TM_MD } },
      policy({ MTR: [MD_MANAGED] }),
    );
    expect(d.decision).toBe('deny');
  });

  it('denies when ANY of several named campaigns is outside the fence', () => {
    const d = decide(
      'launch_ads',
      { client_code: 'MTR', campaign_ids: [MD_MANAGED, TM_MD] },
      policy({ MTR: [MD_MANAGED] }),
    );
    expect(d.decision).toBe('deny');
  });

  it('fences NON-launch writes that name a campaign too', () => {
    const d = decide(
      'set_adset_marker',
      { client_code: 'MTR', campaign_id: TM_MD },
      policy({ MTR: [MD_MANAGED] }),
    );
    expect(d.decision).toBe('deny');
    expect(d.reason).toContain('campaign fence');
  });
});

describe('campaign fence: fail-closed when the list is empty', () => {
  it('an EMPTY fence denies launches even without a campaign named — and even when the ACCOUNT gate would allow (NHY today)', () => {
    // NHY is deliberately put on the account allow-list here, so the only
    // thing standing between this launch and an allow is the fence itself.
    const d = decide(
      'launch_ads',
      { client_code: 'NHY' },
      policy({ NHY: [] }, ['AOTUS', 'MTR', 'NHY']),
    );
    expect(d.decision).toBe('deny');
    expect(d.reason).toContain('no allowed campaigns');
  });

  it('a NULL fence (column exists, never set) behaves like empty', () => {
    const d = decide(
      'launch_ads',
      { client_code: 'NHY' },
      policy({ NHY: null }, ['AOTUS', 'MTR', 'NHY']),
    );
    expect(d.decision).toBe('deny');
    expect(d.reason).toContain('no allowed campaigns');
  });
});

describe('campaign fence: what it deliberately does NOT do', () => {
  it('reads are never fenced — looking at the media buyer\'s campaign is fine', () => {
    const d = decide(
      'get_campaign_performance',
      { client_code: 'MTR', campaign_id: TM_MD },
      policy({ MTR: [MD_MANAGED] }),
    );
    expect(d.decision).toBe('allow');
  });

  it('an unconfigured client keeps pre-fence behavior', () => {
    const d = decide(
      'launch_ads',
      { client_code: 'AOTUS', campaign_id: SANDBOX },
      policy({ MTR: [MD_MANAGED] }),
    );
    expect(d.decision).toBe('allow');
  });

  it('the fence cannot loosen the account allow-list: a fenced-OK campaign on a non-test client still dies at the account gate', () => {
    const d = decide(
      'launch_ads',
      { client_code: 'BRAINFM', campaign_id: MD_MANAGED },
      policy({ BRAINFM: [MD_MANAGED] }),
    );
    expect(d.decision).toBe('deny');
    expect(d.reason).toContain('not in the allowed account list');
  });
});

describe('readCampaignIds', () => {
  it('collects top-level, nested, array and numeric ids', () => {
    expect(
      readCampaignIds({
        campaign_id: 'a',
        changes: { campaignId: 42, deep: { campaign_ids: ['b', 'c'] } },
      }).sort(),
    ).toEqual(['42', 'a', 'b', 'c']);
  });

  it('ignores unrelated keys and non-scalar values', () => {
    expect(readCampaignIds({ campaign_name: 'x', campaign_id: { weird: true } })).toEqual([]);
  });
});
