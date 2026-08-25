import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The approve rail's pause/resume verbs.
 *
 * WHY it exists. `EXEC_TYPES` carried `pause_ad_set` and `pause_ad` and nothing
 * else at the object level, while the droplet's own PROPOSAL vocabulary already
 * offered `pause_campaign` and all three `resume_*`. Ada could put a card in
 * front of a customer for a change her own executor refused by name, and the
 * refusal arrived only after they had clicked Approve.
 *
 * Resume is the verb that makes this worth pinning rather than trusting. It is
 * the only thing on this rail that turns spend ON: a pause that leaks past a
 * gate costs nothing, a resume costs money in an account nobody opened. So the
 * property under test is not "resume works" — it is that resume is gated by
 * exactly the same three rails as pause, and that a refusal happens BEFORE any
 * POST reaches Meta:
 *
 *  1. The write mode (`guard_settings.mode` + a pressed STOP).
 *  2. The account gate — the object must live in this client's ad account.
 *  3. The campaign fence — the object's OWN campaign must be one this client
 *     opened, read from Meta rather than taken from the caller.
 *
 * Meta is mocked at `fetch`, so every Graph call this rail makes is visible and
 * nothing leaves the process. `state.graph` is the whole record: a test that
 * asserts a refusal also asserts that no POST is in it.
 */

const { state } = vi.hoisted(() => {
  // envTokenFor() reads the validated env, and the rail refuses with "no Meta
  // token available" long before it reaches a verb. Set on the hoisted pass so
  // it lands before src/env.ts is parsed.
  process.env.META_ACCESS_TOKEN = 'TEST-ONLY-NOT-A-REAL-TOKEN';
  return {
    state: {
      clients: {} as Record<string, Record<string, unknown>>,
      guardSettings: {} as Record<string, Record<string, unknown>>,
      /** Every Graph request the rail made, in order. */
      graph: [] as Array<{ method: string; path: string; params: Record<string, string> }>,
      /** Route table: `${method} ${path}` -> the JSON Graph answers with. */
      routes: {} as Record<string, Record<string, unknown>>,
      /** Every audit-log row the rail wrote. */
      writes: [] as Array<Record<string, unknown>>,
    },
  };
});

