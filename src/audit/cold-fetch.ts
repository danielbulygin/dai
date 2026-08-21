import { logger } from '../utils/logger.js';
import type { RawAdDay } from './cold-source.js';
import { SIX_MONTH_DAYS } from './audit-window.js';

/**
 * Cold-path Graph fetcher — the IMPURE half of the cold audit (cold-source.ts
 * is the pure mapper). Pulls a freshly-connected account's ad-level daily
 * history live from the Graph API with the CONNECTION token (never an agency
 * token — see meta-token.ts's hard guard).
 *
 * Design notes:
 * - The synchronous insights API rejects long ranges at ad level on big
 *   accounts (the warehouse uses async report jobs for backfills). Strangers
 *   are typically small, but we still CHUNK the six-month window into ≤31-day slices,
 *   a failed slice degrades that slice only (daysCovered/caveat stay honest),
 *   it never kills the audit.
 * - Row cap mirrors the synced pack's honesty rule: if we truncate, we SAY so
 *   (truncated flag → dataCaveat upstream).
 */

const GRAPH = 'https://graph.facebook.com/v21.0';

/** The creative shapes a destination URL can hide in. Pulled out as a pure,
 *  testable function because the first live cold audit under-resolved spend:
 *  the original three paths missed carousel child_attachments (each card its
 *  own link) — a real, safe miss. Catalog/DPA ads route to per-product URLs
 *  with no single stable destination; those stay unresolved on purpose (the
 *  landing report's coverage floor is the honest treatment for them). */
export interface RawCreative {
  asset_feed_spec?: { link_urls?: Array<{ website_url?: string }> };
  object_story_spec?: {
    link_data?: { link?: string; child_attachments?: Array<{ link?: string }> };
    video_data?: { call_to_action?: { value?: { link?: string } } };
    template_data?: { link?: string };
  };
}

export function pickDestinationUrl(creative: RawCreative | undefined): string | null {
  const c = creative;
  const cand =
    c?.asset_feed_spec?.link_urls?.[0]?.website_url ??
    c?.object_story_spec?.link_data?.link ??
    c?.object_story_spec?.link_data?.child_attachments?.find((a) => a?.link)?.link ??
    c?.object_story_spec?.template_data?.link ??
    c?.object_story_spec?.video_data?.call_to_action?.value?.link;
  return cand && /^https?:\/\//.test(cand) ? cand : null;
}
const FIELDS =
  'ad_id,ad_name,adset_id,spend,impressions,clicks,frequency,actions,action_values,video_thruplay_watched_actions';

export interface ColdPullResult {
  adDays: RawAdDay[];
  /** True when the row cap cut the pull short — surface as a data caveat. */
  truncated: boolean;
  /** Slices that failed outright (network/API) — logged, audit continues. */
  failedSlices: number;
}

export interface ColdFetchOptions {
  days?: number; // default SIX_MONTH_DAYS (cohort + creative-inventory coverage)
  sliceDays?: number; // default 31
  maxRows?: number; // default 150_000
  asOf?: string; // YYYY-MM-DD, default today (UTC) — explicit for tests
}

const isoDaysAgo = (asOf: string, days: number): string => {
  const d = new Date(`${asOf}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

/** Account display name + currency — the recognition strip's identity beat. */
export async function fetchAccountMeta(
  token: string,
  adAccountId: string,
): Promise<{ name: string | null; currency: string }> {
  const resp = await fetch(`${GRAPH}/${adAccountId}?fields=name,currency&access_token=${token}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`account meta read failed: ${resp.status}`);
  const body = (await resp.json()) as { name?: string; currency?: string };
  return { name: body.name ?? null, currency: body.currency ?? 'EUR' };
}

/**
 * Pull level=ad, time_increment=1 insights for the window, sliced + paginated.
 * Returns raw Graph rows in the exact shape buildColdRows normalizes.
 */
