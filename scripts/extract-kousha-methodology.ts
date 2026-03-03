/**
 * Extract Kousha Torabi's methodology, preferences, and business context
 * from Fireflies meeting transcripts for the Ninepine-specific Ada.
 *
 * Two-stage pipeline: Haiku filter → Opus extract, following the pattern
 * in extract-methodology.ts but with Kousha/Ninepine-focused prompts.
 *
 * Output: data/ninepine/ with raw JSONs, deduped.json, NINEPINE-METHODOLOGY.md,
 * and KOUSHA-VOICE.md.
 *
 * Usage:
 *   pnpm extract:kousha                           # Full run
 *   pnpm extract:kousha -- --dry-run              # Preview meetings + cost estimate
 *   pnpm extract:kousha -- --resume               # Resume interrupted run
 *   pnpm extract:kousha -- --synthesize-only      # Re-synthesize from existing raw/
 *   pnpm extract:kousha -- --include-internal      # Also process internal Ninepine meetings
 *   pnpm extract:kousha -- --concurrency 3        # Parallel API calls (default 2)
 *   pnpm extract:kousha -- --limit 1              # Process at most N meetings
 *   pnpm extract:kousha -- --load                 # Load deduped.json into methodology_knowledge
 */

import Anthropic from "@anthropic-ai/sdk";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FILTER_MODEL = "claude-haiku-4-5-20251001";
const EXTRACTION_MODEL = "claude-opus-4-6";
const SYNTHESIS_MODEL = "claude-opus-4-6";
const MAX_TRANSCRIPT_CHARS = 80_000;
const REQUEST_DELAY_MS = 2_000;
const DEFAULT_CONCURRENCY = 2;

const DANIEL_ORGANIZER_EMAIL = "daniel.bulygin@gmail.com";

const OUTPUT_DIR = join(process.cwd(), "data", "ninepine");
const RAW_DIR = join(OUTPUT_DIR, "raw");
const PROGRESS_FILE = join(OUTPUT_DIR, "progress.json");
const DEDUPED_FILE = join(OUTPUT_DIR, "deduped.json");
const METHODOLOGY_FILE = join(OUTPUT_DIR, "NINEPINE-METHODOLOGY.md");
const VOICE_FILE = join(OUTPUT_DIR, "KOUSHA-VOICE.md");

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

