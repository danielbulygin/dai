/**
 * One-time drain of the dead insight-review backlog (policy change 2026-06-09).
 *
 * Auto-approves all status='pending', durability='durable', confidence='high'
 * rows in pending_insights into methodology_knowledge (+ learnings), exactly
 * as a human "approve" click would have. Medium/null-confidence rows stay
 * pending (queryable; reviewable whenever). Dedups against existing
 * methodology_knowledge titles — the Feb 27–Mar 4 bulk batch overlaps the
 * queue's first days.
 *
 *   pnpm exec tsx scripts/drain-pending-insights.ts [--dry-run]
 */
import { getDaiSupabase } from '../src/integrations/dai-supabase.js';
import { addLearning } from '../src/memory/learnings.js';

const DRY_RUN = process.argv.includes('--dry-run');
const supabase = getDaiSupabase();

// Existing titles for dedup (paged — PostgREST caps at 1000 rows).
const existingTitles = new Set<string>();
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase
    .from('methodology_knowledge')
    .select('title')
    .range(from, from + 999);
  if (error) throw new Error(`title fetch failed: ${error.message}`);
  for (const r of data ?? []) existingTitles.add((r.title as string).trim().toLowerCase());
  if (!data || data.length < 1000) break;
}
console.log(`Existing methodology titles: ${existingTitles.size}`);

let approved = 0;
let skippedDupes = 0;

for (;;) {
  const { data: batch, error } = await supabase
    .from('pending_insights')
    .select('id, meeting_title, meeting_date, type, title, body, account_code, category, confidence')
    .eq('status', 'pending')
    .eq('durability', 'durable')
    .eq('confidence', 'high')
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) throw new Error(`batch fetch failed: ${error.message}`);
  if (!batch || batch.length === 0) break;

  for (const ins of batch) {
    const isDupe = existingTitles.has((ins.title as string).trim().toLowerCase());
    if (DRY_RUN) {
      if (isDupe) skippedDupes++; else approved++;
      continue;
    }
    if (!isDupe) {
      const { error: insErr } = await supabase.from('methodology_knowledge').insert({
        type: ins.type,
        title: ins.title,
        body: ins.body,
        account_code: ins.account_code,
        category: ins.category,
        confidence: ins.confidence,
        source_meeting: ins.meeting_title,
        source_date: ins.meeting_date,
        extraction_run: 'backlog-drain-2026-06-09',
      });
      if (insErr) throw new Error(`methodology insert failed: ${insErr.message}`);
      await addLearning({
        agent_id: 'ada',
        category: ins.type === 'rule' ? 'methodology_rule' : 'account_knowledge',
        content: ins.account_code ? `[${ins.account_code}] ${ins.title}` : (ins.title as string),
        confidence: 0.8,
        source_session_id: 'backlog-drain-2026-06-09',
        client_code: ins.account_code as string | null,
      });
      existingTitles.add((ins.title as string).trim().toLowerCase());
      approved++;
    } else {
      skippedDupes++;
    }
    const { error: updErr } = await supabase
      .from('pending_insights')
      .update({
        status: 'auto_approved',
        reviewed_at: new Date().toISOString(),
        review_notes: isDupe
          ? 'backlog drain 2026-06-09: duplicate title already in methodology'
          : 'backlog drain 2026-06-09: auto-approved (high confidence)',
      })
      .eq('id', ins.id);
    if (updErr) throw new Error(`status update failed: ${updErr.message}`);
  }
  console.log(`...processed ${approved + skippedDupes} so far (${approved} approved, ${skippedDupes} dupes)`);
  if (DRY_RUN) break; // dry run inspects one batch only
}

console.log(`DONE${DRY_RUN ? ' (dry run, first batch only)' : ''}: ${approved} approved into methodology_knowledge, ${skippedDupes} duplicates marked.`);
process.exit(0);
