import { describe, it, expect, vi } from 'vitest';
import {
  createPageFetch, deriveMatch, extractOfferPromises, extractPage, findOfferMention,
  guardUrl, isOnPlatformUrl, isPrivateHost, normalizeDestination, reconcileChecks,
  runSiteWalk, stripHtml, verifyEvidence,
  type MatchCheck, type PageFetchResult, type WalkAd, type WalkDestination,
} from '../src/audit/site-walk.js';

/**
 * The site walk on fixtures only: a scripted page instead of the open internet,
 * a scripted read instead of the model. The invariants under test are the ones
 * a wrong answer would embarrass us with in front of a customer: a fetch we
 * should not make never leaves, a page we could not read is skipped rather than
 * guessed at, a quote that is not on the page is dropped, the string search
 * beats the model on the same promise, and a blocked page costs the section and
 * nothing else.
 *
 * The anchor case is the life-insurance account: the top destination by spend
 * is the homepage, and the top ad promises a free quote in 60 seconds.
 */

const PAGE_HTML = [
  '<html><head><title>Term Life Insurance | Northline</title>',
  '<meta property="og:title" content="Cover your family from 12 USD a month">',
  '<style>.a{color:red}</style><script>var x = "do not read me";</script></head>',
  '<body><!-- hidden --><h1>Life cover from&nbsp;12 USD a month</h1>',
  '<p>Get a free quote in 60 seconds. No obligation, no medical exam for most applicants.</p>',
  '<p>Rated 4.8 out of 5 by 1,204 families.</p>',
  '<nav><a href="/about">About us</a></nav>',
  '<a href="/quote">Start my free quote</a>',
  '<p>Underwritten by Northline Assurance. Terms apply to every policy we write today.</p>',
  '</body></html>',
].join('');

const destination: WalkDestination = {
  url: 'https://northline.example/',
  spend30: 5_577,
  spend_share_pct: 61.2,
  ads_count: 7,
};

const ad = (over: Partial<WalkAd> = {}): WalkAd => ({
  ad_id: 'ad_1',
  ad_name: 'SB-Image-Life cover calculator',
  headline: 'Life cover from 12 USD a month',
  body: 'Get a free quote in 60 seconds. Use code SAVE20 for 20% off your first year.',
  spend30: 1_204,
  ...over,
});

const okFetch = (html = PAGE_HTML): PageFetchResult => ({
  ok: true, httpStatus: 200, finalUrl: destination.url, html, text: stripHtml(html),
});
const pageFetch = (result: PageFetchResult) => async () => result;

describe('the guards — a fetch we should not make never leaves', () => {
  it('refuses private hosts, loopback, link-local and non-https schemes', async () => {
    const calls: string[] = [];
    const spy = (async (url: string) => {
      calls.push(String(url));
      return new Response('<html>hi</html>', { status: 200 });
    }) as unknown as typeof fetch;
    const fetchPage = createPageFetch(spy);
    for (const url of [
      'http://northline.example/',
      'https://localhost/admin',
      'https://127.0.0.1/',
      'https://10.0.0.5/',
      'https://192.168.1.1/',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/',
      'https://northline.example:8443/',
      'tel:+15551234567',
      'not a url',
    ]) {
      const r = await fetchPage(url);
      expect(r.ok, url).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it('names the reason in words a customer could read', () => {
    expect(guardUrl('http://x.example/')).toEqual({ ok: false, reason: 'the destination is not served over https (http)' });
    expect(guardUrl('https://10.1.2.3/')).toEqual({ ok: false, reason: 'the destination is not a public address' });
    expect(guardUrl('https://x.example:8443/')).toEqual({ ok: false, reason: 'the destination asks for a non-standard port (8443)' });
    expect(guardUrl('https://user:pw@x.example/')).toEqual({ ok: false, reason: 'the destination carries credentials in the address' });
    expect(guardUrl('https://x.example/quote')).toEqual({ ok: true, url: 'https://x.example/quote' });
    expect(isPrivateHost('172.16.0.9')).toBe(true);
    expect(isPrivateHost('172.32.0.9')).toBe(false);
  });

  it('sends no credential of ours and says who we are', async () => {
    let headers: Record<string, string> = {};
    const spy = (async (_url: string, init?: { headers?: Record<string, string> }) => {
      headers = init?.headers ?? {};
      return new Response(PAGE_HTML, { status: 200 });
    }) as unknown as typeof fetch;
    await createPageFetch(spy)('https://northline.example/');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).toEqual(['user-agent', 'accept']);
    expect(headers['user-agent']).toContain('gettinkers.com');
  });

  it('refuses a page whose declared size is past the cap', async () => {
    const huge = (async () =>
      new Response('x', { status: 200, headers: { 'content-length': String(50 * 1024 * 1024) } })) as unknown as typeof fetch;
    await expect(createPageFetch(huge)('https://northline.example/')).resolves.toEqual({
      ok: false, httpStatus: 200, reason: 'the page is too large to read',
    });
  });

  it('follows one redirect and refuses a chain', async () => {
    const hops: string[] = [];
    const twoHops = (async (url: string) => {
      hops.push(String(url));
      return new Response(null, { status: 301, headers: { location: `/hop${hops.length}` } });
    }) as unknown as typeof fetch;
    await expect(createPageFetch(twoHops)('https://northline.example/')).resolves.toEqual({
      ok: false, httpStatus: 301, reason: 'the page redirects more than once',
    });
    expect(hops).toHaveLength(2);

    const oneHop = (async (url: string) =>
      String(url).endsWith('/quote')
        ? new Response(PAGE_HTML, { status: 200 })
        : new Response(null, { status: 302, headers: { location: '/quote' } })) as unknown as typeof fetch;
    const r = await createPageFetch(oneHop)('https://northline.example/');
    expect(r.ok).toBe(true);
  });

  it('a timeout is a page that took too long, never a dead page', async () => {
    const hang = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_res, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'TimeoutError';
          reject(err);
        });
      })) as unknown as typeof fetch;
    vi.useFakeTimers();
    try {
      const pending = createPageFetch(hang)('https://northline.example/');
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toEqual({ ok: false, httpStatus: null, reason: 'the page took too long to answer' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a script shell with no readable text is not a page we read', async () => {
    const shell = (async () => new Response('<html><body><div id="root"></div></body></html>', { status: 200 })) as unknown as typeof fetch;
    const r = await createPageFetch(shell)('https://northline.example/');
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('needs a browser');
  });

  it('a Meta surface is a destination, never a page of ours', () => {
    for (const url of ['https://fb.me/abc', 'https://m.me/northline', 'https://wa.me/15551234567', 'https://www.facebook.com/northline']) {
      expect(isOnPlatformUrl(url)).toBe(true);
    }
    expect(isOnPlatformUrl('https://northline.example/')).toBe(false);
    expect(normalizeDestination('https://Northline.example/quote/?utm=x#y')).toBe('https://northline.example/quote');
  });
});

