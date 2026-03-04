/**
 * Creative Audit Script — Phase 0B
 *
 * Maps current ad accounts into Format × Angle × Style coordinates.
 * Uses Haiku to classify each active creative, then generates per-client
 * distribution reports and saves to the creative_audits table.
 *
 * Usage:
 *   pnpm creative-audit                           # Full run, all clients
 *   pnpm creative-audit -- --client ninepine       # Single client
 *   pnpm creative-audit -- --dry-run               # Preview without saving
 *   pnpm creative-audit -- --days 30               # Lookback window (default 30)
 *   pnpm creative-audit -- --concurrency 3         # Parallel Haiku calls (default 2)
 */

import Anthropic from "@anthropic-ai/sdk";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CLASSIFICATION_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_DAYS = 30;
const DEFAULT_CONCURRENCY = 2;
const REQUEST_DELAY_MS = 500;

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DAI_SUPABASE_URL = process.env.DAI_SUPABASE_URL;
const DAI_SUPABASE_SERVICE_KEY = process.env.DAI_SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY (BMAD)");
  process.exit(1);
}
if (!DAI_SUPABASE_URL || !DAI_SUPABASE_SERVICE_KEY) {
  console.error("Missing DAI_SUPABASE_URL or DAI_SUPABASE_SERVICE_KEY");
  process.exit(1);
}
if (!ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY");
  process.exit(1);
}

const bmad: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const dai: SupabaseClient = createClient(DAI_SUPABASE_URL, DAI_SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Creative {
  creative_id: string;
  ad_id: string;
  ad_name: string | null;
  ad_type: string | null;
  format: string | null;
  primary_text: string | null;
  headline: string | null;
  transcript: string | null;
  video_duration_seconds: number | null;
  hook_score: number | null;
  watch_score: number | null;
  click_score: number | null;
  convert_score: number | null;
  ai_tags: string[] | null;
  client_code: string;
  total_spend: number;
}

interface Classification {
  format_code: string;
  angle_code: string;
  style: string;
  confidence: "high" | "medium" | "low";
}

interface ClassifiedCreative extends Creative {
  classification: Classification;
}

// ---------------------------------------------------------------------------
// Format/Angle definitions for prompt
// ---------------------------------------------------------------------------

const FORMATS = `F01:Talking Head, F02:Interview/Podcast, F03:Product Demo, F04:Unboxing/Reveal, F05:Voiceover+B-roll, F06:Split Screen, F07:Screen Recording, F08:Documentary/Mini-Doc, F09:Reaction/Duet, F10:ASMR/Sensory, F11:Stop Motion/Animation, F12:Photo Slideshow, F13:Compilation/Mashup, F14:Static, F15:Carousel, F16:No-Ads Ad (Organic), F17:Two-Person`;

const ANGLES = `A01:Problem→Solution, A02:Social Proof, A03:Authority/Expert, A04:Founder Story, A05:Comparison/Us vs Them, A06:Education/How-To, A07:Lifestyle/Identity, A08:Behind the Scenes, A09:Ingredient/Science, A10:Use-Case/Occasion, A11:Transformation, A12:Scarcity/FOMO, A13:Myth-Busting, A14:Review/Testimonial, A15:Unboxing/First Impression`;

const STYLES = `lo-fi, hi-fi, energetic, calm, funny, emotional, clinical, aspirational`;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}
const isDryRun = args.includes("--dry-run");
const clientFilter = getArg("client");
const days = parseInt(getArg("days") ?? String(DEFAULT_DAYS), 10);
const concurrency = parseInt(getArg("concurrency") ?? String(DEFAULT_CONCURRENCY), 10);

// ---------------------------------------------------------------------------
// Fetch active creatives with spend data
// ---------------------------------------------------------------------------

