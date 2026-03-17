/**
 * Daily account scanner — runs anomaly detection across all client accounts.
 * Produces a HeartbeatReport with per-client health status.
 */

import { listClients, getClientPerformance, getCampaignPerformance } from '../agents/tools/supabase-tools.js';
import { getClientTargets } from '../agents/tools/client-config-tools.js';
import { getSupabase } from '../integrations/supabase.js';
import { logger } from '../utils/logger.js';
import {
  detectAnomalies,
  deduplicateAnomalies,
  detectCompoundSignals,
  detectPlatformIssues,
  deriveHealth,
  detectClientType,
  type DailyMetric,
  type AnomalySignal,
  type CompoundSignal,
  type HealthStatus,
  type ClientType,
} from './anomaly-detector.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClientInfo {
  id: number;
  code: string;
  name: string;
  conversion_goals: unknown;
}

export interface CampaignIssue {
  campaignName: string;
  campaignId: string;
  spend: number;
  issue: string;
}

export interface ClientHeartbeat {
  clientCode: string;
  clientName: string;
  clientId: number;
  clientType: ClientType;
  health: HealthStatus;
  anomalies: AnomalySignal[];
  compounds: CompoundSignal[];
  topCampaignIssues: CampaignIssue[];
  targets?: Record<string, unknown>;
  dataStale?: boolean;
  insufficientData?: boolean;
  latestDate?: string;
  todaySpend?: number;
  todayFrequency?: number;
}

export interface HeartbeatReport {
  timestamp: string;
  clients: ClientHeartbeat[];
  platformIssue: CompoundSignal | null;
  summary: {
    critical: number;
    alert: number;
    watch: number;
    healthy: number;
    total: number;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDailyMetrics(data: unknown[]): DailyMetric[] {
  return data.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      date: String(r.date ?? ''),
      spend: Number(r.spend) || 0,
      impressions: Number(r.impressions) || 0,
      reach: Number(r.reach) || 0,
      frequency: Number(r.frequency) || 0,
      clicks: Number(r.clicks) || 0,
      link_clicks: Number(r.link_clicks) || 0,
      content_views: Number(r.content_views) || 0,
      add_to_carts: Number(r.add_to_carts) || 0,
      checkouts_initiated: Number(r.checkouts_initiated) || 0,
      purchases: Number(r.purchases) || 0,
      purchase_value: Number(r.purchase_value) || 0,
      roas: Number(r.roas) || 0,
      cpm: Number(r.cpm) || 0,
      ctr: Number(r.ctr) || 0,
      ctr_link: Number(r.ctr_link) || 0,
      cpc: Number(r.cpc) || 0,
      unique_link_clicks: Number(r.unique_link_clicks) || 0,
      results: Number(r.results) || 0,
      cost_per_result: Number(r.cost_per_result) || 0,
      leads: Number(r.leads) || 0,
      complete_registrations: Number(r.complete_registrations) || 0,
    };
  });
}

function parseTargets(
  raw: string,
): { targets?: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.error) return null;
    return {
      targets: (parsed.targets as Record<string, unknown>) ?? undefined,
    };
  } catch {
    return null;
  }
}

/** Check if data is stale (latest date older than yesterday). */
function isDataStale(latestDate: string): boolean {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);
  return latestDate < yesterdayStr;
}

// ---------------------------------------------------------------------------
// Per-client processing
// ---------------------------------------------------------------------------

