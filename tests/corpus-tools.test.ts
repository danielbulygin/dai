import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * search_corpus / read_corpus_memory — Ada's read leg of the AOT Memory store.
 *
 * What these tests protect:
 *  - the principal GUCs are set FIRST inside the transaction, with role=agent /
 *    agent=ada / boundary=internal — the store is fail-closed (audit A1), so a
 *    missing or wrong principal silently reads NOTHING, which would look like
 *    "the corpus is empty" rather than an error;
 *  - read_scopes carries client:* scopes (that is what unlocks client tiers);
 *  - a missing AOT_MEMORY_DB_PASSWORD degrades with a self-describing error;
 *  - alias → canonical scope mapping (TL → teethlovers, PL → press-london);
 *  - the guard classifies both tools as reads, and the client-facing Tinkers
 *    profile does NOT carry them.
 */

const { envState } = vi.hoisted(() => ({
  envState: {
    values: {} as Record<string, string | undefined>,
  },
}));

// Keys the proxy must answer authoritatively (no process.env fallback), so the
// vector arm and the password check are deterministic in tests.
const CONTROLLED = new Set([
  'AOT_MEMORY_DB_PASSWORD', 'GOOGLE_GEMINI_API_KEY', 'GEMINI_API_KEY',
]);

vi.mock('../src/env.js', () => ({
  env: new Proxy(
    {},
    {
      get: (_, k) => {
        const key = k as string;
        if (CONTROLLED.has(key)) return envState.values[key];
        if (key in envState.values) return envState.values[key];
        if (key === 'LOG_LEVEL') return 'silent';
        return process.env[key];
      },
    },
  ),
}));

const storeClient = await import('../src/memory-store/store-client.js');
const { clientScopeFor, allClientScopes, _setPool } = storeClient;
const { searchCorpus, readCorpusMemory } = await import('../src/agents/tools/corpus-tools.js');
const { decide, defaultPolicy } = await import('../src/agents/sdk/guard.js');
const { toolProfiles } = await import('../src/agents/profiles/index.js');

interface QueryLogEntry {
  text: string;
  values: unknown[] | undefined;
}

function installFakePool(resultsByMatch: Array<{ match: RegExp; rows: Record<string, unknown>[] }>) {
  const log: QueryLogEntry[] = [];
  const client = {
    async query(text: string, values?: unknown[]) {
      log.push({ text, values });
      for (const { match, rows } of resultsByMatch) {
        if (match.test(text)) return { rows };
      }
      return { rows: [] };
    },
    release: vi.fn(),
  };
  _setPool({ connect: async () => client } as never);
  return log;
}

beforeEach(() => {
  envState.values = { AOT_MEMORY_DB_PASSWORD: 'test-pw' };
});

afterEach(() => {
  _setPool(null);
  envState.values = {};
});

describe('principal contract (the store is fail-closed — this is what unlocks reads)', () => {
  it('sets the Ada principal FIRST in the transaction, with client read scopes', async () => {
    const log = installFakePool([]);
    await searchCorpus({ query: 'meta error 2643152' });
    expect(log[0]!.text).toBe('begin');
    const guc = log[1]!;
    expect(guc.text).toContain("set_config('app.boundary', 'internal'");
    expect(guc.text).toContain("set_config('app.role',     'agent'");
    expect(guc.text).toContain("set_config('app.agent',    'ada'");
    expect(guc.text).toContain("'public, extensions'");
    const scopes = JSON.parse(String(guc.values![0])) as string[];
    expect(scopes).toContain('client:teethlovers');
    expect(scopes).toContain('client:press-london');
    expect(scopes.every((s) => s.startsWith('client:'))).toBe(true);
  });

  it('write_scopes is always empty — this surface can never write', async () => {
    const log = installFakePool([]);
    await searchCorpus({ query: 'anything' });
    expect(log[1]!.text).toContain(`set_config('app.write_scopes', '[]'`);
  });
});

