/**
 * Two-stage methodology extraction pipeline (Haiku → Opus).
 *
 * Reusable module factored out of scripts/extract-methodology.ts for use
 * by the live Nina/Daniel call monitoring pipeline.
 *
 * Stage 1 (Haiku — cheap): Scan full transcript, extract relevant snippets.
 * Stage 2 (Opus — deep): Structured extraction from concentrated snippets.
 */

import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env.js";
import { logger } from "../utils/logger.js";
import { getDaiSupabase } from "../integrations/dai-supabase.js";
import { normalizeAccountCode } from "../utils/account-codes.js";

const FILTER_MODEL = "claude-haiku-4-5-20251001";
const EXTRACTION_MODEL = "claude-opus-4-6";
const MAX_TRANSCRIPT_CHARS = 80_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MethodologyInsight {
  type: "rule" | "insight" | "decision" | "creative_pattern" | "methodology";
  title: string;
  body: Record<string, unknown>;
  account_code: string | null;
  category: string | null;
  confidence: "high" | "medium" | null;
  durability: "durable" | "situational";
}

interface RawExtraction {
  global_rules: Array<{
    rule: string;
    rationale: string;
    confidence: "high" | "medium";
    source_quote: string;
  }>;
  account_insights: Array<{
    account_code: string;
    insight: string;
    category: string;
    confidence: "high" | "medium";
    durability?: "durable" | "situational";
  }>;
  decision_examples: Array<{
    account_code: string;
    decision_type: string;
    target: string;
    reasoning: string;
    outcome_if_known: string | null;
    durability?: "durable" | "situational";
  }>;
  creative_patterns: Array<{
    pattern: string;
    account_code_if_specific: string | null;
    evidence: string;
    confidence: "high" | "medium";
    durability?: "durable" | "situational";
  }>;
  methodology: Array<{
    step: string;
    description: string;
    when_to_use: string;
  }>;
}

// ---------------------------------------------------------------------------
// Anthropic client (lazy)
// ---------------------------------------------------------------------------

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Stage 1: Snippet filtering (Haiku)
// ---------------------------------------------------------------------------

const FILTER_SYSTEM = `You extract media-buying-relevant snippets from meeting transcripts.

Context: Daniel Bulygin runs performance marketing at Ads on Tap agency. Nina is a senior media buyer. They manage Meta/Facebook ad accounts for e-commerce and lead gen clients.

Your job: Read the transcript and extract ONLY the portions that discuss:
- Ad account performance (metrics, results, trends)
- Optimization decisions (kill, scale, pause, restructure campaigns/ad sets/ads)
- Creative analysis (hook rates, hold rates, what's working, what's not)
- Methodology (how they diagnose issues, analytical frameworks, decision processes)
- Account-specific patterns (what works for this client, quirks, audience insights)
- Strategic principles (general rules Daniel/Nina state about media buying)

RULES:
- Copy the relevant dialogue VERBATIM — do not summarize or paraphrase
- Include enough surrounding context so each snippet makes sense standalone
- Include the speaker name for each line
- Separate distinct topics with "---"
- If the meeting has NO media buying content at all, respond with exactly: NO_RELEVANT_CONTENT
- Do NOT include: greetings, scheduling, small talk, HR topics, unrelated business discussion
- Aim for the minimum text that captures all the methodology and insights`;

