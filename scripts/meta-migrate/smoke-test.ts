/**
 * Meta Migration — Phase 0: Cross-account /copies smoke test
 *
 * Picks the smallest-spend campaign on the old account, tries to copy it
 * to the new account using POST /<campaign_id>/copies with parent_id and
 * deep_copy=true. Lands PAUSED. Tells us whether the /copies endpoint
 * supports cross-account in 2026 — Meta's docs are ambiguous.
 *
 * Outputs: the API response, plus IDs of anything created in the new
 * account so we can roll back if needed.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/meta-migrate/smoke-test.ts
 *   pnpm tsx --env-file=.env scripts/meta-migrate/smoke-test.ts -- --rollback
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const API = "https://graph.facebook.com/v21.0";
const TOKEN = process.env.META_ADS_ACCESS_TOKEN;
const OLD_ACCOUNT = "act_1814118775391116";
const NEW_ACCOUNT = "act_978593421213192";
const STATE = join(process.cwd(), "scripts/meta-migrate/smoke-test-result.json");

if (!TOKEN) {
  console.error("META_ADS_ACCESS_TOKEN missing");
  process.exit(1);
}

type Json = Record<string, unknown>;

async function fbGet(path: string, params: Record<string, string> = {}): Promise<Json> {
  const url = new URL(`${API}/${path}`);
  url.searchParams.set("access_token", TOKEN!);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString());
  const body = (await r.json()) as Json;
  if (!r.ok) throw new Error(`FB GET ${path}: ${JSON.stringify(body.error ?? body)}`);
  return body;
}

async function fbPost(path: string, params: Record<string, string>): Promise<Json> {
  const url = new URL(`${API}/${path}`);
  const form = new URLSearchParams();
  form.set("access_token", TOKEN!);
  for (const [k, v] of Object.entries(params)) form.set(k, v);
  const r = await fetch(url.toString(), { method: "POST", body: form });
  const body = (await r.json()) as Json;
  if (!r.ok) {
    return { _error: body.error ?? body, _status: r.status };
  }
  return body;
}

async function pickLowestSpendCampaign(): Promise<{ id: string; name: string; spend: number }> {
  const rows = await fbGet(`${OLD_ACCOUNT}/insights`, {
    level: "campaign",
    date_preset: "last_90d",
    fields: "campaign_id,campaign_name,spend",
    filtering: JSON.stringify([{ field: "spend", operator: "GREATER_THAN", value: 0 }]),
    limit: "200",
  });
  const data = (rows.data as Json[]) ?? [];
  const sorted = data
    .map((r) => ({
      id: r.campaign_id as string,
      name: r.campaign_name as string,
      spend: parseFloat(r.spend as string),
    }))
    .sort((a, b) => a.spend - b.spend);
  if (!sorted.length) throw new Error("No spending campaigns found on old account");
  return sorted[0]!;
}

async function rollback(): Promise<void> {
  if (!existsSync(STATE)) {
    console.log("No prior smoke test result to roll back.");
    return;
  }
  const prior = JSON.parse(readFileSync(STATE, "utf8")) as Json;
  const copied = prior.copied_campaign_id as string | undefined;
  if (!copied) {
    console.log("Prior result has no copied_campaign_id — nothing to delete.");
    return;
  }
  console.log(`Deleting copied campaign ${copied} (cascade will remove adsets/ads)…`);
  const r = await fbPost(copied, { _method: "DELETE" });
  console.log("Delete result:", JSON.stringify(r, null, 2));
}

async function main(): Promise<void> {
  if (process.argv.includes("--rollback")) {
    await rollback();
    return;
  }

  const target = await pickLowestSpendCampaign();
  console.log(`Smoke-testing copy of:`);
  console.log(`  campaign_id = ${target.id}`);
  console.log(`  name        = ${target.name}`);
  console.log(`  90d spend   = £${target.spend.toFixed(2)}`);
  console.log(`  source      = ${OLD_ACCOUNT}`);
  console.log(`  target      = ${NEW_ACCOUNT}`);
  console.log(`  mode        = deep_copy=true, status_option=PAUSED, parent_id=${NEW_ACCOUNT}\n`);

  const resp = await fbPost(`${target.id}/copies`, {
    deep_copy: "true",
    status_option: "PAUSED",
    parent_id: NEW_ACCOUNT,
    rename_options: JSON.stringify({
      rename_strategy: "ONLY_TOP_LEVEL_RENAME",
      rename_suffix: " [migrated]",
    }),
  });

  const result = {
    timestamp: new Date().toISOString(),
    source_campaign: target,
    response: resp,
    copied_campaign_id: (resp.copied_campaign_id ?? resp.id) as string | undefined,
    ad_object_ids: resp.ad_object_ids as unknown,
    success: !resp._error,
  };

  writeFileSync(STATE, JSON.stringify(result, null, 2));
  console.log("Response:");
  console.log(JSON.stringify(resp, null, 2));
  console.log(`\n→ Saved result to ${STATE}`);

  if (resp._error) {
    console.log("\n❌ Cross-account /copies FAILED. Will need structural recreation path.");
    return;
  }

  console.log("\n✅ /copies returned success. Verifying landing in new account…");
  const copied = (resp.copied_campaign_id ?? resp.id) as string | undefined;
  if (!copied) {
    console.log("⚠️  No copied campaign id in response — odd. Inspect manually.");
    return;
  }

  const newCampaign = await fbGet(copied, {
    fields: "id,name,account_id,status,objective,adsets.limit(50){id,name,status,ads.limit(50){id,name,status}}",
  });
  console.log(JSON.stringify(newCampaign, null, 2));
  const accountId = newCampaign.account_id as string;
  if (accountId === NEW_ACCOUNT.replace("act_", "")) {
    console.log(`\n✅ Confirmed: landed in ${NEW_ACCOUNT}. Cross-account /copies is supported.`);
  } else {
    console.log(`\n⚠️  Landed in account_id=${accountId} (expected ${NEW_ACCOUNT}). parent_id may have been ignored.`);
  }
  console.log(`\nRollback command:  pnpm tsx --env-file=.env scripts/meta-migrate/smoke-test.ts -- --rollback`);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
