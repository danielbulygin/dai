import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Cross-tenant regression suite for `search_memories` (2026-07-25).
 *
 * The leak: the customer chat profile (`client_media_buyer`) exposes
 * `search_memories`, but the tool was NOT in `SCOPED_BMAD_TOOLS` and NOT in the
 * `remember`/`recall` scoped-injection block, so the client code came from model
 * input only. Underneath, `searchLearnings()` hardcoded `agent_id_filter: null`
 * and the `search_learnings` RPC used `client_code_filter` solely inside the
 * rank CASE (a 2x boost) — no row filter anywhere. dai runs on the service-role
 * key, so RLS is bypassed: a scoped customer got every tenant's learnings.
 *
 * These tests drive the REAL `executeTool` dispatcher (the same path the SDK
 * tool bridge uses) against a fake DAI Supabase whose `search_learnings` rpc
 * faithfully emulates the new SQL — including the `client_code_strict`
 * argument added in
 * `supabase/migrations/20260725120000_search_learnings_client_scope.sql`.
 * If the SQL and this emulation ever drift, the emulation is the spec to fix.
 */

interface Row {
  id: string;
  agent_id: string;
  category: string;
  content: string;
  confidence: number;
  applied_count: number;
  source_session_id: string | null;
  client_code: string | null;
  created_at: string;
  updated_at: string;
}

function learning(partial: Partial<Row> & Pick<Row, 'id' | 'agent_id' | 'content'>): Row {
  return {
    category: 'account_knowledge',
    confidence: 0.8,
    applied_count: 1,
    source_session_id: null,
    client_code: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...partial,
  };
}

/**
 * Two tenants plus an agency-global row. Every row matches the topic "roas" so
 * the full-text predicate never masks a filtering bug.
 */
const SEED: Row[] = [
  learning({
    id: 'a1',
    agent_id: 'ada_client_alpha',
    client_code: 'alpha',
    content: 'ALPHA SECRET: roas collapses when we bid above 4 EUR',
  }),
  learning({
    id: 'a2',
    agent_id: 'ada',
    client_code: 'alpha',
    content: 'ALPHA AGENCY NOTE: roas recovers after creative refresh',
  }),
  learning({
    id: 'b1',
    agent_id: 'ada_client_bravo',
    client_code: 'bravo',
    content: 'BRAVO SECRET: roas doubled on the retargeting split',
  }),
  learning({
    id: 'g1',
    agent_id: 'ada',
    client_code: null,
    content: 'GLOBAL: roas targets should always be read against the client config',
  }),
];

const { state } = vi.hoisted(() => ({
  state: {
    rows: [] as unknown[],
    calls: [] as Array<Record<string, unknown>>,
  },
}));

/**
 * Emulates `search_learnings` as the migration defines it:
 *   WHERE search_vector @@ plainto_tsquery(query_text)
 *     AND (agent_id_filter IS NULL OR l.agent_id = agent_id_filter)
 *     AND (NOT COALESCE(client_code_strict, FALSE)
 *          OR l.client_code = client_code_filter)   -- NULL-safe = fail-closed
 *   ORDER BY rank DESC   -- 2x boost on a client_code_filter match
 */
function emulateSearchLearnings(args: Record<string, unknown>): Row[] {
  const queryText = String(args.query_text ?? '').toLowerCase();
  const agentIdFilter = (args.agent_id_filter ?? null) as string | null;
  const clientCodeFilter = (args.client_code_filter ?? null) as string | null;
  const strict = Boolean(args.client_code_strict ?? false);
  const limit = (args.result_limit as number | undefined) ?? 20;

  return (state.rows as Row[])
    .filter((r) => r.content.toLowerCase().includes(queryText))
    .filter((r) => agentIdFilter === null || r.agent_id === agentIdFilter)
    // SQL `l.client_code = NULL` yields NULL (never TRUE) — strict with no code
    // must therefore match nothing.
    .filter((r) => !strict || (clientCodeFilter !== null && r.client_code === clientCodeFilter))
    .map((r) => ({
      ...r,
      rank: clientCodeFilter !== null && r.client_code === clientCodeFilter ? 2 : 1,
    }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit);
}

vi.mock('../src/integrations/dai-supabase.js', () => ({
  getDaiSupabase: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn !== 'search_learnings') return { data: [], error: null };
      state.calls.push(args);
      return { data: emulateSearchLearnings(args), error: null };
    },
    // The fire-and-forget piper_actions audit write lands here.
    from: () => ({ insert: async () => ({ error: null }) }),
  }),
}));

const { executeTool } = await import('../src/agents/tool-registry.js');
const { toolProfiles } = await import('../src/agents/profiles/index.js');

const baseContext = {
  agentId: 'ada',
  channelId: 'C_TEST',
  userId: 'U_TEST',
};

const scopedContext = (clientCode: string) => ({
  ...baseContext,
  agentId: `ada_client_${clientCode}`,
  clientScope: { clientCode },
});

async function searchMemories(
  input: Record<string, unknown>,
  context: Parameters<typeof executeTool>[2],
): Promise<{ memories: Array<{ content: string }> }> {
  const { result, isError } = await executeTool('search_memories', input, context);
  expect(isError).toBe(false);
  return JSON.parse(result);
}

