/**
 * Fix misattributed insight: "55-64 age demographic" tagged as brain_fm → should be audibene
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.DAI_SUPABASE_URL!;
const key = process.env.DAI_SUPABASE_SERVICE_KEY!;
const supabase = createClient(url, key);

async function main(): Promise<void> {
  // 1. Find in pending_insights
  const { data: pending } = await supabase
    .from("pending_insights")
    .select("id, seq, title, account_code, status")
    .ilike("title", "%55-64%");

  console.log("=== pending_insights ===");
  console.log(JSON.stringify(pending, null, 2));

  // 2. Find in methodology_knowledge
  const { data: methKnow } = await supabase
    .from("methodology_knowledge")
    .select("id, title, account_code, type")
    .ilike("title", "%55-64%");

  console.log("\n=== methodology_knowledge ===");
  console.log(JSON.stringify(methKnow, null, 2));

  // 3. Find in learnings
  const { data: learnings } = await supabase
    .from("learnings")
    .select("id, content, client_code")
    .ilike("content", "%55-64%");

  console.log("\n=== learnings ===");
  console.log(JSON.stringify(learnings, null, 2));

  // Fix all found records
  if (pending?.length) {
    for (const row of pending) {
      if (row.account_code === "brain_fm") {
        const { error } = await supabase
          .from("pending_insights")
          .update({ account_code: "audibene" })
          .eq("id", row.id);
        console.log(`\nFixed pending_insights ${row.id}: brain_fm → audibene`, error ?? "OK");
      }
    }
  }

  if (methKnow?.length) {
    for (const row of methKnow) {
      if (row.account_code === "brain_fm") {
        const { error } = await supabase
          .from("methodology_knowledge")
          .update({ account_code: "audibene" })
          .eq("id", row.id);
        console.log(`\nFixed methodology_knowledge ${row.id}: brain_fm → audibene`, error ?? "OK");
      }
    }
  }

  if (learnings?.length) {
    for (const row of learnings) {
      if (row.client_code === "brain_fm") {
        const { error } = await supabase
          .from("learnings")
          .update({ client_code: "audibene" })
          .eq("id", row.id);
        console.log(`\nFixed learnings ${row.id}: brain_fm → audibene`, error ?? "OK");
      }
    }
  }

  // Clean up the correction-note learning (no longer needed since source record is fixed)
  const correctionId = "aT-gbupyd_G1gyTEMXeMW";
  const { error: delErr } = await supabase.from("learnings").delete().eq("id", correctionId);
  console.log(`\nDeleted correction-note learning ${correctionId}:`, delErr ?? "OK");
}

main().catch(console.error);
