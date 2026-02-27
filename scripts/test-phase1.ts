/**
 * Phase 1 Supabase Tools Test Script
 *
 * Tests all supabase-tools functions against the live BMAD Supabase instance.
 * Bypasses the full env validation (which requires Slack tokens etc.) by
 * setting stub values for non-Supabase env vars before importing.
 *
 * Usage: npx tsx --env-file=.env scripts/test-phase1.ts
 */

// Stub the required env vars so env.ts validation passes.
// The .env file is loaded via --env-file, but Slack/Anthropic keys
// may be real or placeholder — either way we just need them present.
for (const key of [
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_SIGNING_SECRET",
  "ANTHROPIC_API_KEY",
  "SLACK_OWNER_USER_ID",
]) {
  if (!process.env[key]) {
    process.env[key] = `stub-${key}`;
  }
}

// Set LOG_LEVEL to error to suppress pino noise during the test
process.env.LOG_LEVEL = "warn";

import {
  listClients,
  getClientPerformance,
  getCampaignPerformance,
  getAdsetPerformance,
  getAdPerformance,
  getBreakdowns,
  getAccountChanges,
  getCreativeDetails,
} from "../src/agents/tools/supabase-tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ColumnReport {
  column: string;
  hasData: boolean;
  sampleValue: unknown;
}

function analyzeRow(row: Record<string, unknown>): ColumnReport[] {
  return Object.entries(row).map(([column, value]) => ({
    column,
    hasData: value !== null && value !== undefined,
    sampleValue: value,
  }));
}

