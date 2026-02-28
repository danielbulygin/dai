/**
 * Manual test: trigger the Nina/Daniel call monitoring pipeline.
 * Usage: pnpm tsx scripts/test-nina-monitor.ts
 */

import { createClient } from "@supabase/supabase-js";

const url = process.env.DAI_SUPABASE_URL;
const key = process.env.DAI_SUPABASE_SERVICE_KEY;

if (url === undefined || key === undefined) {
  console.error("Missing DAI_SUPABASE_URL or DAI_SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const supabase = createClient(url, key);

async function main(): Promise<void> {
  const DANIEL_ORGANIZER_EMAIL = "daniel.bulygin@gmail.com";

  // 1. Show recent meetings to see what's available
  console.log("=== Recent meetings (last 7 days) ===\n");

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: meetings, error } = await supabase
    .from("meetings")
    .select("id, title, date, speakers, short_summary")
    .eq("organizer_email", DANIEL_ORGANIZER_EMAIL)
    .gt("date", since)
    .order("date", { ascending: false });

  if (error) {
    console.error("Failed to fetch meetings:", error.message);
    process.exit(1);
  }

  if (meetings === null || meetings.length === 0) {
    console.log("No meetings in the last 7 days.");

    // Show last 5 meetings regardless of date
    console.log("\n=== Last 5 meetings (any date) ===\n");
    const { data: allMeetings } = await supabase
      .from("meetings")
      .select("id, title, date, speakers")
      .eq("organizer_email", DANIEL_ORGANIZER_EMAIL)
      .order("date", { ascending: false })
      .limit(5);

    for (const m of allMeetings ?? []) {
      const date = m.date ? new Date(m.date).toISOString().slice(0, 10) : "?";
      const speakers = (m.speakers ?? []).join(", ");
      console.log(`  ${date} | ${m.title} | Speakers: ${speakers}`);
    }
    return;
  }

  for (const m of meetings) {
    const date = m.date ? new Date(m.date).toISOString().slice(0, 10) : "?";
    const speakers = (m.speakers ?? []).join(", ");
    const isNinaDaniel =
      speakers.toLowerCase().includes("nina") && speakers.toLowerCase().includes("daniel");
    const marker = isNinaDaniel ? " <-- NINA/DANIEL" : "";
    console.log(`  ${date} | ${m.title} | Speakers: ${speakers}${marker}`);
  }

  // 2. Check ingestion log
  console.log("\n=== Already ingested (nina-daniel-monitoring) ===\n");
  const { data: ingested } = await supabase
    .from("transcript_ingestion_log")
    .select("meeting_id, meeting_title, pattern_id, insights_extracted")
    .eq("pattern_id", "nina-daniel-monitoring");

  if (ingested === null || ingested.length === 0) {
    console.log("  None yet.");
  } else {
    for (const row of ingested) {
      console.log(`  ${row.meeting_title} — ${row.insights_extracted} insights`);
    }
  }

  // 3. Check pending insights
  console.log("\n=== Pending insights ===\n");
  const { data: pending } = await supabase
    .from("pending_insights")
    .select("id, meeting_title, type, title, status")
    .order("created_at", { ascending: false })
    .limit(10);

  if (pending === null || pending.length === 0) {
    console.log("  None.");
  } else {
    for (const row of pending) {
      console.log(`  [${row.status}] ${row.type}: ${row.title} (from: ${row.meeting_title})`);
    }
  }

  console.log("\n=== To run the full pipeline, use: ===");
  console.log("  pnpm tsx scripts/test-nina-monitor.ts --run\n");

  if (process.argv.includes("--run")) {
    console.log("=== Running monitorNinaDanielCalls() ===\n");
    const { monitorNinaDanielCalls } = await import("../src/learning/transcript-ingestor.js");
    const count = await monitorNinaDanielCalls();
    console.log(`\nProcessed ${count} meetings.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
