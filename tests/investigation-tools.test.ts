import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The read-only investigation surface. What these tests actually protect is the
 * set of properties that make "read-only" and "this tenant only" structural
 * rather than aspirational:
 *
 *  - a Graph path aimed at an account this client does not have is DENIED,
 *    including when the leading segment is a bare object id owned elsewhere;
 *  - `?method=post` (Graph's HTTP-verb override) and a caller-supplied
 *    access_token can never reach the wire;
 *  - a URL that resolves into a private range is never fetched, so an
 *    open-redirect or a rebound hostname cannot reach cloud metadata;
 *  - the guard — which is fail-closed — classifies all four names as reads.
 *
 * A regression in any of these is invisible in review and invisible at runtime,
 * which is exactly why they are asserted rather than reasoned about.
 */

// geminiKey() prefers env, falls back to process.env — set before any import
// touches the env proxy so lookAtMedia gets past its key check.
process.env.GEMINI_API_KEY = 'test-gemini-key';

const { tokenState } = vi.hoisted(() => ({
  tokenState: {
    resolution: null as Record<string, unknown> | null,
  },
}));

const { dnsState } = vi.hoisted(() => ({
  dnsState: {
    addresses: [{ address: '93.184.216.34', family: 4 }] as Array<{ address: string; family: number }>,
    /** Per-lookup answers, consumed in order (one entry per redirect hop). */
    queue: [] as Array<Array<{ address: string; family: number }>>,
    throws: false,
  },
}));

vi.mock('../src/integrations/meta-token.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/integrations/meta-token.js')>();
  return {
    ...actual,
    getTokenForClient: vi.fn(async () => tokenState.resolution),
  };
});

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => {
    if (dnsState.throws) throw new Error('ENOTFOUND');
    if (dnsState.queue.length) return dnsState.queue.shift()!;
    return dnsState.addresses;
  }),
}));

const {
  metaGraphGet, lookAtMedia, readRepoFile, grepRepo,
  rewriteDriveUrl, isBlockedAddress, validateGraphPath, leadingNode,
} = await import('../src/agents/tools/investigation-tools.js');
const { decide, defaultPolicy } = await import('../src/agents/sdk/guard.js');

// --- fetch harness (cold-fetch.test.ts idiom) --------------------------------

interface MockResponse {
  ok?: boolean;
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  /** Raw bytes to hand back through a body reader (downloadMedia path). */
  bytes?: Uint8Array;
}

type Matcher = (url: string, init?: RequestInit) => MockResponse | null;

let responses: Matcher[] = [];
let calls: Array<{ url: string; init?: RequestInit }> = [];

function fakeResponse(hit: MockResponse): Response {
  const headers = hit.headers ?? {};
  const body = hit.bytes
    ? {
        _sent: false,
        getReader() {
          const self = this as { _sent: boolean };
          return {
            async read() {
              if (self._sent) return { done: true, value: undefined };
              self._sent = true;
              return { done: false, value: hit.bytes! };
            },
            async cancel() { /* noop */ },
          };
        },
        async cancel() { /* noop */ },
      }
    : undefined;
  return {
    ok: hit.ok ?? true,
    status: hit.status ?? (hit.ok === false ? 500 : 200),
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    body,
    json: async () => hit.json ?? {},
    text: async () => hit.text ?? JSON.stringify(hit.json ?? {}),
  } as unknown as Response;
}

beforeEach(() => {
  calls = [];
  responses = [];
  tokenState.resolution = {
    token: 'TOKEN',
    adAccountId: 'act_123',
    source: 'env',
    mode: 'legacy',
  };
  dnsState.addresses = [{ address: '93.184.216.34', family: 4 }];
  dnsState.queue = [];
  dnsState.throws = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    for (const r of responses) {
      const hit = r(url, init);
      if (hit) return fakeResponse(hit);
    }
    return fakeResponse({ json: { data: [] } });
  }));
});

afterEach(() => vi.unstubAllGlobals());

const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;

// ---------------------------------------------------------------------------
// meta_graph_get — tenant pinning
// ---------------------------------------------------------------------------