describe('degradation', () => {
  it('missing password → self-describing error naming the env var', async () => {
    envState.values = {};
    const result = JSON.parse(await searchCorpus({ query: 'anything' }));
    expect(result.error).toContain('AOT_MEMORY_DB_PASSWORD');
  });

  it('empty query is refused', async () => {
    const result = JSON.parse(await searchCorpus({ query: '  ' }));
    expect(result.error).toContain('query is required');
  });

  it('no Gemini key → FTS-only (no vector query hits the wire)', async () => {
    const log = installFakePool([]);
    await searchCorpus({ query: 'catalog discount' });
    expect(log.some((q) => q.text.includes('memory_embeddings'))).toBe(false);
    expect(log.some((q) => q.text.includes('content_tsv'))).toBe(true);
  });
});

describe('search results', () => {
  it('returns hits with paths and the read-before-relying note', async () => {
    installFakePool([
      {
        match: /content_tsv/,
        rows: [
          { boundary: 'internal', path: 'org/reference_meta_ad_processing_error_2643152.md', title: 'Meta 2643152', version: 1, snippet: 'issues_info …' },
        ],
      },
    ]);
    const result = JSON.parse(await searchCorpus({ query: '2643152' }));
    expect(result.hit_count).toBe(1);
    expect(result.hits[0].path).toBe('org/reference_meta_ad_processing_error_2643152.md');
    expect(result.note).toContain('read_corpus_memory');
  });

  it('zero hits carries a try-different-terms note, not an error', async () => {
    installFakePool([]);
    const result = JSON.parse(await searchCorpus({ query: 'nonexistent topic xyz' }));
    expect(result.hit_count).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.note).toContain('No hits');
  });
});

describe('read_corpus_memory', () => {
  it('returns full content for a readable path', async () => {
    installFakePool([
      {
        match: /from memories/,
        rows: [{ boundary: 'internal', path: 'org/x.md', title: 'X', content: 'FULL BODY', version: 2 }],
      },
    ]);
    const result = JSON.parse(await readCorpusMemory({ path: 'org/x.md' }));
    expect(result.content).toBe('FULL BODY');
    expect(result.address).toBe('internal::org/x.md');
  });

  it('an unreadable/absent path explains the agent/terminal design instead of a bare 404', async () => {
    installFakePool([]);
    const result = JSON.parse(await readCorpusMemory({ path: 'agent/terminal/secret.md' }));
    expect(result.error).toContain('agent/terminal');
  });
});

describe('client scope mapping', () => {
  it('maps dai/ad-set codes to canonical store scopes', () => {
    expect(clientScopeFor('TL')).toBe('teethlovers');
    expect(clientScopeFor('pl')).toBe('press-london');
    expect(clientScopeFor('press_london')).toBe('press-london');
    expect(clientScopeFor('BFM')).toBe('brainfm');
    expect(clientScopeFor('stsp')).toBe('sweetspot');
    expect(clientScopeFor('nonsense-code')).toBeNull();
    expect(clientScopeFor(undefined)).toBeNull();
  });

  it('allClientScopes returns the canonical store scope names', () => {
    const scopes = allClientScopes();
    expect(scopes).toContain('audibene');
    expect(scopes).toContain('jv-academy');
    expect(scopes.length).toBeGreaterThanOrEqual(15);
  });
});

describe('wiring (guard + profiles)', () => {
  it.each(['search_corpus', 'read_corpus_memory'])(
    'the fail-closed guard classifies %s as a read',
    (tool) => {
      const d = decide(tool, { query: 'x', path: 'x' }, defaultPolicy());
      expect(d.decision).toBe('allow');
      expect(d.reason).toBe('read/analysis tool');
    },
  );

  it('internal profiles carry both; the client-facing Tinkers profile does NOT', () => {
    for (const tool of ['search_corpus', 'read_corpus_memory']) {
      expect(toolProfiles.media_buyer).toContain(tool);
      expect(toolProfiles.full).toContain(tool);
      expect(toolProfiles.client_media_buyer).not.toContain(tool);
    }
  });
});
