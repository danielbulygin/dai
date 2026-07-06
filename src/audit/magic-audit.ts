import { randomBytes } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { getSupabase } from '../integrations/supabase.js';
import { executeTool } from '../agents/tool-registry.js';
import type { ToolContext } from '../agents/tool-registry.js';
import { estimateCostUsd } from '../agents/runner.js';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import { extractJson, triageLibrary, libraryAgeBridge, type LibraryAd } from './library-triage.js';
import { buildClientKnowledgeBundle } from '../agents/client-context.js';
import {
  computeConcentration, computeFatigue, computeBudgetScatter, computeCohorts, computeCostTrend, computeDayOfWeek,
  computeConceptRoas, computeOptimizationEvents, buildProvisionalInsights, computeHookCorrection, kpiMode,
  mergeAdPreviews,
  type PackAdRow, type PackAccountRow, type AdsetConfigLite, type FatigueAd, type PlacementHookRow, type AdPreview,
} from './report-pack.js';
import { buildScorecard, buildComparisonSection, type ScorecardInputs, type ScorecardEntry } from './scorecard.js';
import {
  computePlacementBreakdown, computeAudienceBreakdown, computeTargetingSplit, computeLearningLimited,
  computeSaturation, computeCreativeDiversity, computeCohortWave, computeWhatsWorking, computeLandingPages,
  computeAccountFacts, longestStillSpendingSpan, classifyDestination, computeAccountActivity,
  type PlacementInsightRow, type DemoInsightRow, type GeoInsightRow, type TargetingSpecLite,
  type WeeklyReachRow, type LandingAdRow, type DeadUrlCheck, type ActivityEvent,
} from './report-pack-extra.js';
import { buildAccountModel, mergeAccountModel, type AccountModel, type AccountModelInputs } from './account-model.js';
import { coldBreakeven, buildColdKnowledge, type ColdRows } from './cold-source.js';
import { runColdCreativeAnalysis, type OwnLibraryScrape } from './cold-creative.js';

/**
 * Magic Audit orchestrator (master-plan B1, expanded 2026-06-11: creative /
 * funnel / competitor sections + B3 lead-insight ranking + B7 cost meter).
 *
 * Runs audit sections against a client account and writes results
 * progressively into the bmad `magic_audits` row — the report page renders
 * from that row, so sections appear as they complete (staged reveal, D5).
 *
 * Design: each section does DETERMINISTIC data pulls (Supabase aggregation /
 * Meta API / Ads Library scrape — exact numbers, zero LLM) and then at most
 * ONE Opus synthesis call that turns the structured facts into the section
 * narrative. Every LLM + Apify dollar runs through the CostMeter, which
 * enforces a hard per-audit cap (default $10) and lands in
 * magic_audits.cost_usd (B7 — COGS per audit, tracked from audit #1).
 */

export interface AuditSection {
  key: string;
  title: string;
  status: 'pending' | 'running' | 'complete' | 'error' | 'planned';
  summary?: string;
  /** A labelled "Next step:" — standard element of every report (Francis's #1 theme). */
  next_step?: string;
  data?: unknown;
  warnings?: string[];
  error?: string;
  completed_at?: string;
}

export interface AuditOptions {
  /** Hard API-cost cap for the whole audit (LLM + Apify). Default 10. */
  maxCostUsd?: number;
  /** Explicit competitor FB pages to tear down. Without these, the section
   * analyzes the client's OWN public Ads Library footprint. */
  competitorPages?: Array<{ name: string; pageId: string }>;
  /** Section keys to skip this run. */
  skipSections?: string[];
  /** Cold-path injection (self-serve stranger, no warehouse rows). Built by
   * runColdAudit (cold-audit.ts) — never construct by hand elsewhere. */
  cold?: ColdInjection;
}

/**
 * Everything the cold path resolves BEFORE entering the orchestrator: the
 * connection token, the account, the pre-built row set (buildColdRows), and
 * the lead's stated goal (the synthetic target — a stranger has no
 * client-knowledge bundle). Identity contract v2: the audit row is keyed by
 * tenant_id = the auth user's uuid; client_code stays null.
 */
export interface ColdInjection {
  userId: string;
  accessToken: string;
  adAccountId: string;
  accountName: string | null;
  currency: string;
  rows: ColdRows;
  goalMetric?: string | null;
  goalValue?: number | null;
  /** Lead-stated gross margin % (ada_leads.gross_margin_pct, 0<x<100 or null).
   * When set, the fatigue breakeven re-bases from 1.0× to 1 ÷ margin. */
  grossMarginPct?: number | null;
}

/** Sections that read warehouse tables a stranger doesn't have.
 * concept_roas/creative_diversity need angle tags from the warehouse
 * creative_analysis table — without them they render as "0% tagged" dead
 * weight (Dan, first live cold audit 2026-07-03). Future: a cold angle-tagger
 * (LLM over top ad names + creative bodies) can un-skip them.
 * creative_analysis itself now RUNS cold (cold-creative.ts, 2026-07-04):
 * media resolved live (Graph → own Ads Library fallback) + Gemini reads,
 * launched as a background task after the fast tier. */
const COLD_SKIP_SECTIONS = ['dataset_health', 'account_structure', 'concept_roas', 'creative_diversity'];

export interface LeadInsight {
  headline: string;
  detail: string;
  severity: 'risk' | 'opportunity' | 'info';
  section: string;
}

// Fast (deterministic, zero-LLM) sections run FIRST — they land in seconds,
// so the first screen already shows real findings while Opus sections cook
// (Dan 2026-07-02: speed to the first magic moment correlates with conversion).
const SECTION_ORDER: Array<Pick<AuditSection, 'key' | 'title' | 'status'>> = [
  { key: 'dataset_health', title: 'Data Foundation — pixel, CAPI & match quality', status: 'pending' },
  { key: 'account_structure', title: 'Account Structure & Spend Concentration', status: 'pending' },
  { key: 'spend_concentration', title: 'Budget Concentration & Key-Man Risk', status: 'pending' },
  { key: 'creative_fatigue', title: 'Creative Fatigue & Runway', status: 'pending' },
  { key: 'budget_scatter', title: 'Budget — spend vs return per ad', status: 'pending' },
  { key: 'creative_cohorts', title: 'Creative Cohorts — living off old creative?', status: 'pending' },
  { key: 'cost_trends', title: 'CPM & Auction Pressure', status: 'pending' },
  { key: 'timing_patterns', title: 'Day-of-Week Pattern', status: 'pending' },
  { key: 'how_you_compare', title: 'How You Compare — hook & hold vs the desk', status: 'pending' },
  { key: 'placement_breakdown', title: 'Placements — where the spend actually goes', status: 'pending' },
  { key: 'audience_breakdown', title: 'Audience Delivery — age, gender, geography', status: 'pending' },
  { key: 'saturation', title: 'Audience Saturation — how much headroom is left?', status: 'pending' },
  { key: 'concept_roas', title: 'Creative Angles — spend vs return by concept', status: 'pending' },
  { key: 'creative_diversity', title: 'Creative Diversity — how fragile is the portfolio?', status: 'pending' },
  { key: 'whats_working', title: "What's Working — the protect list", status: 'pending' },
  { key: 'optimization_events', title: 'Optimization Events — is Meta hunting the right thing?', status: 'pending' },
  { key: 'learning_limited', title: 'Learning Phase — is the structure starving Meta?', status: 'pending' },
  { key: 'targeting_split', title: 'Targeting — broad vs interests vs audiences', status: 'pending' },
  { key: 'landing_pages', title: 'Landing Pages — spend by destination + dead-URL check', status: 'pending' },
  { key: 'creative_analysis', title: 'Creative Performance & Angles', status: 'pending' },
  { key: 'funnel_read', title: 'Funnel Diagnosis', status: 'pending' },
  { key: 'account_facts', title: 'Did You Know — six months of account texture', status: 'pending' },
  { key: 'account_activity', title: "Account Activity — change history & who's working the account", status: 'pending' },
  { key: 'competitor_teardown', title: 'Ads Library Landscape', status: 'pending' },
];

const toolCtx = (clientCode: string): ToolContext => ({
  agentId: 'magic-audit',
  channelId: `internal-audit-${clientCode.toLowerCase()}`,
  userId: 'magic-audit',
  threadTs: undefined,
  clientScope: undefined,
});

// ---------------------------------------------------------------------------
// Cost meter (B7) — every dollar the audit spends, with a hard cap
// ---------------------------------------------------------------------------

class CostMeter {
  spentUsd = 0;
  readonly breakdown: Record<string, number> = {};
  constructor(readonly capUsd: number) {}

  add(label: string, usd: number): void {
    this.spentUsd += usd;
    this.breakdown[label] = (this.breakdown[label] ?? 0) + usd;
  }

  /** True when the next spend would bust the cap. */
  exhausted(): boolean {
    return this.spentUsd >= this.capUsd;
  }
}

// ---------------------------------------------------------------------------
// Opus synthesis helper — one structured-JSON call per section
// ---------------------------------------------------------------------------

const AUDIT_MODEL = 'claude-opus-4-8';

let anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!anthropic) anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return anthropic;
}

/**
 * One retry on Anthropic capacity errors (overloaded/529) after a pause.
 * A single API blip killed the LLM sections of 5 consecutive sweep audits on
 * 2026-07-02 — the deterministic tier survived, the narratives didn't.
 */
async function finalMessageWithOverloadRetry(
  params: Parameters<Anthropic['messages']['stream']>[0],
): Promise<Anthropic.Message> {
  try {
    return await getAnthropic().messages.stream(params).finalMessage();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/overloaded|529/i.test(msg)) throw err;
    logger.warn({ err: msg }, 'anthropic overloaded — retrying once in 45s');
    await new Promise((r) => setTimeout(r, 45_000));
    return await getAnthropic().messages.stream(params).finalMessage();
  }
}

async function synthesizeJson<T>(
  meter: CostMeter,
  label: string,
  system: string,
  user: string,
): Promise<T | null> {
  if (meter.exhausted()) {
    logger.warn({ label, spent: meter.spentUsd, cap: meter.capUsd }, 'audit cost cap reached — skipping synthesis');
    return null;
  }
  const final = await finalMessageWithOverloadRetry({
    model: AUDIT_MODEL,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    system: [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }],
    messages: [{ role: 'user', content: user }],
  });
  const usage = final.usage as unknown as Record<string, number>;
  meter.add(
    label,
    estimateCostUsd(AUDIT_MODEL, {
      input: final.usage.input_tokens,
      output: final.usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheCreation: usage.cache_creation_input_tokens ?? 0,
    }),
  );
  const text = final.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  try {
    return extractJson<T>(text);
  } catch (err) {
    // One repair round: big accounts occasionally yield structurally-broken JSON
    // (seen live on SS 2026-07-01). Cheaper to repair than to lose the section.
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ label, err: msg }, 'synthesis JSON parse failed — attempting one repair retry');
    if (meter.exhausted()) throw err;
    const fixed = await finalMessageWithOverloadRetry({
      model: AUDIT_MODEL,
      max_tokens: 4000,
      system: 'You repair malformed JSON. Return ONLY the corrected, complete JSON object — no markdown, no commentary, no explanation.',
      messages: [{ role: 'user', content: `This JSON is malformed (parser said: ${msg}). Repair it, preserving all content:\n${text}` }],
    });
    const rUsage = fixed.usage as unknown as Record<string, number>;
    meter.add(
      `${label}_json_repair`,
      estimateCostUsd(AUDIT_MODEL, {
        input: fixed.usage.input_tokens,
        output: fixed.usage.output_tokens,
        cacheRead: rUsage.cache_read_input_tokens ?? 0,
        cacheCreation: rUsage.cache_creation_input_tokens ?? 0,
      }),
    );
    const fixedText = fixed.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return extractJson<T>(fixedText);
  }
}

const SYNTH_SYSTEM =
  'You are a senior media buyer and creative strategist at a performance marketing agency, writing one section of a paid Meta ad-account audit for a prospective client. ' +
  'You write decisively and concretely — every claim cites a specific number, ad name, or campaign from the data given. No hedging, no generic advice, no filler. ' +
  'Numbers keep their currency/unit. If the data is thin, say what is missing rather than inventing. ' +
  'METRIC LABELING (mandatory): every metric states its source — "Meta ROAS"/"Meta CPA" for Meta-attributed numbers, "TW blended"/"TW net profit" for Triple Whale. ' +
  'NEVER use the bare word "blended" for a Meta-attributed number; when two sources disagree, show both with their labels. ' +
  'Respond with PURE JSON matching the requested schema — no markdown, no commentary.';

/**
 * Compose the per-audit synthesis system prompt: the base + this client's
 * knowledge bundle (targets/KPI config, client-scoped learnings, the client
 * intelligence file) + any data-window caveat. Phase B: an audit that judges
 * "below breakeven" without the client's real target is an overreach — every
 * synthesis now sees the same client context (progress doc §5 #3, #5, #6).
 */
