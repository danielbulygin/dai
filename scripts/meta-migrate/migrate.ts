/**
 * Meta Migration — Phase 3: Shallow /copies per entity
 *
 * Reads manifest.json (produced by audit.ts), then for each spending
 * campaign/adset/ad calls POST /<id>/copies with deep_copy=false and
 * the appropriate cross-account parent/parent-pointer, landing PAUSED
 * in the new account.
 *
 * Each /copies call moves exactly 1 entity, sidestepping the
 * 3-entity-per-sync-call limit. Names are preserved exactly.
 *
 * State (id-map.json + errors.log) is persisted incrementally so the
 * script is fully resumable.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/meta-migrate/migrate.ts -- --dry-run
 *   pnpm tsx --env-file=.env scripts/meta-migrate/migrate.ts -- --resume
 *   pnpm tsx --env-file=.env scripts/meta-migrate/migrate.ts -- --limit-campaigns 1
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const API = "https://graph.facebook.com/v21.0";
const TOKEN = process.env.META_ADS_ACCESS_TOKEN;
const NEW_ACCOUNT = "act_978593421213192";
const DIR = join(process.cwd(), "scripts/meta-migrate");
const MANIFEST = join(DIR, "manifest.json");
const ID_MAP = join(DIR, "id-map.json");
const ERR_LOG = join(DIR, "errors.log");

if (!TOKEN) {
  console.error("META_ADS_ACCESS_TOKEN missing");
  process.exit(1);
}

const DRY_RUN = process.argv.includes("--dry-run");
const RESUME = process.argv.includes("--resume");
const LIMIT_IDX = process.argv.indexOf("--limit-campaigns");
const LIMIT = LIMIT_IDX > -1 ? parseInt(process.argv[LIMIT_IDX + 1] ?? "0", 10) : 0;

type Json = Record<string, unknown>;

type IdMap = {
  campaigns: Record<string, string>;
  adsets: Record<string, string>;
  ads: Record<string, string>;
};

function loadIdMap(): IdMap {
  if (RESUME && existsSync(ID_MAP)) {
    return JSON.parse(readFileSync(ID_MAP, "utf8")) as IdMap;
  }
  return { campaigns: {}, adsets: {}, ads: {} };
}

function saveIdMap(map: IdMap): void {
  writeFileSync(ID_MAP, JSON.stringify(map, null, 2));
}

function logError(stage: string, oldId: string, err: unknown): void {
  const line = `[${new Date().toISOString()}] ${stage} ${oldId}: ${JSON.stringify(err)}\n`;
  appendFileSync(ERR_LOG, line);
}

async function fbPost(path: string, params: Record<string, string>): Promise<Json> {
  const url = `${API}/${path}`;
  const form = new URLSearchParams();
  form.set("access_token", TOKEN!);
  for (const [k, v] of Object.entries(params)) form.set(k, v);
  const r = await fetch(url, { method: "POST", body: form });
  const body = (await r.json()) as Json;
  if (!r.ok) return { _error: body.error ?? body };
  return body;
}

async function copy(
  stage: "campaign" | "adset" | "ad",
  oldId: string,
  parentParams: Record<string, string>,
): Promise<string | null> {
  const params: Record<string, string> = {
    deep_copy: "false",
    status_option: "PAUSED",
    parent_id: NEW_ACCOUNT,
    ...parentParams,
  };
  if (DRY_RUN) {
    console.log(`  DRY: POST /${oldId}/copies  params=${JSON.stringify(params)}`);
    return "DRY-RUN";
  }
  const resp = await fbPost(`${oldId}/copies`, params);
  if (resp._error) {
    logError(stage, oldId, resp._error);
    return null;
  }
  const newId = (resp.copied_campaign_id ?? resp.copied_adset_id ?? resp.copied_ad_id ?? resp.id) as string | undefined;
  if (!newId) {
    logError(stage, oldId, { message: "No new id in response", resp });
    return null;
  }
  return newId;
}

async function main(): Promise<void> {
  if (!existsSync(MANIFEST)) {
    console.error(`Missing ${MANIFEST}. Run audit.ts first.`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
    campaigns: Json[];
    adsets: Json[];
    ads: Json[];
  };

  const idMap = loadIdMap();

  console.log(`Migration mode: ${DRY_RUN ? "DRY-RUN" : "LIVE"} ${RESUME ? "(resume)" : ""}`);
  console.log(`Target account: ${NEW_ACCOUNT}`);
  console.log(
    `Will process: ${manifest.campaigns.length} campaigns, ${manifest.adsets.length} adsets, ${manifest.ads.length} ads`,
  );
  if (LIMIT > 0) console.log(`Limited to first ${LIMIT} campaign(s) for this run`);
  console.log();

  const campaignsToRun = LIMIT > 0 ? manifest.campaigns.slice(0, LIMIT) : manifest.campaigns;
  const wantedCampaignIds = new Set(campaignsToRun.map((c) => c.id as string));

  // 1. Campaigns
  let copied = 0;
  for (const c of campaignsToRun) {
    const oldId = c.id as string;
    if (idMap.campaigns[oldId]) {
      console.log(`[campaign] ${oldId} already copied → ${idMap.campaigns[oldId]}, skip`);
      continue;
    }
    console.log(`[campaign] ${oldId}  "${c.name}"`);
    const newId = await copy("campaign", oldId, {});
    if (newId && newId !== "DRY-RUN") {
      idMap.campaigns[oldId] = newId;
      saveIdMap(idMap);
      copied++;
    }
  }
  console.log(`Campaigns done. New copies: ${copied}\n`);

  // 2. Adsets — only spending ones whose parent campaign is in scope
  copied = 0;
  for (const a of manifest.adsets) {
    const oldCampaignId = a.campaign_id as string;
    if (!wantedCampaignIds.has(oldCampaignId)) continue;
    const newCampaignId = idMap.campaigns[oldCampaignId];
    if (!newCampaignId && !DRY_RUN) {
      logError("adset", a.id as string, { message: `No new campaign id for ${oldCampaignId}` });
      continue;
    }
    const oldId = a.id as string;
    if (idMap.adsets[oldId]) {
      continue;
    }
    console.log(`[adset]    ${oldId}  "${a.name}"  → campaign ${newCampaignId ?? "<new-campaign>"}`);
    const newId = await copy("adset", oldId, {
      campaign_id: DRY_RUN ? "<new-campaign>" : newCampaignId!,
    });
    if (newId && newId !== "DRY-RUN") {
      idMap.adsets[oldId] = newId;
      saveIdMap(idMap);
      copied++;
    }
  }
  console.log(`Adsets done. New copies: ${copied}\n`);

  // 3. Ads — only spending ones whose parent adset is in scope
  copied = 0;
  const wantedAdsetIds = new Set(
    manifest.adsets
      .filter((a) => wantedCampaignIds.has(a.campaign_id as string))
      .map((a) => a.id as string),
  );
  for (const ad of manifest.ads) {
    const oldAdsetId = ad.adset_id as string;
    if (!wantedAdsetIds.has(oldAdsetId)) continue;
    const newAdsetId = idMap.adsets[oldAdsetId];
    if (!newAdsetId && !DRY_RUN) {
      // Parent adset not migrated (perhaps it failed or out of scope)
      continue;
    }
    const oldId = ad.id as string;
    if (idMap.ads[oldId]) continue;
    console.log(`[ad]       ${oldId}  "${ad.name}"  → adset ${newAdsetId ?? "<new-adset>"}`);
    const newId = await copy("ad", oldId, {
      adset_id: DRY_RUN ? "<new-adset>" : newAdsetId!,
    });
    if (newId && newId !== "DRY-RUN") {
      idMap.ads[oldId] = newId;
      saveIdMap(idMap);
      copied++;
    }
  }
  console.log(`Ads done. New copies: ${copied}\n`);

  // Summary
  console.log("=== FINAL ===");
  console.log(`campaigns: ${Object.keys(idMap.campaigns).length} mapped`);
  console.log(`adsets:    ${Object.keys(idMap.adsets).length} mapped`);
  console.log(`ads:       ${Object.keys(idMap.ads).length} mapped`);
  if (!DRY_RUN) {
    console.log(`\nid-map → ${ID_MAP}`);
    if (existsSync(ERR_LOG)) console.log(`errors  → ${ERR_LOG}`);
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
