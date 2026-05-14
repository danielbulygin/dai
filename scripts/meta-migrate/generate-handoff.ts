/**
 * Generate handoff artifacts after the migration run.
 *
 * Outputs:
 *   - needs-manual.csv : every source ad that did NOT migrate, with the
 *     destination adset/campaign IDs in the new account so a human can
 *     rebuild each ad in-place.
 *   - summary.md : counts, key IDs, error categories.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/meta-migrate/generate-handoff.ts
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "scripts/meta-migrate");
const MANIFEST = join(DIR, "manifest.json");
const ID_MAP = join(DIR, "id-map.json");
const ERR_LOG = join(DIR, "errors.log");
const OUT_CSV = join(DIR, "needs-manual.csv");
const OUT_MD = join(DIR, "summary.md");

type Json = Record<string, unknown>;

function csvEscape(v: string): string {
  if (v.includes(",") || v.includes("\"") || v.includes("\n")) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

async function main(): Promise<void> {
  if (!existsSync(MANIFEST) || !existsSync(ID_MAP)) {
    console.error("Missing manifest.json or id-map.json");
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
    campaigns: Json[]; adsets: Json[]; ads: Json[];
  };
  const idMap = JSON.parse(readFileSync(ID_MAP, "utf8")) as {
    campaigns: Record<string, string>;
    adsets: Record<string, string>;
    creatives: Record<string, string>;
    ads: Record<string, string>;
  };

  const campaignsById = new Map<string, Json>();
  for (const c of manifest.campaigns) campaignsById.set(c.id as string, c);
  const adsetsById = new Map<string, Json>();
  for (const a of manifest.adsets) adsetsById.set(a.id as string, a);

  // Parse errors.log to classify failure reasons per ad
  const errorByAd = new Map<string, string>();
  if (existsSync(ERR_LOG)) {
    const lines = readFileSync(ERR_LOG, "utf8").split("\n");
    for (const ln of lines) {
      const m = ln.match(/(?:ad|creative) (\d+): (.+)$/);
      if (m) {
        const id = m[1]!;
        let reason = m[2]!;
        try {
          const j = JSON.parse(reason) as { error_user_title?: string; message?: string };
          reason = j.error_user_title ?? j.message ?? reason;
        } catch { /* keep raw */ }
        errorByAd.set(id, reason);
      }
    }
  }

  // Build the CSV: one row per source ad that was NOT migrated
  const rows: string[] = [];
  rows.push([
    "source_ad_id", "ad_name", "ad_status",
    "source_adset_id", "source_adset_name",
    "source_campaign_id", "source_campaign_name",
    "new_adset_id", "new_campaign_id",
    "creative_id", "page_post_url",
    "failure_reason",
  ].join(","));

  let missingCount = 0;
  for (const ad of manifest.ads) {
    const adId = ad.id as string;
    if (idMap.ads[adId]) continue;
    missingCount++;
    const adsetId = ad.adset_id as string;
    const campaignId = ad.campaign_id as string;
    const adset = adsetsById.get(adsetId);
    const campaign = campaignsById.get(campaignId);
    const cr = ad.creative as Json | undefined;
    const post = cr?.effective_object_story_id as string | undefined;
    const postUrl = post ? `https://www.facebook.com/${post.replace("_", "/posts/")}` : "";
    const reason = errorByAd.get(adId) ?? "not attempted";
    rows.push([
      adId,
      String(ad.name ?? ""),
      String(ad.status ?? ""),
      adsetId,
      String(adset?.name ?? ""),
      campaignId,
      String(campaign?.name ?? ""),
      idMap.adsets[adsetId] ?? "",
      idMap.campaigns[campaignId] ?? "",
      String(cr?.id ?? ""),
      postUrl,
      reason,
    ].map(csvEscape).join(","));
  }

  writeFileSync(OUT_CSV, rows.join("\n") + "\n");

  // Summary markdown
  const totalCampaigns = manifest.campaigns.length;
  const totalAdsets = manifest.adsets.length;
  const totalAds = manifest.ads.length;
  const mappedCampaigns = Object.keys(idMap.campaigns).length;
  const mappedAdsets = Object.keys(idMap.adsets).length;
  const mappedAds = Object.keys(idMap.ads).length;

  const reasonCounts = new Map<string, number>();
  for (const r of errorByAd.values()) {
    reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
  }

  const md = [
    `# Meta migration summary`,
    ``,
    `**Source:** act_1814118775391116 (PRESS London)`,
    `**Target:** act_978593421213192 (Naturally Better Nutrition)`,
    `**Filter:** entities with spend in last 90 days`,
    ``,
    `## Counts`,
    `| Level | Source | Migrated | %  |`,
    `|---|---:|---:|---:|`,
    `| Campaigns | ${totalCampaigns} | ${mappedCampaigns} | ${Math.round(100 * mappedCampaigns / totalCampaigns)}% |`,
    `| Adsets    | ${totalAdsets} | ${mappedAdsets} | ${Math.round(100 * mappedAdsets / totalAdsets)}% |`,
    `| Ads       | ${totalAds} | ${mappedAds} | ${Math.round(100 * mappedAds / totalAds)}% |`,
    ``,
    `## Failure breakdown`,
    ...(reasonCounts.size > 0
      ? [...reasonCounts.entries()].map(([r, n]) => `- **${n}×** ${r}`)
      : [`(no failures recorded)`]),
    ``,
    `## Artifacts`,
    `- \`manifest.json\` — full snapshot of source entities at audit time`,
    `- \`id-map.json\` — source_id → new_id mappings for everything migrated`,
    `- \`errors.log\` — raw error stream from the migration run`,
    `- \`needs-manual.csv\` — ${missingCount} source ad(s) that need manual rebuild, with destination IDs`,
    ``,
    `## Next steps`,
    `1. Inspect ${mappedCampaigns} campaign(s) in Ads Manager (Naturally Better Nutrition) — all paused`,
    `2. For each row in \`needs-manual.csv\`, open the source ad's page post (link in CSV) and rebuild in the destination adset`,
    `3. Once satisfied, activate the migrated structure`,
  ].join("\n");

  writeFileSync(OUT_MD, md);

  console.log(`✓ needs-manual.csv  (${missingCount} ads)`);
  console.log(`✓ summary.md`);
  console.log();
  console.log(md);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