async function processClient(client: ClientInfo): Promise<ClientHeartbeat> {
  const clientType = detectClientType(client.conversion_goals);

  // Fetch performance data (14 days) and targets in parallel
  const [perfRaw, targetsRaw] = await Promise.all([
    getClientPerformance({ clientCode: client.code, days: 14 }),
    getClientTargets({ clientCode: client.code }),
  ]);

  const perfData = JSON.parse(perfRaw);
  if (perfData.error) {
    logger.warn(
      { clientCode: client.code, error: perfData.error },
      'Failed to get performance data',
    );
    return {
      clientCode: client.code,
      clientName: client.name,
      clientId: client.id,
      clientType,
      health: 'healthy',
      anomalies: [],
      compounds: [],
      topCampaignIssues: [],
      insufficientData: true,
    };
  }

  let metrics = parseDailyMetrics(perfData as unknown[]);

  // Sort ascending by date
  metrics.sort((a, b) => a.date.localeCompare(b.date));

  // If the latest day has 0 spend or 0 impressions, it's paused/incomplete.
  // Drop zero days from the end until we find a real data point.
  while (
    metrics.length > 1 &&
    (metrics[metrics.length - 1]!.spend === 0 ||
      metrics[metrics.length - 1]!.impressions === 0)
  ) {
    metrics = metrics.slice(0, -1);
  }

  const sorted = metrics;

  // Check for insufficient data (<8 days)
  if (sorted.length < 8) {
    return {
      clientCode: client.code,
      clientName: client.name,
      clientId: client.id,
      clientType,
      health: 'healthy',
      anomalies: [],
      compounds: [],
      topCampaignIssues: [],
      insufficientData: true,
      latestDate: sorted[sorted.length - 1]?.date,
    };
  }

  // Check data staleness
  const latestDay = sorted[sorted.length - 1]!;
  const latestDate = latestDay.date;
  const dataStale = isDataStale(latestDate);

  // Skip paused accounts (< $10 total spend in last 7 days)
  const last7 = sorted.slice(-7);
  const totalSpend7d = last7.reduce((sum, d) => sum + d.spend, 0);
  if (totalSpend7d < 10) {
    return {
      clientCode: client.code,
      clientName: client.name,
      clientId: client.id,
      clientType,
      health: 'healthy',
      anomalies: [],
      compounds: [],
      topCampaignIssues: [],
      dataStale,
      latestDate,
      todaySpend: latestDay.spend,
    };
  }

  // Parse targets
  const targetsParsed = parseTargets(targetsRaw);
  const targets = targetsParsed?.targets;

  // Run anomaly detection + deduplication
  const rawAnomalies = detectAnomalies(sorted, client.conversion_goals, targets);
  const anomalies = deduplicateAnomalies(rawAnomalies);
  const compounds = detectCompoundSignals(
    anomalies,
    sorted,
    client.conversion_goals,
    targets,
  );
  const health = deriveHealth(anomalies, compounds);

  const today = latestDay;

  // Campaign drill-down for alert/critical
  let topCampaignIssues: CampaignIssue[] = [];
  if (health === 'critical' || health === 'alert') {
    topCampaignIssues = await drillDownCampaigns(client.code, anomalies);
  }

  return {
    clientCode: client.code,
    clientName: client.name,
    clientId: client.id,
    clientType,
    health,
    anomalies,
    compounds,
    topCampaignIssues,
    targets,
    dataStale,
    latestDate,
    todaySpend: today.spend,
    todayFrequency: today.frequency,
  };
}

/** Fetch campaign data and identify top issues for alert/critical accounts. */
async function drillDownCampaigns(
  clientCode: string,
  anomalies: AnomalySignal[],
): Promise<CampaignIssue[]> {
  try {
    const raw = JSON.parse(
      await getCampaignPerformance({ clientCode, days: 7 }),
    );
    if (raw.error || !Array.isArray(raw)) return [];

    // Group by campaign, sum spend
    const campaigns = new Map<
      string,
      { name: string; id: string; spend: number; latest: Record<string, unknown> }
    >();
    for (const row of raw as Record<string, unknown>[]) {
      const id = String(row.campaign_id ?? '');
      const existing = campaigns.get(id);
      if (existing) {
        existing.spend += Number(row.spend) || 0;
      } else {
        campaigns.set(id, {
          name: String(row.campaign_name ?? id),
          id,
          spend: Number(row.spend) || 0,
          latest: row,
        });
      }
    }

    // Sort by spend descending, take top 1
    const topCampaigns = [...campaigns.values()]
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 1);

    // Find the primary anomaly metric to highlight
    const primaryAnomaly = anomalies.sort(
      (a, b) => severityRank(a.severity) - severityRank(b.severity),
    )[0];

    return topCampaigns.map((c) => ({
      campaignName: c.name,
      campaignId: c.id,
      spend: c.spend,
      issue: primaryAnomaly
        ? `${primaryAnomaly.metric} ${primaryAnomaly.direction} ${primaryAnomaly.percentChange}%`
        : 'multiple anomalies',
    }));
  } catch (err) {
    logger.warn({ clientCode, err }, 'Campaign drill-down failed');
    return [];
  }
}

function severityRank(severity: string): number {
  switch (severity) {
    case 'P0': return 0;
    case 'P1': return 1;
    case 'P2': return 2;
    case 'P3': return 3;
    default: return 4;
  }
}

// ---------------------------------------------------------------------------
// Alert persistence
// ---------------------------------------------------------------------------

