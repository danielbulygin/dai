import { getSupabase } from "../../integrations/supabase.js";
import { logger } from "../../utils/logger.js";

/**
 * Ada customers read their OWN data, never the agency warehouse.
 *
 * Decision (Dan, 2026-07-25): external Ada customer data must never land in
 * account_daily / campaign_daily / adset_daily / ad_daily. Those tables are
 * agency-only and are filled by the nightly Python sync with an agency Meta
 * token, which has no permission on a self-serve customer's account anyway.
 *
 * Ada Guard already stores exactly what chat needs: one immutable row per
 * entity per day, at account / campaign / adset / ad level, pulled with the
 * customer's OWN OAuth connection and refreshed three times a day. This module
 * reshapes those rows into the same JSON the warehouse tools return, so the
 * chat tools branch on ONE line and every downstream prompt is unchanged.
 *
 * `clients.data_source` decides: 'guard' = Ada customer, 'warehouse' = agency.
 */

/** guard_snapshots columns we project. Keep in step with the tinkers migration. */
const SNAPSHOT_COLUMNS =
  "snapshot_date, entity_level, entity_id, parent_id, name, effective_status, spend, impressions, clicks, link_clicks, landing_page_views, results, result_type, video_plays, video_p25, video_p75, thruplays, ctr, cpm, frequency, cpa, lpv_rate, hook_rate, hold_rate, spend_share, daily_budget";

export type EntityLevel = "account" | "campaign" | "adset" | "ad";

interface SnapshotRow {
  snapshot_date: string;
  entity_level: EntityLevel;
  entity_id: string;
  parent_id: string | null;
  name: string | null;
  effective_status: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  link_clicks: number | null;
  landing_page_views: number | null;
  results: number | null;
  result_type: string | null;
  video_plays: number | null;
  video_p25: number | null;
  video_p75: number | null;
  thruplays: number | null;
  ctr: number | null;
  cpm: number | null;
  frequency: number | null;
  cpa: number | null;
  lpv_rate: number | null;
  hook_rate: number | null;
  hold_rate: number | null;
  spend_share: number | null;
  daily_budget: number | null;
}

export interface AdaClient {
  id: string;
  code: string;
  adAccountId: string | null;
}

const n = (v: number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));