async function filterSnippets(
  transcript: string,
  title: string,
  date: string,
  speakers: string,
): Promise<string | null> {
  let text = transcript;
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text = text.slice(0, MAX_TRANSCRIPT_CHARS) + "\n\n[... transcript truncated]";
  }

  const response = await getClient().messages.create({
    model: FILTER_MODEL,
    max_tokens: 16384,
    system: FILTER_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Meeting: ${title} (${date})\nSpeakers: ${speakers}\n\nTranscript:\n${text}`,
      },
    ],
  });

  const result = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  if (result === "NO_RELEVANT_CONTENT" || result.length < 100) {
    return null;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Stage 2: Deep extraction (Opus)
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM = `You are extracting media buying knowledge from pre-filtered meeting snippets.

The speaker Daniel Bulygin is the head of performance marketing at Ads on Tap (adsontap.io), a paid media agency. Nina is a senior media buyer. Other speakers may be clients or team members.

These snippets have already been filtered to contain only media-buying-relevant discussion. Extract ALL methodology from them.

Return ONLY a valid JSON object with these exact keys:

1. "global_rules" — Universal media buying principles that apply to all accounts
   Each: { "rule": string, "rationale": string, "confidence": "high"|"medium", "source_quote": string }
   Only include rules that Daniel/Nina state as general principles, not one-off observations.

2. "account_insights" — Things specific to one client/account
   Each: { "account_code": string (lowercase, underscores), "insight": string, "category": "what_works"|"what_doesnt"|"quirk"|"audience"|"creative"|"targeting"|"structure", "confidence": "high"|"medium" }
   Account code should match the client name as closely as possible (e.g., "ninepine", "brain_fm", "press_london").

3. "decision_examples" — Kill/scale/pause/iterate decisions with reasoning
   Each: { "account_code": string, "decision_type": "kill"|"scale"|"pause"|"iterate"|"restructure", "target": string (what was acted on), "reasoning": string, "outcome_if_known": string|null }
   Only include explicit decisions, not hypothetical discussions.

4. "creative_patterns" — What makes ads work or fail
   Each: { "pattern": string, "account_code_if_specific": string|null, "evidence": string, "confidence": "high"|"medium" }
   Include hook types, formats, messaging angles, and creative production insights.

5. "methodology" — How Daniel/Nina approach analysis (process, not content)
   Each: { "step": string, "description": string, "when_to_use": string }
   Focus on analytical workflows, diagnostic sequences, and decision-making processes.

Durability classification — add a "durability" field to each item in account_insights, decision_examples, and creative_patterns:
- "durable": Structural principles, reusable patterns, lasting methodology. Would still be true 6+ months from now.
  Examples: "kill ads at 3x target CPA after 7 days", "UGC hooks outperform branded intros", "check frequency before scaling"
- "situational": Current performance observations, time-bound metrics, trends that could change within weeks.
  Examples: "UK CPA is high right now", "US outperforms UK at 2x currently", "this campaign started converting yesterday"
- When in doubt, default to "durable".
- global_rules and methodology items are always durable — no durability field needed for those.

Rules:
- Only extract things that are clearly stated or demonstrated. Do not infer.
- Include direct quotes where they capture a principle ("let it cook", "where in the funnel", etc.)
- Be specific and actionable. "ROAS was discussed" is not an insight.
- It's better to extract fewer high-quality insights than many vague ones.
- If the snippets have no extractable methodology, return all empty arrays.
- Return ONLY valid JSON, no other text, no markdown code fences.`;

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

/**
 * Extract methodology insights from a single meeting via two-stage pipeline.
 * Returns normalized, flattened insights ready for pending_insights storage.
 */
export async function extractMethodologyInsights(
  meetingId: string,
  meetingTitle: string,
  meetingDate: string,
): Promise<MethodologyInsight[]> {
  const supabase = getDaiSupabase();

  // Fetch full_transcript + speakers from the meetings table
  const { data: meetingRow, error } = await supabase
    .from("meetings")
    .select("full_transcript, speakers, short_summary")
    .eq("id", meetingId)
    .single();

  if (error) {
    logger.error({ error, meetingId }, "Failed to fetch meeting for extraction");
    return [];
  }

  const meeting = meetingRow as {
    full_transcript: string | null;
    speakers: string[] | null;
    short_summary: string | null;
  } | null;

  const transcript = meeting?.full_transcript ?? "";

  if (transcript.length < 200) {
    logger.debug({ meetingId }, "Transcript too short or empty, skipping extraction");
    return [];
  }

  const speakers = (meeting?.speakers ?? []).join(", ") || "unknown";
  const summary = meeting?.short_summary;

  // Stage 1: Filter with Haiku
  logger.info({ meetingId, title: meetingTitle }, "Stage 1: Filtering snippets with Haiku");
  const snippets = await filterSnippets(transcript, meetingTitle, meetingDate, speakers);

  if (!snippets) {
    logger.info({ meetingId }, "No relevant media buying content found");
    return [];
  }

  logger.info(
    { meetingId, snippetChars: snippets.length, transcriptChars: transcript.length },
    "Stage 1 complete, running Stage 2",
  );

  // Stage 2: Extract with Opus
  const response = await getClient().messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: 8192,
    system: EXTRACTION_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          `Meeting: ${meetingTitle} (${meetingDate})`,
          `Speakers: ${speakers}`,
          summary ? `Summary: ${summary}` : "",
          "",
          "Relevant snippets from transcript:",
          snippets,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });

  const responseText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  // Parse response
  let parsed: RawExtraction;
  try {
    const cleaned = responseText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    parsed = JSON.parse(cleaned) as RawExtraction;
  } catch (err) {
    logger.error({ meetingId, err }, "Failed to parse extraction response");
    return [];
  }

  // Flatten into unified MethodologyInsight format
  const insights: MethodologyInsight[] = [];

  for (const rule of parsed.global_rules ?? []) {
    insights.push({
      type: "rule",
      title: rule.rule,
      body: { rationale: rule.rationale, source_quote: rule.source_quote },
      account_code: null,
      category: null,
      confidence: rule.confidence,
      durability: "durable", // rules are always durable
    });
  }

  for (const ai of parsed.account_insights ?? []) {
    insights.push({
      type: "insight",
      title: ai.insight,
      body: {},
      account_code: normalizeAccountCode(ai.account_code),
      category: ai.category,
      confidence: ai.confidence,
      durability: ai.durability ?? "durable",
    });
  }

  for (const de of parsed.decision_examples ?? []) {
    insights.push({
      type: "decision",
      title: `${de.decision_type}: ${de.target}`,
      body: { reasoning: de.reasoning, outcome_if_known: de.outcome_if_known },
      account_code: normalizeAccountCode(de.account_code),
      category: de.decision_type,
      confidence: null,
      durability: de.durability ?? "durable",
    });
  }

  for (const cp of parsed.creative_patterns ?? []) {
    insights.push({
      type: "creative_pattern",
      title: cp.pattern,
      body: { evidence: cp.evidence },
      account_code: cp.account_code_if_specific
        ? normalizeAccountCode(cp.account_code_if_specific)
        : null,
      category: null,
      confidence: cp.confidence,
      durability: cp.durability ?? "durable",
    });
  }

  for (const ms of parsed.methodology ?? []) {
    insights.push({
      type: "methodology",
      title: ms.step,
      body: { description: ms.description, when_to_use: ms.when_to_use },
      account_code: null,
      category: null,
      confidence: null,
      durability: "durable", // methodology is always durable
    });
  }

  logger.info(
    { meetingId, total: insights.length },
    "Stage 2 extraction complete",
  );

  return insights;
}