const DAI_SUPABASE_URL = process.env.DAI_SUPABASE_URL;
const DAI_SUPABASE_SERVICE_KEY = process.env.DAI_SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!DAI_SUPABASE_URL || !DAI_SUPABASE_SERVICE_KEY) {
  console.error("Missing DAI_SUPABASE_URL or DAI_SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const supabase: SupabaseClient = createClient(
  DAI_SUPABASE_URL,
  DAI_SUPABASE_SERVICE_KEY,
);

let _anthropic: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!_anthropic) {
    if (!ANTHROPIC_API_KEY) {
      console.error("Missing ANTHROPIC_API_KEY");
      process.exit(1);
    }
    _anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const resume = args.includes("--resume");
const synthesizeOnly = args.includes("--synthesize-only");
const includeInternal = args.includes("--include-internal");
const loadFlag = args.includes("--load");

function getArgValue(flag: string, fallback: number): number {
  const idx = args.indexOf(flag);
  if (idx === -1 || !args[idx + 1]) return fallback;
  const val = parseInt(args[idx + 1]!, 10);
  return isNaN(val) ? fallback : val;
}

const concurrency = getArgValue("--concurrency", DEFAULT_CONCURRENCY);
const limit = getArgValue("--limit", 0);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MeetingRow {
  id: string;
  title: string | null;
  date: string | null;
  duration: number | null;
  speakers: string[] | null;
  organizer_email: string | null;
  short_summary: string | null;
  full_transcript: string | null;
}

interface SentenceRow {
  sentence_index: number;
  speaker_name: string | null;
  text: string | null;
  start_time: number | null;
  end_time: number | null;
}

type Tier = "T1" | "T2";

interface ClassifiedMeeting {
  meeting: MeetingRow;
  tier: Tier;
  reason: string;
}

// Extraction categories
interface EvaluationCriterion {
  criterion: string;
  details: string;
  source_meeting: string;
  source_date: string;
}

interface BrandPhilosophy {
  principle: string;
  details: string;
  source_meeting: string;
  source_date: string;
}

interface BusinessContext {
  fact: string;
  details: string;
  source_meeting: string;
  source_date: string;
}

interface GrowthStrategy {
  strategy: string;
  details: string;
  source_meeting: string;
  source_date: string;
}

interface AgencyExpectation {
  expectation: string;
  details: string;
  source_meeting: string;
  source_date: string;
}

interface CreativePreference {
  preference: string;
  details: string;
  source_meeting: string;
  source_date: string;
}

interface DecisionExample {
  decision: string;
  reasoning: string;
  outcome: string | null;
  source_meeting: string;
  source_date: string;
}

interface DirectQuote {
  quote: string;
  topic: string;
  context: string;
  source_meeting: string;
  source_date: string;
}

interface KoushaExtraction {
  meeting_id: string;
  meeting_title: string;
  meeting_date: string;
  evaluation_criteria: EvaluationCriterion[];
  brand_philosophy: BrandPhilosophy[];
  business_context: BusinessContext[];
  growth_strategy: GrowthStrategy[];
  agency_expectations: AgencyExpectation[];
  creative_preferences: CreativePreference[];
  decision_examples: DecisionExample[];
  direct_quotes: DirectQuote[];
}

interface DedupedData {
  evaluation_criteria: EvaluationCriterion[];
  brand_philosophy: BrandPhilosophy[];
  business_context: BusinessContext[];
  growth_strategy: GrowthStrategy[];
  agency_expectations: AgencyExpectation[];
  creative_preferences: CreativePreference[];
  decision_examples: DecisionExample[];
  direct_quotes: DirectQuote[];
  stats: {
    meetings_processed: number;
    meetings_with_content: number;
    total_items_before_dedup: number;
    total_items_after_dedup: number;
  };
}

interface Progress {
  processed_ids: string[];
  started_at: string;
  last_updated: string;
  total_meetings: number;
  processed_count: number;
  errors: Array<{ meeting_id: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Phase 1: Fetch & Classify
// ---------------------------------------------------------------------------

async function fetchAllMeetings(): Promise<MeetingRow[]> {
  // Supabase returns max 1000 rows by default — paginate to get all
  const all: MeetingRow[] = [];
  const pageSize = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("meetings")
      .select(
        "id, title, date, duration, speakers, organizer_email, short_summary, full_transcript",
      )
      .order("date", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      console.error("Failed to fetch meetings:", error.message);
      process.exit(1);
    }

    if (!data || data.length === 0) break;
    all.push(...(data as MeetingRow[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return all;
}

async function fetchKoushaMeetings(): Promise<MeetingRow[]> {
  const all = await fetchAllMeetings();
  return all.filter((m) => m.speakers?.some((s) => /kousha/i.test(s)));
}

async function fetchInternalNinepineMeetings(): Promise<MeetingRow[]> {
  const all = await fetchAllMeetings();
  return all.filter((m) => {
    const hasNinepineTitle = /ninepine/i.test(m.title ?? "");
    const hasKousha = m.speakers?.some((s) => /kousha/i.test(s));
    return hasNinepineTitle && !hasKousha;
  });
}

function classifyMeeting(m: MeetingRow): ClassifiedMeeting {
  const speakers = m.speakers ?? [];
  const speakerCount = speakers.length;
  const hasDaniel = speakers.some((s) => /daniel/i.test(s));
  const duration = m.duration ?? 0;

  // T1: 1:1 or small (≤3 speakers), Daniel present, >25 min
  if (speakerCount <= 3 && hasDaniel && duration > 25) {
    return {
      meeting: m,
      tier: "T1",
      reason: `${speakerCount} speakers, ${Math.round(duration)} min — full transcript`,
    };
  }

  // T2: larger group or short meetings — build Kousha-focused transcript
  return {
    meeting: m,
    tier: "T2",
    reason: `${speakerCount} speakers, ${Math.round(duration)} min — Kousha-focused`,
  };
}

async function buildKoushaFocusedTranscript(
  meetingId: string,
): Promise<string> {
  // Fetch all sentences for this meeting
  const { data, error } = await supabase
    .from("meeting_sentences")
    .select("sentence_index, speaker_name, text, start_time, end_time")
    .eq("meeting_id", meetingId)
    .order("sentence_index", { ascending: true });

  if (error || !data || data.length === 0) {
    return "";
  }

  const sentences = data as SentenceRow[];

  // Mark Kousha sentences and their surrounding context (1 turn before/after)
  const koushaIndices = new Set<number>();
  for (let i = 0; i < sentences.length; i++) {
    if (/kousha/i.test(sentences[i]!.speaker_name ?? "")) {
      koushaIndices.add(i);
      // Include 1 surrounding turn for context
      if (i > 0) koushaIndices.add(i - 1);
      if (i < sentences.length - 1) koushaIndices.add(i + 1);
    }
  }

  if (koushaIndices.size === 0) return "";

  // Build focused transcript
  const lines: string[] = [];
  let lastIncluded = -2;
  for (const idx of [...koushaIndices].sort((a, b) => a - b)) {
    const s = sentences[idx]!;
    if (idx > lastIncluded + 1 && lastIncluded >= 0) {
      lines.push("\n[...]\n");
    }
    lines.push(`${s.speaker_name ?? "Unknown"}: ${s.text ?? ""}`);
    lastIncluded = idx;
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Phase 2: Per-Meeting Extraction
// ---------------------------------------------------------------------------

const FILTER_SYSTEM = `You extract Kousha Torabi–relevant content from meeting transcripts.

Context: Kousha Torabi is the founder of Ninepine, an activewear brand. These are meetings between Kousha and Daniel Bulygin's agency (Ads on Tap), which manages Ninepine's paid media (Meta/Facebook ads). Other speakers may be agency team members (Nina, Franzi, Aaron) or Ninepine team members.

Your job: Read the transcript and extract ONLY portions where Kousha:
- Evaluates ad/campaign performance (what metrics he cares about, thresholds, what concerns him)
- Discusses brand philosophy, creative direction, or tone
- Shares business context (unit economics, margins, seasonality, product lines, customer journey)
- Describes growth strategy, scaling plans, or market priorities
- Sets expectations for the agency (communication, reporting, decision authority)
- Gives creative feedback (what he likes/dislikes, ad formats, messaging)
- Makes or discusses specific decisions with reasoning
- Says anything revealing about how he thinks about the business or ads

Also include relevant responses from Daniel/agency that clarify Kousha's points.

RULES:
- Copy relevant dialogue VERBATIM — do not summarize or paraphrase
- Include speaker names for each line
- Separate distinct topics with "---"
- If the meeting has NO relevant Kousha content, respond with exactly: NO_RELEVANT_CONTENT
- Do NOT include: greetings, scheduling, small talk, technical issues, off-topic tangents
- Aim for the minimum text that captures all of Kousha's methodology and preferences`;

const EXTRACTION_SYSTEM = `You are extracting Kousha Torabi's (Ninepine founder) methodology, preferences, and business context from pre-filtered meeting snippets.

Context: Kousha runs Ninepine, an activewear brand. Daniel Bulygin's agency (Ads on Tap) manages their Meta/Facebook advertising. You are building a knowledge base about how Kousha thinks about ads, what he expects from the agency, and what Ninepine needs.

Return ONLY a valid JSON object with these exact keys:

1. "evaluation_criteria" — How Kousha judges ad/campaign performance
   Each: { "criterion": string, "details": string }
   Include KPIs he tracks, thresholds he mentions, what concerns vs. excites him.

2. "brand_philosophy" — Brand vision, creative direction, tone, what Ninepine stands for
   Each: { "principle": string, "details": string }
   Include what he'd never do, brand values, aesthetic preferences.

3. "business_context" — Unit economics, seasonality, customer journey, product lines, margins
   Each: { "fact": string, "details": string }
   Concrete business facts that affect ad strategy.

4. "growth_strategy" — Scaling philosophy, geo expansion, channel mix, risk appetite
   Each: { "strategy": string, "details": string }
   Where Ninepine is headed and how Kousha thinks about growth.

5. "agency_expectations" — Communication, reporting, decision authority, escalation triggers
   Each: { "expectation": string, "details": string }
   What Kousha expects from the agency relationship.

6. "creative_preferences" — Ad formats, hooks, messaging angles, visual style, what he likes/dislikes
   Each: { "preference": string, "details": string }
   Specific creative direction that should guide ad production.

7. "decision_examples" — Specific decisions Kousha made or influenced, with reasoning
   Each: { "decision": string, "reasoning": string, "outcome": string|null }
   Only concrete decisions, not hypotheticals.

8. "direct_quotes" — Verbatim quotes that reveal how Kousha thinks
   Each: { "quote": string, "topic": string, "context": string }
   Select quotes that are distinctive and illuminating, not generic.

Rules:
- Only extract things Kousha explicitly states or clearly demonstrates. Do not infer.
- Be specific and actionable. "Kousha cares about ROAS" is not enough — what thresholds? What context?
- It's better to extract fewer high-quality items than many vague ones.
- If snippets have no extractable content, return all empty arrays.
- Return ONLY valid JSON, no other text, no markdown code fences.`;

function getResponseText(response: Anthropic.Message): string {
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function parseJSON(raw: string): Record<string, unknown[]> {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(cleaned) as Record<string, unknown[]>;
}

function parseExtraction(
  responseText: string,
  m: MeetingRow,
): KoushaExtraction {
  const parsed = parseJSON(responseText);
  const meetingDate = m.date
    ? new Date(m.date).toISOString().slice(0, 10)
    : "unknown";
  const meetingTitle = m.title ?? "Untitled";

  const annotate = <T extends object>(items: unknown[]): T[] =>
    (items ?? []).map((item) => ({
      ...(item as T),
      source_meeting: meetingTitle,
      source_date: meetingDate,
    }));

  return {
    meeting_id: m.id,
    meeting_title: meetingTitle,
    meeting_date: meetingDate,
    evaluation_criteria: annotate<EvaluationCriterion>(
      parsed["evaluation_criteria"] as unknown[],
    ),
    brand_philosophy: annotate<BrandPhilosophy>(
      parsed["brand_philosophy"] as unknown[],
    ),
    business_context: annotate<BusinessContext>(
      parsed["business_context"] as unknown[],
    ),
    growth_strategy: annotate<GrowthStrategy>(
      parsed["growth_strategy"] as unknown[],
    ),
    agency_expectations: annotate<AgencyExpectation>(
      parsed["agency_expectations"] as unknown[],
    ),
    creative_preferences: annotate<CreativePreference>(
      parsed["creative_preferences"] as unknown[],
    ),
    decision_examples: annotate<DecisionExample>(
      parsed["decision_examples"] as unknown[],
    ),
    direct_quotes: annotate<DirectQuote>(
      parsed["direct_quotes"] as unknown[],
    ),
  };
}

async function filterSnippets(
  transcript: string,
  m: MeetingRow,
): Promise<string | null> {
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript =
      transcript.slice(0, MAX_TRANSCRIPT_CHARS) +
      "\n\n[... transcript truncated]";
  }

  const date = m.date ? new Date(m.date).toISOString().slice(0, 10) : "unknown";

  const response = await anthropic().messages.create({
    model: FILTER_MODEL,
    max_tokens: 16384,
    system: FILTER_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Meeting: ${m.title ?? "Untitled"} (${date})\nSpeakers: ${(m.speakers ?? []).join(", ")}\n\nTranscript:\n${transcript}`,
      },
    ],
  });

  const text = getResponseText(response);

  if (text === "NO_RELEVANT_CONTENT" || text.length < 100) {
    return null;
  }
  return text;
}

async function extractFromSnippets(
  snippets: string,
  m: MeetingRow,
): Promise<KoushaExtraction> {
  const date = m.date ? new Date(m.date).toISOString().slice(0, 10) : "unknown";
  const speakers = (m.speakers ?? []).join(", ") || "unknown";

  const response = await anthropic().messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: 8192,
    system: EXTRACTION_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          `Meeting: ${m.title ?? "Untitled"} (${date})`,
          `Speakers: ${speakers}`,
          m.short_summary ? `Summary: ${m.short_summary}` : "",
          "",
          "Relevant snippets from transcript:",
          snippets,
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });

  return parseExtraction(getResponseText(response), m);
}

interface StageResult {
  skipped: boolean;
  snippets_chars: number;
  extraction: KoushaExtraction | null;
}

async function processOneMeeting(
  classified: ClassifiedMeeting,
): Promise<StageResult> {
  const m = classified.meeting;

  // Get the transcript to process
  let transcript: string;

  if (classified.tier === "T1") {
    // Full transcript for small/focused meetings
    transcript = m.full_transcript ?? "";
  } else {
    // T2: build Kousha-focused transcript from sentences
    transcript = await buildKoushaFocusedTranscript(m.id);
    if (!transcript) {
      // Fall back to full transcript if sentences not available
      transcript = m.full_transcript ?? "";
    }
  }

  if (transcript.trim().length < 200) {
    return { skipped: true, snippets_chars: 0, extraction: null };
  }

  // Stage 1: Filter with Haiku
  const snippets = await filterSnippets(transcript, m);

  if (!snippets) {
    return { skipped: true, snippets_chars: 0, extraction: null };
  }

  // Stage 2: Extract with Opus
  const extraction = await extractFromSnippets(snippets, m);
  return { skipped: false, snippets_chars: snippets.length, extraction };
}

// ---------------------------------------------------------------------------
// Phase 3: Deduplication
// ---------------------------------------------------------------------------

function computeOverlap(a: string, b: string): number {
  const wordsA = new Set(
    a
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
  const wordsB = new Set(
    b
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }
  return intersection / Math.min(wordsA.size, wordsB.size);
}

function dedup<T extends Record<string, unknown>>(
  items: T[],
  contentKey: string,
  threshold: number,
): T[] {
  const result: T[] = [];
  for (const item of items) {
    const content = String(item[contentKey] ?? "");
    const isDupe = result.some(
      (existing) =>
        computeOverlap(String(existing[contentKey] ?? ""), content) > threshold,
    );
    if (!isDupe) result.push(item);
  }
  return result;
}

function deduplicateAll(extractions: KoushaExtraction[]): DedupedData {
  const all = {
    evaluation_criteria: extractions.flatMap((e) => e.evaluation_criteria),
    brand_philosophy: extractions.flatMap((e) => e.brand_philosophy),
    business_context: extractions.flatMap((e) => e.business_context),
    growth_strategy: extractions.flatMap((e) => e.growth_strategy),
    agency_expectations: extractions.flatMap((e) => e.agency_expectations),
    creative_preferences: extractions.flatMap((e) => e.creative_preferences),
    decision_examples: extractions.flatMap((e) => e.decision_examples),
    direct_quotes: extractions.flatMap((e) => e.direct_quotes),
  };

  const totalBefore = Object.values(all).reduce((s, a) => s + a.length, 0);

  const dedupedData: DedupedData = {
    evaluation_criteria: dedup(all.evaluation_criteria, "details", 0.60),
    brand_philosophy: dedup(all.brand_philosophy, "details", 0.55),
    business_context: dedup(all.business_context, "details", 0.55),
    growth_strategy: dedup(all.growth_strategy, "details", 0.55),
    agency_expectations: dedup(all.agency_expectations, "details", 0.55),
    creative_preferences: dedup(all.creative_preferences, "details", 0.55),
    decision_examples: dedup(all.decision_examples, "reasoning", 0.50),
    direct_quotes: dedup(all.direct_quotes, "quote", 0.70),
    stats: {
      meetings_processed: extractions.length,
      meetings_with_content: extractions.filter(
        (e) =>
          e.evaluation_criteria.length > 0 ||
          e.brand_philosophy.length > 0 ||
          e.business_context.length > 0 ||
          e.direct_quotes.length > 0,
      ).length,
      total_items_before_dedup: totalBefore,
      total_items_after_dedup: 0, // filled below
    },
  };

  dedupedData.stats.total_items_after_dedup = [
    dedupedData.evaluation_criteria,
    dedupedData.brand_philosophy,
    dedupedData.business_context,
    dedupedData.growth_strategy,
    dedupedData.agency_expectations,
    dedupedData.creative_preferences,
    dedupedData.decision_examples,
    dedupedData.direct_quotes,
  ].reduce((s, a) => s + a.length, 0);

  return dedupedData;
}

// ---------------------------------------------------------------------------
// Phase 4: Synthesis
// ---------------------------------------------------------------------------

const SYNTHESIS_SYSTEM = `You are writing a comprehensive methodology document about Kousha Torabi, founder of Ninepine (activewear brand), for an AI advertising assistant.

This document will be the AI's primary knowledge base about Ninepine. It should capture HOW Kousha thinks — his priorities, preferences, expectations, and decision-making style — so the AI can act in alignment with his vision.

Write in third person, present tense. Be specific and actionable — avoid generic platitudes. Include concrete numbers, thresholds, and examples where available. Target 2,000-4,000 words.

Structure the document with these sections:
1. **Ninepine Business Context** — What the brand is, their customer, economics, market position
2. **How Kousha Evaluates Performance** — His scorecard, KPIs, thresholds, red flags
3. **Brand & Creative Direction** — What to recommend, what to avoid
4. **Growth Strategy & Priorities** — Scaling ambitions, constraints, market priorities
5. **Working With Ninepine** — Communication preferences, decision authority, escalation triggers
6. **Key Decisions & Lessons** — Case studies the AI can reference
7. **In Kousha's Own Words** — A curated selection of the most illuminating quotes, organized by topic

Write in clear, professional markdown. Use bullet points and sub-headers for scannability. The document should feel like a thorough briefing, not a transcript summary.`;

async function synthesize(data: DedupedData): Promise<string> {
  const input = JSON.stringify(
    {
      evaluation_criteria: data.evaluation_criteria,
      brand_philosophy: data.brand_philosophy,
      business_context: data.business_context,
      growth_strategy: data.growth_strategy,
      agency_expectations: data.agency_expectations,
      creative_preferences: data.creative_preferences,
      decision_examples: data.decision_examples,
      direct_quotes: data.direct_quotes,
    },
    null,
    2,
  );

  console.log(
    `\nSynthesizing NINEPINE-METHODOLOGY.md from ${data.stats.total_items_after_dedup} items (${Math.round(input.length / 1000)}K chars)...`,
  );

  const response = await anthropic().messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: 8192,
    system: SYNTHESIS_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Here is all the extracted data about Kousha Torabi and Ninepine from ${data.stats.meetings_processed} meetings (${data.stats.meetings_with_content} with meaningful content). Synthesize this into the methodology document.\n\n${input}`,
      },
    ],
  });

  return getResponseText(response);
}

function generateVoiceDoc(quotes: DirectQuote[]): string {
  // Group quotes by topic
  const byTopic = new Map<string, DirectQuote[]>();
  for (const q of quotes) {
    const topic = q.topic || "General";
    const existing = byTopic.get(topic) ?? [];
    existing.push(q);
    byTopic.set(topic, existing);
  }

  const lines: string[] = [
    "# Kousha Torabi — In His Own Words",
    "",
    `> Direct quotes from ${quotes.length} excerpts across Ninepine meetings, organized by topic.`,
    "",
  ];

  for (const [topic, topicQuotes] of [...byTopic.entries()].sort()) {
    lines.push(`## ${topic}`);
    lines.push("");
    for (const q of topicQuotes) {
      lines.push(`> "${q.quote}"`);
      if (q.context) {
        lines.push(`> — _${q.context}_ (${q.source_meeting}, ${q.source_date})`);
      } else {
        lines.push(`> — _(${q.source_meeting}, ${q.source_date})_`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Progress tracking
// ---------------------------------------------------------------------------

function loadProgress(): Progress {
  if (resume && existsSync(PROGRESS_FILE)) {
    const data = JSON.parse(readFileSync(PROGRESS_FILE, "utf-8")) as Progress;
    console.log(
      `Resuming: ${data.processed_count}/${data.total_meetings} processed\n`,
    );
    return data;
  }
  return {
    processed_ids: [],
    started_at: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    total_meetings: 0,
    processed_count: 0,
    errors: [],
  };
}

function saveProgress(progress: Progress): void {
  progress.last_updated = new Date().toISOString();
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function saveRawResult(result: KoushaExtraction): void {
  writeFileSync(
    join(RAW_DIR, `${result.meeting_id}.json`),
    JSON.stringify(result, null, 2),
  );
}

function loadRawResults(): KoushaExtraction[] {
  if (!existsSync(RAW_DIR)) return [];
  const results: KoushaExtraction[] = [];
  for (const f of readdirSync(RAW_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      results.push(
        JSON.parse(readFileSync(join(RAW_DIR, f), "utf-8")) as KoushaExtraction,
      );
    } catch {
      // skip corrupted files
    }
  }
  return results.sort(
    (a, b) => (a.meeting_date ?? "").localeCompare(b.meeting_date ?? ""),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countItems(e: KoushaExtraction): number {
  return (
    e.evaluation_criteria.length +
    e.brand_philosophy.length +
    e.business_context.length +
    e.growth_strategy.length +
    e.agency_expectations.length +
    e.creative_preferences.length +
    e.decision_examples.length +
    e.direct_quotes.length
  );
}

function estimateCost(meetings: ClassifiedMeeting[]): {
  haikuCalls: number;
  opusCalls: number;
  estimatedUSD: number;
} {
  const haikuCalls = meetings.length;
  // Assume ~80% of meetings yield content for Opus
  const opusCalls = Math.ceil(meetings.length * 0.8) + 1; // +1 for synthesis
  // Haiku: ~$0.02/call, Opus extract: ~$0.21/call, synthesis: ~$0.60
  const estimatedUSD =
    haikuCalls * 0.02 + (opusCalls - 1) * 0.21 + 0.6;
  return { haikuCalls, opusCalls, estimatedUSD };
}

// ---------------------------------------------------------------------------
// Phase 5: Load to Supabase (--load)
// ---------------------------------------------------------------------------

interface MethodologyRow {
  type: string;
  title: string;
  body: Record<string, unknown>;
  account_code: string | null;
  category: string | null;
  confidence: string | null;
  source_meeting: string;
  source_date: string;
  extraction_run: string;
}

function mapDedupedToRows(data: DedupedData, run: string): MethodologyRow[] {
  const rows: MethodologyRow[] = [];

  for (const item of data.evaluation_criteria) {
    rows.push({
      type: "insight",
      title: item.criterion,
      body: { details: item.details },
      account_code: "ninepine",
      category: "evaluation",
      confidence: "high",
      source_meeting: item.source_meeting,
      source_date: item.source_date,
      extraction_run: run,
    });
  }

  for (const item of data.brand_philosophy) {
    rows.push({
      type: "insight",
      title: item.principle,
      body: { details: item.details },
      account_code: "ninepine",
      category: "brand",
      confidence: "high",
      source_meeting: item.source_meeting,
      source_date: item.source_date,
      extraction_run: run,
    });
  }

  for (const item of data.business_context) {
    rows.push({
      type: "insight",
      title: item.fact,
      body: { details: item.details },
      account_code: "ninepine",
      category: "business_context",
      confidence: "high",
      source_meeting: item.source_meeting,
      source_date: item.source_date,
      extraction_run: run,
    });
  }

  for (const item of data.growth_strategy) {
    rows.push({
      type: "insight",
      title: item.strategy,
      body: { details: item.details },
      account_code: "ninepine",
      category: "growth_strategy",
      confidence: "high",
      source_meeting: item.source_meeting,
      source_date: item.source_date,
      extraction_run: run,
    });
  }

  for (const item of data.agency_expectations) {
    rows.push({
      type: "insight",
      title: item.expectation,
      body: { details: item.details },
      account_code: "ninepine",
      category: "agency_expectations",
      confidence: "high",
      source_meeting: item.source_meeting,
      source_date: item.source_date,
      extraction_run: run,
    });
  }

  for (const item of data.creative_preferences) {
    rows.push({
      type: "creative_pattern",
      title: item.preference,
      body: { details: item.details },
      account_code: "ninepine",
      category: null,
      confidence: "high",
      source_meeting: item.source_meeting,
      source_date: item.source_date,
      extraction_run: run,
    });
  }

  for (const item of data.decision_examples) {
    rows.push({
      type: "decision",
      title: item.decision,
      body: { reasoning: item.reasoning, outcome: item.outcome },
      account_code: "ninepine",
      category: null,
      confidence: null,
      source_meeting: item.source_meeting,
      source_date: item.source_date,
      extraction_run: run,
    });
  }

  for (const item of data.direct_quotes) {
    rows.push({
      type: "insight",
      title: item.quote,
      body: { topic: item.topic, context: item.context },
      account_code: "ninepine",
      category: "direct_quote",
      confidence: null,
      source_meeting: item.source_meeting,
      source_date: item.source_date,
      extraction_run: run,
    });
  }

  return rows;
}

async function loadToSupabase(): Promise<void> {
  console.log("=== Loading Kousha methodology to Supabase ===\n");

  if (!existsSync(DEDUPED_FILE)) {
    console.error(`No deduped.json found at ${DEDUPED_FILE}. Run extraction first.`);
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(DEDUPED_FILE, "utf-8")) as DedupedData;
  const today = new Date().toISOString().slice(0, 10);
  const extractionRun = `kousha-${today}`;

  const rows = mapDedupedToRows(data, extractionRun);
  console.log(`Mapped ${rows.length} rows from deduped.json (extraction_run: ${extractionRun})`);

  // Delete only kousha-* extraction_run rows (preserve existing 114+ rows from phase3)
  console.log("Clearing previous kousha-* rows...");
  const { error: deleteError } = await supabase
    .from("methodology_knowledge")
    .delete()
    .like("extraction_run", "kousha-%");

  if (deleteError) {
    console.error(`Failed to delete existing kousha rows: ${deleteError.message}`);
    process.exit(1);
  }
  console.log("Cleared.");

  // Batch insert in chunks of 100
  console.log("Inserting rows...");
  const BATCH_SIZE = 100;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error: insertError } = await supabase
      .from("methodology_knowledge")
      .insert(batch);

    if (insertError) {
      console.error(`Batch insert failed at offset ${i}: ${insertError.message}`);
      process.exit(1);
    }
    inserted += batch.length;
    process.stdout.write(`  Inserted ${inserted}/${rows.length}\r`);
  }
  console.log(`\nInserted ${inserted}/${rows.length} rows into methodology_knowledge.`);

  // Print category breakdown
  const byType = new Map<string, number>();
  for (const r of rows) {
    const key = r.category ? `${r.type}/${r.category}` : r.type;
    byType.set(key, (byType.get(key) ?? 0) + 1);
  }
  console.log("\nBreakdown:");
  for (const [key, count] of [...byType.entries()].sort()) {
    console.log(`  ${key}: ${count}`);
  }

  console.log("\n=== Done! ===");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Kousha Torabi Methodology Extraction ===\n");

  // Ensure output directories
  mkdirSync(RAW_DIR, { recursive: true });

  // Handle --load
  if (loadFlag) {
    await loadToSupabase();
    return;
  }

  // Handle --synthesize-only
  if (synthesizeOnly) {
    console.log("Synthesize-only mode: loading existing raw extractions...\n");
    const rawResults = loadRawResults();
    if (rawResults.length === 0) {
      console.error("No raw results found in data/ninepine/raw/. Run extraction first.");
      process.exit(1);
    }
    console.log(`Loaded ${rawResults.length} raw extractions.`);

    const dedupedData = deduplicateAll(rawResults);
    writeFileSync(DEDUPED_FILE, JSON.stringify(dedupedData, null, 2));
    console.log(
      `Deduped: ${dedupedData.stats.total_items_before_dedup} → ${dedupedData.stats.total_items_after_dedup} items`,
    );

    const methodology = await synthesize(dedupedData);
    writeFileSync(METHODOLOGY_FILE, methodology);
    console.log(`Wrote ${METHODOLOGY_FILE}`);

    const voice = generateVoiceDoc(dedupedData.direct_quotes);
    writeFileSync(VOICE_FILE, voice);
    console.log(`Wrote ${VOICE_FILE}`);

    console.log("\nDone! Synthesized from existing extractions.");
    return;
  }

  // Phase 1: Fetch & classify
  console.log("Phase 1: Fetching Kousha meetings...");
  const koushaMeetings = await fetchKoushaMeetings();
  console.log(`  Found ${koushaMeetings.length} meetings with Kousha.\n`);

  let allMeetings = koushaMeetings;

  if (includeInternal) {
    console.log("Fetching internal Ninepine meetings (--include-internal)...");
    const internalMeetings = await fetchInternalNinepineMeetings();
    console.log(
      `  Found ${internalMeetings.length} internal Ninepine meetings.\n`,
    );
    allMeetings = [...koushaMeetings, ...internalMeetings];
  }

  // Classify & sort (T1 first for higher-value extraction first)
  const classified = allMeetings.map(classifyMeeting);
  classified.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === "T1" ? -1 : 1;
    return (a.meeting.date ?? "").localeCompare(b.meeting.date ?? "");
  });

  // Apply limit
  const toProcess = limit > 0 ? classified.slice(0, limit) : classified;

  const t1Count = toProcess.filter((c) => c.tier === "T1").length;
  const t2Count = toProcess.filter((c) => c.tier === "T2").length;

  console.log(`Classification: ${t1Count} T1 (full transcript), ${t2Count} T2 (Kousha-focused)\n`);

  // Print meeting list
  for (const c of toProcess) {
    const date = c.meeting.date
      ? new Date(c.meeting.date).toISOString().slice(0, 10)
      : "????-??-??";
    const duration = c.meeting.duration
      ? `${Math.round(c.meeting.duration)} min`
      : "? min";
    const speakers = (c.meeting.speakers ?? []).join(", ");
    console.log(
      `  [${c.tier}] ${date} | ${duration} | ${c.meeting.title ?? "Untitled"}`,
    );
    console.log(`        Speakers: ${speakers}`);
    console.log(`        ${c.reason}`);
  }

  // Cost estimate
  const cost = estimateCost(toProcess);
  console.log(`\nEstimated cost: ~$${cost.estimatedUSD.toFixed(2)} (${cost.haikuCalls} Haiku + ${cost.opusCalls} Opus calls)`);

  if (dryRun) {
    console.log("\n--dry-run: stopping here.");
    return;
  }

  // Phase 2: Per-meeting extraction
  console.log("\nPhase 2: Extracting per-meeting...\n");
  const progress = loadProgress();
  progress.total_meetings = toProcess.length;

  let extracted = 0;
  let filtered = 0;
  let errors = 0;
  let idx = 0;
  const pending = new Set<Promise<void>>();

  for (const classified_meeting of toProcess) {
    const m = classified_meeting.meeting;

    if (progress.processed_ids.includes(m.id)) {
      idx++;
      continue;
    }

    const task = (async () => {
      const num = ++idx;
      const date = m.date
        ? new Date(m.date).toISOString().slice(0, 10)
        : "?";

      try {
        const result = await processOneMeeting(classified_meeting);

        if (result.extraction) {
          saveRawResult(result.extraction);
          const items = countItems(result.extraction);
          console.log(
            `  [${num}/${toProcess.length}] ${m.title} (${date}) [${classified_meeting.tier}] — ${items} items extracted (${result.snippets_chars} snippet chars)`,
          );
          extracted++;
        } else {
          console.log(
            `  [${num}/${toProcess.length}] ${m.title} (${date}) [${classified_meeting.tier}] — filtered out (no relevant content)`,
          );
          filtered++;
        }

        progress.processed_ids.push(m.id);
        progress.processed_count++;
        saveProgress(progress);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `  [${num}/${toProcess.length}] ERROR: ${m.title} (${date}) — ${msg}`,
        );
        progress.errors.push({ meeting_id: m.id, error: msg });
        progress.processed_ids.push(m.id);
        errors++;
        saveProgress(progress);
      }

      await sleep(REQUEST_DELAY_MS);
    })();

    pending.add(task);
    task.finally(() => pending.delete(task));

    if (pending.size >= concurrency) {
      await Promise.race(pending);
    }
  }

  await Promise.all(pending);
  saveProgress(progress);

  console.log(
    `\nPhase 2 complete: ${extracted} extracted, ${filtered} filtered out, ${errors} errors`,
  );

  // Phase 3: Deduplicate
  console.log("\nPhase 3: Deduplicating...");
  const rawResults = loadRawResults();
  const dedupedData = deduplicateAll(rawResults);
  writeFileSync(DEDUPED_FILE, JSON.stringify(dedupedData, null, 2));
  console.log(
    `  ${dedupedData.stats.total_items_before_dedup} → ${dedupedData.stats.total_items_after_dedup} items (${dedupedData.stats.total_items_before_dedup - dedupedData.stats.total_items_after_dedup} duplicates removed)`,
  );

  // Print category breakdown
  console.log(`  Categories:`);
  console.log(`    evaluation_criteria: ${dedupedData.evaluation_criteria.length}`);
  console.log(`    brand_philosophy: ${dedupedData.brand_philosophy.length}`);
  console.log(`    business_context: ${dedupedData.business_context.length}`);
  console.log(`    growth_strategy: ${dedupedData.growth_strategy.length}`);
  console.log(`    agency_expectations: ${dedupedData.agency_expectations.length}`);
  console.log(`    creative_preferences: ${dedupedData.creative_preferences.length}`);
  console.log(`    decision_examples: ${dedupedData.decision_examples.length}`);
  console.log(`    direct_quotes: ${dedupedData.direct_quotes.length}`);

  // Phase 4: Synthesis
  console.log("\nPhase 4: Synthesizing...");
  const methodology = await synthesize(dedupedData);
  writeFileSync(METHODOLOGY_FILE, methodology);
  console.log(`  Wrote ${METHODOLOGY_FILE} (${methodology.split(/\s+/).length} words)`);

  const voice = generateVoiceDoc(dedupedData.direct_quotes);
  writeFileSync(VOICE_FILE, voice);
  console.log(`  Wrote ${VOICE_FILE} (${dedupedData.direct_quotes.length} quotes)`);

  console.log("\n=== Done! ===");
  console.log(`Output directory: ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
