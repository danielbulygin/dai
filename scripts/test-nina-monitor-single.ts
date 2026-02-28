/**
 * Run the methodology extraction pipeline on a single meeting.
 * Usage: pnpm tsx scripts/test-nina-monitor-single.ts
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
  // Clean up any orphaned pending insights from previous failed runs
  const { data: orphaned } = await supabase
    .from("pending_insights")
    .select("id")
    .eq("status", "pending");
  if (orphaned && orphaned.length > 0) {
    await supabase.from("pending_insights").delete().eq("status", "pending");
    console.log(`Cleaned up ${orphaned.length} orphaned pending insights from previous run.\n`);
  }

  // Find the Nina & Daniel bi-weekly from Feb 23
  const { data: meetings, error } = await supabase
    .from("meetings")
    .select("id, title, date, speakers, short_summary")
    .ilike("title", "%Nina%Daniel%bi-weekly%")
    .gte("date", "2026-02-23")
    .lte("date", "2026-02-24")
    .eq("organizer_email", "daniel.bulygin@gmail.com")
    .limit(1);

  if (error) {
    console.error("Query failed:", error.message);
    process.exit(1);
  }

  if (meetings === null || meetings.length === 0) {
    console.error("Meeting not found");
    process.exit(1);
  }

  const meeting = meetings[0];
  const meetingDate = meeting.date
    ? new Date(meeting.date).toISOString().slice(0, 10)
    : "2026-02-23";

  console.log(`Found: ${meeting.title} (${meetingDate})`);
  console.log(`Speakers: ${(meeting.speakers ?? []).join(", ")}`);
  console.log(`ID: ${meeting.id}\n`);

  // Run extraction
  console.log("=== Running two-stage extraction ===\n");
  const { extractMethodologyInsights } = await import("../src/learning/methodology-extractor.js");

  const insights = await extractMethodologyInsights(
    meeting.id,
    meeting.title ?? "Nina & Daniel bi-weekly",
    meetingDate,
  );

  console.log(`\n=== Extracted ${insights.length} insights ===\n`);

  for (const insight of insights) {
    const acct = insight.account_code ? ` [${insight.account_code}]` : "";
    const dur = insight.durability === "situational" ? " (situational)" : "";
    console.log(`  ${insight.type}${acct}${dur}: ${insight.title}`);
  }

  if (insights.length === 0) {
    console.log("No insights to send for approval.");
    return;
  }

  // Send for Slack approval
  console.log("\n=== Sending for Slack approval ===\n");
  const { sendInsightsForApproval } = await import("../src/learning/insight-approval.js");

  const counts = await sendInsightsForApproval(
    insights,
    meeting.id,
    meeting.title ?? "Nina & Daniel bi-weekly",
    meetingDate,
  );

  console.log(`Sent ${counts.durable} durable insights for approval, ${counts.situational} situational auto-saved. Check your Slack DMs.`);

  // Log to ingestion log so it doesn't get re-processed
  const { nanoid } = await import("nanoid");
  await supabase
    .from("transcript_ingestion_log")
    .upsert(
      {
        id: nanoid(),
        meeting_id: meeting.id,
        meeting_title: meeting.title,
        pattern_id: "nina-daniel-monitoring",
        insights_extracted: insights.length,
      },
      { onConflict: "meeting_id", ignoreDuplicates: true },
    );

  console.log("Logged to transcript_ingestion_log.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