export function buildSynthSystem(clientKnowledge: string, dataCaveat: string | null): string {
  const parts = [SYNTH_SYSTEM];
  if (dataCaveat) {
    parts.push(`DATA WINDOW CAUTION (state this in the section when it changes a read): ${dataCaveat}`);
  }
  if (clientKnowledge.trim()) {
    parts.push(
      '=== CLIENT CONTEXT (anchor every judgment to it) ===\n' +
      'The client\'s real targets, KPI model, and saved client-specific learnings follow. ' +
      '"Good"/"bad"/"below breakeven" only mean something relative to THIS client\'s primary KPI and target — never a generic benchmark when a real target exists. ' +
      'If the account\'s conversion events differ from an e-commerce default (app trials, leads, appointments, offsite checkout), read the funnel through THIS client\'s model, not an e-com lens.\n\n' +
      clientKnowledge,
    );
  }
  return parts.join('\n\n');
}

/**
 * Days-with-data over the audit window (pure; unit-tested). A thin window
 * silently skews every 30d number (BFM had 10/30 — progress doc §5 #4), so
 * the caveat rides the synthesis system prompt when coverage is poor.
 */
export function summarizeDataWindow(
  dates: Array<string | null | undefined>,
  windowDays = 30,
): { daysWithData: number; caveat: string | null } {
  const days = new Set<string>();
  for (const d of dates) if (d) days.add(String(d).slice(0, 10));
  const daysWithData = days.size;
  const caveat =
    daysWithData < Math.ceil(windowDays * 0.8)
      ? `only ${daysWithData} of the last ${windowDays} days have ad-level data rows — every "${windowDays}d" aggregate is really a ${daysWithData}-day read; qualify trends and averages accordingly.`
      : null;
  return { daysWithData, caveat };
}

// ---------------------------------------------------------------------------
// Supabase aggregation helpers (PostgREST silently caps at 1000 rows — page)
// ---------------------------------------------------------------------------

async function resolveClient(code: string): Promise<{ id: string; name: string; currency: string; adAccountId: string | null } | null> {
  const { data } = await getSupabase()
    .from('clients')
    .select('id, name, currency, ad_account_id')
    .ilike('code', code)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id as string,
    name: data.name as string,
    currency: (data.currency as string) ?? 'EUR',
    adAccountId: (data.ad_account_id as string) ?? null,
  };
}

