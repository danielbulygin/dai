import { describe, it, expect } from 'vitest';
import {
  classifySegmentKey,
} from '../src/audit/report-pack-extra.js';
import {
  optimizationActionTypes,
  partialWarning,
  readAudiences,
  readClassifiedAdSets,
  readNamePromises,
  seamGapFor,
  toActivityEvents,
  toAdsetConfigs,
  toAdsetSpend,
  toAdsetWeeklyEvents,
  toDemoRows,
  toGeoRows,
  toPixelLites,
  toPlacementRows,
  toSegmentRows,
  toTargetingSpecs,
} from '../src/audit/tinkers-reads.js';

/**
 * The generation seam's shapes, mapped into what the report engines eat.
 *
 * Every fixture here is derived from the Tinkers side's own contract tests
 * (packages/api/src/__tests__/generation-read.test.ts) rather than from a live
 * call: their port is the thing under test on their side, and ours is the
 * mapping. The rules being pinned are the ones a rename would break silently —
 * a composite breakdown read by dimension NAME rather than by position, a
 * segment key carried verbatim, an unplaceable audience staying unplaced.
 */

const insightRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  level: 'account',
  entityId: 'act_1',
  entityName: null,
  date: '2026-08-01',
  dateStop: '2026-08-31',
  spend: 100,
  impressions: 10_000,
  clicks: 200,
  linkClicks: 150,
  reach: 8_000,
  ctr: 2,
  cpm: 10,
  frequency: 1.25,
  actions: [
    { type: 'purchase', value: 4 },
    { type: 'lead', value: 9 },
  ],
  actionValues: [{ type: 'purchase', value: 400 }],
  purchaseRoas: [],
  videoPlays: 0,
  videoP25: 0,
  videoP75: 0,
  thruplays: 0,
  ...over,
});

const parts = (pairs: Array<[string, string | null]>): Record<string, unknown> => ({
  breakdownParts: pairs.map(([dimension, value]) => ({ dimension, value })),
});

describe('breakdown rows read their dimension by NAME', () => {
  it('a placement row is a platform crossed with a position, not a joined string', () => {
    const rows = toPlacementRows([
      insightRow(parts([['publisher_platform', 'instagram'], ['platform_position', 'story']])),
      // Order reversed on the wire: reading by position would swap these two.
      insightRow(parts([['platform_position', 'feed'], ['publisher_platform', 'facebook']])),
    ]);
    expect(rows[0]).toMatchObject({ publisher_platform: 'instagram', platform_position: 'story', spend: 100 });
    expect(rows[1]).toMatchObject({ publisher_platform: 'facebook', platform_position: 'feed' });
  });

  it('a column Meta would not name reads unknown rather than empty', () => {
    const rows = toPlacementRows([insightRow(parts([['publisher_platform', null], ['platform_position', 'feed']]))]);
    expect(rows[0]!.publisher_platform).toBe('unknown');
  });

  it('the money and the actions come across in the engines own field names', () => {
    const rows = toPlacementRows([insightRow(parts([['publisher_platform', 'facebook'], ['platform_position', 'feed']]))]);
    expect(rows[0]).toMatchObject({ spend: 100, impressions: 10_000, purchases: 4, purchase_value: 400, leads: 9 });
  });

  it('omni_purchase wins over purchase, the port own pickAction order', () => {
    const rows = toPlacementRows([
      insightRow({
        ...parts([['publisher_platform', 'facebook'], ['platform_position', 'feed']]),
        actions: [{ type: 'purchase', value: 2 }, { type: 'omni_purchase', value: 5 }],
        actionValues: [{ type: 'purchase', value: 100 }, { type: 'omni_purchase', value: 250 }],
      }),
    ]);
    expect(rows[0]).toMatchObject({ purchases: 5, purchase_value: 250 });
  });

  it('age and gender are two facts about one row', () => {
    const rows = toDemoRows([insightRow(parts([['age', '25-34'], ['gender', 'female']]))]);
    expect(rows[0]).toMatchObject({ age: '25-34', gender: 'female', leads: 9 });
  });

  it('a single-dimension split rides breakdownValue', () => {
    expect(toGeoRows([insightRow({ breakdownValue: 'DE' })])[0]).toMatchObject({ country: 'DE', spend: 100 });
    expect(toGeoRows([insightRow({ breakdownValue: null })])[0]!.country).toBe('unknown');
  });

  it('a segment key is carried VERBATIM, unknown included', () => {
    const rows = toSegmentRows([
      insightRow({ breakdownValue: 'unknown' }),
      insightRow({ breakdownValue: 'Engaged Audience' }),
    ]);
    // Renaming "unknown" into something friendlier here would hide the one
    // finding the segments section exists to make.
    expect(rows.map((r) => r.key)).toEqual(['unknown', 'Engaged Audience']);
  });

  it('a row that is not an object costs that row and nothing else', () => {
    expect(toPlacementRows([null, 'nope', insightRow(parts([['publisher_platform', 'facebook'], ['platform_position', 'feed']]))])).toHaveLength(3);
    expect(toSegmentRows([null])[0]).toMatchObject({ key: 'unknown', spend: 0 });
  });
});

