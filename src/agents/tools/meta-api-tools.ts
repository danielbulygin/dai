import { getSupabase } from "../../integrations/supabase.js";
import { env } from "../../env.js";
import { logger } from "../../utils/logger.js";

const META_API_VERSION = "v21.0";
const META_BASE_URL = `https://graph.facebook.com/${META_API_VERSION}`;

// ---------------------------------------------------------------------------
// Resolve client code → ad_account_id from BMAD Supabase
// ---------------------------------------------------------------------------

async function resolveAdAccountId(
  clientCode: string,
): Promise<{ adAccountId: string; timezone: string; currency: string } | { error: string }> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("clients")
    .select("ad_account_id, timezone, currency")
    .eq("code", clientCode)
    .single();
  if (error || !data) {
    return { error: `Client '${clientCode}' not found` };
  }
  if (!data.ad_account_id) {
    return { error: `Client '${clientCode}' has no ad_account_id configured` };
  }
  return {
    adAccountId: data.ad_account_id as string,
    timezone: (data.timezone as string) || "Europe/Berlin",
    currency: (data.currency as string) || "EUR",
  };
}

// ---------------------------------------------------------------------------
// Facebook Graph API request helper
// ---------------------------------------------------------------------------

async function metaApiRequest(
  endpoint: string,
  params: Record<string, string>,
): Promise<{ data?: unknown[]; error?: string }> {
  const token = env.META_ACCESS_TOKEN;
  if (!token) {
    return { error: "META_ACCESS_TOKEN is not configured. Cannot query Facebook API directly." };
  }

  const url = new URL(`${META_BASE_URL}/${endpoint}`);
  url.searchParams.set("access_token", token);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  logger.debug({ endpoint, params: Object.keys(params) }, "Meta API request");

  const response = await fetch(url.toString(), {
    signal: AbortSignal.timeout(60_000),
  });

  if (response.status === 429) {
    return { error: "Rate limited by Facebook API. Wait a moment and retry." };
  }

  const body = await response.json() as Record<string, unknown>;

  if (!response.ok) {
    const fbError = body.error as Record<string, unknown> | undefined;
    const msg = fbError?.message ?? JSON.stringify(body);
    logger.error({ status: response.status, error: msg }, "Meta API error");
    return { error: `Facebook API error: ${msg}` };
  }

  // Handle paginated results — collect all pages
  let allData = (body.data as unknown[]) ?? [];
  let paging = body.paging as Record<string, unknown> | undefined;

  while (paging?.next && allData.length < 500) {
    const nextUrl = paging.next as string;
    const nextResp = await fetch(nextUrl, { signal: AbortSignal.timeout(60_000) });
    if (!nextResp.ok) break;
    const nextBody = await nextResp.json() as Record<string, unknown>;
    const nextData = nextBody.data as unknown[];
    if (!nextData?.length) break;
    allData = allData.concat(nextData);
    paging = nextBody.paging as Record<string, unknown> | undefined;
  }

  return { data: allData };
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

    const { adAccountId } = resolved;
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

    const result = await metaApiRequest(`${adAccountId}/insights`, apiParams);

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

    const { adAccountId } = resolved;

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

    const result = await metaApiRequest(`${adAccountId}/ads`, apiParams);

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
): Promise<AdIdCodeReport> {
  const filterFor = (value: string) =>
    JSON.stringify([{ field: 'name', operator: 'CONTAIN', value }]);

  const [adsetResult, adResult] = await Promise.all([
    metaApiRequest(`${adAccountId}/adsets`, {
      filtering: filterFor(code),
      fields: 'id,name,effective_status,status,campaign_id',
      limit: '50',
    }),
    metaApiRequest(`${adAccountId}/ads`, {
      filtering: filterFor(code),
      fields: 'id,name,effective_status,status,adset_id,campaign_id',
      limit: '50',
    }),
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
    const { adAccountId } = resolved;

    const uniqueCodes = Array.from(new Set(params.adIdCodes));
    const reports = await Promise.all(uniqueCodes.map((code) => lookupCodeInMeta(adAccountId, code)));

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
