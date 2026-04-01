import { getSupabase } from "../../integrations/supabase.js";
import { logger } from "../../utils/logger.js";

function daysAgoISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

async function resolveClientId(
  clientCode: string,
): Promise<{ id: number } | { error: string }> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("clients")
    .select("id")
    .eq("code", clientCode)
    .single();
  if (error || !data) {
    return { error: `Client '${clientCode}' not found` };
  }
  return { id: data.id as number };
}

export async function listClients(): Promise<string> {
  try {
    logger.debug("Querying all active clients");
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from("clients")
      .select(
        "id, code, name, ad_account_id, currency, timezone, is_active, conversion_goals, dashboard_metrics",
      )
      .eq("is_active", true);

    if (error) {
      logger.error({ error }, "Failed to list clients");
      return JSON.stringify({ error: error.message });
    }

    logger.debug({ count: data?.length }, "Listed active clients");
    return JSON.stringify(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "listClients failed");
    return JSON.stringify({ error: msg });
  }
}

export async function getClientPerformance(params: {
  clientCode: string;
  days?: number;
}): Promise<string> {
  try {
    const days = params.days ?? 7;
    const since = daysAgoISO(days);

    logger.debug(
      { clientCode: params.clientCode, days, since },
      "Querying client performance",
    );
    const supabase = getSupabase();

    // First resolve client code to id
    const { data: client, error: clientErr } = await supabase
      .from("clients")
      .select("id")
      .eq("code", params.clientCode)
      .single();

    if (clientErr || !client) {
      logger.error({ error: clientErr }, "Client not found");
      return JSON.stringify({
        error: `Client '${params.clientCode}' not found`,
      });
    }

    const { data, error } = await supabase
      .from("account_daily")
      .select(
        "date, spend, impressions, reach, frequency, clicks, link_clicks, content_views, add_to_carts, checkouts_initiated, purchases, purchase_value, roas, cpm, ctr, ctr_link, cpc, unique_link_clicks, results, cost_per_result, leads, complete_registrations, actions",
      )
      .eq("client_id", client.id)
      .gte("date", since)
      .order("date", { ascending: false })
      .limit(90);

    if (error) {
      logger.error({ error }, "Failed to get client performance");
      return JSON.stringify({ error: error.message });
    }

    logger.debug(
      { clientCode: params.clientCode, rows: data?.length },
      "Got client performance data",
    );
    return JSON.stringify(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "getClientPerformance failed");
    return JSON.stringify({ error: msg });
  }
}

export async function getAlerts(params: {
  clientCode?: string;
  severity?: string;
  days?: number;
}): Promise<string> {
  try {
    const days = params.days ?? 7;
    const since = daysAgoISO(days);

    logger.debug(
      { clientCode: params.clientCode, severity: params.severity, days },
      "Querying alerts",
    );
    const supabase = getSupabase();

    let query = supabase
      .from("alerts")
      .select(
        "id, client_id, title, alert_type, severity, metric, expected_value, actual_value, investigation_results, root_cause, recommended_actions, created_at",
      )
      .gte("created_at", since);

    if (params.clientCode) {
      const resolved = await resolveClientId(params.clientCode);
      if ("error" in resolved) return JSON.stringify(resolved);
      query = query.eq("client_id", resolved.id);
    }
    if (params.severity) {
      query = query.eq("severity", params.severity);
    }

    const { data, error } = await query.order("created_at", {
      ascending: false,
    }).limit(50);

    if (error) {
      logger.error({ error }, "Failed to get alerts");
      return JSON.stringify({ error: error.message });
    }

    logger.debug({ count: data?.length }, "Got alerts");
    return JSON.stringify(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "getAlerts failed");
    return JSON.stringify({ error: msg });
  }
}

export async function getLearnings(params: {
  clientCode?: string;
  category?: string;
  limit?: number;
}): Promise<string> {
  try {
    const limit = params.limit ?? 20;

    logger.debug(
      { clientCode: params.clientCode, category: params.category, limit },
      "Querying learnings",
    );
    const supabase = getSupabase();

    let query = supabase
      .from("learnings")
      .select(
        "id, client_id, title, insight, category, subcategory, confidence, evidence_type, created_at",
      );

    if (params.clientCode) {
      const resolved = await resolveClientId(params.clientCode);
      if ("error" in resolved) return JSON.stringify(resolved);
      query = query.eq("client_id", resolved.id);
    }
    if (params.category) {
      query = query.eq("category", params.category);
    }

    const { data, error } = await query
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      logger.error({ error }, "Failed to get learnings");
      return JSON.stringify({ error: error.message });
    }

    logger.debug({ count: data?.length }, "Got learnings");
    return JSON.stringify(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "getLearnings failed");
    return JSON.stringify({ error: msg });
  }
}