async function fetchActiveCreatives(clientCode?: string): Promise<Creative[]> {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);

  // Get clients
  let clientQuery = bmad.from("clients").select("id, code");
  if (clientCode) {
    clientQuery = clientQuery.eq("code", clientCode);
  }
  const { data: clients, error: clientErr } = await clientQuery;
  if (clientErr || !clients?.length) {
    console.error("Failed to fetch clients:", clientErr?.message ?? "no clients found");
    return [];
  }

  const allCreatives: Creative[] = [];

  for (const client of clients) {
    // Get ad-level spend totals for the period
    const { data: adSpend, error: spendErr } = await bmad
      .from("ad_daily")
      .select("ad_id, spend")
      .eq("client_id", client.id)
      .gte("date", sinceStr);

    if (spendErr) {
      console.error(`Failed to fetch ad spend for ${client.code}:`, spendErr.message);
      continue;
    }

    // Aggregate spend per ad_id
    const spendByAd = new Map<string, number>();
    for (const row of adSpend ?? []) {
      const current = spendByAd.get(row.ad_id) ?? 0;
      spendByAd.set(row.ad_id, current + (row.spend ?? 0));
    }

    // Filter to ads with spend > 0
    const activeAdIds = [...spendByAd.entries()]
      .filter(([, spend]) => spend > 0)
      .map(([id]) => id);

    if (activeAdIds.length === 0) continue;

    // Fetch creative details for active ads (batch in chunks of 100)
    for (let i = 0; i < activeAdIds.length; i += 100) {
      const batch = activeAdIds.slice(i, i + 100);
      const { data: creatives, error: creativeErr } = await bmad
        .from("creatives")
        .select("creative_id, ad_id, ad_name, ad_type, format, primary_text, headline, transcript, video_duration_seconds, hook_score, watch_score, click_score, convert_score, ai_tags")
        .eq("client_id", client.id)
        .in("ad_id", batch);

      if (creativeErr) {
        console.error(`Failed to fetch creatives for ${client.code}:`, creativeErr.message);
        continue;
      }

      for (const c of creatives ?? []) {
        allCreatives.push({
          ...c,
          client_code: client.code,
          total_spend: spendByAd.get(c.ad_id) ?? 0,
        });
      }
    }
  }

  return allCreatives;
}

// ---------------------------------------------------------------------------
// Classify a creative via Haiku
// ---------------------------------------------------------------------------

async function classifyCreative(creative: Creative): Promise<Classification> {
  const info = [
    `Ad name: ${creative.ad_name ?? "unknown"}`,
    `Type: ${creative.ad_type ?? "unknown"}`,
    `Format field: ${creative.format ?? "unknown"}`,
    creative.transcript ? `Transcript: ${creative.transcript.slice(0, 500)}` : null,
    creative.primary_text ? `Primary text: ${creative.primary_text.slice(0, 300)}` : null,
    creative.headline ? `Headline: ${creative.headline}` : null,
    creative.video_duration_seconds ? `Duration: ${creative.video_duration_seconds}s` : null,
    creative.ai_tags?.length ? `Tags: ${creative.ai_tags.join(", ")}` : null,
  ].filter(Boolean).join("\n");

  const response = await anthropic.messages.create({
    model: CLASSIFICATION_MODEL,
    max_tokens: 200,
    messages: [
      {
        role: "user",
        content: `Classify this ad creative into creative coordinates.

FORMATS: ${FORMATS}
ANGLES: ${ANGLES}
STYLES: ${STYLES}

AD INFO:
${info}

Respond with ONLY a JSON object (no markdown):
{"format_code":"F??","angle_code":"A??","style":"...","confidence":"high|medium|low"}`,
      },
    ],
  });

  const text = response.content[0]?.type === "text" ? response.content[0].text : "";
  try {
    const parsed = JSON.parse(text.trim());
    return {
      format_code: parsed.format_code ?? "F14",
      angle_code: parsed.angle_code ?? "A01",
      style: parsed.style ?? "lo-fi",
      confidence: parsed.confidence ?? "low",
    };
  } catch {
    console.warn(`Failed to parse classification for ${creative.ad_name}: ${text}`);
    return { format_code: "F14", angle_code: "A01", style: "lo-fi", confidence: "low" };
  }
}

// ---------------------------------------------------------------------------
// Batch classify with concurrency limit
// ---------------------------------------------------------------------------