async function persistAlerts(heartbeats: ClientHeartbeat[]): Promise<void> {
  const supabase = getSupabase();
  const today = new Date().toISOString().slice(0, 10);

  for (const hb of heartbeats) {
    if (hb.health !== 'critical' && hb.health !== 'alert') continue;

    const alertItems = [
      ...hb.compounds.filter((c) => c.severity === 'P0' || c.severity === 'P1'),
      ...hb.anomalies
        .filter((a) => a.severity === 'P0' || a.severity === 'P1')
        .map((a) => ({
          type: 'anomaly' as const,
          severity: a.severity,
          description: `${a.metric} ${a.direction} ${a.percentChange}% (${a.deviations}σ)`,
          evidence: [] as string[],
          metric: a.metric,
          expected: a.baselineAvg,
          actual: a.currentValue,
        })),
    ];

    for (const item of alertItems) {
      const alertType = 'type' in item && item.type !== 'anomaly'
        ? (item as CompoundSignal).type
        : 'anomaly';
      const metric = 'metric' in item ? (item as { metric: string }).metric : alertType;

      try {
        // Deduplicate: skip if open alert with same client + type + metric exists today
        const { data: existing } = await supabase
          .from('alerts')
          .select('id')
          .eq('client_id', hb.clientId)
          .eq('alert_type', alertType)
          .eq('metric', metric)
          .gte('created_at', today)
          .limit(1);

        if (existing && existing.length > 0) continue;

        const title =
          'description' in item
            ? (item as { description: string }).description
            : `${metric} anomaly`;
        const severity = item.severity;
        const expectedValue =
          'expected' in item ? (item as { expected: number }).expected : null;
        const actualValue =
          'actual' in item ? (item as { actual: number }).actual : null;

        await supabase.from('alerts').insert({
          client_id: hb.clientId,
          title,
          alert_type: alertType,
          severity,
          metric,
          expected_value: expectedValue,
          actual_value: actualValue,
        });

        logger.info(
          { clientCode: hb.clientCode, alertType, severity, metric },
          'Persisted monitoring alert',
        );
      } catch (err) {
        logger.warn(
          { clientCode: hb.clientCode, alertType, err },
          'Failed to persist alert',
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main: runDailyHeartbeat
// ---------------------------------------------------------------------------

export async function runDailyHeartbeat(opts?: {
  persistAlerts?: boolean;
}): Promise<HeartbeatReport> {
  logger.info('Starting daily heartbeat scan');

  const clientsRaw = JSON.parse(await listClients());
  if (clientsRaw.error) {
    throw new Error(`Failed to list clients: ${clientsRaw.error}`);
  }

  const clients = (clientsRaw as ClientInfo[]).filter(
    (c) => c.code && c.name && c.id,
  );
  logger.info({ clientCount: clients.length }, 'Scanning active clients');

  const allHeartbeats: ClientHeartbeat[] = [];

  // Process in batches of 5
  for (let i = 0; i < clients.length; i += 5) {
    const batch = clients.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map((client) => processClient(client)),
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j]!;
      const client = batch[j]!;
      if (result.status === 'fulfilled') {
        allHeartbeats.push(result.value);
      } else {
        logger.error(
          { clientCode: client.code, error: result.reason },
          'Client heartbeat failed',
        );
        allHeartbeats.push({
          clientCode: client.code,
          clientName: client.name,
          clientId: client.id,
          clientType: detectClientType(client.conversion_goals),
          health: 'healthy',
          anomalies: [],
          compounds: [],
          topCampaignIssues: [],
          insufficientData: true,
        });
      }
    }
  }

  // Platform-wide check
  const anomalyMap = new Map<string, AnomalySignal[]>();
  for (const hb of allHeartbeats) {
    if (hb.anomalies.length > 0) {
      anomalyMap.set(hb.clientCode, hb.anomalies);
    }
  }
  const platformIssue = detectPlatformIssues(anomalyMap);

  // Persist P0/P1 alerts (opt-in, skipped by CLI dry-run)
  if (opts?.persistAlerts) {
    try {
      await persistAlerts(allHeartbeats);
    } catch (err) {
      logger.error({ err }, 'Failed to persist alerts');
    }
  }

  const summary = {
    critical: allHeartbeats.filter((h) => h.health === 'critical').length,
    alert: allHeartbeats.filter((h) => h.health === 'alert').length,
    watch: allHeartbeats.filter((h) => h.health === 'watch').length,
    healthy: allHeartbeats.filter((h) => h.health === 'healthy').length,
    total: allHeartbeats.length,
  };

  logger.info(summary, 'Daily heartbeat complete');

  return {
    timestamp: new Date().toISOString(),
    clients: allHeartbeats,
    platformIssue,
    summary,
  };
}
