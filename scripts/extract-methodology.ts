/**
 * Phase 3: Bulk methodology extraction from meeting transcripts.
 *
 * Two-stage pipeline for cost efficiency:
 *   Stage 1 (Haiku — cheap): Scan full transcript, extract only the relevant
 *     media-buying snippets. Meetings with no relevant content are skipped.
 *   Stage 2 (Opus — deep): Structured methodology extraction from the
 *     concentrated snippets only.
 *
 * This saves ~50-70% vs sending full transcripts to Opus, because:
 *   - Most transcripts are 80% greetings, scheduling, off-topic
 *   - Meetings with zero media buying content skip Stage 2 entirely
 *   - Opus processes 2-5k tokens of focused content instead of 20-40k
 *
 * Output: data/extraction/*.json files with global rules, account insights,
 * creative patterns, decision examples, and methodology steps.
 *
 * Usage:
 *   pnpm extract:methodology -- --dry-run              # Preview what will be processed
 *   pnpm extract:methodology                           # Full run (all priorities)
 *   pnpm extract:methodology -- --priority p1          # Only Nina/Daniel calls
 *   pnpm extract:methodology -- --priority p2          # P1 + client-specific
 *   pnpm extract:methodology -- --limit 50             # Process at most 50 meetings
 *   pnpm extract:methodology -- --resume               # Resume from last run
 *   pnpm extract:methodology -- --concurrency 3        # Parallel API calls
 *   pnpm extract:methodology -- --batch-size 20        # Meetings per batch
 *   pnpm extract:methodology -- --single-stage         # Skip Stage 1, send full transcript to Opus
 *   pnpm extract:methodology -- --reaggregate          # Re-aggregate raw files (e.g., after normalization changes)
 *   pnpm extract:methodology -- --load                 # Load aggregated JSON into DAI Supabase + seed SQLite learnings
 */

import Anthropic from "@anthropic-ai/sdk";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { ACCOUNT_CODE_ALIASES, normalizeAccountCode } from "../src/utils/account-codes.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FILTER_MODEL = "claude-haiku-4-5-20251001"; // Stage 1: cheap snippet extraction
const EXTRACTION_MODEL = "claude-opus-4-6"; // Stage 2: deep structured extraction
const MAX_TRANSCRIPT_CHARS = 80_000;
const REQUEST_DELAY_MS = 2_000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_CONCURRENCY = 2;

// Daniel's Fireflies recordings — filter to this to avoid duplicates.
// Each meeting participant with Fireflies gets their own copy; we only want Daniel's.
const DANIEL_ORGANIZER_EMAIL = "daniel.bulygin@gmail.com";

const OUTPUT_DIR = join(process.cwd(), "data", "extraction");
const PROGRESS_FILE = join(OUTPUT_DIR, "progress.json");
const RAW_DIR = join(OUTPUT_DIR, "raw");

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

// Anthropic client is only needed for extraction (not --load or --reaggregate)
function getAnthropic(): Anthropic {
  if (!ANTHROPIC_API_KEY) {
    console.error("Missing ANTHROPIC_API_KEY");
    process.exit(1);
  }
  return new Anthropic({ apiKey: ANTHROPIC_API_KEY });
}
let _anthropic: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!_anthropic) _anthropic = getAnthropic();
  return _anthropic;
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const resume = args.includes("--resume");

function getArgValue(flag: string, fallback: number): number {
  const idx = args.indexOf(flag);
  if (idx === -1 || !args[idx + 1]) return fallback;
  const val = parseInt(args[idx + 1]!, 10);
  return isNaN(val) ? fallback : val;
}

const batchSize = getArgValue("--batch-size", DEFAULT_BATCH_SIZE);
const concurrency = getArgValue("--concurrency", DEFAULT_CONCURRENCY);
const limit = getArgValue("--limit", 0); // 0 = no limit

// Priority filter: "p1" = only P1, "p2" = P1+P2, "all" = everything
function getStringArg(flag: string, fallback: string): string {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1]! : fallback;
}
const priorityFilter = getStringArg("--priority", "all");
const singleStage = args.includes("--single-stage");
const titleMatch = getStringArg("--title-match", "");
const titleRegex = titleMatch ? new RegExp(titleMatch, "i") : null;
const reaggregate = args.includes("--reaggregate");
const loadFlag = args.includes("--load");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MeetingRow {
  id: string;
  title: string | null;
  date: string | null;
  speakers: string[] | null;
  short_summary: string | null;
  full_transcript: string | null;
}

interface GlobalRule {
  rule: string;
  rationale: string;
  confidence: "high" | "medium";
  source_quote: string;
  source_meeting: string;
  source_date: string;
}

interface AccountInsight {
  account_code: string;
  insight: string;
  category:
    | "what_works"
    | "what_doesnt"
    | "quirk"
    | "audience"
    | "creative"
    | "targeting"
    | "structure";
  confidence: "high" | "medium";
  source_meeting: string;
  source_date: string;
}

interface DecisionExample {
  account_code: string;
  decision_type: "kill" | "scale" | "pause" | "iterate" | "restructure";
  target: string;
  reasoning: string;
  outcome_if_known: string | null;
  source_meeting: string;
  source_date: string;
}

interface CreativePattern {
  pattern: string;
  account_code_if_specific: string | null;
  evidence: string;
  confidence: "high" | "medium";
  source_meeting: string;
  source_date: string;
}

