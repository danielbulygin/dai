import { getSupabase } from "../../integrations/supabase.js";
import { logger } from "../../utils/logger.js";

function daysAgoISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
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
        "date, spend, impressions, reach, clicks, purchases, revenue, roas, cpa, cpm, ctr",
      )
      .eq("client_id", client.id)
      .gte("date", since)
      .order("date", { ascending: false });

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
        "id, client_code, title, type, severity, metric, expected_value, actual_value, investigation_results, root_cause, recommended_actions, created_at",
      )
      .gte("created_at", since);

    if (params.clientCode) {
      query = query.eq("client_code", params.clientCode);
    }
    if (params.severity) {
      query = query.eq("severity", params.severity);
    }

    const { data, error } = await query.order("created_at", {
      ascending: false,
    });

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
        "id, client_code, title, content, category, subcategory, confidence, evidence_type, created_at",
      );

    if (params.clientCode) {
      query = query.eq("client_code", params.clientCode);
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
        "date, campaign_id, campaign_name, spend, impressions, clicks, purchases, revenue, roas, cpa",
      )
      .eq("client_id", client.id)
      .gte("date", since)
      .order("date", { ascending: false });

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