describe('segment keys are placed by their own words', () => {
  it('names the four things a key can mean, and refuses to guess the rest', () => {
    expect(classifySegmentKey('unknown')).toBe('unknown');
    expect(classifySegmentKey('')).toBe('unknown');
    expect(classifySegmentKey('New Audience')).toBe('new');
    expect(classifySegmentKey('Engaged Audience')).toBe('engaged');
    expect(classifySegmentKey('Existing Customers')).toBe('existing');
    expect(classifySegmentKey('some_key_meta_invented')).toBe('other');
  });

  it('a non-customer is a stranger: new is tested before existing', () => {
    expect(classifySegmentKey('non-customer')).toBe('new');
  });
});

describe('ad set configuration', () => {
  const adSets = [
    { adsetId: 'as_1', name: 'Prospecting broad', effectiveStatus: 'ACTIVE', optimizationGoal: 'OFFSITE_CONVERSIONS', promotedObjectEventType: 'PURCHASE', campaignId: 'c_1' },
    { adsetId: 'as_2', name: null, effectiveStatus: 'PAUSED', optimizationGoal: 'LINK_CLICKS', promotedObjectEventType: null, campaignId: 'c_1' },
  ];

  it('maps into the config shape, and an unnamed ad set is reported under its id', () => {
    expect(toAdsetConfigs(adSets)).toEqual([
      { adset_id: 'as_1', adset_name: 'Prospecting broad', optimization_goal: 'OFFSITE_CONVERSIONS', custom_event_type: 'PURCHASE', effective_status: 'ACTIVE' },
      { adset_id: 'as_2', adset_name: 'as_2', optimization_goal: 'LINK_CLICKS', custom_event_type: null, effective_status: 'PAUSED' },
    ]);
  });

  it('sums ad-set spend per ad set across the rows it was given', () => {
    const spend = toAdsetSpend([
      insightRow({ entityId: 'as_1', spend: 40 }),
      insightRow({ entityId: 'as_1', spend: 60 }),
      insightRow({ entityId: 'as_2', spend: 10 }),
      insightRow({ entityId: null, spend: 999 }),
    ]);
    expect(spend.get('as_1')).toBe(100);
    expect(spend.get('as_2')).toBe(10);
    expect(spend.size).toBe(2);
  });

  it('counts the event the ad set is OPTIMIZING for, never whatever the account records', () => {
    expect(optimizationActionTypes({ optimization_goal: 'OFFSITE_CONVERSIONS', custom_event_type: 'PURCHASE' })).toEqual(['omni_purchase', 'purchase']);
    expect(optimizationActionTypes({ optimization_goal: 'OFFSITE_CONVERSIONS', custom_event_type: 'LEAD' })).toEqual(['lead']);
    expect(optimizationActionTypes({ optimization_goal: 'LEAD_GENERATION', custom_event_type: null })).toEqual(['lead']);
    expect(optimizationActionTypes({ optimization_goal: 'LINK_CLICKS', custom_event_type: null })).toEqual(['link_click']);
    // A config we cannot place answers null, and the caller falls back rather
    // than counting an event nobody configured.
    expect(optimizationActionTypes({ optimization_goal: 'SOMETHING_NEW', custom_event_type: null })).toBeNull();
  });

  it('a weekly rate is each ad set own average over the buckets it actually has', () => {
    const configs = toAdsetConfigs(adSets);
    const weekly = toAdsetWeeklyEvents(
      [
        insightRow({ entityId: 'as_1', date: '2026-08-01', actions: [{ type: 'purchase', value: 30 }] }),
        insightRow({ entityId: 'as_1', date: '2026-08-08', actions: [{ type: 'purchase', value: 50 }] }),
        // as_2 optimizes for link clicks and ran in ONE of the weeks: dividing
        // by a flat four would report a quarter of its real weekly rate.
        insightRow({ entityId: 'as_2', date: '2026-08-08', actions: [{ type: 'link_click', value: 200 }] }),
      ],
      configs,
    );
    expect(weekly.get('as_1')).toBe(40);
    expect(weekly.get('as_2')).toBe(200);
  });

  it('an ad set whose goal we cannot place falls back to the conversions on the row', () => {
    const weekly = toAdsetWeeklyEvents(
      [insightRow({ entityId: 'as_9', date: '2026-08-01', actions: [{ type: 'lead', value: 12 }] })],
      [{ adset_id: 'as_9', adset_name: 'x', optimization_goal: 'SOMETHING_NEW', custom_event_type: null, effective_status: 'ACTIVE' }],
    );
    expect(weekly.get('as_9')).toBe(12);
  });
});

