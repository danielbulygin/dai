import { createClient } from "@supabase/supabase-js";

const bmadUrl = process.env.SUPABASE_URL!;
const bmadKey = process.env.SUPABASE_SERVICE_KEY!;
const client = createClient(bmadUrl, bmadKey);

async function check() {
  const { data: clients } = await client.from("clients").select("id, name, code");
  console.log("Clients:", clients?.map(c => `${c.code} (${c.name})`).join(", "));

  const jva = clients?.find((c: any) => c.code?.toLowerCase() === "jva" || c.name?.toLowerCase().includes("jva"));
  console.log("JVA client:", jva ? `${jva.code} id=${jva.id}` : "NOT FOUND");

  if (clients && clients.length > 0) {
    for (const c of clients.slice(0, 3)) {
      const { count: cd } = await client.from("campaign_daily").select("*", { count: "exact", head: true }).eq("client_id", c.id);
      const { count: ad } = await client.from("account_daily").select("*", { count: "exact", head: true }).eq("client_id", c.id);
      console.log(`${c.code}: campaign_daily=${cd} account_daily=${ad}`);
    }

    // Check sample data sizes
    const { data: campSample } = await client.from("campaign_daily").select("*").limit(1);
    if (campSample?.[0]) console.log("Sample campaign row chars:", JSON.stringify(campSample[0]).length);

    const { data: accSample } = await client.from("account_daily").select("*").limit(1);
    if (accSample?.[0]) console.log("Sample account row chars:", JSON.stringify(accSample[0]).length);

    // Check a full 60-day query size for a client
    const testClient = clients[0];
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString().split('T')[0];
    const { data: fullQuery } = await client.from("campaign_daily")
      .select("*")
      .eq("client_id", testClient.id)
      .gte("date", sixtyDaysAgo);

    if (fullQuery) {
      const jsonStr = JSON.stringify(fullQuery);
      console.log(`60-day campaign data for ${testClient.code}: ${fullQuery.length} rows, ${jsonStr.length} chars`);
    }
  }
}
check().catch(console.error);
