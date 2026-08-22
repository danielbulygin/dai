import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { graphGet, META_API_VERSION } from '../src/integrations/meta-graph.js';

/**
 * The shared Graph read helper, promoted out of meta-api-tools.ts. The
 * behaviours meta_api_tools depended on must survive the move verbatim (version
 * pin, 429 message, error unwrap, 500-row pagination cap), and the two
 * additions the investigation surface needs — node responses and a byte
 * ceiling — must actually work.
 */

interface MockResponse { ok?: boolean; status?: number; text?: string; headers?: Record<string, string> }
type Matcher = (url: string) => MockResponse | null;

let responses: Matcher[] = [];
let calls: string[] = [];

beforeEach(() => {
  calls = [];
  responses = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    for (const r of responses) {
      const hit = r(url);
      if (hit) {
        const headers = hit.headers ?? {};
        return {
          ok: hit.ok ?? true,
          status: hit.status ?? (hit.ok === false ? 500 : 200),
          headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
          body: undefined,
          text: async () => hit.text ?? '{}',
          json: async () => JSON.parse(hit.text ?? '{}'),
        } as unknown as Response;
      }
    }
    return {
      ok: true, status: 200,
      headers: { get: () => null },
      body: undefined,
      text: async () => '{"data":[]}',
      json: async () => ({ data: [] }),
    } as unknown as Response;
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe('graphGet', () => {
  it('pins the API version and appends the token last', async () => {
    responses.push(() => ({ text: '{"data":[]}' }));
    await graphGet('act_1/ads', { access_token: 'ATTACKER' }, 'REAL');
    expect(calls[0]).toContain(`/${META_API_VERSION}/act_1/ads`);
    // The caller-supplied value is overwritten, not appended twice.
    expect(calls[0]).toContain('access_token=REAL');
    expect(calls[0]).not.toContain('ATTACKER');
  });

  it('returns a node body as `node` and an edge body as `data`', async () => {
    responses.push((u) => (u.includes('node1') ? { text: '{"id":"node1","account_id":"123"}' } : null));
    responses.push((u) => (u.includes('edge1') ? { text: '{"data":[{"a":1},{"a":2}]}' } : null));
    const node = await graphGet('node1', {}, 'T');
    expect(node.node).toMatchObject({ id: 'node1', account_id: '123' });
    expect(node.data).toBeUndefined();
    const edge = await graphGet('edge1', {}, 'T');
    expect(edge.data).toHaveLength(2);
    expect(edge.node).toBeUndefined();
  });

  it('follows paging.next and stops at the row cap, flagging truncated', async () => {
    const page = (n: number) => JSON.stringify({
      data: Array.from({ length: 2 }, (_, i) => ({ id: `${n}-${i}` })),
      paging: { next: `https://graph.facebook.com/next?p=${n + 1}` },
    });
    let n = 0;
    responses.push(() => ({ text: page(n++) }));
    const res = await graphGet('act_1/ads', {}, 'T', { maxRows: 5 });
    expect(res.data!.length).toBeGreaterThanOrEqual(5);
    expect(res.truncated).toBe(true);
  });

  it('stops paginating when a page comes back empty', async () => {
    let first = true;
    responses.push(() => {
      if (first) {
        first = false;
        return { text: JSON.stringify({ data: [{ id: 1 }], paging: { next: 'https://graph.facebook.com/next' } }) };
      }
      return { text: '{"data":[]}' };
    });
    const res = await graphGet('act_1/ads', {}, 'T');
    expect(res.data).toHaveLength(1);
    expect(res.truncated).toBeUndefined();
  });

  it('special-cases 429', async () => {
    responses.push(() => ({ ok: false, status: 429, text: '{}' }));
    const res = await graphGet('act_1/ads', {}, 'T');
    expect(res.error).toBe('Rate limited by Facebook API. Wait a moment and retry.');
  });

  it('unwraps the Facebook error message', async () => {
    responses.push(() => ({ ok: false, status: 400, text: '{"error":{"message":"(#100) boom"}}' }));
    const res = await graphGet('act_1/ads', {}, 'T');
    expect(res.error).toBe('Facebook API error: (#100) boom');
  });

  it('enforces the byte ceiling on the response body', async () => {
    responses.push(() => ({ text: `{"data":[{"x":"${'y'.repeat(5000)}"}]}` }));
    const res = await graphGet('act_1/ads', {}, 'T', { maxBytes: 1000 });
    expect(res.error).toContain('exceeded');
    expect(res.error).toContain('Narrow the request');
  });

  it('enforces the byte ceiling from content-length before reading', async () => {
    responses.push(() => ({ headers: { 'content-length': '9999' }, text: '{"data":[]}' }));
    const res = await graphGet('act_1/ads', {}, 'T', { maxBytes: 1000 });
    expect(res.error).toContain('exceeded');
  });

  it('returns (never throws) on a transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    const res = await graphGet('act_1/ads', {}, 'T');
    expect(res.error).toContain('ECONNRESET');
  });

  it('refuses to run without a token', async () => {
    const res = await graphGet('act_1/ads', {}, '');
    expect(res.error).toContain('No Meta access token');
    expect(calls).toHaveLength(0);
  });
});