describe('targeting: their class decides, our flags follow', () => {
  const classified = (over: Record<string, unknown> = {}, signals: Record<string, unknown> = {}): Record<string, unknown> => ({
    adsetId: 'as_1',
    adsetName: 'Broad prospecting',
    targetingClass: 'broad',
    signals: {
      advantageAudience: false,
      hasInterestTargeting: false,
      includedAudiences: [],
      excludedAudiences: [],
      geoCountries: ['US'],
      ageMin: 18,
      ageMax: 65,
      genders: null,
      ...signals,
    },
    ...over,
  });

  it('projects class onto the flags our own classifier reads', () => {
    const rows = readClassifiedAdSets([
      classified({ adsetId: 'a', targetingClass: 'advantage_plus' }),
      classified({ adsetId: 'b', targetingClass: 'retargeting' }),
      classified({ adsetId: 'c', targetingClass: 'lookalike' }),
      classified({ adsetId: 'd', targetingClass: 'interest' }),
      classified({ adsetId: 'e', targetingClass: 'broad' }),
    ]);
    const specs = toTargetingSpecs(rows);
    expect(specs.map((s) => [s.advantage_audience, s.has_custom_audiences, s.has_lookalikes, s.has_interests])).toEqual([
      [true, false, false, false],
      [false, true, false, false],
      [false, true, true, false],
      [false, false, false, true],
      [false, false, false, false],
    ]);
  });

  it('carries the age and gender narrowing across, and "all" only when there is more than one', () => {
    const [one] = toTargetingSpecs(readClassifiedAdSets([classified({}, { genders: ['female'], ageMin: 25, ageMax: 44 })]));
    expect(one).toMatchObject({ genders: 'female', age_min: 25, age_max: 44 });
    const [both] = toTargetingSpecs(readClassifiedAdSets([classified({}, { genders: ['male', 'female'] })]));
    expect(both!.genders).toBe('all');
    const [none] = toTargetingSpecs(readClassifiedAdSets([classified({}, { genders: null })]));
    expect(none!.genders).toBeNull();
  });

  it('reads the audience list into names the promise check can use', () => {
    expect(readAudiences([{ id: 'aud_1', name: 'Purchasers 180d', subtype: 'website' }, { id: null }, 7])).toEqual([
      { id: 'aud_1', name: 'Purchasers 180d' },
    ]);
  });
});

