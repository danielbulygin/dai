import { getTokenForClient } from "../../integrations/meta-token.js";
import { graphGet } from "../../integrations/meta-graph.js";
import { getSupabase } from "../../integrations/supabase.js";
import { env } from "../../env.js";
import { logger } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// Resolve client code → ad_account_id from BMAD Supabase
// ---------------------------------------------------------------------------

async function resolveAdAccountId(
  clientCode: string,
): Promise<
  { adAccountId: string; timezone: string; currency: string; token: string } | { error: string }
> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("clients")
    .select("ad_account_id, timezone, currency")
    .eq("code", clientCode)
    .single();
  if (error || !data) {
    return { error: `Client '${clientCode}' not found` };
  }

  // The token must follow the CLIENT, not the agency. getTokenForClient
  // returns the customer's own OAuth connection when there is one and falls
  // back to the agency env token for legacy agency clients. Before this, every
  // call used the agency token, so an external Ada customer got
  // "Ad account owner has NOT granted ads_management or ads_read permission"
  // and Ada correctly reported she had no data (verified 2026-07-25).
  const resolved = await getTokenForClient({ clientCode });
  if (!resolved) {
    return {
      error: `No usable Meta access for '${clientCode}'. The customer's connection may have expired, or the account is not connected.`,
    };
  }

  return {
    adAccountId: resolved.adAccountId,
    timezone: (data.timezone as string) || "Europe/Berlin",
    currency: (data.currency as string) || "EUR",
    token: resolved.token,
  };
}

// ---------------------------------------------------------------------------
// Facebook Graph API request helper
// ---------------------------------------------------------------------------

/**
 * Edge-shaped adapter over the shared graphGet helper (integrations/meta-graph.ts).
 * The version pin, 429 message, error unwrap, and 500-row pagination cap all
 * live there now, so this file and the investigation surface can't drift.
 * Node responses collapse to [] exactly as this function always did.
 */
async function metaApiRequest(
  endpoint: string,
  params: Record<string, string>,
  /** The CLIENT's token. Falls back to the agency env token when absent. */
  accessToken?: string,
): Promise<{ data?: unknown[]; error?: string }> {
  const token = accessToken || env.META_ACCESS_TOKEN;
  if (!token) {
    return { error: "No Meta access token available for this client." };
  }

  const result = await graphGet(endpoint, params, token);
  if (result.error) return { error: result.error };
  return { data: result.data ?? [] };
}

// ---------------------------------------------------------------------------
// query_meta_insights — direct Facebook Insights API access
// ---------------------------------------------------------------------------

