/**
 * Backfill Fireflies meeting transcripts into DAI Supabase.
 *
 * Usage:
 *   pnpm backfill:fireflies [--from 2024-12-01] [--dry-run]
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
const fromDate = fromIdx !== -1 && args[fromIdx + 1] ? args[fromIdx + 1] : null;

if (dryRun) console.log("[DRY RUN] No data will be written.\n");
if (fromDate) console.log(`Filtering meetings from: ${fromDate}\n`);

// ---------------------------------------------------------------------------
// Fireflies GraphQL helpers
// ---------------------------------------------------------------------------

const FIREFLIES_API = "https://api.fireflies.ai/graphql";
const PAGE_SIZE = 50;
const PAGE_DELAY = 1500; // ms between list pages
const DETAIL_DELAY = 1200; // ms between detail fetches

async function firefliesQuery(query: string, variables?: Record<string, unknown>) {
  const res = await fetch(FIREFLIES_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${FIREFLIES_API_KEY}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`Fireflies API ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as { data?: Record<string, unknown>; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`Fireflies GraphQL error: ${json.errors[0].message}`);
  }
  return json.data;
}

interface FirefliesMeetingListItem {
  id: string;
  title: string;
  date: string;
  duration: number;
  organizer_email: string;
  participants: string[];
}

async function listAllMeetings(): Promise<FirefliesMeetingListItem[]> {
  const all: FirefliesMeetingListItem[] = [];
  let skip = 0;

  while (true) {
    console.log(`  Fetching meetings page (skip=${skip})...`);
    const data = await firefliesQuery(
      `query($limit: Int, $skip: Int) {
        transcripts(limit: $limit, skip: $skip) {
          id
          title
          date
          duration
          organizer_email
          participants
        }
      }`,
      { limit: PAGE_SIZE, skip },
    );

    const transcripts = (data?.transcripts ?? []) as FirefliesMeetingListItem[];
    if (transcripts.length === 0) break;

    all.push(...transcripts);
    skip += PAGE_SIZE;

    if (transcripts.length < PAGE_SIZE) break;
    await sleep(PAGE_DELAY);
  }

  return all;
}

interface FirefliesSentence {
  index: number;
  speaker_name: string;
  text: string;
  raw_text: string;
  start_time: number;
  end_time: number;
}

interface FirefliesMeetingDetail {
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
  sentences: FirefliesSentence[];
}

async function getMeetingDetail(id: string): Promise<FirefliesMeetingDetail> {
  const data = await firefliesQuery(
    `query($id: String!) {
      transcript(id: $id) {
        id
        title
        date
        duration
        organizer_email
        participants
        speakers { name }
        summary {
          keywords
          action_items
          overview
          shorthand_bullet
          gist
          short_summary
        }
        sentences {
          index
          speaker_name
          text
          raw_text
          start_time
          end_time
        }
      }
    }`,
    { id },
  );

  return data!.transcript as FirefliesMeetingDetail;
}

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

async function getExistingIds(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("meetings")
    .select("id");

  if (error) throw new Error(`Failed to fetch existing meetings: ${error.message}`);
  return new Set((data ?? []).map((r: { id: string }) => r.id));
}

async function upsertMeeting(meeting: FirefliesMeetingDetail): Promise<void> {
  const speakers = meeting.speakers?.map((s) => s.name) ?? [];
  const summary = meeting.summary ?? {};

  // Build full_transcript from sentences
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

  if (error) throw new Error(`Failed to upsert meeting ${meeting.id}: ${error.message}`);
}

async function insertSentences(
  meetingId: string,
  sentences: FirefliesSentence[],
): Promise<void> {
  if (!sentences.length) return;

  // Delete existing sentences for this meeting (clean upsert)
  await supabase
    .from("meeting_sentences")
    .delete()
    .eq("meeting_id", meetingId);

  // Insert in chunks of 100
  const CHUNK = 100;
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
    if (error) {
      throw new Error(
        `Failed to insert sentences for ${meetingId} (chunk ${i}): ${error.message}`,
      );
    }
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
  console.log("=== Fireflies -> DAI Supabase Backfill ===\n");

  // 1. List all meetings from Fireflies
  console.log("Step 1: Listing all Fireflies meetings...");
  const allMeetings = await listAllMeetings();
  console.log(`  Found ${allMeetings.length} total meetings.\n`);

  // 2. Filter by date if specified
  let meetings = allMeetings;
  if (fromDate) {
    const fromTs = new Date(fromDate).getTime();
    meetings = meetings.filter((m) => {
      const meetingTs = parseInt(m.date);
      return meetingTs >= fromTs;
    });
    console.log(`  After date filter: ${meetings.length} meetings.\n`);
  }

  // 3. Deduplicate against existing
  console.log("Step 2: Checking existing meetings in Supabase...");
  const existingIds = dryRun ? new Set<string>() : await getExistingIds();
  const newMeetings = meetings.filter((m) => !existingIds.has(m.id));
  console.log(
    `  ${existingIds.size} already in DB, ${newMeetings.length} new to sync.\n`,
  );

  if (newMeetings.length === 0) {
    console.log("Nothing to sync. All meetings already in Supabase.");
    return;
  }

  if (dryRun) {
    console.log("[DRY RUN] Would sync these meetings:");
    for (const m of newMeetings) {
      const date = m.date
        ? new Date(parseInt(m.date)).toISOString().slice(0, 10)
        : "unknown";
      console.log(`  - ${m.title} (${date})`);
    }
    return;
  }

  // 4. Fetch details and sync each meeting
  console.log("Step 3: Syncing meetings...\n");
  let synced = 0;
  let errors = 0;
  let lastError: string | undefined;

  for (let i = 0; i < newMeetings.length; i++) {
    const m = newMeetings[i];
    const date = m.date
      ? new Date(parseInt(m.date)).toISOString().slice(0, 10)
      : "unknown";

    try {
      // Fetch full detail
      const detail = await getMeetingDetail(m.id);

      // Upsert meeting
      await upsertMeeting(detail);

      // Insert sentences
      await insertSentences(m.id, detail.sentences ?? []);

      synced++;
      console.log(
        `  [${synced}/${newMeetings.length}] Synced: ${m.title} (${date}) — ${(detail.sentences ?? []).length} sentences`,
      );

      // Update sync state periodically
      if (synced % 10 === 0) {
        await updateSyncState(existingIds.size + synced);
      }
    } catch (err) {
      errors++;
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`  [ERROR] ${m.title} (${date}): ${lastError}`);
    }

    // Rate limit
    if (i < newMeetings.length - 1) {
      await sleep(DETAIL_DELAY);
    }
  }

  // 5. Final sync state update
  await updateSyncState(existingIds.size + synced, lastError);

  console.log(
    `\n=== Done! Synced ${synced} meetings, ${errors} errors. Total in DB: ${existingIds.size + synced} ===`,
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
