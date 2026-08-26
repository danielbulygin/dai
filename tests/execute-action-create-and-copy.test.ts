import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The two build verbs on the approve rail: create a campaign, copy an ad set
 * into it with a different optimization event.
 *
 * WHY these tests exist. Three of the four properties below were silently
 * missing, and each one fails in a way the customer would have been told the
 * opposite about:
 *
 *  1. `/copies` carries the SOURCE's settings over. An optimization event the
 *     customer approved is therefore not applied by copying — it is applied by
 *     a second write onto the copy, or it never happens while the card says it
 *     did. The same is true of the attribution window, which nobody can correct
 *     once the ad set exists.
 *  2. That second write is an edit, so it is only allowed while the copy has
 *     never spent. The assertion is a real read: an insights call that FAILS is
 *     not a zero, it is a refusal to write.
 *  3. Growing the fence with the new campaign id was best effort with a
 *     console.error. A silent failure there leaves a campaign that exists and
 *     that no follow-up copy can ever land in — so it is a failed action now,
 *     and the failure names the id of the campaign that does exist.
 *  4. The read-back is the only thing allowed to claim anything, so it has to
 *     carry what the portal judges. Adding a campaign budget makes Meta quietly
 *     set LOWEST_COST_WITH_BID_CAP; a bid strategy nobody chose is invisible
 *     unless it is read back by name.
 *
 * Meta is mocked at `fetch` and Supabase at the client, so every Graph request
 * and every fence write is visible in `state` and nothing leaves the process.
 */

const { state } = vi.hoisted(() => {
  process.env.META_ACCESS_TOKEN = 'TEST-ONLY-NOT-A-REAL-TOKEN';
  return {
    state: {
      clients: {} as Record<string, Record<string, unknown>>,
      guardSettings: {} as Record<string, Record<string, unknown>>,
      graph: [] as Array<{ method: string; path: string; params: Record<string, string> }>,
      routes: {} as Record<string, Record<string, unknown>>,
      writes: [] as Array<Record<string, unknown>>,
      /** Every payload handed to `clients.update()`, in order. */
      fenceUpdates: [] as Array<Record<string, unknown>>,
      /** PostgREST reports a failed update by RETURNING an error, not throwing. */
      fenceUpdateError: '' as string,
      /** An update that matched no row: no error, and the row comes back unchanged. */
      fenceUpdateSilent: false,
      /** The transport itself failing. */
      fenceUpdateThrows: false,
    },
  };
});

vi.mock('../src/integrations/supabase.js', () => ({
  getSupabase: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = { _key: '', _update: null };
      const chain = () => q;
      Object.assign(q, {
        select: chain,
        limit: chain,
        not: chain,
        order: chain,
        update: (payload: Record<string, unknown>) => {
          q._update = payload;
          return q;
        },
        eq: (_column: string, value: string) => {
          q._key = value;
          return q;
        },
        maybeSingle: async () => {
          const key = String(q._key);
          if (q._update) {
            state.fenceUpdates.push(q._update as Record<string, unknown>);
            if (state.fenceUpdateThrows) throw new Error('supabase unreachable');
            if (state.fenceUpdateError) return { data: null, error: { message: state.fenceUpdateError } };
            if (state.fenceUpdateSilent) {
              return { data: { allowed_campaign_ids: state.clients[key]?.allowed_campaign_ids }, error: null };
            }
            const grown = (q._update as { allowed_campaign_ids?: string[] }).allowed_campaign_ids ?? [];
            if (state.clients[key]) state.clients[key].allowed_campaign_ids = grown;
            return { data: { allowed_campaign_ids: grown }, error: null };
          }
          if (table === 'clients') return { data: state.clients[key] ?? null, error: null };
          if (table === 'guard_settings') return { data: state.guardSettings[key] ?? null, error: null };
          return { data: null, error: null };
        },
      });
      return q;
    },
  }),
}));