describe('extraction — what the page states outright', () => {
  it('reads the headline, the offer sentence, the CTA and the proof', () => {
    const read = extractPage(PAGE_HTML);
    expect(read.headline).toBe('Life cover from 12 USD a month');
    expect(read.page_title).toBe('Term Life Insurance | Northline');
    expect(read.offer_sentence).toBe('Get a free quote in 60 seconds.');
    expect(read.primary_cta).toBe('Start my free quote');
    expect(read.social_proof).toBe(true);
    expect(read.social_proof_evidence).toContain('4.8 out of 5');
  });

  it('falls back h1 → og:title → title, and never invents what is missing', () => {
    const noH1 = PAGE_HTML.replace(/<h1[\s\S]*?<\/h1>/, '');
    expect(extractPage(noH1).headline).toBe('Cover your family from 12 USD a month');
    const bare = '<html><head><title>Northline</title></head><body><p>' + 'We write policies. '.repeat(20) + '</p></body></html>';
    const read = extractPage(bare);
    expect(read.headline).toBe('Northline');
    expect(read.offer_sentence).toBeNull();
    expect(read.primary_cta).toBeNull();
    expect(read.social_proof).toBe(false);
    expect(read.social_proof_evidence).toBeNull();
  });

  it('keeps only visible text', () => {
    expect(stripHtml('<html><head><style>.a{}</style><script>var x="hide";</script></head><body><h1>Clean&nbsp;Cover</h1><p>20% off &amp; free quote</p></body></html>'))
      .toBe('Clean Cover 20% off & free quote');
  });
});

