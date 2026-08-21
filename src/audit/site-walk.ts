/**
 * The site walk — one page, read honestly.
 *
 * The audit already knows where the money goes (the landing chapter ranks
 * spend by destination) and what the ads say (the creative read has their
 * words). What it never did was OPEN the page the money lands on, so a report
 * could praise a hook while the page it points at never mentions the offer the
 * ad promises. This module opens exactly ONE page, the top destination by
 * spend, and answers one question: does the top ad's promise appear on it?
 *
 * The honesty rules are structural, not conventional:
 *  - one page, one fetch (plus at most one redirect). No crawling.
 *  - https only, public hosts only, standard ports only, byte cap, timeout, no
 *    auth headers, an honest user agent. A fetch we should not make is refused
 *    before it leaves.
 *  - every verdict stronger than `inconclusive` carries a VERBATIM quote from
 *    the page, checked against the page's own text. A quote that is not there
 *    is dropped rather than published, and a model claim we cannot verify can
 *    never become a finding.
 *  - the deterministic offer checks (a code, "N% off", free shipping) OVERRIDE
 *    the model on the same promise: whether a page prints NET15 is a string
 *    search, not a judgment.
 *  - `inconclusive` is never alarmed and never a warning. It means we could not
 *    tell, which is a different thing from a broken page.
 *  - contained and time-capped: a blocked, slow or broken page stores the
 *    section as `skipped` with a reason, and can never fail the audit or change
 *    the landing chapter's own wording.
 *
 * Ported from the walker built for the retired sibling generator (its guards,
 * its evidence rule and its verdict vocabulary); the extraction here is
 * deterministic rather than a model pass, because a headline, an offer sentence
 * and a CTA are all things the HTML states outright.
 */

export const WALK_FETCH_TIMEOUT_MS = 10_000;
export const WALK_MAX_BYTES = 1_500_000;
/** The whole walk, fetch plus the one model read. Past this it is skipped. */
export const WALK_TIME_CAP_MS = 60_000;
const EXTRACT_TEXT_CHARS = 60_000;

/**
 * Meta surfaces are destinations, never websites of ours to read: an ad that
 * sends people into Messenger or onto a Facebook page has no landing page, and
 * calling one broken is the false positive this list exists to prevent.
 */
export const ON_PLATFORM_HOSTS: ReadonlySet<string> = new Set([
  'fb.me', 'm.me', 'wa.me', 'ig.me', 'facebook.com', 'fb.com', 'instagram.com',
  'messenger.com', 'whatsapp.com', 'l.facebook.com', 'lm.facebook.com',
]);

export function isOnPlatformUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (ON_PLATFORM_HOSTS.has(host)) return true;
    for (const h of ON_PLATFORM_HOSTS) if (host.endsWith(`.${h}`)) return true;
    return false;
  } catch {
    return false;
  }
}

