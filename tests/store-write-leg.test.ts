import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Stage B dual-write (AOT Memory §8.2): remember() mirrors each learning into
 * the memory store. What these tests protect:
 *
 *  - path scheme + file shape are BYTE-compatible with backfill-learnings.ts,
 *    so live writes and the 3,548 backfilled rows form one reconcilable corpus
 *    (a drifted shape would mint duplicates on the next backfill re-run);
 *  - the write principal is the writing agent with EXACTLY the one routed
 *    scope — never the read principal, never a broad grant;
 *  - the write goes through mem_propose_write only (DB-enforced permission +
 *    CAS), and an existing identical head is a clean no-op;
 *  - the dual-write is flag-gated and can NEVER break remember(): store
 *    failures are logged, the learnings insert still returns.
 */

const { envState, storeMock, sbState } = vi.hoisted(() => ({
  envState: { values: {} as Record<string, string | undefined> },
  storeMock: {
    calls: [] as Array<Record<string, unknown>>,
    throws: false,
  },
  sbState: { inserted: null as Record<string, unknown> | null },
}));

vi.mock('../src/env.js', () => ({
  env: new Proxy({}, {
    get: (_, k) => {
      const key = k as string;
      if (key in envState.values) return envState.values[key];
      if (key === 'LOG_LEVEL') return 'silent';
      if (['AOT_MEMORY_DB_PASSWORD', 'MEMORY_STORE_DUAL_WRITE'].includes(key)) return undefined;
      return process.env[key];
    },
  }),
}));

vi.mock('../src/integrations/dai-supabase.js', () => ({
  getDaiSupabase: () => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        sbState.inserted = row;
        return {
          select: () => ({
            single: async () => ({
              data: { ...row, applied_count: 0, created_at: '2026-08-23T01:00:00Z', updated_at: '2026-08-23T01:00:00Z' },
              error: null,
            }),
          }),
        };
      },
    }),
  }),
}));

const storeClient = await import('../src/memory-store/store-client.js');
const { learningPath, composeLearningMemory, _setPool } = storeClient;

interface QueryLogEntry { text: string; values: unknown[] | undefined }

function installFakePool(opts?: { proposeConflicts?: boolean; headContent?: string | null }) {
  const log: QueryLogEntry[] = [];
  let proposeCount = 0;
  const client = {
    async query(text: string, values?: unknown[]) {
      log.push({ text, values });
      if (text.includes('mem_propose_write')) {
        proposeCount += 1;
        if (opts?.proposeConflicts && proposeCount === 1) throw new Error('409 conflict: head exists');
        return { rows: [{ out_version: proposeCount, out_sha256: 'sha', out_status: 'committed' }] };
      }
      if (text.includes('from memories')) {
        return opts?.headContent !== undefined && opts.headContent !== null
          ? { rows: [{ content: opts.headContent, content_sha256: 'headsha' }] }
          : { rows: [] };
      }
      return { rows: [] };
    },
    release: vi.fn(),
  };
  _setPool({ connect: async () => client } as never);
  return log;
}

const ROW = {
  id: 'AbC-123_x',
  agent_id: 'ada',
  category: 'client_rule',
  content: 'audibene uses ONE standardised primary text account-wide.\nNever write bespoke copy.',
  confidence: 0.9,
  client_code: 'audibene',
  source_session_id: 'sess-1',
  created_at: '2026-08-23T01:00:00Z',
  updated_at: '2026-08-23T01:00:00Z',
};

beforeEach(() => {
  envState.values = { AOT_MEMORY_DB_PASSWORD: 'pw' };
  storeMock.calls = [];
  storeMock.throws = false;
  sbState.inserted = null;
});

afterEach(() => {
  _setPool(null);
  envState.values = {};
  vi.doUnmock('../src/memory-store/store-client.js');
});