async function pageAll<T>(
  table: string,
  select: string,
  apply: (q: ReturnType<ReturnType<typeof getSupabase>['from']>['select'] extends never ? never : any) => any,
  maxRows = 20_000,
): Promise<T[]> {
  const out: T[] = [];
  const page = 1000;
  for (let from = 0; from < maxRows; from += page) {
    let q = getSupabase().from(table).select(select);
    q = apply(q);
    const { data, error } = await q.range(from, from + page - 1);
    if (error) throw new Error(`${table} query failed: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < page) break;
  }
  return out;
}

const daysAgoISO = (days: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
const round2 = (v: number): number => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Section: dataset_health (B9 tool, unchanged)
// ---------------------------------------------------------------------------

async function runDatasetHealth(clientCode: string): Promise<Partial<AuditSection>> {
  const { result, isError } = await executeTool(
    'audit_dataset_health',
    { client_code: clientCode },
    toolCtx(clientCode),
  );
  if (isError) return { status: 'error', error: result.slice(0, 500) };
  const parsed = JSON.parse(result) as {
    error?: string;
    pixels?: Array<{ pixel_name: string; warnings: string[]; config: Record<string, unknown>; source_split_last_day: Record<string, unknown> }>;
  };
  if (parsed.error) return { status: 'error', error: parsed.error };
  const warnings = (parsed.pixels ?? []).flatMap((p) => p.warnings.map((w) => `${p.pixel_name}: ${w}`));
  const summary =
    warnings.length === 0
      ? `All ${parsed.pixels?.length ?? 0} pixel(s) healthy: advanced matching on, no restriction flags, CAPI + browser both firing.`
      : `${warnings.length} finding(s) in the tracking foundation — see warnings.`;
  return { status: 'complete', summary, data: parsed, warnings };
}

// ---------------------------------------------------------------------------
// Section: account_structure (unchanged)
// ---------------------------------------------------------------------------

async function runAccountStructure(clientCode: string): Promise<Partial<AuditSection>> {
  const { result, isError } = await executeTool(
    'get_campaign_summary',
    { clientCode, days: 30 },
    toolCtx(clientCode),
  );
  if (isError) return { status: 'error', error: result.slice(0, 500) };
  let campaigns: Array<Record<string, unknown>>;
  try {
    const parsed = JSON.parse(result) as unknown;
    // A tool-level {error} payload is NOT an empty account — reading it as
    // "No campaigns with spend" is how meow's real RPC error hid in the sweep.
    if (!Array.isArray(parsed) && typeof (parsed as Record<string, unknown>).error === 'string') {
      return { status: 'error', error: ((parsed as Record<string, unknown>).error as string).slice(0, 500) };
    }
    campaigns = Array.isArray(parsed)
      ? (parsed as Array<Record<string, unknown>>)
      : ((parsed as Record<string, unknown>).campaigns as Array<Record<string, unknown>> ?? []);
  } catch {
    return { status: 'error', error: 'unparseable campaign summary' };
  }
  const withSpend = campaigns
    .map((c) => ({ name: String(c.campaign_name ?? c.name ?? 'unknown'), spend: num(c.spend ?? c.total_spend) }))
    .filter((c) => c.spend > 0)
    .sort((a, b) => b.spend - a.spend);
  const total = withSpend.reduce((s, c) => s + c.spend, 0);
  const top = withSpend[0];
  const topShare = top && total > 0 ? Math.round((top.spend / total) * 100) : 0;
  const warnings: string[] = [];
  if (topShare >= 70) {
    warnings.push(`${topShare}% of 30-day spend runs through one campaign ("${top!.name}") — concentration risk.`);
  }
  if (withSpend.length === 0) warnings.push('No campaigns with spend in the last 30 days.');
  return {
    status: 'complete',
    summary: `${withSpend.length} campaigns spent in the last 30 days; top campaign carries ${topShare}% of spend.`,
    data: { total_spend_30d: Math.round(total), campaigns: withSpend.slice(0, 10) },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Section: creative_analysis — top ads by 30d spend + copy/transcripts → Opus
// ---------------------------------------------------------------------------

interface CreativeSynthesis {
  summary: string;
  winners: Array<{ ad_name: string; spend: number; key_stat: string; why: string }>;
  angle_patterns: Array<{ pattern: string; evidence: string }>;
  gaps: string[];
  warnings: string[];
}

async function runCreativeAnalysis(
  clientCode: string,
  meter: CostMeter,
  client: { id: string; name: string; currency: string },
  synthSystem: string,
): Promise<Partial<AuditSection>> {
  const since = daysAgoISO(30);
  const rows = await pageAll<Record<string, unknown>>(
    'ad_daily',
    'ad_id, ad_name, spend, impressions, clicks, link_clicks, purchases, purchase_value, results, hook_rate, thruplays, video_plays',
    (q) => q.eq('client_id', client.id).gte('date', since),
  );

  if (rows.length === 0) {
    return { status: 'error', error: 'no ad-level rows in the last 30 days' };
  }

  // Aggregate per ad
  const byAd = new Map<string, {
    ad_name: string; spend: number; impressions: number; clicks: number; link_clicks: number;
    purchases: number; purchase_value: number; results: number; hook_w: number; hook_imp: number; is_video: boolean;
  }>();
  for (const r of rows) {
    const id = String(r.ad_id);
    const a = byAd.get(id) ?? {
      ad_name: String(r.ad_name ?? id), spend: 0, impressions: 0, clicks: 0, link_clicks: 0,
      purchases: 0, purchase_value: 0, results: 0, hook_w: 0, hook_imp: 0, is_video: false,
    };
    a.spend += num(r.spend);
    a.impressions += num(r.impressions);
    a.clicks += num(r.clicks);
    a.link_clicks += num(r.link_clicks);
    a.purchases += num(r.purchases);
    a.purchase_value += num(r.purchase_value);
    a.results += num(r.results);
    if (num(r.hook_rate) > 0) {
      a.hook_w += num(r.hook_rate) * num(r.impressions);
      a.hook_imp += num(r.impressions);
    }
    if (num(r.video_plays) > 0 || num(r.thruplays) > 0) a.is_video = true;
    byAd.set(id, a);
  }

  const ads = [...byAd.entries()]
    .map(([ad_id, a]) => ({
      ad_id,
      ad_name: a.ad_name,
      spend: round2(a.spend),
      roas: a.spend > 0 ? round2(a.purchase_value / a.spend) : 0,
      purchases: a.purchases,
      results: a.results,
      ctr_link: a.impressions > 0 ? round2((a.link_clicks / a.impressions) * 100) : 0,
      hook_rate: a.hook_imp > 0 ? round2(a.hook_w / a.hook_imp) : null,
      is_video: a.is_video,
    }))
    .filter((a) => a.spend > 0)
    .sort((a, b) => b.spend - a.spend);

  const totalSpend = ads.reduce((s, a) => s + a.spend, 0);
  const videoShare = totalSpend > 0
    ? Math.round((ads.filter((a) => a.is_video).reduce((s, a) => s + a.spend, 0) / totalSpend) * 100)
    : 0;
  const top = ads.slice(0, 12);
  const topShare = totalSpend > 0
    ? Math.round((top.reduce((s, a) => s + a.spend, 0) / totalSpend) * 100)
    : 0;

  // Copy + transcript context for the top ads (creatives table, best effort)
  let copyByAdId = new Map<string, Record<string, unknown>>();
  try {
    const creatives = await pageAll<Record<string, unknown>>(
      'creatives',
      'ad_id, format, ad_type, primary_text, headline, transcript, video_duration_seconds, is_fatigued',
      (q) => q.eq('client_id', client.id).in('ad_id', top.map((a) => a.ad_id)),
      1000,
    );
    copyByAdId = new Map(creatives.map((c) => [String(c.ad_id), c]));
  } catch (err) {
    logger.warn({ err }, 'creatives lookup failed (continuing without copy)');
  }

  const topWithCopy = top.map((a) => {
    const c = copyByAdId.get(a.ad_id);
    return {
      ...a,
      format: c?.format ?? c?.ad_type ?? (a.is_video ? 'video' : 'static'),
      headline: c?.headline ? String(c.headline).slice(0, 120) : undefined,
      primary_text: c?.primary_text ? String(c.primary_text).slice(0, 220) : undefined,
      transcript_excerpt: c?.transcript ? String(c.transcript).slice(0, 350) : undefined,
      is_fatigued: c?.is_fatigued === true || undefined,
    };
  });

  const facts = {
    client: client.name,
    currency: client.currency,
    window: 'last 30 days',
    total_spend: Math.round(totalSpend),
    ads_with_spend: ads.length,
    top12_spend_share_pct: topShare,
    video_spend_share_pct: videoShare,
    top_ads: topWithCopy,
  };

  const synth = await synthesizeJson<CreativeSynthesis>(
    meter,
    'creative_analysis',
    synthSystem,
    `Account creative data (deterministic, from the Meta-synced warehouse):\n${JSON.stringify(facts, null, 1)}\n\n` +
      `Write the "Creative Performance & Angles" audit section. Schema:\n` +
      `{"summary": "2-3 sentences, must name at least one specific ad and number",` +
      `"winners": [up to 4 of {"ad_name","spend","key_stat","why"}] (key_stat like "ROAS 3.4" or "hook rate 38%", why = one sharp sentence on WHY it wins, grounded in its copy/transcript when present),` +
      `"angle_patterns": [up to 4 of {"pattern","evidence"}] (messaging/format patterns across the spend-weighted inventory),` +
      `"gaps": [up to 3 strings] (creative lanes the account is NOT running that the data suggests it should test),` +
      `"warnings": [up to 3 strings] (fatigue, concentration on one creative, weak hooks — only if the data shows it)}`,
  );

  if (!synth) {
    return {
      status: 'complete',
      summary: `${ads.length} ads spent in the last 30 days; top 12 carry ${topShare}% of spend (cost cap reached before narrative synthesis).`,
      data: { ...facts, top_ads: topWithCopy.map(({ transcript_excerpt: _t, ...rest }) => rest) },
      warnings: [],
    };
  }

  return {
    status: 'complete',
    summary: synth.summary,
    data: {
      total_spend_30d: Math.round(totalSpend),
      ads_with_spend: ads.length,
      top12_spend_share_pct: topShare,
      video_spend_share_pct: videoShare,
      currency: client.currency,
      winners: synth.winners,
      angle_patterns: synth.angle_patterns,
      gaps: synth.gaps,
    },
    warnings: synth.warnings ?? [],
  };
}

// ---------------------------------------------------------------------------
// Section: funnel_read — account_daily stages + trend → Opus
// ---------------------------------------------------------------------------

interface FunnelSynthesis {
  summary: string;
  biggest_leak: { stage: string; read: string };
  opportunities: string[];
  warnings: string[];
}

function aggregateDaily(rows: Array<Record<string, unknown>>): Record<string, number> {
  const fields = [
    'spend', 'impressions', 'clicks', 'link_clicks', 'content_views', 'add_to_carts',
    'checkouts_initiated', 'purchases', 'purchase_value', 'leads', 'complete_registrations', 'results',
  ];
  const out: Record<string, number> = {};
  for (const f of fields) out[f] = rows.reduce((s, r) => s + num(r[f]), 0);
  return out;
}

function funnelStages(t: Record<string, number>, currency: string): Array<{ stage: string; value: number; rate_from_prev: number | null }> {
  void currency;
  const chain: Array<[string, number]> = [
    ['Impressions', t.impressions ?? 0],
    ['Link clicks', t.link_clicks ?? 0],
    ['Content views', t.content_views ?? 0],
    ['Add to cart', t.add_to_carts ?? 0],
    ['Checkout initiated', t.checkouts_initiated ?? 0],
    ['Purchases', t.purchases ?? 0],
  ];
  return chain.map(([stage, value], i) => ({
    stage,
    value,
    rate_from_prev: i === 0 ? null : (chain[i - 1]![1] > 0 ? round2((value / chain[i - 1]![1]) * 100) : null),
  }));
}

async function runFunnelRead(
  clientCode: string,
  meter: CostMeter,
  client: { id: string; name: string; currency: string },
  synthSystem: string,
  rows30Override?: Array<Record<string, unknown>>,
): Promise<Partial<AuditSection>> {
  // Cold path injects the derived account rows (same columns as this select).
  const rows30 = rows30Override ?? await pageAll<Record<string, unknown>>(
    'account_daily',
    'date, spend, impressions, clicks, link_clicks, content_views, add_to_carts, checkouts_initiated, purchases, purchase_value, leads, complete_registrations, results',
    (q) => q.eq('client_id', client.id).gte('date', daysAgoISO(30)),
    200,
  );
  if (rows30.length === 0) return { status: 'error', error: 'no account-level rows in the last 30 days' };

  const last7 = rows30.filter((r) => String(r.date) >= daysAgoISO(7));
  const prior7 = rows30.filter((r) => String(r.date) >= daysAgoISO(14) && String(r.date) < daysAgoISO(7));

  const t30 = aggregateDaily(rows30);
  const t7 = aggregateDaily(last7);
  const p7 = aggregateDaily(prior7);

  const stages = funnelStages(t30, client.currency);
  const derived = {
    cpm: t30.impressions! > 0 ? round2((t30.spend! / t30.impressions!) * 1000) : null,
    ctr_link_pct: t30.impressions! > 0 ? round2((t30.link_clicks! / t30.impressions!) * 100) : null,
    cpa: t30.purchases! > 0 ? round2(t30.spend! / t30.purchases!) : null,
    roas: t30.spend! > 0 ? round2(t30.purchase_value! / t30.spend!) : null,
    aov: t30.purchases! > 0 ? round2(t30.purchase_value! / t30.purchases!) : null,
    cost_per_lead: t30.leads! > 0 ? round2(t30.spend! / t30.leads!) : null,
    cost_per_registration: t30.complete_registrations! > 0 ? round2(t30.spend! / t30.complete_registrations!) : null,
  };

  // Triple Whale blended view where wired (LA, PL) — best effort, never blocks
  let twSummary: string | undefined;
  try {
    const { result, isError } = await executeTool(
      'get_triplewhale_summary',
      { clientCode, days: 7 },
      toolCtx(clientCode),
    );
    if (!isError && !result.includes('"error"')) twSummary = result.slice(0, 1500);
  } catch {
    /* not wired for this client */
  }

  const facts = {
    client: client.name,
    currency: client.currency,
    window: 'last 30 days',
    totals_30d: { ...t30, spend: Math.round(t30.spend!) },
    derived_30d: derived,
    stages_30d: stages,
    last7_vs_prior7: {
      spend: [Math.round(t7.spend!), Math.round(p7.spend!)],
      purchases: [t7.purchases, p7.purchases],
      roas: [
        t7.spend! > 0 ? round2(t7.purchase_value! / t7.spend!) : null,
        p7.spend! > 0 ? round2(p7.purchase_value! / p7.spend!) : null,
      ],
      leads: [t7.leads, p7.leads],
    },
    triple_whale_blended: twSummary,
    benchmark_heuristics:
      'Rough DTC heuristics, label as such: link CTR 1-2% healthy; content-view/link-click 70-85% (lower = slow LP or tracking gap); ATC/content-view 8-15%; purchase/link-click 1-3%. Lead-gen and app accounts differ — judge against the account\'s own trend first.',
  };

  const synth = await synthesizeJson<FunnelSynthesis>(
    meter,
    'funnel_read',
    synthSystem,
    `Account funnel data (deterministic):\n${JSON.stringify(facts, null, 1)}\n\n` +
      `Write the "Funnel Diagnosis" audit section. Schema:\n` +
      `{"summary":"2-3 sentences with the bottom line and the headline numbers (CPA or CPL and ROAS with currency)",` +
      `"biggest_leak":{"stage":"<stage name>","read":"1-2 sentences on the weakest stage-to-stage rate and what it implies"},` +
      `"opportunities":[up to 3 strings, each concrete and tied to a number],` +
      `"warnings":[up to 2 strings — only genuine risks visible in the data]}`,
  );

  const data = {
    currency: client.currency,
    stages: stages,
    derived: derived,
    spend_30d: Math.round(t30.spend!),
    trend_7d: facts.last7_vs_prior7,
    biggest_leak: synth?.biggest_leak,
    opportunities: synth?.opportunities ?? [],
  };

  if (!synth) {
    return {
      status: 'complete',
      summary: `30-day spend ${Math.round(t30.spend!)} ${client.currency}, ${t30.purchases} purchases, ROAS ${derived.roas ?? '—'} (cost cap reached before narrative synthesis).`,
      data,
      warnings: [],
    };
  }
  return { status: 'complete', summary: synth.summary, data, warnings: synth.warnings ?? [] };
}

// ---------------------------------------------------------------------------
// Section: competitor_teardown — public Ads Library via Apify → triage → Opus
// ---------------------------------------------------------------------------

const APIFY_ACTOR = 'curious_coder~facebook-ads-library-scraper';
const APIFY_BASE = 'https://api.apify.com/v2';
const APIFY_COST_PER_AD = 0.00075;

// LibraryAd + triageLibrary + extractJson live in ./library-triage.ts (pure, unit-tested)

async function apifyScrapePage(pageId: string, count: number, meter: CostMeter): Promise<LibraryAd[]> {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error('APIFY_TOKEN not set');
  const url = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&view_all_page_id=${pageId}`;
  const startResp = await fetch(`${APIFY_BASE}/acts/${APIFY_ACTOR}/runs?token=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      urls: [{ url }],
      count,
      scrapeAdDetails: true,
      'scrapePageAds.activeStatus': 'active',
      'scrapePageAds.sortBy': 'most_recent',
      'scrapePageAds.countryCode': 'ALL',
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!startResp.ok) throw new Error(`apify run start failed: ${startResp.status}`);
  const run = ((await startResp.json()) as { data: { id: string; defaultDatasetId: string } }).data;

  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 8000));
    const st = await fetch(`${APIFY_BASE}/actor-runs/${run.id}?token=${token}`, { signal: AbortSignal.timeout(30_000) });
    const data = ((await st.json()) as { data: { status: string } }).data;
    if (data.status === 'SUCCEEDED') break;
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(data.status)) {
      throw new Error(`apify run ${data.status}`);
    }
  }
  const itemsResp = await fetch(
    `${APIFY_BASE}/datasets/${run.defaultDatasetId}/items?token=${token}&format=json&clean=true`,
    { signal: AbortSignal.timeout(60_000) },
  );
  const items = (await itemsResp.json()) as LibraryAd[];
  meter.add('apify', items.length * APIFY_COST_PER_AD);
  return items.filter((a) => a && !('error' in a));
}

function metaTokenFor(clientCode: string): string | undefined {
  const e = process.env;
  const GROWTHSQUAD = new Set(['LA', 'LA2', 'TL']);
  return GROWTHSQUAD.has(clientCode.toUpperCase()) && e.META_ACCESS_TOKEN_GROWTHSQUAD
    ? e.META_ACCESS_TOKEN_GROWTHSQUAD
    : env.META_ACCESS_TOKEN;
}

/** Resolve the client's own FB page from a live ad's effective_object_story_id. */
async function resolveOwnPage(clientCode: string, adAccountId: string | null, tokenOverride?: string): Promise<{ name: string; pageId: string } | null> {
  if (!adAccountId) return null;
  const token = tokenOverride ?? metaTokenFor(clientCode);
  if (!token) return null;
  const acct = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
  const resp = await fetch(
    `https://graph.facebook.com/v21.0/${acct}/ads?fields=creative{effective_object_story_id}&limit=10&access_token=${token}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!resp.ok) return null;
  const body = (await resp.json()) as { data?: Array<{ creative?: { effective_object_story_id?: string } }> };
  const story = body.data?.map((a) => a.creative?.effective_object_story_id).find(Boolean);
  if (!story) return null;
  const pageId = story.split('_')[0]!;
  let name = `Page ${pageId}`;
  try {
    const pr = await fetch(`https://graph.facebook.com/v21.0/${pageId}?fields=name&access_token=${token}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (pr.ok) name = ((await pr.json()) as { name?: string }).name ?? name;
  } catch {
    /* keep fallback name */
  }
  return { name, pageId };
}

/**
 * Placement-broken-down hook inputs for the rewarded-video correction
 * (pro-trust layer). One account-level insights call, last 30 days — fail-soft
 * null on any error; the correction is a bonus, never a blocker.
 */
async function fetchPlacementHookRows(
  clientCode: string,
  adAccountId: string | null,
  tokenOverride?: string,
): Promise<PlacementHookRow[] | null> {
  if (!adAccountId) return null;
  const token = tokenOverride ?? metaTokenFor(clientCode);
  if (!token) return null;
  const acct = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
  try {
    const resp = await fetch(
      `https://graph.facebook.com/v21.0/${acct}/insights?level=account&date_preset=last_30d` +
        `&breakdowns=publisher_platform,platform_position&fields=impressions,actions&limit=500&access_token=${token}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (!resp.ok) return null;
    const body = (await resp.json()) as {
      data?: Array<{
        publisher_platform?: string;
        platform_position?: string;
        impressions?: string;
        actions?: Array<{ action_type: string; value: string }>;
      }>;
    };
    if (!body.data?.length) return null;
    return body.data.map((r) => ({
      publisher_platform: r.publisher_platform ?? 'unknown',
      platform_position: r.platform_position ?? 'unknown',
      impressions: Number(r.impressions ?? 0),
      video_views: Number(r.actions?.find((a) => a.action_type === 'video_view')?.value ?? 0),
    }));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session-G pulls — the full report set (all fail-soft: a failed pull turns
// its section into an honest error, never kills the audit)
// ---------------------------------------------------------------------------

interface RawActionList {
  action_type: string;
  value: string;
}
const actionNum = (xs: RawActionList[] | undefined, type: string): number => Number(xs?.find((a) => a.action_type === type)?.value ?? 0);
const purchasesOf = (actions?: RawActionList[]): number => actionNum(actions, 'omni_purchase') || actionNum(actions, 'purchase');
const leadsOf = (actions?: RawActionList[]): number => actionNum(actions, 'lead');

/** One account-insights pull with the given breakdowns, last 30 days. */
async function fetchInsightsBreakdown(
  clientCode: string,
  adAccountId: string | null,
  breakdowns: string,
  extraParams = '',
  tokenOverride?: string,
): Promise<Array<Record<string, unknown> & { spend?: string; impressions?: string; actions?: RawActionList[]; action_values?: RawActionList[] }> | null> {
  if (!adAccountId) return null;
  const token = tokenOverride ?? metaTokenFor(clientCode);
  if (!token) return null;
  const acct = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
  try {
    const resp = await fetch(
      `https://graph.facebook.com/v21.0/${acct}/insights?level=account&date_preset=last_30d` +
        `&breakdowns=${breakdowns}&fields=spend,impressions,actions,action_values&limit=500${extraParams}&access_token=${token}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (!resp.ok) return null;
    const body = (await resp.json()) as { data?: Array<Record<string, unknown>> };
    return (body.data ?? []) as never;
  } catch {
    return null;
  }
}

/** Weekly reach/impressions/spend, last ~91 days (Meta's own deduped weekly reach). */
async function fetchWeeklyReach(clientCode: string, adAccountId: string | null, tokenOverride?: string): Promise<WeeklyReachRow[] | null> {
  if (!adAccountId) return null;
  const token = tokenOverride ?? metaTokenFor(clientCode);
  if (!token) return null;
  const acct = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
  const until = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - 91 * 86400_000).toISOString().slice(0, 10);
  try {
    const resp = await fetch(
      `https://graph.facebook.com/v21.0/${acct}/insights?level=account&fields=reach,impressions,spend` +
        `&time_increment=7&time_range=${encodeURIComponent(JSON.stringify({ since, until }))}&limit=52&access_token=${token}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (!resp.ok) return null;
    const body = (await resp.json()) as { data?: Array<{ date_start?: string; reach?: string; impressions?: string; spend?: string }> };
    if (!body.data?.length) return null;
    return body.data.map((r) => ({
      week: r.date_start ?? '',
      reach: Number(r.reach ?? 0),
      impressions: Number(r.impressions ?? 0),
      spend: Number(r.spend ?? 0),
    }));
  } catch {
    return null;
  }
}

/** Live targeting spec per ad set, classified fields only. */
async function fetchTargetingSpecs(clientCode: string, adAccountId: string | null, tokenOverride?: string): Promise<TargetingSpecLite[] | null> {
  if (!adAccountId) return null;
  const token = tokenOverride ?? metaTokenFor(clientCode);
  if (!token) return null;
  const acct = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
  const out: TargetingSpecLite[] = [];
  let url =
    `https://graph.facebook.com/v21.0/${acct}/adsets` +
    `?fields=id,name,effective_status,targeting{age_min,age_max,genders,custom_audiences,flexible_spec,targeting_automation}` +
    `&limit=200&access_token=${token}`;
  try {
    for (let page = 0; page < 5 && url; page++) {
      const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!resp.ok) return out.length ? out : null;
      const body = (await resp.json()) as {
        data?: Array<{
          id: string;
          name: string;
          effective_status?: string;
          targeting?: {
            age_min?: number;
            age_max?: number;
            genders?: number[];
            custom_audiences?: Array<{ id: string; name?: string }>;
            flexible_spec?: Array<Record<string, unknown>>;
            targeting_automation?: { advantage_audience?: number };
          };
        }>;
        paging?: { next?: string };
      };
      for (const a of body.data ?? []) {
        const t = a.targeting ?? {};
        const cas = t.custom_audiences ?? [];
        const hasLal = cas.some((c) => /lookalike|lal/i.test(c.name ?? ''));
        const hasInterests = (t.flexible_spec ?? []).some((f) => Object.keys(f).some((k) => k === 'interests' || k === 'behaviors'));
        out.push({
          adset_id: a.id,
          adset_name: a.name,
          effective_status: a.effective_status ?? null,
          advantage_audience: (t.targeting_automation?.advantage_audience ?? 0) === 1,
          has_custom_audiences: cas.length > 0,
          has_lookalikes: hasLal,
          has_interests: hasInterests,
          age_min: t.age_min ?? null,
          age_max: t.age_max ?? null,
          genders: t.genders?.length === 1 ? (t.genders[0] === 1 ? 'male' : 'female') : t.genders?.length ? 'all' : null,
        });
      }
      url = body.paging?.next ?? '';
    }
    return out;
  } catch {
    return out.length ? out : null;
  }
}

/** Ad ids whose creative is branded content (partnership ads). */
async function fetchPartnershipAdIds(clientCode: string, adAccountId: string | null, tokenOverride?: string): Promise<Set<string> | null> {
  if (!adAccountId) return null;
  const token = tokenOverride ?? metaTokenFor(clientCode);
  if (!token) return null;
  const acct = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
  const flagged = new Set<string>();
  let url =
    `https://graph.facebook.com/v21.0/${acct}/ads` +
    `?fields=id,creative{branded_content_sponsor_page_id}&limit=250&access_token=${token}`;
  try {
    for (let page = 0; page < 4 && url; page++) {
      const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!resp.ok) return flagged;
      const body = (await resp.json()) as {
        data?: Array<{ id: string; creative?: { branded_content_sponsor_page_id?: string } }>;
        paging?: { next?: string };
      };
      for (const a of body.data ?? []) if (a.creative?.branded_content_sponsor_page_id) flagged.add(a.id);
      url = body.paging?.next ?? '';
    }
    return flagged;
  } catch {
    return flagged;
  }
}

/**
 * Account change history / activity log — Meta's activities edge
 * (act_<id>/activities), read-only under ads_read. Paginated, fail-soft: any
 * error returns null (the section becomes an honest "unavailable", never a
 * fabricated log). Capped at ACTIVITY_PAGE_CAP pages — automated accounts can
 * emit thousands of events; when the cap is hit we flag `partial` so the counts
 * are read as a floor. Window defaults to 90 days.
 */
const ACTIVITY_PAGE_CAP = 20; // 20 × 500 = up to 10k events before we call it a floor

async function fetchAccountActivities(
  clientCode: string,
  adAccountId: string | null,
  tokenOverride?: string,
  opts: { windowDays?: number; asOf?: string } = {},
): Promise<{ events: ActivityEvent[]; partial: boolean } | null> {
  if (!adAccountId) return null;
  const token = tokenOverride ?? metaTokenFor(clientCode);
  if (!token) return null;
  const acct = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
  const windowDays = opts.windowDays ?? 90;
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const since = new Date(new Date(`${asOf}T00:00:00Z`).getTime() - windowDays * 86400_000).toISOString().slice(0, 10);
  const events: ActivityEvent[] = [];
  let partial = false;
  let url =
    `https://graph.facebook.com/v21.0/${acct}/activities` +
    `?fields=event_type,event_time,actor_id,actor_name,application_id,application_name,object_type` +
    `&since=${since}&until=${asOf}&limit=500&access_token=${token}`;
  try {
    let page = 0;
    for (; page < ACTIVITY_PAGE_CAP && url; page++) {
      const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!resp.ok) {
        // A first-page failure = endpoint unavailable under this token → null so
        // the section reports honestly. Later-page failure = keep what we have.
        return events.length ? { events, partial: true } : null;
      }
      const body = (await resp.json()) as {
        data?: Array<{
          event_type?: string;
          event_time?: string;
          actor_id?: string;
          actor_name?: string;
          application_id?: string;
          application_name?: string;
          object_type?: string;
        }>;
        paging?: { next?: string };
      };
      for (const a of body.data ?? []) {
        events.push({
          event_type: a.event_type ?? 'unknown',
          event_time: a.event_time ?? '',
          actor_id: a.actor_id ?? null,
          actor_name: a.actor_name ?? null,
          application_id: a.application_id ?? null,
          application_name: a.application_name ?? null,
          object_type: a.object_type ?? null,
        });
      }
      url = body.paging?.next ?? '';
    }
    if (page >= ACTIVITY_PAGE_CAP && url) partial = true;
    return { events: events.filter((e) => e.event_time), partial };
  } catch (err) {
    logger.warn({ err, clientCode }, 'account activities pull failed (change-history section degrades)');
    return events.length ? { events, partial: true } : null;
  }
}

/** Per-audit cap on unique destination URLs fetched (top-spend-first). Well above
 * a normal account's dedup'd URL count (LA, the busiest, dedups 124 ads → 18 URLs);
 * exists so a catalog/DPA edge case can't stall the audit. Overflow is surfaced
 * as a section warning, never silently dropped. */
const DEAD_URL_CHECK_CAP = 50;
const GRAPH_IDS_BATCH = 50; // Graph ?ids= batch limit

/**
 * Resolve the CURRENT destination of EVERY currently-delivering spending ad live
 * from its Meta creative (stored landing_page_raw goes stale on dynamic creatives —
 * HARD RULE from the NP dead-URL false-positive incident, 2026-07-01), dedupe by
 * URL, then fetch each one. Was top-15-ads/10-URLs until 2026-07-06 (Dan: check
 * ALL ads getting spend); classification is soft-404 aware via classifyDestination
 * (shared semantics with bmad's url_guard / nightly dead_url_scan). Ads that spent
 * in the window but are no longer delivering (paused, off) are skipped — a stale
 * URL there isn't burning money now.
 */
async function checkAdDestinations(
  clientCode: string,
  spendingAds: Array<{ ad_id: string; ad_name: string; spend: number }>,
  tokenOverride?: string,
): Promise<{ checks: DeadUrlCheck[]; uncheckedUrls: number }> {
  const token = tokenOverride ?? metaTokenFor(clientCode);
  if (!token || spendingAds.length === 0) return { checks: [], uncheckedUrls: 0 };
  const byUrl = new Map<string, { ads: string[]; spend: number }>();
  type CreativeNode = {
    effective_status?: string;
    creative?: {
      asset_feed_spec?: { link_urls?: Array<{ website_url?: string }> };
      object_story_spec?: { link_data?: { link?: string }; video_data?: { call_to_action?: { value?: { link?: string } } } };
    };
  };
  try {
    const body: Record<string, CreativeNode> = {};
    for (let i = 0; i < spendingAds.length; i += GRAPH_IDS_BATCH) {
      const ids = spendingAds.slice(i, i + GRAPH_IDS_BATCH).map((a) => a.ad_id);
      const resp = await fetch(
        `https://graph.facebook.com/v21.0/?ids=${ids.join(',')}` +
          `&fields=name,effective_status,creative{asset_feed_spec{link_urls},object_story_spec{link_data{link},video_data{call_to_action}}}` +
          `&access_token=${token}`,
        { signal: AbortSignal.timeout(30_000) },
      );
      if (!resp.ok) continue; // partial coverage beats none — remaining batches still try
      Object.assign(body, (await resp.json()) as Record<string, CreativeNode>);
    }
    for (const ad of spendingAds) {
      const node = body[ad.ad_id];
      if (!node) continue;
      // Spent in the window but not delivering now → nothing is burning; skip.
      if (node.effective_status && node.effective_status !== 'ACTIVE') continue;
      const c = node.creative;
      const url =
        c?.asset_feed_spec?.link_urls?.[0]?.website_url ??
        c?.object_story_spec?.link_data?.link ??
        c?.object_story_spec?.video_data?.call_to_action?.value?.link;
      if (!url || !/^https?:\/\//.test(url)) continue;
      const clean = url.split('?')[0]!;
      const agg = byUrl.get(clean) ?? { ads: [], spend: 0 };
      agg.ads.push(ad.ad_name);
      agg.spend += ad.spend;
      byUrl.set(clean, agg);
    }
  } catch {
    return { checks: [], uncheckedUrls: 0 };
  }

  // Highest-spend URLs first, so a cap overflow drops the cheapest tail.
  const ranked = [...byUrl.entries()].sort((a, b) => b[1].spend - a[1].spend);
  const toCheck = ranked.slice(0, DEAD_URL_CHECK_CAP);
  const uncheckedUrls = ranked.length - toCheck.length;

  const checks: DeadUrlCheck[] = [];
  for (const [url, agg] of toCheck) {
    let verdict: DeadUrlCheck['verdict'];
    let reason: string;
    let status: number | null = null;
    try {
      const resp = await fetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36' },
        signal: AbortSignal.timeout(15_000),
      });
      status = resp.status;
      const bodySlice = (await resp.text()).slice(0, 65_536);
      ({ verdict, reason } = classifyDestination(url, resp.url, resp.status, bodySlice));
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        verdict = 'inconclusive';
        reason = 'fetch timed out — could not verify (not evidence of a dead page)';
      } else if (err instanceof Error && (err.cause as { code?: string } | undefined)?.code === 'ENOTFOUND') {
        verdict = 'dead';
        reason = 'domain does not resolve (DNS failure) — the site/host is gone';
      } else {
        // Transient TCP/TLS trouble is NOT proof of death (the nightly scan
        // browser-confirms these; the audit has no browser, so it stays honest).
        verdict = 'inconclusive';
        reason = `connection problem — could not verify (${err instanceof Error ? err.message.slice(0, 80) : 'fetch error'})`;
      }
    }
    checks.push({ url, verdict, status, daily_burn: agg.spend / 30, ads: agg.ads.slice(0, 5), reason });
    await new Promise((r) => setTimeout(r, 300)); // gentle pacing — never burst a shop
  }
  return { checks, uncheckedUrls };
}

