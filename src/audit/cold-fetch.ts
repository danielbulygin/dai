import { logger } from '../utils/logger.js';
import type { RawAdDay } from './cold-source.js';

/**
 * Cold-path Graph fetcher — the IMPURE half of the cold audit (cold-source.ts
 * is the pure mapper). Pulls a freshly-connected account's ad-level daily
 * history live from the Graph API with the CONNECTION token (never an agency
 * token — see meta-token.ts's hard guard).
 *
 * Design notes:
 * - The synchronous insights API rejects long ranges at ad level on big
 *   accounts (the warehouse uses async report jobs for backfills). Strangers
 *   are typically small, but we still CHUNK the 180d window into 30d slices —
 *   a failed slice degrades that slice only (daysCovered/caveat stay honest),
 *   it never kills the audit.
 * - Row cap mirrors the synced pack's honesty rule: if we truncate, we SAY so
 *   (truncated flag → dataCaveat upstream).
 */

const GRAPH = 'https://graph.facebook.com/v21.0';
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
  days?: number; // default 180 (cohort coverage)
  sliceDays?: number; // default 30
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
  const days = opts.days ?? 180;
  const sliceDays = opts.sliceDays ?? 30;
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
  const top = opts.top ?? 15;
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
    const resp = await fetch(
      `${GRAPH}/?ids=${ids.join(',')}` +
        `&fields=creative{asset_feed_spec{link_urls},object_story_spec{link_data{link},video_data{call_to_action}}}` +
        `&access_token=${token}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (!resp.ok) return {};
    const body = (await resp.json()) as Record<
      string,
      {
        creative?: {
          asset_feed_spec?: { link_urls?: Array<{ website_url?: string }> };
          object_story_spec?: { link_data?: { link?: string }; video_data?: { call_to_action?: { value?: { link?: string } } } };
        };
      }
    >;
    for (const adId of ids) {
      const c = body[adId]?.creative;
      const url =
        c?.asset_feed_spec?.link_urls?.[0]?.website_url ??
        c?.object_story_spec?.link_data?.link ??
        c?.object_story_spec?.video_data?.call_to_action?.value?.link;
      if (!url || !/^https?:\/\//.test(url)) continue;
      try {
        out[adId] = { market: null, path: new URL(url).pathname };
      } catch {
        /* malformed url — leave unresolved */
      }
    }
  } catch (err) {
    logger.warn({ err }, 'cold destination resolve failed (landing section degrades to unresolved)');
  }
  return out;
}
