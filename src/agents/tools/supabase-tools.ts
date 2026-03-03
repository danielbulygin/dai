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
}): Promise<string> {
  try {
    const days = params.days ?? 7;
    const since = daysAgoISO(days);

    logger.debug(
      { clientCode: params.clientCode, breakdownType: params.breakdownType, entityType: params.entityType, days },
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
    if (entityType !== "account" && params.entityId) {
      query = query.eq("entity_type", entityType).eq("entity_id", params.entityId);
    } else if (entityType !== "account") {
      query = query.eq("entity_type", entityType);
    }

    const { data, error } = await query.order("date", { ascending: false }).limit(300);

    if (error) {
      logger.error({ error }, "Failed to get breakdowns");
      return JSON.stringify({ error: error.message });
    }

    logger.debug(
      { clientCode: params.clientCode, rows: data?.length },
      "Got breakdown data",
    );
    return JSON.stringify(data);
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