export async function fetchColdAdDays(
  token: string,
  adAccountId: string,
  opts: ColdFetchOptions = {},
): Promise<ColdPullResult> {
  const days = opts.days ?? SIX_MONTH_DAYS;
  const sliceDays = opts.sliceDays ?? 31;
  const maxRows = opts.maxRows ?? 150_000;
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);

  const adDays: RawAdDay[] = [];
  let truncated = false;
  let failedSlices = 0;

  for (let offset = 0; offset < days && !truncated; offset += sliceDays) {
    const until = isoDaysAgo(asOf, offset);
    const since = isoDaysAgo(asOf, Math.min(offset + sliceDays - 1, days));
    const range = encodeURIComponent(JSON.stringify({ since, until }));
    let url =
      `${GRAPH}/${adAccountId}/insights?level=ad&time_increment=1&time_range=${range}` +
      `&fields=${FIELDS}&limit=500&access_token=${token}`;
    try {
      for (let page = 0; page < 100 && url; page++) {
        const resp = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (!resp.ok) {
          const bodyText = await resp.text().catch(() => '');
          throw new Error(`insights slice ${since}..${until} failed: ${resp.status} ${bodyText.slice(0, 200)}`);
        }
        const body = (await resp.json()) as { data?: RawAdDay[]; paging?: { next?: string } };
        for (const row of body.data ?? []) {
          if (adDays.length >= maxRows) {
            truncated = true;
            break;
          }
          adDays.push(row);
        }
        if (truncated) break;
        url = body.paging?.next ?? '';
      }
    } catch (err) {
      failedSlices += 1;
      logger.warn({ err, since, until }, 'cold pull slice failed (audit continues on partial window)');
    }
  }

  if (truncated) {
    logger.error({ adAccountId, rows: adDays.length, maxRows }, 'cold pull hit row cap — aggregates incomplete');
  }
  return { adDays, truncated, failedSlices };
}

/**
 * Resolve current landing destinations for the top-spend ads (30d) — the same
 * creative-resolution GET the dead-URL check uses (live creative reads, never
 * a stored landing_page_raw, which goes stale on dynamic creatives).
 * Returns the `destinations` map buildColdRows attaches to landing30.
 */
export async function resolveDestinations(
  token: string,
  adDays: RawAdDay[],
  opts: { top?: number; asOf?: string } = {},
): Promise<Record<string, { market: string | null; path: string | null }>> {
  // Top 15 was a 46%-of-spend cap on the first live cold audit — the landing
  // report undercounted a page's spend 2× (Dan caught daily-celery at £1,954
  // vs £4k+ real, 2026-07-04). Resolve enough ads to cover ~all mapped spend;
  // the ?ids= batch endpoint takes 50 per call, so this is ceil(top/50) calls.
  const top = opts.top ?? 100;
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const cut30 = isoDaysAgo(asOf, 30);

  const spendByAd = new Map<string, number>();
  for (const r of adDays) {
    const adId = r.ad_id ? String(r.ad_id) : '';
    const date = (r.date_start ?? '').slice(0, 10);
    if (!adId || !date || date < cut30) continue;
    const spend = typeof r.spend === 'number' ? r.spend : parseFloat(String(r.spend ?? '0')) || 0;
    spendByAd.set(adId, (spendByAd.get(adId) ?? 0) + spend);
  }
  const ids = [...spendByAd.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([id]) => id);
  if (ids.length === 0) return {};

  const out: Record<string, { market: string | null; path: string | null }> = {};
  try {
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const resp = await fetch(
        `${GRAPH}/?ids=${batch.join(',')}` +
          `&fields=creative{asset_feed_spec{link_urls},object_story_spec{link_data{link,child_attachments{link}},video_data{call_to_action},template_data{link}}}` +
          `&access_token=${token}`,
        { signal: AbortSignal.timeout(30_000) },
      );
      if (!resp.ok) break; // keep whatever earlier batches resolved
      const body = (await resp.json()) as Record<string, { creative?: RawCreative }>;
      for (const adId of batch) {
        const url = pickDestinationUrl(body[adId]?.creative);
        if (!url) continue;
        try {
          out[adId] = { market: null, path: new URL(url).pathname };
        } catch {
          /* malformed url — leave unresolved */
        }
      }
    }
    return out;
  } catch (err) {
    logger.warn({ err }, 'cold destination resolve failed (landing section degrades to unresolved)');
  }
  return out;
}
