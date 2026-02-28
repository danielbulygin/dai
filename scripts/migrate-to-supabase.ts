/**
 * One-time migration script: SQLite → Supabase
 *
 * Reads all data from the local SQLite database (data/dai.db) and batch-inserts
 * it into the DAI Supabase instance.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/migrate-to-supabase.ts [--dry-run] [--table TABLE]
 *
 * Flags:
 *   --dry-run     Preview row counts without inserting
 *   --table NAME  Migrate only the specified table
 */

import Database from "better-sqlite3";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DB_PATH = resolve(process.env.DB_PATH ?? "data/dai.db");
const DAI_SUPABASE_URL = process.env.DAI_SUPABASE_URL;
const DAI_SUPABASE_SERVICE_KEY = process.env.DAI_SUPABASE_SERVICE_KEY;
const DRY_RUN = process.argv.includes("--dry-run");
const TABLE_FILTER = getArgValue("--table");

const BATCH_SIZE = 500;

// Migration order respects FK constraints
const MIGRATION_ORDER = [
  "sessions",
  "observations",
  "summaries",
  "learnings",
  "messages",
  "feedback",
  "decisions",
  "transcript_ingestion_log",
  "channel_monitor",
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getArgValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

async function migrateTable(
  db: Database.Database,
  supabase: SupabaseClient,
  table: string,
): Promise<{ source: number; inserted: number }> {
  // Read all rows from SQLite
  const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  const sourceCount = rows.length;

  console.log(`  ${table}: ${sourceCount} rows in SQLite`);

  if (DRY_RUN || sourceCount === 0) {
    return { source: sourceCount, inserted: 0 };
  }

  // Fix learnings: SQLite allowed text in the REAL confidence column
  if (table === "learnings") {
    for (const row of rows) {
      if (typeof row.confidence === "string") {
        const map: Record<string, number> = { high: 0.9, medium: 0.6, low: 0.3 };
        row.confidence = map[row.confidence as string] ?? 0.5;
      }
    }
  }

  // For channel_monitor, we need to handle the BIGSERIAL id column:
  // insert with explicit ids, then reset the sequence
  let inserted = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    const { error } = await supabase
      .from(table)
      .upsert(batch, { onConflict: table === "channel_monitor" ? "message_ts" : "id", ignoreDuplicates: true });

    if (error) {
      console.error(`  ERROR inserting into ${table} (batch ${Math.floor(i / BATCH_SIZE) + 1}): ${error.message}`);
      continue;
    }

    inserted += batch.length;
  }

  // For channel_monitor: reset the sequence to max(id) + 1
  if (table === "channel_monitor" && inserted > 0) {
    const maxId = Math.max(...rows.map((r) => r.id as number));
    const { error } = await supabase.rpc("pg_catalog.setval", {
      // This won't work via Supabase SDK — use raw SQL instead
    }).catch(() => null) as { error: null };
    // Note: sequence reset needs to be done via SQL editor:
    // SELECT setval('channel_monitor_id_seq', (SELECT MAX(id) FROM channel_monitor));
    if (error) {
      console.log(`  Note: Run this in Supabase SQL Editor to reset sequence:`);
      console.log(`    SELECT setval('channel_monitor_id_seq', ${maxId});`);
    } else {
      console.log(`  Note: Run this in Supabase SQL Editor to reset sequence:`);
      console.log(`    SELECT setval('channel_monitor_id_seq', ${maxId});`);
    }
  }

  return { source: sourceCount, inserted };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== SQLite → Supabase Migration ===\n");

  if (DRY_RUN) {
    console.log("*** DRY RUN — no data will be inserted ***\n");
  }

  // Validate prerequisites
  if (!existsSync(DB_PATH)) {
    console.error(`SQLite database not found at: ${DB_PATH}`);
    console.error("Set DB_PATH env var to the correct path.");
    process.exit(1);
  }

  if (!DAI_SUPABASE_URL || !DAI_SUPABASE_SERVICE_KEY) {
    console.error("Missing DAI_SUPABASE_URL or DAI_SUPABASE_SERVICE_KEY env vars.");
    process.exit(1);
  }

  // Open SQLite
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma("journal_mode = WAL");

  // Open Supabase
  const supabase = createClient(DAI_SUPABASE_URL, DAI_SUPABASE_SERVICE_KEY);

  // Verify Supabase connectivity
  const { error: pingError } = await supabase.from("sessions").select("id").limit(1);
  if (pingError) {
    console.error(`Supabase connectivity check failed: ${pingError.message}`);
    console.error("Make sure the migration SQL has been applied first.");
    process.exit(1);
  }

  console.log(`Source: ${DB_PATH}`);
  console.log(`Target: ${DAI_SUPABASE_URL}\n`);

  // Determine which tables to migrate
  const tables = TABLE_FILTER
    ? MIGRATION_ORDER.filter((t) => t === TABLE_FILTER)
    : [...MIGRATION_ORDER];

  if (TABLE_FILTER && tables.length === 0) {
    console.error(`Unknown table: ${TABLE_FILTER}`);
    console.error(`Available tables: ${MIGRATION_ORDER.join(", ")}`);
    process.exit(1);
  }

  // Migrate each table
  const results: Array<{ table: string; source: number; inserted: number }> = [];

  for (const table of tables) {
    try {
      const result = await migrateTable(db, supabase, table);
      results.push({ table, ...result });
    } catch (err) {
      console.error(`  FAILED to migrate ${table}: ${err instanceof Error ? err.message : err}`);
      results.push({ table, source: -1, inserted: 0 });
    }
  }

  // Summary
  console.log("\n=== Migration Summary ===\n");
  console.log("Table                      | Source | Inserted | Match?");
  console.log("---------------------------|--------|----------|-------");

  for (const r of results) {
    const match = r.source === r.inserted ? "YES" : (DRY_RUN ? "N/A" : "NO");
    console.log(
      `${r.table.padEnd(27)}| ${String(r.source).padStart(6)} | ${String(r.inserted).padStart(8)} | ${match}`,
    );
  }

  if (!DRY_RUN) {
    // Validate row counts
    console.log("\n=== Validation ===\n");
    let allMatch = true;

    for (const table of tables) {
      const sqliteCount = (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
      const { count: supabaseCount } = await supabase
        .from(table)
        .select("*", { count: "exact", head: true });

      const match = sqliteCount === (supabaseCount ?? 0);
      if (!match) allMatch = false;

      console.log(
        `${table}: SQLite=${sqliteCount}, Supabase=${supabaseCount ?? 0} ${match ? "OK" : "MISMATCH!"}`,
      );
    }

    if (allMatch) {
      console.log("\nAll row counts match. Migration successful!");
    } else {
      console.log("\nSome row counts don't match. Check the errors above.");
      console.log("Re-run with --table TABLE to retry specific tables.");
    }
  }

  db.close();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