export async function getCampaignPerformance(params: {
  clientCode: string;
  days?: number;
}): Promise<string> {
  try {
    const days = params.days ?? 7;
    const since = daysAgoISO(days);

    logger.debug(
      { clientCode: params.clientCode, days },
      "Querying campaign performance",
    );
    const supabase = getSupabase();

    // Resolve client code to id
    const { data: client, error: clientErr } = await supabase
      .from("clients")
      .select("id")
      .eq("code", params.clientCode)
      .single();

    if (clientErr || !client) {
      return JSON.stringify({
        error: `Client '${params.clientCode}' not found`,
      });
    }

    const { data, error } = await supabase
      .from("campaign_daily")
      .select(
        "date, campaign_id, campaign_name, status, objective, spend, impressions, reach, frequency, clicks, link_clicks, content_views, add_to_carts, checkouts_initiated, purchases, purchase_value, roas, cpm, ctr, ctr_link, cpc, unique_link_clicks, results, cost_per_result, leads, complete_registrations, actions",
      )
      .eq("client_id", client.id)
      .gte("date", since)
      .order("date", { ascending: false })
      .limit(200);

    if (error) {
      logger.error({ error }, "Failed to get campaign performance");
      return JSON.stringify({ error: error.message });
    }

    logger.debug(
      { clientCode: params.clientCode, rows: data?.length },
      "Got campaign performance data",
    );
    return JSON.stringify(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "getCampaignPerformance failed");
    return JSON.stringify({ error: msg });
  }
}

export async function getBriefs(params: {
  clientCode: string;
  status?: string;
}): Promise<string> {
  try {
    logger.debug(
      { clientCode: params.clientCode, status: params.status },
      "Querying briefs",
    );
    const supabase = getSupabase();

    let query = supabase
      .from("briefs")
      .select(
        "id, brief_code, client_code, title, content, status, hooks, assigned_creator, created_at",
      )
      .eq("client_code", params.clientCode);

    if (params.status) {
      query = query.eq("status", params.status);
    }

    const { data, error } = await query.order("created_at", {
      ascending: false,
    });

    if (error) {
      logger.error({ error }, "Failed to get briefs");
      return JSON.stringify({ error: error.message });
    }

    logger.debug({ count: data?.length }, "Got briefs");
    return JSON.stringify(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "getBriefs failed");
    return JSON.stringify({ error: msg });
  }
}

export async function getConcepts(params: {
  clientCode: string;
  status?: string;
}): Promise<string> {
  try {
    logger.debug(
      { clientCode: params.clientCode, status: params.status },
      "Querying concepts",
    );
    const supabase = getSupabase();

    let query = supabase
      .from("concepts")
      .select(
        "id, client_code, title, description, angle, theme, format, status, dials, created_at",
      )
      .eq("client_code", params.clientCode);

    if (params.status) {
      query = query.eq("status", params.status);
    }

    const { data, error } = await query.order("created_at", {
      ascending: false,
    });

    if (error) {
      logger.error({ error }, "Failed to get concepts");
      return JSON.stringify({ error: error.message });
    }

    logger.debug({ count: data?.length }, "Got concepts");
    return JSON.stringify(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "getConcepts failed");
    return JSON.stringify({ error: msg });
  }
}

// ---------------------------------------------------------------------------
// Summary tools (server-side aggregation — 1 row per entity)
// ---------------------------------------------------------------------------

export async function getCampaignSummary(params: {
  clientCode: string;
  days?: number;
}): Promise<string> {
  try {
    const days = params.days ?? 30;

    logger.debug(
      { clientCode: params.clientCode, days },
      "Querying campaign summary (RPC)",
    );
    const supabase = getSupabase();

    const { data, error } = await supabase.rpc("get_campaign_summary", {
      p_client_code: params.clientCode,
      p_days: days,
    });

    if (error) {
      logger.error({ error }, "Failed to get campaign summary");
      return JSON.stringify({ error: error.message });
    }

    logger.debug(
      { clientCode: params.clientCode, rows: data?.length },
      "Got campaign summary",
    );
    return JSON.stringify(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "getCampaignSummary failed");
    return JSON.stringify({ error: msg });
  }
}

