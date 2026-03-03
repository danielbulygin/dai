/**
 * Run the pending_insights migration against DAI Supabase.
 * Usage: pnpm tsx scripts/run-pending-insights-migration.ts
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
  // Check if table already exists
  const { error: checkError } = await supabase
    .from("pending_insights")
    .select("id")
    .limit(1);

  if (checkError === null) {
    console.log("Table pending_insights already exists — migration already applied.");
    return;
  }

  if (checkError.message.includes("does not exist") || checkError.code === "42P01") {
    console.log("Table pending_insights does not exist. Please run this SQL in the Supabase SQL Editor:\n");
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync("supabase/migrations/20260228_pending_insights.sql", "utf-8");
    console.log(sql);
    console.log("\nURL: https://supabase.com/dashboard/project/bzhqvxknwvxhgpovrhlp/sql/new");
  } else {
    console.error("Unexpected error:", checkError.message);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
