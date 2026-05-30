/**
 * Dry-run validation for the twice-daily Ready-to-Upload check.
 * Calls query_aot_tasks directly (the risky part), mirrors the module's Blocked-exclude
 * filter, and prints a status breakdown + the realistic backlog — no Slack post.
 * Run: npx tsx --env-file=.env scripts/test-ready-to-upload.ts
 */
import { queryAotTasks } from '../src/agents/tools/aot-notion-tools.js';

const raw = await queryAotTasks({ status_group: 'active', task_name_contains: 'upload' });
const parsed = JSON.parse(raw) as {
  error?: string;
  count?: number;
  tasks?: Array<{ task_name: string | null; task_due_date: string | null; status: string | null; format: string | null }>;
};
if (parsed.error) {
  console.error('QUERY ERROR:', parsed.error);
  process.exit(1);
}
const all = parsed.tasks ?? [];
const byStatus: Record<string, number> = {};
for (const t of all) byStatus[t.status ?? '(none)'] = (byStatus[t.status ?? '(none)'] ?? 0) + 1;
const ready = all.filter((t) => t.status !== 'Blocked');
console.log('total active "upload" tasks:', all.length);
console.log('status breakdown:', JSON.stringify(byStatus, null, 2));
console.log('READY (non-Blocked):', ready.length);
console.log(
  'soonest 12 ready:',
  JSON.stringify(
    ready.slice(0, 12).map((t) => ({ name: t.task_name, due: t.task_due_date, status: t.status, format: t.format })),
    null,
    2,
  ),
);
