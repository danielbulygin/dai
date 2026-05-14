/**
 * Isolated probe: figure out what creative-spec shape makes Meta accept a
 * cross-account creative when the source page post is a "dynamic creative"
 * carrier. Tests one failed ad's source creative under several payload shapes.
 *
 * Strictly creates AdCreative objects (no Ads attached). These leave creative
 * residue in the new account but do not run. Surface for user cleanup
 * decision after the probe.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/meta-migrate/probe-creative.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const API = "https://graph.facebook.com/v21.0";
const TOKEN = process.env.META_ADS_ACCESS_TOKEN!;
const NEW_ACCOUNT = "act_978593421213192";
const FAILED_AD_ID = "120244512990820066"; // Plan - leaflet // V2

type Json = Record<string, unknown>;

async function fbPost(path: string, body: Record<string, string>): Promise<Json> {
  const form = new URLSearchParams();
  form.set("access_token", TOKEN);
  for (const [k, v] of Object.entries(body)) form.set(k, v);
  const r = await fetch(`${API}/${path}`, { method: "POST", body: form });
  const json = (await r.json()) as Json;
  if (!r.ok) return { _error: json.error ?? json };
  return json;
}

async function main(): Promise<void> {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "scripts/meta-migrate/manifest.json"), "utf8")) as { ads: Json[] };
  const ad = manifest.ads.find((a) => a.id === FAILED_AD_ID);
  if (!ad) throw new Error(`Ad ${FAILED_AD_ID} not in manifest`);
  const cr = ad.creative as Json;
  const effective = cr.effective_object_story_id as string;
  const dofs = cr.degrees_of_freedom_spec as Json;

  console.log(`Probing creative shapes against ${NEW_ACCOUNT} using source ad ${FAILED_AD_ID}`);
  console.log(`  effective_object_story_id: ${effective}`);
  console.log();

  // Test 1: bare object_story_id (we know this fails — baseline)
  console.log("[T1] object_story_id only");
  const t1 = await fbPost(`${NEW_ACCOUNT}/adcreatives`, {
    name: `probe_t1_${Date.now()}`,
    object_story_id: effective,
  });
  console.log(`     ${t1._error ? "❌ " + JSON.stringify((t1._error as Json).error_user_title ?? t1._error) : "✓ " + t1.id}`);

  // Test 2: object_story_id + degrees_of_freedom_spec from source
  console.log("\n[T2] object_story_id + degrees_of_freedom_spec (source)");
  const t2 = await fbPost(`${NEW_ACCOUNT}/adcreatives`, {
    name: `probe_t2_${Date.now()}`,
    object_story_id: effective,
    degrees_of_freedom_spec: JSON.stringify(dofs),
  });
  console.log(`     ${t2._error ? "❌ " + JSON.stringify((t2._error as Json).error_user_title ?? t2._error) : "✓ " + t2.id}`);

  // Test 3: object_story_id + degrees_of_freedom_spec with ALL OPT_OUT
  console.log("\n[T3] object_story_id + DOF all OPT_OUT");
  const allOptOut = {
    creative_features_spec: {
      advantage_plus_creative: { enroll_status: "OPT_OUT" },
      image_animation: { enroll_status: "OPT_OUT" },
      image_brightness_and_contrast: { enroll_status: "OPT_OUT" },
      image_templates: { enroll_status: "OPT_OUT" },
      image_touchups: { enroll_status: "OPT_OUT" },
      inline_comment: { enroll_status: "OPT_OUT" },
      product_extensions: { enroll_status: "OPT_OUT" },
      site_extensions: { enroll_status: "OPT_OUT" },
      standard_enhancements: { enroll_status: "OPT_OUT" },
      text_optimizations: { enroll_status: "OPT_OUT" },
    },
  };
  const t3 = await fbPost(`${NEW_ACCOUNT}/adcreatives`, {
    name: `probe_t3_${Date.now()}`,
    object_story_id: effective,
    degrees_of_freedom_spec: JSON.stringify(allOptOut),
  });
  console.log(`     ${t3._error ? "❌ " + JSON.stringify((t3._error as Json).error_user_title ?? t3._error) : "✓ " + t3.id}`);

  // Test 4: object_story_id + url_tags + dofs (more like source ad structure)
  console.log("\n[T4] object_story_id + url_tags + DOF source");
  const t4 = await fbPost(`${NEW_ACCOUNT}/adcreatives`, {
    name: `probe_t4_${Date.now()}`,
    object_story_id: effective,
    url_tags: String(cr.url_tags ?? ""),
    degrees_of_freedom_spec: JSON.stringify(dofs),
  });
  console.log(`     ${t4._error ? "❌ " + JSON.stringify((t4._error as Json).error_user_title ?? t4._error) : "✓ " + t4.id}`);

  console.log("\nProbe complete. Each successful test created an AdCreative in the new account (no ad attached).");
  console.log("Creative IDs above are residue; report them so user can decide on cleanup.");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