interface MethodologyStep {
  step: string;
  description: string;
  when_to_use: string;
  source_meeting: string;
  source_date: string;
}

interface ExtractionResult {
  meeting_id: string;
  meeting_title: string;
  meeting_date: string;
  global_rules: GlobalRule[];
  account_insights: AccountInsight[];
  decision_examples: DecisionExample[];
  creative_patterns: CreativePattern[];
  methodology_steps: MethodologyStep[];
}

interface Progress {
  processed_ids: string[];
  started_at: string;
  last_updated: string;
  total_meetings: number;
  relevant_meetings: number;
  processed_count: number;
  errors: Array<{ meeting_id: string; error: string }>;
}

type MeetingPriority = "p1_nina_daniel" | "p2_client_specific" | "p3_general";

// ---------------------------------------------------------------------------
// Meeting classification
// ---------------------------------------------------------------------------

/** Known client codes and title patterns */
const CLIENT_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: "ninepine", pattern: /ninepine/i },
  { code: "comis", pattern: /comis/i },
  { code: "press_london", pattern: /press\s*london/i },
  { code: "brain_fm", pattern: /brain\.?fm/i },
  { code: "slumber", pattern: /slumber/i },
  { code: "laori", pattern: /laori/i },
  { code: "freeletics", pattern: /freeletics/i },
  { code: "puresport", pattern: /puresport/i },
  { code: "lassie", pattern: /lassie/i },
  { code: "junglück", pattern: /jungl[uü]ck/i },
  { code: "aer", pattern: /\baer\b/i },
  { code: "kousha", pattern: /kousha/i },
  { code: "tenzo", pattern: /tenzo/i },
  { code: "fastic", pattern: /fastic/i },
  { code: "mute", pattern: /\bmute\b/i },
  { code: "alpin_loacker", pattern: /alpin\s*loacker/i },
  { code: "auro", pattern: /\bauro\b/i },
];

/** Strong keywords — clearly media buying. Used for title/summary matching. */
const STRONG_KEYWORDS =
  /\b(account\s*review|media\s*buying|ad\s*performance|roas|cpa|cpm|ctr|ads?\s*manager|meta\s*ads|facebook\s*ads|google\s*ads|performance\s*marketing|ad\s*spend|bid\s*cap|hook\s*rate|hold\s*rate|creative\s*review|creative\s*refresh|retargeting|adset|ad\s*set)\b/i;

/** Broader keywords — relevant when combined with other signals (e.g., nina as speaker) */
const BROAD_KEYWORDS =
  /\b(campaign|creative|conversion|funnel|optimization|targeting|audience|scaling|frequency|impressions|click\s*through|landing\s*page|budget|ads?)\b/i;

function classifyMeeting(
  m: MeetingRow,
): { relevant: boolean; priority: MeetingPriority; accountCodes: string[] } {
  const title = m.title ?? "";
  const summary = m.short_summary ?? "";
  const speakers = (m.speakers ?? []).join(" ");
  const titleAndSummary = `${title} ${summary}`;
  const combined = `${title} ${summary} ${speakers}`;

  // Extract account codes from title + summary (not speakers — "nina" is a speaker, not a client)
  const accountCodes: string[] = [];
  for (const cp of CLIENT_PATTERNS) {
    if (cp.pattern.test(titleAndSummary)) {
      accountCodes.push(cp.code);
    }
  }

  // Check relevance signals
  const hasClient = accountCodes.length > 0;
  const hasStrongKeywords = STRONG_KEYWORDS.test(titleAndSummary);
  const hasBroadKeywords = BROAD_KEYWORDS.test(titleAndSummary);
  const hasNina = /\bnina\b/i.test(speakers);
  const hasDaniel = /\bdaniel\b/i.test(speakers);

  // Relevance gates:
  // - Has a client name in title/summary → always relevant
  // - Has strong media buying keywords in title/summary → always relevant
  // - Has broad keywords AND Nina as speaker → relevant (she's the media buyer)
  // - Just Daniel or just broad keywords → not enough signal
  const relevant =
    hasClient || hasStrongKeywords || (hasNina && hasBroadKeywords);

  // Priority classification
  let priority: MeetingPriority = "p3_general";
  if (hasNina && hasDaniel && (hasClient || hasStrongKeywords || hasBroadKeywords)) {
    priority = "p1_nina_daniel";
  } else if (hasNina && (hasClient || hasStrongKeywords || hasBroadKeywords)) {
    priority = "p1_nina_daniel";
  } else if (hasClient) {
    priority = "p2_client_specific";
  }

  return { relevant, priority, accountCodes };
}

// ---------------------------------------------------------------------------
// Stage 1: Snippet filtering (Haiku — cheap)
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

