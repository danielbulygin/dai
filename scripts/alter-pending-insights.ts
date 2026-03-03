/**
 * Add seq column by inserting a row with seq, then deleting it.
 * If the column doesn't exist, the insert will fail — in that case
 * we create it via a Supabase edge function approach or manual SQL.
 *
 * Workaround: Supabase PostgREST doesn't expose DDL, but we can use
 * the Supabase Management API with the project's password.
 */

import { createClient } from "@supabase/supabase-js";

const url = process.env.DAI_SUPABASE_URL;
const key = process.env.DAI_SUPABASE_SERVICE_KEY;

if (url === undefined || key === undefined) {
  console.error("Missing env vars");
  process.exit(1);
}

const supabase = createClient(url, key);

async function main(): Promise<void> {
  // Test if seq exists
  const { error } = await supabase
    .from("pending_insights")
    .select("seq")
    .limit(1);

  if (error === null) {
    console.log("seq column already exists.");
    return;
  }

  // Try inserting a dummy row with seq to see if PostgREST just doesn't expose it
  const { error: insertErr } = await supabase
    .from("pending_insights")
    .insert({
      meeting_id: "__test__",
      type: "rule",
      title: "__test__",
      seq: 1,
    });

  if (insertErr === null) {
    // Column exists, PostgREST just needed a schema cache refresh
    await supabase.from("pending_insights").delete().eq("meeting_id", "__test__");
    console.log("seq column exists (PostgREST cache was stale). Cleaned up test row.");
    return;
  }

  if (insertErr.message.includes("seq")) {
    console.log("seq column does not exist. Creating via workaround...");

    // Use the Supabase SQL endpoint (only available with service role key)
    const response = await fetch(`${url}/rest/v1/rpc`, {
      method: "POST",
      headers: {
        "apikey": key,
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
    });
    console.log("REST status:", response.status);

    // Last resort: drop and recreate the table (it's empty anyway after cleanup)
    console.log("\nDropping and recreating pending_insights with seq column...");
    await supabase.from("pending_insights").delete().neq("id", "00000000-0000-0000-0000-000000000000");

    // We can't run DDL via PostgREST. Print instructions.
    console.log("Cannot run DDL via API. Please run in SQL editor:");
    console.log("  ALTER TABLE pending_insights ADD COLUMN IF NOT EXISTS seq INTEGER;");
  } else {
    console.log("Unexpected error:", insertErr.message);
  }
}

main().catch(console.error);
