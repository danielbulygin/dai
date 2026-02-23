/**
 * Backfill Fireflies meeting transcripts into DAI Supabase.
 *
 * Designed for Fireflies' strict rate limits:
 *   - Free/Pro: 50 requests/day
 *   - Business: 60 requests/min
 *
 * Strategy: newest-first, resumable, budget-aware.
 * Each meeting costs 2 API calls (1 list + 1 detail fetch).
 * Run daily until all meetings are synced.
 *
 * Usage:
 *   pnpm backfill:fireflies [--from 2024-12-01] [--budget 40] [--dry-run]
 */

import { createClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Config from env
// ---------------------------------------------------------------------------

const FIREFLIES_API_KEY = process.env.FIREFLIES_API_KEY;
const DAI_SUPABASE_URL = process.env.DAI_SUPABASE_URL;
const DAI_SUPABASE_SERVICE_KEY = process.env.DAI_SUPABASE_SERVICE_KEY;

if (!FIREFLIES_API_KEY || !DAI_SUPABASE_URL || !DAI_SUPABASE_SERVICE_KEY) {
  console.error(
    "Missing required env vars: FIREFLIES_API_KEY, DAI_SUPABASE_URL, DAI_SUPABASE_SERVICE_KEY",
  );
  process.exit(1);
}

const supabase = createClient(DAI_SUPABASE_URL, DAI_SUPABASE_SERVICE_KEY);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const fromIdx = args.indexOf("--from");
const fromDate = fromIdx !== -1 && args[fromIdx + 1] ? args[fromIdx + 1] : "2024-12-01";
const budgetIdx = args.indexOf("--budget");
const API_BUDGET = budgetIdx !== -1 && args[budgetIdx + 1] ? parseInt(args[budgetIdx + 1]) : 40;

let apiCalls = 0;

if (dryRun) console.log("[DRY RUN] No data will be written.\n");
console.log(`Config: from=${fromDate}, budget=${API_BUDGET} API calls, dry=${dryRun}\n`);

// ---------------------------------------------------------------------------
// Fireflies GraphQL
// ---------------------------------------------------------------------------

const FIREFLIES_API = "https://api.fireflies.ai/graphql";
const REQUEST_DELAY = 1500; // ms between all API calls

async function firefliesQuery(query: string, variables?: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  apiCalls++;
  if (apiCalls > API_BUDGET) {
    console.log(`\n[BUDGET] Hit ${API_BUDGET} API call limit. Run again tomorrow to continue.`);
    return null;
  }

  await sleep(REQUEST_DELAY);

  const res = await fetch(FIREFLIES_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${FIREFLIES_API_KEY}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) {
      console.error(`\n[RATE LIMITED] HTTP 429. Stop and retry later.`);
      return null;
    }
    throw new Error(`Fireflies API ${res.status}: ${text}`);
  }

  const json = (await res.json()) as { data?: Record<string, unknown>; errors?: Array<{ message: string; code?: string }> };
  if (json.errors?.length) {
    const code = (json.errors[0] as { code?: string; extensions?: { code?: string } }).extensions?.code ?? "";
    if (code === "auth_failed") {
      // Fireflies returns this for rate limits AND pagination overflow
      console.error(`\n[RATE LIMITED] API returned auth_failed (likely rate limit). Stop.`);
      return null;
    }
    throw new Error(`Fireflies GraphQL: ${json.errors[0].message}`);
  }

  return json.data ?? null;
}

interface TranscriptListItem {
  id: string;
  title: string;
  date: string;
}

interface MeetingDetail {
  id: string;
  title: string;
  date: string;
  duration: number;
  organizer_email: string;
  participants: string[];
  speakers: Array<{ name: string }>;
  summary: {
    keywords: string[];
    action_items: string;
    overview: string;
    shorthand_bullet: string;
    gist: string;
    short_summary: string;
  };
  sentences: Array<{
    index: number;
    speaker_name: string;
    text: string;
    raw_text: string;
    start_time: number;
    end_time: number;
  }>;
}