export async function getAdsetSummary(params: {
  clientCode: string;
  campaignId?: string;
  days?: number;
}): Promise<string> {
  try {
    const days = params.days ?? 30;

    logger.debug(
      { clientCode: params.clientCode, campaignId: params.campaignId, days },
      "Querying adset summary (RPC)",
    );
    const supabase = getSupabase();

    const { data, error } = await supabase.rpc("get_adset_summary", {
      p_client_code: params.clientCode,
      p_campaign_id: params.campaignId ?? null,
      p_days: days,
    });

    if (error) {
      logger.error({ error }, "Failed to get adset summary");
      return JSON.stringify({ error: error.message });
    }

    logger.debug(
      { clientCode: params.clientCode, rows: data?.length },
      "Got adset summary",
    );
    return JSON.stringify(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "getAdsetSummary failed");
    return JSON.stringify({ error: msg });
  }
}

export async function getAdSummary(params: {
  clientCode: string;
  campaignId?: string;
  adsetId?: string;
  days?: number;
}): Promise<string> {
  try {
    const days = params.days ?? 30;

    // Guard: require campaignId or adsetId to prevent full-account queries blowing up context
    if (!params.campaignId && !params.adsetId) {
      return JSON.stringify({
        error: "get_ad_summary requires campaignId or adsetId to avoid huge result sets. Use get_campaign_summary first to identify campaigns, then call get_ad_summary with a specific campaignId.",
      });
    }

    logger.debug(
      { clientCode: params.clientCode, campaignId: params.campaignId, adsetId: params.adsetId, days },
      "Querying ad summary (RPC)",
    );
    const supabase = getSupabase();

    const { data, error } = await supabase.rpc("get_ad_summary", {
      p_client_code: params.clientCode,
      p_campaign_id: params.campaignId ?? null,
      p_adset_id: params.adsetId ?? null,
      p_days: days,
    });

    if (error) {
      logger.error({ error }, "Failed to get ad summary");
      return JSON.stringify({ error: error.message });
    }

    logger.debug(
      { clientCode: params.clientCode, rows: data?.length },
      "Got ad summary",
    );
    return JSON.stringify(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "getAdSummary failed");
    return JSON.stringify({ error: msg });
  }
}

// ---------------------------------------------------------------------------
// Phase 1B: New granular tools
// ---------------------------------------------------------------------------

export async function getAdsetPerformance(params: {
  clientCode: string;
  campaignId?: string;
  days?: number;
}): Promise<string> {
  try {
    const days = params.days ?? 7;
    const since = daysAgoISO(days);

    logger.debug(
      { clientCode: params.clientCode, campaignId: params.campaignId, days },
      "Querying adset performance",
    );

    const resolved = await resolveClientId(params.clientCode);
    if ("error" in resolved) return JSON.stringify(resolved);

    const supabase = getSupabase();
    let query = supabase
      .from("adset_daily")
      .select(
        "date, campaign_id, adset_id, adset_name, status, targeting_audience_type, spend, impressions, reach, frequency, clicks, link_clicks, content_views, add_to_carts, checkouts_initiated, purchases, purchase_value, roas, cpm, ctr, ctr_link, cpc, unique_link_clicks, results, cost_per_result, actions",
      )
      .eq("client_id", resolved.id)
      .gte("date", since);

    if (params.campaignId) {
      query = query.eq("campaign_id", params.campaignId);
    }

    const { data, error } = await query.order("date", { ascending: false }).limit(150);

    if (error) {
      logger.error({ error }, "Failed to get adset performance");
      return JSON.stringify({ error: error.message });
    }

    logger.debug(
      { clientCode: params.clientCode, rows: data?.length },
      "Got adset performance data",
    );
    return JSON.stringify(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "getAdsetPerformance failed");
    return JSON.stringify({ error: msg });
  }
}

