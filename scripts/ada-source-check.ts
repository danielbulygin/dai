import { adaClientFor, adaAccountPerformance, adaEntitySummary } from "../src/agents/tools/ada-source.js";
import { getClientPerformance, getCampaignSummary } from "../src/agents/tools/supabase-tools.js";

const j = (s: string) => JSON.parse(s);

async function main() {
  
  const mtr = await adaClientFor("MTR");
  console.log("MTR is an Ada client:", !!mtr, mtr?.adAccountId);
  const ab = await adaClientFor("AB");
  console.log("AB (agency) routed to Ada source:", !!ab, "<- must be false");
  
  const acct = j(await adaAccountPerformance(mtr!, 30));
  console.log("\naccount days:", acct.length);
  console.log("sample day:", JSON.stringify(acct[1]));
  const spend = acct.reduce((a: number, r: any) => a + r.spend, 0);
  const results = acct.reduce((a: number, r: any) => a + r.results, 0);
  console.log(`30d totals: spend=$${spend.toFixed(2)} leads=${results} CPL=$${(spend/results).toFixed(2)}`);
  
  const camps = j(await adaEntitySummary(mtr!, "campaign", 30));
  console.log("\ncampaigns:", camps.length);
  for (const c of camps.slice(0,3)) console.log(`  $${Number(c.spend).toFixed(0).padStart(5)}  ${c.results} results  cpr=${c.cost_per_result?.toFixed(2)}  ${c.campaign_name?.slice(0,45)}`);
  
  // The real entry points the chat tools use
  console.log("\n=== via the actual tool functions ===");
  console.log("getClientPerformance(MTR) rows:", j(await getClientPerformance({clientCode:"MTR",days:30})).length);
  const abRows = j(await getClientPerformance({clientCode:"AB",days:7}));
  console.log("getClientPerformance(AB) rows:", Array.isArray(abRows)? abRows.length : abRows, "<- agency path still works");
  console.log("getCampaignSummary(MTR) rows:", j(await getCampaignSummary({clientCode:"MTR",days:30})).length);
  
}
main().catch((e)=>{console.error(e);process.exit(1);});
