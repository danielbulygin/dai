/**
 * Backfill hook_rate in BMAD Supabase ad_daily table.
 *
 * Formula: hook_rate = video_p25 / impressions  (when both > 0)
 *
 * Run:  npx tsx --env-file=.env scripts/backfill-hook-rate.ts
 */

import { createClient } from "@supabase/supabase-js";

const BATCH_SIZE = 500;

function getEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(`Missing env var: ${key}`);
  }
  return val;
}

async function main() {
  const supabaseUrl = getEnv("SUPABASE_URL");
  const supabaseKey = getEnv("SUPABASE_SERVICE_KEY");
  const supabase = createClient(supabaseUrl, supabaseKey);

  console.log("Connected to Supabase:", supabaseUrl);

  // ── Step 0: Explore hold_rate feasibility ──────────────────────────
  console.log("\n--- Hold Rate Feasibility Check ---");

  // Check how many ad_daily rows have video_avg_time
  const { count: videoAvgTimeCount } = await supabase
    .from("ad_daily")
    .select("*", { count: "exact", head: true })
    .not("video_avg_time", "is", null)
    .gt("video_avg_time", 0);

  console.log(`ad_daily rows with video_avg_time > 0: ${videoAvgTimeCount ?? 0}`);

  // Check how many creatives have video_duration_seconds
  const { count: videoDurationCount } = await supabase
    .from("creatives")
    .select("*", { count: "exact", head: true })
    .not("video_duration_seconds", "is", null)
    .gt("video_duration_seconds", 0);

  console.log(`creatives rows with video_duration_seconds > 0: ${videoDurationCount ?? 0}`);

  // Check how many ad_daily rows could be joined with creatives for hold_rate
  // ad_daily has creative_id, creatives has creative_id
  if ((videoAvgTimeCount ?? 0) > 0 && (videoDurationCount ?? 0) > 0) {
    // Sample a few to see if the join would work
    const { data: sampleJoin } = await supabase
      .from("ad_daily")
      .select("ad_id, creative_id, video_avg_time")
      .not("video_avg_time", "is", null)
      .gt("video_avg_time", 0)
      .limit(5);

    if (sampleJoin && sampleJoin.length > 0) {
      console.log("Sample ad_daily rows with video_avg_time:", sampleJoin);

      // Try to find matching creatives
      const creativeIds = sampleJoin
        .map((r) => r.creative_id)
        .filter(Boolean);
      if (creativeIds.length > 0) {
        const { data: matchingCreatives } = await supabase
          .from("creatives")
          .select("creative_id, video_duration_seconds")
          .in("creative_id", creativeIds);

        console.log("Matching creatives with duration:", matchingCreatives);
      }
    }
    console.log(
      "Hold rate computation may be feasible — but requires a join. Skipping for now, focus on hook_rate."
    );
  } else {
    console.log(
      "Not enough data for hold_rate computation. Skipping."
    );
  }

  // ── Step 1: Count eligible rows ────────────────────────────────────
  console.log("\n--- Hook Rate Backfill ---");

  const { count: eligibleCount, error: countErr } = await supabase
    .from("ad_daily")
    .select("*", { count: "exact", head: true })
    .is("hook_rate", null)
    .not("video_p25", "is", null)
    .gt("video_p25", 0)
    .gt("impressions", 0);

  if (countErr) {
    console.error("Error counting eligible rows:", countErr);
    process.exit(1);
  }

  console.log(`Eligible rows (hook_rate IS NULL, video_p25 > 0, impressions > 0): ${eligibleCount}`);

  if (!eligibleCount || eligibleCount === 0) {
    console.log("Nothing to backfill. Done.");
    return;
  }

  // Also check: how many rows already have hook_rate?
  const { count: alreadyFilledCount } = await supabase
    .from("ad_daily")
    .select("*", { count: "exact", head: true })
    .not("hook_rate", "is", null);

  console.log(`Rows already with hook_rate: ${alreadyFilledCount ?? 0}`);

  // ── Step 2: Fetch and update in batches ────────────────────────────
  let totalUpdated = 0;
  let offset = 0;
  const sampleValues: { ad_id: string; date: string; hook_rate: number; video_p25: number; impressions: number }[] = [];

  while (true) {
    const { data: rows, error: fetchErr } = await supabase
      .from("ad_daily")
      .select("id, ad_id, date, video_p25, impressions")
      .is("hook_rate", null)
      .not("video_p25", "is", null)
      .gt("video_p25", 0)
      .gt("impressions", 0)
      .order("date", { ascending: true })
      .range(offset, offset + BATCH_SIZE - 1);

    if (fetchErr) {
      console.error(`Error fetching batch at offset ${offset}:`, fetchErr);
      break;
    }

    if (!rows || rows.length === 0) {
      break;
    }

    console.log(`Processing batch: ${rows.length} rows (offset ${offset})...`);

    // Compute hook_rate for each row and update individually
    // (Supabase JS client doesn't support bulk update by different values, so we batch via Promise.all)
    const updates = rows.map((row) => {
      const hookRate = Math.round((row.video_p25 / row.impressions) * 10000) / 10000; // 4 decimal places
      return { id: row.id, hookRate, ad_id: row.ad_id, date: row.date, video_p25: row.video_p25, impressions: row.impressions };
    });

    // Collect samples from first batch
    if (sampleValues.length < 10) {
      for (const u of updates.slice(0, 10 - sampleValues.length)) {
        sampleValues.push({
          ad_id: u.ad_id,
          date: u.date,
          hook_rate: u.hookRate,
          video_p25: u.video_p25,
          impressions: u.impressions,
        });
      }
    }

    // Execute updates in parallel chunks of 50 to avoid overwhelming the API
    const PARALLEL_CHUNK = 50;
    for (let i = 0; i < updates.length; i += PARALLEL_CHUNK) {
      const chunk = updates.slice(i, i + PARALLEL_CHUNK);
      const results = await Promise.all(
        chunk.map((u) =>
          supabase
            .from("ad_daily")
            .update({ hook_rate: u.hookRate })
            .eq("id", u.id)
        )
      );

      const errors = results.filter((r) => r.error);
      if (errors.length > 0) {
        console.error(`  ${errors.length} errors in chunk:`, errors[0].error);
      }
    }

    totalUpdated += rows.length;
    console.log(`  Updated ${rows.length} rows (total so far: ${totalUpdated})`);

    // If we got fewer rows than the batch size, we're done
    // NOTE: We re-query from scratch each time since updated rows no longer match the filter
    // So we always start at offset 0
    if (rows.length < BATCH_SIZE) {
      break;
    }
  }

  // ── Step 3: Report ─────────────────────────────────────────────────
  console.log("\n--- Backfill Complete ---");
  console.log(`Total rows updated: ${totalUpdated}`);

  if (sampleValues.length > 0) {
    console.log("\nSample hook_rate values:");
    console.table(sampleValues);
  }

  // Verify with a final count
  const { count: remainingNull } = await supabase
    .from("ad_daily")
    .select("*", { count: "exact", head: true })
    .is("hook_rate", null)
    .not("video_p25", "is", null)
    .gt("video_p25", 0)
    .gt("impressions", 0);

  const { count: totalWithHookRate } = await supabase
    .from("ad_daily")
    .select("*", { count: "exact", head: true })
    .not("hook_rate", "is", null);

  console.log(`\nRemaining rows with NULL hook_rate (eligible): ${remainingNull ?? 0}`);
  console.log(`Total rows with hook_rate populated: ${totalWithHookRate ?? 0}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