async function classifyAll(creatives: Creative[]): Promise<ClassifiedCreative[]> {
  const results: ClassifiedCreative[] = [];
  let processed = 0;

  for (let i = 0; i < creatives.length; i += concurrency) {
    const batch = creatives.slice(i, i + concurrency);
    const classifications = await Promise.all(
      batch.map((c) => classifyCreative(c)),
    );

    for (let j = 0; j < batch.length; j++) {
      results.push({ ...batch[j]!, classification: classifications[j]! });
    }

    processed += batch.length;
    if (processed % 10 === 0 || processed === creatives.length) {
      console.log(`  Classified ${processed}/${creatives.length}`);
    }

    if (i + concurrency < creatives.length) {
      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Generate audit report per client
// ---------------------------------------------------------------------------

interface AuditReport {
  client_code: string;
  format_distribution: Record<string, { spend_pct: number; count: number; spend: number }>;
  angle_distribution: Record<string, { spend_pct: number; count: number; spend: number }>;
  style_distribution: Record<string, { spend_pct: number; count: number }>;
  gap_matrix: { untested: string[]; underweight: string[] };
  top_performers: Array<{
    ad_id: string;
    ad_name: string | null;
    format: string;
    angle: string;
    style: string;
    spend: number;
    hook_score: number | null;
  }>;
  total_spend: number;
  total_ads: number;
}

function generateReport(clientCode: string, creatives: ClassifiedCreative[]): AuditReport {
  const totalSpend = creatives.reduce((sum, c) => sum + c.total_spend, 0);

  // Format distribution
  const formatMap = new Map<string, { count: number; spend: number }>();
  const angleMap = new Map<string, { count: number; spend: number }>();
  const styleMap = new Map<string, { count: number }>();
  const testedCombos = new Set<string>();

  for (const c of creatives) {
    const { format_code, angle_code, style } = c.classification;

    const fEntry = formatMap.get(format_code) ?? { count: 0, spend: 0 };
    fEntry.count++;
    fEntry.spend += c.total_spend;
    formatMap.set(format_code, fEntry);

    const aEntry = angleMap.get(angle_code) ?? { count: 0, spend: 0 };
    aEntry.count++;
    aEntry.spend += c.total_spend;
    angleMap.set(angle_code, aEntry);

    const sEntry = styleMap.get(style) ?? { count: 0 };
    sEntry.count++;
    styleMap.set(style, sEntry);

    testedCombos.add(`${format_code}×${angle_code}`);
  }

  const formatDist: AuditReport["format_distribution"] = {};
  for (const [code, data] of formatMap) {
    formatDist[code] = { ...data, spend_pct: totalSpend > 0 ? data.spend / totalSpend : 0 };
  }

  const angleDist: AuditReport["angle_distribution"] = {};
  for (const [code, data] of angleMap) {
    angleDist[code] = { ...data, spend_pct: totalSpend > 0 ? data.spend / totalSpend : 0 };
  }

  const styleDist: AuditReport["style_distribution"] = {};
  for (const [style, data] of styleMap) {
    styleDist[style] = data;
  }

  // Gap matrix: all possible F×A combos minus tested ones
  const allFormats = Array.from({ length: 17 }, (_, i) => `F${String(i + 1).padStart(2, "0")}`);
  const allAngles = Array.from({ length: 15 }, (_, i) => `A${String(i + 1).padStart(2, "0")}`);
  const untested: string[] = [];
  const underweight: string[] = [];

  for (const f of allFormats) {
    for (const a of allAngles) {
      const combo = `${f}×${a}`;
      if (!testedCombos.has(combo)) {
        untested.push(combo);
      }
    }
  }

  // Underweight: combos with < 5% spend despite being tested
  for (const combo of testedCombos) {
    const [f, a] = combo.split("×");
    const fSpendPct = formatDist[f!]?.spend_pct ?? 0;
    const aSpendPct = angleDist[a!]?.spend_pct ?? 0;
    if (fSpendPct < 0.05 && aSpendPct < 0.05) {
      underweight.push(combo);
    }
  }

  // Top performers (by hook_score, fallback to spend)
  const sorted = [...creatives].sort((a, b) => {
    const aScore = a.hook_score ?? 0;
    const bScore = b.hook_score ?? 0;
    return bScore - aScore || b.total_spend - a.total_spend;
  });

  const topPerformers = sorted.slice(0, 10).map((c) => ({
    ad_id: c.ad_id,
    ad_name: c.ad_name,
    format: c.classification.format_code,
    angle: c.classification.angle_code,
    style: c.classification.style,
    spend: c.total_spend,
    hook_score: c.hook_score,
  }));

  return {
    client_code: clientCode,
    format_distribution: formatDist,
    angle_distribution: angleDist,
    style_distribution: styleDist,
    gap_matrix: { untested, underweight },
    top_performers: topPerformers,
    total_spend: totalSpend,
    total_ads: creatives.length,
  };
}

// ---------------------------------------------------------------------------
// Save audit to DAI Supabase
// ---------------------------------------------------------------------------

async function saveAudit(report: AuditReport): Promise<void> {
  const { error } = await dai.from("creative_audits").insert({
    client_code: report.client_code,
    format_distribution: report.format_distribution,
    angle_distribution: report.angle_distribution,
    style_distribution: report.style_distribution,
    gap_matrix: report.gap_matrix,
    top_performers: report.top_performers,
    total_spend: report.total_spend,
    total_ads: report.total_ads,
  });

  if (error) {
    console.error(`Failed to save audit for ${report.client_code}:`, error.message);
  } else {
    console.log(`  Saved audit for ${report.client_code}`);
  }
}

// ---------------------------------------------------------------------------
// Print summary
// ---------------------------------------------------------------------------

function printSummary(report: AuditReport): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${report.client_code.toUpperCase()} — ${report.total_ads} ads, $${report.total_spend.toFixed(2)} total spend`);
  console.log("=".repeat(60));

  console.log("\nFormat Distribution:");
  const fEntries = Object.entries(report.format_distribution).sort((a, b) => b[1].spend_pct - a[1].spend_pct);
  for (const [code, data] of fEntries) {
    const bar = "#".repeat(Math.round(data.spend_pct * 40));
    console.log(`  ${code}  ${bar} ${(data.spend_pct * 100).toFixed(1)}% (${data.count} ads)`);
  }

  console.log("\nAngle Distribution:");
  const aEntries = Object.entries(report.angle_distribution).sort((a, b) => b[1].spend_pct - a[1].spend_pct);
  for (const [code, data] of aEntries) {
    const bar = "#".repeat(Math.round(data.spend_pct * 40));
    console.log(`  ${code}  ${bar} ${(data.spend_pct * 100).toFixed(1)}% (${data.count} ads)`);
  }

  console.log(`\nGap Matrix: ${report.gap_matrix.untested.length} untested combos, ${report.gap_matrix.underweight.length} underweight`);

  if (report.top_performers.length > 0) {
    console.log("\nTop Performers:");
    for (const tp of report.top_performers.slice(0, 5)) {
      console.log(`  ${tp.ad_name ?? tp.ad_id} — ${tp.format}×${tp.angle}×${tp.style} (hook: ${tp.hook_score ?? "n/a"}, spend: $${tp.spend.toFixed(2)})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Creative Audit — last ${days} days${clientFilter ? ` (client: ${clientFilter})` : " (all clients)"}`);
  if (isDryRun) console.log("DRY RUN — will not save to Supabase\n");

  // 1. Fetch active creatives
  console.log("Fetching active creatives from BMAD...");
  const creatives = await fetchActiveCreatives(clientFilter);
  console.log(`Found ${creatives.length} active creatives`);

  if (creatives.length === 0) {
    console.log("No active creatives found. Done.");
    return;
  }

  // 2. Classify each creative via Haiku
  console.log("\nClassifying creatives...");
  const classified = await classifyAll(creatives);

  // 3. Group by client and generate reports
  const byClient = new Map<string, ClassifiedCreative[]>();
  for (const c of classified) {
    const arr = byClient.get(c.client_code) ?? [];
    arr.push(c);
    byClient.set(c.client_code, arr);
  }

  // 4. Generate and save reports
  for (const [clientCode, clientCreatives] of byClient) {
    const report = generateReport(clientCode, clientCreatives);
    printSummary(report);

    if (!isDryRun) {
      await saveAudit(report);
    }
  }

  console.log(`\nDone! Processed ${classified.length} creatives across ${byClient.size} clients.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