/** How many surfaced ads get a preview link + thumbnail per audit (one batched
 * Graph call — the ids= batch endpoint takes up to 50; 15 covers the page). */
const AD_PREVIEW_CAP = 15;

/**
 * Batched preview links + creative thumbnails for the ads that actually
 * surface on the report page (fatigue `ads[]` + concentration `top_ads[]`) —
 * ONE Graph `?ids=` call, same batch shape as the dead-URL creative resolve.
 * `preview_shareable_link` is an fb.me link anyone can open ("view this ad").
 * Fail-soft: no token / any Graph error → empty map, the audit stays intact.
 */
async function fetchAdPreviews(
  clientCode: string,
  adIds: string[],
  tokenOverride?: string,
): Promise<Map<string, AdPreview>> {
  const out = new Map<string, AdPreview>();
  const token = tokenOverride ?? metaTokenFor(clientCode);
  if (!token || adIds.length === 0) return out;
  const ids = adIds.slice(0, AD_PREVIEW_CAP);
  try {
    const resp = await fetch(
      `https://graph.facebook.com/v21.0/?ids=${ids.join(',')}` +
        `&fields=preview_shareable_link,creative{thumbnail_url}&access_token=${token}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (!resp.ok) return out;
    const body = (await resp.json()) as Record<
      string,
      { preview_shareable_link?: string; creative?: { thumbnail_url?: string } }
    >;
    for (const id of ids) {
      const a = body[id];
      if (!a) continue;
      const preview_link = a.preview_shareable_link ?? null;
      const thumbnail_url = a.creative?.thumbnail_url ?? null;
      if (preview_link || thumbnail_url) out.set(id, { preview_link, thumbnail_url });
    }
  } catch (err) {
    logger.warn({ err, clientCode }, 'ad preview fetch failed (report renders without previews)');
  }
  return out;
}

interface CompetitorSynthesis {
  summary: string;
  pages: Array<{ page_name: string; velocity_read: string; dominant_messages: string[]; lp_strategy: string }>;
  open_lanes: string[];
  warnings: string[];
}

async function runCompetitorTeardown(
  clientCode: string,
  meter: CostMeter,
  client: { id: string; name: string; currency: string; adAccountId: string | null },
  options: AuditOptions,
  synthSystem: string,
  getOwnLibrary?: () => Promise<OwnLibraryScrape>,
  /** Account-API context for the own-footprint age bridge (count-scope debt
   * 2026-07-04): the Library's "oldest active" vs the account's true longest
   * run measure different populations — the page must say so. */
  accountAge?: { adsCount: number; longestRunningDays: number | null },
): Promise<Partial<AuditSection>> {
  const targets = options.competitorPages ?? [];
  let mode: 'competitors' | 'own_footprint' = 'competitors';

  const perPage: Array<{ name: string; pageId: string; triage: Record<string, unknown> }> = [];
  const scrapeWarnings: string[] = [];
  if (targets.length === 0) {
    // Own-footprint mode rides the SHARED memoized scrape (one Apify run per
    // audit — the cold creative_analysis fallback reads the same result).
    mode = 'own_footprint';
    if (!getOwnLibrary) return { status: 'error', error: 'no competitor pages given and no own-footprint scrape available' };
    try {
      const lib = await getOwnLibrary();
      perPage.push({ name: lib.page.name, pageId: lib.page.pageId, triage: triageLibrary(lib.ads) });
    } catch (err) {
      return { status: 'error', error: `own-footprint scrape failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  } else for (const t of targets.slice(0, 3)) {
    if (meter.exhausted()) {
      scrapeWarnings.push(`cost cap reached before scraping ${t.name}`);
      continue;
    }
    try {
      const ads = await apifyScrapePage(t.pageId, 250, meter);
      perPage.push({ name: t.name, pageId: t.pageId, triage: triageLibrary(ads) });
    } catch (err) {
      scrapeWarnings.push(`${t.name}: scrape failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (perPage.length === 0) {
    return { status: 'error', error: scrapeWarnings.join('; ') || 'no pages scraped' };
  }

  // Deterministic age-scope bridge (own footprint only): reconciles the
  // Library's "oldest active ad" with the account API's longest-running ad.
  const ageBridge = mode === 'own_footprint' ? libraryAgeBridge(perPage[0]!.triage, accountAge) : null;

  const synth = await synthesizeJson<CompetitorSynthesis>(
    meter,
    'competitor_teardown',
    synthSystem,
    `Public Facebook Ads Library scrape (deterministic triage, weights = ad-cluster size as spend proxy):\n` +
      `Mode: ${mode === 'own_footprint' ? `the client's OWN public footprint (page: ${perPage[0]!.name})` : 'competitor pages'}\n` +
      `Client: ${client.name}\n${JSON.stringify(perPage, null, 1)}\n\n` +
      (ageBridge
        ? `Population note (private account data): ${accountAge!.adsCount} ads delivered in the audit window; the longest-running still-spending ad is ${accountAge!.longestRunningDays} days old. ` +
          `The Library only shows currently-active PUBLIC ads — never present its oldest_active_days as the account's true oldest ad, and never mix the two populations' counts.\n\n`
        : '') +
      `Write the "Ads Library Landscape" audit section. Velocity rule: oldest active ad >120d means evergreen winners exist (name the signal); <60d means rotation cadence IS the strategy. ` +
      `Catalog note: catalog_dynamic_weight_share_pct is the share of catalog/dynamic (DPA) creative — its {{...}} template tokens render per-product at serve time and are already excluded from top_hooks; NEVER describe template tokens as broken, unrendered, or a QA failure. Schema:\n` +
      `{"summary":"2-3 sentences with the headline strategic read and at least two numbers",` +
      `"pages":[per page {"page_name","velocity_read","dominant_messages":[up to 3 short strings from the top hooks],"lp_strategy":"1 sentence from the landing-path concentration"}],` +
      `"open_lanes":[up to 3 strings — angles/formats visibly NOT used that ${mode === 'own_footprint' ? 'the brand' : 'the client'} could take],` +
      `"warnings":[up to 2 strings]}`,
  );

  const data = { mode, pages: perPage, age_bridge: ageBridge ?? undefined, narrative: synth ? { pages: synth.pages, open_lanes: synth.open_lanes } : undefined };

  if (!synth) {
    const p = perPage[0]!;
    return {
      status: 'complete',
      summary:
        `${p.name}: ${String((p.triage as { page_total_active?: unknown }).page_total_active)} active ads in the public library (cost cap reached before narrative synthesis).` +
        (ageBridge ? ` ${ageBridge}` : ''),
      data,
      warnings: scrapeWarnings,
    };
  }
  return {
    status: 'complete',
    summary: ageBridge ? `${synth.summary} ${ageBridge}` : synth.summary,
    data,
    warnings: [...(synth.warnings ?? []), ...scrapeWarnings],
  };
}

// ---------------------------------------------------------------------------
// Session D — read-only adset configs, angle map, account model, recognition
// ---------------------------------------------------------------------------

/** READ-ONLY GET of ad-set optimization configs. Audits never write to Meta. */
async function fetchAdsetConfigs(clientCode: string, adAccountId: string | null, tokenOverride?: string): Promise<AdsetConfigLite[]> {
  if (!adAccountId) return [];
  const token = tokenOverride ?? metaTokenFor(clientCode);
  if (!token) return [];
  const acct = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
  const out: AdsetConfigLite[] = [];
  let url =
    `https://graph.facebook.com/v21.0/${acct}/adsets` +
    `?fields=id,name,optimization_goal,effective_status,promoted_object{custom_event_type}` +
    `&limit=200&access_token=${token}`;
  for (let page = 0; page < 5 && url; page++) {
    const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) throw new Error(`adsets read failed: ${resp.status}`);
    const body = (await resp.json()) as {
      data?: Array<{ id: string; name: string; optimization_goal?: string; effective_status?: string; promoted_object?: { custom_event_type?: string } }>;
      paging?: { next?: string };
    };
    for (const a of body.data ?? []) {
      out.push({
        adset_id: a.id,
        adset_name: a.name,
        optimization_goal: a.optimization_goal ?? null,
        custom_event_type: a.promoted_object?.custom_event_type ?? null,
        effective_status: a.effective_status ?? null,
      });
    }
    url = body.paging?.next ?? '';
  }
  return out;
}

/** messaging-angle per ad_id: creatives (hash cols) → creative_analysis.ai_analysis. */
async function fetchAngleByAdId(clientId: string, adIds: Set<string>): Promise<Map<string, string>> {
  const angleByAd = new Map<string, string>();
  if (adIds.size === 0) return angleByAd;
  const creatives = await pageAll<{ ad_id: string; video_hash: string | null; video_id: string | null; image_hash: string | null }>(
    'creatives',
    'ad_id, video_hash, video_id, image_hash',
    (q) => q.eq('client_id', clientId),
    20_000,
  );
  const hashByAd = new Map<string, string>();
  for (const c of creatives) {
    if (!adIds.has(String(c.ad_id))) continue;
    const h = c.video_hash ?? (c.video_id != null ? String(c.video_id) : null) ?? c.image_hash;
    if (h) hashByAd.set(String(c.ad_id), String(h));
  }
  const hashes = [...new Set(hashByAd.values())];
  const angleByHash = new Map<string, string>();
  // Chunked .in() — hundreds of hashes in one GET would blow the URL length.
  for (let i = 0; i < hashes.length; i += 100) {
    const { data, error } = await getSupabase()
      .from('creative_analysis')
      .select('content_hash, ai_analysis')
      .in('content_hash', hashes.slice(i, i + 100));
    if (error) throw new Error(`creative_analysis query failed: ${error.message}`);
    for (const row of (data ?? []) as Array<{ content_hash: string; ai_analysis: Record<string, unknown> | null }>) {
      const angle = row.ai_analysis?.['messaging_angle'];
      if (typeof angle === 'string' && angle.trim()) angleByHash.set(String(row.content_hash), angle.trim());
    }
  }
  for (const [adId, h] of hashByAd) {
    const angle = angleByHash.get(h);
    if (angle) angleByAd.set(adId, angle);
  }
  return angleByAd;
}

/** Instant recognition strip — one cheap account_daily query, lands with the row insert. */
async function quickRecognition(clientId: string, currency: string): Promise<Record<string, unknown> | null> {
  try {
    const rows = await pageAll<{ date: string; spend: number }>(
      'account_daily', 'date, spend', (q) => q.eq('client_id', clientId).gte('date', daysAgoISO(90)), 200,
    );
    if (rows.length === 0) return null;
    const spend = rows.reduce((s, r) => s + num(r.spend), 0);
    return { window_days: 90, days_covered: rows.length, spend_90d: Math.round(spend), currency };
  } catch {
    return null;
  }
}

/** Cold-path recognition — same shape as quickRecognition, from the pre-pulled rows. */
function coldRecognition(cold: ColdInjection, currency: string): Record<string, unknown> | null {
  const rows = cold.rows.packAccRows90;
  if (rows.length === 0) return null;
  const spend = rows.reduce((s, r) => s + num(r.spend), 0);
  return { window_days: 90, days_covered: rows.length, spend_90d: Math.round(spend), currency };
}

/** Upsert the Account Model — human_stated facts survive re-inference (merge rule). */
async function upsertAccountModel(clientCode: string, auditId: string, model: AccountModel): Promise<void> {
  const supabase = getSupabase();
  const { data: prev } = await supabase
    .from('account_models')
    .select('id, facts, version')
    .eq('client_code', clientCode)
    .maybeSingle();
  const merged = mergeAccountModel(
    prev ? { facts: ((prev.facts as AccountModel['facts']) ?? []) } : null,
    model,
  );
  const payload = {
    client_code: clientCode,
    audit_id: auditId,
    business_model: merged.business_model,
    facts: merged.facts,
    open_questions: merged.open_questions,
    version: prev ? ((prev.version as number) ?? 1) + 1 : 1,
    updated_at: new Date().toISOString(),
  };
  const { error } = prev
    ? await supabase.from('account_models').update(payload).eq('id', prev.id as string)
    : await supabase.from('account_models').insert(payload);
  if (error) throw new Error(`account_models upsert failed: ${error.message}`);
}

/** One honest work-receipt line per finished section — real numbers, no theater. */
function workLineFor(key: string, s: AuditSection): string | null {
  if (s.status !== 'complete') return null;
  const d = (s.data ?? {}) as Record<string, unknown>;
  switch (key) {
    case 'dataset_health': {
      const pixels = (d.pixels as unknown[] | undefined)?.length ?? 0;
      return pixels ? `Checked ${pixels} pixel dataset${pixels > 1 ? 's' : ''} — events, CAPI split, match keys` : null;
    }
    case 'account_structure': {
      const n = (d.campaigns as unknown[] | undefined)?.length ?? 0;
      return n ? `Mapped ${n} campaigns and how budget flows through them` : null;
    }
    case 'spend_concentration':
      return typeof d.ads_with_spend === 'number' ? `Measured spend concentration across ${d.ads_with_spend} active ads` : null;
    case 'creative_fatigue':
      return typeof d.assessed_ads === 'number' ? `Ran 90-day fatigue trends on ${d.assessed_ads} ads` : null;
    case 'budget_scatter':
      return typeof d.ads_plotted === 'number' && d.ads_plotted > 0 ? `Plotted spend against return for ${d.ads_plotted} ads` : null;
    case 'creative_cohorts':
      return typeof d.window_months === 'number' ? `Rebuilt ${d.window_months} months of creative launch cohorts` : null;
    case 'cost_trends': {
      const n = (d.series as unknown[] | undefined)?.length ?? 0;
      return n ? `Read ${n} weeks of CPM × CTR history` : null;
    }
    case 'timing_patterns':
      return `Split 90 days of results by weekday`;
    case 'how_you_compare': {
      const n = (d.bands as unknown[] | undefined)?.length ?? 0;
      return n ? `Benchmarked your hook${n > 1 ? ' & hold' : ''} rate against the accounts on our desk` : null;
    }
    case 'concept_roas':
      return typeof d.coverage_pct === 'number' ? `Matched creative angle tags on ${d.coverage_pct}% of spend` : null;
    case 'optimization_events': {
      // counts covers ALL assessed ad sets; data.rows is capped for display.
      const c = d.counts as { check: number; x: number; question: number } | undefined;
      const n = c ? c.check + c.x + c.question : 0;
      return n ? `Read the optimization goal on all ${n} ad sets that spent in the last 30 days` : null;
    }
    case 'creative_analysis':
      // Cold path: we watched the actual downloaded creatives with Gemini.
      if (typeof d.creatives_analyzed === 'number' && d.creatives_analyzed > 0) {
        return `Watched the actual creative on ${d.creatives_analyzed} top ads — hooks, formats, casting`;
      }
      return typeof d.ads_with_spend === 'number' ? `Read the copy + transcripts of the top spenders (${d.ads_with_spend} ads in market)` : null;
    case 'funnel_read':
      return `Walked the funnel stage by stage (30 days)`;
    case 'placement_breakdown': {
      const n = (d.platforms as unknown[] | undefined)?.length ?? 0;
      return n ? `Split spend across ${n} platforms and their placements — Audience Network checked` : null;
    }
    case 'audience_breakdown':
      return `Broke delivery down by age, gender and country`;
    case 'saturation': {
      const n = (d.weeks as unknown[] | undefined)?.length ?? 0;
      return n ? `Read ${n} weeks of reach vs frequency for saturation` : null;
    }
    case 'creative_diversity':
      return typeof d.angles === 'number' && d.angles > 0 ? `Measured portfolio concentration across ${d.angles} creative angles` : null;
    case 'whats_working':
      return `Assembled the protect list — what NOT to touch`;
    case 'learning_limited': {
      // data.rows is display-capped at 15 — the honest population count is
      // assessed_adsets (count-scope debt 2026-07-04: the work log said "15"
      // while the section said "42 of 42").
      const n = typeof d.assessed_adsets === 'number' ? d.assessed_adsets : ((d.rows as unknown[] | undefined)?.length ?? 0);
      return n ? `Checked all ${n} currently active spending ad sets against Meta's learning-phase bar` : null;
    }
    case 'targeting_split': {
      const n = (d.classes as unknown[] | undefined)?.length ?? 0;
      return n ? `Classified every spending ad set's live targeting (${n} styles found)` : null;
    }
    case 'landing_pages': {
      const checks = (d.dead_checks as unknown[] | undefined)?.length ?? 0;
      return checks
        ? `Resolved every delivering ad's CURRENT destination from Meta and fetched all ${checks} unique URLs live`
        : `Ranked spend by landing destination`;
    }
    case 'account_facts':
      return `Pulled six months of account texture — the "did you know" facts`;
    case 'competitor_teardown':
      return `Scanned the public Ads Library footprint`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// B3 — lead-insight ranking across all completed sections
// ---------------------------------------------------------------------------

async function rankLeadInsights(
  meter: CostMeter,
  client: { name: string },
  sections: Record<string, AuditSection>,
  synthSystem: string,
): Promise<LeadInsight[] | null> {
  const material = Object.values(sections)
    .filter((s) => s.status === 'complete')
    .map((s) => ({
      section: s.key,
      summary: s.summary,
      warnings: s.warnings,
      extract: JSON.stringify(s.data).slice(0, 1800),
    }));
  if (material.length === 0) return null;

  const out = await synthesizeJson<{ insights: LeadInsight[] }>(
    meter,
    'lead_insights',
    synthSystem,
    `Completed audit sections for ${client.name}:\n${JSON.stringify(material, null, 1)}\n\n` +
      `Pick the THREE lead insights for the top of the report. Ranking rubric: surprise × specificity — ` +
      `a qualifying insight names a specific entity (ad, campaign, pixel, stage, competitor page) AND a number. ` +
      `Prefer findings the client almost certainly does NOT already know. Never restate a section summary verbatim — sharpen it.\n` +
      `Schema: {"insights":[exactly 3 of {"headline":"<=90 chars, punchy","detail":"2-3 sentences with the number(s) and why it matters","severity":"risk|opportunity|info","section":"<section key>"}]}`,
  );
  return out?.insights ?? null;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runMagicAudit(
  clientCode: string,
  options: AuditOptions = {},
): Promise<{ auditId: string; token: string; costUsd: number }> {
  const supabase = getSupabase();
  const cold = options.cold;
  const code = clientCode.toUpperCase();
  const meter = new CostMeter(options.maxCostUsd ?? 10);
  const skip = new Set(options.skipSections ?? []);
  // Cold path: warehouse-backed sections can't run for a stranger — mark them
  // planned via the existing skip machinery, never as errors.
  if (cold) for (const k of COLD_SKIP_SECTIONS) skip.add(k);

  // Cold path synthesizes the client shape from the live connection; `id` is
  // the auth user's uuid and is ONLY used as tenant identity — every
  // warehouse query keyed by client.id is guarded behind `!cold` below.
  const client = cold
    ? { id: cold.userId, name: cold.accountName ?? 'Your account', currency: cold.currency, adAccountId: cold.adAccountId }
    : await resolveClient(code);
  if (!client) throw new Error(`client ${code} not found`);

  // Stated-economics re-basing (founder-sim debt #1, 2026-07-04): a cold
  // lead's stated gross margin turns the fatigue breakeven from the honest
  // 1.0× default into their real line (1 ÷ margin, e.g. 45% → 2.22×). The
  // warehouse path stays at 1.0× — agency clients' real targets live in the
  // knowledge bundle, not this param.
  const { grossMarginPct, breakevenRoas } = coldBreakeven(cold?.grossMarginPct);

  // Phase B (context layer): assemble this client's knowledge bundle ONCE
  // (targets/KPI config + client-scoped learnings + the intelligence file) and
  // the days-with-data preflight; every synthesis call sees both via the
  // system prompt. Fail-soft — an audit without context still runs.
  // Cold path: a stranger has no knowledge bundle — the lead's stated goal +
  // margin (ada_leads.goal_metric/value/gross_margin_pct) anchor judgments,
  // and the attribution contract (cite them AS the owner's, never ours) rides
  // in via buildColdKnowledge.
  let clientKnowledge = '';
  if (cold) {
    clientKnowledge = buildColdKnowledge({
      goalMetric: cold.goalMetric,
      goalValue: cold.goalValue,
      grossMarginPct,
      breakevenRoas,
    });
  } else {
    try {
      clientKnowledge = await buildClientKnowledgeBundle(code);
    } catch (err) {
      logger.warn({ err, code }, 'client knowledge bundle failed (audit continues without it)');
    }
  }
  let dataCaveat: string | null = null;
  let daysWithData: number | null = null;
  try {
    const dates = cold
      ? cold.rows.accFull30.map((r) => r.date)
      : (
          await pageAll<{ date: string }>(
            'ad_daily',
            'date',
            (q) => q.eq('client_id', client.id).gte('date', daysAgoISO(30)),
          )
        ).map((r) => r.date);
    const win = summarizeDataWindow(dates);
    daysWithData = win.daysWithData;
    dataCaveat = win.caveat;
  } catch (err) {
    logger.warn({ err, code }, 'days-with-data preflight failed (audit continues)');
  }
  // `let` — the pack pulls below can append a truncation caveat, after which
  // the synth system is rebuilt (runners read it at call time via closure).
  let synthSystem = buildSynthSystem(clientKnowledge, dataCaveat);
  logger.info(
    { code, knowledgeChars: clientKnowledge.length, daysWithData, thinWindow: !!dataCaveat },
    'audit client context assembled',
  );

  const token = randomBytes(16).toString('hex');
  const sections: Record<string, AuditSection> = {};
  for (const s of SECTION_ORDER) sections[s.key] = { ...s, status: skip.has(s.key) ? 'planned' : s.status };

  // Recognition strip — seeded AT insert so the very first paint already says
  // "that's MY account" (UX review §2.1: recognition is the first magic beat).
  // Cold path derives it from the pre-pulled rows (no account_daily to read).
  const recognition = cold ? coldRecognition(cold, client.currency) : await quickRecognition(client.id, client.currency);

  // Identity contract v2 (Dan ruling 2026-07-03): tenant_id (uuid) is the
  // canonical audit identity — clients.id for agency clients, auth users.id
  // for self-serve strangers (cold path; client_code stays NULL there).
  // Requires the magic_audits.tenant_id DDL (bmad migration 20260703150000) —
  // applied to prod 2026-07-03.
  const { data: row, error } = await supabase
    .from('magic_audits')
    .insert({ token, client_code: cold ? null : code, client_name: client.name, sections, recognition, tenant_id: client.id })
    .select('id')
    .single();
  if (error || !row) throw new Error(`audit row insert failed: ${error?.message}`);
  const auditId = row.id as string;
  logger.info({ auditId, token, clientCode: code, capUsd: meter.capUsd }, 'Magic audit started');

  const updateRow = async (patch: Record<string, unknown>): Promise<void> => {
    const { error: e } = await supabase
      .from('magic_audits')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', auditId);
    if (e) logger.error({ error: e, auditId }, 'magic_audits update failed');
  };
  const saveSection = async (section: AuditSection): Promise<void> => {
    sections[section.key] = section;
    await updateRow({ sections, cost_usd: round2(meter.spentUsd) });
  };

  // Work narration → permanent work receipt (UX review §2.3: progress IS value;
  // every line carries a real number from work actually done).
  const workLog: Array<{ at: string; line: string }> = [];
  const logWork = async (line: string | null): Promise<void> => {
    if (!line) return;
    workLog.push({ at: new Date().toISOString(), line });
    await updateRow({ work_log: workLog });
  };

  // --- Fast tier (Phase C): shared deterministic pulls, fetched ONCE ---------
  // Each dataset is fail-soft: a failed pull turns its sections into honest
  // errors, never kills the audit.
  // leads:actions->lead — ad_daily.results is NULL for most lead-gen accounts;
  // the lead count lives only in the actions JSONB (concept-roas CPR fallback).
  const PACK_AD_COLS = 'ad_id, ad_name, adset_id, date, spend, impressions, purchases, purchase_value, results, leads:actions->lead, frequency, hook_rate, hold_rate';
  let packRows90: PackAdRow[] = [];
  let packRows180: Array<Pick<PackAdRow, 'ad_id' | 'date' | 'spend'>> = [];
  let packAccRows90: PackAccountRow[] = [];
  let accFull30: Array<Record<string, unknown>> = [];
  let landing30: Array<{
    ad_id: string;
    spend: number;
    purchases: number;
    purchase_value: number;
    leads: number | null;
    landing_page_market: string | null;
    landing_page_path: string | null;
  }> = [];
  if (cold) {
    // Cold path: the five row sets were already built from the live Graph pull
    // (buildColdRows) — same shapes, same field semantics as the warehouse.
    packRows90 = cold.rows.packRows90;
    packRows180 = cold.rows.packRows180;
    packAccRows90 = cold.rows.packAccRows90;
    accFull30 = cold.rows.accFull30 as unknown as Array<Record<string, unknown>>;
    landing30 = cold.rows.landing30;
  } else try {
    // Caps sized to the LARGEST account on the desk (NP: 144k ad-day rows/90d).
    // The old 40k cap silently truncated NP to 28% of its rows — concentration
    // and fatigue were computed on an arbitrary subset (caught by the sweep's
    // reconcile check 2026-07-02). If a pull ever hits its cap again, we say so.
    [packRows90, packRows180, packAccRows90, accFull30, landing30] = await Promise.all([
      pageAll<PackAdRow>('ad_daily', PACK_AD_COLS, (q) => q.eq('client_id', client.id).gte('date', daysAgoISO(90)), 250_000),
      pageAll<Pick<PackAdRow, 'ad_id' | 'date' | 'spend'>>('ad_daily', 'ad_id, date, spend', (q) => q.eq('client_id', client.id).gte('date', daysAgoISO(180)), 400_000),
      pageAll<PackAccountRow>('account_daily', 'date, spend, impressions, link_clicks, purchases, purchase_value, results', (q) => q.eq('client_id', client.id).gte('date', daysAgoISO(90)), 200),
      pageAll<Record<string, unknown>>(
        'account_daily',
        'date, spend, impressions, clicks, link_clicks, content_views, add_to_carts, checkouts_initiated, purchases, purchase_value, leads, complete_registrations, results',
        (q) => q.eq('client_id', client.id).gte('date', daysAgoISO(30)),
        200,
      ),
      pageAll<{
        ad_id: string;
        spend: number;
        purchases: number;
        purchase_value: number;
        leads: number | null;
        landing_page_market: string | null;
        landing_page_path: string | null;
      }>(
        'ad_daily',
        'ad_id, spend, purchases, purchase_value, leads:actions->lead, landing_page_market, landing_page_path',
        (q) => q.eq('client_id', client.id).gte('date', daysAgoISO(30)),
        250_000,
      ),
    ]);
    if (packRows90.length >= 250_000 || packRows180.length >= 400_000) {
      dataCaveat = [dataCaveat, 'the ad-level pull hit its row cap — 90d aggregates may be incomplete for this very large account; say so when citing them.']
        .filter(Boolean)
        .join(' ');
      synthSystem = buildSynthSystem(clientKnowledge, dataCaveat);
      logger.error({ code, rows90: packRows90.length, rows180: packRows180.length }, 'report-pack pull hit row cap — aggregates incomplete');
    }
  } catch (err) {
    logger.warn({ err, code }, 'report-pack shared pulls failed (fast sections degrade)');
  }
  const rows30 = packRows90.filter((r) => r.date >= daysAgoISO(30));
  const accountTotals30 = accFull30.length > 0 ? aggregateDaily(accFull30) : null;

  // The recognition strip gets its ads count the moment we know it (seconds in).
  {
    const adsCount = new Set(packRows90.map((r) => r.ad_id)).size;
    const daysCount = new Set(packRows90.map((r) => r.date)).size;
    if (recognition && adsCount > 0) {
      await updateRow({ recognition: { ...recognition, ads_count: adsCount } });
    }
    await logWork(
      adsCount > 0
        ? `Read ${adsCount} ads × ${daysCount} days of ad-level delivery history`
        : `Read the account's delivery history`,
    );
  }

  // Optimization-event configs feed BOTH the correctness report and the
  // Account Model's "what Meta is told to optimize for" fact.
  let adsetConfigsForModel: AdsetConfigLite[] = [];
  const spendByAdset = new Map<string, number>();
  for (const r of rows30) {
    if (!r.adset_id) continue;
    spendByAdset.set(String(r.adset_id), (spendByAdset.get(String(r.adset_id)) ?? 0) + (r.spend || 0));
  }

  // Session-G shared state: sections later in the order reuse earlier reads.
  let savedScorecard: ScorecardEntry[] | null = null;
  let angleByAdIdShared: Map<string, string> | null = null;
  const getAngles = async (): Promise<Map<string, string>> => {
    if (!angleByAdIdShared) angleByAdIdShared = cold ? new Map() : await fetchAngleByAdId(client.id, new Set(rows30.map((r) => r.ad_id)));
    return angleByAdIdShared;
  };
  const auditKpiMode = kpiMode(rows30);

  // ONE own-page Ads Library scrape per audit, memoized: competitor_teardown
  // (own_footprint mode) and the cold creative_analysis media fallback both
  // await the same promise — the Apify dollars and the multi-minute run are
  // never paid twice. A rejection memoizes too (one attempt per audit).
  let ownLibraryPromise: Promise<OwnLibraryScrape> | undefined;
  const getOwnLibrary = (): Promise<OwnLibraryScrape> => {
    ownLibraryPromise ??= (async () => {
      const own = await resolveOwnPage(code, client.adAccountId, cold?.accessToken);
      if (!own) throw new Error('own FB page could not be resolved');
      if (meter.exhausted()) throw new Error(`cost cap reached before scraping ${own.name}`);
      const ads = await apifyScrapePage(own.pageId, 250, meter);
      return { page: own, ads };
    })();
    return ownLibraryPromise;
  };

  const RUNNERS: Record<string, () => Promise<Partial<AuditSection>>> = {
    dataset_health: () => runDatasetHealth(code),
    account_structure: () => runAccountStructure(code),
    spend_concentration: async () => computeConcentration(rows30),
    // breakevenRoas is 1.0 unless the cold lead stated a gross margin (see
    // coldBreakeven above) — warehouse audits are unchanged.
    creative_fatigue: async () => computeFatigue(packRows90, breakevenRoas, client.currency, grossMarginPct),
    // Runs AFTER creative_fatigue in SECTION_ORDER, so it reuses that section's
    // classification — the red "move" dots ARE the unguarded fatiguing ads, so
    // the scatter never re-tallies money the fatigue chapter already counted.
    budget_scatter: async () => {
      const fatAds = (sections['creative_fatigue']?.data as { ads?: FatigueAd[] } | undefined)?.ads ?? [];
      return computeBudgetScatter(rows30, fatAds, breakevenRoas, client.currency, grossMarginPct);
    },
    creative_cohorts: async () => {
      const s = computeCohorts(packRows180);
      // Second cohort view (design batch 4): absolute monthly cohorts over time.
      s.data.cohort_wave = computeCohortWave(packRows180);
      return s;
    },
    cost_trends: async () => computeCostTrend(packAccRows90, client.currency),
    timing_patterns: async () => computeDayOfWeek(packAccRows90),
    // Runs AFTER timing_patterns, whose iteration triggers computeAndSaveScorecard —
    // so savedScorecard (hook/hold cohort bands) is populated. Repackages the
    // already-benchmarked rate dims into the dedicated band chapter; posts a stat.
    how_you_compare: async () => buildComparisonSection(savedScorecard ?? []),
    placement_breakdown: async () => {
      const raw = await fetchInsightsBreakdown(code, client.adAccountId, 'publisher_platform,platform_position', '', cold?.accessToken);
      if (!raw) return { status: 'error', error: 'placement insights pull failed' };
      const rows: PlacementInsightRow[] = raw.map((r) => ({
        publisher_platform: String(r.publisher_platform ?? 'unknown'),
        platform_position: String(r.platform_position ?? 'unknown'),
        spend: Number(r.spend ?? 0),
        impressions: Number(r.impressions ?? 0),
        purchases: purchasesOf(r.actions),
        purchase_value: purchasesOf(r.action_values),
        leads: leadsOf(r.actions),
      }));
      return computePlacementBreakdown(rows, client.currency);
    },
    audience_breakdown: async () => {
      const [demoRaw, geoRaw] = await Promise.all([
        fetchInsightsBreakdown(code, client.adAccountId, 'age,gender', '', cold?.accessToken),
        fetchInsightsBreakdown(code, client.adAccountId, 'country', '', cold?.accessToken),
      ]);
      if (!demoRaw) return { status: 'error', error: 'demographic insights pull failed' };
      const demo: DemoInsightRow[] = demoRaw.map((r) => ({
        age: String(r.age ?? 'unknown'),
        gender: String(r.gender ?? 'unknown'),
        spend: Number(r.spend ?? 0),
        impressions: Number(r.impressions ?? 0),
        purchases: purchasesOf(r.actions),
        purchase_value: purchasesOf(r.action_values),
        leads: leadsOf(r.actions),
      }));
      const geo: GeoInsightRow[] = (geoRaw ?? []).map((r) => ({
        country: String(r.country ?? 'unknown'),
        spend: Number(r.spend ?? 0),
        impressions: Number(r.impressions ?? 0),
        purchases: purchasesOf(r.actions),
        purchase_value: purchasesOf(r.action_values),
        leads: leadsOf(r.actions),
      }));
      return computeAudienceBreakdown(demo, geo, client.currency);
    },
    saturation: async () => {
      const weeks = await fetchWeeklyReach(code, client.adAccountId, cold?.accessToken);
      if (!weeks) return { status: 'error', error: 'weekly reach pull failed' };
      return computeSaturation(weeks, client.currency);
    },
    concept_roas: async () => computeConceptRoas(rows30, await getAngles()),
    creative_diversity: async () => computeCreativeDiversity(rows30, await getAngles(), client.currency),
    whats_working: async () =>
      computeWhatsWorking(
        sections['creative_fatigue']?.data as Parameters<typeof computeWhatsWorking>[0],
        sections['concept_roas']?.data as Parameters<typeof computeWhatsWorking>[1],
        savedScorecard ?? undefined,
        client.currency,
      ),
    optimization_events: async () => {
      adsetConfigsForModel = await fetchAdsetConfigs(code, client.adAccountId, cold?.accessToken);
      const t = accountTotals30 ?? { purchases: 0, leads: 0, purchase_value: 0 };
      return computeOptimizationEvents(adsetConfigsForModel, spendByAdset, {
        purchases: t.purchases ?? 0,
        leads: t.leads ?? 0,
        purchase_value: t.purchase_value ?? 0,
      }, client.currency);
    },
    learning_limited: async () => {
      // Weekly optimization-event rate per ad set from the last 28 days.
      const cut = daysAgoISO(28);
      const weekly = new Map<string, number>();
      for (const r of packRows90) {
        if (!r.adset_id || r.date < cut) continue;
        const events = auditKpiMode === 'roas' ? r.purchases || 0 : r.purchases || r.leads || 0;
        weekly.set(String(r.adset_id), (weekly.get(String(r.adset_id)) ?? 0) + events / 4);
      }
      const adsets = adsetConfigsForModel.length ? adsetConfigsForModel : await fetchAdsetConfigs(code, client.adAccountId, cold?.accessToken);
      return computeLearningLimited(adsets, weekly, spendByAdset, client.currency);
    },
    targeting_split: async () => {
      const specs = await fetchTargetingSpecs(code, client.adAccountId, cold?.accessToken);
      if (!specs) return { status: 'error', error: 'targeting spec pull failed' };
      const kpiByAdset = new Map<string, { value: number; results: number }>();
      for (const r of rows30) {
        if (!r.adset_id) continue;
        const a = kpiByAdset.get(String(r.adset_id)) ?? { value: 0, results: 0 };
        a.value += r.purchase_value || 0;
        a.results += (auditKpiMode === 'roas' ? r.purchases : r.purchases || r.leads) || 0;
        kpiByAdset.set(String(r.adset_id), a);
      }
      return computeTargetingSplit(specs, spendByAdset, kpiByAdset, rows30, client.currency);
    },
    landing_pages: async () => {
      const adRows: LandingAdRow[] = landing30.map((r) => ({
        ad_id: r.ad_id,
        spend: r.spend || 0,
        purchases: r.purchases || 0,
        purchase_value: r.purchase_value || 0,
        leads: r.leads || 0,
        landing_page_path: r.landing_page_path,
      }));
      const byAd = new Map<string, { ad_id: string; ad_name: string; spend: number }>();
      for (const r of rows30) {
        const a = byAd.get(r.ad_id) ?? { ad_id: r.ad_id, ad_name: r.ad_name ?? r.ad_id, spend: 0 };
        a.spend += r.spend || 0;
        if (r.ad_name) a.ad_name = r.ad_name;
        byAd.set(r.ad_id, a);
      }
      // ALL ads with spend in the window (Dan 2026-07-06) — the engine drops the
      // no-longer-delivering ones and dedupes by URL, so this stays cheap.
      const spendingAds = [...byAd.values()].filter((a) => a.spend > 0).sort((a, b) => b.spend - a.spend);
      const { checks, uncheckedUrls } = await checkAdDestinations(code, spendingAds, cold?.accessToken);
      return computeLandingPages(adRows, checks, client.currency, auditKpiMode, uncheckedUrls);
    },
    creative_analysis: async () => {
      const s = await runCreativeAnalysis(code, meter, client, synthSystem);
      // 9:16 creative tiles (design "done 2026-06-25"): give each winner its
      // thumbnail + delivery stats so the page renders tiles, not a row list.
      try {
        const winners = (s.data as { winners?: Array<{ ad_name: string; [k: string]: unknown }> } | undefined)?.winners;
        if (winners?.length) {
          const idByName = new Map<string, string>();
          for (const r of rows30) if (r.ad_name) idByName.set(r.ad_name, r.ad_id);
          const ids = winners.map((w) => idByName.get(w.ad_name)).filter((v): v is string => !!v);
          if (ids.length) {
            const thumbs = await pageAll<{ ad_id: string; thumbnail_url: string | null }>(
              'creatives',
              'ad_id, thumbnail_url',
              (q) => q.in('ad_id', ids),
              200,
            );
            const thumbById = new Map(thumbs.map((t) => [t.ad_id, t.thumbnail_url]));
            const statsById = new Map<string, { hook: number | null; spend: number }>();
            for (const r of rows30) {
              const a = statsById.get(r.ad_id) ?? { hook: null, spend: 0 };
              a.spend += r.spend || 0;
              if (typeof r.hook_rate === 'number' && r.hook_rate > 0) a.hook = Math.round(r.hook_rate * 1000) / 10;
              statsById.set(r.ad_id, a);
            }
            for (const w of winners) {
              const id = idByName.get(w.ad_name);
              if (!id) continue;
              w.thumbnail_url = thumbById.get(id) ?? null;
              w.hook_rate_pct = statsById.get(id)?.hook ?? null;
            }
          }
        }
      } catch (err) {
        logger.warn({ err, code }, 'winner tile enrichment failed (section still valid)');
      }
      return s;
    },
    funnel_read: () => runFunnelRead(code, meter, client, synthSystem, cold ? accFull30 : undefined),
    account_facts: async () => {
      const partnershipIds = await fetchPartnershipAdIds(code, client.adAccountId, cold?.accessToken);
      let partnershipPct: number | null = null;
      if (partnershipIds && partnershipIds.size > 0) {
        const total = rows30.reduce((s, r) => s + (r.spend || 0), 0);
        const flagged = rows30.filter((r) => partnershipIds.has(r.ad_id)).reduce((s, r) => s + (r.spend || 0), 0);
        partnershipPct = total > 0 ? Math.round((flagged / total) * 1000) / 10 : null;
      } else if (partnershipIds) {
        partnershipPct = 0;
      }
      const adNames = new Map<string, string>();
      for (const r of packRows90) if (r.ad_name) adNames.set(r.ad_id, r.ad_name);
      return computeAccountFacts({ rows180: packRows180, adNames, partnershipSpendPct: partnershipPct, currency: client.currency });
    },
    account_activity: async () => {
      // Change history reads live from Meta's activities edge on BOTH paths
      // (cold connection token or the agency token) — no warehouse dependency.
      const res = await fetchAccountActivities(code, client.adAccountId, cold?.accessToken);
      if (!res) return { status: 'error', error: 'account change-history pull failed or is unavailable under ads_read' };
      // Monthly retainer is nullable — unknown at audit time. This is the wire
      // point: when a lead states what they pay their manager, thread it here to
      // light up cost-per-change. Until then the section reports counts only.
      const monthlyRetainer: number | null = null;
      return computeAccountActivity({
        events: res.events,
        currency: client.currency,
        monthlyRetainer,
        partial: res.partial,
      });
    },
    competitor_teardown: () => {
      // Account-side age context for the Library bridge — computed from the
      // SAME rows + helper as the account_facts "longest-running ad" fact, so
      // the two sections can never cite different account-side numbers.
      const accountAge =
        packRows180.length > 0
          ? {
              adsCount: new Set(packRows180.map((r) => r.ad_id)).size,
              longestRunningDays: longestStillSpendingSpan(packRows180)?.spanDays ?? null,
            }
          : undefined;
      return runCompetitorTeardown(code, meter, client, options, synthSystem, getOwnLibrary, accountAge);
    },
  };

  // "Where you stand" scorecard — computed the moment the fast tier is done
  // (seconds in), stored on the row so the page can render it up top while the
  // LLM sections are still cooking. Fail-soft.
  const computeAndSaveScorecard = async (): Promise<void> => {
    try {
      // ad_daily stores hook_rate/hold_rate as FRACTIONS (avg ~0.24 = 24%);
      // the scorecard's unit is '%', so convert here — "median 0.2%" on the
      // page was the fraction leaking through the % label (fixed Session D).
      const weightedRate = (rows: PackAdRow[], key: 'hook_rate' | 'hold_rate'): { value: number; spend: number } => {
        let num = 0; let den = 0;
        for (const r of rows) {
          const v = r[key];
          if (typeof v === 'number' && v > 0 && r.spend > 0) { num += v * r.spend; den += r.spend; }
        }
        return { value: den > 0 ? (num / den) * 100 : 0, spend: den };
      };
      // Cohort: spend-weighted hook/hold per ACCOUNT on our desk, last 7 days.
      // Rates cross accounts safely; money metrics never do (currency).
      const corpus = await pageAll<{ client_id: string; spend: number; hook_rate: number | null; hold_rate: number | null }>(
        'ad_daily', 'client_id, spend, hook_rate, hold_rate', (q) => q.gte('date', daysAgoISO(7)), 40_000,
      );
      const byClient = new Map<string, Array<{ spend: number; hook_rate: number | null; hold_rate: number | null }>>();
      for (const r of corpus) {
        const list = byClient.get(r.client_id) ?? [];
        list.push(r);
        byClient.set(r.client_id, list);
      }
      const cohortOf = (key: 'hook_rate' | 'hold_rate'): number[] =>
        [...byClient.values()]
          .map((rows) => weightedRate(rows as PackAdRow[], key))
          .filter((x) => x.spend >= 100) // accounts with real video spend only
          .map((x) => x.value);
      const cohortLabel = `the ${byClient.size} accounts on our desk (last 7 days)`;

      const ownHooks = weightedRate(rows30, 'hook_rate');
      const ownHold = weightedRate(rows30, 'hold_rate');
      // Video impressions (30d) let the scorecard state the hook gap in PEOPLE
      // on the same spend (pro-trust layer — units the metric owns, never €).
      const videoImps30 = rows30.reduce(
        (s, r) => s + (typeof r.hook_rate === 'number' && r.hook_rate > 0 ? r.impressions || 0 : 0),
        0,
      );
      const inputs: ScorecardInputs = {};
      if (ownHooks.spend >= 100) inputs.hooks = { value: ownHooks.value, cohortValues: cohortOf('hook_rate'), cohortLabel, impressions30: videoImps30 };
      if (ownHold.spend >= 100) inputs.hold = { value: ownHold.value, cohortValues: cohortOf('hold_rate'), cohortLabel };
      const cohortsData = sections['creative_cohorts']?.data as { fresh_cohort_share_pct?: number } | undefined;
      if (typeof cohortsData?.fresh_cohort_share_pct === 'number') inputs.freshness = { value: cohortsData.fresh_cohort_share_pct };
      const concData = sections['spend_concentration']?.data as { top3_share_pct?: number } | undefined;
      if (typeof concData?.top3_share_pct === 'number') inputs.concentration = { value: concData.top3_share_pct };
      const costData = sections['cost_trends']?.data as { cpm_delta_pct?: number } | undefined;
      if (typeof costData?.cpm_delta_pct === 'number') inputs.cpmTrend = { value: costData.cpm_delta_pct };

      const scorecard = buildScorecard(inputs);

      // "We corrected your OWN metric down" — the rewarded-video hook-inflation
      // check (binding ruling #5; the persona test's most trust-building move).
      // One live placement-broken-down pull; fail-soft, only speaks when material.
      try {
        const hooksEntry = scorecard.find((e) => e.key === 'hooks');
        if (hooksEntry) {
          const placementRows = await fetchPlacementHookRows(code, client.adAccountId, cold?.accessToken);
          const correction = placementRows ? computeHookCorrection(placementRows) : null;
          if (correction?.material) {
            hooksEntry.correction = { corrected_value: correction.corrected_pct, note: correction.note };
            await logWork(
              `Checked ${correction.forced_share_pct}% of impressions on forced-view placements — corrected the hook rate ${correction.reported_pct}% → ${correction.corrected_pct}%`,
            );
            logger.info({ code, correction }, 'hook-rate correction applied (rewarded video)');
          }
        }
      } catch (err) {
        logger.warn({ err, code }, 'hook correction failed (scorecard continues uncorrected)');
      }

      if (scorecard.length) await updateRow({ scorecard });
      savedScorecard = scorecard; // later sections (whats_working) read it
      logger.info({ code, dimensions: scorecard.map((e) => `${e.key}:${e.band}`) }, 'scorecard computed');

      // Provisional top-3 lead insights the moment the fast tier lands — the
      // top of the page must never be the LAST thing to arrive (UX review
      // §2.2). The end-of-audit LLM ranking overwrites these.
      const provisional = buildProvisionalInsights(
        scorecard,
        sections['creative_fatigue']?.data as { ads?: FatigueAd[] } | undefined,
        sections['spend_concentration']?.data as Record<string, never> | undefined,
      );
      if (provisional.length) await updateRow({ lead_insights: provisional });
    } catch (err) {
      logger.warn({ err, code }, 'scorecard computation failed (audit continues)');
    }
  };

  // Ad identity + visuals post-pass (fast-tier decoration): the fatigue and
  // concentration rows now carry ad_id — give the ads that actually surface
  // on the page a "view this ad" link (preview_shareable_link) and a creative
  // thumbnail via ONE batched Graph call, then write the enriched section data
  // back through the normal section-save path. Fail-soft everywhere: any
  // Graph error → the report simply renders without previews.
  const enrichAdPreviewsSafely = async (): Promise<void> => {
    try {
      const fatigueData = sections['creative_fatigue']?.data as { ads?: Array<{ ad_id?: string }> } | undefined;
      const concData = sections['spend_concentration']?.data as { top_ads?: Array<{ ad_id?: string }> } | undefined;
      const surfaced = [...(fatigueData?.ads ?? []), ...(concData?.top_ads ?? [])]
        .map((r) => r.ad_id)
        .filter((v): v is string => typeof v === 'string' && v.length > 0);
      const ids = [...new Set(surfaced)].slice(0, AD_PREVIEW_CAP);
      if (ids.length === 0) return;
      const previews = await fetchAdPreviews(code, ids, cold?.accessToken);
      if (previews.size === 0) return;
      if (fatigueData?.ads?.length) {
        fatigueData.ads = mergeAdPreviews(fatigueData.ads, previews)!;
        await saveSection(sections['creative_fatigue']!);
      }
      if (concData?.top_ads?.length) {
        concData.top_ads = mergeAdPreviews(concData.top_ads, previews)!;
        await saveSection(sections['spend_concentration']!);
      }
      logger.info({ code, previewed: previews.size, surfaced: ids.length }, 'ad previews merged into fatigue + concentration sections');
    } catch (err) {
      logger.warn({ err, code }, 'ad preview enrichment failed (audit continues)');
    }
  };

  // The Account Model — the audit WRITES durable context, not just a report
  // (context design C1: the audit is the context bootstrap). Fail-soft.
  const writeAccountModelSafely = async (): Promise<void> => {
    try {
      if (cold) return; // account_models is client_code-keyed; stranger identity lands with tenant-keyed models later
      if (!accountTotals30) return;
      const marketAgg = new Map<string, number>();
      const pathAgg = new Map<string, number>();
      for (const r of landing30) {
        if (r.landing_page_market) marketAgg.set(r.landing_page_market, (marketAgg.get(r.landing_page_market) ?? 0) + num(r.spend));
        if (r.landing_page_path) pathAgg.set(r.landing_page_path, (pathAgg.get(r.landing_page_path) ?? 0) + num(r.spend));
      }
      const goalAgg = new Map<string, number>();
      for (const a of adsetConfigsForModel) {
        const spend = spendByAdset.get(a.adset_id) ?? 0;
        if (spend <= 0) continue;
        const goal = (a.optimization_goal ?? 'UNKNOWN') + (a.custom_event_type ? ` → ${a.custom_event_type}` : '');
        goalAgg.set(goal, (goalAgg.get(goal) ?? 0) + spend);
      }
      const structData = sections['account_structure']?.data as { campaigns?: Array<{ name: string; spend: number }> } | undefined;
      const creativeSpend = rows30.reduce((s, r) => s + (r.spend || 0), 0);
      const videoSpend = rows30.filter((r) => (r.hook_rate ?? 0) > 0 || (r.hold_rate ?? 0) > 0).reduce((s, r) => s + (r.spend || 0), 0);
      const inputs: AccountModelInputs = {
        currency: client.currency,
        observedAt: new Date().toISOString(),
        totals30: {
          spend: accountTotals30.spend ?? 0,
          impressions: accountTotals30.impressions ?? 0,
          purchases: accountTotals30.purchases ?? 0,
          purchase_value: accountTotals30.purchase_value ?? 0,
          leads: accountTotals30.leads ?? 0,
          complete_registrations: accountTotals30.complete_registrations ?? 0,
          add_to_carts: accountTotals30.add_to_carts ?? 0,
          checkouts_initiated: accountTotals30.checkouts_initiated ?? 0,
          content_views: accountTotals30.content_views ?? 0,
        },
        adsWithSpend30: new Set(rows30.filter((r) => (r.spend || 0) > 0).map((r) => r.ad_id)).size,
        videoSpendSharePct: creativeSpend > 0 ? Math.round((videoSpend / creativeSpend) * 100) : null,
        campaigns: structData?.campaigns ?? [],
        markets: [...marketAgg.entries()].map(([market, spend]) => ({ market, spend })),
        landingPaths: [...pathAgg.entries()].map(([path, spend]) => ({ path, spend })),
        optimizationGoals: goalAgg.size > 0 ? [...goalAgg.entries()].map(([goal, spend]) => ({ goal, spend })) : undefined,
      };
      const model = buildAccountModel(inputs);
      await upsertAccountModel(code, auditId, model);
      await logWork(`Wrote down what we understood about your business (${model.facts.length} facts) — check the "correct us" section`);
      logger.info({ code, facts: model.facts.length, businessModel: model.business_model }, 'account model written');
    } catch (err) {
      logger.warn({ err, code }, 'account model write failed (audit continues)');
    }
  };

  let anyError = false;
  // Cold path: creative_analysis is HEAVY (media downloads + Gemini reads) —
  // it launches here as a background task so the tail sections keep landing,
  // and settles before the lead-insight ranking below. The page's
  // "still cooking" state covers it like any other late section.
  let coldCreativePromise: Promise<void> | null = null;
  for (const def of SECTION_ORDER) {
    if (skip.has(def.key)) continue;
    if (cold && def.key === 'creative_analysis') {
      await saveSection({ ...sections[def.key]!, status: 'running' });
      coldCreativePromise = (async () => {
        let partial: Partial<AuditSection>;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          partial = await Promise.race([
            runColdCreativeAnalysis({
              meter,
              accessToken: cold.accessToken,
              accountName: client.name,
              currency: client.currency,
              rows30,
              getOwnLibrary,
              synthesize: <T,>(label: string, user: string) => synthesizeJson<T>(meter, label, synthSystem, user),
            }),
            new Promise<Partial<AuditSection>>((resolve) => {
              timer = setTimeout(
                () => resolve({ status: 'error', error: 'creative analysis timed out after 8 minutes' }),
                8 * 60_000,
              );
            }),
          ]);
        } catch (err) {
          partial = { status: 'error', error: err instanceof Error ? err.message : String(err) };
          logger.error({ err, section: 'creative_analysis' }, 'cold creative analysis failed');
        } finally {
          clearTimeout(timer);
        }
        await saveSection({
          ...sections['creative_analysis']!,
          ...partial,
          status: partial.status ?? 'complete',
          completed_at: new Date().toISOString(),
        });
        if (partial.status === 'error') anyError = true;
        else await logWork(workLineFor('creative_analysis', sections['creative_analysis']!));
      })();
      continue;
    }
    const runner = RUNNERS[def.key];
    if (!runner) continue;
    await saveSection({ ...sections[def.key]!, status: 'running' });
    try {
      const partial = await runner();
      await saveSection({
        ...sections[def.key]!,
        ...partial,
        status: partial.status ?? 'complete',
        completed_at: new Date().toISOString(),
      });
      if (partial.status === 'error') anyError = true;
      else await logWork(workLineFor(def.key, sections[def.key]!));
    } catch (err) {
      anyError = true;
      await saveSection({
        ...sections[def.key]!,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      logger.error({ err, section: def.key }, 'audit section failed');
    }
    // The 5-report fast tier ends at timing_patterns — the scorecard +
    // provisional lead insights land NOW (seconds in), not after the LLM
    // sections finish minutes later. The ad-preview decoration rides the same
    // beat: fatigue + concentration are already stored, so their rows get
    // their "view this ad" links + thumbnails before the heavy sections cook.
    if (def.key === 'timing_patterns') {
      await computeAndSaveScorecard();
      await enrichAdPreviewsSafely();
    }
    // All deterministic evidence is in after the ad-set config read — write
    // the Account Model here so the "correct us" section renders early too.
    if (def.key === 'optimization_events') await writeAccountModelSafely();
  }

  // Settle the background cold creative section before ranking — the lead
  // insights should see what we found in the actual creatives.
  if (coldCreativePromise) await coldCreativePromise;

  // B3 — rank the lead insights across everything that completed
  try {
    const insights = await rankLeadInsights(meter, client, sections, synthSystem);
    if (insights) await updateRow({ lead_insights: insights });
  } catch (err) {
    logger.warn({ err }, 'lead-insight ranking failed (report still valid)');
  }

  await updateRow({ status: anyError ? 'error' : 'complete', cost_usd: round2(meter.spentUsd) });
  logger.info(
    { auditId, anyError, costUsd: round2(meter.spentUsd), breakdown: meter.breakdown },
    'Magic audit finished',
  );
  return { auditId, token, costUsd: round2(meter.spentUsd) };
}
