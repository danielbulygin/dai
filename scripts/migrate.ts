/**
 * Database migrations are now managed via Supabase.
 *
 * Migration files live in: supabase/migrations/
 *
 * To run migrations:
 *   - Local: supabase db push
 *   - Remote: supabase db push --linked
 *
 * This script verifies connectivity to the DAI Supabase instance.
 */

import { createClient } from "@supabase/supabase-js";

const url = process.env.DAI_SUPABASE_URL;
const key = process.env.DAI_SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.error("Missing DAI_SUPABASE_URL or DAI_SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const supabase = createClient(url, key);

async function main(): Promise<void> {
  console.log("Checking Supabase connectivity...");

  const { error } = await supabase.from("sessions").select("id").limit(1);
  if (error) {
    console.error(`Supabase connectivity check failed: ${error.message}`);
    process.exit(1);
  }

  console.log("Supabase connected successfully.");
  console.log("\nMigrations are managed via Supabase. Run:");
  console.log("  supabase db push        # local");
  console.log("  supabase db push --linked  # remote");
}

main().catch((err) => {
  console.error("Migration check failed:", err);
  process.exit(1);
});
