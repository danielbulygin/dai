/**
 * One-off manual trigger for the Ready-to-Upload check — posts the backlog to #ada
 * AS Ada (via ADA_BOT_TOKEN), labeled as a manual test so it's distinguishable from
 * the scheduled 10:00/17:00 runs. Self-contained (mirrors ready-to-upload-check.ts).
 * Run on the droplet: npx tsx --env-file=.env scripts/fire-ready-to-upload.ts
 */
import { WebClient } from '@slack/web-api';
import { queryAotTasks } from '../src/agents/tools/aot-notion-tools.js';

const NINA = 'U08LEQVHDRU';
const DAN = 'U084AS8QRA7';
const CHANNEL = 'C0AHX94CBF0';

const raw = await queryAotTasks({ status_group: 'active', task_name_contains: 'upload' });
const parsed = JSON.parse(raw) as {
  error?: string;
  tasks?: Array<{ task_name: string | null; task_due_date: string | null; status: string | null; format: string | null }>;
};
if (parsed.error) {
  console.error('query error:', parsed.error);
  process.exit(1);
}
const tasks = (parsed.tasks ?? []).filter((t) => t.status !== 'Blocked');
if (tasks.length === 0) {
  console.log('backlog empty — nothing to post');
  process.exit(0);
}
const MAX = 15;
const lines = tasks.slice(0, MAX).map((t) => {
  const due = t.task_due_date ? ` _(due ${t.task_due_date})_` : '';
  const fmt = t.format ? ` · ${t.format}` : '';
  return `  • ${t.task_name ?? '(untitled task)'}${fmt}${due}`;
});
if (tasks.length > MAX) lines.push(`  • …and ${tasks.length - MAX} more — see the *Ready to Upload* view in Notion`);

const message =
  `:test_tube: _(manual test of the twice-daily check)_\n` +
  `<@${DAN}> <@${NINA}> — *${tasks.length} ad set${tasks.length === 1 ? '' : 's'} ready to upload*\n` +
  `${lines.join('\n')}\n\n` +
  `Reply in this thread to start one and I'll walk the gates — ` +
  `scan → upload → analysis → QC → preview → confirm → launch (paused) → verify. ` +
  `E.g. _"Ada, run the upload for <task>"_.`;

const token = process.env.ADA_BOT_TOKEN;
if (!token) {
  console.error('ADA_BOT_TOKEN not set');
  process.exit(1);
}
const res = await new WebClient(token).chat.postMessage({ channel: CHANNEL, text: message });
console.log('posted ok=', res.ok, 'ts=', res.ts);
