/**
 * Loop 1 — the agency morning brief (media-buyer vision, board card 81).
 *
 * Every weekday morning, one Slack message covering the pilot clients:
 * yesterday's numbers WITH their meaning (band → target → honest absence),
 * the ad-level movers worth attention, what's new, and — before any of it —
 * the honesty gate: a day that cannot be verified is never quoted as fact.
 *
 * Design: docs/factory/day-2026-08-06/loop1-detection-design.md (tinkers repo,
 * mirrored under dai/docs/specs/ada-loops/). The movers detector is designed
 * from first principles (materiality → surprise → persistence); the existing
 * anomaly-detector.ts was evaluated against that spec and kept only as an
 * account-level supplement (it cannot see ads and ranks by sigma, not money).
 *
 * Multi-account clients: a pilot code expands to its own clients row plus all
 * active rows whose parent_code points at it (Press London = PL + PL3). One
 * client section, one labelled block per ad account — a silent single-account
 * read is the named failure mode this structure makes impossible.
 *
 * "Yesterday" is the ACCOUNT's local day (clients.timezone), never the server
 * day. Currency is per account (clients.currency), never hardcoded.
 */

import { getSupabase } from '../integrations/supabase.js';
import { getDaiSupabase } from '../integrations/dai-supabase.js';
import { getDedicatedBotClient } from '../slack/dedicated-bots.js';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import {
  composeWhy,
  findOnset,
  type WhyResult,
} from './why-clause.js';
import {
  judgeSafely,
  selfCheckLine,
  type JudgeVerdict,
} from './daniel-judge.js';
import {
  evaluateLaunches,
  type LaunchVerdict,
  type WatchInput,
} from './launch-verdicts.js';
import {
  applyWalkOutcomes,
  walkAdInsights,
  type LedgerInsight,
  type WalkedInsight,
} from './ledger-walker.js';

// v1 pilots (Daniel, 2026-08-06). Top-level codes; children join via parent_code.
export const PILOT_CLIENTS = ['BFM', 'PL'];

// #ada — Ada's bot is already a member (same default as ready-to-upload-check).
const DEFAULT_CHANNEL = 'C0AHX94CBF0';

const HISTORY_DAYS = 15;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClientRow {
  id: string;
  code: string;
  name: string;
  ad_account_id: string | null;
  timezone: string | null;
  currency: string | null;
  parent_code: string | null;
  account_label: string | null;
  goal_bands: GoalBands | null;
}

interface GoalBands {
  metric?: string;
  currency?: string;
  dream?: number;
  happy?: number;
  nervous?: number;
  kill?: number;
  source?: string;
}

interface AccountDay {
  date: string;
  spend: number;
  purchases: number;
  purchase_value: number | null;
  roas: number | null;
  results: number | null;
  cost_per_result: number | null;
  leads: number | null;
  fetched_at: string | null;
}

interface AdDay {
  date: string;
  ad_id: string;
  ad_name: string | null;
  adset_id: string | null;
  campaign_id: string | null;
  spend: number;
  impressions: number;
  link_clicks: number;
  hook_rate: number | null;
  frequency: number | null;
  content_views: number;
  purchases: number;
  results: number | null;
}

interface ConfigTargets {
  kpi_primary?: string;
  targets?: Record<string, number>;
  category_targets?: Record<
    string,
    { name?: string; targets?: Record<string, number> }
  >;
  category_parsing?: {
    rules?: Array<{
      category: string;
      patterns?: string[];
      match_in?: string[];
    }>;
    default_category?: string;
  };
}

export interface Mover {
  adId: string;
  adName: string;
  kind: 'cpa_shift' | 'zero_results_on_spend' | 'spend_share_shift';
  line: string;
  spendAtStake: number;
  score: number;
  evidence: Record<string, unknown>;
  why?: WhyResult;
}

export interface AccountBrief {
  clientRow: ClientRow;
  status: 'verified' | 'unverified' | 'dormant';
  yesterday: string; // account-local date string
  lines: string[];
  movers: Mover[];
  newAds: Array<{ adId: string; adName: string; spend: number; results: number }>;
  watchVerdicts: LaunchVerdict[];
  /** Prior days' ad-level claims, re-checked against this reporting day. */
  followUps: WalkedInsight[];
  day?: AccountDay;
  trailing?: AccountDay[];
}

export interface AgencyBriefResult {
  text: string;
  accounts: AccountBrief[];
  posted: boolean;
  channel: string | null;
  insightsWritten: number;
  judge: JudgeVerdict | null;
}

// ---------------------------------------------------------------------------
// Date + money helpers (account-local, per-currency — the two standing traps)
// ---------------------------------------------------------------------------

