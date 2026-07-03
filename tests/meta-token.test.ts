import { describe, it, expect, afterEach, vi } from 'vitest';
import { normalizeAdAccountId, pickAdAccount, envTokenFor, getTokenForClient } from '../src/integrations/meta-token.js';

/**
 * Supabase mock for the getTokenForClient resolution tests: `state` controls
 * what the two lookups (meta_connections, clients) return. The query builder
 * is chainable and resolves at maybeSingle(), like the real client.
 */
const { state } = vi.hoisted(() => ({
  state: {
    connection: null as Record<string, unknown> | null,
    client: { id: 'client-uuid', ad_account_id: '123456' } as Record<string, unknown> | null,
  },
}));

vi.mock('../src/integrations/supabase.js', () => ({
  getSupabase: () => ({
    from: (table: string) => {
      let selected = '';
      const q = {
        select: (s: string) => { selected = s; return q; },
        eq: () => q,
        ilike: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () => {
          if (table === 'meta_connections') return { data: state.connection, error: null };
          if (table === 'clients') {
            if (!state.client) return { data: null, error: null };
            return {
              data: selected.includes('ad_account_id')
                ? { ad_account_id: state.client.ad_account_id }
                : { id: state.client.id },
              error: null,
            };
          }
          return { data: null, error: null };
        },
      };
      return q;
    },
  }),
}));

/**
 * The token bridge's pure selection logic (the DB lookup is integration-tested
 * live). Two invariants matter for correctness:
 *  - the cold audit must target the SAME account the Tinkers funnel showed the
 *    user (inferAccountSnapshot uses ad_account_ids[0]) unless one is pinned;
 *  - the env branch keeps the exact GROWTHSQUAD split the engine always used.
 */

describe('normalizeAdAccountId', () => {
  it('prefixes a bare id and leaves an act_ id untouched', () => {
    expect(normalizeAdAccountId('123')).toBe('act_123');
    expect(normalizeAdAccountId('act_123')).toBe('act_123');
    expect(normalizeAdAccountId('  act_9  ')).toBe('act_9');
  });
});

describe('pickAdAccount', () => {
  it('returns the first granted account by default (funnel parity)', () => {
    expect(pickAdAccount(['act_1', 'act_2'])).toBe('act_1');
    expect(pickAdAccount(['9', '8'])).toBe('act_9'); // normalised
  });

  it('honours a pinned account when it is actually granted (act_-insensitive)', () => {
    expect(pickAdAccount(['act_1', 'act_2'], '2')).toBe('act_2');
    expect(pickAdAccount(['act_1', 'act_2'], 'act_2')).toBe('act_2');
  });

  it('falls back to the first granted account when the pin is NOT granted', () => {
    expect(pickAdAccount(['act_1', 'act_2'], 'act_999')).toBe('act_1');
  });

  it('returns null when nothing is granted', () => {
    expect(pickAdAccount([])).toBeNull();
    expect(pickAdAccount([''])).toBeNull();
  });
});

describe('envTokenFor', () => {
  const orig = { main: process.env.META_ACCESS_TOKEN, gs: process.env.META_ACCESS_TOKEN_GROWTHSQUAD };
  afterEach(() => {
    process.env.META_ACCESS_TOKEN = orig.main;
    process.env.META_ACCESS_TOKEN_GROWTHSQUAD = orig.gs;
  });

  it('routes Growth Squad clients to the GROWTHSQUAD token', () => {
    process.env.META_ACCESS_TOKEN = 'main-token';
    process.env.META_ACCESS_TOKEN_GROWTHSQUAD = 'gs-token';
    // envTokenFor reads env.META_ACCESS_TOKEN (cached at import) for the main
    // branch, so we only assert the GROWTHSQUAD routing here.
    expect(envTokenFor('LA')).toBe('gs-token');
    expect(envTokenFor('la2')).toBe('gs-token');
    expect(envTokenFor('TL')).toBe('gs-token');
  });

  it('falls back to the main token for a Growth Squad client when GS token is unset', () => {
    delete process.env.META_ACCESS_TOKEN_GROWTHSQUAD;
    // main branch comes from the env module (loaded once); just assert it is NOT
    // the (now-absent) GS token.
    expect(envTokenFor('LA')).not.toBe('gs-token');
  });

  it('never uses the GS token for a non-Growth-Squad client', () => {
    process.env.META_ACCESS_TOKEN_GROWTHSQUAD = 'gs-token';
    expect(envTokenFor('AB')).not.toBe('gs-token');
    expect(envTokenFor('GG')).not.toBe('gs-token');
    expect(envTokenFor('SS')).not.toBe('gs-token');
  });
});

describe('getTokenForClient — resolution order + fallback guard', () => {
  const orig = process.env.META_ACCESS_TOKEN_GROWTHSQUAD;
  afterEach(() => {
    process.env.META_ACCESS_TOKEN_GROWTHSQUAD = orig;
    state.connection = null;
    state.client = { id: 'client-uuid', ad_account_id: '123456' };
  });

  it('uses the connection FIRST, even when a clientCode with an env token is also given', async () => {
    process.env.META_ACCESS_TOKEN_GROWTHSQUAD = 'gs-token';
    state.connection = {
      id: 'conn-1', client_id: null, access_token: 'user-oauth-token',
      ad_account_ids: ['111', '222'], mode: 'readonly', status: 'active',
    };
    const res = await getTokenForClient({ userId: 'u1', clientCode: 'LA' });
    expect(res?.source).toBe('connection');
    expect(res?.token).toBe('user-oauth-token');
    expect(res?.adAccountId).toBe('act_111'); // funnel parity: first granted, normalised
    expect(res?.mode).toBe('readonly');
  });

  it('honours a pinned granted account on the connection', async () => {
    state.connection = {
      id: 'conn-1', client_id: null, access_token: 'user-oauth-token',
      ad_account_ids: ['111', '222'], mode: 'readonly', status: 'active',
    };
    const res = await getTokenForClient({ userId: 'u1', adAccountId: 'act_222' });
    expect(res?.adAccountId).toBe('act_222');
  });

  it('HARD GUARD: a userId lookup with no usable connection returns null — never the env token', async () => {
    process.env.META_ACCESS_TOKEN_GROWTHSQUAD = 'gs-token';
    state.connection = null; // stranger's connection missing/expired
    const res = await getTokenForClient({ userId: 'u1', clientCode: 'LA' });
    expect(res).toBeNull();
  });

  it('falls back to the env token + clients row for a clientCode-only (legacy) lookup', async () => {
    process.env.META_ACCESS_TOKEN_GROWTHSQUAD = 'gs-token';
    state.connection = null;
    const res = await getTokenForClient({ clientCode: 'LA' });
    expect(res?.source).toBe('env');
    expect(res?.mode).toBe('legacy');
    expect(res?.token).toBe('gs-token');
    expect(res?.adAccountId).toBe('act_123456'); // from clients row, normalised
  });
});