describe('the ad set name promise', () => {
  const row = (name: string | null, cls: string, included: Array<{ id: string; name: string | null; subtype: string | null }> = []): Record<string, unknown> => ({
    adsetId: `as_${name ?? 'none'}`,
    adsetName: name,
    targetingClass: cls,
    signals: {
      advantageAudience: cls === 'advantage_plus',
      hasInterestTargeting: cls === 'interest',
      includedAudiences: included,
      excludedAudiences: [],
      geoCountries: ['US'],
      ageMin: null,
      ageMax: null,
      genders: null,
    },
  });

  it('catches a name claiming a lookalike over a spec that holds none', () => {
    const promises = readNamePromises(readClassifiedAdSets([row('LAL 1% purchasers', 'broad')]), []);
    expect(promises).toHaveLength(1);
    expect(promises[0]!.claim).toBe('a lookalike');
    expect(promises[0]!.detail).toContain('no audience and no interests at all');
    // The verdict never says which half is stale, because from here they look
    // identical: a renamed ad set and a rebuilt audience.
    expect(promises[0]!.detail).not.toMatch(/wrong|lying|mistake/i);
  });

  it('catches retargeting and broad names the spec disagrees with', () => {
    const promises = readNamePromises(
      readClassifiedAdSets([row('Retargeting 30d', 'broad'), row('Broad test', 'interest')]),
      [],
    );
    expect(promises.map((p) => p.claim)).toEqual(['retargeting', 'broad targeting']);
  });

  it('says nothing about a name that claims nothing, or one the spec agrees with', () => {
    expect(
      readNamePromises(
        readClassifiedAdSets([row('Q3 test 4', 'broad'), row('LAL 1%', 'lookalike'), row('Broad ABO', 'advantage_plus'), row(null, 'broad')]),
        [],
      ),
    ).toEqual([]);
  });

  it('catches a name pointing at one of the account own audiences it does not target', () => {
    const audiences = [
      { id: 'aud_1', name: 'Purchasers 180d' },
      { id: 'aud_2', name: 'Site visitors' },
    ];
    const promises = readNamePromises(
      readClassifiedAdSets([row('Purchasers 180d expansion', 'broad')]),
      audiences,
    );
    expect(promises).toHaveLength(1);
    expect(promises[0]!.detail).toContain('names the saved audience "Purchasers 180d"');
  });

  it('leaves an ad set that DOES include the named audience alone', () => {
    const promises = readNamePromises(
      readClassifiedAdSets([row('Purchasers 180d', 'retargeting', [{ id: 'aud_1', name: 'Purchasers 180d', subtype: 'website' }])]),
      [{ id: 'aud_1', name: 'Purchasers 180d' }],
    );
    expect(promises).toEqual([]);
  });

  it('reports one finding per ad set, never two for the same name', () => {
    const promises = readNamePromises(
      readClassifiedAdSets([row('LAL Purchasers 180d', 'broad')]),
      [{ id: 'aud_1', name: 'Purchasers 180d' }],
    );
    expect(promises).toHaveLength(1);
  });
});