function localDateStr(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** The account's local "yesterday" as YYYY-MM-DD. */
export function accountYesterday(timeZone: string, now: Date = new Date()): string {
  return localDateStr(new Date(now.getTime() - 24 * 3600 * 1000), timeZone);
}

function isWeekendDate(dateStr: string): boolean {
  const day = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/** '2026-08-05' → 'Wed Aug 5'. Any line touching more than one day names the
 * days explicitly — relative words ("yesterday") get ambiguous across briefs. */
function dayLabel(dateStr: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${dateStr}T12:00:00Z`));
}

function money(value: number, currency: string, decimals = 0): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  } catch {
    return `${value.toFixed(decimals)} ${currency}`;
  }
}

// ---------------------------------------------------------------------------
// Data access (shared warehouse)
// ---------------------------------------------------------------------------

/** Pilot code → its clients row + all active children (parent_code). */
export async function fetchClientGroup(code: string): Promise<ClientRow[]> {
  const { data, error } = await getSupabase()
    .from('clients')
    .select(
      'id, code, name, ad_account_id, timezone, currency, parent_code, account_label, goal_bands',
    )
    .or(`code.eq.${code},parent_code.eq.${code}`)
    .eq('is_active', true)
    .order('code');
  if (error) throw new Error(`clients fetch failed for ${code}: ${error.message}`);
  return (data ?? []) as ClientRow[];
}

async function fetchAccountDaily(clientId: string, since: string): Promise<AccountDay[]> {
  const { data, error } = await getSupabase()
    .from('account_daily')
    .select(
      'date, spend, purchases, purchase_value, roas, results, cost_per_result, leads, fetched_at',
    )
    .eq('client_id', clientId)
    .gte('date', since)
    .order('date', { ascending: true });
  if (error) throw new Error(`account_daily fetch failed: ${error.message}`);
  return (data ?? []).map((r: Record<string, unknown>) => ({
    date: String(r.date),
    spend: Number(r.spend) || 0,
    purchases: Number(r.purchases) || 0,
    purchase_value: r.purchase_value === null ? null : Number(r.purchase_value),
    roas: r.roas === null ? null : Number(r.roas),
    results: r.results === null ? null : Number(r.results),
    cost_per_result: r.cost_per_result === null ? null : Number(r.cost_per_result),
    leads: r.leads === null ? null : Number(r.leads),
    fetched_at: r.fetched_at ? String(r.fetched_at) : null,
  }));
}

/**
 * PostgREST caps a response at 1000 rows regardless of .limit() — BFM alone
 * has ~2800 ad-days in the window. Page explicitly; silent truncation here
 * would quietly blind the movers detector to the newest days.
 */
export async function fetchAdDaily(clientId: string, since: string): Promise<AdDay[]> {
  const pageSize = 1000;
  const raw: Record<string, unknown>[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await getSupabase()
      .from('ad_daily')
      .select(
        'date, ad_id, ad_name, adset_id, campaign_id, spend, impressions, link_clicks, hook_rate, frequency, content_views, purchases, results',
      )
      .eq('client_id', clientId)
      .gte('date', since)
      .order('date', { ascending: true })
      .order('ad_id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`ad_daily fetch failed: ${error.message}`);
    raw.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return raw.map((r: Record<string, unknown>) => ({
    date: String(r.date),
    ad_id: String(r.ad_id),
    ad_name: r.ad_name ? String(r.ad_name) : null,
    adset_id: r.adset_id ? String(r.adset_id) : null,
    campaign_id: r.campaign_id ? String(r.campaign_id) : null,
    spend: Number(r.spend) || 0,
    impressions: Number(r.impressions) || 0,
    link_clicks: Number(r.link_clicks) || 0,
    hook_rate: r.hook_rate === null ? null : Number(r.hook_rate),
    frequency: r.frequency === null ? null : Number(r.frequency),
    content_views: Number(r.content_views) || 0,
    purchases: Number(r.purchases) || 0,
    results: r.results === null ? null : Number(r.results),
  }));
}

/** Change ledger around the reporting day, for the why-clause join. */
async function fetchAccountChanges(
  clientId: string,
  sinceIso: string,
): Promise<import('./why-clause.js').ChangeEvent[]> {
  const { data } = await getSupabase()
    .from('account_changes')
    .select('event_time, event_type, object_type, object_id, object_name, actor_name')
    .eq('client_id', clientId)
    .gte('event_time', sinceIso)
    .order('event_time', { ascending: false })
    .limit(200);
  return (data ?? []) as import('./why-clause.js').ChangeEvent[];
}

/** Account-level country/platform spend-mix shifts, yesterday vs trailing. */
async function fetchMixShifts(
  clientId: string,
  yesterday: string,
  since: string,
): Promise<import('./why-clause.js').MixShift[]> {
  // Review fix 2026-08-08: PostgREST caps at 1000 rows and an unordered query
  // returned an arbitrary (oldest-first) slice — fabrication risk. Mix shifts
  // only need yesterday vs its trailing week, ordered newest-first, paged.
  void since;
  const mixSince = new Date(`${yesterday}T12:00:00Z`);
  mixSince.setUTCDate(mixSince.getUTCDate() - 8);
  const mixSinceStr = mixSince.toISOString().slice(0, 10);
  const pageSize = 1000;
  const raw: unknown[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await getSupabase()
      .from('breakdowns')
      .select('date, breakdown_type, breakdown_value, spend')
      .eq('client_id', clientId)
      .eq('entity_type', 'account')
      .in('breakdown_type', ['country', 'platform'])
      .gte('date', mixSinceStr)
      .lte('date', yesterday)
      .order('date', { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) return [];
    raw.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  const rows = raw as Array<{
    date: string;
    breakdown_type: string;
    breakdown_value: string;
    spend: number;
  }>;
  const shifts: import('./why-clause.js').MixShift[] = [];
  for (const dim of ['country', 'platform']) {
    const dimRows = rows.filter((r) => r.breakdown_type === dim);
    const yRows = dimRows.filter((r) => r.date === yesterday);
    const tRows = dimRows.filter((r) => r.date < yesterday);
    const yTotal = yRows.reduce((s, r) => s + (Number(r.spend) || 0), 0);
    const tTotal = tRows.reduce((s, r) => s + (Number(r.spend) || 0), 0);
    if (yTotal <= 0 || tTotal <= 0) continue;
    const values = new Set(dimRows.map((r) => r.breakdown_value));
    for (const v of values) {
      const yShare = yRows.filter((r) => r.breakdown_value === v).reduce((s, r) => s + (Number(r.spend) || 0), 0) / yTotal;
      const tShare = tRows.filter((r) => r.breakdown_value === v).reduce((s, r) => s + (Number(r.spend) || 0), 0) / tTotal;
      if (Math.abs(yShare - tShare) > 0.08) {
        shifts.push({ dimension: dim, value: v, fromShare: tShare, toShare: yShare });
      }
    }
  }
  return shifts.sort(
    (a, b) => Math.abs(b.toShare - b.fromShare) - Math.abs(a.toShare - a.fromShare),
  );
}

export async function fetchConfigTargets(code: string): Promise<ConfigTargets | null> {
  const { data } = await getSupabase()
    .from('client_configs')
    .select('config')
    .eq('client_code', code)
    .maybeSingle();
  return (data?.config as ConfigTargets) ?? null;
}

// ---------------------------------------------------------------------------
// The honesty gate
// ---------------------------------------------------------------------------

/**
 * Yesterday is verified iff its row exists AND was fetched after the
 * account-local day closed (the fetch's local date is later than yesterday).
 * No row anywhere near now + no recent spend → dormant, which is a fact
 * ("no delivery"), not a gap.
 */
export function gateYesterday(
  days: AccountDay[],
  yesterday: string,
  timeZone: string,
): 'verified' | 'unverified' | 'dormant' {
  const row = days.find((d) => d.date === yesterday);
  if (row) {
    if (!row.fetched_at) return 'unverified';
    const fetchedLocalDate = localDateStr(new Date(row.fetched_at), timeZone);
    return fetchedLocalDate > yesterday ? 'verified' : 'unverified';
  }
  // No yesterday row. Zero-spend ROWS are evidence of no delivery; the total
  // absence of data is a verification gap, never a delivery claim.
  if (days.length === 0) return 'unverified';
  const anySpend = days.some((d) => d.spend > 0);
  return anySpend ? 'unverified' : 'dormant';
}

// ---------------------------------------------------------------------------
// The yesterday line (number AND meaning, always)
// ---------------------------------------------------------------------------

function meaningForCpa(
  cpa: number,
  currency: string,
  bands: GoalBands | null,
  config: ConfigTargets | null,
): string {
  if (bands && (bands.happy ?? bands.nervous ?? bands.kill) !== undefined) {
    const { dream, happy, nervous, kill } = bands;
    if (kill !== undefined && cpa >= kill) {
      return `past your ${money(kill, currency)} kill line`;
    }
    if (nervous !== undefined && cpa >= nervous) {
      return `in your nervous band (${money(nervous, currency)}–${
        kill !== undefined ? money(kill, currency) : '…'
      })`;
    }
    if (happy !== undefined && cpa <= happy) {
      return dream !== undefined && cpa <= dream
        ? `dream territory (under ${money(dream, currency)})`
        : `inside your happy band (under ${money(happy, currency)})`;
    }
    if (happy !== undefined) {
      return `above your ${money(happy, currency)} happy band`;
    }
  }
  const target = config?.targets?.cpa ?? config?.targets?.cost_per_result;
  if (target) {
    const diffPct = ((cpa - target) / target) * 100;
    if (Math.abs(diffPct) <= 5) return `right on your ${money(target, currency, 2)} target`;
    return diffPct > 0
      ? `${Math.round(diffPct)}% over your ${money(target, currency, 2)} target`
      : `${Math.round(-diffPct)}% under your ${money(target, currency, 2)} target`;
  }
  return 'no target on file — goal-bands slot open';
}

function composeYesterdayLine(
  day: AccountDay,
  trailing: AccountDay[],
  currency: string,
  bands: GoalBands | null,
  config: ConfigTargets | null,
): string {
  const parts: string[] = [];
  parts.push(`${dayLabel(day.date)}: ${money(day.spend, currency)} spent`);
  parts.push(`${day.purchases} purchase${day.purchases === 1 ? '' : 's'}`);

  if (day.purchases >= 3 && day.spend > 0) {
    const cpa = day.spend / day.purchases;
    parts.push(`${money(cpa, currency, 2)} CPA — ${meaningForCpa(cpa, currency, bands, config)}`);
  } else if (day.spend > 0) {
    parts.push('too few results for a CPA verdict');
  }
  if (day.roas !== null && day.roas > 0) {
    parts.push(`ROAS ${day.roas.toFixed(2)}`);
  }

  // Context: the account against itself.
  const prior = trailing.filter((d) => d.date < day.date && d.spend > 0).slice(-7);
  if (prior.length >= 3) {
    const avgSpend = prior.reduce((s, d) => s + d.spend, 0) / prior.length;
    const totSpend = prior.reduce((s, d) => s + d.spend, 0);
    const totPurch = prior.reduce((s, d) => s + d.purchases, 0);
    const ctx: string[] = [`7d avg spend ${money(avgSpend, currency)}`];
    if (totPurch >= 3 && day.purchases >= 3) {
      ctx.push(`7d CPA ${money(totSpend / totPurch, currency, 2)}`);
    }
    parts.push(`(${ctx.join(' · ')})`);
  }
  if (isWeekendDate(day.date)) parts.push('_(a weekend day — judge against weekends)_');
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Movers — materiality → surprise → persistence (from-scratch, see design doc)
// ---------------------------------------------------------------------------

export function detectMovers(
  ads: AdDay[],
  yesterday: string,
  accountSpendYesterday: number,
  accountAvgDailySpend: number,
  currency: string,
): Mover[] {
  const yesterdayAds = ads.filter((a) => a.date === yesterday && a.spend > 0);
  if (yesterdayAds.length === 0) return [];

  const materialityFloor = Math.max(
    0.05 * accountSpendYesterday,
    0.01 * accountAvgDailySpend,
  );

  const byAd = new Map<string, AdDay[]>();
  for (const row of ads) {
    if (!byAd.has(row.ad_id)) byAd.set(row.ad_id, []);
    byAd.get(row.ad_id)!.push(row);
  }

  const movers: Mover[] = [];
  for (const yRow of yesterdayAds) {
    if (yRow.spend < materialityFloor) continue;
    const history = (byAd.get(yRow.ad_id) ?? []).filter(
      (r) => r.date < yesterday && r.spend > 0,
    );
    // New ads belong to What's-New (Loop 2), never to movers.
    if (history.length < 3) continue;

    const trail = history.slice(-7);
    const tSpend = trail.reduce((s, r) => s + r.spend, 0);
    const tPurch = trail.reduce((s, r) => s + r.purchases, 0);
    // Review fix 2026-08-08: divide by the ACCOUNT's trailing day count, not
    // the ad's own spending-day count — an intermittent ad's "usual per day"
    // must include its zero days, or the money line overstates and the share
    // direction can invert.
    const accountTrailingDays =
      new Set(ads.filter((r) => r.date < yesterday && r.spend > 0).map((r) => r.date)).size || 1;
    const tAvgSpend = tSpend / Math.min(accountTrailingDays, 7);
    const tAvgPurch = tPurch / trail.length;
    const name = yRow.ad_name ?? yRow.ad_id;

    // Signal 1: money out, nothing back — on an ad that usually converts.
    if (yRow.purchases === 0 && tAvgPurch >= 1 && yRow.spend >= materialityFloor) {
      movers.push({
        adId: yRow.ad_id,
        adName: name,
        kind: 'zero_results_on_spend',
        spendAtStake: yRow.spend,
        score: yRow.spend * 2,
        line: `"${truncate(name, 48)}" — ${money(yRow.spend, currency)} spent, 0 purchases (usually ~${tAvgPurch.toFixed(1)}/day)`,
        evidence: {
          yesterday_spend: yRow.spend,
          trailing_avg_purchases: round2(tAvgPurch),
        },
      });
      continue;
    }

    // Signal 2: CPA shift vs the ad's own trailing pooled CPA.
    if (yRow.purchases >= 3 && tPurch >= 3) {
      const yCpa = yRow.spend / yRow.purchases;
      const tCpa = tSpend / tPurch;
      const rel = (yCpa - tCpa) / tCpa;
      if (Math.abs(rel) > 0.25) {
        // Typical-variation check when enough defined daily CPAs exist.
        const dailyCpas = trail
          .filter((r) => r.purchases > 0)
          .map((r) => r.spend / r.purchases);
        let passesVariation = true;
        if (dailyCpas.length >= 4) {
          const mean = dailyCpas.reduce((s, v) => s + v, 0) / dailyCpas.length;
          const sd = Math.sqrt(
            dailyCpas.reduce((s, v) => s + (v - mean) ** 2, 0) / dailyCpas.length,
          );
          passesVariation = Math.abs(yCpa - tCpa) > 1.5 * sd;
        }
        if (passesVariation) {
          const dir = rel > 0 ? 'up' : 'down';
          movers.push({
            adId: yRow.ad_id,
            adName: name,
            kind: 'cpa_shift',
            spendAtStake: yRow.spend,
            score: yRow.spend * Math.abs(rel),
            line: `"${truncate(name, 48)}" — CPA ${money(yCpa, currency, 2)} vs ${money(tCpa, currency, 2)} usual (${dir} ${Math.round(Math.abs(rel) * 100)}%), on ${money(yRow.spend, currency)}`,
            evidence: {
              yesterday_cpa: round2(yCpa),
              trailing_cpa: round2(tCpa),
              rel_change: round2(rel),
              yesterday_spend: yRow.spend,
            },
          });
          continue;
        }
      }
    }

    // Signal 3: spend-share shift (delivery moved, big ad got bigger/smaller).
    if (accountSpendYesterday > 0 && accountAvgDailySpend > 0) {
      const yShare = yRow.spend / accountSpendYesterday;
      const tShare = tAvgSpend / accountAvgDailySpend;
      const shift = yShare - tShare;
      if (Math.abs(shift) > 0.08) {
        // Daniel's rule (2026-08-07): the currency amount leads; the share is
        // only the meaning, and only worth voicing because it changed.
        movers.push({
          adId: yRow.ad_id,
          adName: name,
          kind: 'spend_share_shift',
          spendAtStake: yRow.spend,
          score: yRow.spend * Math.abs(shift) * 4,
          line: `"${truncate(name, 48)}" — ${money(yRow.spend, currency)} vs ${money(tAvgSpend, currency)}/day usual (share of account ${Math.round(tShare * 100)}% → ${Math.round(yShare * 100)}%)`,
          evidence: {
            yesterday_spend: yRow.spend,
            trailing_avg_spend: round2(tAvgSpend),
            yesterday_share: round2(yShare),
            trailing_share: round2(tShare),
          },
        });
      }
    }
  }

  movers.sort((a, b) => b.score - a.score);
  return movers.slice(0, 3);
}

// ---------------------------------------------------------------------------
// What's new (Loop 2's detection seed; keyed on ad_id, and says so)
// ---------------------------------------------------------------------------

export async function detectNewAds(
  clientId: string,
  ads: AdDay[],
  yesterday: string,
): Promise<Array<{ adId: string; adName: string; spend: number; results: number }>> {
  const yesterdaySpenders = ads.filter((a) => a.date === yesterday && a.spend > 0);
  if (yesterdaySpenders.length === 0) return [];

  const seenBefore = new Set(
    ads.filter((a) => a.date < yesterday && a.spend > 0).map((a) => a.ad_id),
  );
  const candidates = yesterdaySpenders.filter((a) => !seenBefore.has(a.ad_id));
  if (candidates.length === 0) return [];

  // The window only covers HISTORY_DAYS — confirm against full history.
  // One cheap existence probe per candidate (bounded: candidates are few),
  // immune to the 1000-row response cap a bulk query would silently hit.
  const olderSpenders = new Set<string>();
  for (const c of candidates) {
    const { data } = await getSupabase()
      .from('ad_daily')
      .select('ad_id')
      .eq('client_id', clientId)
      .eq('ad_id', c.ad_id)
      .lt('date', yesterday)
      .gt('spend', 0)
      .limit(1);
    if (data?.length) olderSpenders.add(c.ad_id);
  }

  return candidates
    .filter((c) => !olderSpenders.has(c.ad_id))
    .map((c) => ({
      adId: c.ad_id,
      adName: c.ad_name ?? c.ad_id,
      spend: c.spend,
      results: c.purchases,
    }));
}

// ---------------------------------------------------------------------------
// PL-style category lines (client_configs.category_targets + parsing rules)
// ---------------------------------------------------------------------------

async function composeCategoryLines(
  clientId: string,
  yesterday: string,
  currency: string,
  config: ConfigTargets | null,
): Promise<string[]> {
  const rules = config?.category_parsing?.rules;
  const targets = config?.category_targets;
  if (!rules?.length || !targets) return [];

  const { data, error } = await getSupabase()
    .from('campaign_daily')
    .select('campaign_name, spend, purchases')
    .eq('client_id', clientId)
    .eq('date', yesterday)
    .limit(500);
  if (error || !data?.length) return [];

  const categorize = (name: string): string => {
    for (const rule of rules) {
      if ((rule.patterns ?? []).some((p) => name.includes(p))) return rule.category;
    }
    return config?.category_parsing?.default_category ?? 'default';
  };

  const agg = new Map<string, { spend: number; purchases: number }>();
  for (const row of data as Array<{ campaign_name: string | null; spend: number; purchases: number }>) {
    const cat = categorize(row.campaign_name ?? '');
    const cur = agg.get(cat) ?? { spend: 0, purchases: 0 };
    cur.spend += Number(row.spend) || 0;
    cur.purchases += Number(row.purchases) || 0;
    agg.set(cat, cur);
  }

  const lines: string[] = [];
  for (const [cat, sums] of [...agg.entries()].sort((a, b) => b[1].spend - a[1].spend)) {
    if (sums.spend < 1) continue;
    const t = targets[cat];
    const label = t?.name ?? cat;
    if (sums.purchases >= 3) {
      const cpa = sums.spend / sums.purchases;
      const target = t?.targets?.cpa_target;
      const meaning =
        target !== undefined
          ? cpa <= target
            ? `on target (${money(target, currency)})`
            : `${Math.round(((cpa - target) / target) * 100)}% over the ${money(target, currency)} target`
          : 'no category target';
      lines.push(
        `${label}: ${money(sums.spend, currency)} · ${sums.purchases} purchases · ${money(cpa, currency, 2)} CPA — ${meaning}`,
      );
    } else {
      lines.push(
        `${label}: ${money(sums.spend, currency)} · ${sums.purchases} purchase${sums.purchases === 1 ? '' : 's'} — too few for a CPA verdict`,
      );
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Insight ledger writes (DAI Supabase; the brief's claims become records)
// ---------------------------------------------------------------------------

async function writeInsights(briefs: AccountBrief[]): Promise<number> {
  const rows: Array<Record<string, unknown>> = [];
  for (const b of briefs) {
    const base = {
      client_code: b.clientRow.code,
      ad_account_id: b.clientRow.ad_account_id,
      source: 'loop-1-brief',
    };
    if (b.status === 'verified' && b.day) {
      const cpa = b.day.purchases >= 3 ? b.day.spend / b.day.purchases : null;
      rows.push({
        ...base,
        entity_level: 'account',
        entity_id: b.clientRow.ad_account_id,
        entity_name: b.clientRow.name,
        kind: 'daily-observation',
        claim: `${b.yesterday}: ${b.lines[0] ?? 'reported'}`,
        evidence: {
          date: b.yesterday,
          spend: b.day.spend,
          purchases: b.day.purchases,
          purchase_value: b.day.purchase_value,
          roas: b.day.roas,
          cpa,
        },
        recheck: {
          metric: 'account_day',
          scope: { client_code: b.clientRow.code, date: b.yesterday },
          note: 'restate check: re-read account_daily for this date and compare',
        },
      });
    }
    for (const m of b.movers) {
      rows.push({
        ...base,
        entity_level: 'ad',
        entity_id: m.adId,
        entity_name: m.adName,
        kind: 'daily-observation',
        claim: m.why ? `${m.line} | why: ${m.why.text}` : m.line,
        evidence: {
          date: b.yesterday,
          kind: m.kind,
          ...m.evidence,
          ...(m.why ? { cause_class: m.why.causeClass, why_evidence: m.why.evidence } : {}),
        },
        recheck: {
          metric: m.kind,
          scope: { client_code: b.clientRow.code, ad_id: m.adId },
          note: m.why
            ? `is the diagnosed cause (${m.why.causeClass}) still present the next day?`
            : 'does the same signal fire on the next day? escalate on second day',
        },
      });
    }
    // The intraday pulse may already have opened a watch for these ads the
    // afternoon they first spent — one watch per ad, whichever path was first.
    let alreadyWatched = new Set<string>();
    if (b.newAds.length) {
      const { data: watchRows } = await getDaiSupabase()
        .from('ada_insights')
        .select('entity_id')
        .eq('client_code', b.clientRow.code)
        .eq('kind', 'launch-watch')
        .in('entity_id', b.newAds.map((n) => n.adId));
      alreadyWatched = new Set(
        ((watchRows ?? []) as Array<{ entity_id: string | null }>)
          .map((r) => r.entity_id)
          .filter((id): id is string => !!id),
      );
    }
    for (const n of b.newAds) {
      if (alreadyWatched.has(n.adId)) continue;
      rows.push({
        ...base,
        entity_level: 'ad',
        entity_id: n.adId,
        entity_name: n.adName,
        kind: 'launch-watch',
        claim: `First spend ${b.yesterday}: "${truncate(n.adName, 60)}" (${n.spend.toFixed(2)}, ${n.results} purchases). Verdicts due at 24h/72h/7d.`,
        evidence: { first_spend_date: b.yesterday, spend: n.spend, results: n.results },
        recheck: {
          metric: 'launch_watch',
          scope: { client_code: b.clientRow.code, ad_id: n.adId },
          checkpoints: [1, 3, 7],
        },
      });
    }
  }
  if (!rows.length) return 0;
  const { error } = await getDaiSupabase().from('ada_insights').insert(rows);
  if (error) {
    // Fail loud in the log, but a ledger hiccup must not kill the brief.
    logger.error({ err: error.message }, 'ada_insights write failed');
    return 0;
  }
  return rows.length;
}

/** Open launch watches for a client (Loop 2's verdict half reads these). */
async function fetchActiveWatches(clientCode: string): Promise<WatchInput[]> {
  const { data } = await getDaiSupabase()
    .from('ada_insights')
    .select('id, entity_id, entity_name, evidence')
    .eq('client_code', clientCode)
    .eq('kind', 'launch-watch')
    .eq('status', 'active');
  return ((data ?? []) as Array<{
    id: string;
    entity_id: string | null;
    entity_name: string | null;
    evidence: { first_spend_date?: string } | null;
  }>)
    .filter((r) => r.entity_id && r.evidence?.first_spend_date)
    .map((r) => ({
      insightId: r.id,
      adId: r.entity_id!,
      adName: r.entity_name ?? r.entity_id!,
      firstSpendDate: r.evidence!.first_spend_date!,
    }));
}

/** Live ad-level claims from earlier mornings — the re-check walker's queue. */
async function fetchActiveAdObservations(clientCode: string): Promise<LedgerInsight[]> {
  const { data } = await getDaiSupabase()
    .from('ada_insights')
    .select('id, entity_id, entity_name, evidence, derived_at')
    .eq('client_code', clientCode)
    .eq('entity_level', 'ad')
    .eq('kind', 'daily-observation')
    .eq('status', 'active')
    .gte('derived_at', new Date(Date.now() - 10 * 86400_000).toISOString())
    .order('derived_at', { ascending: false })
    .limit(200);
  return ((data ?? []) as Array<{
    id: string;
    entity_id: string | null;
    entity_name: string | null;
    evidence: Record<string, unknown> | null;
    derived_at: string;
  }>)
    .filter((r) => r.entity_id && r.evidence)
    .map((r) => ({
      id: r.id,
      entity_id: r.entity_id!,
      entity_name: r.entity_name,
      evidence: r.evidence!,
      derived_at: r.derived_at,
    }));
}

/** Verdicts append to their watch's trajectory; final verdicts close it. */
async function updateWatchRows(verdicts: LaunchVerdict[], asOf: string): Promise<void> {
  const dai = getDaiSupabase();
  for (const v of verdicts) {
    const { data } = await dai
      .from('ada_insights')
      .select('trajectory')
      .eq('id', v.insightId)
      .maybeSingle();
    const trajectory = Array.isArray(data?.trajectory) ? (data!.trajectory as unknown[]) : [];
    trajectory.push({ date: asOf, verdict: v.kind, line: v.line });
    const { error } = await dai
      .from('ada_insights')
      .update({
        trajectory,
        last_checked_at: new Date().toISOString(),
        status: v.isFinal ? 'resolved' : 'active',
        ...(v.isFinal ? { resolved_at: new Date().toISOString() } : {}),
      })
      .eq('id', v.insightId);
    if (error) logger.error({ err: error.message, id: v.insightId }, 'watch update failed');
  }
}

/**
 * Movers already on the ledger from earlier days → persistence phrasing.
 * Two distinct cases (Daniel's question, 2026-08-07): the SAME signal firing
 * again ("second day running") vs a DIFFERENT signal on an ad that was
 * already worth watching — in which case yesterday's actual finding is quoted
 * so the multi-day story reads itself.
 */
async function markPersistence(briefs: AccountBrief[]): Promise<void> {
  for (const b of briefs) {
    if (!b.movers.length) continue;
    const { data } = await getDaiSupabase()
      .from('ada_insights')
      .select('entity_id, claim, evidence, derived_at')
      .eq('client_code', b.clientRow.code)
      .eq('entity_level', 'ad')
      .eq('kind', 'daily-observation')
      .eq('source', 'loop-1-brief') // pulse dedupe rows are events, not flags
      .in('entity_id', b.movers.map((m) => m.adId))
      .gte('derived_at', new Date(Date.now() - 3 * 86400_000).toISOString())
      // Rows written within the last 12h are this morning's own run (or a
      // same-day re-run) — yesterday's genuine signals are ~24h old.
      .lt('derived_at', new Date(Date.now() - 12 * 3600_000).toISOString())
      .order('derived_at', { ascending: false });
    const priorByAd = new Map<
      string,
      Array<{ claim: string; kind?: string; date?: string }>
    >();
    for (const r of (data ?? []) as Array<{
      entity_id: string;
      claim: string;
      evidence: { kind?: string; date?: string } | null;
    }>) {
      if (!priorByAd.has(r.entity_id)) priorByAd.set(r.entity_id, []);
      priorByAd
        .get(r.entity_id)!
        .push({ claim: r.claim, kind: r.evidence?.kind, date: r.evidence?.date });
    }
    for (const m of b.movers) {
      // Only rows about EARLIER data days count — a stored claim about the
      // same reporting day (same-day re-run, or an account whose day hasn't
      // rolled) is this signal, not a prior one.
      const prior = (priorByAd.get(m.adId) ?? []).filter(
        (p) => p.date && p.date < b.yesterday,
      );
      if (!prior.length) continue;
      // Claims start with the ad name and may carry their own why/persistence
      // suffixes — strip all of that; the reader is already on this ad's line.
      const latest = prior[0]!;
      const prev = truncate(
        latest.claim
          .replace(/^"[^"]*" — /, '')
          .split(' | why:')[0]!
          .split(' — _')[0]!,
        90,
      );
      const when = dayLabel(latest.date!);
      m.line += prior.some((p) => p.kind === m.kind)
        ? ` — _same signal on ${when} too: ${prev}_`
        : ` — _this ad was also flagged for ${when}: ${prev}_`;
    }
  }
}

// ---------------------------------------------------------------------------
// Composition + posting
// ---------------------------------------------------------------------------

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function briefAccount(row: ClientRow, now: Date): Promise<AccountBrief> {
  const tz = row.timezone ?? 'Europe/Berlin';
  const currency = row.currency ?? 'EUR';
  const yesterday = accountYesterday(tz, now);
  const since = localDateStr(new Date(now.getTime() - HISTORY_DAYS * 86400_000), tz);

  const days = await fetchAccountDaily(row.id, since);
  const status = gateYesterday(days, yesterday, tz);
  const brief: AccountBrief = {
    clientRow: row,
    status,
    yesterday,
    lines: [],
    movers: [],
    newAds: [],
    watchVerdicts: [],
    followUps: [],
  };

  if (status === 'dormant') {
    const lastRow = days[days.length - 1];
    brief.lines.push(
      `No delivery recorded in the last ${HISTORY_DAYS}+ days (last data row ${lastRow?.date ?? 'n/a'}).`,
    );
    return brief;
  }

  if (status === 'unverified') {
    const lastVerified = [...days]
      .reverse()
      .find((d) => d.fetched_at && localDateStr(new Date(d.fetched_at), tz) > d.date);
    brief.lines.push(
      `⚠️ Could not verify yesterday (${yesterday}) — data sync incomplete.` +
        (lastVerified
          ? ` Freshest verified day is ${lastVerified.date}: ${money(lastVerified.spend, currency)} spent, ${lastVerified.purchases} purchases.`
          : ' No verified day in the window.'),
    );
    return brief;
  }

  const day = days.find((d) => d.date === yesterday)!;
  brief.day = day;
  brief.trailing = days;

  const config = await fetchConfigTargets(row.code);
  brief.lines.push(
    composeYesterdayLine(day, days, currency, row.goal_bands, config),
  );

  // Category view (PL-style), when the client's config defines one.
  const catLines = await composeCategoryLines(row.id, yesterday, currency, config);
  for (const l of catLines) brief.lines.push(`  · ${l}`);

  if (day.spend > 0) {
    const ads = await fetchAdDaily(row.id, since);
    const prior = days.filter((d) => d.date < yesterday && d.spend > 0).slice(-7);
    const avgDaily = prior.length
      ? prior.reduce((s, d) => s + d.spend, 0) / prior.length
      : day.spend;
    brief.movers = detectMovers(ads, yesterday, day.spend, avgDaily, currency);
    brief.newAds = await detectNewAds(row.id, ads, yesterday);

    // Loop 2's verdict half: evaluate the open launch watches, evidence-based.
    const watches = await fetchActiveWatches(row.code);
    if (watches.length) {
      const priorSpend = prior.reduce((s, d) => s + d.spend, 0);
      const priorPurch = prior.reduce((s, d) => s + d.purchases, 0);
      brief.watchVerdicts = evaluateLaunches({
        watches,
        ads,
        yesterday,
        accountSpendYesterday: day.spend,
        trailingAvgDailySpend: avgDaily,
        accountTrailingCpa: priorPurch >= 3 ? priorSpend / priorPurch : null,
        expectedCpa: row.goal_bands?.happy ?? config?.targets?.cpa ?? null,
        expectedCpaLabel:
          row.goal_bands?.happy !== undefined && row.goal_bands?.happy !== null
            ? 'your happy band'
            : 'your target',
        currency,
        // Ad set spend floors are not in the warehouse — unknown, and the
        // module phrases delivery lines neutrally because of it.
        flooredAdsetIds: undefined,
        dayLabel,
      });
    }

    // Loop 3's ledger walker: yesterday's claims get closed out, not dropped.
    const openObservations = await fetchActiveAdObservations(row.code);
    if (openObservations.length) {
      brief.followUps = walkAdInsights({
        insights: openObservations,
        ads,
        yesterday,
        accountSpendYesterday: day.spend,
        trailingAvgDailySpend: avgDaily,
        currency,
        todaysMoverAdIds: new Set(brief.movers.map((m) => m.adId)),
        dayLabel,
      });
    }

    // The why-clause: each mover carries its diagnosis (Loop 3, slice 1).
    if (brief.movers.length) {
      const dayBefore = new Date(`${yesterday}T00:00:00Z`);
      dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
      const [changes, mixShifts] = await Promise.all([
        fetchAccountChanges(row.id, dayBefore.toISOString()),
        fetchMixShifts(row.id, yesterday, since),
      ]);
      for (const m of brief.movers) {
        const adRows = ads.filter((a) => a.ad_id === m.adId);
        const ids = new Set(
          [m.adId, adRows[0]?.adset_id, adRows[0]?.campaign_id].filter(Boolean) as string[],
        );
        const direction =
          m.kind === 'cpa_shift' && Number(m.evidence.rel_change) < 0 ? 'good' : 'bad';
        m.why = composeWhy({
          moverKind: m.kind,
          direction,
          adRows,
          peerRows: ads,
          yesterday,
          changes: changes.filter((c) => c.object_id && ids.has(c.object_id)),
          mixShifts,
          dayLabel,
        });
        // Onset: a CPA story that started before yesterday says so.
        if (m.kind === 'cpa_shift' && direction === 'bad' && m.why) {
          const trailingCpa = Number(m.evidence.trailing_cpa);
          if (trailingCpa > 0) {
            const onset = findOnset(adRows, yesterday, trailingCpa);
            if (onset.days > 1) {
              m.why.text = `building since ${dayLabel(onset.firstDate)} (${onset.days} days) — ${m.why.text}`;
            }
          }
        }
      }
    }
  }
  return brief;
}

function renderClientSection(
  pilotName: string,
  briefs: AccountBrief[],
): string {
  const multi = briefs.length > 1;
  const out: string[] = [];
  out.push(`*${pilotName}*${multi ? ` — ${briefs.length} ad accounts` : ''}`);
  for (const b of briefs) {
    const label = multi
      ? `_${b.clientRow.account_label ?? b.clientRow.name} (${b.clientRow.currency ?? '?'})_\n`
      : '';
    const head = `${label}${b.lines.join('\n')}`;
    out.push(head);
    if (b.movers.length) {
      out.push(
        [
          'Movers:',
          ...b.movers.map((m) => {
            const why = m.why
              ? `\n    ↳ why: ${m.why.text}\n    ↳ next: ${m.why.next}`
              : '';
            return `• ${m.line}${why}`;
          }),
        ].join('\n'),
      );
    }
    if (b.newAds.length) {
      const items = b.newAds
        .slice(0, 5)
        .map(
          (n) =>
            `• "${truncate(n.adName, 48)}" — first spend, ${money(n.spend, b.clientRow.currency ?? 'EUR')} · ${n.results} purchases (watch opened — verdicts as evidence arrives)`,
        );
      out.push([`New (${b.newAds.length}):`, ...items].join('\n'));
    }
    if (b.watchVerdicts.length) {
      out.push(
        [
          'Watch:',
          ...b.watchVerdicts.map((v) => `• ${v.line}\n    ↳ next: ${v.next}`),
        ].join('\n'),
      );
    }
    const followUpLines = b.followUps.filter((f) => f.line);
    if (followUpLines.length) {
      out.push(['Follow-ups:', ...followUpLines.map((f) => `• ${f.line}`)].join('\n'));
    }
  }
  return out.join('\n');
}

export interface RunOptions {
  post?: boolean;
  pilots?: string[];
  now?: Date;
  writeToLedger?: boolean;
  /** Run the simulated-Dan judge over the composed brief. Defaults to the
   * value of `post` — every real post is judged, dry runs opt in. */
  judge?: boolean;
}

export async function runAgencyMorningBrief(
  opts: RunOptions = {},
): Promise<AgencyBriefResult> {
  const pilots = opts.pilots ?? PILOT_CLIENTS;
  const now = opts.now ?? new Date();
  const writeToLedger = opts.writeToLedger ?? true;

  logger.info({ pilots }, 'Composing agency morning brief');

  const sections: string[] = [];
  const allBriefs: AccountBrief[] = [];

  for (const code of pilots) {
    // Per-account isolation (review fix 2026-08-08): one broken account or a
    // flaky query must never silence the whole brief — it gets an honest
    // error line instead.
    let group: ClientRow[] = [];
    try {
      group = await fetchClientGroup(code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, code }, 'client group fetch failed');
      sections.push(`*${code}* — ⚠️ could not load this client's accounts (${msg.slice(0, 80)})`);
      continue;
    }
    if (!group.length) {
      sections.push(`*${code}* — ⚠️ no active client rows found`);
      continue;
    }
    const top = group.find((g) => g.code === code) ?? group[0]!;
    const briefs: AccountBrief[] = [];
    for (const row of group) {
      try {
        briefs.push(await briefAccount(row, now));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg, code: row.code }, 'account brief failed');
        briefs.push({
          clientRow: row,
          status: 'unverified',
          yesterday: accountYesterday(row.timezone ?? 'Europe/Berlin', now),
          lines: [`⚠️ could not build this account's brief (${msg.slice(0, 100)}) — numbers withheld rather than guessed.`],
          movers: [],
          newAds: [],
          watchVerdicts: [],
          followUps: [],
        });
      }
    }
    allBriefs.push(...briefs);
    try {
      await markPersistence(briefs);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'persistence pass failed — lines post without repeat tags');
    }
    sections.push(renderClientSection(top.name, briefs));
  }

  const dateLine = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'Europe/Berlin',
  }).format(now);

  let text = [
    `☀️ *Agency morning brief* — ${dateLine}`,
    ...sections,
    '_Numbers are each account\'s own local day, verified against the warehouse sync before quoting. Pilot: Brain.fm + Press London._',
  ].join('\n\n');

  // The simulated-Dan judge: grade before posting; a weak brief still posts,
  // wearing its self-check. A judge failure never blocks the brief.
  let judge: JudgeVerdict | null = null;
  if (opts.judge ?? opts.post ?? false) {
    judge = await judgeSafely(text);
    if (judge) {
      const check = selfCheckLine(judge);
      if (check) text = `${text}\n\n${check}`;
      logger.info(
        { overall: judge.overall, linter: judge.linter.length },
        'Daniel-judge verdict on the brief',
      );
    }
  }

  // The post comes FIRST (review fix 2026-08-08): the brief reaching #ada is
  // the product; bookkeeping failing afterwards is a logged wound, never a
  // silent morning.
  let posted = false;
  const channel = env.AGENCY_BRIEF_CHANNEL_ID ?? DEFAULT_CHANNEL;
  if (opts.post) {
    await getDedicatedBotClient('ada').chat.postMessage({ channel, text });
    posted = true;
  }

  let insightsWritten = 0;
  try {
  if (writeToLedger) {
    insightsWritten = await writeInsights(allBriefs);
    for (const b of allBriefs) {
      if (b.watchVerdicts.length) await updateWatchRows(b.watchVerdicts, b.yesterday);
      if (b.followUps.length) await applyWalkOutcomes(b.followUps, b.yesterday);
    }
    if (judge) {
      await getDaiSupabase().from('ada_insights').insert({
        client_code: 'AGENCY',
        entity_level: 'business',
        kind: 'judge',
        claim: `Brief ${dateLine}: ${judge.overall}/10 on the Daniel bar. Unanswerable question: ${judge.daniel_question}`,
        evidence: judge as unknown as Record<string, unknown>,
        recheck: { metric: 'judge_score', note: 'does tomorrow’s brief answer this question and score higher?' },
        source: 'loop-1-brief',
      });
      insightsWritten += 1;
    }
  }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'ledger phase failed after posting — brief delivered, bookkeeping incomplete',
    );
  }
  if (posted) logger.info({ channel, insightsWritten }, 'Agency morning brief posted');

  return { text, accounts: allBriefs, posted, channel: opts.post ? channel : null, insightsWritten, judge };
}
