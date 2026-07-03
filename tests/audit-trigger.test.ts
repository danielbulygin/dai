import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Tinkers → engine trigger seam: auth via X-Ada-Secret, 202-then-async,
 * and idempotency (a lead with an audit_token or a running audit is never
 * re-audited — goal re-saves must not double-spend).
 */

const { state } = vi.hoisted(() => ({
  state: {
    secret: 'shhh' as string | undefined,
    lead: null as Record<string, unknown> | null,
    running: null as Record<string, unknown> | null,
    coldRuns: [] as string[],
  },
}));

vi.mock('../src/env.js', () => ({
  env: new Proxy(
    {},
    {
      get: (_, k) => {
        if (k === 'AUDIT_TRIGGER_SECRET') return state.secret;
        if (k === 'LOG_LEVEL') return 'silent'; // the real logger boots off env
        return undefined;
      },
    },
  ),
}));

vi.mock('../src/audit/cold-audit.js', () => ({
  runColdAudit: async (args: { userId: string }) => {
    state.coldRuns.push(args.userId);
    return { auditId: 'a1', token: 't1', costUsd: 0 };
  },
}));

vi.mock('../src/integrations/supabase.js', () => ({
  getSupabase: () => ({
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: table === 'ada_leads' ? state.lead : state.running, error: null }),
      };
      return q;
    },
  }),
}));

import { auditTriggerRouter } from '../src/api/routes/audit-trigger.js';

const post = (body: unknown, secret?: string): Promise<Response> =>
  auditTriggerRouter.request('/audit/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Ada-Secret': secret } : {}) },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  state.secret = 'shhh';
  state.lead = null;
  state.running = null;
  state.coldRuns.length = 0;
});

describe('POST /audit/trigger', () => {
  it('503s when the secret is not configured', async () => {
    state.secret = undefined;
    expect((await post({ userId: 'u1' }, 'anything')).status).toBe(503);
  });

  it('401s on a wrong or missing secret', async () => {
    expect((await post({ userId: 'u1' }, 'wrong')).status).toBe(401);
    expect((await post({ userId: 'u1' })).status).toBe(401);
    expect(state.coldRuns).toHaveLength(0);
  });

  it('400s without a userId', async () => {
    expect((await post({}, 'shhh')).status).toBe(400);
    expect((await post({ userId: '  ' }, 'shhh')).status).toBe(400);
  });

  it('202s and fires the cold audit for a fresh lead', async () => {
    const res = await post({ userId: 'u-fresh' }, 'shhh');
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'accepted' });
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget tick
    expect(state.coldRuns).toEqual(['u-fresh']);
  });

  it('is idempotent: an existing audit_token short-circuits (no re-run)', async () => {
    state.lead = { audit_token: 'tok-existing' };
    const res = await post({ userId: 'u1' }, 'shhh');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'exists', auditToken: 'tok-existing' });
    expect(state.coldRuns).toHaveLength(0);
  });

  it('is idempotent: a running audit short-circuits (no double-spend)', async () => {
    state.running = { token: 'tok-running' };
    const res = await post({ userId: 'u1' }, 'shhh');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'running', auditToken: 'tok-running' });
    expect(state.coldRuns).toHaveLength(0);
  });
});
