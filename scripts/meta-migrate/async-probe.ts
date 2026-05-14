/**
 * Probe: does POST /act_NEW/async_batch_requests support cross-account /copies?
 *
 * Submits a tiny async batch (one campaign /copies op) targeting the new
 * ad account. Polls for completion. Then checks where the new entities landed.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/meta-migrate/async-probe.ts
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const API = "https://graph.facebook.com/v21.0";
const TOKEN = process.env.META_ADS_ACCESS_TOKEN!;
const OLD_ACCOUNT = "act_1814118775391116";
const NEW_ACCOUNT = "act_978593421213192";
const SOURCE_CAMPAIGN_A = "120244512990470066"; // £88 spend, smallest
const SOURCE_CAMPAIGN_B = "120241405725110066"; // £2,264 spend, also small

type Json = Record<string, unknown>;

async function fb(method: "GET" | "POST" | "DELETE", path: string, body?: Record<string, string>): Promise<Json> {
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
  const r = await fetch(url, { method, body: form });
  return (await r.json()) as Json;
}

async function main(): Promise<void> {
  console.log(`Probe: cross-account /copies via async_batch_requests`);
  console.log(`Sources: ${SOURCE_CAMPAIGN_A}, ${SOURCE_CAMPAIGN_B} (from ${OLD_ACCOUNT})`);
  console.log(`Target account: ${NEW_ACCOUNT}\n`);

  // Submit async batch — need ≥2 ops. Copy 2 different campaigns to probe.
  const adbatch = [
    {
      relative_url: `${SOURCE_CAMPAIGN_A}/copies`,
      name: "copy_campaign_a",
      body: `deep_copy=false&status_option=PAUSED`,
    },
    {
      relative_url: `${SOURCE_CAMPAIGN_B}/copies`,
      name: "copy_campaign_b",
      body: `deep_copy=false&status_option=PAUSED`,
    },
  ];

  console.log("Submitting batch…");
  const submit = await fb("POST", `${NEW_ACCOUNT}/async_batch_requests`, {
    name: "migrate_probe_1",
    adbatch: JSON.stringify(adbatch),
  });
  console.log("Submit response:", JSON.stringify(submit, null, 2));

  const batchId = (submit.id ?? (submit.async_session_id as string | undefined)) as string | undefined;
  if (!batchId) {
    console.log("\n❌ No batch id returned. Endpoint may not exist or payload shape is wrong.");
    return;
  }

  console.log(`\nPolling batch ${batchId}…`);
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 5000));
    const status = await fb("GET", batchId, {
      fields: "id,name,status,async_percent_completion,results",
    });
    const s = status.status as string | undefined;
    const pct = status.async_percent_completion;
    console.log(`  attempt ${attempt + 1}: status=${s} pct=${pct}`);
    if (s === "COMPLETED" || s === "FAILED" || s === "Job Completed") {
      console.log("\nFinal:");
      console.log(JSON.stringify(status, null, 2));
      writeFileSync(join(process.cwd(), "scripts/meta-migrate/async-probe-result.json"), JSON.stringify(status, null, 2));
      break;
    }
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
