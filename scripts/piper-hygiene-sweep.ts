/**
 * Piper pipeline-hygiene sweep — DRY RUN (terminal).
 *
 *   pnpm hygiene:sweep            # dry-run: report what WOULD be cleaned, write nothing
 *   pnpm hygiene:sweep --apply    # (not wired yet — refuses, by design)
 *
 * Reads the bmad Supabase mirror (aot_tasks_current / aot_adsets_current) and
 * classifies cleanup candidates. Does the task→parent-ad-set join in memory
 * (PostgREST can't express "all parents terminal").
 *
 * CRITICAL: 'On Hold' is NOT terminal. It means paused-but-may-resume — its
 * tasks are live pipeline (e.g. JVA concepts with future delivery dates). The
 * terminal set is Completed / Cancelled / Archived only. On Hold is treated as
 * LIVE here, and near-term On Hold work is surfaced, never closed.
 */

import { getSupabase } from '../src/integrations/supabase.js';
import { getDaiSupabase } from '../src/integrations/dai-supabase.js';
import { getNotion } from '../src/integrations/notion.js';
import { randomUUID } from 'node:crypto';

const TERMINAL_AD_SET_STAGES = new Set(['Completed', 'Cancelled', 'Archived']); // NOT 'On Hold'
const TERMINAL_TASK_STATUSES = new Set(['Done', 'Cancelled', 'Complete', 'Archived Task']);
const DAY = 86_400_000;
const now = Date.now();
const today = new Date().toISOString().slice(0, 10);
const ageDays = (iso: string | null): number => (iso ? Math.floor((now - Date.parse(iso)) / DAY) : Infinity);

interface AdSet {
  notion_id: string; stage: string | null; ad_id_code: string | null; ad_title: string | null;
  client_code: string | null; client_status: string | null; ad_delivery_date: string | null;
  notion_last_edited_time: string | null; overdue_tasks_count: number | null; url: string | null;
}
interface Task {
  notion_id: string; status: string | null; task_name: string | null; task_due_date: string | null;
  notion_last_edited_time: string | null; ad_set_code: string | null;
  ad_set_relation_ids: string[] | null; url: string | null;
}

