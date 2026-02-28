/**
 * Seed Ada's per-account learnings from BMAD Supabase data.
 *
 * Bootstraps Ada's knowledge base with:
 * - Client profiles (KPI targets, account type, markets)
 * - Existing BMAD learnings
 * - Known benchmarks from ads-config.yaml files
 * - Client-specific insights from transcript analysis
 *
 * Usage:
 *   pnpm tsx scripts/seed-ada-learnings.ts [--dry-run]
 */

import { createClient } from "@supabase/supabase-js";
import { nanoid } from "nanoid";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DAI_SUPABASE_URL = process.env.DAI_SUPABASE_URL;
const DAI_SUPABASE_SERVICE_KEY = process.env.DAI_SUPABASE_SERVICE_KEY;
const DRY_RUN = process.argv.includes("--dry-run");

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY (BMAD)");
  process.exit(1);
}

if (!DAI_SUPABASE_URL || !DAI_SUPABASE_SERVICE_KEY) {
  console.error("Missing DAI_SUPABASE_URL or DAI_SUPABASE_SERVICE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const daiSupabase = createClient(DAI_SUPABASE_URL, DAI_SUPABASE_SERVICE_KEY);

const AGENT_ID = "ada";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BmadClient {
  code: string;
  name: string;
  status: string;
}

interface BmadLearning {
  client_code: string | null;
  category: string;
  content: string;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Seed Functions
// ---------------------------------------------------------------------------

async function insertLearning(
  category: string,
  content: string,
  confidence: number = 0.7,
): Promise<void> {
  if (DRY_RUN) {
    console.log(`[DRY RUN] ${category}: ${content.slice(0, 80)}...`);
    return;
  }

  const { error } = await daiSupabase.from("learnings").insert({
    id: nanoid(),
    agent_id: AGENT_ID,
    category,
    content,
    confidence,
    source_session_id: null,
  });

  if (error) {
    console.error(`Failed to insert learning: ${error.message}`);
  }
}

async function seedFromBmadClients(): Promise<void> {
  console.log("\n--- Seeding client profiles from BMAD ---");

  const { data: clients, error } = await supabase
    .from("clients")
    .select("*")
    .eq("status", "active");

  if (error) {
    console.error("Failed to fetch clients:", error.message);
    return;
  }

  if (!clients?.length) {
    console.log("No active clients found in BMAD");
    return;
  }

  console.log(`Found ${clients.length} active clients`);

  for (const client of clients as BmadClient[]) {
    await insertLearning(
      "account_profile",
      `Client: ${client.name} (${client.code}) | Status: ${client.status}`,
      0.9,
    );
  }
}

async function seedFromBmadLearnings(): Promise<void> {
  console.log("\n--- Seeding from BMAD learnings table ---");

  const { data: learnings, error } = await supabase
    .from("learnings")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    console.error("Failed to fetch learnings:", error.message);
    return;
  }

  if (!learnings?.length) {
    console.log("No learnings found in BMAD");
    return;
  }

  console.log(`Found ${learnings.length} BMAD learnings`);

  for (const l of learnings as BmadLearning[]) {
    const prefix = l.client_code ? `[${l.client_code}] ` : "";
    await insertLearning(
      l.category ?? "general",
      `${prefix}${l.content}`,
      l.confidence ?? 0.6,
    );
  }
}

async function seedTranscriptInsights(): Promise<void> {
  console.log("\n--- Seeding transcript-derived client insights ---");

  const insights: Array<{
    category: string;
    content: string;
    confidence: number;
  }> = [
    // Audibena
    {
      category: "account_profile",
      content:
        "[audibena] Hearing aids, 65+ demographic. CPA target: €139 (client-stated, real target may be €150-190). Attribution: 1-day click/1-day view. Reporting via Domo/Salesforce. Meta-to-Domo CPL discrepancy ~25%.",
      confidence: 0.9,
    },
    {
      category: "account_insight",
      content:
        "[audibena] 55-64 age segment has 55% lower CPA but 28% worse downstream conversion (CR3). Purchase willingness much stronger for 65+ due to hearing loss severity. Android may outperform iOS for this demo.",
      confidence: 0.8,
    },
    {
      category: "account_insight",
      content:
        "[audibena] CR2 (lead→appointment) depends heavily on how fast the sales team calls leads. CPA optimization is partially compromised by this uncontrollable variable. Track CR2 trends separately.",
      confidence: 0.85,
    },
    {
      category: "account_insight",
      content:
        "[audibena] Steven (client-side) renames ad sets mid-flight, causing Domo to split single ad sets into multiple rows. Never rename active ad sets for this client. Always verify data with explicit date ranges, not 'last 7 days'.",
      confidence: 0.9,
    },

    // Brain.fm
    {
      category: "account_profile",
      content:
        "[brainfm] Productivity app, subscription model. CPA target: $50. Currently achieving ~$34-39. Kill threshold: $200 CPP. Geo: US dominant (50%+ spend), Tier 2 markets. Client is 'ecstatic' with current performance.",
      confidence: 0.9,
    },
    {
      category: "account_insight",
      content:
        "[brainfm] Hero ad dependency: entire account performance relies on one neurotype funnel ad. Single point of failure. Audience Network inflates vanity metrics — always exclude. Social proof reset when re-uploading ads with new links.",
      confidence: 0.85,
    },
    {
      category: "account_insight",
      content:
        "[brainfm] Non-impulsive buy — conversions may come in evenings. Landing pages that look like the main website underperform dedicated funnels. Custom landing pages must be meaningfully different.",
      confidence: 0.75,
    },

    // Press London
    {
      category: "account_profile",
      content:
        "[press] Juice cleanses + meal plans, e-commerce D2C. Product hierarchy by efficiency: Cleanses > Shots > Meals. ROAS + CPA both matter. TikTok = 22% of revenue per post-purchase survey.",
      confidence: 0.9,
    },
    {
      category: "account_insight",
      content:
        "[press] Customers are deal/discount sensitive, NOT price sensitive. Sale ending caused 40% ATC drop even though prices were permanently lowered. The psychology of a 'sale' matters more than absolute price.",
      confidence: 0.85,
    },
    {
      category: "account_insight",
      content:
        "[press] Cart abandonment tripled after sale ended (Jan 5-11). All pre-click metrics improved during this period — the break was specifically at the ATC stage. Classic post-click funnel issue.",
      confidence: 0.8,
    },

    // Laori
    {
      category: "account_profile",
      content:
        "[laori] Non-alcoholic spirits, German brand. High ROAS but unprofitable at current spend. Needs ~€3K/day (was €1K/day) to cover fixed costs. Weather-correlated: sunny/warm = demand spike. Account timezone: Los Angeles.",
      confidence: 0.9,
    },
    {
      category: "account_insight",
      content:
        "[laori] Top-of-funnel engine is critical. When the low-frequency TOF ad set was killed, performance dropped immediately. Amalfi Mom and Amalfi Spritz are long-running performers (~1 year). Chaotic hooks work well.",
      confidence: 0.85,
    },
    {
      category: "account_insight",
      content:
        "[laori] Limited edition ads dragged down account performance — turning them off immediately improved PDP views and ATC rates. Negroni is highest spend but NOT highest ROAS. Bundles have higher ROAS due to AOV.",
      confidence: 0.8,
    },
    {
      category: "creative",
      content:
        "[laori] AI-generated spokesperson video performs extremely well — people don't realize it's AI because real footage is mixed in (tattoo details on hands match). Weight loss angle also performing well on ROAS.",
      confidence: 0.7,
    },

    // Teeth Lovers / Strays
    {
      category: "account_profile",
      content:
        "[teethlvrs] Dental/health products. Primary KPI: new customer CPA. Drops product = best seller with lowest CPA and highest volume. UGC videos from 'Alex' drove major improvement. ROAS breakeven: 2.16.",
      confidence: 0.9,
    },
    {
      category: "account_insight",
      content:
        "[strays] Performance directly correlates with stock availability. Stock-out = reduce spend immediately. Pre-position bid caps for restock to scale instantly. Target NCCPA tracked in Klar.",
      confidence: 0.85,
    },
    {
      category: "account_insight",
      content:
        "[strays] Turnaround came from being stricter with ads and NOT forcing Meta to spend on test ads. Letting Meta allocate to proven 'mixed' ad sets outperformed active management. Cost caps doing their job.",
      confidence: 0.8,
    },

    // Slumber
    {
      category: "account_profile",
      content:
        "[slumber] Sleep product, e-commerce. Does NOT care about ROAS — cares about new customer CPA specifically. V2 Pixel audiences outperforming. 65+ bid caps working well. Cross-check Meta with Triple Whale NCCPA.",
      confidence: 0.9,
    },

    // JV Academy
    {
      category: "account_profile",
      content:
        "[jva] Football/soccer training academy. Webinar funnel model. UK: ~£8-10/lead. US: webinar CVR is 2x UK. UK limited by creative variety and frequency. Soccer→football terminology blocks US ad reuse in UK.",
      confidence: 0.9,
    },
    {
      category: "account_insight",
      content:
        "[jva] US conversion rate collapsed from 2.6% to 0.6% because Calendly booking widget had no January 2026 slots. Always validate full funnel when CVR drops dramatically with stable ad metrics.",
      confidence: 0.85,
    },

    // V Lifestyle
    {
      category: "account_insight",
      content:
        "[vlifestyle] German supplements, 55+ target. Main lever is AOV (conversion rates are acceptable). Bundle strategy needed. Android ROAS 2.7 vs iPhone, cost per subscription 6x lower on Android. Consider Android-only campaigns.",
      confidence: 0.8,
    },

    // General methodology
    {
      category: "methodology",
      content:
        "Frequency is the #1 leading indicator across ALL accounts. Inverse correlation with ROAS is consistent. Every account needs at least one ad set driving low-frequency fresh reach (the 'top-of-funnel engine').",
      confidence: 0.95,
    },
    {
      category: "methodology",
      content:
        "Standard scaling rate: 20%/day. Aggressive scaling only when seasonal opportunity + proven ROAS. Scaling requires creative pipeline — you cannot scale without fresh creative supply.",
      confidence: 0.9,
    },
    {
      category: "methodology",
      content:
        "Kill composite: frequency > 3.5 AND CPA > 5x target for 3+ days AND < 2 conversions AND no external explanation. All criteria must be met. Don't kill prematurely.",
      confidence: 0.95,
    },
    {
      category: "methodology",
      content:
        "Before changing anything in a specific account, check if 3+ other accounts show the same pattern. If yes, it's a platform-wide issue — do nothing for 24-48 hours.",
      confidence: 0.95,
    },
    {
      category: "methodology",
      content:
        "CPMs dropping is NOT always good — can mean Meta is shifting to cheaper/lower-quality audiences. Rising CPMs with stable CTR = external auction pressure, not creative failure.",
      confidence: 0.9,
    },
  ];

  for (const insight of insights) {
    await insertLearning(insight.category, insight.content, insight.confidence);
  }

  console.log(`Seeded ${insights.length} transcript-derived insights`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Seeding Ada learnings into DAI Supabase");
  if (DRY_RUN) console.log("=== DRY RUN MODE ===\n");

  // Count existing Ada learnings
  const { count: existingCount } = await daiSupabase
    .from("learnings")
    .select("*", { count: "exact", head: true })
    .eq("agent_id", AGENT_ID);
  console.log(`Existing Ada learnings: ${existingCount ?? 0}`);

  await seedFromBmadClients();
  await seedFromBmadLearnings();
  await seedTranscriptInsights();

  // Final count
  if (!DRY_RUN) {
    const { count: finalCount } = await daiSupabase
      .from("learnings")
      .select("*", { count: "exact", head: true })
      .eq("agent_id", AGENT_ID);
    console.log(`\nTotal Ada learnings after seeding: ${finalCount ?? 0}`);
  }

  console.log("\nDone!");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