async function filterSnippets(m: MeetingRow): Promise<string | null> {
  let transcript = m.full_transcript ?? "";
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

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  if (text === "NO_RELEVANT_CONTENT" || text.length < 100) {
    return null;
  }

  return text;
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

Rules:
- Only extract things that are clearly stated or demonstrated. Do not infer.
- Include direct quotes where they capture a principle ("let it cook", "where in the funnel", etc.)
- Be specific and actionable. "ROAS was discussed" is not an insight.
- It's better to extract fewer high-quality insights than many vague ones.
- If the snippets have no extractable methodology, return all empty arrays.
- Return ONLY valid JSON, no other text, no markdown code fences.`;

// ---------------------------------------------------------------------------
// Two-stage extraction
// ---------------------------------------------------------------------------

interface StageResult {
  skipped_stage1: boolean;
  snippets_chars: number;
  extraction: ExtractionResult | null;
}

function parseExtractionResponse(
  responseText: string,
  m: MeetingRow,
): ExtractionResult {
  const cleaned = responseText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const parsed = JSON.parse(cleaned) as Record<string, unknown[]>;
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
    global_rules: annotate<GlobalRule>(parsed["global_rules"] as unknown[]),
    account_insights: annotate<AccountInsight>(parsed["account_insights"] as unknown[]),
    decision_examples: annotate<DecisionExample>(parsed["decision_examples"] as unknown[]),
    creative_patterns: annotate<CreativePattern>(parsed["creative_patterns"] as unknown[]),
    methodology_steps: annotate<MethodologyStep>(parsed["methodology"] as unknown[]),
  };
}

async function extractTwoStage(m: MeetingRow): Promise<StageResult> {
  if (!m.full_transcript || m.full_transcript.trim().length < 200) {
    return { skipped_stage1: true, snippets_chars: 0, extraction: null };
  }

  // Stage 1: Filter with Haiku
  const snippets = await filterSnippets(m);

  if (!snippets) {
    return { skipped_stage1: true, snippets_chars: 0, extraction: null };
  }

  // Stage 2: Extract with Opus from concentrated snippets
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

  const responseText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  const extraction = parseExtractionResponse(responseText, m);
  return { skipped_stage1: false, snippets_chars: snippets.length, extraction };
}

async function extractSingleStage(m: MeetingRow): Promise<StageResult> {
  if (!m.full_transcript || m.full_transcript.trim().length < 200) {
    return { skipped_stage1: true, snippets_chars: 0, extraction: null };
  }

  let transcript = m.full_transcript;
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript =
      transcript.slice(0, MAX_TRANSCRIPT_CHARS) +
      "\n\n[... transcript truncated at 80k chars]";
  }

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
          "Transcript:",
          transcript,
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

  const extraction = parseExtractionResponse(responseText, m);
  return {
    skipped_stage1: false,
    snippets_chars: transcript.length,
    extraction,
  };
}

async function extractFromMeeting(m: MeetingRow): Promise<StageResult> {
  return singleStage ? extractSingleStage(m) : extractTwoStage(m);
}

// ---------------------------------------------------------------------------
// Progress tracking (resumable)
// ---------------------------------------------------------------------------

function loadProgress(): Progress {
  if (resume && existsSync(PROGRESS_FILE)) {
    const data = JSON.parse(readFileSync(PROGRESS_FILE, "utf-8")) as Progress;
    console.log(
      `Resuming from previous run: ${data.processed_count}/${data.relevant_meetings} processed\n`,
    );
    return data;
  }
  return {
    processed_ids: [],
    started_at: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    total_meetings: 0,
    relevant_meetings: 0,
    processed_count: 0,
    errors: [],
  };
}

function saveProgress(progress: Progress): void {
  progress.last_updated = new Date().toISOString();
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function saveRawResult(result: ExtractionResult): void {
  const path = join(RAW_DIR, `${result.meeting_id}.json`);
  writeFileSync(path, JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// Deduplication & aggregation
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

function deduplicateByContent<T extends { [key: string]: unknown }>(
  items: T[],
  contentKey: string,
  threshold = 0.65,
): T[] {
  const deduped: T[] = [];
  for (const item of items) {
    const content = String(item[contentKey] ?? "");
    const isDupe = deduped.some(
      (existing) =>
        computeOverlap(String(existing[contentKey] ?? ""), content) > threshold,
    );
    if (!isDupe) {
      deduped.push(item);
    }
  }
  return deduped;
}

function aggregateResults(resultFiles: string[]): {
  globalRules: GlobalRule[];
  accountInsights: Map<string, AccountInsight[]>;
  decisionExamples: DecisionExample[];
  creativePatterns: CreativePattern[];
  methodologySteps: MethodologyStep[];
} {
  const allRules: GlobalRule[] = [];
  const allInsights: AccountInsight[] = [];
  const allDecisions: DecisionExample[] = [];
  const allCreative: CreativePattern[] = [];
  const allMethodology: MethodologyStep[] = [];

  for (const file of resultFiles) {
    try {
      const result = JSON.parse(
        readFileSync(file, "utf-8"),
      ) as ExtractionResult;
      allRules.push(...result.global_rules);
      allInsights.push(...result.account_insights);
      allDecisions.push(...result.decision_examples);
      allCreative.push(...result.creative_patterns);
      allMethodology.push(...result.methodology_steps);
    } catch {
      // Skip corrupted files
    }
  }

  // Normalize all account codes before deduplication
  for (const insight of allInsights) {
    insight.account_code = normalizeAccountCode(insight.account_code);
  }
  for (const decision of allDecisions) {
    decision.account_code = normalizeAccountCode(decision.account_code);
  }
  for (const pattern of allCreative) {
    if (pattern.account_code_if_specific) {
      pattern.account_code_if_specific = normalizeAccountCode(
        pattern.account_code_if_specific,
      );
    }
  }

  // Deduplicate each category
  const globalRules = deduplicateByContent(allRules, "rule");
  const decisionExamples = deduplicateByContent(allDecisions, "reasoning");
  const creativePatterns = deduplicateByContent(allCreative, "pattern");
  const methodologySteps = deduplicateByContent(allMethodology, "description");

  // Group account insights by normalized code, then deduplicate within each
  const accountInsights = new Map<string, AccountInsight[]>();
  for (const insight of allInsights) {
    const code = insight.account_code;
    const existing = accountInsights.get(code) ?? [];
    existing.push(insight);
    accountInsights.set(code, existing);
  }
  for (const [code, insights] of accountInsights) {
    accountInsights.set(code, deduplicateByContent(insights, "insight"));
  }

  return {
    globalRules,
    accountInsights,
    decisionExamples,
    creativePatterns,
    methodologySteps,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function writeOutputFiles(agg: ReturnType<typeof aggregateResults>): void {
  // Global rules
  writeFileSync(
    join(OUTPUT_DIR, "global-rules.json"),
    JSON.stringify(agg.globalRules, null, 2),
  );

  // Per-account insights — clear old files first to avoid stale aliases
  const accountDir = join(OUTPUT_DIR, "account-insights");
  if (existsSync(accountDir)) {
    for (const f of readdirSync(accountDir)) {
      if (f.endsWith(".json")) unlinkSync(join(accountDir, f));
    }
  }
  mkdirSync(accountDir, { recursive: true });
  for (const [code, insights] of agg.accountInsights) {
    writeFileSync(
      join(accountDir, `${code}.json`),
      JSON.stringify(insights, null, 2),
    );
  }

  // Decision examples
  writeFileSync(
    join(OUTPUT_DIR, "decision-examples.json"),
    JSON.stringify(agg.decisionExamples, null, 2),
  );

  // Creative patterns
  writeFileSync(
    join(OUTPUT_DIR, "creative-patterns.json"),
    JSON.stringify(agg.creativePatterns, null, 2),
  );

  // Methodology steps
  writeFileSync(
    join(OUTPUT_DIR, "methodology-steps.json"),
    JSON.stringify(agg.methodologySteps, null, 2),
  );

  // Summary markdown for human review
  const summaryLines = [
    "# Methodology Extraction Results\n",
    `Extracted: ${new Date().toISOString().slice(0, 10)}\n`,
    `## Statistics`,
    `- Global rules: ${agg.globalRules.length}`,
    `- Account insights: ${[...agg.accountInsights.values()].reduce((sum, a) => sum + a.length, 0)} across ${agg.accountInsights.size} accounts`,
    `- Decision examples: ${agg.decisionExamples.length}`,
    `- Creative patterns: ${agg.creativePatterns.length}`,
    `- Methodology steps: ${agg.methodologySteps.length}`,
    "",
    "## Accounts with Insights",
    ...[...agg.accountInsights.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([code, insights]) => `- **${code}**: ${insights.length} insights`),
    "",
    "## Top Global Rules (by frequency)",
    ...agg.globalRules
      .filter((r) => r.confidence === "high")
      .slice(0, 20)
      .map((r, i) => `${i + 1}. ${r.rule}\n   _"${r.source_quote}"_`),
    "",
    "## Methodology Steps",
    ...agg.methodologySteps
      .slice(0, 20)
      .map((s) => `- **${s.step}**: ${s.description} (${s.when_to_use})`),
  ];

  writeFileSync(join(OUTPUT_DIR, "SUMMARY.md"), summaryLines.join("\n"));
}

