import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Tinkers monorepo seam: the generation reads (Bearer-authorized GETs — no
 * credential ever crosses this boundary), the row mapper, HMAC signing on the
 * write-backs, snake_case → camelCase patch mapping, and the rule that makes
 * the whole thing safe to run — nothing token-shaped reaches a log or the wire.
 */

const { state } = vi.hoisted(() => ({
  state: {
    baseUrl: 'https://tinkers.test' as string | undefined,
    secret: 'seam-secret' as string | undefined,
    calls: [] as Array<{ url: string; method: string; auth: string | null; signature: string | null; body: string | null }>,
    /** Queued answers for POSTs to /audit-complete (shifted in order). */
    responses: [] as Array<{ status?: number; json?: unknown; throws?: Error }>,
    /** Handlers for the generation GETs, by path segment. An array shifts
     *  per call, so a test can fail one window out of six. */
    reads: {} as Record<
      string,
      { status?: number; json?: unknown; throws?: Error } | Array<{ status?: number; json?: unknown; throws?: Error }>
    >,
    logs: [] as string[],
    // The real column patches magic-audit writes, in the order it writes them
    // (copied from a run of tests/magic-audit-row-mirror.test.ts).
    orchestratorPatches: [] as Array<Record<string, unknown>>,
    finalRowState: {} as Record<string, unknown>,
    /** Set to a pending promise to hold a run open (concurrency tests). */
    holdRun: undefined as Promise<void> | undefined,
    /** What runMagicAudit received (the cold injection under test). */
    magicAuditOptions: undefined as Record<string, unknown> | undefined,
  },
}));

vi.mock('../src/env.js', () => ({
  env: new Proxy(
    {},
    {
      get: (_, k) => {
        if (k === 'TINKERS_BASE_URL') return state.baseUrl;
        if (k === 'TINKERS_AUDIT_SEAM_SECRET') return state.secret;
        if (k === 'LOG_LEVEL') return 'silent';
        // Everything else stays real: this module's import chain reaches the
        // tool registry, which boots the Slack app off env at import time.
        return process.env[k as string];
      },
    },
  ),
}));

vi.mock('../src/utils/logger.js', () => {
  const record =
    (level: string) =>
    (...args: unknown[]) =>
      state.logs.push(`${level} ${args.map((a) => JSON.stringify(a)).join(' ')}`);
  return { logger: { info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') } };
});

// The audit machinery is stubbed down to the two things this file is about:
// what the bridge reads and what leaves the wire for each patch.
vi.mock('../src/audit/cold-source.js', () => ({
  buildColdRows: () => ({
    packRows90: [], packRows180: [], packAccRows90: [], accFull30: [], landing30: [],
    rowCount: 7, daysCovered: 3, adNames: {}, sixMonthAds: [],
    window: {
      asOf: '2026-08-20', lastSpendDate: '2026-08-19', anchorDate: '2026-08-20', anchored: false,
      daysSinceLastSpend: 1, coreStart: '2026-07-21', ninetyStart: '2026-05-22', sixMonthStart: '2026-02-18',
    },
  }),
}));

vi.mock('../src/audit/magic-audit.js', () => ({
  runMagicAudit: async (_code: string, options: { onRowUpdate?: (p: Record<string, unknown>, m: { final: boolean }) => void | Promise<void> }) => {
    state.magicAuditOptions = options as unknown as Record<string, unknown>;
    if (state.holdRun) await state.holdRun;
    for (const patch of state.orchestratorPatches) await options.onRowUpdate?.(patch, { final: false });
    await options.onRowUpdate?.(state.finalRowState, { final: true });
    return { auditId: 'dai-audit-1', token: 'tok', costUsd: 4.5 };
  },
}));

vi.stubGlobal('fetch', async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
  const u = String(url);
  state.calls.push({
    url: u,
    method: init?.method ?? 'GET',
    auth: init?.headers?.Authorization ?? null,
    signature: init?.headers?.['x-tinkers-signature-256'] ?? null,
    body: init?.body ?? null,
  });
  let next: { status?: number; json?: unknown; throws?: Error } | undefined;
  if (u.includes('/api/generation/')) {
    const seg = u.match(/\/api\/generation\/[^/]+\/([a-z-]+)/)?.[1] ?? '';
    const handler = state.reads[seg];
    next = Array.isArray(handler) ? handler.shift() : handler;
  } else {
    next = state.responses.shift();
  }
  next ??= { json: { ok: false, reason: 'not_configured' } };
  if (next.throws) throw next.throws;
  const status = next.status ?? 200;
  return { ok: status >= 200 && status < 300, status, json: async () => next.json } as unknown as Response;
});

import { runBridgedColdAudit } from '../src/audit/tinkers-bridge.js';
import { seamGapFor, type TinkersSeamReads } from '../src/audit/tinkers-reads.js';
import {
  fetchTinkersActivity,
  fetchTinkersAdDays,
  fetchTinkersAdSets,
  fetchTinkersAdSetInsights,
  fetchTinkersBreakdown,
  fetchTinkersPixels,
  fetchTinkersTargeting,
  tinkersSeamReads,
  fetchTinkersDestinations,
  fetchTinkersLeadContext,
  fetchTinkersStoreMedia,
  hasReportContent,
  isTinkersSeamConfigured,
  redactSecrets,
  reportAuditFinalize,
  reportAuditUpdate,
  signRequest,
  toRawAdDay,
  topSpendingAdIds,
  toTinkersPatch,
} from '../src/audit/tinkers-bridge.js';

const okAccount = {
  ok: true,
  account: { externalId: 'act_123', name: 'Acme', currency: 'EUR', timezone: 'Europe/Berlin' },
};

const insightRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  level: 'ad',
  entityId: 'ad_1',
  entityName: 'Blue hoodie UGC',
  campaignId: 'c_1',
  adsetId: 'as_1',
  date: '2026-08-01',
  dateStop: '2026-08-01',
  spend: 12.5,
  impressions: 1000,
  clicks: 40,
  linkClicks: 30,
  reach: 800,
  ctr: 4,
  cpm: 12.5,
  frequency: 1.25,
  actions: [
    { type: 'purchase', value: 2 },
    { type: 'video_view', value: 300 },
  ],
  actionValues: [{ type: 'purchase', value: 90 }],
  purchaseRoas: [],
  videoPlays: 300,
  videoP25: 250,
  videoP75: 120,
  thruplays: 90,
  ...over,
});