describe('metaGraphGet: tenant pinning', () => {
  it('allows a read on the account the client actually has', async () => {
    responses.push((u) => (u.includes('act_123/activities') ? { json: { data: [{ event_type: 'update' }] } } : null));
    const out = parse(await metaGraphGet({ clientCode: 'LA', path: 'act_123/activities' }));
    expect(out.error).toBeUndefined();
    expect(out.row_count).toBe(1);
    expect(out.ad_account_scope).toEqual(['act_123']);
    expect(out.ownership).toBe('verified');
  });

  it('DENIES a path aimed at an ad account this client does not have', async () => {
    const out = parse(await metaGraphGet({ clientCode: 'LA', path: 'act_999/activities' }));
    expect(out.error).toContain('act_999');
    expect(out.error).toContain("not an ad account");
    // The denial must happen BEFORE any network call.
    expect(calls).toHaveLength(0);
  });

  it('honours every granted account on a connection token', async () => {
    tokenState.resolution = {
      token: 'TOKEN',
      adAccountId: 'act_500',
      source: 'connection',
      mode: 'readonly',
      grantedAdAccountIds: ['act_500', 'act_501'],
    };
    responses.push(() => ({ json: { data: [] } }));
    const ok = parse(await metaGraphGet({ clientCode: 'X', path: 'act_501/ads' }));
    expect(ok.error).toBeUndefined();
    const denied = parse(await metaGraphGet({ clientCode: 'X', path: 'act_502/ads' }));
    expect(denied.error).toContain('act_502');
  });

  it('denies a leading segment that cannot be scoped to a tenant', async () => {
    for (const path of ['me/adaccounts', 'search', 'debug_token']) {
      const out = parse(await metaGraphGet({ clientCode: 'LA', path }));
      expect(out.error, path).toContain('not a client-owned node');
    }
    expect(calls).toHaveLength(0);
  });

  it('errors when no token can be resolved', async () => {
    tokenState.resolution = null;
    const out = parse(await metaGraphGet({ clientCode: 'NOPE', path: 'act_123/ads' }));
    expect(out.error).toContain('No usable Meta access');
  });
});

// ---------------------------------------------------------------------------
// meta_graph_get — read-only by construction
// ---------------------------------------------------------------------------

describe('metaGraphGet: read-only by construction', () => {
  it.each(['access_token', 'method', 'appsecret_proof', 'METHOD'])(
    'refuses the param %s',
    async (key) => {
      const out = parse(await metaGraphGet({
        clientCode: 'LA',
        path: 'act_123/ads',
        params: { [key]: 'post' },
      }));
      expect(out.error).toContain('not allowed');
      expect(calls).toHaveLength(0);
    },
  );

  it('refuses a path containing ..', async () => {
    const out = parse(await metaGraphGet({ clientCode: 'LA', path: 'act_123/../act_999/ads' }));
    expect(out.error).toContain("'..'");
    expect(calls).toHaveLength(0);
  });

  it('refuses a path with query characters or a raw query string', async () => {
    for (const path of ['act_123/ads?fields=id', 'act_123/ads&limit=5', 'act_123/ads;drop']) {
      const out = parse(await metaGraphGet({ clientCode: 'LA', path }));
      expect(out.error, path).toContain('characters outside');
    }
  });

  it('refuses a param name with injection characters', async () => {
    const out = parse(await metaGraphGet({
      clientCode: 'LA',
      path: 'act_123/ads',
      params: { 'fields&access_token': 'x' },
    }));
    expect(out.error).toContain('param name');
  });

  it('always issues a GET and never lets a param displace the token', async () => {
    responses.push(() => ({ json: { data: [] } }));
    await metaGraphGet({ clientCode: 'LA', path: 'act_123/ads', params: { fields: 'id,name' } });
    expect(calls).toHaveLength(1);
    // undefined method === GET in fetch; the helper never sets one.
    expect(calls[0]!.init?.method).toBeUndefined();
    expect(calls[0]!.url).toContain('access_token=TOKEN');
  });
});

// ---------------------------------------------------------------------------
// meta_graph_get — ownership probe on a bare object id
// ---------------------------------------------------------------------------