// ---------------------------------------------------------------------------
// Rate-limited batch processor
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BatchStats {
  filtered: number;
  extracted: number;
  skipped: number;
  errors: number;
}

async function processBatch(
  meetings: MeetingRow[],
  progress: Progress,
  batchNum: number,
  totalBatches: number,
): Promise<BatchStats> {
  console.log(
    `\n--- Batch ${batchNum}/${totalBatches} (${meetings.length} meetings) ---`,
  );

  const stats: BatchStats = { filtered: 0, extracted: 0, skipped: 0, errors: 0 };
  let idx = 0;
  const pending = new Set<Promise<void>>();

  for (const meeting of meetings) {
    if (progress.processed_ids.includes(meeting.id)) continue;

    const task = (async () => {
      const num = ++idx;
      const date = meeting.date
        ? new Date(meeting.date).toISOString().slice(0, 10)
        : "?";
      const transcriptLen = meeting.full_transcript?.length ?? 0;

      try {
        const result = await extractFromMeeting(meeting);

        if (result.extraction) {
          saveRawResult(result.extraction);
          const counts = [
            result.extraction.global_rules.length,
            result.extraction.account_insights.length,
            result.extraction.decision_examples.length,
            result.extraction.creative_patterns.length,
            result.extraction.methodology_steps.length,
          ];
          const reduction = transcriptLen > 0
            ? Math.round((1 - result.snippets_chars / transcriptLen) * 100)
            : 0;
          const stageInfo = singleStage
            ? ""
            : ` (${reduction}% filtered, ${result.snippets_chars} chars → Opus)`;
          console.log(
            `  [${num}/${meetings.length}] ${meeting.title} (${date})${stageInfo} — ` +
              `rules:${counts[0]} insights:${counts[1]} decisions:${counts[2]} creative:${counts[3]} methodology:${counts[4]}`,
          );
          stats.extracted++;
        } else if (result.skipped_stage1) {
          console.log(
            `  [${num}/${meetings.length}] ${meeting.title} (${date}) — filtered out (no relevant content)`,
          );
          stats.filtered++;
        } else {
          console.log(
            `  [${num}/${meetings.length}] ${meeting.title} (${date}) — skipped (no/short transcript)`,
          );
          stats.skipped++;
        }

        progress.processed_ids.push(meeting.id);
        progress.processed_count++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `  [${num}/${meetings.length}] ERROR: ${meeting.title} (${date}) — ${msg}`,
        );
        progress.errors.push({ meeting_id: meeting.id, error: msg });
        progress.processed_ids.push(meeting.id);
        stats.errors++;
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
    `  Batch summary: ${stats.extracted} extracted, ${stats.filtered} filtered out, ${stats.skipped} skipped, ${stats.errors} errors`,
  );
  return stats;
}

// ---------------------------------------------------------------------------
// Load to Supabase + seed SQLite learnings (--load)
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

function mapGlobalRules(rules: GlobalRule[], run: string): MethodologyRow[] {
  return rules.map((r) => ({
    type: "rule",
    title: r.rule,
    body: { rationale: r.rationale, source_quote: r.source_quote },
    account_code: null,
    category: null,
    confidence: r.confidence,
    source_meeting: r.source_meeting,
    source_date: r.source_date,
    extraction_run: run,
  }));
}

function mapAccountInsights(
  insightsByAccount: Map<string, AccountInsight[]>,
  run: string,
): MethodologyRow[] {
  const rows: MethodologyRow[] = [];
  for (const [code, insights] of insightsByAccount) {
    for (const i of insights) {
      rows.push({
        type: "insight",
        title: i.insight,
        body: {},
        account_code: code,
        category: i.category,
        confidence: i.confidence,
        source_meeting: i.source_meeting,
        source_date: i.source_date,
        extraction_run: run,
      });
    }
  }
  return rows;
}

function mapDecisionExamples(decisions: DecisionExample[], run: string): MethodologyRow[] {
  return decisions.map((d) => ({
    type: "decision",
    title: `${d.decision_type}: ${d.target}`,
    body: { reasoning: d.reasoning, outcome_if_known: d.outcome_if_known },
    account_code: d.account_code,
    category: d.decision_type,
    confidence: null,
    source_meeting: d.source_meeting,
    source_date: d.source_date,
    extraction_run: run,
  }));
}

function mapCreativePatterns(patterns: CreativePattern[], run: string): MethodologyRow[] {
  return patterns.map((p) => ({
    type: "creative_pattern",
    title: p.pattern,
    body: { evidence: p.evidence },
    account_code: p.account_code_if_specific,
    category: null,
    confidence: p.confidence,
    source_meeting: p.source_meeting,
    source_date: p.source_date,
    extraction_run: run,
  }));
}

function mapMethodologySteps(steps: MethodologyStep[], run: string): MethodologyRow[] {
  return steps.map((s) => ({
    type: "methodology",
    title: s.step,
    body: { description: s.description, when_to_use: s.when_to_use },
    account_code: null,
    category: null,
    confidence: null,
    source_meeting: s.source_meeting,
    source_date: s.source_date,
    extraction_run: run,
  }));
}

async function loadToSupabase(): Promise<void> {
  console.log("=== Loading methodology knowledge into DAI Supabase ===\n");

  const extractionRun = `phase3-${new Date().toISOString().slice(0, 10)}`;

  // 1. Read aggregated JSON files
  const globalRulesPath = join(OUTPUT_DIR, "global-rules.json");
  const decisionExamplesPath = join(OUTPUT_DIR, "decision-examples.json");
  const creativePatternsPath = join(OUTPUT_DIR, "creative-patterns.json");
  const methodologyStepsPath = join(OUTPUT_DIR, "methodology-steps.json");
  const accountInsightsDir = join(OUTPUT_DIR, "account-insights");

  if (!existsSync(globalRulesPath)) {
    console.error("No aggregated files found. Run extraction first (without --load).");
    process.exit(1);
  }

  const globalRules = JSON.parse(readFileSync(globalRulesPath, "utf-8")) as GlobalRule[];
  const decisionExamples = JSON.parse(readFileSync(decisionExamplesPath, "utf-8")) as DecisionExample[];
  const creativePatterns = JSON.parse(readFileSync(creativePatternsPath, "utf-8")) as CreativePattern[];
  const methodologySteps = JSON.parse(readFileSync(methodologyStepsPath, "utf-8")) as MethodologyStep[];

  // Load per-account insight files
  const accountInsights = new Map<string, AccountInsight[]>();
  if (existsSync(accountInsightsDir)) {
    for (const file of readdirSync(accountInsightsDir).filter((f) => f.endsWith(".json"))) {
      const code = file.replace(".json", "");
      const insights = JSON.parse(readFileSync(join(accountInsightsDir, file), "utf-8")) as AccountInsight[];
      accountInsights.set(code, insights);
    }
  }

  const insightCount = [...accountInsights.values()].reduce((sum, a) => sum + a.length, 0);
  console.log(`  Loaded from JSON files:`);
  console.log(`    Global rules: ${globalRules.length}`);
  console.log(`    Account insights: ${insightCount} across ${accountInsights.size} accounts`);
  console.log(`    Decision examples: ${decisionExamples.length}`);
  console.log(`    Creative patterns: ${creativePatterns.length}`);
  console.log(`    Methodology steps: ${methodologySteps.length}`);

  // 2. Map to unified schema
  const allRows: MethodologyRow[] = [
    ...mapGlobalRules(globalRules, extractionRun),
    ...mapAccountInsights(accountInsights, extractionRun),
    ...mapDecisionExamples(decisionExamples, extractionRun),
    ...mapCreativePatterns(creativePatterns, extractionRun),
    ...mapMethodologySteps(methodologySteps, extractionRun),
  ];

  console.log(`\n  Total rows to insert: ${allRows.length}`);

  // 3. Delete existing rows (idempotent re-load)
  console.log("\n  Clearing existing methodology_knowledge rows...");
  const { error: deleteError } = await supabase
    .from("methodology_knowledge")
    .delete()
    .neq("id", "00000000-0000-0000-0000-000000000000"); // delete all rows

  if (deleteError) {
    console.error(`  Failed to delete existing rows: ${deleteError.message}`);
    process.exit(1);
  }
  console.log("  Cleared.");

  // 4. Batch insert into Supabase (chunks of 100)
  console.log("  Inserting rows...");
  const BATCH_INSERT_SIZE = 100;
  let inserted = 0;

  for (let i = 0; i < allRows.length; i += BATCH_INSERT_SIZE) {
    const batch = allRows.slice(i, i + BATCH_INSERT_SIZE);
    const { error: insertError } = await supabase
      .from("methodology_knowledge")
      .insert(batch);

    if (insertError) {
      console.error(`  Batch insert failed at offset ${i}: ${insertError.message}`);
      process.exit(1);
    }
    inserted += batch.length;
    process.stdout.write(`  Inserted ${inserted}/${allRows.length}\r`);
  }
  console.log(`  Inserted ${inserted}/${allRows.length} rows into methodology_knowledge.`);

  // 5. Seed learnings in DAI Supabase
  console.log("\n  Seeding learnings in Supabase...");

  const daiUrl = process.env.DAI_SUPABASE_URL;
  const daiKey = process.env.DAI_SUPABASE_SERVICE_KEY;
  if (!daiUrl || !daiKey) {
    console.log("  DAI_SUPABASE_URL/DAI_SUPABASE_SERVICE_KEY not set — skipping learning seeding.");
  } else {
    const daiSupa = createClient(daiUrl, daiKey);
    const ADA_AGENT_ID = "ada";
    const SOURCE_SESSION = "phase3-extraction";

    // Clean previous phase3 entries
    const { data: deleted } = await daiSupa
      .from("learnings")
      .delete()
      .eq("source_session_id", SOURCE_SESSION)
      .select("id");
    console.log(`  Cleaned ${deleted?.length ?? 0} previous phase3 learnings.`);

    // Seed high-confidence global rules as methodology_rule
    const ruleRows: Array<Record<string, unknown>> = [];
    for (const rule of globalRules) {
      if (rule.confidence === "high") {
        ruleRows.push({
          id: nanoid(),
          agent_id: ADA_AGENT_ID,
          category: "methodology_rule",
          content: `${rule.rule}\n\nRationale: ${rule.rationale}`,
          confidence: 0.8,
          source_session_id: SOURCE_SESSION,
          client_code: null,
        });
      }
    }
    if (ruleRows.length > 0) {
      await daiSupa.from("learnings").insert(ruleRows);
    }
    console.log(`  Seeded ${ruleRows.length} high-confidence rules as methodology_rule.`);

    // Seed high-confidence account insights as account_knowledge
    const insightRows: Array<Record<string, unknown>> = [];
    for (const [code, insights] of accountInsights) {
      for (const insight of insights) {
        if (insight.confidence === "high") {
          insightRows.push({
            id: nanoid(),
            agent_id: ADA_AGENT_ID,
            category: "account_knowledge",
            content: insight.insight,
            confidence: 0.7,
            source_session_id: SOURCE_SESSION,
            client_code: code,
          });
        }
      }
    }
    if (insightRows.length > 0) {
      // Insert in batches of 500
      for (let i = 0; i < insightRows.length; i += 500) {
        await daiSupa.from("learnings").insert(insightRows.slice(i, i + 500));
      }
    }
    console.log(`  Seeded ${insightRows.length} high-confidence insights as account_knowledge.`);
  }

  console.log("\n=== Load complete ===");
  console.log(`  Supabase: ${allRows.length} rows in methodology_knowledge`);
  console.log(`  Extraction run: ${extractionRun}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const startTime = Date.now();
  console.log("=== Phase 3: Methodology Extraction from Transcripts ===\n");

  // --load: load aggregated JSON into Supabase + seed SQLite learnings
  if (loadFlag) {
    await loadToSupabase();
    return;
  }

  // --reaggregate: re-aggregate existing raw files without re-extracting
  if (reaggregate) {
    console.log("Re-aggregating existing raw results with updated normalization...\n");
    const rawFiles = readdirSync(RAW_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => join(RAW_DIR, f));
    console.log(`  Found ${rawFiles.length} raw extraction files`);

    const aggregated = aggregateResults(rawFiles);
    writeOutputFiles(aggregated);

    const insightCount = [...aggregated.accountInsights.values()].reduce(
      (sum, a) => sum + a.length,
      0,
    );
    console.log(`\n=== Re-aggregation complete ===`);
    console.log(`  Global rules: ${aggregated.globalRules.length}`);
    console.log(`  Account insights: ${insightCount} across ${aggregated.accountInsights.size} accounts`);
    console.log(`  Decision examples: ${aggregated.decisionExamples.length}`);
    console.log(`  Creative patterns: ${aggregated.creativePatterns.length}`);
    console.log(`  Methodology steps: ${aggregated.methodologySteps.length}`);
    return;
  }

  const pipeline = singleStage ? "single-stage (Opus only)" : `two-stage (${FILTER_MODEL} → ${EXTRACTION_MODEL})`;
  console.log(
    `Config: pipeline=${pipeline}, batch_size=${batchSize}, concurrency=${concurrency}, ` +
      `priority=${priorityFilter}, limit=${limit || "none"}, dry_run=${dryRun}, resume=${resume}\n`,
  );

  // Ensure output directories
  mkdirSync(RAW_DIR, { recursive: true });

  // 1. Fetch Daniel's meeting recordings (paginated — Supabase defaults to 1000 rows)
  //    Each Fireflies user gets their own copy of a meeting. We filter to Daniel's
  //    organizer_email to deduplicate (he's in every meeting we care about).
  console.log("Step 1: Fetching Daniel's meetings from DAI Supabase...");
  const meetings: MeetingRow[] = [];
  const PAGE_SIZE = 1000;
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("meetings")
      .select("id, title, date, speakers, short_summary, full_transcript")
      .eq("organizer_email", DANIEL_ORGANIZER_EMAIL)
      .order("date", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      console.error(`Failed to fetch meetings: ${error.message}`);
      process.exit(1);
    }

    const rows = (data ?? []) as MeetingRow[];
    meetings.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    process.stdout.write(`  Fetched ${meetings.length} meetings so far...\r`);
  }

  console.log(`  Daniel's meetings: ${meetings.length} (filtered by organizer_email)`);

  // 2. Classify meetings
  console.log("\nStep 2: Classifying meetings by relevance and priority...");
  const classified = meetings.map((m) => ({
    meeting: m,
    ...classifyMeeting(m),
  }));

  const relevant = classified.filter((c) => c.relevant);
  const byPriority = {
    p1: relevant.filter((c) => c.priority === "p1_nina_daniel"),
    p2: relevant.filter((c) => c.priority === "p2_client_specific"),
    p3: relevant.filter((c) => c.priority === "p3_general"),
  };

  console.log(`  Relevant: ${relevant.length}/${meetings.length}`);
  console.log(
    `    P1 (Nina/Daniel calls): ${byPriority.p1.length}`,
  );
  console.log(
    `    P2 (Client-specific): ${byPriority.p2.length}`,
  );
  console.log(
    `    P3 (General media buying): ${byPriority.p3.length}`,
  );
  console.log(`  Skipped: ${meetings.length - relevant.length}`);

  // Show account distribution
  const accountCounts = new Map<string, number>();
  for (const c of relevant) {
    for (const code of c.accountCodes) {
      accountCounts.set(code, (accountCounts.get(code) ?? 0) + 1);
    }
  }
  if (accountCounts.size > 0) {
    console.log("\n  Meetings by account:");
    const sorted = [...accountCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [code, count] of sorted) {
      console.log(`    ${code}: ${count}`);
    }
  }

  // 3. Dry-run mode: show sample and exit
  if (dryRun) {
    // Build the filtered set the same way the real run would
    let dryRunMeetings: typeof relevant = [];
    dryRunMeetings.push(...byPriority.p1);
    if (priorityFilter === "p2" || priorityFilter === "all") {
      dryRunMeetings.push(...byPriority.p2);
    }
    if (priorityFilter === "all") {
      dryRunMeetings.push(...byPriority.p3);
    }
    if (titleRegex) {
      dryRunMeetings = dryRunMeetings.filter((c) => titleRegex.test(c.meeting.title ?? ""));
    }
    const effectiveCount = limit > 0 ? Math.min(dryRunMeetings.length, limit) : dryRunMeetings.length;

    console.log(
      `\n[DRY RUN] Would process ${effectiveCount} meetings (priority=${priorityFilter}${limit > 0 ? `, limit=${limit}` : ""}):\n`,
    );

    const sample = dryRunMeetings.slice(0, 15);
    for (const c of sample) {
      const date = c.meeting.date
        ? new Date(c.meeting.date).toISOString().slice(0, 10)
        : "?";
      const accounts = c.accountCodes.length
        ? ` [${c.accountCodes.join(", ")}]`
        : "";
      const transcriptLen = c.meeting.full_transcript?.length ?? 0;
      console.log(
        `  ${c.priority} | ${date} | ${c.meeting.title}${accounts} | ${transcriptLen} chars`,
      );
    }
    if (effectiveCount > 15) {
      console.log(`  ... and ${effectiveCount - 15} more`);
    }

    // Estimate costs based on what would actually be processed
    const targetMeetings = dryRunMeetings.slice(0, effectiveCount);
    const withTranscripts = targetMeetings.filter(
      (c) => (c.meeting.full_transcript?.trim().length ?? 0) >= 200,
    );
    const n = withTranscripts.length;
    const avgCharsPerMeeting =
      withTranscripts.reduce(
        (sum, c) => sum + (c.meeting.full_transcript?.length ?? 0),
        0,
      ) / Math.max(n, 1);
    const avgTokensIn = avgCharsPerMeeting / 4;

    console.log(
      `\n  Meetings with transcript (>=200 chars): ${n}/${effectiveCount}`,
    );
    console.log(`  Avg transcript: ~${Math.round(avgTokensIn)} tokens\n`);

    if (singleStage) {
      // Single-stage: all tokens go to Opus
      const opusIn = 15 / 1_000_000;
      const opusOut = 75 / 1_000_000;
      const cost = n * (avgTokensIn * opusIn + 2000 * opusOut);
      console.log(`  [single-stage] Estimated cost: $${cost.toFixed(0)}`);
      console.log(
        `  [single-stage] Estimated time: ${Math.round((n * REQUEST_DELAY_MS) / 1000 / 60 / concurrency)} min at ${concurrency} concurrency`,
      );
    } else {
      // Two-stage: Haiku filters, Opus extracts from snippets
      const haikuIn = 0.80 / 1_000_000;
      const haikuOut = 4 / 1_000_000;
      const opusIn = 15 / 1_000_000;
      const opusOut = 75 / 1_000_000;
      const snippetTokens = avgTokensIn * 0.25; // ~25% of transcript is relevant
      const yieldRate = 0.60; // ~60% of meetings have relevant content

      const stage1Cost = n * (avgTokensIn * haikuIn + 3000 * haikuOut);
      const stage2Count = Math.round(n * yieldRate);
      const stage2Cost = stage2Count * (snippetTokens * opusIn + 2000 * opusOut);
      const totalCost = stage1Cost + stage2Cost;

      // Compare with single-stage
      const singleCost = n * (avgTokensIn * opusIn + 2000 * opusOut);
      const savings = Math.round((1 - totalCost / singleCost) * 100);

      console.log(`  [two-stage] Stage 1 (Haiku filter): ${n} meetings → $${stage1Cost.toFixed(0)}`);
      console.log(`  [two-stage] Stage 2 (Opus extract): ~${stage2Count} meetings (~${Math.round(yieldRate * 100)}% yield) → $${stage2Cost.toFixed(0)}`);
      console.log(`  [two-stage] Total estimated: $${totalCost.toFixed(0)} (${savings}% savings vs single-stage $${singleCost.toFixed(0)})`);
      console.log(
        `  [two-stage] Estimated time: ${Math.round((n * REQUEST_DELAY_MS + stage2Count * REQUEST_DELAY_MS) / 1000 / 60 / concurrency)} min at ${concurrency} concurrency`,
      );
    }

    console.log("\n  Run without --dry-run to start extraction.");
    console.log("  Options: --priority p1|p2|all  --limit N  --resume  --concurrency N  --single-stage");
    return;
  }

  // 4. Load progress (for resume)
  const progress = loadProgress();
  progress.total_meetings = meetings.length;
  progress.relevant_meetings = relevant.length;

  // Build ordered meeting list based on priority filter
  const orderedMeetings: MeetingRow[] = [];
  orderedMeetings.push(...byPriority.p1.map((c) => c.meeting));
  if (priorityFilter === "p2" || priorityFilter === "all") {
    orderedMeetings.push(...byPriority.p2.map((c) => c.meeting));
  }
  if (priorityFilter === "all") {
    orderedMeetings.push(...byPriority.p3.map((c) => c.meeting));
  }

  // Filter out already-processed meetings
  const processedSet = new Set(progress.processed_ids);
  let toProcess = orderedMeetings.filter((m) => !processedSet.has(m.id));

  // Apply title filter
  if (titleRegex) {
    toProcess = toProcess.filter((m) => titleRegex.test(m.title ?? ""));
    console.log(`  Title filter /${titleMatch}/i: ${toProcess.length} matches`);
  }

  // Apply limit
  if (limit > 0 && toProcess.length > limit) {
    toProcess = toProcess.slice(0, limit);
  }

  console.log(
    `\nStep 3: Processing ${toProcess.length} meetings (${progress.processed_count} already done)...`,
  );

  // Process in batches
  const totalBatches = Math.ceil(toProcess.length / batchSize);
  const totalStats: BatchStats = { filtered: 0, extracted: 0, skipped: 0, errors: 0 };
  for (let i = 0; i < toProcess.length; i += batchSize) {
    const batch = toProcess.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const stats = await processBatch(batch, progress, batchNum, totalBatches);
    totalStats.filtered += stats.filtered;
    totalStats.extracted += stats.extracted;
    totalStats.skipped += stats.skipped;
    totalStats.errors += stats.errors;
  }

  saveProgress(progress);

  // 5. Aggregate and deduplicate
  console.log("\nStep 4: Aggregating and deduplicating results...");
  const rawFiles: string[] = [];
  for (const id of progress.processed_ids) {
    const path = join(RAW_DIR, `${id}.json`);
    if (existsSync(path)) rawFiles.push(path);
  }

  const aggregated = aggregateResults(rawFiles);

  // 6. Write output files
  console.log("Step 5: Writing output files...");
  writeOutputFiles(aggregated);

  // Summary
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  const insightCount = [...aggregated.accountInsights.values()].reduce(
    (sum, a) => sum + a.length,
    0,
  );

  console.log(`\n=== Done in ${elapsed} minutes ===`);
  if (!singleStage) {
    console.log(
      `  Pipeline: ${totalStats.extracted} extracted, ${totalStats.filtered} filtered out by Haiku, ${totalStats.skipped} skipped (no transcript)`,
    );
  }
  console.log(`  Global rules: ${aggregated.globalRules.length}`);
  console.log(
    `  Account insights: ${insightCount} across ${aggregated.accountInsights.size} accounts`,
  );
  console.log(`  Decision examples: ${aggregated.decisionExamples.length}`);
  console.log(`  Creative patterns: ${aggregated.creativePatterns.length}`);
  console.log(`  Methodology steps: ${aggregated.methodologySteps.length}`);
  console.log(`  Errors: ${progress.errors.length}`);
  console.log(`\nOutput files in: ${OUTPUT_DIR}/`);
  console.log(
    "  Run 'cat data/extraction/SUMMARY.md' for a human-readable overview.",
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
