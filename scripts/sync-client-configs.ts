/**
 * Sync BMAD client YAML configs to BMAD Supabase.
 *
 * Reads all ads-config.yaml files from the BMAD clients directory and upserts
 * them into the `client_configs` table in BMAD Supabase. This enables cloud
 * deployment where the BMAD repo isn't available on disk.
 *
 * Prerequisites:
 *   - client_configs table in BMAD Supabase:
 *     CREATE TABLE client_configs (
 *       client_code TEXT PRIMARY KEY,
 *       config JSONB NOT NULL,
 *       updated_at TIMESTAMPTZ DEFAULT NOW()
 *     );
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/sync-client-configs.ts [--dry-run]
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import yaml from "js-yaml";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BMAD_CLIENTS_DIR = resolve(
  process.env.BMAD_CLIENTS_DIR ?? "/Users/danielbulygin/dev/bmad/pma/clients",
);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DRY_RUN = process.argv.includes("--dry-run");

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Sync BMAD Client Configs to Supabase ===\n");

  if (DRY_RUN) {
    console.log("*** DRY RUN ***\n");
  }

  if (!existsSync(BMAD_CLIENTS_DIR)) {
    console.error(`BMAD clients directory not found: ${BMAD_CLIENTS_DIR}`);
    console.error("Set BMAD_CLIENTS_DIR env var to the correct path.");
    process.exit(1);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY (BMAD Supabase).");
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Discover all client directories with ads-config.yaml
  const dirs = readdirSync(BMAD_CLIENTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  console.log(`Found ${dirs.length} client directories in ${BMAD_CLIENTS_DIR}\n`);

  let synced = 0;
  let skipped = 0;

  for (const dir of dirs) {
    const configPath = join(BMAD_CLIENTS_DIR, dir, "ads-config.yaml");

    if (!existsSync(configPath)) {
      console.log(`  ${dir}: no ads-config.yaml, skipping`);
      skipped++;
      continue;
    }

    try {
      const raw = readFileSync(configPath, "utf-8");
      const config = yaml.load(raw) as Record<string, unknown>;
      const clientCode = (config.client_code as string) ?? dir;

      if (DRY_RUN) {
        console.log(`  ${clientCode}: would sync (${Object.keys(config).length} fields)`);
        synced++;
        continue;
      }

      const { error } = await supabase
        .from("client_configs")
        .upsert(
          {
            client_code: clientCode,
            config,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "client_code" },
        );

      if (error) {
        console.error(`  ${clientCode}: ERROR — ${error.message}`);
        continue;
      }

      console.log(`  ${clientCode}: synced`);
      synced++;
    } catch (err) {
      console.error(`  ${dir}: FAILED — ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\n=== Done: ${synced} synced, ${skipped} skipped ===`);
}

main().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