const contents = (r: { memories: Array<{ content: string }> }) => r.memories.map((m) => m.content);

beforeEach(() => {
  state.rows = SEED.map((r) => ({ ...r }));
  state.calls = [];
});

describe('search_memories is reachable by customers', () => {
  it('is in the customer chat profile — so the tool-level filter IS the boundary', () => {
    expect(toolProfiles.client_media_buyer).toContain('search_memories');
  });
});

describe('scoped customer run never sees another tenant', () => {
  it('client alpha gets only alpha rows, never bravo', async () => {
    const res = await searchMemories({ topic: 'roas' }, scopedContext('alpha'));
    const got = contents(res);
    expect(got.some((c) => c.startsWith('ALPHA SECRET'))).toBe(true);
    expect(got.some((c) => c.includes('BRAVO'))).toBe(false);
    expect(got.some((c) => c.startsWith('GLOBAL'))).toBe(false);
  });

  it('client bravo gets only bravo rows, never alpha', async () => {
    const res = await searchMemories({ topic: 'roas' }, scopedContext('bravo'));
    const got = contents(res);
    expect(got.some((c) => c.startsWith('BRAVO SECRET'))).toBe(true);
    expect(got.some((c) => c.includes('ALPHA'))).toBe(false);
  });

  it('a model-supplied client_code cannot override the verified scope', async () => {
    const res = await searchMemories(
      { topic: 'roas', client_code: 'bravo' },
      scopedContext('alpha'),
    );
    expect(contents(res).some((c) => c.includes('BRAVO'))).toBe(false);
    expect(state.calls[0]!.client_code_filter).toBe('alpha');
  });

  it('the scope reaches the RPC as agent + strict client filter', async () => {
    await searchMemories({ topic: 'roas' }, scopedContext('alpha'));
    expect(state.calls[0]).toMatchObject({
      agent_id_filter: 'ada_client_alpha',
      client_code_filter: 'alpha',
      client_code_strict: true,
    });
  });

  it('the audit-logged params carry the forced code, not the model\'s', async () => {
    const input: Record<string, unknown> = { topic: 'roas', client_code: 'bravo' };
    await searchMemories(input, scopedContext('alpha'));
    expect(input.client_code).toBe('alpha');
  });

  it('a mis-wired scope with no client code returns nothing (fail-closed)', () => {
    expect(
      emulateSearchLearnings({
        query_text: 'roas',
        agent_id_filter: null,
        client_code_filter: null,
        client_code_strict: true,
        result_limit: 20,
      }),
    ).toEqual([]);
  });
});

describe('internal agency run keeps cross-client search', () => {
  it('unscoped search still returns every client', async () => {
    const res = await searchMemories({ topic: 'roas' }, baseContext);
    const got = contents(res);
    expect(got.some((c) => c.includes('ALPHA'))).toBe(true);
    expect(got.some((c) => c.includes('BRAVO'))).toBe(true);
    expect(got.some((c) => c.startsWith('GLOBAL'))).toBe(true);
  });

  it('unscoped search sends no agent filter and no strict flag', async () => {
    await searchMemories({ topic: 'roas' }, baseContext);
    expect(state.calls[0]).toMatchObject({
      agent_id_filter: null,
      client_code_filter: null,
      client_code_strict: false,
    });
  });

  it('an internal client_code stays a rank BOOST, not a filter', async () => {
    const res = await searchMemories({ topic: 'roas', client_code: 'alpha' }, baseContext);
    const got = contents(res);
    // Boosted to the top…
    expect(got[0]!).toContain('ALPHA');
    // …but the other tenants and the global rows are still there.
    expect(got.some((c) => c.includes('BRAVO'))).toBe(true);
    expect(got.some((c) => c.startsWith('GLOBAL'))).toBe(true);
    expect(state.calls[0]!.client_code_strict).toBe(false);
  });
});

describe('recall is untouched by the fix', () => {
  it('still filters by agent id only — client_code stays a boost', async () => {
    const { result } = await executeTool('recall', { query: 'roas' }, scopedContext('alpha'));
    const parsed = JSON.parse(result) as { results: Array<{ content: string }> };
    const got = parsed.results.map((r) => r.content);
    // agent_id_filter = ada_client_alpha excludes bravo AND the 'ada' rows.
    expect(got.some((c) => c.startsWith('ALPHA SECRET'))).toBe(true);
    expect(got.some((c) => c.includes('BRAVO'))).toBe(false);
    const learningsCall = state.calls[0]!;
    expect(learningsCall.agent_id_filter).toBe('ada_client_alpha');
    expect(learningsCall.client_code_filter).toBe('alpha');
    expect(learningsCall.client_code_strict ?? false).toBe(false);
  });

  it('an unscoped recall with a client_code still returns global rows', async () => {
    const { result } = await executeTool('recall', { query: 'roas', client_code: 'alpha' }, baseContext);
    const parsed = JSON.parse(result) as { results: Array<{ content: string }> };
    // agent_id_filter = 'ada' here (context.agentId), so both 'ada' rows survive.
    const got = parsed.results.map((r) => r.content);
    expect(got.some((c) => c.startsWith('GLOBAL'))).toBe(true);
    expect(got.some((c) => c.startsWith('ALPHA AGENCY NOTE'))).toBe(true);
  });
});
