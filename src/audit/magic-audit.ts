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

const SECTION_ORDER: Array<Pick<AuditSection, 'key' | 'title' | 'status'>> = [
  { key: 'dataset_health', title: 'Data Foundation — pixel, CAPI & match quality', status: 'pending' },
  { key: 'account_structure', title: 'Account Structure & Spend Concentration', status: 'pending' },
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
  ].filter(([, v]) => v > 0 || true);
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

/** Resolve the client's own FB page from a live ad's effective_object_story_id. */
async function resolveOwnPage(clientCode: string, adAccountId: string | null): Promise<{ name: string; pageId: string } | null> {
  if (!adAccountId) return null;
  const e = process.env;
  const GROWTHSQUAD = new Set(['LA', 'LA2', 'TL']);
  const token = GROWTHSQUAD.has(clientCode.toUpperCase()) && e.META_ACCESS_TOKEN_GROWTHSQUAD
    ? e.META_ACCESS_TOKEN_GROWTHSQUAD
    : env.META_ACCESS_TOKEN;
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

  const { data: row, error } = await supabase
    .from('magic_audits')
    .insert({ token, client_code: code, client_name: client.name, sections })
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

  const RUNNERS: Record<string, () => Promise<Partial<AuditSection>>> = {
    dataset_health: () => runDatasetHealth(code),
    account_structure: () => runAccountStructure(code),
    creative_analysis: () => runCreativeAnalysis(code, meter, client, synthSystem),
    funnel_read: () => runFunnelRead(code, meter, client, synthSystem),
    competitor_teardown: () => runCompetitorTeardown(code, meter, client, options, synthSystem),
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
    } catch (err) {
      anyError = true;
      await saveSection({
        ...sections[def.key]!,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      logger.error({ err, section: def.key }, 'audit section failed');
    }
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