describe('the message match — every verdict stronger than inconclusive shows the page', () => {
  const text = stripHtml(PAGE_HTML);

  it('pulls checkable promises out of the ad\'s own words', () => {
    expect(extractOfferPromises('Get a free quote in 60 seconds. Use code SAVE20 for 20% off your first year. Free shipping.'))
      .toEqual(['code SAVE20', '20% off', 'free shipping']);
    expect(findOfferMention('free quote', text).found).toBe(true);
    expect(findOfferMention('code SAVE20', text).found).toBe(false);
  });

  it('only counts a quote as evidence when the page really carries it', () => {
    expect(verifyEvidence(text, 'free quote in 60 seconds')).toBe(true);
    expect(verifyEvidence(text, 'no medical   EXAM')).toBe(true);
    expect(verifyEvidence(text, 'cheapest cover in America')).toBe(false);
    expect(verifyEvidence(text, ' ')).toBe(false);
  });

  it('matched when every promise is on the page, with the page\'s own words as evidence', () => {
    const checks: MatchCheck[] = [
      { promise: 'free quote in 60 seconds', found_on_page: true, page_evidence: 'Get a free quote in 60 seconds', source: 'deterministic' },
    ];
    const out = deriveMatch(checks, extractPage(PAGE_HTML), text);
    expect(out.verdict).toBe('matched');
    expect(out.evidence_quote).toBe('Get a free quote in 60 seconds');
  });

  it('mismatch shows what the page says INSTEAD', () => {
    const checks: MatchCheck[] = [
      { promise: 'code SAVE20', found_on_page: false, page_evidence: null, source: 'deterministic' },
    ];
    const out = deriveMatch(checks, extractPage(PAGE_HTML), text);
    expect(out.verdict).toBe('mismatch');
    expect(out.evidence_quote).toBe('Life cover from 12 USD a month');
    expect(verifyEvidence(text, out.evidence_quote!)).toBe(true);
  });

  it('partial when the page keeps some of it', () => {
    const out = deriveMatch(
      [
        { promise: 'free quote in 60 seconds', found_on_page: true, page_evidence: 'free quote in 60 seconds', source: 'deterministic' },
        { promise: 'code SAVE20', found_on_page: false, page_evidence: null, source: 'deterministic' },
      ],
      extractPage(PAGE_HTML),
      text,
    );
    expect(out.verdict).toBe('partial');
    expect(out.evidence_quote).toBe('free quote in 60 seconds');
  });

  it('no checkable promise, or no verifiable quote, is inconclusive and never alarmed', () => {
    expect(deriveMatch([], extractPage(PAGE_HTML), text).verdict).toBe('inconclusive');
    const unverifiable = deriveMatch(
      [{ promise: 'x', found_on_page: true, page_evidence: 'a sentence the page never printed', source: 'read' }],
      extractPage(PAGE_HTML),
      text,
    );
    expect(unverifiable.verdict).toBe('inconclusive');
    expect(unverifiable.evidence_quote).toBeNull();
    // No headline to quote instead: a mismatch with nothing to show is not a claim.
    const blind = deriveMatch(
      [{ promise: 'code SAVE20', found_on_page: false, page_evidence: null, source: 'deterministic' }],
      { headline: null, page_title: null, offer_sentence: null, primary_cta: null, social_proof: false, social_proof_evidence: null },
      text,
    );
    expect(blind.verdict).toBe('inconclusive');
  });

  it('the string search beats the model on the same promise, and a fake quote is dropped', () => {
    const deterministic: MatchCheck[] = [
      { promise: 'code SAVE20', found_on_page: false, page_evidence: null, source: 'deterministic' },
    ];
    const out = reconcileChecks(
      deterministic,
      [
        { promise: 'code SAVE20', found_on_page: true, page_evidence: 'Use code SAVE20 today' },
        { promise: 'no medical exam', found_on_page: true, page_evidence: 'no medical exam for most applicants' },
        { promise: 'cheapest in America', found_on_page: true, page_evidence: 'we are the cheapest in America' },
        { promise: 'lifetime price lock', found_on_page: false, page_evidence: null },
      ],
      text,
    );
    expect(out).toEqual([
      { promise: 'code SAVE20', found_on_page: false, page_evidence: null, source: 'deterministic' },
      { promise: 'no medical exam', found_on_page: true, page_evidence: 'no medical exam for most applicants', source: 'read' },
      { promise: 'lifetime price lock', found_on_page: false, page_evidence: null, source: 'read' },
    ]);
  });
});