export async function queryMetaInsights(params: {
  clientCode: string;
  dateStart: string;
  dateEnd: string;
  level?: "account" | "campaign" | "adset" | "ad";
  timeIncrement?: "daily" | "hourly" | "all_days";
  campaignId?: string;
  adsetId?: string;
  breakdowns?: string;
  fields?: string;
  limit?: number;
}): Promise<string> {
  try {
    const resolved = await resolveAdAccountId(params.clientCode);
    if ("error" in resolved) return JSON.stringify(resolved);

    const { adAccountId, token } = resolved;
    const level = params.level ?? "account";

    // Default fields — comprehensive but not overwhelming
    const defaultFields =
      "spend,impressions,reach,frequency,clicks,cpc,cpm,ctr," +
      "actions,action_values,cost_per_action_type";

    const apiParams: Record<string, string> = {
      fields: params.fields ?? defaultFields,
      time_range: JSON.stringify({
        since: params.dateStart,
        until: params.dateEnd,
      }),
    };

    // Level (account, campaign, adset, ad)
    if (level !== "account") {
      apiParams.level = level;
    }

    // Time increment — hourly uses a special breakdown
    if (params.timeIncrement === "hourly") {
      apiParams.breakdowns = params.breakdowns
        ? `hourly_stats_aggregated_by_advertiser_time_zone,${params.breakdowns}`
        : "hourly_stats_aggregated_by_advertiser_time_zone";
    } else if (params.timeIncrement === "daily") {
      apiParams.time_increment = "1";
    }
    // "all_days" = no time_increment (aggregate over whole range) — default behavior

    // Non-hourly breakdowns
    if (params.breakdowns && params.timeIncrement !== "hourly") {
      apiParams.breakdowns = params.breakdowns;
    }

    // Filtering by campaign or adset
    const filtering: Array<Record<string, unknown>> = [];
    if (params.campaignId) {
      filtering.push({
        field: "campaign.id",
        operator: "EQUAL",
        value: params.campaignId,
      });
    }
    if (params.adsetId) {
      filtering.push({
        field: "adset.id",
        operator: "EQUAL",
        value: params.adsetId,
      });
    }
    if (filtering.length > 0) {
      apiParams.filtering = JSON.stringify(filtering);
    }

    if (params.limit) {
      apiParams.limit = String(params.limit);
    }

    const result = await metaApiRequest(`${adAccountId}/insights`, apiParams, token);

    if (result.error) {
      return JSON.stringify({ error: result.error });
    }

    logger.info(
      { clientCode: params.clientCode, level, rows: result.data?.length },
      "Meta Insights API query complete",
    );

    return JSON.stringify({
      client: params.clientCode,
      ad_account_id: adAccountId,
      level,
      date_range: { start: params.dateStart, end: params.dateEnd },
      time_increment: params.timeIncrement ?? "all_days",
      rows: result.data?.length ?? 0,
      data: result.data,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "queryMetaInsights failed");
    return JSON.stringify({ error: msg });
  }
}

// ---------------------------------------------------------------------------
// query_meta_creatives — direct Facebook Marketing API access for creative
// configuration (Instagram identity, page, object_story_spec, link URL, etc.)
// ---------------------------------------------------------------------------

// NOTE: effective_instagram_actor_id was removed (2026-06-21). It 400s in Graph
// v22 — "(#100) Tried accessing nonexisting field" — on BOTH the adcreative node
// AND the ad node (verified by probe), so it was firing on every creatives lookup.
// IG/page identity is still covered by instagram_user_id + instagram_permalink_url
// + page_id + object_story_spec below.
const DEFAULT_CREATIVE_FIELDS =
  "id,name,status,effective_status," +
  "creative{id,name,instagram_actor_id," +
  "instagram_user_id,instagram_permalink_url," +
  "page_id,object_story_id,effective_object_story_id,object_story_spec," +
  "thumbnail_url,video_id,image_url,image_hash,title,body," +
  "link_url,call_to_action_type,asset_feed_spec}";

export async function queryMetaCreatives(params: {
  clientCode: string;
  campaignId?: string;
  adsetId?: string;
  adIds?: string[];
  fields?: string;
  effectiveStatus?: string[]; // e.g. ["ACTIVE"]
  limit?: number;
}): Promise<string> {
  try {
    const resolved = await resolveAdAccountId(params.clientCode);
    if ("error" in resolved) return JSON.stringify(resolved);

    const { adAccountId, token } = resolved;

    if (!params.campaignId && !params.adsetId && !(params.adIds && params.adIds.length > 0)) {
      return JSON.stringify({
        error:
          "Must specify campaignId, adsetId, or adIds. Querying every ad in an account is not supported.",
      });
    }

    const apiParams: Record<string, string> = {
      fields: params.fields ?? DEFAULT_CREATIVE_FIELDS,
    };

    const filtering: Array<Record<string, unknown>> = [];
    if (params.campaignId) {
      filtering.push({ field: "campaign.id", operator: "EQUAL", value: params.campaignId });
    }
    if (params.adsetId) {
      filtering.push({ field: "adset.id", operator: "EQUAL", value: params.adsetId });
    }
    if (params.adIds && params.adIds.length > 0) {
      filtering.push({ field: "ad.id", operator: "IN", value: params.adIds });
    }
    if (filtering.length > 0) {
      apiParams.filtering = JSON.stringify(filtering);
    }

    if (params.effectiveStatus && params.effectiveStatus.length > 0) {
      apiParams.effective_status = JSON.stringify(params.effectiveStatus);
    }

    apiParams.limit = String(params.limit ?? 100);

    const result = await metaApiRequest(`${adAccountId}/ads`, apiParams, token);

    if (result.error) {
      return JSON.stringify({ error: result.error });
    }

    logger.info(
      { clientCode: params.clientCode, ads: result.data?.length },
      "Meta Creatives API query complete",
    );

    return JSON.stringify({
      client: params.clientCode,
      ad_account_id: adAccountId,
      campaign_id: params.campaignId ?? null,
      adset_id: params.adsetId ?? null,
      ad_count: result.data?.length ?? 0,
      data: result.data,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "queryMetaCreatives failed");
    return JSON.stringify({ error: msg });
  }
}

// ---------------------------------------------------------------------------
// check_ads_in_meta — does an AOT ad_id_code (e.g. PLx3942) exist in the
// client's Meta ad account, as either an ad set name or an ad name?
//
// Used by Piper to reconcile open "Upload and Configure Campaign" tasks
// against the actual Meta account. The naming convention is reliable: every
// ad and ad set carries the ad_id_code in its name.
//
// Status-agnostic by design — paused/archived ads still count as "uploaded".
// ---------------------------------------------------------------------------

interface MetaNameMatch {
  id: string;
  name: string;
  effective_status: string;
  status?: string;
}

interface AdIdCodeReport {
  ad_id_code: string;
  found: boolean;
  matched_adsets: MetaNameMatch[];
  matched_ads: Array<MetaNameMatch & { adset_id?: string; campaign_id?: string }>;
}

async function lookupCodeInMeta(
  adAccountId: string,
  code: string,
  token: string,
): Promise<AdIdCodeReport> {
  const filterFor = (value: string) =>
    JSON.stringify([{ field: 'name', operator: 'CONTAIN', value }]);

  const [adsetResult, adResult] = await Promise.all([
    metaApiRequest(`${adAccountId}/adsets`, {
      filtering: filterFor(code),
      fields: 'id,name,effective_status,status,campaign_id',
      limit: '50',
    }, token),
    metaApiRequest(`${adAccountId}/ads`, {
      filtering: filterFor(code),
      fields: 'id,name,effective_status,status,adset_id,campaign_id',
      limit: '50',
    }, token),
  ]);

  const adsets = (adsetResult.data ?? []) as MetaNameMatch[];
  const ads = (adResult.data ?? []) as Array<MetaNameMatch & { adset_id?: string; campaign_id?: string }>;

  return {
    ad_id_code: code,
    found: adsets.length > 0 || ads.length > 0,
    matched_adsets: adsets,
    matched_ads: ads,
  };
}

export async function checkAdsInMeta(params: {
  clientCode: string;
  adIdCodes: string[];
}): Promise<string> {
  try {
    if (!params.adIdCodes || params.adIdCodes.length === 0) {
      return JSON.stringify({ error: 'adIdCodes must be a non-empty array' });
    }
    if (params.adIdCodes.length > 50) {
      return JSON.stringify({ error: 'Too many ad_id_codes — max 50 per call (one Graph request per code per level).' });
    }

    const resolved = await resolveAdAccountId(params.clientCode);
    if ('error' in resolved) return JSON.stringify(resolved);
    const { adAccountId, token } = resolved;

    const uniqueCodes = Array.from(new Set(params.adIdCodes));
    const reports = await Promise.all(uniqueCodes.map((code) => lookupCodeInMeta(adAccountId, code, token)));

    const foundCount = reports.filter((r) => r.found).length;
    logger.info(
      { clientCode: params.clientCode, codes: uniqueCodes.length, found: foundCount },
      'Meta ad-existence check complete',
    );

    return JSON.stringify({
      client: params.clientCode,
      ad_account_id: adAccountId,
      codes_checked: uniqueCodes.length,
      found_count: foundCount,
      not_found_count: uniqueCodes.length - foundCount,
      reports,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, 'checkAdsInMeta failed');
    return JSON.stringify({ error: msg });
  }
}

// ---------------------------------------------------------------------------
// get_pixel_event_stats — what is this account's pixel ACTUALLY firing?
//
// Built 2026-08-25 after web-Ada was asked about "our new qualified subscriber
// event", called no tool at all, and guessed the event was low-volume and risky.
// The pixel said the opposite: the event is named QualifiedSubscription and it
// fires several times per purchase. A volume claim nobody read is a fabricated
// receipt, so this is the tool that makes reading it possible.
//
// Two shapes Meta forces on us, both found by probe (2026-08-25):
//  - /stats buckets are HOURLY, not daily. 7 days is 168 rows (~800KB); 14 days
//    is refused outright with "Please reduce the amount of data you're asking
//    for". So the window is walked in <=7-day chunks and summed here.
//  - each bucket carries at most 100 distinct events. A pixel with a longer tail
//    than that loses its rarest events per bucket, so the caveat is REPORTED
//    rather than hidden — an undercount presented as a count is the same lie as
//    a guess.
// A pixel we cannot read (the practice account answers (#100) Permission Denied)
// is reported as unreadable, NEVER as zero: "nothing fired" and "I could not
// look" collapsing into one number is exactly the failure this tool exists for.
// ---------------------------------------------------------------------------

/** Events whose counts are always carried, so a ratio is one line away. */
const BENCHMARK_EVENTS = [
  "Purchase",
  "CompleteRegistration",
  "StartTrial",
  "Subscribe",
];

const STATS_CHUNK_DAYS = 7;
const TOP_EVENTS_RETURNED = 15;
/** Meta's own per-bucket ceiling — hitting it means the tail is incomplete. */
const STATS_BUCKET_EVENT_CAP = 100;

/** Case, space, underscore and hyphen insensitive: "qualified subscriber" == "Qualified_Subscriber". */
function normalizeEventName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

interface EventMatch {
  event: string;
  count: number;
  how: "exact" | "normalized" | "substring" | "stem";
}

/**
 * Word stems for the loosest matching rung.
 *
 * The case this exists for: a customer says "qualified subscriber" and the
 * pixel calls it "QualifiedSubscription". Same words, different endings, so
 * neither string contains the other and every tighter rung misses -- which is
 * the exact question that started this whole tool. Six characters keeps
 * "qualif"/"subscr" apart from anything else on a real pixel; short tokens are
 * kept whole, and tokens under three characters are dropped because they carry
 * no signal and would match everything.
 */
function eventStems(loose: string): string[] {
  return loose
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3)
    .map((token) => (token.length > 6 ? token.slice(0, 6) : token));
}

/** Fuzzy-resolve a loosely typed event name against the names the pixel really fired. */
function matchEventName(
  loose: string,
  counts: Map<string, number>,
): EventMatch[] {
  const wanted = normalizeEventName(loose);
  if (!wanted) return [];
  const stems = eventStems(loose);
  const exact: EventMatch[] = [];
  const normalized: EventMatch[] = [];
  const substring: EventMatch[] = [];
  const stemmed: EventMatch[] = [];
  for (const [event, count] of counts) {
    const norm = normalizeEventName(event);
    if (event === loose) exact.push({ event, count, how: "exact" });
    else if (norm === wanted)
      normalized.push({ event, count, how: "normalized" });
    else if (norm.includes(wanted) || wanted.includes(norm))
      substring.push({ event, count, how: "substring" });
    else if (stems.length > 0 && stems.every((stem) => norm.includes(stem)))
      stemmed.push({ event, count, how: "stem" });
  }
  const byCount = (a: EventMatch, b: EventMatch) => b.count - a.count;
  if (exact.length) return exact.sort(byCount);
  if (normalized.length) return normalized.sort(byCount);
  // The two loose rungs are the easiest to over-match on a short word, so each
  // is capped and only ever reached when nothing tighter has hit.
  if (substring.length) return substring.sort(byCount).slice(0, 5);
  return stemmed.sort(byCount).slice(0, 5);
}

interface PixelRow {
  id: string;
  name?: string;
  last_fired_time?: string;
}

interface PixelStatsRead {
  pixel_id: string;
  pixel_name: string | null;
  last_fired_time: string | null;
  readable: boolean;
  error?: string;
  note?: string;
  total_events?: number;
  distinct_events?: number;
  top_events?: Array<{ event: string; count: number }>;
  benchmark_events?: Record<string, number | null>;
  matched?:
    | { resolvedFrom: string; resolvedTo: string[]; matches: EventMatch[] }
    | { resolvedFrom: string; resolvedTo: null; note: string };
  caveats?: string[];
}

/** Sum `count` per event `value` across every hourly bucket of one chunked read. */
async function readPixelEventCounts(
  pixelId: string,
  startUnix: number,
  endUnix: number,
  token: string,
): Promise<{
  counts: Map<string, number>;
  buckets: number;
  capped: boolean;
  error?: string;
}> {
  const counts = new Map<string, number>();
  let buckets = 0;
  let capped = false;

  for (
    let from = startUnix;
    from < endUnix;
    from += STATS_CHUNK_DAYS * 86_400
  ) {
    const to = Math.min(from + STATS_CHUNK_DAYS * 86_400, endUnix);
    const res = await graphGet(
      `${pixelId}/stats`,
      { aggregation: "event", start_time: String(from), end_time: String(to) },
      token,
      // 24h x 7d = 168 rows per chunk; the 500-row default would silently
      // truncate a chunk Meta happened to split more finely.
      { maxRows: 2000, maxBytes: 24 * 1024 * 1024 },
    );
    if (res.error) return { counts, buckets, capped, error: res.error };
    for (const raw of (res.data ?? []) as Array<{
      data?: Array<{ value?: unknown; count?: unknown }>;
    }>) {
      const entries = Array.isArray(raw.data) ? raw.data : [];
      buckets += 1;
      if (entries.length >= STATS_BUCKET_EVENT_CAP) capped = true;
      for (const entry of entries) {
        const name = typeof entry.value === "string" ? entry.value : null;
        const count = Number(entry.count ?? 0);
        if (!name || !Number.isFinite(count)) continue;
        counts.set(name, (counts.get(name) ?? 0) + count);
      }
    }
  }

  return { counts, buckets, capped };
}

export async function getPixelEventStats(params: {
  clientCode: string;
  days?: number;
  event?: string;
}): Promise<string> {
  try {
    const requestedDays = Number(params.days ?? 7);
    const days = Number.isFinite(requestedDays)
      ? Math.min(28, Math.max(1, Math.round(requestedDays)))
      : 7;

    const resolved = await resolveAdAccountId(params.clientCode);
    if ("error" in resolved) return JSON.stringify(resolved);
    const { adAccountId, token } = resolved;

    const pixelRes = await graphGet(
      `${adAccountId}/adspixels`,
      { fields: "id,name,last_fired_time", limit: "25" },
      token,
    );
    if (pixelRes.error) {
      return JSON.stringify({
        client: params.clientCode,
        ad_account_id: adAccountId,
        error: pixelRes.error,
        note: "The pixel LIST could not be read. That says nothing about whether a pixel exists — do not report 'no pixel'.",
      });
    }

    const pixels = (pixelRes.data ?? []) as PixelRow[];
    const endUnix = Math.floor(Date.now() / 1000);
    const startUnix = endUnix - days * 86_400;
    const window = {
      days,
      since: new Date(startUnix * 1000).toISOString().slice(0, 10),
      until: new Date(endUnix * 1000).toISOString().slice(0, 10),
    };

    if (pixels.length === 0) {
      return JSON.stringify({
        client: params.clientCode,
        ad_account_id: adAccountId,
        window,
        pixel_count: 0,
        pixels: [],
        note: "No pixel (dataset) is attached to this ad account. The list read succeeded and came back empty, so this IS the account's state, not a read failure.",
      });
    }

    const reads: PixelStatsRead[] = [];
    for (const pixel of pixels) {
      const { counts, buckets, capped, error } = await readPixelEventCounts(
        pixel.id,
        startUnix,
        endUnix,
        token,
      );
      const base = {
        pixel_id: pixel.id,
        pixel_name: pixel.name ?? null,
        last_fired_time: pixel.last_fired_time ?? null,
      };

      if (error) {
        reads.push({
          ...base,
          readable: false,
          error,
          note: "Meta refused the event-count read for this pixel. That is NOT a zero — never say this pixel fired nothing; say the counts could not be read.",
        });
        continue;
      }

      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const total = sorted.reduce((sum, [, count]) => sum + count, 0);
      const benchmark: Record<string, number | null> = {};
      for (const name of BENCHMARK_EVENTS)
        benchmark[name] = counts.get(name) ?? null;

      const caveats: string[] = [];
      if (capped) {
        caveats.push(
          `Meta returns at most ${STATS_BUCKET_EVENT_CAP} distinct events per hourly bucket and this pixel hit that ceiling, so the rarest events may be undercounted. The top events are reliable.`,
        );
      }
      if (buckets === 0) {
        caveats.push(
          "The read succeeded but returned no time buckets at all for this window.",
        );
      }

      const read: PixelStatsRead = {
        ...base,
        readable: true,
        total_events: total,
        distinct_events: sorted.length,
        top_events: sorted
          .slice(0, TOP_EVENTS_RETURNED)
          .map(([event, count]) => ({ event, count })),
        benchmark_events: benchmark,
        ...(caveats.length ? { caveats } : {}),
      };

      if (params.event) {
        const matches = matchEventName(params.event, counts);
        read.matched = matches.length
          ? {
              resolvedFrom: params.event,
              resolvedTo: matches.map((m) => m.event),
              matches,
            }
          : {
              resolvedFrom: params.event,
              resolvedTo: null,
              note: `No event on this pixel matches "${params.event}" in this window. Say so plainly rather than assuming the name is right.`,
            };
      }

      reads.push(read);
    }

    logger.info(
      { clientCode: params.clientCode, pixels: pixels.length, days },
      "Pixel event stats read complete",
    );

    return JSON.stringify({
      client: params.clientCode,
      ad_account_id: adAccountId,
      window,
      pixel_count: pixels.length,
      pixels: reads,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "getPixelEventStats failed");
    return JSON.stringify({ error: msg });
  }
}

// ---------------------------------------------------------------------------
// get_custom_conversions — the account's OWN named conversions, with the rule
// that defines each one. Half the "what is that event?" questions are about a
// custom conversion rather than a raw pixel event, and the rule is what says
// which raw event and which URL it is built from.
// ---------------------------------------------------------------------------

/** Rules are JSON blobs; the model needs their shape, not the whole thing. */
const RULE_MAX_CHARS = 160;

function truncateRule(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  return text.length > RULE_MAX_CHARS
    ? `${text.slice(0, RULE_MAX_CHARS)}...`
    : text;
}

export async function getCustomConversions(params: {
  clientCode: string;
}): Promise<string> {
  try {
    const resolved = await resolveAdAccountId(params.clientCode);
    if ("error" in resolved) return JSON.stringify(resolved);
    const { adAccountId, token } = resolved;

    const res = await graphGet(
      `${adAccountId}/customconversions`,
      {
        fields: "id,name,custom_event_type,rule,is_archived,pixel",
        limit: "100",
      },
      token,
    );
    if (res.error) {
      return JSON.stringify({
        client: params.clientCode,
        ad_account_id: adAccountId,
        error: res.error,
        note: "The custom-conversion list could not be read. Do not report that the account has none.",
      });
    }

    const rows = (res.data ?? []) as Array<Record<string, unknown>>;
    const conversions = rows.map((row) => ({
      id: String(row.id ?? ""),
      name: (row.name as string | undefined) ?? null,
      custom_event_type: (row.custom_event_type as string | undefined) ?? null,
      is_archived: Boolean(row.is_archived),
      pixel_id: (row.pixel as { id?: string } | undefined)?.id ?? null,
      rule: truncateRule(row.rule),
    }));

    logger.info(
      { clientCode: params.clientCode, conversions: conversions.length },
      "Custom conversions read complete",
    );

    return JSON.stringify({
      client: params.clientCode,
      ad_account_id: adAccountId,
      count: conversions.length,
      note:
        conversions.length === 0
          ? "The read succeeded and the account has no custom conversions defined."
          : "rule is truncated for reading; it names the raw event and URL each conversion is built from.",
      custom_conversions: conversions,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "getCustomConversions failed");
    return JSON.stringify({ error: msg });
  }
}
