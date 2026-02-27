/**
 * Phase 3: Bulk methodology extraction from meeting transcripts.
 *
 * Reads all 2,472 Fireflies meeting transcripts from DAI Supabase,
 * filters to media-buying-relevant meetings, and extracts structured
 * methodology using Claude Opus.
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
 */

import Anthropic from "@anthropic-ai/sdk";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EXTRACTION_MODEL = "claude-opus-4-6";
const MAX_TRANSCRIPT_CHARS = 80_000;
const REQUEST_DELAY_MS = 2_000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_CONCURRENCY = 2;

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
if (!ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY");
  process.exit(1);
}

const supabase: SupabaseClient = createClient(
  DAI_SUPABASE_URL,
  DAI_SUPABASE_SERVICE_KEY,
);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

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
// Extraction prompt
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM = `You are extracting media buying knowledge from a meeting transcript.

The speaker Daniel Bulygin is the head of performance marketing at Ads on Tap (adsontap.io), a paid media agency. Nina is a senior media buyer. Other speakers may be clients or team members.

Extract the following categories. Return ONLY a valid JSON object with these exact keys.

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
- If the meeting has no media buying content, return all empty arrays.
- Return ONLY valid JSON, no other text, no markdown code fences.`;

function buildExtractionUserMessage(m: MeetingRow): string {
  const date = m.date ? new Date(m.date).toISOString().slice(0, 10) : "unknown";
  const speakers = (m.speakers ?? []).join(", ") || "unknown";

  let transcript = m.full_transcript ?? "";
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript =
      transcript.slice(0, MAX_TRANSCRIPT_CHARS) +
      "\n\n[... transcript truncated at 80k chars]";
  }

  return [
    `Meeting: ${m.title ?? "Untitled"} (${date})`,
    `Speakers: ${speakers}`,
    m.short_summary ? `Summary: ${m.short_summary}` : "",
    "",
    "Transcript:",
    transcript,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Extraction logic
// ---------------------------------------------------------------------------

async function extractFromMeeting(
  m: MeetingRow,
): Promise<ExtractionResult | null> {
  if (!m.full_transcript || m.full_transcript.trim().length < 200) {
    return null; // Too short to be useful
  }

  const response = await anthropic.messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: 8192,
    system: EXTRACTION_SYSTEM,
    messages: [{ role: "user", content: buildExtractionUserMessage(m) }],
  });

  const responseText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  // Strip markdown fences if Claude wraps the JSON
  const cleaned = responseText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const parsed = JSON.parse(cleaned) as Record<string, unknown[]>;
  const meetingDate = m.date
    ? new Date(m.date).toISOString().slice(0, 10)
    : "unknown";
  const meetingTitle = m.title ?? "Untitled";

  // Attach source metadata to each item
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
    global_rules: annotate<GlobalRule>(
      parsed["global_rules"] as unknown[],
    ),
    account_insights: annotate<AccountInsight>(
      parsed["account_insights"] as unknown[],
    ),
    decision_examples: annotate<DecisionExample>(
      parsed["decision_examples"] as unknown[],
    ),
    creative_patterns: annotate<CreativePattern>(
      parsed["creative_patterns"] as unknown[],
    ),
    methodology_steps: annotate<MethodologyStep>(
      parsed["methodology"] as unknown[],
    ),
  };
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

  // Deduplicate each category
  const globalRules = deduplicateByContent(allRules, "rule");
  const decisionExamples = deduplicateByContent(allDecisions, "reasoning");
  const creativePatterns = deduplicateByContent(allCreative, "pattern");
  const methodologySteps = deduplicateByContent(allMethodology, "description");

  // Group account insights by account code, then deduplicate within each
  const accountInsights = new Map<string, AccountInsight[]>();
  for (const insight of allInsights) {
    const code = insight.account_code.toLowerCase().replace(/\s+/g, "_");
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

  // Per-account insights
  const accountDir = join(OUTPUT_DIR, "account-insights");
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

async function processBatch(
  meetings: MeetingRow[],
  progress: Progress,
  batchNum: number,
  totalBatches: number,
): Promise<void> {
  console.log(
    `\n--- Batch ${batchNum}/${totalBatches} (${meetings.length} meetings) ---`,
  );

  // Process with limited concurrency
  let idx = 0;
  const pending = new Set<Promise<void>>();

  for (const meeting of meetings) {
    if (progress.processed_ids.includes(meeting.id)) continue;

    const task = (async () => {
      const num = ++idx;
      const date = meeting.date
        ? new Date(meeting.date).toISOString().slice(0, 10)
        : "?";

      try {
        const result = await extractFromMeeting(meeting);
        if (result) {
          saveRawResult(result);
          const counts = [
            result.global_rules.length,
            result.account_insights.length,
            result.decision_examples.length,
            result.creative_patterns.length,
            result.methodology_steps.length,
          ];
          console.log(
            `  [${num}/${meetings.length}] ${meeting.title} (${date}) — ` +
              `rules:${counts[0]} insights:${counts[1]} decisions:${counts[2]} creative:${counts[3]} methodology:${counts[4]}`,
          );
        } else {
          console.log(
            `  [${num}/${meetings.length}] ${meeting.title} (${date}) — skipped (no/short transcript)`,
          );
        }

        progress.processed_ids.push(meeting.id);
        progress.processed_count++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `  [${num}/${meetings.length}] ERROR: ${meeting.title} (${date}) — ${msg}`,
        );
        progress.errors.push({ meeting_id: meeting.id, error: msg });
        progress.processed_ids.push(meeting.id); // Don't retry on resume
      }

      // Rate limiting
      await sleep(REQUEST_DELAY_MS);
    })();

    pending.add(task);
    task.finally(() => pending.delete(task));

    // Limit concurrency
    if (pending.size >= concurrency) {
      await Promise.race(pending);
    }
  }

  // Wait for remaining
  await Promise.all(pending);

  // Save progress after each batch
  saveProgress(progress);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const startTime = Date.now();
  console.log("=== Phase 3: Methodology Extraction from Transcripts ===\n");
  console.log(
    `Config: model=${EXTRACTION_MODEL}, batch_size=${batchSize}, concurrency=${concurrency}, ` +
      `priority=${priorityFilter}, limit=${limit || "none"}, dry_run=${dryRun}, resume=${resume}\n`,
  );

  // Ensure output directories
  mkdirSync(RAW_DIR, { recursive: true });

  // 1. Fetch all meeting metadata (paginated — Supabase defaults to 1000 rows)
  console.log("Step 1: Fetching all meetings from DAI Supabase...");
  const meetings: MeetingRow[] = [];
  const PAGE_SIZE = 1000;
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("meetings")
      .select("id, title, date, speakers, short_summary, full_transcript")
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

  console.log(`  Total meetings in DB: ${meetings.length}`);

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
    const dryRunMeetings: typeof relevant = [];
    dryRunMeetings.push(...byPriority.p1);
    if (priorityFilter === "p2" || priorityFilter === "all") {
      dryRunMeetings.push(...byPriority.p2);
    }
    if (priorityFilter === "all") {
      dryRunMeetings.push(...byPriority.p3);
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
    const avgCharsPerMeeting =
      withTranscripts.reduce(
        (sum, c) => sum + (c.meeting.full_transcript?.length ?? 0),
        0,
      ) / Math.max(withTranscripts.length, 1);
    const avgTokensIn = avgCharsPerMeeting / 4;
    const avgTokensOut = 2000;
    const costPerInputToken = 15 / 1_000_000; // Opus input
    const costPerOutputToken = 75 / 1_000_000; // Opus output
    const totalCost =
      withTranscripts.length *
      (avgTokensIn * costPerInputToken + avgTokensOut * costPerOutputToken);

    console.log(
      `\n  Meetings with transcript (>=200 chars): ${withTranscripts.length}/${effectiveCount}`,
    );
    console.log(
      `  Estimated cost: $${totalCost.toFixed(0)} (${withTranscripts.length} meetings × ~${Math.round(avgTokensIn)} input tokens avg)`,
    );
    console.log(
      `  Estimated time: ${Math.round((withTranscripts.length * REQUEST_DELAY_MS) / 1000 / 60 / concurrency)} minutes at ${concurrency} concurrency`,
    );
    console.log("\n  Run without --dry-run to start extraction.");
    console.log("  Options: --priority p1|p2|all  --limit N  --resume  --concurrency N");
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

  // Apply limit
  if (limit > 0 && toProcess.length > limit) {
    toProcess = toProcess.slice(0, limit);
  }

  console.log(
    `\nStep 3: Processing ${toProcess.length} meetings (${progress.processed_count} already done)...`,
  );

  // Process in batches
  const totalBatches = Math.ceil(toProcess.length / batchSize);
  for (let i = 0; i < toProcess.length; i += batchSize) {
    const batch = toProcess.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    await processBatch(batch, progress, batchNum, totalBatches);
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
