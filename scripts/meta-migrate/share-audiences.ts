/**
 * Share each custom audience referenced in manifest.json with the new ad
 * account. Uses POST /<audience_id>/adaccounts (Meta's audience-sharing API).
 *
 * Read-only audit step first: lists which audiences are currently shared with
 * the new account and which are not. Then prompts (via flag) to share.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/meta-migrate/share-audiences.ts             # dry-run / list
 *   pnpm tsx --env-file=.env scripts/meta-migrate/share-audiences.ts -- --apply  # actually share
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const API = "https://graph.facebook.com/v21.0";
const TOKEN = process.env.META_ADS_ACCESS_TOKEN!;
const NEW_ACCOUNT = "act_978593421213192";
const NEW_ACCOUNT_NUMERIC = NEW_ACCOUNT.replace("act_", "");
const DIR = join(process.cwd(), "scripts/meta-migrate");
const MANIFEST = join(DIR, "manifest.json");
const APPLY = process.argv.includes("--apply");

type Json = Record<string, unknown>;

async function fb(method: "GET" | "POST", path: string, body?: Record<string, string>): Promise<Json> {
  const url = `${API}/${path}`;
  if (method === "GET") {
    const u = new URL(url);
    u.searchParams.set("access_token", TOKEN);
    if (body) for (const [k, v] of Object.entries(body)) u.searchParams.set(k, v);
    const r = await fetch(u.toString());
    return (await r.json()) as Json;
  }
  const form = new URLSearchParams();
  form.set("access_token", TOKEN);
  if (body) for (const [k, v] of Object.entries(body)) form.set(k, v);
  const r = await fetch(url, { method: "POST", body: form });
  return (await r.json()) as Json;
}

async function main(): Promise<void> {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
    assets: { audiences: Record<string, number> };
  };
  const audienceIds = Object.keys(manifest.assets.audiences);
  console.log(`Checking ${audienceIds.length} audiences against ${NEW_ACCOUNT}\n`);

  type Row = { id: string; name: string; sharedWithNew: boolean };
  const rows: Row[] = [];

  for (const id of audienceIds) {
    const meta = await fb("GET", id, { fields: "id,name,account_id,sharing_status" });
    if (meta.error) {
      console.log(`  ${id}  ❌ read failed: ${JSON.stringify(meta.error)}`);
      continue;
    }
    const ownerAccount = meta.account_id as string;
    // Read adaccounts list — accounts this audience is shared with
    const shareList = await fb("GET", `${id}/adaccounts`, { fields: "account_id" });
    const accounts = ((shareList.data as Json[]) ?? []).map((a) => a.account_id as string);
    const sharedWithNew = ownerAccount === NEW_ACCOUNT_NUMERIC || accounts.includes(NEW_ACCOUNT_NUMERIC);
    rows.push({ id, name: String(meta.name ?? ""), sharedWithNew });
    console.log(`  ${id}  ${sharedWithNew ? "✓" : "○"}  "${meta.name}"  (owner=${ownerAccount}, shared=${accounts.join(",") || "-"})`);
  }

  const toShare = rows.filter((r) => !r.sharedWithNew);
  console.log(`\n${rows.length - toShare.length}/${rows.length} already shared with new account`);
  console.log(`${toShare.length} need sharing`);

  if (!APPLY) {
    console.log(`\nRerun with --apply to share the ${toShare.length} unshared audience(s).`);
    return;
  }

  console.log(`\nSharing ${toShare.length} audience(s)…`);
  const results: Json[] = [];
  for (const r of toShare) {
    const resp = await fb("POST", `${r.id}/adaccounts`, {
      adaccounts: JSON.stringify([NEW_ACCOUNT_NUMERIC]),
    });
    const ok = !resp.error;
    console.log(`  ${r.id}  ${ok ? "✓ shared" : "❌"}  "${r.name}"${ok ? "" : "  " + JSON.stringify(resp.error)}`);
    results.push({ id: r.id, name: r.name, ok, resp });
  }
  writeFileSync(join(DIR, "share-audiences-result.json"), JSON.stringify(results, null, 2));
  console.log(`\nResults → scripts/meta-migrate/share-audiences-result.json`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
