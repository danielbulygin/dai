/**
 * Add seq column to pending_insights (already-applied migration didn't have it).
 * Usage: pnpm tsx scripts/add-seq-column.ts
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
  // Test if seq column exists by trying to select it
  const { error } = await supabase
    .from("pending_insights")
    .select("seq")
    .limit(1);

  if (error === null) {
    console.log("seq column already exists.");
  } else {
    console.log("seq column missing. Please run in Supabase SQL editor:");
    console.log("  ALTER TABLE pending_insights ADD COLUMN seq INTEGER;");
    console.log("\nURL: https://supabase.com/dashboard/project/fgwzscafqolpjtmcnxhn/sql/new");
  }

  // Clean up any orphaned pending insights
  const { data: orphaned } = await supabase
    .from("pending_insights")
    .select("id")
    .eq("status", "pending");

  if (orphaned && orphaned.length > 0) {
    await supabase.from("pending_insights").delete().eq("status", "pending");
    console.log(`\nCleaned up ${orphaned.length} orphaned pending insights.`);
  }

  // Clean up ingestion log for re-testing
  const { data: logEntry } = await supabase
    .from("transcript_ingestion_log")
    .select("id")
    .eq("pattern_id", "nina-daniel-monitoring");

  if (logEntry && logEntry.length > 0) {
    await supabase
      .from("transcript_ingestion_log")
      .delete()
      .eq("pattern_id", "nina-daniel-monitoring");
    console.log(`Cleaned up ${logEntry.length} ingestion log entries for re-testing.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
