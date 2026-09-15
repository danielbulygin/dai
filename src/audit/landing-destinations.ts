import { classifyDestination, type DeadUrlCheck } from './report-pack-extra.js';
import {
  createPageFetch,
  guardUrl,
  isOnPlatformUrl,
  normalizeDestination,
  type PageFetch,
  type PageFetchResult,
} from './site-walk.js';

/** Coverage of the live provider read, separate from website availability. */
export interface DestinationCoverage {
  status: 'complete' | 'partial' | 'unavailable';
  reason?: string;
  pages: number;
  adsRead: number;
}

const DESTINATION_CAP = 50;
const CHECK_CONCURRENCY = 3;
const CHECK_TIME_CAP_MS = 60_000;
const PAGE_TIME_CAP_MS = 25_000;

type DestinationGroup = {
  url: string;
  spend: number;
  ads: Set<string>;
  refusal?: string;
};

/** A refused URL is never fetched; do not print credentials or its query. */
function refusedDisplayUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return '(unreadable destination)';
  }
}

async function boundedPageRead(url: string, timeoutMs: number, supplied?: PageFetch): Promise<PageFetchResult> {
  const controller = new AbortController();
  // Abort the whole default read, including response-body consumption. The
  // reader's own timeout additionally guards each redirect hop.
  const read = supplied ?? createPageFetch((input, init) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (isOnPlatformUrl(target)) return Promise.reject(new Error('on-platform destination'));
    return fetch(input, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, controller.signal])
        : controller.signal,
    });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => read(url)).catch((): PageFetchResult => ({
        ok: false,
        httpStatus: null,
        reason: 'the page could not be reached',
      })),
      new Promise<PageFetchResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ ok: false, httpStatus: null, reason: 'the page read reached its time limit' });
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function classifyPage(url: string, result: PageFetchResult): Pick<DeadUrlCheck, 'verdict' | 'status' | 'reason'> {
  if (!result.ok) {
    // A failed read has no body. Only explicit missing-page status codes are
    // conclusive; blocked, oversized, empty, transient and slow reads are not.
    if (result.httpStatus === 404 || result.httpStatus === 410) {
      return { ...classifyDestination(url, url, result.httpStatus, ''), status: result.httpStatus };
    }
    return { verdict: 'inconclusive', status: result.httpStatus, reason: result.reason };
  }

  const finalGuard = guardUrl(result.finalUrl);
  if (!finalGuard.ok || isOnPlatformUrl(result.finalUrl)) {
    return {
      verdict: 'inconclusive',
      status: result.httpStatus,
      reason: finalGuard.ok ? 'the destination redirects to a social or messaging page' : finalGuard.reason,
    };
  }
  if (!result.html.trim() || result.text.trim().length < 200) {
    return { verdict: 'inconclusive', status: result.httpStatus, reason: 'the page did not return enough readable content' };
  }
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(result.html)?.[1] ?? '').trim();
  const blockedTitle = /^(?:just a moment|attention required|access denied|security check(?:point)?|security verification|checking your browser|verify (?:that )?you are human)(?:\b|[.!…])/i.test(title);
  const blockedText = /(?:verify (?:that )?you are human|checking your browser before|enable javascript and cookies to continue)/i.test(result.text);
  if (blockedTitle || blockedText) {
    return { verdict: 'inconclusive', status: result.httpStatus, reason: 'the page returned a browser or bot-verification screen' };
  }
  return {
    ...classifyDestination(url, result.finalUrl, result.httpStatus, result.html.slice(0, 65_536)),
    status: result.httpStatus,
  };
}

/**
 * Tokenless website checks for destinations just resolved through the scoped
 * provider seam. Historical spend orders the checks; it does not prove that an
 * ACTIVE ad is spending today. Paused or unknown-status ads are never checked.
 */
export async function checkLandingDestinations(input: {
  landingUrls: Record<string, string>;
  activeAdIds: string[];
  spendingAds: Array<{ ad_id: string; ad_name: string; spend: number }>;
  fetchPage?: PageFetch;
}): Promise<{ checks: DeadUrlCheck[]; uncheckedUrls: number; urlByAdId: Map<string, string> }> {
  const active = new Set(input.activeAdIds);
  const urlByAdId = new Map<string, string>();
  const byUrl = new Map<string, DestinationGroup>();
  for (const ad of input.spendingAds) {
    if (!active.has(ad.ad_id) || !Number.isFinite(ad.spend) || ad.spend <= 0) continue;
    const raw = input.landingUrls[ad.ad_id];
    if (!raw) continue;

    // Validate before normalizing: credentials and non-standard ports must
    // remain visible to the guard, even if they would disappear from grouping.
    const guard = guardUrl(raw);
    const refusal = !guard.ok ? guard.reason : isOnPlatformUrl(raw)
      ? 'the ad opens a social or messaging destination rather than a website'
      : undefined;
    const url = refusal ? refusedDisplayUrl(raw) : normalizeDestination(raw);
    if (!url) continue;
    if (!refusal) urlByAdId.set(ad.ad_id, url);
    const key = refusal ? `refused:${raw}` : url;
    const group = byUrl.get(key) ?? { url, spend: 0, ads: new Set<string>(), refusal };
    group.spend += ad.spend;
    group.ads.add(ad.ad_name || ad.ad_id);
    byUrl.set(key, group);
  }

  const ranked = [...byUrl.values()].sort((a, b) => b.spend - a.spend);
  const selected = ranked.slice(0, DESTINATION_CAP);
  const checks: Array<DeadUrlCheck | undefined> = new Array(selected.length);
  const deadline = Date.now() + CHECK_TIME_CAP_MS;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < selected.length && Date.now() < deadline) {
      const index = cursor++;
      const group = selected[index]!;
      const verdict = group.refusal
        ? { verdict: 'inconclusive' as const, status: null, reason: group.refusal }
        : classifyPage(group.url, await boundedPageRead(
          group.url,
          Math.min(PAGE_TIME_CAP_MS, Math.max(1, deadline - Date.now())),
          input.fetchPage,
        ));
      checks[index] = {
        url: group.url,
        ...verdict,
        // Retain the established data field for callers. Its basis is the
        // historical 30-day average, never verified current burn or savings.
        daily_burn: group.spend / 30,
        ads: [...group.ads],
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, selected.length) }, worker));
  const completed = checks.filter((check): check is DeadUrlCheck => check != null);
  return { checks: completed, uncheckedUrls: ranked.length - completed.length, urlByAdId };
}