/**
 * List meetings newest-first using date-windowed pagination.
 * Starts from now, works backwards to fromDate.
 * Each page = 1 API call.
 */
async function listMeetings(since: string): Promise<TranscriptListItem[] | null> {
  const all: TranscriptListItem[] = [];
  let toDate: string | null = null; // null = from now
  const sinceTs = new Date(since).getTime();

  while (apiCalls < API_BUDGET) {
    const vars: Record<string, unknown> = { limit: 50 };
    if (toDate) vars.toDate = toDate;

    const data = await firefliesQuery(
      `query($limit: Int, $toDate: DateTime) {
        transcripts(limit: $limit, toDate: $toDate) {
          id title date
        }
      }`,
      vars,
    );

    if (!data) return all.length > 0 ? all : null; // budget/rate exhausted
    const page = (data.transcripts ?? []) as TranscriptListItem[];
    if (page.length === 0) break;

    // Filter and collect
    let hitCutoff = false;
    for (const t of page) {
      const ts = parseInt(t.date);
      if (ts < sinceTs) {
        hitCutoff = true;
        break;
      }
      all.push(t);
    }

    if (hitCutoff || page.length < 50) break;

    // Move window: toDate = 1ms before oldest in this page
    const oldestDate = Math.min(...page.map((t) => parseInt(t.date)));
    toDate = new Date(oldestDate - 1).toISOString();

    process.stdout.write(`  Listed ${all.length} meetings so far...\r`);
  }

  console.log(`  Listed ${all.length} meetings total.          `);
  return all;
}

async function fetchDetail(id: string): Promise<MeetingDetail | null> {
  const data = await firefliesQuery(
    `query($id: String!) {
      transcript(id: $id) {
        id title date duration organizer_email participants
        speakers { name }
        summary { keywords action_items overview shorthand_bullet gist short_summary }
        sentences { index speaker_name text raw_text start_time end_time }
      }
    }`,
    { id },
  );

  if (!data) return null;
  return data.transcript as MeetingDetail;
}

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

async function getExistingIds(): Promise<Set<string>> {
  const { data, error } = await supabase.from("meetings").select("id");
  if (error) throw new Error(`Failed to fetch existing meetings: ${error.message}`);
  return new Set((data ?? []).map((r: { id: string }) => r.id));
}

async function upsertMeeting(meeting: MeetingDetail): Promise<void> {
  const speakers = meeting.speakers?.map((s) => s.name) ?? [];
  const summary = meeting.summary ?? ({} as MeetingDetail["summary"]);
  const fullTranscript = (meeting.sentences ?? [])
    .map((s) => `${s.speaker_name}: ${s.text}`)
    .join("\n");

  const { error } = await supabase.from("meetings").upsert({
    id: meeting.id,
    title: meeting.title,
    date: meeting.date ? new Date(parseInt(meeting.date)).toISOString() : null,
    duration: meeting.duration,
    organizer_email: meeting.organizer_email,
    speakers,
    participant_emails: meeting.participants ?? [],
    short_summary: summary.short_summary ?? null,
    keywords: summary.keywords ?? [],
    action_items: summary.action_items ?? null,
    overview: summary.overview ?? null,
    notes: summary.shorthand_bullet ?? null,
    gist: summary.gist ?? null,
    full_transcript: fullTranscript || null,
  });

  if (error) throw new Error(`Upsert meeting ${meeting.id}: ${error.message}`);
}

