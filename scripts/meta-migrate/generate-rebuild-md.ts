/**
 * Generate a prioritized manual-rebuild markdown file.
 *
 * Reads needs-manual.csv (output of generate-handoff.ts), queries last-14d
 * spend per ad from Meta Insights, sorts descending by spend, and writes
 * a markdown file the operator can work through top-down.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/meta-migrate/generate-rebuild-md.ts
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const API = "https://graph.facebook.com/v21.0";
const TOKEN = process.env.META_ADS_ACCESS_TOKEN!;
const OLD_ACCOUNT = "act_1814118775391116";
const DIR = join(process.cwd(), "scripts/meta-migrate");
const CSV = join(DIR, "needs-manual.csv");
const OUT = join(DIR, "rebuild-priorities.md");

type Json = Record<string, unknown>;

async function fbGet(path: string, params: Record<string, string> = {}): Promise<Json> {
  const u = new URL(`${API}/${path}`);
  u.searchParams.set("access_token", TOKEN);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u.toString());
  return (await r.json()) as Json;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split("\n");
  const header = lines[0]!.split(",");
  return lines.slice(1).map((ln) => {
    // Simple CSV parser respecting quoted fields with embedded commas
    const cells: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < ln.length; i++) {
      const ch = ln[i];
      if (inQ) {
        if (ch === '"' && ln[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') { inQ = false; }
        else { cur += ch; }
      } else {
        if (ch === ",") { cells.push(cur); cur = ""; }
        else if (ch === '"') { inQ = true; }
        else { cur += ch; }
      }
    }
    cells.push(cur);
    const row: Record<string, string> = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ""; });
    return row;
  });
}

async function main(): Promise<void> {
  if (!existsSync(CSV)) {
    console.error(`Missing ${CSV}. Run generate-handoff.ts first.`);
    process.exit(1);
  }
  const rows = parseCsv(readFileSync(CSV, "utf8"));
  console.log(`Found ${rows.length} ads needing manual rebuild. Fetching 14d spend…`);

  // Fetch last-14d insights for all ads on the old account in one call
  const insights = await fbGet(`${OLD_ACCOUNT}/insights`, {
    level: "ad",
    date_preset: "last_14d",
    fields: "ad_id,spend,impressions,clicks,actions",
    limit: "500",
  });
  const data = ((insights.data as Json[]) ?? []) as Array<{
    ad_id: string; spend?: string; impressions?: string; clicks?: string; actions?: Array<{ action_type: string; value: string }>;
  }>;
  const spendByAd = new Map<string, { spend: number; impressions: number; clicks: number; purchases: number }>();
  for (const d of data) {
    const purchases = (d.actions ?? [])
      .filter((a) => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase")
      .reduce((sum, a) => sum + parseFloat(a.value), 0);
    spendByAd.set(d.ad_id, {
      spend: parseFloat(d.spend ?? "0"),
      impressions: parseInt(d.impressions ?? "0", 10),
      clicks: parseInt(d.clicks ?? "0", 10),
      purchases,
    });
  }

  // Enrich + sort
  type Row = {
    source_ad_id: string;
    ad_name: string;
    source_campaign_name: string;
    source_adset_name: string;
    new_adset_id: string;
    new_campaign_id: string;
    page_post_url: string;
    failure_reason: string;
    spend_14d: number;
    impressions_14d: number;
    clicks_14d: number;
    purchases_14d: number;
  };
  const enriched: Row[] = rows.map((r) => {
    const s = spendByAd.get(r.source_ad_id!);
    return {
      source_ad_id: r.source_ad_id!,
      ad_name: r.ad_name!,
      source_campaign_name: r.source_campaign_name!,
      source_adset_name: r.source_adset_name!,
      new_adset_id: r.new_adset_id!,
      new_campaign_id: r.new_campaign_id!,
      page_post_url: r.page_post_url!,
      failure_reason: r.failure_reason!,
      spend_14d: s?.spend ?? 0,
      impressions_14d: s?.impressions ?? 0,
      clicks_14d: s?.clicks ?? 0,
      purchases_14d: s?.purchases ?? 0,
    };
  });
  enriched.sort((a, b) => b.spend_14d - a.spend_14d);

  // Group by campaign for readability
  const byCampaign = new Map<string, Row[]>();
  for (const r of enriched) {
    const key = r.source_campaign_name || "(unknown campaign)";
    if (!byCampaign.has(key)) byCampaign.set(key, []);
    byCampaign.get(key)!.push(r);
  }

  // Sort campaigns by their total 14d spend desc
  const campaignOrder = [...byCampaign.entries()]
    .map(([name, rows]) => ({
      name,
      total: rows.reduce((s, r) => s + r.spend_14d, 0),
      rows,
    }))
    .sort((a, b) => b.total - a.total);

  const totalSpend = enriched.reduce((s, r) => s + r.spend_14d, 0);
  const adsWithSpend = enriched.filter((r) => r.spend_14d > 0).length;

  const md: string[] = [];
  md.push(`# Manual rebuild — prioritized by last 14d spend`);
  md.push(``);
  md.push(`Generated ${new Date().toISOString()}. Currency: GBP.`);
  md.push(``);
  md.push(`These ${enriched.length} ads could not be migrated via the Marketing API because their source Page posts are registered as "dynamic creative" carriers that require a \`product_set_id\` Meta refuses to accept any creative payload override we tried.`);
  md.push(``);
  md.push(`**Total 14d spend across these ads:** £${totalSpend.toFixed(2)}`);
  md.push(`**Ads with non-zero spend in last 14d:** ${adsWithSpend} of ${enriched.length}`);
  md.push(``);
  md.push(`## How to rebuild each ad`);
  md.push(``);
  md.push(`1. Open the source ad's page post URL (right-most column) — that's the rendered creative you need to recreate`);
  md.push(`2. In Ads Manager, navigate to the destination ad set listed in the table (it's already created in **Naturally Better Nutrition** \`act_978593421213192\`)`);
  md.push(`3. Click "+ Create Ad" inside that ad set`);
  md.push(`4. Either: select "Use existing post" and paste the page post URL, OR rebuild the creative manually with the same media/copy`);
  md.push(`5. Leave the ad **paused** until you're done with all rebuilds in that ad set`);
  md.push(``);
  md.push(`Tip: work top-down. The ads at the top represent the highest spend and likely best-performing creatives — rebuild those first so the new account has the strongest performers ready to activate.`);
  md.push(``);

  for (const c of campaignOrder) {
    md.push(`## ${c.name}`);
    md.push(``);
    md.push(`**Campaign 14d spend (across unmigrated ads): £${c.total.toFixed(2)}** · ${c.rows.length} ads to rebuild`);
    md.push(``);
    md.push(`| 14d Spend | 14d Purchases | Ad Name | Destination Ad Set ID | Page Post |`);
    md.push(`|---:|---:|---|---|---|`);
    for (const r of c.rows) {
      const post = r.page_post_url ? `[open](${r.page_post_url})` : "—";
      md.push(`| £${r.spend_14d.toFixed(2)} | ${r.purchases_14d.toFixed(0)} | ${r.ad_name.replace(/\|/g, "\\|")} | \`${r.new_adset_id}\` | ${post} |`);
    }
    md.push(``);
  }

  writeFileSync(OUT, md.join("\n"));
  console.log(`✓ ${OUT}`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
