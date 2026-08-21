import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchColdAdDays, resolveDestinations, fetchAccountMeta, pickDestinationUrl } from '../src/audit/cold-fetch.js';

/**
 * The impure cold fetcher, tested against a mocked Graph: slicing must tile
 * the 180d window with no gap/overlap, pagination must follow paging.next,
 * the row cap must trip the truncated flag, and a failed slice must degrade
 * that slice only (never throw).
 */

const ASOF = '2026-07-03';

type MockResponse = { ok: boolean; status?: number; json?: unknown; text?: string };
let responses: Array<(url: string) => MockResponse | null> = [];
const calls: string[] = [];

beforeEach(() => {
  calls.length = 0;
  responses = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    for (const r of responses) {
      const hit = r(url);
      if (hit) {
        return {
          ok: hit.ok,
          status: hit.status ?? (hit.ok ? 200 : 500),
          json: async () => hit.json ?? {},
          text: async () => hit.text ?? '',
        } as Response;
      }
    }
    return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '' } as Response;
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe('fetchColdAdDays', () => {
  it('tiles six months into 6 contiguous ≤31d slices (no gap, no overlap)', async () => {
    await fetchColdAdDays('tok', 'act_1', { asOf: ASOF });
    const ranges = calls
      .filter((u) => u.includes('/insights'))
      .map((u) => JSON.parse(decodeURIComponent(u.match(/time_range=([^&]+)/)![1]!)) as { since: string; until: string });
    expect(ranges).toHaveLength(6);
    expect(ranges[0]!.until).toBe(ASOF);
    expect(ranges[5]!.since).toBe('2026-01-01'); // asOf - 183d, the six-month floor
    for (let i = 1; i < ranges.length; i++) {
      const prevSince = new Date(`${ranges[i - 1]!.since}T00:00:00Z`).getTime();
      const thisUntil = new Date(`${ranges[i]!.until}T00:00:00Z`).getTime();
      expect(prevSince - thisUntil).toBe(86_400_000); // exactly one day apart
    }
  });

  it('follows paging.next within a slice', async () => {
    responses.push((url) => {
      if (url.includes('/insights') && !url.includes('page2')) {
        return { ok: true, json: { data: [{ ad_id: '1', date_start: '2026-07-01' }], paging: { next: 'https://graph.facebook.com/page2' } } };
      }
      if (url.includes('page2')) {
        return { ok: true, json: { data: [{ ad_id: '2', date_start: '2026-07-01' }] } };
      }
      return null;
    });
    const res = await fetchColdAdDays('tok', 'act_1', { asOf: ASOF, days: 30, sliceDays: 30 });
    expect(res.adDays.map((r) => r.ad_id)).toEqual(['1', '2']);
    expect(res.truncated).toBe(false);
    expect(res.failedSlices).toBe(0);
  });

  it('trips the truncated flag at the row cap', async () => {
    responses.push((url) =>
      url.includes('/insights')
        ? { ok: true, json: { data: Array.from({ length: 10 }, (_, i) => ({ ad_id: String(i), date_start: '2026-07-01' })) } }
        : null,
    );
    const res = await fetchColdAdDays('tok', 'act_1', { asOf: ASOF, days: 30, sliceDays: 30, maxRows: 5 });
    expect(res.adDays).toHaveLength(5);
    expect(res.truncated).toBe(true);
  });

  it('a failed slice degrades that slice only — never throws', async () => {
    let first = true;
    responses.push((url) => {
      if (url.includes('/insights') && first) {
        first = false;
        return { ok: false, status: 500, text: 'boom' };
      }
      if (url.includes('/insights')) {
        return { ok: true, json: { data: [{ ad_id: 'ok', date_start: '2026-05-01' }] } };
      }
      return null;
    });
    const res = await fetchColdAdDays('tok', 'act_1', { asOf: ASOF, days: 60, sliceDays: 30 });
    expect(res.failedSlices).toBe(1);
    expect(res.adDays.map((r) => r.ad_id)).toEqual(['ok']);
  });
});

describe('resolveDestinations', () => {
  it('resolves top-spend (30d) ads to landing paths via the creative read', async () => {
    responses.push((url) =>
      url.includes('?ids=')
        ? {
            ok: true,
            json: {
              big: { creative: { object_story_spec: { link_data: { link: 'https://shop.example/products/gin?utm=x' } } } },
              small: { creative: { asset_feed_spec: { link_urls: [{ website_url: 'https://shop.example/lp/summer' }] } } },
            },
          }
        : null,
    );
    const adDays = [
      { ad_id: 'big', date_start: '2026-07-01', spend: '900' },
      { ad_id: 'small', date_start: '2026-07-01', spend: '100' },
      { ad_id: 'old', date_start: '2026-01-01', spend: '5000' }, // outside 30d — must not count
    ];
    const dest = await resolveDestinations('tok', adDays, { asOf: ASOF, top: 2 });
    expect(dest['big']!.path).toBe('/products/gin');
    expect(dest['small']!.path).toBe('/lp/summer');
    expect(dest['old']).toBeUndefined();
    const idsCall = calls.find((u) => u.includes('?ids='))!;
    expect(idsCall).toContain('ids=big,small');
  });

  it('returns {} for an empty pull without calling the Graph', async () => {
    const dest = await resolveDestinations('tok', [], { asOf: ASOF });
    expect(dest).toEqual({});
    expect(calls).toHaveLength(0);
  });
});

describe('fetchAccountMeta', () => {
  it('returns name + currency', async () => {
    responses.push((url) =>
      url.includes('act_9?fields=name,currency') ? { ok: true, json: { name: 'Acme Shop', currency: 'SEK' } } : null,
    );
    expect(await fetchAccountMeta('tok', 'act_9')).toEqual({ name: 'Acme Shop', currency: 'SEK' });
  });

  it('throws on a Graph error (caller surfaces an honest failure)', async () => {
    responses.push(() => ({ ok: false, status: 403 }));
    await expect(fetchAccountMeta('tok', 'act_9')).rejects.toThrow('403');
  });
});

describe('pickDestinationUrl — destination shapes (cold coverage, 2026-07-04)', () => {
  it('single-image link_data.link', () => {
    expect(pickDestinationUrl({ object_story_spec: { link_data: { link: 'https://x.com/p' } } })).toBe('https://x.com/p');
  });
  it('asset_feed_spec.link_urls wins first', () => {
    expect(pickDestinationUrl({ asset_feed_spec: { link_urls: [{ website_url: 'https://a.com/lp' }] }, object_story_spec: { link_data: { link: 'https://b.com' } } })).toBe('https://a.com/lp');
  });
  it('carousel child_attachments (the miss the original three paths dropped)', () => {
    expect(pickDestinationUrl({ object_story_spec: { link_data: { child_attachments: [{ link: 'https://x.com/card1' }, { link: 'https://x.com/card2' }] } } })).toBe('https://x.com/card1');
  });
  it('template_data.link (dynamic)', () => {
    expect(pickDestinationUrl({ object_story_spec: { template_data: { link: 'https://x.com/t' } } })).toBe('https://x.com/t');
  });
  it('video call_to_action link', () => {
    expect(pickDestinationUrl({ object_story_spec: { video_data: { call_to_action: { value: { link: 'https://x.com/v' } } } } })).toBe('https://x.com/v');
  });
  it('rejects non-http and empty (catalog/DPA product-set ads stay unresolved on purpose)', () => {
    expect(pickDestinationUrl({ object_story_spec: { link_data: { link: 'fb://x' } } })).toBeNull();
    expect(pickDestinationUrl(undefined)).toBeNull();
    expect(pickDestinationUrl({})).toBeNull();
  });
})