beforeEach(() => {
  state.baseUrl = 'https://tinkers.test';
  state.secret = 'seam-secret';
  state.calls.length = 0;
  state.responses.length = 0;
  state.logs.length = 0;
  state.holdRun = undefined;
  state.magicAuditOptions = undefined;
  state.reads = {
    account: { json: okAccount },
    'ad-days': { json: { ok: true, rows: [], partial: false } },
    creatives: { json: { ok: true, creatives: [] } },
    'creative-media': { json: { ok: true, ads: [] } },
    context: { json: { ok: true, goal: null, grossMarginPct: null, interview: { who_runs_ads: null, pain_point: null, tried: [], agency_fee: null }, rivals: [], accountTarget: null } },
  };
  state.orchestratorPatches = [
    { recognition: { ads_count: 12 }, updated_at: 'ts' },
    { work_log: [{ at: 'ts', line: 'Read 12 ads' }] },
    { sections: { creative_fatigue: { status: 'complete' } }, cost_usd: 0 },
    { scorecard: [{ key: 'hooks', band: 'weak' }] },
    { lead_insights: [{ headline: 'Top ad is fatiguing' }] },
    { status: 'complete', cost_usd: 4.5 },
  ];
  state.finalRowState = {
    sections: { creative_fatigue: { status: 'complete' } },
    recognition: { ads_count: 12 },
    work_log: [{ at: 'ts', line: 'Read 12 ads' }],
    scorecard: [{ key: 'hooks', band: 'weak' }],
    lead_insights: [{ headline: 'Top ad is fatiguing' }],
    cost_usd: 4.5,
    status: 'complete',
  };
});

