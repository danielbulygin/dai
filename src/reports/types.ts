// ---------------------------------------------------------------------------
// Report pipeline types
// ---------------------------------------------------------------------------

/** Raw data collected from BMAD Supabase in Stage 1 */
export interface ReportData {
  clientCode: string;
  clientName: string;
  currency: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;
  days: number;

  // Account-level daily (current + prior week)
  accountDaily: AccountDailyRow[];

  // Campaign summaries (current + prior period)
  campaignsCurrent: CampaignSummaryRow[];
  campaignsPrior: CampaignSummaryRow[];

  // Account changes
  accountChanges: AccountChangeRow[];

  // Breakdowns (aggregated)
  breakdowns: Record<string, BreakdownRow[]>;

  // Creatives
  fatiguedCreatives: CreativeRow[];
  topCreatives: CreativeRow[];

  // Context
  clientTargets: Record<string, unknown> | null;
  methodology: MethodologyRow[];
  learnings: LearningRow[];

  // Optional drill-downs for flagged campaigns
  campaignDrilldowns: CampaignDrilldown[];
}

export interface AccountDailyRow {
  date: string;
  spend: number;
  impressions: number;
  reach: number;
  frequency: number;
  clicks: number;
  link_clicks: number;
  content_views: number;
  add_to_carts: number;
  checkouts_initiated: number;
  purchases: number;
  purchase_value: number;
  roas: number;
  cpm: number;
  ctr: number;
  ctr_link: number;
  cpc: number;
  unique_link_clicks: number;
  results: number;
  cost_per_result: number;
  leads: number;
  complete_registrations: number;
  actions: unknown;
}

export interface CampaignSummaryRow {
  campaign_id: string;
  campaign_name: string;
  status: string;
  objective: string;
  spend: number;
  impressions: number;
  reach: number;
  frequency: number;
  clicks: number;
  link_clicks: number;
  purchases: number;
  purchase_value: number;
  roas: number;
  cpm: number;
  ctr: number;
  cpc: number;
  results: number;
  cost_per_result: number;
  leads: number;
  content_views: number;
  add_to_carts: number;
  checkouts_initiated: number;
  [key: string]: unknown;
}

export interface AccountChangeRow {
  event_time: string;
  event_type: string;
  object_type: string;
  object_id: string;
  object_name: string;
  actor_name: string;
  extra_data: unknown;
}

export interface BreakdownRow {
  breakdown_value: string;
  spend: number;
  impressions: number;
  clicks: number;
  link_clicks: number;
  results: number;
  purchases: number;
  purchase_value: number;
  roas?: number;
  cpa?: number;
  ctr?: number;
  days_with_data?: number;
}

export interface CreativeRow {
  creative_id: string;
  ad_id: string;
  ad_name: string;
  ad_type: string;
  status: string;
  format: string;
  primary_text: string;
  headline: string;
  is_fatigued: boolean;
  fatigue_detected_at: string | null;
  hook_score: number | null;
  watch_score: number | null;
  click_score: number | null;
  convert_score: number | null;
  campaign_name: string;
  adset_name: string;
  last_active_at: string;
  [key: string]: unknown;
}

export interface MethodologyRow {
  id: string;
  type: string;
  title: string;
  content: string;
  account_code: string;
  category: string;
  [key: string]: unknown;
}

export interface LearningRow {
  id: string;
  title: string;
  insight: string;
  category: string;
  confidence: number;
  [key: string]: unknown;
}

export interface CampaignDrilldown {
  campaignId: string;
  campaignName: string;
  reason: string; // why it was flagged
  adsets: AdsetSummaryRow[];
}

export interface AdsetSummaryRow {
  adset_id: string;
  adset_name: string;
  spend: number;
  impressions: number;
  purchases: number;
  purchase_value: number;
  roas: number;
  cost_per_result: number;
  results: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Stage 2: Condensed report
// ---------------------------------------------------------------------------

export type HealthScore = 'Excellent' | 'Good' | 'Watch' | 'Concern' | 'Critical';

export interface WoWDelta {
  current: number;
  prior: number;
  change: number; // absolute
  changePct: number; // percentage
}

export interface DailyAnomaly {
  date: string;
  metric: string;
  value: number;
  weekAvg: number;
  deviationPct: number;
}

export interface CampaignHighlight {
  campaignId: string;
  campaignName: string;
  spend: number;
  spendChange: number;
  primaryKpi: number;
  primaryKpiChange: number;
  status: string;
  flags: string[]; // e.g. ['spend_spike', 'kpi_drop']
}

export interface FunnelStage {
  stage: string;
  value: number;
  rate: number; // conversion rate from prior stage
  priorRate: number;
  rateChange: number;
}

export interface CreativeSummary {
  totalActive: number;
  fatiguedCount: number;
  topPerformers: { name: string; score: number; metric: string }[];
  recentLaunches: number;
}

export interface CondensedReport {
  clientCode: string;
  clientName: string;
  currency: string;
  periodStart: string;
  periodEnd: string;

  // Overall health
  healthScore: HealthScore;
  healthReasons: string[];

  // Week-over-week deltas
  wow: {
    spend: WoWDelta;
    primaryKpi: WoWDelta;
    primaryKpiName: string; // 'roas' | 'cpa' | 'cpl'
    frequency: WoWDelta;
    ctr: WoWDelta;
    cpm: WoWDelta;
    impressions: WoWDelta;
    purchases: WoWDelta;
    revenue: WoWDelta;
  };

  // Daily anomalies
  anomalies: DailyAnomaly[];

  // Campaign rankings
  topCampaigns: CampaignHighlight[];
  bottomCampaigns: CampaignHighlight[];
  flaggedCampaigns: CampaignHighlight[];

  // Funnel
  funnel: FunnelStage[];

  // Breakdowns
  breakdownInsights: {
    type: string;
    topSegments: { value: string; spend: number; roas: number; cpa: number }[];
    shifts: string[]; // narrative hints
  }[];

  // Changes
  changeCorrelations: {
    change: string;
    date: string;
    impact: string;
  }[];

  // Creative health
  creative: CreativeSummary;

  // Drill-downs for flagged campaigns
  drilldowns: {
    campaignName: string;
    reason: string;
    details: string;
  }[];

  // Targets
  targets: Record<string, unknown> | null;

  // Context for narrative
  methodology: string[];
  learnings: string[];
}

export interface ReportResult {
  reportText: string;
  condensedData: CondensedReport;
  inputTokens: number;
  outputTokens: number;
}