describe('backfill compatibility (drift here = duplicate corpus rows)', () => {
  it('learningPath matches the backfill slug + tier routing', () => {
    const path = learningPath(ROW);
    expect(path).toMatch(/^client\/audibene\/learnings\/learning-abc123x-[a-f0-9]{6}\.md$/);
    // No client code -> the agent scratchpad, same as pathForRow.
    expect(learningPath({ ...ROW, client_code: null })).toMatch(/^agent\/ada\/learnings\//);
    // Unmapped freeform code -> scratchpad too (backfill's conservative default).
    expect(learningPath({ ...ROW, client_code: 'mystery_client' })).toMatch(/^agent\/ada\/learnings\//);
  });

  it('composeLearningMemory writes frontmatter in KNOWN_KEYS order with the claim as body', () => {
    const memory = composeLearningMemory(ROW);
    expect(memory.startsWith('---\nid: "AbC-123_x"\nagent_id: "ada"\ncategory: "client_rule"\nclient_code: "audibene"\nconfidence: 0.9\n')).toBe(true);
    expect(memory.endsWith(`---\n\n${ROW.content}`)).toBe(true);
  });
});

describe('storeWriteLearning', () => {
  it('writes with the AGENT principal scoped to exactly the routed client tier', async () => {
    const log = installFakePool();
    await storeClient.storeWriteLearning(ROW);
    const guc = log[1]!;
    expect(guc.values![0]).toBe('ada');
    expect(JSON.parse(String(guc.values![1]))).toEqual(['client:audibene']);
    expect(JSON.parse(String(guc.values![2]))).toEqual(['client:audibene']);
    const propose = log.find((q) => q.text.includes('mem_propose_write'))!;
    expect(propose.values![1]).toMatch(/^client\/audibene\/learnings\//);
    expect(propose.values![2]).toBe('client');
    expect(propose.values![3]).toBe('audibene');
    expect(propose.values![9]).toBe('agent'); // p_role
    expect(propose.values![10]).toBe('agent'); // p_source
  });

  it('identical existing head → clean no-op', async () => {
    const content = composeLearningMemory(ROW);
    installFakePool({ proposeConflicts: true, headContent: content });
    const res = await storeClient.storeWriteLearning(ROW);
    expect(res.status).toBe('noop');
  });

  it('different existing head → CAS retry against the head sha', async () => {
    const log = installFakePool({ proposeConflicts: true, headContent: 'something older' });
    const res = await storeClient.storeWriteLearning(ROW);
    expect(res.status).toBe('committed');
    const proposes = log.filter((q) => q.text.includes('mem_propose_write'));
    expect(proposes.length).toBe(2);
    expect(proposes[0]!.values![6]).toBeNull();
    expect(proposes[1]!.values![6]).toBe('headsha');
  });
});

describe('addLearning dual-write gating', () => {
  it('flag OFF → the store is never touched', async () => {
    const log = installFakePool();
    const { addLearning } = await import('../src/memory/learnings.js');
    await addLearning({ agent_id: 'ada', category: 'x', content: 'y' });
    expect(log.length).toBe(0);
  });

  it('flag ON → the committed row is mirrored; store failure never breaks remember()', async () => {
    envState.values.MEMORY_STORE_DUAL_WRITE = '1';
    envState.values.AOT_MEMORY_DB_PASSWORD = undefined; // store unreachable → dual-write throws internally
    const { addLearning } = await import('../src/memory/learnings.js');
    const learning = await addLearning({ agent_id: 'ada', category: 'x', content: 'y', client_code: 'TL' });
    expect(learning.content).toBe('y'); // the insert still returned
  });

  it('flag ON with store reachable → one mem_propose_write lands', async () => {
    envState.values.MEMORY_STORE_DUAL_WRITE = '1';
    const log = installFakePool();
    const { addLearning } = await import('../src/memory/learnings.js');
    await addLearning({ agent_id: 'ada', category: 'x', content: 'store me', client_code: 'TL' });
    expect(log.some((q) => q.text.includes('mem_propose_write'))).toBe(true);
  });
});
