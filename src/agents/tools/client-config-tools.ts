import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { logger } from "../../utils/logger.js";

const BMAD_CLIENTS_DIR = resolve(
  process.env.BMAD_CLIENTS_DIR ?? "/Users/danielbulygin/dev/bmad/pma/clients",
);

/** Map Supabase client codes (snake_case) to BMAD folder names (kebab-case) */
const CODE_TO_FOLDER: Record<string, string> = {
  ninepine: "ninepine",
  press_london: "press-london",
  brainfm: "brainfm",
  slumber: "slumber",
  laori: "laori",
  meow: "meow",
  teethlovers: "teethlovers",
  urvi: "urvi",
  vi_lifestyle: "vi-lifestyle",
  jva: "jv-academy",
  noso: "nothings-something",
  getgoing: "getgoing",
  sweetspot: "sweetspot",
  strayz: "strayz",
  audibene: "audibene",
};

export async function getClientTargets(params: {
  clientCode: string;
}): Promise<string> {
  try {
    const folder = CODE_TO_FOLDER[params.clientCode] ?? params.clientCode;
    const configPath = resolve(BMAD_CLIENTS_DIR, folder, "ads-config.yaml");

    if (!existsSync(configPath)) {
      logger.warn({ clientCode: params.clientCode, configPath }, "Client config not found");
      return JSON.stringify({
        error: `No ads-config.yaml found for '${params.clientCode}' (looked in ${folder}/)`,
        hint: "Use list_clients() for basic conversion goals, or ask Daniel for targets",
      });
    }

    const raw = readFileSync(configPath, "utf-8");
    const config = yaml.load(raw) as Record<string, unknown>;

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
      "Loaded client targets config",
    );
    return JSON.stringify(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg, clientCode: params.clientCode }, "getClientTargets failed");
    return JSON.stringify({ error: msg });
  }
}
