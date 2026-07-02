import { randomBytes } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { getSupabase } from '../integrations/supabase.js';
import { executeTool } from '../agents/tool-registry.js';
import type { ToolContext } from '../agents/tool-registry.js';
import { estimateCostUsd } from '../agents/runner.js';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import { extractJson, triageLibrary, type LibraryAd } from './library-triage.js';
import { buildClientKnowledgeBundle } from '../agents/client-context.js';
import {
  computeConcentration, computeFatigue, computeCohorts, computeCostTrend, computeDayOfWeek,
  computeConceptRoas, computeOptimizationEvents, buildProvisionalInsights,
  type PackAdRow, type PackAccountRow, type AdsetConfigLite, type FatigueAd,
} from './report-pack.js';
import { buildScorecard, type ScorecardInputs } from './scorecard.js';
import { buildAccountModel, mergeAccountModel, type AccountModel, type AccountModelInputs } from './account-model.js';

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
}

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
  { key: 'creative_cohorts', title: 'Creative Cohorts — living off old creative?', status: 'pending' },
  { key: 'cost_trends', title: 'CPM & Auction Pressure', status: 'pending' },
  { key: 'timing_patterns', title: 'Day-of-Week Pattern', status: 'pending' },
  { key: 'concept_roas', title: 'Creative Angles — spend vs return by concept', status: 'pending' },
  { key: 'optimization_events', title: 'Optimization Events — is Meta hunting the right thing?', status: 'pending' },
  { key: 'creative_analysis', title: 'Creative Performance & Angles', status: 'pending' },
  { key: 'funnel_read', title: 'Funnel Diagnosis', status: 'pending' },
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
  const stream = getAnthropic().messages.stream({
    model: AUDIT_MODEL,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    system: [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }],
    messages: [{ role: 'user', content: user }],
  });
  const final = await stream.finalMessage();
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
    const repair = getAnthropic().messages.stream({
      model: AUDIT_MODEL,
      max_tokens: 4000,
      system: 'You repair malformed JSON. Return ONLY the corrected, complete JSON object — no markdown, no commentary, no explanation.',
      messages: [{ role: 'user', content: `This JSON is malformed (parser said: ${msg}). Repair it, preserving all content:\n${text}` }],
    });
    const fixed = await repair.finalMessage();
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
): Promise<Partial<AuditSection>> {
  const rows30 = await pageAll<Record<string, unknown>>(
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
async function resolveOwnPage(clientCode: string, adAccountId: string | null): Promise<{ name: string; pageId: string } | null> {
  if (!adAccountId) return null;
  const token = metaTokenFor(clientCode);
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
): Promise<Partial<AuditSection>> {
  let targets = options.competitorPages ?? [];
  let mode: 'competitors' | 'own_footprint' = 'competitors';
  if (targets.length === 0) {
    const own = await resolveOwnPage(clientCode, client.adAccountId);
    if (!own) return { status: 'error', error: 'no competitor pages given and own FB page could not be resolved' };
    targets = [own];
    mode = 'own_footprint';
  }

  const perPage: Array<{ name: string; pageId: string; triage: Record<string, unknown> }> = [];
  const scrapeWarnings: string[] = [];
  for (const t of targets.slice(0, 3)) {
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

  const synth = await synthesizeJson<CompetitorSynthesis>(
    meter,
    'competitor_teardown',
    synthSystem,
    `Public Facebook Ads Library scrape (deterministic triage, weights = ad-cluster size as spend proxy):\n` +
      `Mode: ${mode === 'own_footprint' ? `the client's OWN public footprint (page: ${perPage[0]!.name})` : 'competitor pages'}\n` +
      `Client: ${client.name}\n${JSON.stringify(perPage, null, 1)}\n\n` +
      `Write the "Ads Library Landscape" audit section. Velocity rule: oldest active ad >120d means evergreen winners exist (name the signal); <60d means rotation cadence IS the strategy. ` +
      `Catalog note: catalog_dynamic_weight_share_pct is the share of catalog/dynamic (DPA) creative — its {{...}} template tokens render per-product at serve time and are already excluded from top_hooks; NEVER describe template tokens as broken, unrendered, or a QA failure. Schema:\n` +
      `{"summary":"2-3 sentences with the headline strategic read and at least two numbers",` +
      `"pages":[per page {"page_name","velocity_read","dominant_messages":[up to 3 short strings from the top hooks],"lp_strategy":"1 sentence from the landing-path concentration"}],` +
      `"open_lanes":[up to 3 strings — angles/formats visibly NOT used that ${mode === 'own_footprint' ? 'the brand' : 'the client'} could take],` +
      `"warnings":[up to 2 strings]}`,
  );

  const data = { mode, pages: perPage, narrative: synth ? { pages: synth.pages, open_lanes: synth.open_lanes } : undefined };

  if (!synth) {
    const p = perPage[0]!;
    return {
      status: 'complete',
      summary: `${p.name}: ${String((p.triage as { page_total_active?: unknown }).page_total_active)} active ads in the public library (cost cap reached before narrative synthesis).`,
      data,
      warnings: scrapeWarnings,
    };
  }
  return { status: 'complete', summary: synth.summary, data, warnings: [...(synth.warnings ?? []), ...scrapeWarnings] };
}

// ---------------------------------------------------------------------------
// Session D — read-only adset configs, angle map, account model, recognition
// ---------------------------------------------------------------------------

/** READ-ONLY GET of ad-set optimization configs. Audits never write to Meta. */
async function fetchAdsetConfigs(clientCode: string, adAccountId: string | null): Promise<AdsetConfigLite[]> {
  if (!adAccountId) return [];
  const token = metaTokenFor(clientCode);
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
    case 'creative_cohorts':
      return typeof d.window_months === 'number' ? `Rebuilt ${d.window_months} months of creative launch cohorts` : null;
    case 'cost_trends': {
      const n = (d.series as unknown[] | undefined)?.length ?? 0;
      return n ? `Read ${n} weeks of CPM × CTR history` : null;
    }
    case 'timing_patterns':
      return `Split 90 days of results by weekday`;
    case 'concept_roas':
      return typeof d.coverage_pct === 'number' ? `Matched creative angle tags on ${d.coverage_pct}% of spend` : null;
    case 'optimization_events': {
      // counts covers ALL assessed ad sets; data.rows is capped for display.
      const c = d.counts as { check: number; x: number; question: number } | undefined;
      const n = c ? c.check + c.x + c.question : 0;
      return n ? `Read the optimization goal on ${n} spending ad sets` : null;
    }
    case 'creative_analysis':
      return typeof d.ads_with_spend === 'number' ? `Read the copy + transcripts of the top spenders (${d.ads_with_spend} ads in market)` : null;
    case 'funnel_read':
      return `Walked the funnel stage by stage (30 days)`;
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
  const code = clientCode.toUpperCase();
  const meter = new CostMeter(options.maxCostUsd ?? 10);
  const skip = new Set(options.skipSections ?? []);

  const client = await resolveClient(code);
  if (!client) throw new Error(`client ${code} not found`);

  // Phase B (context layer): assemble this client's knowledge bundle ONCE
  // (targets/KPI config + client-scoped learnings + the intelligence file) and
  // the days-with-data preflight; every synthesis call sees both via the
  // system prompt. Fail-soft — an audit without context still runs.
  let clientKnowledge = '';
  try {
    clientKnowledge = await buildClientKnowledgeBundle(code);
  } catch (err) {
    logger.warn({ err, code }, 'client knowledge bundle failed (audit continues without it)');
  }
  let dataCaveat: string | null = null;
  let daysWithData: number | null = null;
  try {
    const dateRows = await pageAll<{ date: string }>(
      'ad_daily',
      'date',
      (q) => q.eq('client_id', client.id).gte('date', daysAgoISO(30)),
    );
    const win = summarizeDataWindow(dateRows.map((r) => r.date));
    daysWithData = win.daysWithData;
    dataCaveat = win.caveat;
  } catch (err) {
    logger.warn({ err, code }, 'days-with-data preflight failed (audit continues)');
  }
  const synthSystem = buildSynthSystem(clientKnowledge, dataCaveat);
  logger.info(
    { code, knowledgeChars: clientKnowledge.length, daysWithData, thinWindow: !!dataCaveat },
    'audit client context assembled',
  );

  const token = randomBytes(16).toString('hex');
  const sections: Record<string, AuditSection> = {};
  for (const s of SECTION_ORDER) sections[s.key] = { ...s, status: skip.has(s.key) ? 'planned' : s.status };

  // Recognition strip — seeded AT insert so the very first paint already says
  // "that's MY account" (UX review §2.1: recognition is the first magic beat).
  const recognition = await quickRecognition(client.id, client.currency);

  const { data: row, error } = await supabase
    .from('magic_audits')
    .insert({ token, client_code: code, client_name: client.name, sections, recognition })
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
  const PACK_AD_COLS = 'ad_id, ad_name, adset_id, date, spend, impressions, purchases, purchase_value, results, frequency, hook_rate, hold_rate';
  let packRows90: PackAdRow[] = [];
  let packRows180: Array<Pick<PackAdRow, 'ad_id' | 'date' | 'spend'>> = [];
  let packAccRows90: PackAccountRow[] = [];
  let accFull30: Array<Record<string, unknown>> = [];
  let landing30: Array<{ spend: number; landing_page_market: string | null; landing_page_path: string | null }> = [];
  try {
    [packRows90, packRows180, packAccRows90, accFull30, landing30] = await Promise.all([
      pageAll<PackAdRow>('ad_daily', PACK_AD_COLS, (q) => q.eq('client_id', client.id).gte('date', daysAgoISO(90)), 40_000),
      pageAll<Pick<PackAdRow, 'ad_id' | 'date' | 'spend'>>('ad_daily', 'ad_id, date, spend', (q) => q.eq('client_id', client.id).gte('date', daysAgoISO(180)), 60_000),
      pageAll<PackAccountRow>('account_daily', 'date, spend, impressions, link_clicks, purchases, purchase_value, results', (q) => q.eq('client_id', client.id).gte('date', daysAgoISO(90)), 200),
      pageAll<Record<string, unknown>>(
        'account_daily',
        'date, spend, impressions, clicks, link_clicks, content_views, add_to_carts, checkouts_initiated, purchases, purchase_value, leads, complete_registrations, results',
        (q) => q.eq('client_id', client.id).gte('date', daysAgoISO(30)),
        200,
      ),
      pageAll<{ spend: number; landing_page_market: string | null; landing_page_path: string | null }>(
        'ad_daily',
        'spend, landing_page_market, landing_page_path',
        (q) => q.eq('client_id', client.id).gte('date', daysAgoISO(30)),
        40_000,
      ),
    ]);
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

  const RUNNERS: Record<string, () => Promise<Partial<AuditSection>>> = {
    dataset_health: () => runDatasetHealth(code),
    account_structure: () => runAccountStructure(code),
    spend_concentration: async () => computeConcentration(rows30),
    creative_fatigue: async () => computeFatigue(packRows90),
    creative_cohorts: async () => computeCohorts(packRows180),
    cost_trends: async () => computeCostTrend(packAccRows90),
    timing_patterns: async () => computeDayOfWeek(packAccRows90),
    concept_roas: async () => {
      const angleByAdId = await fetchAngleByAdId(client.id, new Set(rows30.map((r) => r.ad_id)));
      return computeConceptRoas(rows30, angleByAdId);
    },
    optimization_events: async () => {
      adsetConfigsForModel = await fetchAdsetConfigs(code, client.adAccountId);
      const t = accountTotals30 ?? { purchases: 0, leads: 0, purchase_value: 0 };
      return computeOptimizationEvents(adsetConfigsForModel, spendByAdset, {
        purchases: t.purchases ?? 0,
        leads: t.leads ?? 0,
        purchase_value: t.purchase_value ?? 0,
      });
    },
    creative_analysis: () => runCreativeAnalysis(code, meter, client, synthSystem),
    funnel_read: () => runFunnelRead(code, meter, client, synthSystem),
    competitor_teardown: () => runCompetitorTeardown(code, meter, client, options, synthSystem),
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
      const inputs: ScorecardInputs = {};
      if (ownHooks.spend >= 100) inputs.hooks = { value: ownHooks.value, cohortValues: cohortOf('hook_rate'), cohortLabel };
      if (ownHold.spend >= 100) inputs.hold = { value: ownHold.value, cohortValues: cohortOf('hold_rate'), cohortLabel };
      const cohortsData = sections['creative_cohorts']?.data as { fresh_cohort_share_pct?: number } | undefined;
      if (typeof cohortsData?.fresh_cohort_share_pct === 'number') inputs.freshness = { value: cohortsData.fresh_cohort_share_pct };
      const concData = sections['spend_concentration']?.data as { top3_share_pct?: number } | undefined;
      if (typeof concData?.top3_share_pct === 'number') inputs.concentration = { value: concData.top3_share_pct };
      const costData = sections['cost_trends']?.data as { cpm_delta_pct?: number } | undefined;
      if (typeof costData?.cpm_delta_pct === 'number') inputs.cpmTrend = { value: costData.cpm_delta_pct };

      const scorecard = buildScorecard(inputs);
      if (scorecard.length) await updateRow({ scorecard });
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

  // The Account Model — the audit WRITES durable context, not just a report
  // (context design C1: the audit is the context bootstrap). Fail-soft.
  const writeAccountModelSafely = async (): Promise<void> => {
    try {
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
  for (const def of SECTION_ORDER) {
    if (skip.has(def.key)) continue;
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
    // sections finish minutes later.
    if (def.key === 'timing_patterns') await computeAndSaveScorecard();
    // All deterministic evidence is in after the ad-set config read — write
    // the Account Model here so the "correct us" section renders early too.
    if (def.key === 'optimization_events') await writeAccountModelSafely();
  }

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
