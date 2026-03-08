/**
 * Live Creative Classification — Phase 2B
 *
 * Nightly job that auto-classifies unclassified BMAD creatives into
 * Format × Angle × Style coordinates using Haiku.
 *
 * Stores coordinates directly on the BMAD `creatives` table:
 *   format_code (F01-F17), angle_code (A01-A15), style_tags (JSONB)
 *
 * Also refreshes the creative audit in the DAI `creative_audits` table.
 */

import Anthropic from "@anthropic-ai/sdk";
import { getSupabase } from "../integrations/supabase.js";
import { getDaiSupabase } from "../integrations/dai-supabase.js";
import { env } from "../env.js";
import { logger } from "../utils/logger.js";

const CLASSIFICATION_MODEL = "claude-haiku-4-5-20251001";
const BATCH_SIZE = 2;
const REQUEST_DELAY_MS = 500;

// ---------------------------------------------------------------------------
// Format/Angle definitions for prompt
// ---------------------------------------------------------------------------

const FORMATS = `F01:Talking Head, F02:Interview/Podcast, F03:Product Demo, F04:Unboxing/Reveal, F05:Voiceover+B-roll, F06:Split Screen, F07:Screen Recording, F08:Documentary/Mini-Doc, F09:Reaction/Duet, F10:ASMR/Sensory, F11:Stop Motion/Animation, F12:Photo Slideshow, F13:Compilation/Mashup, F14:Static, F15:Carousel, F16:No-Ads Ad (Organic), F17:Two-Person`;

const ANGLES = `A01:Problem→Solution, A02:Social Proof, A03:Authority/Expert, A04:Founder Story, A05:Comparison/Us vs Them, A06:Education/How-To, A07:Lifestyle/Identity, A08:Behind the Scenes, A09:Ingredient/Science, A10:Use-Case/Occasion, A11:Transformation, A12:Scarcity/FOMO, A13:Myth-Busting, A14:Review/Testimonial, A15:Unboxing/First Impression`;

const STYLES = `lo-fi, hi-fi, energetic, calm, funny, emotional, clinical, aspirational`;

// ---------------------------------------------------------------------------
// Classify a single creative via Haiku
// ---------------------------------------------------------------------------

interface CreativeRow {
  creative_id: string;
  ad_id: string;
  ad_name: string | null;
  ad_type: string | null;
  format: string | null;
  primary_text: string | null;
  headline: string | null;
  transcript: string | null;
  video_duration_seconds: number | null;
  ai_tags: string[] | null;
  client_id: number;
}

interface Classification {
  format_code: string;
  angle_code: string;
  style_tags: string[];
}

