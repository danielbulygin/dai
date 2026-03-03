import { createClient } from "@supabase/supabase-js";

const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

async function check() {
  // Get JVA client
  const { data: jva } = await client.from("clients").select("*").eq("code", "JVA").single();
  console.log("JVA client:", JSON.stringify(jva, null, 2)?.substring(0, 500));

  const clientId = jva?.id;
  if (!clientId) return;

  // Check data volumes
  const tables = ["campaign_daily", "account_daily", "adset_daily", "ad_daily", "breakdowns", "account_changes", "creatives"];
  for (const table of tables) {
    const { count } = await client.from(table).select("*", { count: "exact", head: true }).eq("client_id", clientId);
    console.log(`${table}: ${count} rows`);
  }

  // Simulate what Ada would get with get_campaign_performance for 60 days
  const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString().split('T')[0];
  const { data: campaigns } = await client.from("campaign_daily")
    .select("*")
    .eq("client_id", clientId)
    .gte("date", sixtyDaysAgo);
  if (campaigns) {
    const jsonStr = JSON.stringify(campaigns);
    console.log(`\n60-day campaign_daily: ${campaigns.length} rows, ${jsonStr.length} chars`);
  }

  // Simulate get_account_changes
  const { data: changes } = await client.from("account_changes")
    .select("*")
    .eq("client_id", clientId)
    .gte("timestamp", sixtyDaysAgo);
  if (changes) {
    const jsonStr = JSON.stringify(changes);
    console.log(`60-day account_changes: ${changes.length} rows, ${jsonStr.length} chars`);
  }

  // Simulate breakdowns
  const { data: breakdowns } = await client.from("breakdowns")
    .select("*")
    .eq("client_id", clientId)
    .gte("date", sixtyDaysAgo);
  if (breakdowns) {
    const jsonStr = JSON.stringify(breakdowns);
    console.log(`60-day breakdowns: ${breakdowns.length} rows, ${jsonStr.length} chars`);
  }

  // Check alerts
  const { data: alerts } = await client.from("alerts").select("*").eq("client_id", clientId);
  if (alerts) {
    const jsonStr = JSON.stringify(alerts);
    console.log(`alerts: ${alerts.length} rows, ${jsonStr.length} chars`);
  }

  // Check learnings
  const { data: learnings } = await client.from("learnings").select("*").eq("client_id", clientId);
  if (learnings) {
    const jsonStr = JSON.stringify(learnings);
    console.log(`learnings: ${learnings.length} rows, ${jsonStr.length} chars`);
  }

  // Adset daily
  const { data: adsets } = await client.from("adset_daily")
    .select("*")
    .eq("client_id", clientId)
    .gte("date", sixtyDaysAgo);
  if (adsets) {
    const jsonStr = JSON.stringify(adsets);
    console.log(`60-day adset_daily: ${adsets.length} rows, ${jsonStr.length} chars`);
  }

  // Ad daily
  const { data: ads } = await client.from("ad_daily")
    .select("*")
    .eq("client_id", clientId)
    .gte("date", sixtyDaysAgo);
  if (ads) {
    const jsonStr = JSON.stringify(ads);
    console.log(`60-day ad_daily: ${ads.length} rows, ${jsonStr.length} chars`);
  }
}
check().catch(console.error);