function daysAgoISO(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Is this client served from Ada's own tables? Returns the client when yes,
 * null when it is an agency client (caller falls through to the warehouse).
 */
export async function adaClientFor(clientCode: string): Promise<AdaClient | null> {
  const { data, error } = await getSupabase()
    .from("clients")
    .select("id, code, ad_account_id, data_source")
    .ilike("code", clientCode)
    .maybeSingle();

  if (error) {
    logger.warn({ err: error.message, clientCode }, "ada-source: client lookup failed");
    return null;
  }
  if (!data || data.data_source !== "guard") return null;
  return {
    id: data.id as string,
    code: data.code as string,
    adAccountId: (data.ad_account_id as string | null) ?? null,
  };
}

async function fetchSnapshots(
  adAccountId: string,
  level: EntityLevel,
  since: string,
  filters: { campaignId?: string; adsetId?: string } = {},
): Promise<SnapshotRow[]> {
  let q = getSupabase()
    .from("guard_snapshots")
    .select(SNAPSHOT_COLUMNS)
    .eq("ad_account_id", adAccountId)
    .eq("entity_level", level)
    .gte("snapshot_date", since)
    .order("snapshot_date", { ascending: false })
    .limit(5000);

  // Ads and ad sets are both parented to their CAMPAIGN in guard_snapshots
  // (budget moves at campaign level under CBO, which is what people ask about).
  if (filters.campaignId) q = q.eq("parent_id", filters.campaignId);

  const { data, error } = await q;
  if (error) {
    logger.error({ err: error.message, level }, "ada-source: snapshot read failed");
    return [];
  }
  return (data ?? []) as unknown as SnapshotRow[];
}

/** account_daily shape. Lead-gen accounts have no revenue, so ROAS stays null. */
function toAccountDaily(r: SnapshotRow) {
  return {
    date: r.snapshot_date,
    spend: n(r.spend),
    impressions: n(r.impressions),
    reach: null,
    frequency: r.frequency,
    clicks: n(r.clicks),
    link_clicks: n(r.link_clicks),
    landing_page_views: n(r.landing_page_views),
    ctr: r.ctr,
    cpm: r.cpm,
    cpc: n(r.clicks) > 0 ? n(r.spend) / n(r.clicks) : null,
    results: n(r.results),
    cost_per_result: r.cpa,
    leads: r.result_type && r.result_type.includes("lead") ? n(r.results) : null,
    purchases: null,
    purchase_value: null,
    roas: null,
    lpv_rate: r.lpv_rate,
  };
}

/** campaign_daily / adset_daily / ad_daily shape. */
function toEntityDaily(r: SnapshotRow, level: EntityLevel) {
  const idKey = level === "campaign" ? "campaign_id" : level === "adset" ? "adset_id" : "ad_id";
  const nameKey = level === "campaign" ? "campaign_name" : level === "adset" ? "adset_name" : "ad_name";
  return {
    date: r.snapshot_date,
    [idKey]: r.entity_id,
    [nameKey]: r.name,
    // Everything below campaign level is parented to its campaign here.
    campaign_id: level === "campaign" ? r.entity_id : r.parent_id,
    status: r.effective_status,
    spend: n(r.spend),
    impressions: n(r.impressions),
    clicks: n(r.clicks),
    link_clicks: n(r.link_clicks),
    landing_page_views: n(r.landing_page_views),
    ctr: r.ctr,
    cpm: r.cpm,
    frequency: r.frequency,
    results: n(r.results),
    cost_per_result: r.cpa,
    hook_rate: r.hook_rate,
    hold_rate: r.hold_rate,
    video_plays: n(r.video_plays),
    video_p25: n(r.video_p25),
    video_p75: n(r.video_p75),
    thruplays: n(r.thruplays),
    lpv_rate: r.lpv_rate,
    share_of_spend: r.spend_share,
    daily_budget: r.daily_budget,
    purchases: null,
    purchase_value: null,
    roas: null,
  };
}

/** Day-by-day account rows. */
export async function adaAccountPerformance(client: AdaClient, days: number): Promise<string> {
  if (!client.adAccountId) return JSON.stringify({ error: "client has no ad account" });
  const rows = await fetchSnapshots(client.adAccountId, "account", daysAgoISO(days));
  return JSON.stringify(rows.map(toAccountDaily));
}

/** Day-by-day rows for one level. */
export async function adaEntityPerformance(
  client: AdaClient,
  level: EntityLevel,
  days: number,
  filters: { campaignId?: string; adsetId?: string } = {},
): Promise<string> {
  if (!client.adAccountId) return JSON.stringify({ error: "client has no ad account" });
  const rows = await fetchSnapshots(client.adAccountId, level, daysAgoISO(days), filters);
  return JSON.stringify(rows.map((r) => toEntityDaily(r, level)));
}

/**
 * Rolled-up totals per entity, the equivalent of the get_*_summary RPCs.
 * Rates are recomputed from the totals rather than averaged, because the mean
 * of daily CTRs is not the CTR of the period.
 */
export async function adaEntitySummary(
  client: AdaClient,
  level: EntityLevel,
  days: number,
  filters: { campaignId?: string; adsetId?: string } = {},
): Promise<string> {
  if (!client.adAccountId) return JSON.stringify({ error: "client has no ad account" });
  const rows = await fetchSnapshots(client.adAccountId, level, daysAgoISO(days), filters);

  const byEntity = new Map<string, SnapshotRow[]>();
  for (const r of rows) {
    const list = byEntity.get(r.entity_id);
    if (list) list.push(r);
    else byEntity.set(r.entity_id, [r]);
  }

  const out = [...byEntity.values()].map((group) => {
    const sum = (f: (r: SnapshotRow) => number) => group.reduce((a, r) => a + f(r), 0);
    const spend = sum((r) => n(r.spend));
    const impressions = sum((r) => n(r.impressions));
    const clicks = sum((r) => n(r.clicks));
    const linkClicks = sum((r) => n(r.link_clicks));
    const lpv = sum((r) => n(r.landing_page_views));
    const results = sum((r) => n(r.results));
    const plays = sum((r) => n(r.video_plays));
    const thruplays = sum((r) => n(r.thruplays));
    // Newest row carries the current name and status.
    const latest = group.reduce((a, b) => (b.snapshot_date > a.snapshot_date ? b : a));

    const idKey = level === "campaign" ? "campaign_id" : level === "adset" ? "adset_id" : "ad_id";
    const nameKey =
      level === "campaign" ? "campaign_name" : level === "adset" ? "adset_name" : "ad_name";

    return {
      [idKey]: latest.entity_id,
      [nameKey]: latest.name,
      campaign_id: level === "campaign" ? latest.entity_id : latest.parent_id,
      status: latest.effective_status,
      days: group.length,
      spend,
      impressions,
      clicks,
      link_clicks: linkClicks,
      landing_page_views: lpv,
      results,
      cost_per_result: results > 0 ? spend / results : null,
      ctr: impressions > 0 ? clicks / impressions : null,
      cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
      cpc: clicks > 0 ? spend / clicks : null,
      lpv_rate: linkClicks > 0 ? lpv / linkClicks : null,
      hook_rate: impressions > 0 ? plays / impressions : null,
      hold_rate: impressions > 0 ? thruplays / impressions : null,
      purchases: null,
      purchase_value: null,
      roas: null,
    };
  });

  out.sort((a, b) => Number(b.spend) - Number(a.spend));
  return JSON.stringify(out);
}

/**
 * A short note appended to Ada-customer answers' data, so the model knows what
 * it does and does not have. Guard stores performance, not creative assets, so
 * transcripts and creative bodies are genuinely absent until the Ada-side
 * creative table exists.
 */
export const ADA_SOURCE_NOTE =
  "Source: Ada Guard snapshots (this customer's own connected account, refreshed 3x/day). " +
  "Revenue and ROAS are unavailable for lead-gen accounts. Ad-to-ad-set linkage is not " +
  "stored; ads roll up to their campaign.";
