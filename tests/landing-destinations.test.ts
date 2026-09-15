import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkLandingDestinations } from '../src/audit/landing-destinations.js';
import type { PageFetchResult } from '../src/audit/site-walk.js';

const healthy = (url: string): PageFetchResult => ({
  ok: true,
  httpStatus: 200,
  finalUrl: url,
  html: '<title>Daily moisturiser</title><h1>Daily moisturiser</h1><p>Hydration for your everyday routine.</p>',
  text: 'Daily moisturiser. Hydration for your everyday routine. Add to cart. '.repeat(6),
});

const inputFor = (urls: string[]) => ({
  landingUrls: Object.fromEntries(urls.map((url, i) => [`ad-${i}`, url])),
  activeAdIds: urls.map((_, i) => `ad-${i}`),
  spendingAds: urls.map((_, i) => ({ ad_id: `ad-${i}`, ad_name: `Ad ${i}`, spend: (i + 1) * 30 })),
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('checkLandingDestinations', () => {
  it('reads only explicit ACTIVE ads with positive spend, deduplicating their live URLs', async () => {
    const fetchPage = vi.fn(async (url: string) => healthy(url));
    const result = await checkLandingDestinations({
      landingUrls: {
        active: 'https://shop.example/product?item=7&utm_source=meta',
        alsoActive: 'https://shop.example/product?item=7&utm_campaign=launch',
        paused: 'https://shop.example/old-product',
        unknownStatus: 'https://shop.example/another-product',
        noSpend: 'https://shop.example/no-spend',
        invalidSpend: 'https://shop.example/invalid-spend',
      },
      activeAdIds: ['active', 'alsoActive', 'noSpend', 'invalidSpend'],
      spendingAds: [
        { ad_id: 'active', ad_name: 'Current ad', spend: 300 },
        { ad_id: 'alsoActive', ad_name: 'Second current ad', spend: 600 },
        { ad_id: 'paused', ad_name: 'Paused ad', spend: 20_000 },
        { ad_id: 'unknownStatus', ad_name: 'Unknown ad', spend: 30_000 },
        { ad_id: 'noSpend', ad_name: 'New ad', spend: 0 },
        { ad_id: 'invalidSpend', ad_name: 'Invalid ad', spend: Number.NaN },
      ],
      fetchPage,
    });
    expect(fetchPage).toHaveBeenCalledExactlyOnceWith('https://shop.example/product?item=7');
    expect(result.checks).toEqual([expect.objectContaining({
      url: 'https://shop.example/product?item=7', verdict: 'ok',
      daily_burn: 30, ads: ['Current ad', 'Second current ad'],
    })]);
    expect([...result.urlByAdId.keys()]).toEqual(['active', 'alsoActive']);
    expect(result.uncheckedUrls).toBe(0);
  });

  it('refuses credentials, unsafe ports, HTTP, private and social destinations before any fetch', async () => {
    const fetchPage = vi.fn(async (url: string) => healthy(url));
    const result = await checkLandingDestinations({
      ...inputFor([
        'https://user:secret-value@shop.example/product',
        'https://shop.example:8443/product',
        'http://shop.example/product',
        'https://10.0.0.8/product',
        'https://localhost/product',
        'https://facebook.com/profile',
        'https://m.me/shop',
      ]),
      fetchPage,
    });
    expect(fetchPage).not.toHaveBeenCalled();
    expect(result.checks).toHaveLength(7);
    expect(result.checks.every((check) => check.verdict === 'inconclusive')).toBe(true);
    expect(result.urlByAdId.size).toBe(0);
    expect(JSON.stringify(result.checks)).not.toContain('secret-value');
    expect(result.checks.find((check) => check.reason?.includes('non-standard port'))?.url).toContain(':8443');
  });

  it('keeps functional query destinations distinct and removes fragments', async () => {
    const fetchPage = vi.fn(async (url: string) => healthy(url));
    await checkLandingDestinations({
      ...inputFor(['https://shop.example/product?item=7#details', 'https://shop.example/product?item=8#details']),
      fetchPage,
    });
    expect(fetchPage.mock.calls.map(([url]) => url)).toEqual([
      'https://shop.example/product?item=8', 'https://shop.example/product?item=7',
    ]);
  });

  it('checks the 50 highest-spend unique destinations and reports the remainder', async () => {
    const fetchPage = vi.fn(async (url: string) => healthy(url));
    const result = await checkLandingDestinations({
      ...inputFor(Array.from({ length: 53 }, (_, i) => `https://shop.example/product/${i}`)), fetchPage,
    });
    expect(fetchPage).toHaveBeenCalledTimes(50);
    expect(fetchPage.mock.calls[0]?.[0]).toBe('https://shop.example/product/52');
    expect(fetchPage.mock.calls.some(([url]) => url === 'https://shop.example/product/2')).toBe(false);
    expect(result.checks).toHaveLength(50);
    expect(result.uncheckedUrls).toBe(3);
    expect(result.urlByAdId.size).toBe(53);
  });

  it('distinguishes readable pages, explicit missing pages and readable soft-404s', async () => {
    const result = await checkLandingDestinations({
      ...inputFor(['https://shop.example/healthy', 'https://shop.example/gone', 'https://shop.example/missing', 'https://shop.example/soft-404']),
      fetchPage: async (url) => {
        if (url.endsWith('/gone')) return { ok: false, httpStatus: 410, reason: 'the page answered HTTP 410' };
        if (url.endsWith('/missing')) return { ok: false, httpStatus: 404, reason: 'the page answered HTTP 404' };
        if (url.endsWith('/soft-404')) return {
          ok: true, httpStatus: 200, finalUrl: url,
          html: '<title>Seite nicht gefunden</title><h1>Seite nicht gefunden</h1>',
          text: 'Seite nicht gefunden. Bitte besuchen Sie unsere Startseite, um ein anderes Produkt zu finden. '.repeat(4),
        };
        return healthy(url);
      },
    });
    expect(result.checks.map(({ verdict }) => verdict)).toEqual(['soft_404', 'dead', 'dead', 'ok']);
  });

  it('keeps empty, blocked, transient and browser-only reads inconclusive', async () => {
    const responses: PageFetchResult[] = [
      { ok: false, httpStatus: 403, reason: 'HTTP 403 blocked' },
      { ok: false, httpStatus: 429, reason: 'HTTP 429 rate limited' },
      { ok: false, httpStatus: 503, reason: 'HTTP 503' },
      { ok: false, httpStatus: 200, reason: 'the page needs a browser to render' },
      { ok: true, httpStatus: 200, finalUrl: 'https://shop.example/4', html: '', text: '' },
      {
        ok: true, httpStatus: 200, finalUrl: 'https://shop.example/5',
        html: '<title>Just a moment...</title><p>Verify you are human.</p>',
        text: 'Verify you are human. This verification protects the site against automated requests. '.repeat(5),
      },
    ];
    const result = await checkLandingDestinations({
      ...inputFor(responses.map((_, i) => `https://shop.example/${i}`)),
      fetchPage: async (url) => responses[Number(new URL(url).pathname.slice(1))]!,
    });
    expect(result.checks).toHaveLength(6);
    expect(result.checks.every((check) => check.verdict === 'inconclusive')).toBe(true);
  });

  it('reports a request failure without turning it into a dead destination', async () => {
    const result = await checkLandingDestinations({
      ...inputFor(['https://shop.example/product']),
      fetchPage: async () => { throw new Error('private transport details'); },
    });
    expect(result.checks[0]).toMatchObject({ verdict: 'inconclusive', status: null, reason: 'the page could not be reached' });
    expect(JSON.stringify(result)).not.toContain('private transport details');
  });

  it('does not follow a public URL onto a social platform', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://m.me/shop' } }));
    vi.stubGlobal('fetch', fetch);
    const result = await checkLandingDestinations(inputFor(['https://shop.example/product']));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.checks[0]?.verdict).toBe('inconclusive');
  });

  it('limits simultaneous page reads instead of launching the whole URL set at once', async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;
    const pending = checkLandingDestinations({
      ...inputFor(Array.from({ length: 12 }, (_, i) => `https://shop.example/${i}`)),
      fetchPage: async (url) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 100));
        active--;
        return healthy(url);
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThan(1);
    expect(result.checks).toHaveLength(12);
    expect(result.uncheckedUrls).toBe(0);
  });

  it('stops an unfinished set within the overall time limit and preserves honest coverage', async () => {
    vi.useFakeTimers();
    const fetchPage = vi.fn(() => new Promise<PageFetchResult>(() => {}));
    const pending = checkLandingDestinations({
      ...inputFor(Array.from({ length: 20 }, (_, i) => `https://shop.example/${i}`)), fetchPage,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(fetchPage.mock.calls.length).toBeLessThan(20);
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.checks.every((check) => check.verdict === 'inconclusive')).toBe(true);
    expect(result.checks.length + result.uncheckedUrls).toBe(20);
    expect(result.uncheckedUrls).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts a default fetch whose body hangs, keeping the result inconclusive', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => {
      signal = init?.signal;
      const response = new Response('<title>Shop</title>');
      response.text = () => new Promise<string>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return response;
    }));
    const pending = checkLandingDestinations(inputFor(['https://shop.example/product']));
    await vi.advanceTimersByTimeAsync(25_000);
    const result = await pending;
    expect(signal?.aborted).toBe(true);
    expect(result.checks[0]?.verdict).toBe('inconclusive');
    expect(vi.getTimerCount()).toBe(0);
  });
});