describe('the section — one page, one read, contained', () => {
  /** The one model read, scripted: it finds the ad's prose promise on the page. */
  const readsFreeQuote = async <T,>() =>
    ({ checks: [{ promise: 'free quote in 60 seconds', found_on_page: true, page_evidence: 'Get a free quote in 60 seconds' }] }) as unknown as T;

  it('reads the top page and reports the promise the page does not keep', async () => {
    const s = await runSiteWalk({ currency: 'USD', destination, ad: ad(), fetchPage: pageFetch(okFetch()), synthesize: readsFreeQuote });
    expect(s.status).toBe('complete');
    const d = s.data as Record<string, any>;
    expect(d.verdict).toBe('partial');
    expect(d.page.url).toBe('https://northline.example/');
    expect(d.page.spend_30d).toBe(5_577);
    expect(d.page.spend_share_pct).toBe(61.2);
    expect(d.page.ads_pointing_here).toBe(7);
    expect(d.page.headline).toBe('Life cover from 12 USD a month');
    expect(d.page.primary_cta).toBe('Start my free quote');
    expect(d.page.social_proof).toBe(true);
    expect(d.ad.ad_id).toBe('ad_1');
    expect(d.signal).toBe(true);
    expect(s.summary).toContain('"code SAVE20" is not on it');
    expect(s.next_step).toContain('northline.example/');
    expect(s.warnings).toBeUndefined();
    expect(JSON.stringify(s)).not.toMatch(/—/);
  });

  it('a page that keeps the promise is quiet: no warning, no next step', async () => {
    const s = await runSiteWalk({
      currency: 'USD',
      destination,
      ad: ad({ body: 'Get a free quote in 60 seconds. No medical exam for most applicants.' }),
      fetchPage: pageFetch(okFetch()),
    });
    const d = s.data as Record<string, any>;
    expect(['matched', 'inconclusive']).toContain(d.verdict);
    expect(d.signal).toBe(false);
    expect(s.next_step).toBeUndefined();
    expect(s.warnings).toBeUndefined();
  });

  it('an ad with no checkable promise is inconclusive, and says so plainly', async () => {
    const s = await runSiteWalk({
      currency: 'USD',
      destination,
      ad: ad({ headline: 'Protect what matters', body: 'Because they depend on you.' }),
      fetchPage: pageFetch(okFetch()),
    });
    const d = s.data as Record<string, any>;
    expect(d.verdict).toBe('inconclusive');
    expect(d.signal).toBe(false);
    expect(s.summary).toContain('nothing to match');
    expect(s.warnings).toBeUndefined();
  });

  it('the ONE model read is verified against the page and can only add checks', async () => {
    const s = await runSiteWalk({
      currency: 'USD',
      destination,
      ad: ad({ body: 'Get a free quote in 60 seconds.' }),
      fetchPage: pageFetch(okFetch()),
      synthesize: async <T,>() =>
        ({
          checks: [
            { promise: 'no medical exam', found_on_page: true, page_evidence: 'no medical exam for most applicants' },
            { promise: 'cover in 24 hours', found_on_page: true, page_evidence: 'cover starts within 24 hours' },
          ],
        }) as unknown as T,
    });
    const d = s.data as Record<string, any>;
    const promises = (d.checks as MatchCheck[]).map((c) => c.promise);
    expect(promises).toContain('no medical exam');
    expect(promises).not.toContain('cover in 24 hours');
    expect(d.verdict).toBe('matched');
  });

  it('a blocked, dead or Meta destination skips the section with a reason', async () => {
    const blocked = await runSiteWalk({
      currency: 'USD', destination, ad: ad(),
      fetchPage: pageFetch({ ok: false, httpStatus: 403, reason: 'the page answered HTTP 403' }),
    });
    expect(blocked.status).toBe('skipped');
    expect(blocked.skip_reason).toContain('HTTP 403');
    expect(blocked.data).toBeUndefined();

    const meta = await runSiteWalk({
      currency: 'USD', ad: ad(), fetchPage: pageFetch(okFetch()),
      destination: { ...destination, url: 'https://m.me/northline' },
    });
    expect(meta.status).toBe('skipped');
    expect(meta.skip_reason).toContain('Meta surface');

    const none = await runSiteWalk({ currency: 'USD', destination: null, ad: null, fetchPage: pageFetch(okFetch()) });
    expect(none.status).toBe('skipped');
    expect(none.skip_reason).toContain('no destination');
  });

  it('no read, and a promise the page never prints, is a mismatch that shows what the page DOES say', async () => {
    const s = await runSiteWalk({ currency: 'USD', destination, ad: ad(), fetchPage: pageFetch(okFetch()) });
    const d = s.data as Record<string, any>;
    expect(d.verdict).toBe('mismatch');
    expect(d.evidence_quote).toBe('Life cover from 12 USD a month');
    expect(s.summary).toContain('could not find it');
    expect(s.warnings?.[0]).toContain('does not appear on the page');
    expect(d.signal).toBe(true);
  });

  it('a walker that throws, and a model read that throws, never fail the audit', async () => {
    const thrown = await runSiteWalk({
      currency: 'USD', destination, ad: ad(),
      fetchPage: async () => { throw new Error('socket hang up'); },
    });
    expect(thrown.status).toBe('skipped');
    expect(thrown.skip_reason).toContain('could not be read');

    const readThrew = await runSiteWalk({
      currency: 'USD', destination, ad: ad(), fetchPage: pageFetch(okFetch()),
      synthesize: async () => { throw new Error('overloaded'); },
    });
    // The deterministic checks stand on their own.
    expect(readThrew.status).toBe('complete');
    expect((readThrew.data as Record<string, any>).verdict).toBe('mismatch');
  });

  it('a walk that outruns its time cap is skipped, not awaited', async () => {
    const s = await runSiteWalk({
      currency: 'USD', destination, ad: ad(), timeCapMs: 5,
      fetchPage: () => new Promise((resolve) => setTimeout(() => resolve(okFetch()), 200)),
    });
    expect(s.status).toBe('skipped');
    expect(s.skip_reason).toContain('longer than we allow');
  });
});