describe('metaGraphGet: ownership probe', () => {
  it('DENIES a bare node id owned by another ad account', async () => {
    responses.push((u) =>
      u.includes('fields=account_id') ? { json: { id: '777000111', account_id: '999' } } : null,
    );
    const out = parse(await metaGraphGet({ clientCode: 'LA', path: '777000111/issues_info' }));
    expect(out.error).toContain('belongs to act_999');
    // Only the probe ran — never the actual read.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('fields=account_id');
  });

  it('allows a bare node id owned by the client, marked verified', async () => {
    responses.push((u) =>
      u.includes('fields=account_id') ? { json: { id: '777000222', account_id: '123' } } : null,
    );
    responses.push((u) => (u.includes('issues_info') ? { json: { data: [{ level: 'AD' }] } } : null));
    const out = parse(await metaGraphGet({ clientCode: 'LA', path: '777000222/issues_info' }));
    expect(out.error).toBeUndefined();
    expect(out.ownership).toBe('verified');
    expect(out.row_count).toBe(1);
  });

  it('proceeds with ownership=unverified when the node has no account_id', async () => {
    // Graph's real answer for a node type without the field: (#100) error.
    responses.push((u) =>
      u.includes('fields=account_id')
        ? { ok: false, status: 400, json: { error: { message: '(#100) nonexisting field' } } }
        : null,
    );
    responses.push((u) => (u.includes('product_sets') ? { json: { data: [{ id: 'ps1' }] } } : null));
    const out = parse(await metaGraphGet({ clientCode: 'LA', path: '777000333/product_sets' }));
    expect(out.error).toBeUndefined();
    expect(out.ownership).toBe('unverified');
  });

  it('memoizes the probe per process', async () => {
    responses.push((u) =>
      u.includes('fields=account_id') ? { json: { id: '777000444', account_id: '123' } } : null,
    );
    responses.push(() => ({ json: { data: [] } }));
    await metaGraphGet({ clientCode: 'LA', path: '777000444/insights' });
    const afterFirst = calls.length;
    await metaGraphGet({ clientCode: 'LA', path: '777000444/insights' });
    // Second call: read only, no second probe.
    expect(calls.length - afterFirst).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// meta_graph_get — response shape + size ceiling
// ---------------------------------------------------------------------------

describe('metaGraphGet: response handling', () => {
  it('returns a node body as `node`, not an empty list', async () => {
    responses.push((u) =>
      u.includes('act_123') ? { json: { id: 'act_123', name: 'Laori', currency: 'EUR' } } : null,
    );
    const out = parse(await metaGraphGet({ clientCode: 'LA', path: 'act_123', params: { fields: 'name,currency' } }));
    expect(out.data).toBeUndefined();
    expect(out.node).toMatchObject({ name: 'Laori', currency: 'EUR' });
  });

  it('returns a self-describing error when the response blows the size cap', async () => {
    responses.push(() => ({ headers: { 'content-length': '5000000' }, json: { data: [] } }));
    const out = parse(await metaGraphGet({ clientCode: 'LA', path: 'act_123/ads' }));
    expect(out.error).toContain('exceeded');
    expect(out.error).toContain('Narrow the request');
    expect(out.error).toContain('limit');
  });

  it('surfaces the Facebook error message verbatim', async () => {
    responses.push(() => ({
      ok: false,
      status: 400,
      json: { error: { message: '(#100) Tried accessing nonexisting field (issues_info)' } },
    }));
    const out = parse(await metaGraphGet({ clientCode: 'LA', path: 'act_123/ads' }));
    expect(out.error).toContain('nonexisting field');
  });
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

describe('pure helpers', () => {
  it('rewrites a Google Drive view link to the direct download', () => {
    expect(rewriteDriveUrl('https://drive.google.com/file/d/1AbC-_dEf/view?usp=sharing'))
      .toBe('https://drive.google.com/uc?export=download&id=1AbC-_dEf');
    expect(rewriteDriveUrl('https://drive.google.com/file/d/1AbC-_dEf/edit'))
      .toBe('https://drive.google.com/uc?export=download&id=1AbC-_dEf');
  });

  it('leaves a non-Drive URL alone', () => {
    const url = 'https://scontent.xx.fbcdn.net/v/t45/abc.jpg?_nc_cat=1';
    expect(rewriteDriveUrl(url)).toBe(url);
  });

  it.each([
    ['127.0.0.1', true], ['10.1.2.3', true], ['172.16.0.1', true], ['172.31.255.255', true],
    ['192.168.1.1', true], ['169.254.169.254', true], ['100.64.0.1', true], ['0.0.0.0', true],
    ['::1', true], ['fc00::1', true], ['fd12:3456::1', true], ['fe80::1', true],
    ['::ffff:10.0.0.1', true],
    ['93.184.216.34', false], ['8.8.8.8', false], ['172.32.0.1', false],
    ['2606:2800:220:1::1', false],
  ])('isBlockedAddress(%s) === %s', (addr, blocked) => {
    expect(isBlockedAddress(addr)).toBe(blocked);
  });

  it('classifies the leading path segment', () => {
    expect(leadingNode('act_123/activities')).toEqual({ kind: 'account', accountId: 'act_123' });
    expect(leadingNode('120250000000/issues_info')).toEqual({ kind: 'numeric', nodeId: '120250000000' });
    expect(leadingNode('me/adaccounts')).toEqual({ kind: 'other', segment: 'me' });
  });

  it('requires a path', () => {
    expect(validateGraphPath('')).toEqual({ error: expect.stringContaining('required') });
  });
});

// ---------------------------------------------------------------------------
// look_at_media — SSRF guard + Drive rewrite + happy path
// ---------------------------------------------------------------------------

describe('lookAtMedia', () => {
  it('REFUSES a host that resolves into a private range', async () => {
    dnsState.addresses = [{ address: '10.0.0.7', family: 4 }];
    const out = parse(await lookAtMedia({ url: 'https://sneaky.example.com/x.png' }));
    expect(out.error).toContain('private/reserved');
    expect(calls).toHaveLength(0);
  });

  it('REFUSES the cloud metadata address', async () => {
    dnsState.addresses = [{ address: '169.254.169.254', family: 4 }];
    const out = parse(await lookAtMedia({ url: 'http://metadata.internal/latest' }));
    expect(out.error).toContain('169.254.169.254');
    expect(calls).toHaveLength(0);
  });

  it('refuses a non-http protocol', async () => {
    const out = parse(await lookAtMedia({ url: 'file:///etc/passwd' }));
    expect(out.error).toContain('not allowed');
  });

  it('re-checks the host on every redirect hop', async () => {
    // Public host 302s to an internal one — the classic open-redirect SSRF.
    responses.push((u) =>
      u.includes('start')
        ? { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }
        : null,
    );
    // Hop 1 resolves public; hop 2 (the redirect target) resolves to metadata.
    dnsState.queue = [
      [{ address: '93.184.216.34', family: 4 }],
      [{ address: '169.254.169.254', family: 4 }],
    ];
    const out = parse(await lookAtMedia({ url: 'https://public.example.com/start' }));
    expect(out.error).toContain('private/reserved');
  });

  it('rewrites a Drive link and reads the fetched image', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    responses.push((u, init) => {
      if (!u.includes('drive.google.com')) return null;
      // preflight walks redirects manually; the download runs with redirect:'error'
      if (init?.redirect === 'manual') return { headers: {} };
      return { headers: { 'content-type': 'image/png' }, bytes: png };
    });
    responses.push((u) =>
      u.includes('generativelanguage')
        ? { json: { candidates: [{ content: { parts: [{ text: 'A black bottle. Text: "30% OFF".' }] } }] } }
        : null,
    );

    const out = parse(await lookAtMedia({ url: 'https://drive.google.com/file/d/FILEID/view' }));
    expect(out.error).toBeUndefined();
    expect(out.content_type).toBe('image/png');
    expect(out.bytes).toBe(8);
    expect(out.answer).toContain('30% OFF');
    // The rewritten direct-download URL is what actually got fetched.
    expect(calls[0]!.url).toBe('https://drive.google.com/uc?export=download&id=FILEID');
    // And the real download refuses to chase a late redirect.
    expect(calls[1]!.init?.redirect).toBe('error');
  });

  it('explains a non-media content type instead of guessing', async () => {
    responses.push((u, init) => {
      if (init?.redirect === 'manual') return { headers: {} };
      return { headers: { 'content-type': 'text/html' }, bytes: new Uint8Array([60, 104, 116]) };
    });
    const out = parse(await lookAtMedia({ url: 'https://drive.google.com/uc?export=download&id=X' }));
    expect(out.error).toContain('text/html');
    expect(out.error).toContain('neither image');
  });
});

// ---------------------------------------------------------------------------
// repo tools — missing droplet key
// ---------------------------------------------------------------------------

describe('repo tools', () => {
  it('read_repo_file self-describes the missing droplet key before any network call', async () => {
    const out = parse(await readRepoFile({ path: 'pma/global/meta-ads-api-gotchas.md' }));
    expect(out.error).toContain('DROPLET_API_KEY');
    expect(out.error).toContain('API_SECRET');
    expect(calls).toHaveLength(0);
  });

  it('grep_repo self-describes the missing droplet key', async () => {
    const out = parse(await grepRepo({ pattern: '2643152' }));
    expect(out.error).toContain('DROPLET_API_KEY');
    expect(calls).toHaveLength(0);
  });

  it('requires the arguments it needs', async () => {
    expect(parse(await readRepoFile({ path: '' })).error).toContain('path is required');
    expect(parse(await grepRepo({ pattern: '' })).error).toContain('pattern is required');
  });
});

// ---------------------------------------------------------------------------
// guard classification
// ---------------------------------------------------------------------------

describe('guard: the investigation tools are reads', () => {
  // The guard is FAIL-CLOSED: a name missing from READ_TOOLS is denied on the
  // web-chat surface even when the profile grants it. That failure mode looks
  // like "the tool does nothing", so it is asserted here rather than discovered.
  it.each(['meta_graph_get', 'look_at_media', 'read_repo_file', 'grep_repo'])(
    'allows %s in the default (read-only) policy',
    (tool) => {
      const d = decide(tool, { client_code: 'LA' }, defaultPolicy());
      expect(d.decision).toBe('allow');
      expect(d.reason).toBe('read/analysis tool');
    },
  );

  it('allows them under an mcp-prefixed name too', () => {
    const d = decide('mcp__dai__meta_graph_get', {}, defaultPolicy());
    expect(d.decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// registry + profile wiring
// ---------------------------------------------------------------------------

describe('registry wiring', () => {
  const NAMES = ['meta_graph_get', 'look_at_media', 'read_repo_file', 'grep_repo'];

  // getToolsForProfile silently DROPS a name with no registry entry, so a typo
  // in either list produces a tool the model never sees and no error anywhere.
  //
  // The generous timeout is about the IMPORT, not the assertion: this is the
  // first `await import` of the tool registry in this file, and transforming it
  // plus everything it pulls in already costs ~4.5s of the default 5s budget on
  // the droplet. Without it, adding any tool to the registry turns these two red
  // for a reason unrelated to what they check (and the second then fails with
  // "Cannot access 'REGISTRY' before initialization", because the first test's
  // import is still running).
  const REGISTRY_IMPORT_TIMEOUT_MS = 30_000;

  it('resolves all four on media_buyer and full', async () => {
    const { getToolsForProfile } = await import('../src/agents/tool-registry.js');
    for (const profile of ['media_buyer', 'full'] as const) {
      const { definitions } = getToolsForProfile(profile);
      const resolved = definitions.map((d) => d.name);
      for (const name of NAMES) expect(resolved, `${name} on ${profile}`).toContain(name);
    }
  }, REGISTRY_IMPORT_TIMEOUT_MS);

  it('withholds all four from client_media_buyer', async () => {
    const { getToolsForProfile } = await import('../src/agents/tool-registry.js');
    const resolved = getToolsForProfile('client_media_buyer').definitions.map((d) => d.name);
    for (const name of NAMES) expect(resolved, name).not.toContain(name);
  }, REGISTRY_IMPORT_TIMEOUT_MS);
});