export async function getAdPerformance(params: {
  clientCode: string;
  campaignId?: string;
  adsetId?: string;
  days?: number;
}): Promise<string> {
  try {
    const days = params.days ?? 7;
    const since = daysAgoISO(days);

    logger.debug(
      { clientCode: params.clientCode, campaignId: params.campaignId, adsetId: params.adsetId, days },
      "Querying ad performance",
    );

    const resolved = await resolveClientId(params.clientCode);
    if ("error" in resolved) return JSON.stringify(resolved);

    const supabase = getSupabase();
    let query = supabase
      .from("ad_daily")
      .select(
        "date, campaign_id, adset_id, ad_id, ad_name, status, creative_id, spend, impressions, reach, frequency, clicks, link_clicks, unique_link_clicks, ctr, ctr_link, unique_ctr_link, cpm, cpc, video_plays, video_p25, video_p50, video_p75, video_p100, thruplays, video_avg_time, hook_rate, hold_rate, landing_page_views, content_views, add_to_carts, checkouts_initiated, pdp_view_rate, atc_on_pdp_rate, checkout_abandonment_rate, conversion_rate, revenue_per_click, purchases, purchase_value, roas, results, cost_per_result, actions",
      )
      .eq("client_id", resolved.id)
      .gte("date", since);

    if (params.campaignId) {
      query = query.eq("campaign_id", params.campaignId);
    }
    if (params.adsetId) {
      query = query.eq("adset_id", params.adsetId);
    }

    // Require at least one filter to prevent full-account queries
    if (!params.campaignId && !params.adsetId) {
      query = query.limit(50);
    } else {
      query = query.limit(150);
    }

    const { data, error } = await query.order("date", { ascending: false });

    if (error) {
      logger.error({ error }, "Failed to get ad performance");
      return JSON.stringify({ error: error.message });
    }

    logger.debug(
      { clientCode: params.clientCode, rows: data?.length },
      "Got ad performance data",
    );
    return JSON.stringify(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "getAdPerformance failed");
    return JSON.stringify({ error: msg });
  }
}