vi.mock('../src/agents/action-log.js', () => ({
  logWrite: (input: Record<string, unknown>) => {
    state.writes.push(input);
  },
  logToolCall: () => {},
}));

const { handleExecuteAction } = await import('../scripts/ada-console-assist.js');

const FENCED_CAMPAIGN = '120000000000001';
const NEW_CAMPAIGN = '120000000000777';
const SOURCE_ADSET = '6001';
const COPY_ADSET = '7777';

function graphFetch(url: string | URL, init?: { method?: string; body?: unknown }) {
  const parsed = new URL(String(url));
  const path = parsed.pathname.replace(/^\/v\d+\.\d+\//, '');
  const method = init?.method ?? 'GET';
  const params: Record<string, string> = {};
  const source =
    method === 'GET' ? parsed.searchParams : new URLSearchParams(String(init?.body ?? ''));
  for (const [key, value] of source) if (key !== 'access_token') params[key] = value;
  state.graph.push({ method, path, params });
  const answer = state.routes[`${method} ${path}`] ?? { error: { message: `no route for ${method} ${path}` } };
  return Promise.resolve({ json: async () => answer } as unknown as Response);
}

const calls = (method: string, path: string) =>
  state.graph.filter((c) => c.method === method && c.path === path);

beforeEach(() => {
  state.clients = {
    AOT: {
      code: 'AOT',
      name: 'Ads on Tap',
      ad_account_id: 'act_100',
      allowed_campaign_ids: [FENCED_CAMPAIGN],
      max_daily_budget_usd: 600,
    },
  };
  state.guardSettings = { act_100: { mode: 'hitl', enabled: true, stopped_at: null } };
  state.graph = [];
  state.writes = [];
  state.routes = {};
  state.fenceUpdates = [];
  state.fenceUpdateError = '';
  state.fenceUpdateSilent = false;
  state.fenceUpdateThrows = false;
  vi.stubGlobal('fetch', vi.fn(graphFetch));
});

const run = (intent: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  handleExecuteAction({ client_code: 'AOT', user_id: 'u_1', intent, ...extra });

const CREATE_SETTINGS = {
  name: 'AOT // CBO // QualifiedSubscription Test',
  objective: 'OUTCOME_SALES',
  status: 'PAUSED',
  budget_mode: 'cbo',
  daily_budget_usd: 500,
  bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
};

function campaignRoutes() {
  state.routes['POST act_100/campaigns'] = { id: NEW_CAMPAIGN };
  state.routes[`GET ${NEW_CAMPAIGN}`] = {
    id: NEW_CAMPAIGN,
    name: CREATE_SETTINGS.name,
    status: 'PAUSED',
    effective_status: 'PAUSED',
    objective: 'OUTCOME_SALES',
    daily_budget: '50000',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    account_id: '100',
  };
}

describe('create_campaign — the read-back the portal judges', () => {
  it('asks Meta back for status, objective, budget, bid strategy and account', async () => {
    campaignRoutes();
    const out = await run({ type: 'create_campaign', target_id: 'act_100', settings: CREATE_SETTINGS });

    expect(out).toMatchObject({ ok: true, applied: true });
    const readBack = calls('GET', NEW_CAMPAIGN)[0];
    // Adding a campaign budget makes Meta silently set LOWEST_COST_WITH_BID_CAP.
    // A bid strategy nobody chose is a contradiction, not a detail.
    for (const field of ['status', 'objective', 'daily_budget', 'bid_strategy', 'account_id']) {
      expect(readBack.params.fields, `read-back must carry ${field}`).toContain(field);
    }
    expect(out.object).toMatchObject({ id: NEW_CAMPAIGN, bid_strategy: 'LOWEST_COST_WITHOUT_CAP' });
  });

  it('validates with Meta before creating, and writes nothing on a dry run', async () => {
    campaignRoutes();
    const out = await run(
      { type: 'create_campaign', target_id: 'act_100', settings: CREATE_SETTINGS },
      { dry_run: true },
    );

    expect(out).toMatchObject({ ok: true, dry_run: true, would_apply: true });
    const posts = calls('POST', 'act_100/campaigns');
    expect(posts).toHaveLength(1);
    expect(posts[0].params.execution_options).toContain('validate_only');
    expect(state.fenceUpdates).toHaveLength(0);
  });
});

describe('create_campaign — growing the fence is a step, not a courtesy', () => {
  it('adds the new campaign id, so a copy can land in it', async () => {
    campaignRoutes();
    await run({ type: 'create_campaign', target_id: 'act_100', settings: CREATE_SETTINGS });

    expect(state.fenceUpdates[0]).toEqual({ allowed_campaign_ids: [FENCED_CAMPAIGN, NEW_CAMPAIGN] });
  });

  it('FAILS the action when the fence write errors, naming the campaign that does exist', async () => {
    campaignRoutes();
    state.fenceUpdateError = 'permission denied for table clients';
    const out = await run({ type: 'create_campaign', target_id: 'act_100', settings: CREATE_SETTINGS });

    expect(out.ok).toBe(false);
    expect(out.error).toBe('fence_grow_failed');
    // The customer is told the campaign EXISTS. Reporting "nothing happened"
    // over a campaign Meta created is the one thing the write path forbids.
    expect(String(out.detail)).toContain(NEW_CAMPAIGN);
    expect(String(out.detail)).toContain('permission denied for table clients');
    expect(out.object).toMatchObject({ id: NEW_CAMPAIGN });
    // The write still reached the ledger — it happened, whatever the fence did.
    expect(state.writes[0]).toMatchObject({ toolName: 'execute_action:create_campaign', targetId: NEW_CAMPAIGN });
    expect(String((state.writes[0] as { summary: string }).summary)).toContain('FENCE GROW FAILED');
  });

  it('FAILS on an update that quietly matched nothing, not just on a loud error', async () => {
    campaignRoutes();
    state.fenceUpdateSilent = true;
    const out = await run({ type: 'create_campaign', target_id: 'act_100', settings: CREATE_SETTINGS });

    expect(out.error).toBe('fence_grow_failed');
    expect(String(out.detail)).toContain('read back without the new campaign id');
  });

  it('FAILS when the fence write throws', async () => {
    campaignRoutes();
    state.fenceUpdateThrows = true;
    const out = await run({ type: 'create_campaign', target_id: 'act_100', settings: CREATE_SETTINGS });

    expect(out.error).toBe('fence_grow_failed');
    expect(String(out.detail)).toContain('supabase unreachable');
  });

  it('still refuses a live create and a budget over the ceiling', async () => {
    campaignRoutes();
    const live = await run({
      type: 'create_campaign', target_id: 'act_100',
      settings: { ...CREATE_SETTINGS, status: 'ACTIVE' },
    });
    expect(String(live.refused)).toContain('PAUSED-only');

    const rich = await run({
      type: 'create_campaign', target_id: 'act_100',
      settings: { ...CREATE_SETTINGS, daily_budget_usd: 5000 },
    });
    expect(String(rich.refused)).toContain('ceiling');
    expect(state.graph.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

const COPY_SETTINGS = {
  destination_campaign_id: FENCED_CAMPAIGN,
  status: 'PAUSED',
  name: 'AOT // QS // Broad // Video 4',
  optimization_goal: 'OFFSITE_CONVERSIONS',
  promoted_object: { pixel_id: '999', custom_event_type: 'OTHER', custom_event_str: 'QualifiedSubscription' },
  attribution_spec: [
    { event_type: 'CLICK_THROUGH', window_days: 7 },
    { event_type: 'VIEW_THROUGH', window_days: 1 },
  ],
};

function copyRoutes(spend = '0') {
  state.routes[`GET ${SOURCE_ADSET}`] = {
    id: SOURCE_ADSET,
    name: 'AOT // Broad // Video 4',
    campaign_id: FENCED_CAMPAIGN,
    account_id: '100',
    optimization_goal: 'OFFSITE_CONVERSIONS',
    promoted_object: { pixel_id: '999', custom_event_type: 'PURCHASE' },
    // The SAME windows the card asks for, in Meta's own order: a copy
    // inherits these and can never be told different ones.
    attribution_spec: [
      { event_type: 'VIEW_THROUGH', window_days: 1 },
      { event_type: 'CLICK_THROUGH', window_days: 7 },
    ],
  };
  // No ads on the source: the page/lead-ToS pre-flight has nothing to sample
  // and is not what these tests are about.
  state.routes[`GET ${SOURCE_ADSET}/ads`] = { data: [] };
  state.routes[`POST ${SOURCE_ADSET}/copies`] = { copied_adset_id: COPY_ADSET };
  // The receipt's own count: a deep copy of a source with no ads has none.
  state.routes[`GET ${COPY_ADSET}/ads`] = { data: [], summary: { total_count: 0 } };
  state.routes[`GET ${COPY_ADSET}/insights`] = spend === '' ? { error: { message: 'insights unavailable' } } : { data: spend === '0' ? [] : [{ spend }] };
  state.routes[`POST ${COPY_ADSET}`] = { success: true };
  state.routes[`GET ${COPY_ADSET}`] = {
    id: COPY_ADSET,
    name: COPY_SETTINGS.name,
    status: 'PAUSED',
    effective_status: 'PAUSED',
    campaign_id: FENCED_CAMPAIGN,
    account_id: '100',
    optimization_goal: 'OFFSITE_CONVERSIONS',
    promoted_object: COPY_SETTINGS.promoted_object,
    attribution_spec: COPY_SETTINGS.attribution_spec,
  };
}

describe('duplicate_ad_set — the copy is told what the card promised', () => {
  it('writes the event, the promoted object and the name onto the COPY, and never the window', async () => {
    copyRoutes();
    const out = await run({ type: 'duplicate_ad_set', target_id: SOURCE_ADSET, settings: COPY_SETTINGS });

    expect(out).toMatchObject({ ok: true, applied: true });
    const configure = calls('POST', COPY_ADSET)[0];
    expect(configure.params.optimization_goal).toBe('OFFSITE_CONVERSIONS');
    expect(JSON.parse(configure.params.promoted_object)).toMatchObject({ custom_event_str: 'QualifiedSubscription' });
    expect(configure.params.name).toBe(COPY_SETTINGS.name);
    // Meta refuses attribution_spec on an ad set that exists, and it refuses it
    // as a generic "unexpected error" that kills the WHOLE post: on 2026-08-26
    // that took the rename down with it and orphaned the copy. The window the
    // card asked for is the source's own, verified before copying, so there is
    // nothing here to write.
    expect(configure.params.attribution_spec).toBeUndefined();
    // The SOURCE is read and never written to. That is the whole no-edits-
    // after-spend guarantee for this verb.
    expect(calls('POST', SOURCE_ADSET)).toHaveLength(0);
  });

  it('tells Meta to bring the source\u2019s ads along, because a copy without them cannot run', async () => {
    copyRoutes();
    await run({ type: 'duplicate_ad_set', target_id: SOURCE_ADSET, settings: COPY_SETTINGS });

    // deep_copy defaults to FALSE. Live on 2026-08-26 a source with 3 ads
    // produced a copy with 0 while the receipt said the ads had come with it.
    expect(calls('POST', `${SOURCE_ADSET}/copies`)[0].params.deep_copy).toBe('true');
  });

  it('names the copy in the account convention, not in a dash suffix', async () => {
    copyRoutes();
    await run({ type: 'duplicate_ad_set', target_id: SOURCE_ADSET, settings: COPY_SETTINGS });

    const rename = JSON.parse(calls('POST', `${SOURCE_ADSET}/copies`)[0].params.rename_options);
    expect(rename.rename_suffix).toBe(' // Ada copy');
    expect(rename.rename_suffix).not.toContain('ADA COPY');
  });

  it('reads back the fields the portal judges', async () => {
    copyRoutes();
    await run({ type: 'duplicate_ad_set', target_id: SOURCE_ADSET, settings: COPY_SETTINGS });

    const readBack = calls('GET', COPY_ADSET).at(-1);
    for (const field of ['status', 'campaign_id', 'optimization_goal', 'promoted_object', 'attribution_spec', 'bid_strategy', 'daily_budget']) {
      expect(readBack?.params.fields, `read-back must carry ${field}`).toContain(field);
    }
  });

  it('reads the copy back AFTER configuring it, so the answer shows what was set', async () => {
    copyRoutes();
    await run({ type: 'duplicate_ad_set', target_id: SOURCE_ADSET, settings: COPY_SETTINGS });

    const order = state.graph.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf(`POST ${COPY_ADSET}`)).toBeLessThan(order.lastIndexOf(`GET ${COPY_ADSET}`));
  });
});

describe('duplicate_ad_set — nothing is edited that has spent', () => {
  it('asserts the copy has never spent BEFORE it writes a field', async () => {
    copyRoutes();
    await run({ type: 'duplicate_ad_set', target_id: SOURCE_ADSET, settings: COPY_SETTINGS });

    const order = state.graph.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf(`GET ${COPY_ADSET}/insights`)).toBeGreaterThan(-1);
    expect(order.indexOf(`GET ${COPY_ADSET}/insights`)).toBeLessThan(order.indexOf(`POST ${COPY_ADSET}`));
  });

  it('refuses to configure an object that HAS spent, and says it must be rebuilt', async () => {
    copyRoutes('18400.12');
    const out = await run({ type: 'duplicate_ad_set', target_id: SOURCE_ADSET, settings: COPY_SETTINGS });

    expect(out.ok).toBe(false);
    expect(out.error).toBe('copy_not_configured');
    expect(calls('POST', COPY_ADSET)).toHaveLength(0);
    expect(String(out.detail)).toContain('18400.12');
    expect(String(out.detail)).toContain('rebuilt');
  });

  it('treats an insights read it could not make as "cannot prove", never as a zero', async () => {
    copyRoutes('');
    const out = await run({ type: 'duplicate_ad_set', target_id: SOURCE_ADSET, settings: COPY_SETTINGS });

    expect(out.error).toBe('copy_not_configured');
    expect(String(out.detail)).toContain('could not confirm');
    expect(calls('POST', COPY_ADSET)).toHaveLength(0);
  });

  it('does not ask about spend when there is nothing to write', async () => {
    copyRoutes();
    const out = await run({
      type: 'duplicate_ad_set', target_id: SOURCE_ADSET,
      settings: { destination_campaign_id: FENCED_CAMPAIGN },
    });

    expect(out).toMatchObject({ ok: true, applied: true });
    expect(calls('GET', `${COPY_ADSET}/insights`)).toHaveLength(0);
    expect(calls('POST', COPY_ADSET)).toHaveLength(0);
  });
});

describe('duplicate_ad_set — a shape Ada will not guess at', () => {
  it('refuses an attribution window that is only nearly right, before copying anything', async () => {
    copyRoutes();
    const out = await run({
      type: 'duplicate_ad_set', target_id: SOURCE_ADSET,
      settings: { ...COPY_SETTINGS, attribution_spec: [{ event_type: 'CLICK_THROUGH' }] },
    });

    expect(String(out.refused)).toContain('attribution_spec');
    expect(calls('POST', `${SOURCE_ADSET}/copies`)).toHaveLength(0);
  });

  it('refuses prose where an optimization goal belongs', async () => {
    copyRoutes();
    const out = await run({
      type: 'duplicate_ad_set', target_id: SOURCE_ADSET,
      settings: { ...COPY_SETTINGS, optimization_goal: 'mirror the existing ad sets' },
    });

    expect(String(out.refused)).toContain('optimization_goal');
    expect(calls('POST', `${SOURCE_ADSET}/copies`)).toHaveLength(0);
  });

  it('still refuses a destination outside the fence', async () => {
    copyRoutes();
    const out = await run({
      type: 'duplicate_ad_set', target_id: SOURCE_ADSET,
      settings: { ...COPY_SETTINGS, destination_campaign_id: '120000000000999' },
    });

    expect(String(out.refused)).toContain('campaign fence');
    expect(calls('POST', `${SOURCE_ADSET}/copies`)).toHaveLength(0);
  });

  it('says what it would set, and copies nothing, on a dry run', async () => {
    copyRoutes();
    const out = await run(
      { type: 'duplicate_ad_set', target_id: SOURCE_ADSET, settings: COPY_SETTINGS },
      { dry_run: true },
    );

    expect(out).toMatchObject({ ok: true, dry_run: true, would_apply: true });
    expect(String(out.detail)).toContain('optimization_goal');
    expect(String(out.detail)).toContain('deep copy');
    // The window is inherited, not set — and the dry run has to say so in the
    // words the customer asked in, or the receipt promises a write nobody makes.
    expect(String(out.detail)).toContain('inherits it from the source');
    expect(String(out.detail)).toContain('7-day click');
    expect(String(out.detail)).not.toContain('set attribution');
    expect(state.graph.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

describe('duplicate_ad_set — the window a copy can never be told', () => {
  it('refuses a window the source does not already have, BEFORE a copy exists', async () => {
    copyRoutes();
    const out = await run({
      type: 'duplicate_ad_set', target_id: SOURCE_ADSET,
      settings: {
        ...COPY_SETTINGS,
        attribution_spec: [
          { event_type: 'CLICK_THROUGH', window_days: 1 },
          { event_type: 'VIEW_THROUGH', window_days: 1 },
        ],
      },
    });

    expect(out.ok).toBe(false);
    // Nothing exists to clean up. The live failure on 2026-08-26 refused the
    // window AFTER the copy was made, leaving 120247820138370225 in the
    // account under the wrong name because the rename shared that same post.
    expect(calls('POST', `${SOURCE_ADSET}/copies`)).toHaveLength(0);
    expect(calls('POST', COPY_ADSET)).toHaveLength(0);
    // The refusal names both windows in words, and why it is a rebuild.
    expect(String(out.refused)).toContain('7-day click');
    expect(String(out.refused)).toContain('1-day view');
    expect(String(out.refused)).toContain('cannot be changed once an ad set exists');
    expect(String(out.refused)).toContain('built from scratch');
  });

  it('copies without asking for a window when the source already has the one wanted', async () => {
    copyRoutes();
    const out = await run({ type: 'duplicate_ad_set', target_id: SOURCE_ADSET, settings: COPY_SETTINGS });

    expect(out).toMatchObject({ ok: true, applied: true });
    expect(calls('POST', `${SOURCE_ADSET}/copies`)).toHaveLength(1);
    expect(calls('POST', COPY_ADSET)[0].params.attribution_spec).toBeUndefined();
  });
});

describe('duplicate_ad_set — the ads that come along are validated, not assumed', () => {
  function sourceWithOneAd() {
    copyRoutes();
    state.routes[`GET ${SOURCE_ADSET}/ads`] = { data: [{ id: '8001', creative: { id: 'c_1' } }] };
    state.routes['POST act_100/ads'] = { id: 'preflight-never-created' };
    state.routes[`GET ${COPY_ADSET}/ads`] = { data: [{ id: '9001' }], summary: { total_count: 3 } };
  }

  it('refuses when the ads on the source cannot be read, and copies nothing', async () => {
    copyRoutes();
    state.routes[`GET ${SOURCE_ADSET}/ads`] = { error: { message: 'Please reduce the amount of data' } };
    const out = await run({ type: 'duplicate_ad_set', target_id: SOURCE_ADSET, settings: COPY_SETTINGS });

    expect(out.ok).toBe(false);
    expect(String(out.refused)).toContain('Please reduce the amount of data');
    expect(String(out.refused)).toContain('Nothing has been copied');
    expect(calls('POST', `${SOURCE_ADSET}/copies`)).toHaveLength(0);
  });

  it('refuses when the sample ad fails the page gate, and copies nothing', async () => {
    sourceWithOneAd();
    state.routes['POST act_100/ads'] = {
      error: { message: 'You do not have access to create ads for this page' },
    };
    const out = await run({ type: 'duplicate_ad_set', target_id: SOURCE_ADSET, settings: COPY_SETTINGS });

    expect(out.ok).toBe(false);
    expect(String(out.refused)).toContain('page permission');
    expect(calls('POST', `${SOURCE_ADSET}/copies`)).toHaveLength(0);
  });

  it('validates the sample ad, then says how many ads arrived with the copy', async () => {
    sourceWithOneAd();
    const out = await run({ type: 'duplicate_ad_set', target_id: SOURCE_ADSET, settings: COPY_SETTINGS });

    expect(out).toMatchObject({ ok: true, applied: true, copiedAds: 3 });
    expect(calls('POST', 'act_100/ads')[0].params.execution_options).toContain('validate_only');
    expect(String((state.writes[0] as { summary: string }).summary)).toContain('arrived with 3 ads');
  });

  it('proceeds without the gate when the source has no ads, and counts the empty copy', async () => {
    copyRoutes();
    const out = await run({ type: 'duplicate_ad_set', target_id: SOURCE_ADSET, settings: COPY_SETTINGS });

    expect(out).toMatchObject({ ok: true, applied: true, copiedAds: 0 });
    // Nothing to sample means nothing to validate — an empty source honestly
    // yields an empty copy rather than an unvalidated one.
    expect(calls('POST', 'act_100/ads')).toHaveLength(0);
    expect(String((state.writes[0] as { summary: string }).summary)).toContain('arrived with 0 ads');
  });

  it('does not fail the step when the ad count cannot be read', async () => {
    copyRoutes();
    delete state.routes[`GET ${COPY_ADSET}/ads`];
    const out = await run({ type: 'duplicate_ad_set', target_id: SOURCE_ADSET, settings: COPY_SETTINGS });

    expect(out).toMatchObject({ ok: true, applied: true, copiedAds: null });
    expect(String((state.writes[0] as { summary: string }).summary)).toContain('ad count unknown');
  });
});

describe('duplicate_ad_set — reading the new id out of a deep copy', () => {
  it('takes the ADSET entry out of ad_object_ids, not the first one', async () => {
    copyRoutes();
    state.routes[`POST ${SOURCE_ADSET}/copies`] = {
      ad_object_ids: [
        { ad_object_type: 'AD', source_id: '8001', copied_id: '9001' },
        { ad_object_type: 'ADSET', source_id: SOURCE_ADSET, copied_id: COPY_ADSET },
      ],
    };
    const out = await run({ type: 'duplicate_ad_set', target_id: SOURCE_ADSET, settings: COPY_SETTINGS });

    expect(out).toMatchObject({ ok: true, applied: true });
    expect(calls('POST', COPY_ADSET)).toHaveLength(1);
    expect(calls('POST', '9001')).toHaveLength(0);
    expect(state.writes[0]).toMatchObject({ targetId: COPY_ADSET });
  });

  it('still fails loudly when no id comes back at all', async () => {
    copyRoutes();
    state.routes[`POST ${SOURCE_ADSET}/copies`] = { ad_object_ids: [{ ad_object_type: 'AD', copied_id: '9001' }] };
    const out = await run({ type: 'duplicate_ad_set', target_id: SOURCE_ADSET, settings: COPY_SETTINGS });

    expect(out.error).toBe('copy_returned_no_id');
    expect(String(out.detail)).toContain('check the campaign before retrying');
  });
});