function printResult(
  toolName: string,
  raw: string,
  opts?: { label?: string },
) {
  const label = opts?.label ?? toolName;
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  ${label}`);
  console.log("=".repeat(70));

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.log("  [ERROR] Could not parse JSON response");
    console.log("  Raw:", raw.slice(0, 500));
    return { ok: false, rows: 0 };
  }

  // Error response
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    "error" in (parsed as Record<string, unknown>)
  ) {
    console.log(
      `  [ERROR] ${(parsed as Record<string, unknown>).error}`,
    );
    return { ok: false, rows: 0 };
  }

  const data = parsed as Record<string, unknown>[];
  console.log(`  Rows returned: ${data.length}`);

  if (data.length === 0) {
    console.log("  (no data)");
    return { ok: true, rows: 0 };
  }

  // Analyze first row
  const firstRow = data[0]!;
  const report = analyzeRow(firstRow);

  const populated = report.filter((r) => r.hasData);
  const empty = report.filter((r) => !r.hasData);

  console.log(
    `  Columns with data (${populated.length}/${report.length}):`,
  );
  for (const col of populated) {
    const val =
      typeof col.sampleValue === "string" && col.sampleValue.length > 60
        ? col.sampleValue.slice(0, 60) + "..."
        : col.sampleValue;
    console.log(`    + ${col.column}: ${JSON.stringify(val)}`);
  }

  if (empty.length > 0) {
    console.log(`  Columns with NULL/undefined (${empty.length}):"`);
    for (const col of empty) {
      console.log(`    - ${col.column}`);
    }
  }

  return { ok: true, rows: data.length };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("Phase 1 Supabase Tools Test");
  console.log("Time:", new Date().toISOString());
  console.log(
    "SUPABASE_URL:",
    process.env.SUPABASE_URL
      ? process.env.SUPABASE_URL.slice(0, 30) + "..."
      : "NOT SET",
  );
  console.log(
    "SUPABASE_SERVICE_KEY:",
    process.env.SUPABASE_SERVICE_KEY ? "SET (hidden)" : "NOT SET",
  );

  // -----------------------------------------------------------------------
  // 1. List clients
  // -----------------------------------------------------------------------
  const clientsRaw = await listClients();
  const clientsResult = printResult("listClients", clientsRaw);

  if (!clientsResult.ok || clientsResult.rows === 0) {
    console.log(
      "\n[ABORT] Cannot proceed without clients. Check Supabase connection.",
    );
    process.exit(1);
  }

  // Pick the first active client — or a specific one if provided via CLI arg
  const clients = JSON.parse(clientsRaw) as Array<{
    id: number;
    code: string;
    name: string;
  }>;

  const requestedCode = process.argv[2];
  const client = requestedCode
    ? clients.find((c) => c.code === requestedCode) ?? clients[0]!
    : clients[0]!;
  console.log(
    `\nUsing client: ${client.name} (code=${client.code}, id=${client.id})`,
  );
  console.log(
    `  (pass a client code as CLI arg to test a specific client, e.g.: npx tsx --env-file=.env scripts/test-phase1.ts NP)`,
  );

  // -----------------------------------------------------------------------
  // 2. getClientPerformance
  // -----------------------------------------------------------------------
  const DAYS = 30; // Use 30 days to ensure we find data
  const perfRaw = await getClientPerformance({
    clientCode: client.code,
    days: DAYS,
  });
  printResult("getClientPerformance", perfRaw, {
    label: `getClientPerformance (${client.code}, ${DAYS}d)`,
  });

  // -----------------------------------------------------------------------
  // 3. getCampaignPerformance
  // -----------------------------------------------------------------------
  const campRaw = await getCampaignPerformance({
    clientCode: client.code,
    days: DAYS,
  });
  const campResult = printResult("getCampaignPerformance", campRaw, {
    label: `getCampaignPerformance (${client.code}, ${DAYS}d)`,
  });

  // Grab a campaign_id for downstream tests
  let campaignId: string | undefined;
  if (campResult.ok && campResult.rows > 0) {
    const campaigns = JSON.parse(campRaw) as Array<{
      campaign_id: string;
    }>;
    campaignId = campaigns[0]?.campaign_id;
    if (campaignId) {
      console.log(`  -> Using campaign_id=${campaignId} for adset/ad tests`);
    }
  }

  // -----------------------------------------------------------------------
  // 4. getAdsetPerformance
  // -----------------------------------------------------------------------
  const adsetRaw = await getAdsetPerformance({
    clientCode: client.code,
    campaignId,
    days: DAYS,
  });
  printResult("getAdsetPerformance", adsetRaw, {
    label: `getAdsetPerformance (${client.code}, campaign=${campaignId ?? "all"}, ${DAYS}d)`,
  });

  // -----------------------------------------------------------------------
  // 5. getAdPerformance
  // -----------------------------------------------------------------------
  const adRaw = await getAdPerformance({
    clientCode: client.code,
    campaignId,
    days: DAYS,
  });
  printResult("getAdPerformance", adRaw, {
    label: `getAdPerformance (${client.code}, campaign=${campaignId ?? "all"}, ${DAYS}d)`,
  });

  // -----------------------------------------------------------------------
  // 6. getBreakdowns (device)
  // -----------------------------------------------------------------------
  const breakRaw = await getBreakdowns({
    clientCode: client.code,
    breakdownType: "device",
    days: DAYS,
  });
  printResult("getBreakdowns", breakRaw, {
    label: `getBreakdowns (${client.code}, device, ${DAYS}d)`,
  });

  // -----------------------------------------------------------------------
  // 7. getAccountChanges
  // -----------------------------------------------------------------------
  const changesRaw = await getAccountChanges({
    clientCode: client.code,
    days: 30, // wider window for changes
  });
  printResult("getAccountChanges", changesRaw, {
    label: `getAccountChanges (${client.code}, 30d)`,
  });

  // -----------------------------------------------------------------------
  // 8. getCreativeDetails
  // -----------------------------------------------------------------------
  const creativeRaw = await getCreativeDetails({
    clientCode: client.code,
  });
  printResult("getCreativeDetails", creativeRaw, {
    label: `getCreativeDetails (${client.code})`,
  });

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log(`\n${"=".repeat(70)}`);
  console.log("  SUMMARY");
  console.log("=".repeat(70));
  console.log("All tool calls completed. Review output above for:");
  console.log("  1. Which tools returned data vs errors");
  console.log("  2. New Phase 1 columns (frequency, content_views, add_to_carts,");
  console.log("     checkouts_initiated, hook_rate, hold_rate, etc.)");
  console.log("  3. New tables (adset_daily, ad_daily, breakdowns,");
  console.log("     account_changes, creatives)");
  console.log("=".repeat(70));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
