import type {
  ReportData,
  CondensedReport,
  HealthScore,
  WoWDelta,
  DailyAnomaly,
  CampaignHighlight,
  FunnelStage,
  CreativeSummary,
  AccountDailyRow,
  CampaignSummaryRow,
  BreakdownRow,
} from './types.js';

// ---------------------------------------------------------------------------
// Stage 2: Data Condensation (pure math — zero LLM)
// ---------------------------------------------------------------------------

export function condenseReport(data: ReportData): CondensedReport {
  const { days } = data;

  // Split account daily into current and prior periods
  const cutoff = daysAgoISO(days);
  const currentDays = data.accountDaily.filter((r) => r.date >= cutoff);
  const priorDays = data.accountDaily.filter((r) => r.date < cutoff);

  // Aggregate periods
  const currentAgg = aggregateDays(currentDays);
  const priorAgg = aggregateDays(priorDays);

  // Determine primary KPI
  const primaryKpiName = detectPrimaryKpi(data.clientTargets);

  // WoW deltas
  const wow = computeWoW(currentAgg, priorAgg, primaryKpiName);

  // Daily anomalies
  const anomalies = detectDailyAnomalies(currentDays);

  // Campaign highlights
  const { top, bottom, flagged } = rankCampaigns(
    data.campaignsCurrent,
    data.campaignsPrior,
    primaryKpiName,
  );

  // Funnel analysis
  const funnel = analyzeFunnel(currentAgg, priorAgg);

  // Breakdown insights
  const breakdownInsights = analyzeBreakdowns(data.breakdowns);

  // Change correlations
  const changeCorrelations = correlateChanges(data.accountChanges, currentDays);

  // Creative health
  const creative = summarizeCreatives(data);

  // Drill-down summaries
  const drilldowns = data.campaignDrilldowns.map((d) => ({
    campaignName: d.campaignName,
    reason: d.reason,
    details: summarizeDrilldown(d),
  }));

  // Health score
  const { score, reasons } = computeHealthScore(wow, anomalies, primaryKpiName, data.clientTargets);

  // Context strings for narrative
  const methodology = data.methodology
    .slice(0, 15)
    .map((m) => `[${m.type}] ${m.title}: ${m.content?.slice(0, 200)}`);
  const learnings = data.learnings
    .slice(0, 10)
    .map((l) => `${l.title}: ${l.insight?.slice(0, 200)}`);

  return {
    clientCode: data.clientCode,
    clientName: data.clientName,
    currency: data.currency,
    periodStart: data.periodStart,
    periodEnd: data.periodEnd,
    healthScore: score,
    healthReasons: reasons,
    wow,
    anomalies,
    topCampaigns: top,
    bottomCampaigns: bottom,
    flaggedCampaigns: flagged,
    funnel,
    breakdownInsights,
    changeCorrelations,
    creative,
    drilldowns,
    targets: data.clientTargets,
    methodology,
    learnings,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgoISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

interface AggregatedMetrics {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  link_clicks: number;
  content_views: number;
  add_to_carts: number;
  checkouts_initiated: number;
  purchases: number;
  purchase_value: number;
  leads: number;
  complete_registrations: number;
  days: number;
  frequency: number;
  roas: number;
  cpm: number;
  ctr: number;
  cpc: number;
  cost_per_result: number;
}

function aggregateDays(rows: AccountDailyRow[]): AggregatedMetrics {
  const agg: AggregatedMetrics = {
    spend: 0, impressions: 0, reach: 0, clicks: 0, link_clicks: 0,
    content_views: 0, add_to_carts: 0, checkouts_initiated: 0,
    purchases: 0, purchase_value: 0, leads: 0, complete_registrations: 0,
    days: rows.length, frequency: 0, roas: 0, cpm: 0, ctr: 0, cpc: 0,
    cost_per_result: 0,
  };

  for (const r of rows) {
    agg.spend += n(r.spend);
    agg.impressions += n(r.impressions);
    agg.reach += n(r.reach);
    agg.clicks += n(r.clicks);
    agg.link_clicks += n(r.link_clicks);
    agg.content_views += n(r.content_views);
    agg.add_to_carts += n(r.add_to_carts);
    agg.checkouts_initiated += n(r.checkouts_initiated);
    agg.purchases += n(r.purchases);
    agg.purchase_value += n(r.purchase_value);
    agg.leads += n(r.leads);
    agg.complete_registrations += n(r.complete_registrations);
  }

  // Computed metrics
  agg.frequency = agg.reach > 0 ? round(agg.impressions / agg.reach, 2) : 0;
  agg.roas = agg.spend > 0 ? round(agg.purchase_value / agg.spend, 2) : 0;
  agg.cpm = agg.impressions > 0 ? round((agg.spend / agg.impressions) * 1000, 2) : 0;
  agg.ctr = agg.impressions > 0 ? round((agg.clicks / agg.impressions) * 100, 2) : 0;
  agg.cpc = agg.clicks > 0 ? round(agg.spend / agg.clicks, 2) : 0;
  agg.cost_per_result = agg.purchases > 0
    ? round(agg.spend / agg.purchases, 2)
    : agg.leads > 0
      ? round(agg.spend / agg.leads, 2)
      : 0;

  return agg;
}

function n(v: unknown): number {
  return Number(v) || 0;
}

function round(v: number, dp = 2): number {
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}

function pctChange(current: number, prior: number): number {
  if (prior === 0) return current > 0 ? 100 : 0;
  return round(((current - prior) / prior) * 100, 1);
}

function makeWoW(current: number, prior: number): WoWDelta {
  return {
    current: round(current),
    prior: round(prior),
    change: round(current - prior),
    changePct: pctChange(current, prior),
  };
}

// ---------------------------------------------------------------------------
// Primary KPI detection
// ---------------------------------------------------------------------------

function detectPrimaryKpi(targets: Record<string, unknown> | null): string {
  if (!targets) return 'roas';
  const kpi = targets.kpi_primary as string | undefined;
  if (!kpi) return 'roas';
  const lower = kpi.toLowerCase();
  if (lower.includes('cpa') || lower.includes('cost_per_purchase')) return 'cpa';
  if (lower.includes('cpl') || lower.includes('cost_per_lead')) return 'cpl';
  if (lower.includes('roas')) return 'roas';
  return 'roas';
}

// ---------------------------------------------------------------------------
// WoW computation
// ---------------------------------------------------------------------------

function computeWoW(
  current: AggregatedMetrics,
  prior: AggregatedMetrics,
  primaryKpiName: string,
): CondensedReport['wow'] {
  let primaryKpiCurrent: number;
  let primaryKpiPrior: number;

  switch (primaryKpiName) {
    case 'cpa':
      primaryKpiCurrent = current.purchases > 0 ? round(current.spend / current.purchases) : 0;
      primaryKpiPrior = prior.purchases > 0 ? round(prior.spend / prior.purchases) : 0;
      break;
    case 'cpl':
      primaryKpiCurrent = current.leads > 0 ? round(current.spend / current.leads) : 0;
      primaryKpiPrior = prior.leads > 0 ? round(prior.spend / prior.leads) : 0;
      break;
    default: // roas
      primaryKpiCurrent = current.roas;
      primaryKpiPrior = prior.roas;
  }

  return {
    spend: makeWoW(current.spend, prior.spend),
    primaryKpi: makeWoW(primaryKpiCurrent, primaryKpiPrior),
    primaryKpiName,
    frequency: makeWoW(current.frequency, prior.frequency),
    ctr: makeWoW(current.ctr, prior.ctr),
    cpm: makeWoW(current.cpm, prior.cpm),
    impressions: makeWoW(current.impressions, prior.impressions),
    purchases: makeWoW(current.purchases, prior.purchases),
    revenue: makeWoW(current.purchase_value, prior.purchase_value),
  };
}

// ---------------------------------------------------------------------------
// Daily anomaly detection
// ---------------------------------------------------------------------------

function detectDailyAnomalies(days: AccountDailyRow[]): DailyAnomaly[] {
  if (days.length < 3) return [];

  const anomalies: DailyAnomaly[] = [];
  const metrics: (keyof AccountDailyRow)[] = ['spend', 'roas', 'cpm', 'ctr'];

  for (const metric of metrics) {
    const values = days.map((d) => n(d[metric]));
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    if (avg === 0) continue;

    for (let i = 0; i < days.length; i++) {
      const deviation = ((values[i]! - avg) / avg) * 100;
      if (Math.abs(deviation) > 20) {
        anomalies.push({
          date: days[i]!.date,
          metric: metric as string,
          value: round(values[i]!),
          weekAvg: round(avg),
          deviationPct: round(deviation, 1),
        });
      }
    }
  }

  return anomalies.sort((a, b) => Math.abs(b.deviationPct) - Math.abs(a.deviationPct)).slice(0, 10);
}

// ---------------------------------------------------------------------------
// Campaign rankings
// ---------------------------------------------------------------------------

function rankCampaigns(
  current: CampaignSummaryRow[],
  prior: CampaignSummaryRow[],
  primaryKpiName: string,
): { top: CampaignHighlight[]; bottom: CampaignHighlight[]; flagged: CampaignHighlight[] } {
  const priorMap = new Map(prior.map((c) => [c.campaign_id, c]));

  const highlights: CampaignHighlight[] = current
    .filter((c) => n(c.spend) > 0)
    .map((c) => {
      const p = priorMap.get(c.campaign_id);
      const spendChange = p && n(p.spend) > 0 ? pctChange(n(c.spend), n(p.spend)) : 0;

      let kpiVal: number;
      let kpiPrior: number;
      switch (primaryKpiName) {
        case 'cpa':
          kpiVal = n(c.purchases) > 0 ? n(c.spend) / n(c.purchases) : 0;
          kpiPrior = p && n(p.purchases) > 0 ? n(p.spend) / n(p.purchases) : 0;
          break;
        case 'cpl':
          kpiVal = n(c.leads) > 0 ? n(c.spend) / n(c.leads) : 0;
          kpiPrior = p && n(p.leads) > 0 ? n(p.spend) / n(p.leads) : 0;
          break;
        default:
          kpiVal = n(c.roas);
          kpiPrior = p ? n(p.roas) : 0;
      }

      const kpiChange = kpiPrior > 0 ? pctChange(kpiVal, kpiPrior) : 0;
      const flags: string[] = [];
      if (Math.abs(spendChange) > 30) flags.push(spendChange > 0 ? 'spend_spike' : 'spend_drop');
      if (primaryKpiName === 'roas' && kpiChange < -20) flags.push('kpi_drop');
      if (primaryKpiName !== 'roas' && kpiChange > 20) flags.push('kpi_worsened'); // CPA/CPL going up is bad
      if (n(c.frequency) > 2.5) flags.push('high_frequency');

      return {
        campaignId: c.campaign_id,
        campaignName: c.campaign_name,
        spend: round(n(c.spend)),
        spendChange,
        primaryKpi: round(kpiVal),
        primaryKpiChange: kpiChange,
        status: c.status,
        flags,
      };
    });

  // Sort by spend for top/bottom
  const sorted = [...highlights].sort((a, b) => b.spend - a.spend);
  const top = sorted.slice(0, 5);
  const bottom = sorted.filter((c) => c.spend > 10).slice(-3).reverse();
  const flagged = highlights.filter((c) => c.flags.length > 0).slice(0, 5);

  return { top, bottom, flagged };
}

// ---------------------------------------------------------------------------
// Funnel analysis
// ---------------------------------------------------------------------------

function analyzeFunnel(current: AggregatedMetrics, prior: AggregatedMetrics): FunnelStage[] {
  const stages: FunnelStage[] = [];

  const funnelDef: { stage: string; currentVal: number; priorVal: number; base: 'impressions' | 'link_clicks' | 'content_views' | 'add_to_carts' | 'checkouts_initiated' }[] = [
    { stage: 'Impressions → Link Clicks', currentVal: current.link_clicks, priorVal: prior.link_clicks, base: 'impressions' },
    { stage: 'Link Clicks → Content Views', currentVal: current.content_views, priorVal: prior.content_views, base: 'link_clicks' },
    { stage: 'Content Views → Add to Cart', currentVal: current.add_to_carts, priorVal: prior.add_to_carts, base: 'content_views' },
    { stage: 'Add to Cart → Checkout', currentVal: current.checkouts_initiated, priorVal: prior.checkouts_initiated, base: 'add_to_carts' },
    { stage: 'Checkout → Purchase', currentVal: current.purchases, priorVal: prior.purchases, base: 'checkouts_initiated' },
  ];

  const currentBases: Record<string, number> = {
    impressions: current.impressions,
    link_clicks: current.link_clicks,
    content_views: current.content_views,
    add_to_carts: current.add_to_carts,
    checkouts_initiated: current.checkouts_initiated,
  };

  const priorBases: Record<string, number> = {
    impressions: prior.impressions,
    link_clicks: prior.link_clicks,
    content_views: prior.content_views,
    add_to_carts: prior.add_to_carts,
    checkouts_initiated: prior.checkouts_initiated,
  };

  for (const f of funnelDef) {
    const currentBase = currentBases[f.base] ?? 0;
    const priorBase = priorBases[f.base] ?? 0;

    const rate = currentBase > 0 ? round((f.currentVal / currentBase) * 100, 2) : 0;
    const priorRate = priorBase > 0 ? round((f.priorVal / priorBase) * 100, 2) : 0;

    // Skip stages with no data
    if (currentBase === 0 && priorBase === 0) continue;

    stages.push({
      stage: f.stage,
      value: f.currentVal,
      rate,
      priorRate,
      rateChange: round(rate - priorRate, 2),
    });
  }

  return stages;
}

// ---------------------------------------------------------------------------
// Breakdown analysis
// ---------------------------------------------------------------------------

function analyzeBreakdowns(
  breakdowns: Record<string, BreakdownRow[]>,
): CondensedReport['breakdownInsights'] {
  const insights: CondensedReport['breakdownInsights'] = [];

  for (const [type, rows] of Object.entries(breakdowns)) {
    if (!rows.length) continue;

    const sorted = [...rows].sort((a, b) => n(b.spend) - n(a.spend));
    const totalSpend = sorted.reduce((sum, r) => sum + n(r.spend), 0);

    const topSegments = sorted.slice(0, 5).map((r) => ({
      value: r.breakdown_value,
      spend: round(n(r.spend)),
      roas: n(r.roas) || (n(r.spend) > 0 ? round(n(r.purchase_value) / n(r.spend), 2) : 0),
      cpa: n(r.cpa) || (n(r.purchases) > 0 ? round(n(r.spend) / n(r.purchases)) : 0),
    }));

    const shifts: string[] = [];

    // Concentration check
    if (sorted.length > 0 && totalSpend > 0) {
      const topPct = round((n(sorted[0]!.spend) / totalSpend) * 100, 1);
      if (topPct > 60) {
        shifts.push(`${sorted[0]!.breakdown_value} dominates at ${topPct}% of spend`);
      }
    }

    // ROAS variance
    const roasValues = topSegments.filter((s) => s.roas > 0).map((s) => s.roas);
    if (roasValues.length >= 2) {
      const maxRoas = Math.max(...roasValues);
      const minRoas = Math.min(...roasValues);
      if (maxRoas > minRoas * 2) {
        const best = topSegments.find((s) => s.roas === maxRoas);
        const worst = topSegments.find((s) => s.roas === minRoas);
        if (best && worst) {
          shifts.push(`${best.value} (${maxRoas}x ROAS) vs ${worst.value} (${minRoas}x) — ${round(maxRoas / minRoas, 1)}x gap`);
        }
      }
    }

    insights.push({ type, topSegments, shifts });
  }

  return insights;
}

// ---------------------------------------------------------------------------
// Change-to-performance correlation
// ---------------------------------------------------------------------------

function correlateChanges(
  changes: { event_time: string; event_type: string; object_name: string; extra_data: unknown }[],
  dailyData: AccountDailyRow[],
): CondensedReport['changeCorrelations'] {
  if (!changes.length || !dailyData.length) return [];

  const correlations: CondensedReport['changeCorrelations'] = [];
  const dailyMap = new Map(dailyData.map((d) => [d.date, d]));

  for (const change of changes.slice(0, 10)) {
    const changeDate = change.event_time.slice(0, 10);
    const nextDay = nextDayISO(changeDate);
    const dayAfter = dailyMap.get(nextDay);
    const dayBefore = dailyMap.get(changeDate);

    if (dayAfter && dayBefore) {
      const spendDelta = n(dayBefore.spend) > 0
        ? pctChange(n(dayAfter.spend), n(dayBefore.spend))
        : 0;
      const cpaDelta = n(dayBefore.cost_per_result) > 0 && n(dayAfter.cost_per_result) > 0
        ? pctChange(n(dayAfter.cost_per_result), n(dayBefore.cost_per_result))
        : 0;

      if (Math.abs(spendDelta) > 15 || Math.abs(cpaDelta) > 15) {
        correlations.push({
          change: `${change.event_type}: ${change.object_name}`,
          date: changeDate,
          impact: `Next day: spend ${spendDelta > 0 ? '+' : ''}${spendDelta}%, CPA ${cpaDelta > 0 ? '+' : ''}${cpaDelta}%`,
        });
      }
    }
  }

  return correlations.slice(0, 5);
}

function nextDayISO(date: string): string {
  const d = new Date(date);
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Creative summary
// ---------------------------------------------------------------------------

function summarizeCreatives(data: ReportData): CreativeSummary {
  const fatigued = data.fatiguedCreatives;

  // Top performers from non-fatigued creatives (by scores)
  const topPerformers = [...(data.topCreatives ?? []), ...fatigued]
    .filter((c) => !c.is_fatigued && c.convert_score != null)
    .sort((a, b) => n(b.convert_score) - n(a.convert_score))
    .slice(0, 3)
    .map((c) => ({
      name: c.ad_name,
      score: round(n(c.convert_score)),
      metric: 'convert_score',
    }));

  // Recent launches (last_active_at within 7 days)
  const sevenDaysAgo = daysAgoISO(7);
  const recentLaunches = [...(data.topCreatives ?? []), ...fatigued]
    .filter((c) => c.last_active_at >= sevenDaysAgo && !c.is_fatigued)
    .length;

  return {
    totalActive: (data.topCreatives?.length ?? 0) + fatigued.filter((c) => !c.is_fatigued).length,
    fatiguedCount: fatigued.filter((c) => c.is_fatigued).length,
    topPerformers,
    recentLaunches,
  };
}

// ---------------------------------------------------------------------------
// Drill-down summarization
// ---------------------------------------------------------------------------

function summarizeDrilldown(drilldown: { adsets: { adset_name: string; spend: number; roas: number; cost_per_result: number; results: number }[] }): string {
  if (!drilldown.adsets.length) return 'No adset data available';

  const sorted = [...drilldown.adsets].sort((a, b) => n(b.spend) - n(a.spend));
  return sorted
    .slice(0, 5)
    .map((a) => `${a.adset_name}: spend ${round(n(a.spend))}, ROAS ${round(n(a.roas), 2)}x, CPR ${round(n(a.cost_per_result))}`)
    .join(' | ');
}

// ---------------------------------------------------------------------------
// Health score
// ---------------------------------------------------------------------------

function computeHealthScore(
  wow: CondensedReport['wow'],
  anomalies: DailyAnomaly[],
  primaryKpiName: string,
  targets: Record<string, unknown> | null,
): { score: HealthScore; reasons: string[] } {
  let score = 0; // 0-100
  const reasons: string[] = [];

  // Primary KPI direction (higher is better for ROAS, lower for CPA/CPL)
  const kpiImproving = primaryKpiName === 'roas'
    ? wow.primaryKpi.changePct > 0
    : wow.primaryKpi.changePct < 0;

  if (kpiImproving) {
    score += 30;
    reasons.push(`${primaryKpiName.toUpperCase()} improved ${Math.abs(wow.primaryKpi.changePct)}% WoW`);
  } else if (Math.abs(wow.primaryKpi.changePct) < 5) {
    score += 20;
    reasons.push(`${primaryKpiName.toUpperCase()} stable (${wow.primaryKpi.changePct}% WoW)`);
  } else {
    reasons.push(`${primaryKpiName.toUpperCase()} worsened ${Math.abs(wow.primaryKpi.changePct)}% WoW`);
  }

  // Spend stability (big changes in either direction get some concern)
  if (Math.abs(wow.spend.changePct) < 10) {
    score += 20;
  } else if (Math.abs(wow.spend.changePct) < 25) {
    score += 10;
    reasons.push(`Spend shifted ${wow.spend.changePct > 0 ? '+' : ''}${wow.spend.changePct}%`);
  } else {
    reasons.push(`Large spend change: ${wow.spend.changePct > 0 ? '+' : ''}${wow.spend.changePct}%`);
  }

  // Frequency (low is good for prospecting)
  if (wow.frequency.current < 1.5) {
    score += 15;
  } else if (wow.frequency.current < 2.0) {
    score += 10;
  } else {
    reasons.push(`High frequency: ${wow.frequency.current}`);
  }

  // CTR trend
  if (wow.ctr.changePct > 0) {
    score += 10;
  } else if (wow.ctr.changePct < -10) {
    reasons.push(`CTR dropped ${Math.abs(wow.ctr.changePct)}%`);
  } else {
    score += 5;
  }

  // Anomaly penalty
  const severeAnomalies = anomalies.filter((a) => Math.abs(a.deviationPct) > 40);
  if (severeAnomalies.length === 0) {
    score += 15;
  } else {
    score += Math.max(0, 15 - severeAnomalies.length * 5);
    reasons.push(`${severeAnomalies.length} severe daily anomalies`);
  }

  // Purchase volume trend
  if (wow.purchases.changePct > 5) {
    score += 10;
  } else if (wow.purchases.changePct > -5) {
    score += 5;
  } else {
    reasons.push(`Purchases down ${Math.abs(wow.purchases.changePct)}%`);
  }

  // Map to label
  let label: HealthScore;
  if (score >= 80) label = 'Excellent';
  else if (score >= 60) label = 'Good';
  else if (score >= 40) label = 'Watch';
  else if (score >= 20) label = 'Concern';
  else label = 'Critical';

  return { score: label, reasons };
}