/** Hosts a server-side fetch must never be pointed at. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '::1' || host.startsWith('fd') || host.startsWith('fe80:')) return true;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  const [a = 0, b = 0] = host.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a === 169 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** Origin + path only: the query varies per ad, the page does not. */
export function normalizeDestination(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.hostname.toLowerCase()}${path || '/'}`;
  } catch {
    return null;
  }
}

export type UrlGuard = { ok: true; url: string } | { ok: false; reason: string };

/**
 * Everything that must be true before a URL is fetched from our server. Plain
 * reasons, because they are printed as the section's skip reason.
 */
export function guardUrl(raw: string): UrlGuard {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'the destination is not a readable web address' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: `the destination is not served over https (${u.protocol.replace(':', '')})` };
  if (isPrivateHost(u.hostname)) return { ok: false, reason: 'the destination is not a public address' };
  if (u.port && u.port !== '443') return { ok: false, reason: `the destination asks for a non-standard port (${u.port})` };
  if (u.username || u.password) return { ok: false, reason: 'the destination carries credentials in the address' };
  return { ok: true, url: u.toString() };
}

export type PageFetchResult =
  | { ok: true; httpStatus: number; finalUrl: string; html: string; text: string }
  | { ok: false; httpStatus: number | null; reason: string };

export type PageFetch = (url: string) => Promise<PageFetchResult>;

/** Visible text only: scripts, styles and tags out, entities decoded. */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * One guarded fetch, following at most one redirect (a shop's http-to-https or
 * trailing-slash hop is normal; a redirect chain is somebody else's crawler
 * problem). No cookies, no auth headers, an honest user agent that says who we
 * are and why we are reading.
 */
export function createPageFetch(fetchImpl: typeof fetch = fetch): PageFetch {
  const once = async (url: string): Promise<{ res: Response } | { fail: PageFetchResult }> => {
    const guard = guardUrl(url);
    if (!guard.ok) return { fail: { ok: false, httpStatus: null, reason: guard.reason } };
    // An explicit controller rather than AbortSignal.timeout: the timeout is an
    // invariant worth a test, and that one cannot be driven by a fake clock.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WALK_FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(guard.url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': 'AdaAudit/1.0 (+https://gettinkers.com; reads the page your ads point at)',
          accept: 'text/html,application/xhtml+xml',
        },
      });
      return { res };
    } finally {
      clearTimeout(timer);
    }
  };

  return async (url) => {
    try {
      let attempt = await once(url);
      if ('fail' in attempt) return attempt.fail;
      let res = attempt.res;
      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get('location');
        if (!location) return { ok: false, httpStatus: res.status, reason: `the page answered HTTP ${res.status} with nowhere to go` };
        const next = new URL(location, url).toString();
        attempt = await once(next);
        if ('fail' in attempt) return attempt.fail;
        res = attempt.res;
        if (REDIRECT_STATUSES.has(res.status)) {
          return { ok: false, httpStatus: res.status, reason: 'the page redirects more than once' };
        }
      }
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > WALK_MAX_BYTES) {
        return { ok: false, httpStatus: res.status, reason: 'the page is too large to read' };
      }
      if (!res.ok) return { ok: false, httpStatus: res.status, reason: `the page answered HTTP ${res.status}` };
      const html = (await res.text()).slice(0, WALK_MAX_BYTES);
      const text = stripHtml(html).slice(0, EXTRACT_TEXT_CHARS);
      if (text.length < 200) {
        return { ok: false, httpStatus: res.status, reason: 'the page arrived with almost no readable text (it needs a browser to render)' };
      }
      return { ok: true, httpStatus: res.status, finalUrl: res.url || url, html, text };
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      return {
        ok: false,
        httpStatus: null,
        reason: name === 'TimeoutError' || name === 'AbortError'
          ? 'the page took too long to answer'
          : 'the page could not be reached',
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Extraction — what the page says, from what the page states outright
// ---------------------------------------------------------------------------

export interface PageRead {
  /** h1, else og:title, else <title>. */
  headline: string | null;
  page_title: string | null;
  /** The first sentence carrying an offer, a price or a guarantee. */
  offer_sentence: string | null;
  primary_cta: string | null
  social_proof: boolean;
  /** The proof as the page prints it, so the reader can check us. */
  social_proof_evidence: string | null;
}

/**
 * Collapse a phrase a page prints twice in one element. Hero markup routinely
 * carries a visually-hidden copy of its own headline, and the live walk quoted
 * "$2,000,000 Life Cover from $1 /day$2,000,000 Life Cover from $1 /day" back
 * to the customer as their headline.
 */
export function collapseRepeat(text: string): string {
  const clean = text.trim();
  const half = Math.floor(clean.length / 2);
  if (half < 8) return clean;
  for (const gap of ['', ' ', '. ', ' | ', ' - ']) {
    const first = clean.slice(0, half - Math.floor(gap.length / 2));
    if (clean === `${first}${gap}${first}`) return first.trim();
  }
  // An odd-length duplicate with a separator: split on the midpoint and compare.
  const left = clean.slice(0, half).trim();
  const right = clean.slice(half).replace(/^[\s.|,;:-]+/, '').trim();
  return left.length >= 8 && left.toLowerCase() === right.toLowerCase() ? left : clean;
}

const tagText = (html: string, re: RegExp): string | null => {
  const hit = re.exec(html);
  if (!hit?.[1]) return null;
  const text = collapseRepeat(stripHtml(hit[1]));
  return text.length > 0 ? text.slice(0, 240) : null;
};

const META_CONTENT = (html: string, property: string): string | null => {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]*>`, 'i');
  const tag = re.exec(html)?.[0];
  if (!tag) return null;
  const content = /content=["']([^"']*)["']/i.exec(tag)?.[1];
  const text = content ? collapseRepeat(stripHtml(content)) : '';
  return text.length > 0 ? text.slice(0, 240) : null;
};