async function classifyCreative(
  anthropic: Anthropic,
  creative: CreativeRow,
): Promise<Classification> {
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
STYLES (pick 1-2): ${STYLES}

AD INFO:
${info}

Respond with ONLY a JSON object (no markdown):
{"format_code":"F??","angle_code":"A??","style_tags":["..."],"confidence":"high|medium|low"}`,
      },
    ],
  });

  let text = response.content[0]?.type === "text" ? response.content[0].text : "";
  // Strip markdown code blocks if present
  text = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  try {
    const parsed = JSON.parse(text);
    return {
      format_code: parsed.format_code ?? "F14",
      angle_code: parsed.angle_code ?? "A01",
      style_tags: Array.isArray(parsed.style_tags) ? parsed.style_tags : [parsed.style ?? "lo-fi"],
    };
  } catch {
    logger.warn({ ad_name: creative.ad_name, response: text }, "Failed to parse classification");
    return { format_code: "F14", angle_code: "A01", style_tags: ["lo-fi"] };
  }
}

// ---------------------------------------------------------------------------
// classifyNewCreatives — nightly job entry point
// ---------------------------------------------------------------------------

export async function classifyNewCreatives(): Promise<void> {
  logger.info("Starting nightly creative classification");

  const bmad = getSupabase();
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  // Fetch creatives where format_code is null (unclassified)
  // Only classify creatives that have been active recently (last_active_at within 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const { data: creatives, error } = await bmad
    .from("creatives")
    .select("creative_id, ad_id, ad_name, ad_type, format, primary_text, headline, transcript, video_duration_seconds, ai_tags, client_id")
    .is("format_code", null)
    .gte("last_active_at", thirtyDaysAgo.toISOString())
    .limit(200);

  if (error) {
    logger.error({ error }, "Failed to fetch unclassified creatives");
    return;
  }

  if (!creatives || creatives.length === 0) {
    logger.info("No unclassified creatives found");
    return;
  }

  logger.info({ count: creatives.length }, "Found unclassified creatives to classify");

  let classified = 0;
  let failed = 0;

  for (let i = 0; i < creatives.length; i += BATCH_SIZE) {
    const batch = creatives.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map(async (creative) => {
        try {
          const classification = await classifyCreative(anthropic, creative as CreativeRow);
          return { creative_id: creative.creative_id, ...classification };
        } catch (err) {
          logger.error({ error: err, creative_id: creative.creative_id }, "Classification failed");
          return null;
        }
      }),
    );

    for (const result of results) {
      if (!result) {
        failed++;
        continue;
      }

      const { error: updateErr } = await bmad
        .from("creatives")
        .update({
          format_code: result.format_code,
          angle_code: result.angle_code,
          style_tags: result.style_tags,
        })
        .eq("creative_id", result.creative_id);

      if (updateErr) {
        logger.error({ error: updateErr, creative_id: result.creative_id }, "Failed to update creative");
        failed++;
      } else {
        classified++;
      }
    }

    if (i + BATCH_SIZE < creatives.length) {
      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    }
  }

  logger.info({ classified, failed, total: creatives.length }, "Creative classification complete");
}

// ---------------------------------------------------------------------------
// runCreativeAuditRefresh — weekly job that re-generates audit reports
// ---------------------------------------------------------------------------

export async function runCreativeAuditRefresh(): Promise<void> {
  logger.info("Starting weekly creative audit refresh");

  const bmad = getSupabase();
  const dai = getDaiSupabase();

  // Get all active clients
  const { data: clients, error: clientErr } = await bmad
    .from("clients")
    .select("id, code")
    .eq("is_active", true);

  if (clientErr || !clients?.length) {
    logger.error({ error: clientErr?.message }, "Failed to fetch clients for audit refresh");
    return;
  }

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const sinceStr = thirtyDaysAgo.toISOString().slice(0, 10);

  for (const client of clients) {
    try {
      // Get ad spend for the period
      const { data: adSpend } = await bmad
        .from("ad_daily")
        .select("ad_id, spend")
        .eq("client_id", client.id)
        .gte("date", sinceStr);

      const spendByAd = new Map<string, number>();
      for (const row of adSpend ?? []) {
        const current = spendByAd.get(row.ad_id) ?? 0;
        spendByAd.set(row.ad_id, current + (row.spend ?? 0));
      }

      const activeAdIds = [...spendByAd.entries()]
        .filter(([, spend]) => spend > 0)
        .map(([id]) => id);

      if (activeAdIds.length === 0) continue;

      // Fetch classified creatives
      const allCreatives: Array<{
        ad_id: string;
        ad_name: string | null;
        format_code: string;
        angle_code: string;
        style_tags: string[];
        hook_score: number | null;
      }> = [];

      for (let i = 0; i < activeAdIds.length; i += 100) {
        const batch = activeAdIds.slice(i, i + 100);
        const { data: creatives } = await bmad
          .from("creatives")
          .select("ad_id, ad_name, format_code, angle_code, style_tags, hook_score")
          .eq("client_id", client.id)
          .in("ad_id", batch)
          .not("format_code", "is", null);

        if (creatives) allCreatives.push(...creatives);
      }

      if (allCreatives.length === 0) continue;

      // Build audit report
      const totalSpend = allCreatives.reduce((sum, c) => sum + (spendByAd.get(c.ad_id) ?? 0), 0);

      const formatMap = new Map<string, { count: number; spend: number }>();
      const angleMap = new Map<string, { count: number; spend: number }>();
      const styleMap = new Map<string, { count: number }>();
      const testedCombos = new Set<string>();

      for (const c of allCreatives) {
        const spend = spendByAd.get(c.ad_id) ?? 0;

        const fEntry = formatMap.get(c.format_code) ?? { count: 0, spend: 0 };
        fEntry.count++;
        fEntry.spend += spend;
        formatMap.set(c.format_code, fEntry);

        const aEntry = angleMap.get(c.angle_code) ?? { count: 0, spend: 0 };
        aEntry.count++;
        aEntry.spend += spend;
        angleMap.set(c.angle_code, aEntry);

        for (const style of c.style_tags ?? []) {
          const sEntry = styleMap.get(style) ?? { count: 0 };
          sEntry.count++;
          styleMap.set(style, sEntry);
        }

        testedCombos.add(`${c.format_code}×${c.angle_code}`);
      }

      const formatDist: Record<string, { spend_pct: number; count: number; spend: number }> = {};
      for (const [code, data] of formatMap) {
        formatDist[code] = { ...data, spend_pct: totalSpend > 0 ? data.spend / totalSpend : 0 };
      }

      const angleDist: Record<string, { spend_pct: number; count: number; spend: number }> = {};
      for (const [code, data] of angleMap) {
        angleDist[code] = { ...data, spend_pct: totalSpend > 0 ? data.spend / totalSpend : 0 };
      }

      const styleDist: Record<string, { count: number }> = {};
      for (const [style, data] of styleMap) {
        styleDist[style] = data;
      }

      // Gap matrix
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

      for (const combo of testedCombos) {
        const [f, a] = combo.split("×");
        const fSpendPct = formatDist[f!]?.spend_pct ?? 0;
        const aSpendPct = angleDist[a!]?.spend_pct ?? 0;
        if (fSpendPct < 0.05 && aSpendPct < 0.05) {
          underweight.push(combo);
        }
      }

      // Top performers
      const sorted = [...allCreatives].sort((a, b) => {
        const aScore = a.hook_score ?? 0;
        const bScore = b.hook_score ?? 0;
        return bScore - aScore || (spendByAd.get(b.ad_id) ?? 0) - (spendByAd.get(a.ad_id) ?? 0);
      });

      const topPerformers = sorted.slice(0, 10).map((c) => ({
        ad_id: c.ad_id,
        ad_name: c.ad_name,
        format: c.format_code,
        angle: c.angle_code,
        style: (c.style_tags ?? []).join(", "),
        spend: spendByAd.get(c.ad_id) ?? 0,
        hook_score: c.hook_score,
      }));

      // Save audit
      const { error: saveErr } = await dai.from("creative_audits").insert({
        client_code: client.code,
        format_distribution: formatDist,
        angle_distribution: angleDist,
        style_distribution: styleDist,
        gap_matrix: { untested, underweight },
        top_performers: topPerformers,
        total_spend: totalSpend,
        total_ads: allCreatives.length,
      });

      if (saveErr) {
        logger.error({ error: saveErr, client: client.code }, "Failed to save audit");
      } else {
        logger.info({ client: client.code, ads: allCreatives.length }, "Saved creative audit");
      }
    } catch (err) {
      logger.error({ error: err, client: client.code }, "Audit refresh failed for client");
    }
  }

  logger.info("Weekly creative audit refresh complete");
}