describe('signRequest', () => {
  it('is the hex HMAC-SHA256 of the exact body bytes', () => {
    expect(signRequest('{"a":1}', 'seam-secret')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with the body and with the secret', () => {
    expect(signRequest('{"a":1}', 's1')).not.toBe(signRequest('{"a":2}', 's1'));
    expect(signRequest('{"a":1}', 's1')).not.toBe(signRequest('{"a":1}', 's2'));
  });
});

describe('isTinkersSeamConfigured', () => {
  it('needs both halves', () => {
    expect(isTinkersSeamConfigured()).toBe(true);
    state.baseUrl = undefined;
    expect(isTinkersSeamConfigured()).toBe(false);
    state.baseUrl = 'https://tinkers.test';
    state.secret = undefined;
    expect(isTinkersSeamConfigured()).toBe(false);
  });
});

describe('the generation reads', () => {
  it('authorizes with the Bearer secret and never signs a read', async () => {
    await fetchTinkersDestinations('aud_1');
    const call = state.calls[0]!;
    expect(call.url).toBe('https://tinkers.test/api/generation/aud_1/creatives');
    expect(call.method).toBe('GET');
    expect(call.auth).toBe('Bearer seam-secret');
    expect(call.signature).toBeNull();
    expect(call.body).toBeNull();
  });

  it('a not-ready account read refuses the whole run and posts nothing', async () => {
    state.reads.account = { json: { ok: false, reason: 'no_connection' } };
    await expect(runBridgedColdAudit({ organizationId: 'org_1', auditId: 'aud_1' })).rejects.toThrow('no_connection');
    expect(state.calls.filter((c) => c.url.endsWith('/audit-complete'))).toHaveLength(0);
  });

  it("an unknown audit is their 404 and refuses loudly", async () => {
    state.reads.account = { status: 404, json: { error: { code: 'NOT_FOUND' } } };
    await expect(runBridgedColdAudit({ organizationId: 'org_1', auditId: 'nope' })).rejects.toThrow('404');
  });

  it('refuses an unconfigured seam before any call leaves', async () => {
    state.secret = undefined;
    await expect(runBridgedColdAudit({ organizationId: 'org_1', auditId: 'aud_1' })).rejects.toThrow('not configured');
    expect(state.calls).toHaveLength(0);
  });
});

describe('toRawAdDay', () => {
  it('maps their normalized row onto the raw Graph shape the pack builder eats', () => {
    const raw = toRawAdDay(insightRow())!;
    expect(raw).toMatchObject({
      ad_id: 'ad_1',
      ad_name: 'Blue hoodie UGC',
      adset_id: 'as_1',
      date_start: '2026-08-01',
      date_stop: '2026-08-01',
      spend: 12.5,
      impressions: 1000,
      clicks: 40,
      frequency: 1.25,
    });
    expect(raw.actions).toContainEqual({ action_type: 'purchase', value: 2 });
    expect(raw.action_values).toEqual([{ action_type: 'purchase', value: 90 }]);
    // Thruplays land under the video_view type — the type Meta itself uses
    // inside video_thruplay_watched_actions, and the one cold-source reads.
    expect(raw.video_thruplay_watched_actions).toEqual([{ action_type: 'video_view', value: 90 }]);
  });

  it('re-injects video_view from videoPlays when the actions list dropped it', () => {
    const raw = toRawAdDay(insightRow({ actions: [{ type: 'purchase', value: 2 }] }))!;
    expect(raw.actions).toContainEqual({ action_type: 'video_view', value: 300 });
  });

  it('refuses a row it cannot identify, and tolerates junk fields', () => {
    expect(toRawAdDay(null)).toBeNull();
    expect(toRawAdDay({ entityId: '', date: '2026-08-01' })).toBeNull();
    expect(toRawAdDay(insightRow({ date: null }))).toBeNull();
    const raw = toRawAdDay(insightRow({ spend: 'twelve', actions: 'nope', thruplays: null }))!;
    expect(raw.spend).toBe(0);
    expect(raw.video_thruplay_watched_actions).toEqual([]);
  });
});

describe('fetchTinkersAdDays', () => {
  it('pulls 180 days as six ≤31-day windows — their functions stop at 300s, so the slicing IS the contract', async () => {
    state.reads['ad-days'] = { json: { ok: true, rows: [insightRow()], partial: false } };
    const pull = await fetchTinkersAdDays('aud_1', { asOf: '2026-08-20' });

    const windows = state.calls.filter((c) => c.url.includes('/ad-days'));
    expect(windows).toHaveLength(6);
    for (const w of windows) {
      const since = new Date(`${w.url.match(/since=([\d-]+)/)![1]}T00:00:00Z`).getTime();
      const until = new Date(`${w.url.match(/until=([\d-]+)/)![1]}T00:00:00Z`).getTime();
      const days = (until - since) / 86_400_000 + 1;
      expect(days).toBeGreaterThan(0);
      expect(days).toBeLessThanOrEqual(31);
    }
    expect(pull.adDays).toHaveLength(6);
    expect(pull.failedSlices).toBe(0);
  });

  it('a failed window costs that window, never the audit', async () => {
    const good = { json: { ok: true, rows: [insightRow()], partial: false } };
    state.reads['ad-days'] = [good, { status: 502, json: {} }, good, good, good, good];

    const pull = await fetchTinkersAdDays('aud_1', { asOf: '2026-08-20' });
    expect(pull.failedSlices).toBe(1);
    expect(pull.adDays).toHaveLength(5);
    expect(state.logs.some((l) => l.includes('window failed'))).toBe(true);
  });
});

describe('fetchTinkersDestinations + fetchTinkersStoreMedia', () => {
  it('maps landing urls to paths AND full urls, and skips what it cannot parse', async () => {
    state.reads.creatives = {
      json: {
        ok: true,
        creatives: [
          { adId: 'ad_1', adName: 'A', landingUrl: 'https://shop.example/products/hoodie?x=1', mediaType: 'video' },
          { adId: 'ad_2', adName: 'B', landingUrl: 'fb.me/whatever', mediaType: 'image' },
          { adId: 'ad_3', adName: 'C', landingUrl: null, mediaType: null },
        ],
      },
    };
    // The path feeds the landing chapter; the full url (query dropped, it is
    // per-ad tracking) is what the site walk can actually fetch.
    await expect(fetchTinkersDestinations('aud_1')).resolves.toEqual({
      destinations: { ad_1: { market: null, path: '/products/hoodie' } },
      landingUrls: { ad_1: 'https://shop.example/products/hoodie' },
    });
  });

  it('store media arrives keyed by ad id; a not-ready answer degrades to null', async () => {
    state.reads['creative-media'] = {
      json: {
        ok: true,
        ads: [{ adId: 'ad_1', body: 'Buy the hoodie', headline: 'Hoodie', videoUrl: 'https://signed/video.mp4', imageUrl: null, posterUrl: 'https://signed/poster.jpg' }],
      },
    };
    const media = await fetchTinkersStoreMedia('aud_1', ['ad_1']);
    expect(media?.get('ad_1')).toEqual({
      body: 'Buy the hoodie',
      title: 'Hoodie',
      video_url: 'https://signed/video.mp4',
      image_url: null,
      poster_url: 'https://signed/poster.jpg',
    });

    state.reads['creative-media'] = { json: { ok: false, reason: 'media_store_unconfigured' } };
    await expect(fetchTinkersStoreMedia('aud_1', ['ad_1'])).resolves.toBeNull();
    expect(await fetchTinkersStoreMedia('aud_1', [])).toBeNull();
  });
});

describe('fetchTinkersLeadContext — what the owner told us, contained', () => {
  it('prefers the funnel answer and says it came from signup', async () => {
    state.reads.context = {
      json: {
        ok: true,
        goal: { metric: 'cpl', value: 40 },
        grossMarginPct: 62,
        interview: { who_runs_ads: 'an agency', pain_point: 'nobody buys', tried: ['lookalikes'], agency_fee: '2000/mo' },
        rivals: ['acme', 'globex'],
        accountTarget: { metric: 'cpl', value: 55 },
      },
    };
    const ctx = await fetchTinkersLeadContext('aud_1');
    expect(ctx).toEqual({
      goalMetric: 'cpl',
      goalValue: 40,
      goalSource: 'signup',
      grossMarginPct: 62,
      interview: { who_runs_ads: 'an agency', pain_point: 'nobody buys', tried: ['lookalikes'], agency_fee: '2000/mo' },
      rivals: ['acme', 'globex'],
    });
    // Read like every other generation read: Bearer authorized, never signed.
    const call = state.calls.find((c) => c.url.includes('/context'))!;
    expect(call.auth).toBe('Bearer seam-secret');
    expect(call.signature).toBeNull();
  });

  it('falls back to the account target and says THAT is where it came from', async () => {
    state.reads.context = { json: { ok: true, goal: null, grossMarginPct: null, accountTarget: { metric: 'roas', value: 3 } } };
    const ctx = await fetchTinkersLeadContext('aud_1');
    expect(ctx).toMatchObject({ goalMetric: 'roas', goalValue: 3, goalSource: 'account' });
    expect(ctx!.interview).toBeNull();
  });

  it('an org that told us nothing is a domain state, not an error', async () => {
    state.reads.context = { json: { ok: true, goal: null, grossMarginPct: null, interview: null, rivals: [], accountTarget: null } };
    const ctx = await fetchTinkersLeadContext('aud_1');
    expect(ctx).toMatchObject({ goalMetric: null, goalValue: null, goalSource: null, grossMarginPct: null });
  });

  it('a 404, a not-ready answer, a broken contract and an outage all cost the same nothing', async () => {
    for (const read of [
      { status: 404, json: { error: 'not found' } },
      { json: { ok: false, reason: 'no_connection' } },
      { json: { ok: true, goal: { metric: 'cpl' } } },
      { throws: new Error('socket hang up') },
    ]) {
      state.reads.context = read;
      await expect(fetchTinkersLeadContext('aud_1')).resolves.toBeNull();
    }
    expect(state.logs.filter((l) => l.includes('context read')).length).toBe(4);
  });
});

describe('topSpendingAdIds', () => {
  it('ranks by spend inside the core window and ignores rows before it', () => {
    const rows = [
      { ad_id: 'old', date_start: '2026-05-01', spend: 999 },
      { ad_id: 'small', date_start: '2026-08-10', spend: 1 },
      { ad_id: 'big', date_start: '2026-08-10', spend: 50 },
      { ad_id: 'big', date_start: '2026-08-11', spend: 50 },
    ];
    expect(topSpendingAdIds(rows, '2026-07-21', 2)).toEqual(['big', 'small']);
  });

  it('asks for the media of the ads in a DORMANT account\'s own last month', () => {
    const rows = [
      { ad_id: 'ran-in-may', date_start: '2026-05-20', spend: 400 },
      { ad_id: 'ran-in-february', date_start: '2026-02-20', spend: 900 },
    ];
    // The core window of an account whose last spending day was 2026-05-20.
    expect(topSpendingAdIds(rows, '2026-04-20', 2)).toEqual(['ran-in-may']);
  });
});

describe('reportAuditUpdate', () => {
  it('sends every content payload as a partial, and seals with a contentless finalize', async () => {
    state.responses.push({ json: { received: true, recorded: true } });
    await reportAuditUpdate('aud_1', { costUsd: 1.5 });
    expect(JSON.parse(state.calls[0]!.body!)).toEqual({ auditId: 'aud_1', partial: true, costUsd: 1.5 });
    expect(state.calls[0]!.url).toBe('https://tinkers.test/api/webhooks/audit-complete');

    // The finalize call stays tiny no matter how fat the report got — that is
    // the whole point of splitting it off the last content payload.
    state.responses.push({ json: { received: true, recorded: true } });
    await reportAuditFinalize('aud_1');
    expect(JSON.parse(state.calls[1]!.body!)).toEqual({ auditId: 'aud_1', finalize: true });
    expect(state.calls[1]!.body!.length).toBeLessThan(64);
  });

  it('is fail-soft: a transport failure warns instead of throwing', async () => {
    state.responses.push({ throws: new Error('socket hang up') });
    await expect(reportAuditUpdate('aud_1', { costUsd: 1 })).resolves.toBeUndefined();
    expect(state.logs.some((l) => l.startsWith('warn'))).toBe(true);
  });

  it('warns (but does not retry) when Tinkers received without recording', async () => {
    state.responses.push({ json: { received: true, recorded: false } });
    await reportAuditUpdate('aud_1', { costUsd: 1 });
    expect(state.calls).toHaveLength(1);
    expect(state.logs.some((l) => l.includes('not recorded'))).toBe(true);
  });

  it('never lets an unrecorded FINAL report read as a failed audit', async () => {
    // Tinkers only accepts content writes while the audit is RUNNING, so a
    // finalize that timed out here but landed there answers recorded:false on
    // the retry — with the audit complete and its email already sent.
    state.responses.push({ json: { received: true, recorded: false } });
    await reportAuditFinalize('aud_1');

    const line = state.logs.find((l) => l.includes('not recorded'))!;
    expect(line).toContain('audit may already be sealed');
    expect(line).toContain('the sweep reconciles if not');
    expect(line).not.toMatch(/failed|error|rejected/i);
  });
});

describe('toTinkersPatch', () => {
  it('maps our snake_case columns to the seam contract', () => {
    expect(
      toTinkersPatch({
        sections: { a: 1 },
        scorecard: [{ key: 'hooks' }],
        lead_insights: [{ headline: 'h' }],
        recognition: { ads_count: 4 },
        work_log: [{ at: 't', line: 'l' }],
        cost_usd: 3.25,
      }),
    ).toEqual({
      sections: { a: 1 },
      scorecard: [{ key: 'hooks' }],
      leadInsights: [{ headline: 'h' }],
      recognition: { ads_count: 4 },
      workLog: [{ at: 't', line: 'l' }],
      costUsd: 3.25,
    });
  });

  it('carries only the keys present, and drops columns that are ours alone', () => {
    expect(toTinkersPatch({ work_log: [], status: 'complete', updated_at: 'now' })).toEqual({ workLog: [] });
    expect(toTinkersPatch({})).toEqual({});
  });
});

describe('token hygiene', () => {
  it('redacts token-shaped text anywhere in a message', () => {
    expect(redactSecrets('GET https://graph.facebook.com/act_1?access_token=EAAsecret&x=1 failed')).toBe(
      'GET https://graph.facebook.com/act_1?access_token=[redacted]&x=1 failed',
    );
    expect(redactSecrets('token EAAB1234abcd rejected')).toBe('token [redacted-token] rejected');
    expect(redactSecrets('audit-context returned 500')).toBe('audit-context returned 500');
  });

  it('a token-shaped upstream error never reaches a log line', async () => {
    state.responses.push({ throws: new Error('upstream rejected token EAA-super-secret-token') });
    await reportAuditUpdate('aud_1', { costUsd: 1 });

    const logged = state.logs.join('\n');
    expect(logged).not.toContain('EAA');
    expect(logged).toContain('upstream rejected token'); // the message still lands, just not the secret
  });
});

describe('hasReportContent', () => {
  it('is false for a payload Tinkers would store nothing from', () => {
    expect(hasReportContent({})).toBe(false);
    expect(hasReportContent({ costUsd: 4.5 })).toBe(false); // the orchestrator's status write maps to this
    expect(hasReportContent({ sections: {} })).toBe(true);
    expect(hasReportContent({ workLog: [], costUsd: 1 })).toBe(true);
  });
});

describe('runBridgedColdAudit reporting', () => {
  const SNAKE_KEYS = ['lead_insights', 'work_log', 'cost_usd', 'ads_count'];

  const runBridge = async (): Promise<Array<Record<string, unknown>>> => {
    for (let i = 0; i < 12; i += 1) state.responses.push({ json: { received: true, recorded: true } });
    await runBridgedColdAudit({ organizationId: 'org_1', auditId: 'aud_1' });
    return state.calls
      .filter((c) => c.url.endsWith('/audit-complete'))
      .map((c) => JSON.parse(c.body!) as Record<string, unknown>);
  };

  it('maps EVERY payload, not just the last one', async () => {
    const posted = await runBridge();

    for (const body of posted) {
      // Tinkers' zod strips unknown keys: a snake_case key at the TOP LEVEL of a
      // payload reads as no content at all — recorded:false, sections silently
      // lost, HTTP 200. Nothing may leave here in our column names.
      for (const key of Object.keys(body)) {
        expect(SNAKE_KEYS).not.toContain(key);
        expect(key).not.toMatch(/_/);
      }
    }

    // Contract v1.1: content is ALL partials — the accumulated row included —
    // and the run ends with the contentless finalize.
    expect(posted.map((b) => Object.keys(b).filter((k) => k !== 'auditId' && k !== 'partial'))).toEqual([
      ['recognition'],
      ['workLog'],
      ['sections', 'costUsd'],
      ['scorecard'],
      ['leadInsights'],
      ['sections', 'scorecard', 'leadInsights', 'recognition', 'workLog', 'costUsd'],
      ['finalize'],
    ]);
    expect(posted.slice(0, -1).every((b) => b.partial === true)).toBe(true);
  });

  it('runs the audit TOKENLESS: the cold injection carries no credential', async () => {
    await runBridge();
    const cold = state.magicAuditOptions?.cold as Record<string, unknown>;
    expect(cold.accessToken).toBeNull();
    expect(cold.adAccountId).toBe('act_123');
    expect(cold.accountName).toBe('Acme');
    expect(cold.currency).toBe('EUR');
    // Nothing stated yet: the audit runs on its honest defaults.
    expect(cold.goalMetric).toBeNull();
    expect(cold.grossMarginPct).toBeNull();
  });

  it('threads the owner\'s own goal, margin and answers into the audit', async () => {
    state.reads.context = {
      json: {
        ok: true,
        goal: { metric: 'cpl', value: 40 },
        grossMarginPct: 62,
        interview: { who_runs_ads: 'me', pain_point: 'no purchases', tried: [], agency_fee: null },
        rivals: [],
        accountTarget: null,
      },
    };
    await runBridge();
    const cold = state.magicAuditOptions?.cold as Record<string, unknown>;
    expect(cold.goalMetric).toBe('cpl');
    expect(cold.goalValue).toBe(40);
    expect(cold.goalSource).toBe('signup');
    expect(cold.grossMarginPct).toBe(62);
    expect(cold.interview).toEqual({ who_runs_ads: 'me', pain_point: 'no purchases', tried: [], agency_fee: null });
  });

  it('a context endpoint that is not there yet costs the target, never the audit', async () => {
    state.reads.context = { status: 404, json: { error: 'not found' } };
    const posted = await runBridge();
    const cold = state.magicAuditOptions?.cold as Record<string, unknown>;
    expect(cold.goalMetric).toBeNull();
    expect(cold.goalSource).toBeNull();
    expect(cold.interview).toBeNull();
    // The audit still ran and still sealed.
    expect(posted.at(-1)).toEqual({ auditId: 'aud_1', finalize: true });
  });

  it('skips the contentless cost-only patch instead of earning a warning for it', async () => {
    // The orchestrator's closing { status, cost_usd } write maps to costUsd
    // alone, which Tinkers reads as no content — posting it would warn on every
    // healthy run.
    const posted = await runBridge();
    // Five of the six orchestrator patches carry content; the sixth is dropped.
    // The accumulated row then goes out as one more partial.
    const partials = posted.filter((b) => b.partial === true);
    expect(partials).toHaveLength(state.orchestratorPatches.length - 1 + 1);
    expect(partials.some((b) => Object.keys(b).join() === 'auditId,partial,costUsd')).toBe(false);
    expect(state.logs.some((l) => l.includes('not recorded'))).toBe(false);
  });

  it('seals with a tiny finalize carrying no content, after the whole report is stored', async () => {
    const posted = await runBridge();
    const finalize = posted.at(-1)!;
    const lastContent = posted.at(-2)!;

    expect(finalize).toEqual({ auditId: 'aud_1', finalize: true });
    expect(lastContent).toEqual({
      auditId: 'aud_1',
      partial: true,
      sections: { creative_fatigue: { status: 'complete' } },
      recognition: { ads_count: 12 },
      workLog: [{ at: 'ts', line: 'Read 12 ads' }],
      scorecard: [{ key: 'hooks', band: 'weak' }],
      leadInsights: [{ headline: 'Top ad is fatiguing' }],
      costUsd: 4.5,
    });
  });

  it('stores the report but NEVER finalizes when the run ended in error', async () => {
    // Finalizing would flip their row COMPLETE and burn the one-ever "I found
    // something" email on a broken report. Their 24h fallback rail is the
    // honest treatment instead.
    state.orchestratorPatches = [{ sections: { creative_fatigue: { status: 'error' } } }, { status: 'error', cost_usd: 1 }];
    state.finalRowState = { sections: { creative_fatigue: { status: 'error' } }, cost_usd: 1, status: 'error' };

    const posted = await runBridge();

    expect(posted.every((b) => b.partial === true)).toBe(true);
    expect(posted.some((b) => b.finalize === true)).toBe(false);
    expect(posted.at(-1)).toMatchObject({ sections: { creative_fatigue: { status: 'error' } }, costUsd: 1 });
    expect(state.logs.some((l) => l.includes('not finalizing'))).toBe(true);
  });

  it('reports to the auditId the trigger named', async () => {
    const posted = await runBridge();
    expect(posted.every((b) => b.auditId === 'aud_1')).toBe(true);
  });

  it('redacts token-shaped strings INSIDE the payload, not just the log line', async () => {
    // Section errors carry raw err.message, and this content is rendered on a
    // public /audit/<token> page — a token in a section error would be publish
    // -to-the-web, not just log noise.
    const leaked = 'insights slice failed: https://graph.facebook.com/v21.0/act_1/insights?access_token=EAAsecretlive';
    state.orchestratorPatches = [{ sections: { creative_fatigue: { status: 'error', error: leaked } } }];
    state.finalRowState = { sections: { creative_fatigue: { status: 'error', error: leaked } }, status: 'complete' };

    const posted = await runBridge();
    const wire = JSON.stringify(posted);

    expect(wire).not.toContain('EAAsecretlive');
    expect(wire).toContain('access_token=[redacted]');
    expect(wire).toContain('insights slice failed'); // the honest error survives
  });
});

describe('runBridgedColdAudit idempotency', () => {
  it('refuses a second concurrent trigger for the same org, but not for another', async () => {
    // Two tinkers pulls and two LLM bills interleaving partials into one row is
    // what a double-click costs without this — the trigger is fire-and-forget
    // and cannot see an audit that started a second ago.
    let release: () => void = () => {};
    state.holdRun = new Promise<void>((r) => {
      release = r;
    });
    for (let i = 0; i < 24; i += 1) state.responses.push({ json: { received: true, recorded: true } });

    const first = runBridgedColdAudit({ organizationId: 'org_1', auditId: 'aud_1' });
    await new Promise((r) => setTimeout(r, 0));

    await expect(runBridgedColdAudit({ organizationId: 'org_1', auditId: 'aud_1' })).resolves.toEqual({
      status: 'skipped',
      reason: 'already_running',
    });
    expect(state.logs.some((l) => l.includes('already running'))).toBe(true);
    expect(state.calls.filter((c) => c.url.includes('/account'))).toHaveLength(1);

    release();
    await expect(first).resolves.toMatchObject({ status: 'complete' });

    // And the guard releases: the same org can be audited again afterwards.
    state.holdRun = undefined;
    state.responses.length = 0;
    for (let i = 0; i < 12; i += 1) state.responses.push({ json: { received: true, recorded: true } });
    await expect(runBridgedColdAudit({ organizationId: 'org_1', auditId: 'aud_1' })).resolves.toMatchObject({ status: 'complete' });
  });
});

describe('the account-structure reads', () => {
  const adSetsBody = {
    ok: true,
    adSets: [
      { adsetId: 'as_1', name: 'Broad prospecting', effectiveStatus: 'ACTIVE', optimizationGoal: 'OFFSITE_CONVERSIONS', promotedObjectEventType: 'PURCHASE', campaignId: 'c_1' },
      { adsetId: 'as_2', name: null, effectiveStatus: 'PAUSED', optimizationGoal: null, promotedObjectEventType: null, campaignId: null },
    ],
    partial: false,
  };

  it('every one of them is Bearer authorized, and none of them is signed', async () => {
    state.reads['ad-sets'] = { json: adSetsBody };
    state.reads['adset-insights'] = { json: { ok: true, rows: [], partial: false } };
    state.reads.breakdown = { json: { ok: true, rows: [], partial: false } };
    state.reads.activity = { json: { ok: true, changes: [], partial: false } };
    state.reads.targeting = { json: { ok: true, adSets: [], audiences: [], partial: false } };
    state.reads.pixels = { json: { ok: true, pixels: [], partial: false } };

    await fetchTinkersAdSets('aud_1');
    await fetchTinkersAdSetInsights('aud_1', { since: '2026-07-21', until: '2026-08-19', granularity: 'total' });
    await fetchTinkersBreakdown('aud_1', { dimension: 'placement', since: '2026-07-21', until: '2026-08-19' });
    await fetchTinkersActivity('aud_1', { since: '2026-07-21', until: '2026-08-19' });
    await fetchTinkersTargeting('aud_1');
    await fetchTinkersPixels('aud_1');

    expect(state.calls.map((c) => c.url.replace('https://tinkers.test/api/generation/aud_1', ''))).toEqual([
      '/ad-sets',
      '/adset-insights?since=2026-07-21&until=2026-08-19&granularity=total',
      '/breakdown?dimension=placement&since=2026-07-21&until=2026-08-19',
      '/activity?since=2026-07-21&until=2026-08-19',
      '/targeting',
      '/pixels',
    ]);
    for (const call of state.calls) {
      expect(call.method).toBe('GET');
      expect(call.auth).toBe('Bearer seam-secret');
      expect(call.signature).toBeNull();
    }
  });

  it('hands the ad-set rows over with their nulls intact', async () => {
    state.reads['ad-sets'] = { json: adSetsBody };
    const read = await fetchTinkersAdSets('aud_1');
    expect(read).toEqual({
      state: 'ok',
      partial: false,
      data: [
        { adsetId: 'as_1', name: 'Broad prospecting', effectiveStatus: 'ACTIVE', optimizationGoal: 'OFFSITE_CONVERSIONS', promotedObjectEventType: 'PURCHASE', campaignId: 'c_1' },
        { adsetId: 'as_2', name: null, effectiveStatus: 'PAUSED', optimizationGoal: null, promotedObjectEventType: null, campaignId: null },
      ],
    });
  });

  it('surfaces the partial flag rather than reporting a short read as a whole one', async () => {
    state.reads['ad-sets'] = { json: { ...adSetsBody, partial: true } };
    state.reads.breakdown = { json: { ok: true, rows: [insightRow()], partial: true } };
    state.reads.pixels = { json: { ok: true, pixels: [{ id: 'px' }], partial: true } };
    expect((await fetchTinkersAdSets('aud_1')).partial).toBe(true);
    expect((await fetchTinkersBreakdown('aud_1', { dimension: 'country', since: '2026-08-01', until: '2026-08-19' })).partial).toBe(true);
    expect((await fetchTinkersPixels('aud_1')).partial).toBe(true);
  });

  it('a 404 is the endpoint not being deployed yet, and the section stays PLANNED', async () => {
    // These six paths ship on Tinkers' own schedule. Until they land, the
    // sections reading them must be the honest gap they already were, never an
    // error on a customer's report.
    for (const read of ['ad-sets', 'adset-insights', 'breakdown', 'activity', 'targeting', 'pixels']) {
      state.reads[read] = { status: 404, json: { error: { code: 'NOT_FOUND' } } };
    }
    const reads = tinkersSeamReads('aud_1');
    const outcomes = [
      await reads.adSets(),
      await reads.adSetInsights({ since: '2026-08-01', until: '2026-08-19', granularity: 'weekly' }),
      await reads.breakdown({ dimension: 'user_segment', since: '2026-08-01', until: '2026-08-19' }),
      await reads.activity({ since: '2026-08-01', until: '2026-08-19' }),
      await reads.targeting(),
      await reads.pixels(),
    ];
    expect(outcomes.map((o) => o.state)).toEqual(Array(6).fill('not_deployed'));
    for (const outcome of outcomes) expect(seamGapFor(outcome as never, 'the read').status).toBe('planned');
    expect(state.logs.some((l) => l.includes('not deployed yet'))).toBe(true);
  });

  it('an ok:false reason SKIPS the section and travels as data', async () => {
    state.reads.activity = { json: { ok: false, reason: 'activity_read_unsupported' } };
    state.reads.targeting = { json: { ok: false, reason: 'targeting_read_unsupported' } };
    state.reads.pixels = { json: { ok: false, reason: 'pixel_read_unsupported' } };

    const activity = await fetchTinkersActivity('aud_1', { since: '2026-08-01', until: '2026-08-19' });
    const targeting = await fetchTinkersTargeting('aud_1');
    const pixels = await fetchTinkersPixels('aud_1');
    expect(activity).toEqual({ state: 'unsupported', reason: 'activity_read_unsupported' });
    expect(targeting).toEqual({ state: 'unsupported', reason: 'targeting_read_unsupported' });
    expect(pixels).toEqual({ state: 'unsupported', reason: 'pixel_read_unsupported' });

    // "I cannot see the change history" and "nothing changed" are different
    // sentences, and this is the one that keeps them apart.
    const gap = seamGapFor(activity as never, "this account's change history");
    expect(gap.status).toBe('skipped');
    expect(gap.data).toMatchObject({ unavailable_reason: 'activity_read_unsupported' });
  });

  it('a 502, a dead socket and a broken contract are all the honest error', async () => {
    state.reads.breakdown = { status: 502, json: {} };
    expect(await fetchTinkersBreakdown('aud_1', { dimension: 'placement', since: '2026-08-01', until: '2026-08-19' })).toMatchObject({ state: 'failed' });

    state.reads.breakdown = { throws: new Error('socket hang up') };
    expect(await fetchTinkersBreakdown('aud_1', { dimension: 'placement', since: '2026-08-01', until: '2026-08-19' })).toMatchObject({
      state: 'failed',
      reason: 'socket hang up',
    });

    state.reads['ad-sets'] = { json: { ok: true, adSets: [{ name: 'no id' }] } };
    expect(await fetchTinkersAdSets('aud_1')).toMatchObject({ state: 'failed' });
  });

  it('a token-shaped upstream failure never reaches a log line or a reason', async () => {
    state.reads.pixels = { throws: new Error('upstream rejected token EAA-super-secret-token') };
    const read = await fetchTinkersPixels('aud_1');
    expect(JSON.stringify(read)).not.toContain('EAA');
    expect(state.logs.join('\n')).not.toContain('EAA');
  });

  it('carries the changes and the audiences under the names the mappers read', async () => {
    state.reads.activity = {
      json: { ok: true, changes: [{ key: 'k1', at: '2026-08-10T09:00:00Z', kind: 'paused', objectId: 'ad_1', objectType: 'AD', providerEventType: 'update_ad_run_status' }], partial: false },
    };
    state.reads.targeting = {
      json: {
        ok: true,
        adSets: [{ adsetId: 'as_1', adsetName: 'LAL 1%', targetingClass: 'broad', signals: {} }],
        audiences: [{ id: 'aud_1', name: 'Purchasers', subtype: 'website' }],
        partial: false,
      },
    };
    const activity = await fetchTinkersActivity('aud_1', { since: '2026-08-01', until: '2026-08-19' });
    expect(activity.state === 'ok' && activity.data).toHaveLength(1);
    const targeting = await fetchTinkersTargeting('aud_1');
    expect(targeting.state === 'ok' && targeting.data.adSets).toHaveLength(1);
    expect(targeting.state === 'ok' && targeting.data.audiences).toHaveLength(1);
  });

  it('an absent audience list is an empty one, never undefined downstream', async () => {
    state.reads.targeting = { json: { ok: true, adSets: [], partial: false } };
    const read = await fetchTinkersTargeting('aud_1');
    expect(read.state === 'ok' && read.data.audiences).toEqual([]);
  });

  it('an unconfigured seam fails the read without any call leaving', async () => {
    state.secret = undefined;
    const read = await fetchTinkersPixels('aud_1');
    expect(read.state).toBe('failed');
    expect(state.calls).toHaveLength(0);
  });
});

describe('runBridgedColdAudit hands the reads to the audit', () => {
  it('the cold injection carries the six seam reads, still with no credential', async () => {
    for (let i = 0; i < 12; i += 1) state.responses.push({ json: { received: true, recorded: true } });
    await runBridgedColdAudit({ organizationId: 'org_1', auditId: 'aud_1' });
    const cold = state.magicAuditOptions?.cold as Record<string, unknown>;
    const seam = cold.seam as Record<string, unknown>;
    expect(Object.keys(seam).sort()).toEqual(['activity', 'adSetInsights', 'adSets', 'breakdown', 'pixels', 'targeting']);
    for (const fn of Object.values(seam)) expect(typeof fn).toBe('function');
    expect(cold.accessToken).toBeNull();
  });

  it('the reads are bound to the audit id the trigger named', async () => {
    for (let i = 0; i < 12; i += 1) state.responses.push({ json: { received: true, recorded: true } });
    await runBridgedColdAudit({ organizationId: 'org_1', auditId: 'aud_42' });
    const seam = (state.magicAuditOptions?.cold as { seam: TinkersSeamReads }).seam;
    state.reads.pixels = { json: { ok: true, pixels: [], partial: false } };
    await seam.pixels();
    // The audit id is the tenant capability: a read bound to another one could
    // not resolve a tenant at all.
    expect(state.calls.at(-1)!.url).toBe('https://tinkers.test/api/generation/aud_42/pixels');
  });
});
