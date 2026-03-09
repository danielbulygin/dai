import * as supabaseTools from '../agents/tools/supabase-tools.js';
import * as clientConfigTools from '../agents/tools/client-config-tools.js';
import * as methodologyTools from '../agents/tools/methodology-tools.js';
import { logger } from '../utils/logger.js';
import type {
  ReportData,
  AccountDailyRow,
  CampaignSummaryRow,
  AccountChangeRow,
  BreakdownRow,
  CreativeRow,
  MethodologyRow,
  LearningRow,
  CampaignDrilldown,
} from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJson<T>(raw: string): T | null {
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.error) {
      logger.warn({ error: parsed.error }, 'Data source returned error');
      return null;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

function daysAgoISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Stage 1: Data Gathering
// ---------------------------------------------------------------------------

export async function gatherReportData(
  clientCode: string,
  days = 7,
): Promise<ReportData> {
  logger.info({ clientCode, days }, 'Gathering report data');

  // Resolve client name first
  const clientsRaw = await supabaseTools.listClients();
  const clients = parseJson<{ code: string; name: string; currency: string }[]>(clientsRaw);
  const client = clients?.find(
    (c) => c.code.toLowerCase() === clientCode.toLowerCase(),
  );
  if (!client) {
    throw new Error(`Client '${clientCode}' not found`);
  }

  // Parallel fetch — all independent
  const [
    accountDailyRaw,
    campaignsCurrentRaw,
    campaignsPriorRaw,
    accountChangesRaw,
    breakdownDeviceRaw,
    breakdownPlacementRaw,
    breakdownAgeRaw,
    breakdownCountryRaw,
    fatiguedRaw,
    targetsRaw,
    methodologyRaw,
    learningsRaw,
  ] = await Promise.all([
    // 14 days of account data (current + prior for WoW)
    supabaseTools.getClientPerformance({ clientCode, days: days * 2 }),
    // Campaign summary: current period
    supabaseTools.getCampaignSummary({ clientCode, days }),
    // Campaign summary: prior period (double the window, we subtract current later)
    supabaseTools.getCampaignSummary({ clientCode, days: days * 2 }),
    // Account changes
    supabaseTools.getAccountChanges({ clientCode, days }),
    // Breakdowns (aggregated)
    supabaseTools.getBreakdowns({ clientCode, breakdownType: 'device', days, aggregate: true }),
    supabaseTools.getBreakdowns({ clientCode, breakdownType: 'placement', days, aggregate: true }),
    supabaseTools.getBreakdowns({ clientCode, breakdownType: 'age', days, aggregate: true }),
    supabaseTools.getBreakdowns({ clientCode, breakdownType: 'country', days, aggregate: true }),
    // Creatives: fatigued
    supabaseTools.getCreativeDetails({ clientCode, onlyFatigued: true }),
    // Client targets
    clientConfigTools.getClientTargets({ clientCode }),
    // Methodology (account-specific)
    methodologyTools.searchMethodology({ accountCode: clientCode.toLowerCase(), limit: 30 }),
    // Learnings
    supabaseTools.getLearnings({ clientCode, limit: 20 }),
  ]);

  const accountDaily = parseJson<AccountDailyRow[]>(accountDailyRaw) ?? [];
  const campaignsCurrent = parseJson<CampaignSummaryRow[]>(campaignsCurrentRaw) ?? [];
  const campaignsPrior = parseJson<CampaignSummaryRow[]>(campaignsPriorRaw) ?? [];
  const accountChanges = parseJson<AccountChangeRow[]>(accountChangesRaw) ?? [];
  const fatiguedCreatives = parseJson<CreativeRow[]>(fatiguedRaw) ?? [];
  const targets = parseJson<Record<string, unknown>>(targetsRaw);
  const methodology = parseJson<MethodologyRow[]>(methodologyRaw) ?? [];
  const learnings = parseJson<LearningRow[]>(learningsRaw) ?? [];

  // Parse breakdowns — handle both raw array and aggregated format
  const breakdowns: Record<string, BreakdownRow[]> = {};
  for (const [key, raw] of [
    ['device', breakdownDeviceRaw],
    ['placement', breakdownPlacementRaw],
    ['age', breakdownAgeRaw],
    ['country', breakdownCountryRaw],
  ] as const) {
    const parsed = parseJson<BreakdownRow[] | { data: BreakdownRow[] }>(raw);
    if (parsed) {
      breakdowns[key] = Array.isArray(parsed) ? parsed : (parsed.data ?? []);
    } else {
      breakdowns[key] = [];
    }
  }

  // Conditional drill-downs: campaigns with >20% WoW spend change or top 3 by spend
  const drilldowns = await fetchCampaignDrilldowns(
    clientCode,
    days,
    campaignsCurrent,
    campaignsPrior,
  );

  const periodEnd = todayISO();
  const periodStart = daysAgoISO(days);

  const data: ReportData = {
    clientCode: client.code,
    clientName: client.name,
    currency: client.currency ?? 'EUR',
    periodStart,
    periodEnd,
    days,
    accountDaily,
    campaignsCurrent,
    campaignsPrior,
    accountChanges,
    breakdowns,
    fatiguedCreatives,
    topCreatives: [], // filled from campaign data
    clientTargets: targets,
    methodology,
    learnings,
    campaignDrilldowns: drilldowns,
  };

  logger.info(
    {
      clientCode,
      accountDays: accountDaily.length,
      campaigns: campaignsCurrent.length,
      changes: accountChanges.length,
      drilldowns: drilldowns.length,
    },
    'Report data gathered',
  );

  return data;
}

// ---------------------------------------------------------------------------
// Conditional drill-downs
// ---------------------------------------------------------------------------

async function fetchCampaignDrilldowns(
  clientCode: string,
  days: number,
  current: CampaignSummaryRow[],
  prior: CampaignSummaryRow[],
): Promise<CampaignDrilldown[]> {
  const priorMap = new Map(prior.map((c) => [c.campaign_id, c]));
  const flagged: { id: string; name: string; reason: string }[] = [];

  // Flag campaigns with >20% WoW change in spend or primary KPI
  for (const c of current) {
    const p = priorMap.get(c.campaign_id);
    if (!p || p.spend < 10) continue; // skip tiny or new campaigns

    const spendChange = p.spend > 0 ? ((c.spend - p.spend) / p.spend) * 100 : 0;
    const kpiChange = p.cost_per_result > 0
      ? ((c.cost_per_result - p.cost_per_result) / p.cost_per_result) * 100
      : 0;

    if (Math.abs(spendChange) > 20) {
      flagged.push({
        id: c.campaign_id,
        name: c.campaign_name,
        reason: `spend ${spendChange > 0 ? '+' : ''}${spendChange.toFixed(0)}% WoW`,
      });
    } else if (Math.abs(kpiChange) > 20) {
      flagged.push({
        id: c.campaign_id,
        name: c.campaign_name,
        reason: `cost/result ${kpiChange > 0 ? '+' : ''}${kpiChange.toFixed(0)}% WoW`,
      });
    }
  }

  // Also include top 3 by spend if not already flagged
  const sorted = [...current].sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0));
  const flaggedIds = new Set(flagged.map((f) => f.id));
  for (const c of sorted.slice(0, 3)) {
    if (!flaggedIds.has(c.campaign_id)) {
      flagged.push({
        id: c.campaign_id,
        name: c.campaign_name,
        reason: 'top spend',
      });
    }
  }

  // Limit to 5 drill-downs to control data volume
  const toDrill = flagged.slice(0, 5);
  if (toDrill.length === 0) return [];

  // Fetch adset summaries in parallel
  const drilldowns = await Promise.all(
    toDrill.map(async (f) => {
      const raw = await supabaseTools.getAdsetSummary({
        clientCode,
        campaignId: f.id,
        days,
      });
      const adsets = parseJson<CampaignDrilldown['adsets']>(raw) ?? [];
      return {
        campaignId: f.id,
        campaignName: f.name,
        reason: f.reason,
        adsets,
      };
    }),
  );

  return drilldowns;
}