export async function getBreakdowns(params: {
  clientCode: string;
  breakdownType: string;
  entityType?: string;
  entityId?: string;
  days?: number;
  aggregate?: boolean;
}): Promise<string> {
  try {
    const days = params.days ?? 7;
    const since = daysAgoISO(days);
    // Auto-aggregate when looking at >14 days to avoid massive result sets
    const shouldAggregate = params.aggregate ?? days > 14;

    logger.debug(
      { clientCode: params.clientCode, breakdownType: params.breakdownType, entityType: params.entityType, days, aggregate: shouldAggregate },
      "Querying breakdowns",
    );

    const resolved = await resolveClientId(params.clientCode);
    if ("error" in resolved) return JSON.stringify(resolved);

    const supabase = getSupabase();
    let query = supabase
      .from("breakdowns")
      .select(
        "date, breakdown_type, breakdown_value, spend, impressions, clicks, link_clicks, results, cost_per_result, purchases, purchase_value",
      )
      .eq("client_id", resolved.id)
      .eq("breakdown_type", params.breakdownType)
      .gte("date", since);

    const entityType = params.entityType ?? "account";
    query = query.eq("entity_type", entityType);
    if (entityType !== "account" && params.entityId) {
      query = query.eq("entity_id", params.entityId);
    }

    // Scale limit with date range to avoid truncation on YTD queries
    const rowLimit = Math.min(5000, Math.max(300, days * 50));
    const { data, error } = await query.order("date", { ascending: false }).limit(rowLimit);

    if (error) {
      logger.error({ error }, "Failed to get breakdowns");
      return JSON.stringify({ error: error.message });
    }

    logger.debug(
      { clientCode: params.clientCode, rows: data?.length, aggregate: shouldAggregate },
      "Got breakdown data",
    );

    if (!shouldAggregate || !data?.length) {
      return JSON.stringify(data);
    }

    // Aggregate by breakdown_value to produce compact totals
    const agg = new Map<string, {
      breakdown_value: string;
      spend: number; impressions: number; clicks: number; link_clicks: number;
      results: number; purchases: number; purchase_value: number; days_with_data: number;
    }>();
    for (const row of data) {
      const key = row.breakdown_value as string;
      const existing = agg.get(key);
      if (!existing) {
        agg.set(key, {
          breakdown_value: key,
          spend: Number(row.spend) || 0,
          impressions: Number(row.impressions) || 0,
          clicks: Number(row.clicks) || 0,
          link_clicks: Number(row.link_clicks) || 0,
          results: Number(row.results) || 0,
          purchases: Number(row.purchases) || 0,
          purchase_value: Number(row.purchase_value) || 0,
          days_with_data: 1,
        });
      } else {
        existing.spend += Number(row.spend) || 0;
        existing.impressions += Number(row.impressions) || 0;
        existing.clicks += Number(row.clicks) || 0;
        existing.link_clicks += Number(row.link_clicks) || 0;
        existing.results += Number(row.results) || 0;
        existing.purchases += Number(row.purchases) || 0;
        existing.purchase_value += Number(row.purchase_value) || 0;
        existing.days_with_data += 1;
      }
    }

    // Add computed metrics and sort by spend descending
    const aggregated = [...agg.values()]
      .map((r) => ({
        ...r,
        roas: r.spend > 0 ? Math.round((r.purchase_value / r.spend) * 100) / 100 : 0,
        cpa: r.purchases > 0 ? Math.round(r.spend / r.purchases) : 0,
        ctr: r.impressions > 0 ? Math.round((r.clicks / r.impressions) * 10000) / 100 : 0,
      }))
      .sort((a, b) => b.spend - a.spend);

    return JSON.stringify({
      period: `${days} days (${since} to today)`,
      total_rows_fetched: data.length,
      aggregated_by: params.breakdownType,
      data: aggregated,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "getBreakdowns failed");
    return JSON.stringify({ error: msg });
  }
}

export async function getAccountChanges(params: {
  clientCode: string;
  days?: number;
}): Promise<string> {
  try {
    const days = params.days ?? 7;
    const since = daysAgoISO(days);

    logger.debug(
      { clientCode: params.clientCode, days },
      "Querying account changes",
    );

    const resolved = await resolveClientId(params.clientCode);
    if ("error" in resolved) return JSON.stringify(resolved);

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("account_changes")
      .select(
        "event_time, event_type, object_type, object_id, object_name, actor_name, extra_data",
      )
      .eq("client_id", resolved.id)
      .gte("event_time", since)
      .order("event_time", { ascending: false })
      .limit(200);

    if (error) {
      logger.error({ error }, "Failed to get account changes");
      return JSON.stringify({ error: error.message });
    }

    logger.debug(
      { clientCode: params.clientCode, rows: data?.length },
      "Got account changes",
    );
    return JSON.stringify(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "getAccountChanges failed");
    return JSON.stringify({ error: msg });
  }
}

export async function getCreativeDetails(params: {
  clientCode: string;
  creativeId?: string;
  adId?: string;
  onlyFatigued?: boolean;
}): Promise<string> {
  try {
    logger.debug(
      { clientCode: params.clientCode, creativeId: params.creativeId, adId: params.adId, onlyFatigued: params.onlyFatigued },
      "Querying creative details",
    );

    const resolved = await resolveClientId(params.clientCode);
    if ("error" in resolved) return JSON.stringify(resolved);

    const supabase = getSupabase();
    let query = supabase
      .from("creatives")
      .select(
        "creative_id, ad_id, ad_name, ad_type, status, format, primary_text, headline, description, call_to_action, link_url, video_duration_seconds, transcript, hook_score, watch_score, click_score, convert_score, is_fatigued, fatigue_detected_at, ai_tags, custom_tags, campaign_name, adset_name, last_active_at",
      )
      .eq("client_id", resolved.id);

    if (params.creativeId) {
      query = query.eq("creative_id", params.creativeId);
    }
    if (params.adId) {
      query = query.eq("ad_id", params.adId);
    }
    if (params.onlyFatigued) {
      query = query.eq("is_fatigued", true);
    }

    const { data, error } = await query.order("last_active_at", {
      ascending: false,
    }).limit(50);

    if (error) {
      logger.error({ error }, "Failed to get creative details");
      return JSON.stringify({ error: error.message });
    }

    logger.debug(
      { clientCode: params.clientCode, rows: data?.length },
      "Got creative details",
    );
    return JSON.stringify(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "getCreativeDetails failed");
    return JSON.stringify({ error: msg });
  }
}

// ---------------------------------------------------------------------------
// Domo (Salesforce funnel data) — downstream metrics Meta doesn't have
// ---------------------------------------------------------------------------

interface DomoRow {
  ad_id: string;
  ad_name: string | null;
  campaign_id: string | null;
  adset_id: string | null;
  date: string;
  costs: number | null;
  clicks: number | null;
  impressions: number | null;
  leads_sf: number | null;
  open_leads_sf: number | null;
  autoclosed_sf: number | null;
  opportunities_sf: number | null;
  first_care_leads: number | null;
  severely_suffering_leads: number | null;
  not_at_all_suffering_leads: number | null;
  barely_suffering_leads: number | null;
  rx_share: number | null;
}

interface DomoAgg {
  key: string;
  costs: number;
  clicks: number;
  impressions: number;
  leads_sf: number;
  open_leads_sf: number;
  autoclosed_sf: number;
  opportunities_sf: number;
  first_care_leads: number;
  severely_suffering_leads: number;
  not_at_all_suffering_leads: number;
  barely_suffering_leads: number;
  rx_share_weighted_sum: number;
  rx_share_weight: number;
  ad_names?: string[];
  days: number;
}

function aggregateDomoRows(
  rows: DomoRow[],
  groupBy: string,
): Record<string, unknown>[] {
  const buckets = new Map<string, DomoAgg>();

  for (const r of rows) {
    let key: string;
    switch (groupBy) {
      case "date":
        key = r.date;
        break;
      case "ad":
        key = r.ad_id;
        break;
      case "campaign":
        key = r.campaign_id ?? "unknown";
        break;
      case "adset":
        key = r.adset_id ?? "unknown";
        break;
      default:
        key = "total";
    }

    let b = buckets.get(key);
    if (!b) {
      b = {
        key,
        costs: 0,
        clicks: 0,
        impressions: 0,
        leads_sf: 0,
        open_leads_sf: 0,
        autoclosed_sf: 0,
        opportunities_sf: 0,
        first_care_leads: 0,
        severely_suffering_leads: 0,
        not_at_all_suffering_leads: 0,
        barely_suffering_leads: 0,
        rx_share_weighted_sum: 0,
        rx_share_weight: 0,
        ad_names: groupBy === "ad" ? [] : undefined,
        days: 0,
      };
      buckets.set(key, b);
    }

    b.costs += r.costs ?? 0;
    b.clicks += r.clicks ?? 0;
    b.impressions += r.impressions ?? 0;
    b.leads_sf += r.leads_sf ?? 0;
    b.open_leads_sf += r.open_leads_sf ?? 0;
    b.autoclosed_sf += r.autoclosed_sf ?? 0;
    b.opportunities_sf += r.opportunities_sf ?? 0;
    b.first_care_leads += r.first_care_leads ?? 0;
    b.severely_suffering_leads += r.severely_suffering_leads ?? 0;
    b.not_at_all_suffering_leads += r.not_at_all_suffering_leads ?? 0;
    b.barely_suffering_leads += r.barely_suffering_leads ?? 0;
    if (r.rx_share != null && r.leads_sf) {
      b.rx_share_weighted_sum += r.rx_share * r.leads_sf;
      b.rx_share_weight += r.leads_sf;
    }
    if (groupBy === "ad" && r.ad_name && !b.ad_names!.includes(r.ad_name)) {
      b.ad_names!.push(r.ad_name);
    }
    b.days += 1;
  }

  const results: Record<string, unknown>[] = [];
  for (const b of buckets.values()) {
    const netLeads = b.leads_sf - b.autoclosed_sf;
    const totalSuffering =
      b.severely_suffering_leads +
      b.not_at_all_suffering_leads +
      b.barely_suffering_leads;

    const rec: Record<string, unknown> = {
      [groupBy === "date"
        ? "date"
        : groupBy === "ad"
          ? "ad_id"
          : groupBy === "campaign"
            ? "campaign_id"
            : groupBy === "adset"
              ? "adset_id"
              : "group"]: b.key,
      costs: round2(b.costs),
      impressions: b.impressions,
      clicks: b.clicks,
      leads_sf: b.leads_sf,
      autoclosed_sf: b.autoclosed_sf,
      net_leads: netLeads,
      open_leads_sf: b.open_leads_sf,
      opportunities_sf: b.opportunities_sf,
      first_care_leads: b.first_care_leads,
      severely_suffering_leads: b.severely_suffering_leads,
      barely_suffering_leads: b.barely_suffering_leads,
      not_at_all_suffering_leads: b.not_at_all_suffering_leads,
      // Computed rates
      cpl_sf: b.leads_sf > 0 ? round2(b.costs / b.leads_sf) : null,
      cpa_sf: b.opportunities_sf > 0 ? round2(b.costs / b.opportunities_sf) : null,
      cr2: b.leads_sf > 0 ? round4(b.opportunities_sf / b.leads_sf) : null,
      autoclose_rate: b.leads_sf > 0 ? round4(b.autoclosed_sf / b.leads_sf) : null,
      first_care_share:
        b.leads_sf > 0 ? round4(b.first_care_leads / b.leads_sf) : null,
      severe_suffering_share:
        totalSuffering > 0
          ? round4(b.severely_suffering_leads / totalSuffering)
          : null,
      not_at_all_share:
        totalSuffering > 0
          ? round4(b.not_at_all_suffering_leads / totalSuffering)
          : null,
      rx_share:
        b.rx_share_weight > 0
          ? round4(b.rx_share_weighted_sum / b.rx_share_weight)
          : null,
      data_completeness:
        b.leads_sf > 0
          ? b.open_leads_sf === 0
            ? "complete"
            : "partial"
          : "no_data",
    };

    if (groupBy === "ad" && b.ad_names?.length) {
      rec.ad_name = b.ad_names[0];
    }

    results.push(rec);
  }

  // Sort: by date ascending for date grouping, by spend descending otherwise
  if (groupBy === "date") {
    results.sort((a, b) =>
      String(a.date ?? "").localeCompare(String(b.date ?? "")),
    );
  } else {
    results.sort(
      (a, b) => ((b.costs as number) ?? 0) - ((a.costs as number) ?? 0),
    );
  }

  return results;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// Given a set of ad_ids, find all ad_ids that share the same image_hash or video_hash.
// This finds all copies of the same creative asset across the entire account.
async function expandAdIdsByHash(
  supabase: ReturnType<typeof getSupabase>,
  clientId: string,
  adIds: string[],
): Promise<{ expandedIds: string[]; hashInfo: string | null }> {
  if (adIds.length === 0) return { expandedIds: [], hashInfo: null };

  // Step 1: Get hashes for the given ad_ids
  const { data: creatives } = await supabase
    .from("creatives")
    .select("ad_id, image_hash, video_hash, video_id, ad_type")
    .eq("client_id", clientId)
    .in("ad_id", adIds);

  if (!creatives || creatives.length === 0) {
    return { expandedIds: adIds, hashInfo: null };
  }

  // Collect unique hashes
  const imageHashes = new Set<string>();
  const videoHashes = new Set<string>();
  for (const c of creatives) {
    if (c.image_hash) imageHashes.add(c.image_hash);
    if (c.video_hash) videoHashes.add(c.video_hash);
    if (c.video_id) videoHashes.add(c.video_id); // video_id also identifies the asset
  }

  if (imageHashes.size === 0 && videoHashes.size === 0) {
    return { expandedIds: adIds, hashInfo: null };
  }

  // Step 2: Find all ad_ids sharing those hashes
  const allAdIds = new Set(adIds);
  const hashType = imageHashes.size > 0 ? "image_hash" : "video_hash";
  const hashes = imageHashes.size > 0 ? [...imageHashes] : [...videoHashes];

  const { data: siblings } = await supabase
    .from("creatives")
    .select("ad_id")
    .eq("client_id", clientId)
    .in(hashType, hashes);

  if (siblings) {
    for (const s of siblings) allAdIds.add(s.ad_id);
  }

  // Also check video_id if we had video hashes
  if (videoHashes.size > 0) {
    const { data: videoSiblings } = await supabase
      .from("creatives")
      .select("ad_id")
      .eq("client_id", clientId)
      .in("video_id", [...videoHashes]);
    if (videoSiblings) {
      for (const s of videoSiblings) allAdIds.add(s.ad_id);
    }
  }

  const expanded = [...allAdIds];
  const hashInfo = expanded.length > adIds.length
    ? `Expanded from ${adIds.length} to ${expanded.length} ad_ids via ${hashType} matching (same creative asset in different campaigns/ad sets).`
    : null;

  return { expandedIds: expanded, hashInfo };
}

export async function getDomoFunnel(params: {
  clientCode: string;
  days?: number;
  campaignId?: string;
  adsetId?: string;
  adId?: string;
  adName?: string;
  groupBy?: string;
}): Promise<string> {
  try {
    const days = params.days ?? 30;
    const since = daysAgoISO(days);
    const groupBy = params.groupBy ?? "date";

    logger.debug(
      {
        clientCode: params.clientCode,
        days,
        groupBy,
        campaignId: params.campaignId,
        adName: params.adName,
      },
      "Querying Domo funnel data",
    );

    const resolved = await resolveClientId(params.clientCode);
    if ("error" in resolved) return JSON.stringify(resolved);

    const supabase = getSupabase();

    // When filtering by adName or adId, expand via image_hash/video_hash to find
    // all copies of the same creative asset across the account.
    let hashResolvedIds: string[] | null = null;
    let hashInfo: string | null = null;

    if (params.adName || params.adId) {
      // First pass: find matching ad_ids from domo_ad_daily
      let seedQuery = supabase
        .from("domo_ad_daily")
        .select("ad_id")
        .eq("client_id", resolved.id);
      if (params.adId) seedQuery = seedQuery.eq("ad_id", params.adId);
      if (params.adName) seedQuery = seedQuery.ilike("ad_name", `%${params.adName}%`);
      const { data: seedRows } = await seedQuery.limit(500);

      const seedIds = [...new Set((seedRows ?? []).map(r => r.ad_id))];
      if (seedIds.length > 0) {
        const result = await expandAdIdsByHash(supabase, resolved.id, seedIds);
        hashResolvedIds = result.expandedIds;
        hashInfo = result.hashInfo;
      }
    }

    let query = supabase
      .from("domo_ad_daily")
      .select(
        "ad_id, ad_name, campaign_id, adset_id, date, costs, clicks, impressions, leads_sf, open_leads_sf, autoclosed_sf, opportunities_sf, first_care_leads, severely_suffering_leads, not_at_all_suffering_leads, barely_suffering_leads, rx_share",
      )
      .eq("client_id", resolved.id)
      .gte("date", since);

    if (params.campaignId) {
      query = query.eq("campaign_id", params.campaignId);
    }
    if (params.adsetId) {
      query = query.eq("adset_id", params.adsetId);
    }

    if (hashResolvedIds) {
      // Use the hash-expanded ad_id list
      query = query.in("ad_id", hashResolvedIds);
    } else if (params.adId) {
      query = query.eq("ad_id", params.adId);
    } else if (params.adName) {
      query = query.ilike("ad_name", `%${params.adName}%`);
    }

    const { data, error } = await query
      .order("date", { ascending: false })
      .limit(2000);

    if (error) {
      logger.error({ error }, "Failed to get Domo funnel data");
      return JSON.stringify({ error: error.message });
    }

    if (!data || data.length === 0) {
      return JSON.stringify({
        message: "No Domo data found for this client/period. Domo CSV exports may not have been uploaded yet.",
        hint: "Domo data is uploaded manually — check if recent CSVs have been imported.",
      });
    }

    const aggregated = aggregateDomoRows(data as DomoRow[], groupBy);

    // Data quality check: detect rows with spend but null leads (incomplete attribution)
    const rows = data as DomoRow[];
    const nullLeadRows = rows.filter(r => r.leads_sf == null && (r.costs ?? 0) > 0);
    const nullLeadCost = nullLeadRows.reduce((s, r) => s + (r.costs ?? 0), 0);
    const totalCost = rows.reduce((s, r) => s + (r.costs ?? 0), 0);
    const nullPct = totalCost > 0 ? Math.round(nullLeadCost / totalCost * 100) : 0;

    logger.debug(
      {
        clientCode: params.clientCode,
        rawRows: data.length,
        aggregatedRows: aggregated.length,
        groupBy,
        nullLeadRows: nullLeadRows.length,
        nullLeadCostPct: nullPct,
      },
      "Got Domo funnel data",
    );

    const meta: Record<string, unknown> = {
      raw_row_count: data.length,
      note: "cr2 = opportunities_sf / leads_sf. cpa_sf = costs / opportunities_sf. data_completeness: 'complete' when open_leads_sf = 0 (all leads processed by sales).",
    };

    if (hashInfo) {
      meta.hash_resolution = hashInfo;
    }

    if (nullPct >= 20) {
      meta.data_quality_warning = `${nullPct}% of spend (€${Math.round(nullLeadCost)} of €${Math.round(totalCost)}) comes from rows with no lead attribution data. Actual leads may be HIGHER than reported. This happens when the Domo CSV export was uploaded before Salesforce lead attribution was complete, or when leads are only attributed to certain campaign placements in Domo. Check the Domo dashboard directly for the most accurate lead counts.`;
    }

    return JSON.stringify({
      period: { from: since, days, groupBy },
      rows: aggregated,
      _meta: meta,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "getDomoFunnel failed");
    return JSON.stringify({ error: msg });
  }
}