vi.mock('../src/integrations/supabase.js', () => ({
  getSupabase: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = { _key: '' };
      const chain = () => q;
      Object.assign(q, {
        select: chain,
        limit: chain,
        not: chain,
        order: chain,
        eq: (_column: string, value: string) => {
          q._key = value;
          return q;
        },
        maybeSingle: async () => {
          const key = String(q._key);
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

const { handleExecuteAction, EXEC_TYPES } = await import('../scripts/ada-console-assist.js');

const FENCED_CAMPAIGN = '120000000000001';
const OUTSIDE_CAMPAIGN = '120000000000999';

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

/** Graph calls that CHANGE something. A refusal must produce none of these. */
const posts = () => state.graph.filter((c) => c.method === 'POST');

beforeEach(() => {
  state.clients = {
    AOT: {
      code: 'AOT',
      name: 'Ads on Tap',
      ad_account_id: 'act_100',
      allowed_campaign_ids: [FENCED_CAMPAIGN],
      max_daily_budget_usd: null,
    },
  };
  state.guardSettings = { act_100: { mode: 'hitl', enabled: true, stopped_at: null } };
  state.graph = [];
  state.writes = [];
  state.routes = {};
  vi.stubGlobal('fetch', vi.fn(graphFetch));
});

/** An ad set inside the fence, currently paused. */
function pausedAdSetInFence(id = '6001') {
  state.routes[`GET ${id}`] = {
    id,
    name: 'AOT // Broad // Video 4',
    status: 'PAUSED',
    effective_status: 'PAUSED',
    campaign_id: FENCED_CAMPAIGN,
    account_id: '100',
  };
  state.routes[`POST ${id}`] = { success: true };
  return id;
}

const run = (intent: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  handleExecuteAction({ client_code: 'AOT', user_id: 'u_1', intent, ...extra });

describe('EXEC_TYPES — what the executor will answer to', () => {
  it('answers to every verb the portal can build a card for', () => {
    for (const verb of [
      'pause_campaign', 'pause_ad_set', 'pause_ad',
      'resume_campaign', 'resume_ad_set', 'resume_ad',
      'update_budget',
    ]) {
      expect(EXEC_TYPES.has(verb), `${verb} is proposable and must be executable`).toBe(true);
    }
  });

  it('keeps the build verbs it already had', () => {
    for (const verb of ['create_campaign', 'create_ad_set', 'create_ad', 'duplicate_ad_set', 'duplicate_ad']) {
      expect(EXEC_TYPES.has(verb)).toBe(true);
    }
  });

  it('still refuses a verb nobody implemented, by name', async () => {
    const out = await run({ type: 'delete_campaign', target_id: '1' });
    expect(out.refused).toContain('delete_campaign');
    expect(state.graph).toHaveLength(0);
  });
});

describe('resume — the one verb that turns spend on', () => {
  it('REFUSES a resume on an ad set outside the fence, before any write', async () => {
    state.routes['GET 6002'] = {
      id: '6002',
      name: 'Someone else campaign // Ad set',
      status: 'PAUSED',
      effective_status: 'PAUSED',
      campaign_id: OUTSIDE_CAMPAIGN,
      account_id: '100',
    };
    const out = await run({ type: 'resume_ad_set', target_id: '6002' });

    expect(out.ok).toBe(false);
    expect(String(out.refused)).toContain('campaign fence');
    expect(String(out.refused)).toContain(OUTSIDE_CAMPAIGN);
    // The fence is read from Meta's answer, not from the caller: the rail had
    // to look the ad set up to learn its campaign, and then it stopped.
    expect(posts()).toHaveLength(0);
    expect(state.writes).toHaveLength(0);
  });

  it('REFUSES a resume on a campaign that is not itself in the fence', async () => {
    state.routes[`GET ${OUTSIDE_CAMPAIGN}`] = {
      id: OUTSIDE_CAMPAIGN,
      name: 'A campaign nobody opened',
      status: 'PAUSED',
      effective_status: 'PAUSED',
      account_id: '100',
    };
    const out = await run({ type: 'resume_campaign', target_id: OUTSIDE_CAMPAIGN });

    expect(out.ok).toBe(false);
    expect(String(out.refused)).toContain('campaign fence');
    expect(posts()).toHaveLength(0);
  });

  it('REFUSES a resume on an object in another ad account', async () => {
    state.routes['GET 6003'] = {
      id: '6003',
      name: 'Another tenant ad set',
      status: 'PAUSED',
      campaign_id: FENCED_CAMPAIGN,
      account_id: '999',
    };
    const out = await run({ type: 'resume_ad_set', target_id: '6003' });

    expect(String(out.refused)).toContain('different account');
    expect(posts()).toHaveLength(0);
  });

  it('REFUSES a resume when the account is read-only, without reading Meta at all', async () => {
    state.guardSettings.act_100 = { mode: 'read_only', enabled: true, stopped_at: null };
    pausedAdSetInFence();
    const out = await run({ type: 'resume_ad_set', target_id: '6001' });

    expect(out.refused).toBe('writes_not_enabled_for_this_account');
    expect(state.graph).toHaveLength(0);
  });

  it('REFUSES a resume when STOP is pressed, even in hitl', async () => {
    state.guardSettings.act_100 = { mode: 'hitl', enabled: true, stopped_at: '2026-08-24T22:10:00Z' };
    pausedAdSetInFence();
    const out = await run({ type: 'resume_ad_set', target_id: '6001' });

    expect(out.refused).toBe('writes_not_enabled_for_this_account');
    expect(String(out.detail)).toContain('STOP pressed');
    expect(state.graph).toHaveLength(0);
  });

  it('resumes an ad set inside the fence, and reads the result back', async () => {
    pausedAdSetInFence();
    const out = await run({ type: 'resume_ad_set', target_id: '6001' });

    expect(out).toMatchObject({ ok: true, applied: true });
    const write = posts().find((c) => c.path === '6001');
    expect(write?.params.status).toBe('ACTIVE');
    // The read-back is what may claim the change happened; the intent may not.
    const readBack = state.graph.filter((c) => c.method === 'GET' && c.path === '6001');
    expect(readBack).toHaveLength(2);
    expect(readBack[1].params.fields).toContain('campaign_id');
  });

  it('records the reverse of a resume as a pause', async () => {
    pausedAdSetInFence();
    await run({ type: 'resume_ad_set', target_id: '6001' });

    expect(state.writes[0]).toMatchObject({
      toolName: 'execute_action:resume_ad_set',
      reverse: { params: { status: 'PAUSED' } },
      initiatedBy: 'client_approved',
    });
    expect(String((state.writes[0] as { summary: string }).summary)).toContain('Resumed ad set');
  });

  it('reports an already-active object as nothing done, not as a change', async () => {
    state.routes['GET 6004'] = {
      id: '6004', name: 'Already running', status: 'ACTIVE', effective_status: 'ACTIVE',
      campaign_id: FENCED_CAMPAIGN, account_id: '100',
    };
    const out = await run({ type: 'resume_ad_set', target_id: '6004' });

    expect(out).toMatchObject({ ok: true, applied: false, note: 'already active' });
    expect(posts()).toHaveLength(0);
  });

  it('writes nothing on a dry run and says what it would have done', async () => {
    pausedAdSetInFence();
    const out = await run({ type: 'resume_ad_set', target_id: '6001' }, { dry_run: true });

    expect(out).toMatchObject({ ok: true, dry_run: true, would_apply: true });
    expect(String(out.detail)).toContain('would resume ad set');
    expect(posts()).toHaveLength(0);
    expect(state.writes).toHaveLength(0);
  });
});

describe('the target read knows which level it is looking at', () => {
  it('never asks a campaign for a campaign_id — the field does not exist and the read throws', async () => {
    state.routes[`GET ${FENCED_CAMPAIGN}`] = {
      id: FENCED_CAMPAIGN, name: 'AOT // CBO // Main', status: 'PAUSED',
      effective_status: 'PAUSED', daily_budget: '50000', account_id: '100',
    };
    state.routes[`POST ${FENCED_CAMPAIGN}`] = { success: true };
    const out = await run({ type: 'resume_campaign', target_id: FENCED_CAMPAIGN });

    expect(out).toMatchObject({ ok: true, applied: true });
    for (const call of state.graph.filter((c) => c.method === 'GET')) {
      expect(call.params.fields).not.toContain('campaign_id');
    }
  });

  it('pauses a campaign, fencing on the campaign id itself', async () => {
    state.routes[`GET ${FENCED_CAMPAIGN}`] = {
      id: FENCED_CAMPAIGN, name: 'AOT // CBO // Main', status: 'ACTIVE',
      effective_status: 'ACTIVE', daily_budget: '50000', account_id: '100',
    };
    state.routes[`POST ${FENCED_CAMPAIGN}`] = { success: true };
    const out = await run({ type: 'pause_campaign', target_id: FENCED_CAMPAIGN });

    expect(out).toMatchObject({ ok: true, applied: true });
    expect(posts()[0].params.status).toBe('PAUSED');
    expect(String((state.writes[0] as { summary: string }).summary)).toContain('Paused campaign');
  });

  it('still reads an ad set ad-set-shaped, and an ad ad-shaped', async () => {
    pausedAdSetInFence();
    await run({ type: 'pause_ad_set', target_id: '6001' }).catch(() => undefined);
    expect(state.graph[0].params.fields).toContain('daily_budget');

    state.graph = [];
    state.routes['GET 7001'] = {
      id: '7001', name: 'An ad', status: 'ACTIVE', effective_status: 'ACTIVE',
      campaign_id: FENCED_CAMPAIGN, account_id: '100',
    };
    state.routes['POST 7001'] = { success: true };
    await run({ type: 'pause_ad', target_id: '7001' });
    expect(state.graph[0].params.fields).not.toContain('daily_budget');
    expect(state.graph[0].params.fields).toContain('campaign_id');
  });
});