async function fetchAll<T>(table: string, columns: string, filter?: (q: any) => any): Promise<T[]> {
  const sb = getSupabase();
  const out: T[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(table).select(columns).range(from, from + PAGE - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data as T[]) ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

function fmt(rows: Array<{ code: string | null; label: string | null; extra?: string; url: string | null }>, n = 8): string {
  const lines = rows.slice(0, n).map((r) => `    • ${r.code ?? '(no code)'}  ${(r.label ?? '').slice(0, 48)}${r.extra ? '  ' + r.extra : ''}  ${r.url ?? ''}`);
  if (rows.length > n) lines.push(`    … +${rows.length - n} more`);
  return lines.join('\n');
}

const TERMINAL_TASK_STATUS = 'Archived Task';

/** Archive one task in Notion (Status → 'Archived Task') and log a reversible write row. */
async function archiveTask(t: Task, sessionId: string): Promise<'archived' | 'skipped' | 'failed'> {
  const notion = getNotion();
  const t0 = Date.now();
  try {
    // Live re-check: don't act on stale mirror data.
    const page = (await notion.pages.retrieve({ page_id: t.notion_id })) as any;
    const liveStatus: string | null = page.properties?.Status?.status?.name ?? null;
    if (liveStatus && TERMINAL_TASK_STATUSES.has(liveStatus)) return 'skipped'; // already terminal

    await notion.pages.update({
      page_id: t.notion_id,
      properties: { Status: { status: { name: TERMINAL_TASK_STATUS } } },
    });

    await logWrite({
      sessionId, targetId: t.notion_id, status: 'success', durationMs: Date.now() - t0,
      before: { status: liveStatus }, after: { status: TERMINAL_TASK_STATUS },
      reverse: { action: 'set_task_status', task_id: t.notion_id, status: liveStatus },
      summary: `archived ${t.ad_set_code ?? ''} ${(t.task_name ?? '').slice(0, 50)}`.trim(),
      params: { task_id: t.notion_id, category: 'A_cascade_close', ad_set_code: t.ad_set_code },
    });
    return 'archived';
  } catch (err) {
    await logWrite({
      sessionId, targetId: t.notion_id, status: 'failed', durationMs: Date.now() - t0,
      before: null, after: null, reverse: null,
      summary: `FAILED archive ${t.ad_set_code ?? ''}`, params: { task_id: t.notion_id, category: 'A_cascade_close' },
      error: (err as Error).message,
    });
    return 'failed';
  }
}

/** Insert a full write-row into piper_actions (dai Supabase) — the existing logToolCall only does action_type='tool_call'. */
async function logWrite(o: {
  sessionId: string; targetId: string; status: 'success' | 'failed'; durationMs: number;
  before: unknown; after: unknown; reverse: unknown; summary: string; params: Record<string, unknown>; error?: string;
}): Promise<void> {
  try {
    await getDaiSupabase().from('piper_actions').insert({
      agent_id: 'piper', session_id: o.sessionId, action_type: 'write',
      tool_name: 'hygiene_sweep_archive_task', initiator: 'terminal',
      params: o.params, result_summary: o.summary.slice(0, 800),
      target_system: 'notion', target_id: o.targetId,
      before_state: o.before, after_state: o.after, reverse_action: o.reverse,
      status: o.status, duration_ms: o.durationMs, error: o.error?.slice(0, 2000) ?? null,
    });
  } catch (err) {
    console.error('  (warn) piper_actions log failed:', (err as Error).message);
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const limArg = process.argv.indexOf('--limit');
  const limit = limArg >= 0 ? parseInt(process.argv[limArg + 1], 10) : Infinity;

  console.log(`\nPiper hygiene sweep — ${apply ? 'APPLY' : 'DRY RUN'} — ${today}\n${'='.repeat(60)}`);

  const [adsets, tasks] = await Promise.all([
    fetchAll<AdSet>('aot_adsets_current', 'notion_id,stage,ad_id_code,ad_title,client_code,client_status,ad_delivery_date,notion_last_edited_time,overdue_tasks_count,url', (q) => q.not('is_deleted', 'is', true)),
    fetchAll<Task>('aot_tasks_current', 'notion_id,status,task_name,task_due_date,notion_last_edited_time,ad_set_code,ad_set_relation_ids,url', (q) => q.not('is_deleted', 'is', true).not('status', 'in', `(${[...TERMINAL_TASK_STATUSES].map((s) => `"${s}"`).join(',')})`)),
  ]);

  const stageById = new Map(adsets.map((a) => [a.notion_id, a.stage]));
  const adsetByCode = new Map(adsets.filter((a) => a.ad_id_code).map((a) => [a.notion_id, a]));
  console.log(`Loaded ${tasks.length} non-terminal tasks, ${adsets.length} ad sets.\n`);

  // --- TASK CATEGORIES ---
  const cascadeSafe: Task[] = [];      // A: every parent terminal (Completed/Cancelled/Archived), >=1 parent
  const onHoldNearTerm: Task[] = [];   // surface, never close
  const staleReaper: Task[] = [];      // B: untouched >90d, not in A
  const staleDeep: Task[] = [];        //    of those, >180d (highest-confidence)

  for (const t of tasks) {
    const parents = (t.ad_set_relation_ids ?? []).map((id) => stageById.get(id)).filter((s): s is string => s != null);
    const hasParent = parents.length > 0;
    const allTerminal = hasParent && parents.every((s) => TERMINAL_AD_SET_STAGES.has(s));
    const anyOnHold = parents.includes('On Hold');
    const pastDue = !!t.task_due_date && t.task_due_date < today;
    const age = ageDays(t.notion_last_edited_time);

    if (allTerminal) { cascadeSafe.push(t); continue; }
    if (anyOnHold && pastDue) onHoldNearTerm.push(t); // paused work that's past its (old) due date — surface
    if (pastDue && age > 90) { staleReaper.push(t); if (age > 180) staleDeep.push(t); }
  }

  // --- AD SET CATEGORIES ---
  const live = (s: string | null) => s != null && !TERMINAL_AD_SET_STAGES.has(s) && s !== 'On Hold';
  const shippedLaunch = adsets.filter((a) => a.stage === 'Launch' && a.ad_delivery_date && a.ad_delivery_date < today && ageDays(a.ad_delivery_date) > 90 && (a.overdue_tasks_count ?? 0) === 0);
  const deadConcept = adsets.filter((a) => a.stage === 'Concept' && a.ad_delivery_date && a.ad_delivery_date < today && ageDays(a.ad_delivery_date) > 90 && ageDays(a.notion_last_edited_time) > 90);

  const toRow = (t: Task) => ({ code: t.ad_set_code, label: t.task_name, extra: `[${t.status}]`, url: t.url });
  const toRowA = (a: AdSet) => ({ code: a.ad_id_code, label: a.ad_title, extra: `${a.client_code}/${a.stage} del ${a.ad_delivery_date}`, url: a.url });

  console.log(`A. CASCADE-CLOSE (SAFE) — tasks whose every parent is Completed/Cancelled/Archived`);
  console.log(`   → action: Status → 'Archived Task'. Reversal: restore prior status (logged to piper_actions).`);
  console.log(`   COUNT: ${cascadeSafe.length}`);
  console.log(fmt(cascadeSafe.map(toRow)) + '\n');

  console.log(`B. STALE REAPER — past-due tasks untouched >90d (excludes A)`);
  console.log(`   → action: Status → 'Archived Task'. Gate: auto >180d, review 90-180d.`);
  console.log(`   COUNT: ${staleReaper.length}  (of which >180d, highest-confidence: ${staleDeep.length})`);
  console.log(fmt(staleReaper.map(toRow)) + '\n');

  console.log(`C. SHIPPED-LAUNCH CLOSE-OUT (REVIEW — needs Meta reconcile)`);
  console.log(`   → Launch ad sets, delivery >90d ago, 0 open tasks. If not spending 30d → Stage 'Completed'.`);
  console.log(`   COUNT: ${shippedLaunch.length}`);
  console.log(fmt(shippedLaunch.map(toRowA)) + '\n');

  console.log(`D. DEAD CONCEPT AD SETS (REVIEW — human glance)`);
  console.log(`   → Concept ad sets, delivery >90d ago, untouched >90d. Likely abandoned briefs → 'Cancelled'.`);
  console.log(`   COUNT: ${deadConcept.length}`);
  console.log(fmt(deadConcept.map(toRowA)) + '\n');

  console.log(`⚠ ON HOLD — DO NOT CLOSE (paused, may resume). Surfaced for awareness only.`);
  console.log(`   past-due tasks under On-Hold parents: ${onHoldNearTerm.length}`);
  console.log(fmt(onHoldNearTerm.map(toRow)) + '\n');

  console.log(`${'='.repeat(60)}`);
  console.log(`SUMMARY (dry-run, nothing written):`);
  console.log(`  A cascade-close (safe, auto):    ${cascadeSafe.length} tasks`);
  console.log(`  B stale reaper (>180d auto):     ${staleDeep.length} tasks  (+${staleReaper.length - staleDeep.length} for review at 90-180d)`);
  console.log(`  C shipped-Launch (Meta review):  ${shippedLaunch.length} ad sets`);
  console.log(`  D dead Concept (human review):   ${deadConcept.length} ad sets`);
  console.log(`  On Hold (left alone):            ${onHoldNearTerm.length} tasks`);

  if (!apply) { console.log(`\n(dry run — nothing written. Re-run with --apply to action category A.)`); process.exit(0); }

  // ---- APPLY: category A only (cascade-close). Reversible via piper_actions.reverse_action. ----
  const batch = cascadeSafe.slice(0, limit);
  const sessionId = `hygiene-sweep-${randomUUID()}`;
  console.log(`\n${'='.repeat(60)}\nAPPLYING category A: archiving ${batch.length} task(s)${limit < cascadeSafe.length ? ` (--limit ${limit} of ${cascadeSafe.length})` : ''}.`);
  console.log(`session_id=${sessionId} (every write logged to piper_actions with reverse_action)\n`);

  let archived = 0, skipped = 0, failed = 0;
  for (let i = 0; i < batch.length; i++) {
    const r = await archiveTask(batch[i], sessionId);
    if (r === 'archived') archived++; else if (r === 'skipped') skipped++; else failed++;
    if ((i + 1) % 25 === 0 || i === batch.length - 1) console.log(`  ${i + 1}/${batch.length}  (archived ${archived}, skipped ${skipped}, failed ${failed})`);
    await new Promise((res) => setTimeout(res, 320)); // Notion rate-limit courtesy (~3 req/s)
  }
  console.log(`\nDONE. archived=${archived} skipped(already terminal)=${skipped} failed=${failed}`);
  console.log(`Undo: piper_actions rows for session_id=${sessionId} carry reverse_action {set_task_status → prior status}.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error('hygiene-sweep failed:', (err as Error).message);
  process.exit(1);
});
