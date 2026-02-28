import { getSupabase } from "../../integrations/supabase.js";
import { logger } from "../../utils/logger.js";

export async function getClientTargets(params: {
  clientCode: string;
}): Promise<string> {
  try {
    const supabase = getSupabase();

    // Try exact match first, then uppercase (BMAD codes are typically uppercase)
    let { data, error } = await supabase
      .from("client_configs")
      .select("config")
      .eq("client_code", params.clientCode)
      .maybeSingle();

    if (!data && !error) {
      ({ data, error } = await supabase
        .from("client_configs")
        .select("config")
        .eq("client_code", params.clientCode.toUpperCase())
        .maybeSingle());
    }

    if (error || !data) {
      logger.warn({ clientCode: params.clientCode, error }, "Client config not found in Supabase");
      return JSON.stringify({
        error: `No config found for '${params.clientCode}'`,
        hint: "Use list_clients() for basic conversion goals, or ask Daniel for targets",
      });
    }

    const config = data.config as Record<string, unknown>;

    // Extract the most useful fields for Ada
    const result: Record<string, unknown> = {
      client_code: config.client_code,
      client_name: config.client_name,
      currency: config.currency,
      kpi_primary: config.kpi_primary,
    };

    if (config.targets) result.targets = config.targets;
    if (config.category_targets) result.category_targets = config.category_targets;
    if (config.benchmarks) result.benchmarks = config.benchmarks;
    if (config.analysis_thresholds) result.analysis_thresholds = config.analysis_thresholds;
    if (config.anomaly_thresholds) result.anomaly_thresholds = config.anomaly_thresholds;
    if (config.metric_alerts) result.metric_alerts = config.metric_alerts;
    if (config.budget) result.budget = config.budget;
    if (config.markets) result.markets = config.markets;
    if (config.hit_criteria) result.hit_criteria = config.hit_criteria;
    if (config.scaling_candidate) result.scaling_candidate = config.scaling_candidate;
    if (config.notes) result.notes = config.notes;

    logger.debug(
      { clientCode: params.clientCode, fields: Object.keys(result).length },
      "Loaded client targets config from Supabase",
    );
    return JSON.stringify(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg, clientCode: params.clientCode }, "getClientTargets failed");
    return JSON.stringify({ error: msg });
  }
}