async function insertSentences(meetingId: string, sentences: MeetingDetail["sentences"]): Promise<void> {
  if (!sentences.length) return;

  await supabase.from("meeting_sentences").delete().eq("meeting_id", meetingId);

  const CHUNK = 200;
  for (let i = 0; i < sentences.length; i += CHUNK) {
    const chunk = sentences.slice(i, i + CHUNK).map((s) => ({
      meeting_id: meetingId,
      sentence_index: s.index,
      speaker_name: s.speaker_name,
      text: s.text,
      raw_text: s.raw_text,
      start_time: s.start_time,
      end_time: s.end_time,
    }));

    const { error } = await supabase.from("meeting_sentences").insert(chunk);
    if (error) throw new Error(`Insert sentences ${meetingId}: ${error.message}`);
  }
}

async function updateSyncState(totalSynced: number, lastError?: string): Promise<void> {
  await supabase.from("sync_state").update({
    last_synced_at: new Date().toISOString(),
    last_sync_run: new Date().toISOString(),
    total_synced: totalSynced,
    last_error: lastError ?? null,
  }).eq("id", 1);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const startTime = Date.now();
  console.log("=== Fireflies -> DAI Supabase Backfill ===\n");

  // 1. List meetings (newest first, stops at fromDate)
  console.log("Step 1: Listing meetings from Fireflies (newest first)...");
  const meetings = await listMeetings(fromDate);
  if (!meetings || meetings.length === 0) {
    console.log("No meetings to sync (or budget exhausted on listing).");
    return;
  }
  console.log(`  API calls used for listing: ${apiCalls}\n`);

  // 2. Deduplicate against existing DB
  console.log("Step 2: Checking existing meetings in Supabase...");
  const existingIds = dryRun ? new Set<string>() : await getExistingIds();
  const newMeetings = meetings.filter((m) => !existingIds.has(m.id));
  console.log(`  ${existingIds.size} already in DB, ${newMeetings.length} new to sync.`);
  console.log(`  Remaining API budget: ${API_BUDGET - apiCalls} calls = ~${API_BUDGET - apiCalls} meetings\n`);

  if (newMeetings.length === 0) {
    console.log("All listed meetings already synced.");
    return;
  }

  if (dryRun) {
    console.log("[DRY RUN] Would sync (newest first):");
    for (const m of newMeetings.slice(0, 20)) {
      const date = m.date ? new Date(parseInt(m.date)).toISOString().slice(0, 10) : "?";
      console.log(`  - ${m.title} (${date})`);
    }
    if (newMeetings.length > 20) console.log(`  ... and ${newMeetings.length - 20} more`);
    return;
  }

  // 3. Fetch details & sync (1 API call per meeting)
  console.log("Step 3: Fetching details and syncing...\n");
  let synced = 0;
  let errors = 0;
  let lastError: string | undefined;

  for (const m of newMeetings) {
    if (apiCalls >= API_BUDGET) {
      console.log(`\n[BUDGET] Reached ${API_BUDGET} API calls. Run again tomorrow.`);
      break;
    }

    const date = m.date ? new Date(parseInt(m.date)).toISOString().slice(0, 10) : "?";

    try {
      const detail = await fetchDetail(m.id);
      if (!detail) break; // budget or rate limited

      await upsertMeeting(detail);
      await insertSentences(m.id, detail.sentences ?? []);

      synced++;
      console.log(
        `  [${synced}/${newMeetings.length}] ${m.title} (${date}) — ${(detail.sentences ?? []).length} sentences`,
      );

      if (synced % 5 === 0) {
        await updateSyncState(existingIds.size + synced);
      }
    } catch (err) {
      errors++;
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`  [ERROR] ${m.title} (${date}): ${lastError}`);
    }
  }

  await updateSyncState(existingIds.size + synced, lastError);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const remaining = newMeetings.length - synced;
  console.log(
    `\n=== Done in ${elapsed}s! Synced: ${synced}, Errors: ${errors}, API calls: ${apiCalls}/${API_BUDGET} ===`,
  );
  console.log(`DB total: ${existingIds.size + synced}. Remaining: ${remaining > 0 ? remaining : 0}.`);
  if (remaining > 0) {
    console.log(`Run again tomorrow to continue (resumable — skips already-synced meetings).`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