const OFFER_MARKERS =
  /(\d{1,3}\s?%\s?off|free shipping|free trial|free quote|free consultation|money.back|guarantee|no obligation|starting at|starts at|from \$?\d|save \$?\d|\$\d|£\d|€\d)/i;
const CTA_VERBS =
  /^(get|start|buy|shop|book|claim|join|sign up|subscribe|order|request|apply|try|see|compare|call|talk|schedule|download|add to cart|check)\b/i;
const PROOF_PATTERNS: RegExp[] = [
  /\b[\d][\d,.]*\+?\s*(?:5[- ]star\s+)?(?:reviews?|ratings?|customers?|clients?|families|members|policies|installs)\b/i,
  /\b\d(?:\.\d)?\s*(?:out of|\/)\s*5\b/i,
  /\b(?:rated|trusted by|as seen (?:in|on)|voted)\b/i,
  /★|⭐/,
];

const sentences = (text: string): string[] =>
  text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 0);

/**
 * The page in five fields. Deterministic on purpose: a headline, an offer
 * sentence, a button label and a review count are printed, not inferred, and a
 * model asked to "read the page" invents the ones that are missing.
 */
export function extractPage(html: string): PageRead {
  const title = tagText(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const headline =
    tagText(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) ?? META_CONTENT(html, 'og:title') ?? title;

  // Sentences come from the BODY: the head's title and meta tags are not things
  // the visitor reads, and a page whose hero has no full stop would otherwise
  // hand back its own <title> as the offer.
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const visible = stripHtml(body).slice(0, EXTRACT_TEXT_CHARS);
  let offerSentence = sentences(visible).find((s) => OFFER_MARKERS.test(s) && s.length <= 260) ?? null;
  // A hero headline with no full stop runs into the next line: the headline is
  // already its own field, so it is not the offer as well.
  if (offerSentence && headline && offerSentence.startsWith(headline)) {
    const rest = offerSentence.slice(headline.length).trim();
    offerSentence = rest.length > 0 ? rest : offerSentence;
  }

  let cta = tagText(html, /<button[^>]*>([\s\S]*?)<\/button>/i);
  if (!cta || !CTA_VERBS.test(cta)) {
    cta = null;
    for (const m of html.matchAll(/<(?:a|button)\b[^>]*>([\s\S]*?)<\/(?:a|button)>/gi)) {
      const label = stripHtml(m[1] ?? '');
      if (label.length >= 3 && label.length <= 40 && CTA_VERBS.test(label)) {
        cta = label;
        break;
      }
    }
  }

  const proofSentence = sentences(visible).find((s) => PROOF_PATTERNS.some((re) => re.test(s))) ?? null;

  return {
    headline,
    page_title: title,
    offer_sentence: offerSentence,
    primary_cta: cta,
    social_proof: proofSentence != null,
    social_proof_evidence: proofSentence ? proofSentence.slice(0, 200) : null,
  };
}

// ---------------------------------------------------------------------------
// The one message-match read
// ---------------------------------------------------------------------------

export type MatchVerdict = 'matched' | 'partial' | 'mismatch' | 'inconclusive';

export interface MatchCheck {
  /** The promise, in the ad's own words. */
  promise: string;
  found_on_page: boolean;
  /** VERBATIM from the page. Null when the promise is not on it. */
  page_evidence: string | null;
  /** A string search on the page, or the one model read. */
  source: 'deterministic' | 'read';
}

const normalizeForSearch = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();

/** A quote counts as evidence only when the page really carries it. */
export function verifyEvidence(pageText: string, quote: string): boolean {
  const needle = normalizeForSearch(quote);
  if (needle.length < 3) return false;
  return normalizeForSearch(pageText).includes(needle);
}

/** Promises checkable without a model: discount codes, percentages, shipping. */
export function extractOfferPromises(adWords: string): string[] {
  const promises: string[] = [];
  for (const m of adWords.matchAll(/\b(?:code|coupon)[:\s]+"?([A-Z0-9]{3,20})\b/gi)) {
    const code = m[1];
    if (code && /\d|^[A-Z]{4,}$/.test(code)) promises.push(`code ${code}`);
  }
  for (const m of adWords.matchAll(/\b(\d{1,2})\s?%\s?off\b/gi)) promises.push(`${m[1]}% off`);
  if (/\bfree shipping\b/i.test(adWords)) promises.push('free shipping');
  if (/\bfree trial\b/i.test(adWords)) promises.push('free trial');
  return [...new Set(promises)];
}

/** Is a promise printed in a body of text, and where? */
export function findOfferMention(promise: string, text: string): { found: boolean; evidence: string | null } {
  const haystack = normalizeForSearch(text);
  const term = promise.startsWith('code ') ? promise.slice(5) : promise;
  const idx = haystack.indexOf(normalizeForSearch(term));
  if (idx >= 0) {
    return { found: true, evidence: text.slice(Math.max(0, idx - 40), idx + term.length + 40).trim() };
  }
  // "15% off" may be printed "15 % off" or "15%off".
  const pctMatch = /^(\d{1,2})% off$/.exec(promise);
  if (pctMatch && new RegExp(`\\b${pctMatch[1]}\\s?%\\s?off`, 'i').test(haystack)) {
    return { found: true, evidence: promise };
  }
  return { found: false, evidence: null };
}

export interface MatchOutcome {
  verdict: MatchVerdict;
  /** Verbatim page text. Null only when the verdict is inconclusive. */
  evidence_quote: string | null;
  checks: MatchCheck[];
}

/**
 * The verdict, and the rule that keeps it honest: nothing stronger than
 * `inconclusive` is returned without a quote from the page behind it. For a
 * kept promise the quote is where the page keeps it; for a mismatch it is what
 * the page says instead, because "we could not find it" needs to show what we
 * DID find.
 */
export function deriveMatch(checks: MatchCheck[], page: PageRead, pageText: string): MatchOutcome {
  if (checks.length === 0) return { verdict: 'inconclusive', evidence_quote: null, checks };
  const found = checks.filter((c) => c.found_on_page);
  const missing = checks.filter((c) => !c.found_on_page);

  if (missing.length === 0) {
    const quote = found.find((c) => c.page_evidence && verifyEvidence(pageText, c.page_evidence))?.page_evidence ?? null;
    return quote
      ? { verdict: 'matched', evidence_quote: quote, checks }
      : { verdict: 'inconclusive', evidence_quote: null, checks };
  }

  // What the page says instead: its own headline, else its own offer sentence.
  const instead = [page.headline, page.offer_sentence].find(
    (q): q is string => !!q && verifyEvidence(pageText, q),
  ) ?? null;

  if (found.length > 0) {
    const quote = found.find((c) => c.page_evidence && verifyEvidence(pageText, c.page_evidence))?.page_evidence ?? instead;
    return quote ? { verdict: 'partial', evidence_quote: quote, checks } : { verdict: 'inconclusive', evidence_quote: null, checks };
  }
  return instead
    ? { verdict: 'mismatch', evidence_quote: instead, checks }
    : { verdict: 'inconclusive', evidence_quote: null, checks };
}

/**
 * The model's checks, kept only where the page backs them, and only once per
 * line of page evidence. Two promises that both resolve to "See your
 * personalised rate in 60 seconds" are one kept promise: counting them twice
 * inflated the kept side of the live verdict.
 */
export function reconcileChecks(
  deterministic: MatchCheck[],
  fromRead: Array<{ promise?: unknown; found_on_page?: unknown; page_evidence?: unknown }>,
  pageText: string,
): MatchCheck[] {
  const out = [...deterministic];
  const claimed = new Set(deterministic.map((c) => normalizeForSearch(c.promise)));
  const evidenceSeen = new Set(
    deterministic.filter((c) => c.found_on_page && c.page_evidence).map((c) => normalizeForSearch(c.page_evidence!)),
  );
  for (const raw of fromRead) {
    const promise = typeof raw.promise === 'string' ? raw.promise.trim() : '';
    if (!promise) continue;
    const key = normalizeForSearch(promise);
    // A string search beats a judgment about the same promise.
    if (claimed.has(key)) continue;
    claimed.add(key);
    const evidence = typeof raw.page_evidence === 'string' ? raw.page_evidence.trim() : '';
    const found = raw.found_on_page === true;
    if (found) {
      // A quote the page does not carry is dropped, never published and never
      // turned into its opposite: an unverifiable claim is not evidence of
      // absence either.
      if (!evidence || !verifyEvidence(pageText, evidence)) continue;
      const line = normalizeForSearch(evidence);
      if (evidenceSeen.has(line)) continue;
      evidenceSeen.add(line);
      out.push({ promise, found_on_page: true, page_evidence: evidence, source: 'read' });
    } else {
      out.push({ promise, found_on_page: false, page_evidence: null, source: 'read' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

/** The page the money lands on, resolved from the landing chapter's ranking. */
export interface WalkDestination {
  url: string;
  spend30: number;
  spend_share_pct: number;
  ads_count: number;
}

export interface WalkAd {
  ad_id: string;
  ad_name: string | null;
  body: string | null;
  headline: string | null;
  spend30: number;
}

export interface WalkSectionResult {
  status: 'complete' | 'skipped';
  summary?: string;
  next_step?: string;
  skip_reason?: string;
  data?: Record<string, unknown>;
  warnings?: string[];
}

export interface SiteWalkArgs {
  currency: string;
  destination: WalkDestination | null;
  ad: WalkAd | null;
  fetchPage: PageFetch;
  /** The ONE model read. Absent or failing leaves the deterministic checks. */
  synthesize?: <T>(label: string, user: string) => Promise<T | null>;
  timeCapMs?: number;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

const money = (v: number, currency: string): string =>
  `${Math.round(v).toLocaleString('en-US')}${currency ? ` ${currency}` : ''}`;

const skipped = (reason: string): WalkSectionResult => ({ status: 'skipped', skip_reason: reason });

/**
 * Read the top landing page and match the top ad's promise against it.
 * NEVER throws: every failure is a skipped section with a reason in plain words,
 * and the landing chapter above it keeps its own wording either way.
 */
export async function runSiteWalk(args: SiteWalkArgs): Promise<WalkSectionResult> {
  const cap = args.timeCapMs ?? WALK_TIME_CAP_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      walk(args),
      new Promise<WalkSectionResult>((resolve) => {
        timer = setTimeout(() => resolve(skipped('reading the landing page took longer than we allow for it')), cap);
      }),
    ]);
  } catch (err) {
    args.log?.('site_walk_failed', { error: err instanceof Error ? err.message : String(err) });
    return skipped('the landing page could not be read this run');
  } finally {
    clearTimeout(timer);
  }
}

async function walk(args: SiteWalkArgs): Promise<WalkSectionResult> {
  const { destination, ad, currency } = args;
  if (!destination) return skipped('no destination could be resolved for the ads carrying spend');
  if (isOnPlatformUrl(destination.url)) {
    return skipped(`the top destination by spend is a Meta surface (${new URL(destination.url).hostname}), which has no landing page of its own to read`);
  }
  const guard = guardUrl(destination.url);
  if (!guard.ok) return skipped(guard.reason);

  const fetched = await args.fetchPage(guard.url);
  if (!fetched.ok) return skipped(`${fetched.reason}, so we did not read it this run`);

  const page = extractPage(fetched.html);
  const adWords = [ad?.headline, ad?.body].filter((v): v is string => !!v && v.trim().length > 0).join(' ').trim();

  const deterministic: MatchCheck[] = extractOfferPromises(adWords).map((promise) => {
    const hit = findOfferMention(promise, fetched.text);
    return { promise, found_on_page: hit.found, page_evidence: hit.evidence, source: 'deterministic' as const };
  });

  let checks = deterministic;
  if (adWords.length > 0 && args.synthesize) {
    try {
      const read = await args.synthesize<{ checks?: Array<Record<string, unknown>> }>(
        'message_match',
        `An ad and the page it sends people to. Decide, for each promise the AD makes, whether the PAGE keeps it.\n\n` +
          `AD (${ad?.ad_name ?? 'top spender'}), its own words:\n${adWords.slice(0, 1200)}\n\n` +
          `PAGE (${guard.url}), its visible text:\n${fetched.text.slice(0, 6000)}\n\n` +
          `Rules: at most 4 promises, each quoted from the AD's own words. A promise is "found" ONLY if the page ` +
          `carries it, and then page_evidence MUST be the exact page text that keeps it, copied character for ` +
          `character from the page text above. Never quote the ad as page evidence. Never invent a promise the ad ` +
          `does not make. If the ad makes no specific promise, return an empty list.\n` +
          `Schema: {"checks":[{"promise":"...","found_on_page":true|false,"page_evidence":"..."|null}]}`,
      );
      if (read?.checks?.length) checks = reconcileChecks(deterministic, read.checks, fetched.text);
    } catch (err) {
      args.log?.('site_walk_read_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  const outcome = deriveMatch(checks, page, fetched.text);
  const adSpendWord = ad && ad.spend30 > 0 ? money(ad.spend30, currency) : null;
  const missing = outcome.checks.filter((c) => !c.found_on_page);
  const kept = outcome.checks.filter((c) => c.found_on_page);
  const host = new URL(guard.url).hostname.replace(/^www\./, '');

  const summary =
    outcome.verdict === 'matched'
      ? `The page carrying the most spend keeps what the top ad promises. The ad says "${kept[0]!.promise}", and the page prints "${outcome.evidence_quote}".`
      : outcome.verdict === 'partial'
        ? `The page keeps part of what the top ad promises. "${missing[0]!.promise}" is not on it` +
          (adSpendWord ? `, and ${adSpendWord} ran on that ad in the last 30 days.` : '.')
        : outcome.verdict === 'mismatch'
          ? `The top ad promises "${missing[0]!.promise}". We read ${host}${new URL(guard.url).pathname} and could not find it. The page leads with "${outcome.evidence_quote}"` +
            (adSpendWord ? `, and ${adSpendWord} ran on that ad in the last 30 days.` : '.')
          : `We read ${host}${new URL(guard.url).pathname}, the destination carrying ${destination.spend_share_pct}% of mapped spend` +
            (page.headline ? `, which leads with "${page.headline}"` : '') +
            `. The top ad's words carry no promise we can check against it, so there is nothing to match yet.`;

  const signal = outcome.verdict === 'partial' || outcome.verdict === 'mismatch';
  const next_step = signal
    ? `Put "${missing[0]!.promise}" on ${host}${new URL(guard.url).pathname} where the visitor lands, or take it out of the ad. ` +
      `The two have to say the same thing before anything else on this page is worth testing, and this is the page side of the same click the funnel chapter reads upstream.`
    : undefined;

  return {
    status: 'complete',
    summary,
    ...(next_step ? { next_step } : {}),
    data: {
      window_days: 30,
      currency: currency || undefined,
      verdict: outcome.verdict,
      evidence_quote: outcome.evidence_quote,
      page: {
        url: guard.url,
        final_url: fetched.finalUrl,
        http_status: fetched.httpStatus,
        spend_30d: Math.round(destination.spend30),
        spend_share_pct: destination.spend_share_pct,
        ads_pointing_here: destination.ads_count,
        headline: page.headline,
        page_title: page.page_title,
        offer_sentence: page.offer_sentence,
        primary_cta: page.primary_cta,
        social_proof: page.social_proof,
        social_proof_evidence: page.social_proof_evidence,
      },
      ad: ad
        ? {
            ad_id: ad.ad_id,
            ad_name: ad.ad_name,
            spend_30d: Math.round(ad.spend30),
            words: adWords.slice(0, 400) || null,
          }
        : null,
      checks: outcome.checks,
      signal,
    },
    // An inconclusive read is never alarmed: it means we could not tell.
    warnings: outcome.verdict === 'mismatch'
      ? [`The ad's promise "${missing[0]!.promise}" does not appear on the page it sends people to.`]
      : undefined,
  };
}