describe('change history and pixels', () => {
  it('reads the provider own event name, drops the actor, and dedupes on the key', () => {
    const events = toActivityEvents([
      { key: 'k1', at: '2026-08-10T09:00:00Z', kind: 'paused', objectId: 'ad_1', objectName: 'Hoodie', objectType: 'AD', providerEventType: 'update_ad_run_status', fromBudget: null, toBudget: null },
      // The same change arriving in two overlapping window slices.
      { key: 'k1', at: '2026-08-10T09:00:00Z', kind: 'paused', objectId: 'ad_1', objectName: 'Hoodie', objectType: 'AD', providerEventType: 'update_ad_run_status', fromBudget: null, toBudget: null },
      { key: 'k2', at: '2026-08-11T09:00:00Z', kind: 'budget_decreased', objectId: 'as_1', objectName: null, objectType: 'AD_SET', providerEventType: 'update_ad_set_budget', fromBudget: 100, toBudget: 60 },
      { key: 'k3', at: null },
    ]);
    expect(events).toHaveLength(2);
    // The categoriser was written against Meta's own event names, so that is
    // the field the bucket is decided from.
    expect(events[0]).toEqual({
      event_type: 'update_ad_run_status',
      event_time: '2026-08-10T09:00:00Z',
      actor_id: null,
      actor_name: null,
      application_id: null,
      application_name: null,
      object_type: 'AD',
    });
    expect(events[1]!.event_type).toBe('update_ad_set_budget');
  });

  it('falls back to the normalized kind when the provider named nothing', () => {
    const events = toActivityEvents([{ key: 'k', at: '2026-08-10T09:00:00Z', kind: 'paused', providerEventType: null }]);
    expect(events[0]!.event_type).toBe('paused');
  });

  it('reads a pixel whole, and a null match rate stays null', () => {
    const pixels = toPixelLites([
      {
        id: 'px_1',
        name: 'Main pixel',
        lastFiredTime: '2026-08-20T10:00:00Z',
        automaticMatchingEnabled: true,
        automaticMatchingFields: ['em', 'ph'],
        matchRateApprox: null,
        diagnostics: [
          { key: 'unverified_domain', title: 'Verify your domain', result: 'failed' },
          { key: 'pixel_installed', title: 'Pixel installed', result: 'passed' },
          { key: 'no_result', title: 'No result at all' },
        ],
      },
      { id: null },
    ]);
    expect(pixels).toHaveLength(1);
    expect(pixels[0]).toMatchObject({
      id: 'px_1',
      automatic_matching_enabled: true,
      automatic_matching_fields: ['em', 'ph'],
      match_rate_approx: null,
    });
    // A check with no result word is not a check: coercing it into a pass or a
    // fail would invent a verdict.
    expect(pixels[0]!.diagnostics).toEqual([
      { key: 'unverified_domain', title: 'Verify your domain', result: 'failed' },
      { key: 'pixel_installed', title: 'Pixel installed', result: 'passed' },
    ]);
  });

  it('an absent automatic-matching flag stays null, never false', () => {
    const [pixel] = toPixelLites([{ id: 'px', automaticMatchingEnabled: null, diagnostics: [] }]);
    expect(pixel!.automatic_matching_enabled).toBeNull();
    expect(pixel!.automatic_matching_fields).toEqual([]);
  });
});

describe('what a read that could not answer does to its section', () => {
  it('a 404 leaves the section PLANNED, because the endpoint is not deployed yet', () => {
    const gap = seamGapFor({ state: 'not_deployed' }, "this account's pixels");
    expect(gap).toEqual({ status: 'planned' });
    // Never an error: a customer who did nothing wrong must not read a failure
    // on their report because we shipped a reader before the endpoint landed.
    expect(gap.error).toBeUndefined();
  });

  it('an ok:false reason SKIPS the section and carries the reason as data', () => {
    const gap = seamGapFor({ state: 'unsupported', reason: 'pixel_read_unsupported' }, "this account's pixels");
    expect(gap.status).toBe('skipped');
    expect(gap.skip_reason).toContain("this account's pixels");
    expect(gap.data).toEqual({ unavailable_reason: 'pixel_read_unsupported', signal: false });
    // The reason is a machine word and stays out of the sentence a customer reads.
    expect(gap.skip_reason).not.toContain('pixel_read_unsupported');
  });

  it('anything else is the honest error a failed pull has always been', () => {
    const gap = seamGapFor({ state: 'failed', reason: 'targeting returned 502' }, 'who each ad set is told to reach');
    expect(gap.status).toBe('error');
    expect(gap.error).toContain('502');
  });

  it('every sentence it produces is free of em-dashes', () => {
    const texts = [
      seamGapFor({ state: 'unsupported', reason: 'x' }, 'the placements').skip_reason ?? '',
      partialWarning('placement'),
    ];
    for (const text of texts) expect(text).not.toMatch(/—/);
  });
});
