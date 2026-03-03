const { createClient } = require("@supabase/supabase-js");
const bmadUrl = process.env.BMAD_SUPABASE_URL;
const bmadKey = process.env.BMAD_SUPABASE_SERVICE_KEY;
if (!bmadUrl || !bmadKey) { console.log("BMAD credentials not found"); process.exit(1); }
const client = createClient(bmadUrl, bmadKey);

async function check() {
  const { data: clients } = await client.from("clients").select("id, name, code");
  console.log("Clients:", clients?.map(c => c.code + " (" + c.name + ")").join(", "));

  const jva = clients?.find(c => c.code?.toLowerCase() === "jva" || c.name?.toLowerCase().includes("jva"));
  console.log("JVA client:", jva ? jva.code + " id=" + jva.id : "NOT FOUND");

  // Check data volume for a client
  if (clients?.length > 0) {
    for (const c of clients.slice(0, 3)) {
      const { count: cd } = await client.from("campaign_daily").select("*", { count: "exact", head: true }).eq("client_id", c.id);
      const { count: ad } = await client.from("account_daily").select("*", { count: "exact", head: true }).eq("client_id", c.id);
      console.log(c.code + ": campaign_daily=" + cd + " account_daily=" + ad);
    }

    // Check sample data size
    const { data: sample } = await client.from("campaign_daily").select("*").limit(1);
    if (sample && sample[0]) console.log("Sample campaign row chars:", JSON.stringify(sample[0]).length);

    const { data: accSample } = await client.from("account_daily").select("*").limit(1);
    if (accSample && accSample[0]) console.log("Sample account row chars:", JSON.stringify(accSample[0]).length);
  }
}
check().catch(console.error);
