/**
 * Twice-daily "Ready to Upload" check (10:00 + 17:00 Europe/Berlin).
 *
 * Queries the AOT Tasks DB for "Upload and Configure" tasks that aren't Done/
 * Cancelled/Archived/Blocked, resolves each task's parent ad set (for the human
 * title, ad-id code, client, and Notion page link — the task row itself only carries
 * the generic "Upload and Configure Campaign"), and if the backlog is non-empty posts
 * to #ada grouped by client, tagging Dan + Nina so the gated flow can be kicked off
 * in-thread. Posts AS Ada. Silent when the backlog is empty.
 */

import { getDedicatedBotClient } from '../slack/dedicated-bots.js';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import { queryAotTasks, queryAotAdSets, getClientNameMap } from '../agents/tools/aot-notion-tools.js';

const ADA_CHANNEL = (env as Record<string, string | undefined>).ADA_UPLOAD_CHECK_CHANNEL_ID || 'C0AHX94CBF0';
const NINA_USER_ID = (env as Record<string, string | undefined>).NINA_SLACK_USER_ID || 'U08LEQVHDRU';
const DAN_USER_ID = (env as Record<string, string | undefined>).SLACK_OWNER_USER_ID || 'U084AS8QRA7';

interface AotTask {
  task_id: string;
  task_name: string | null;
  status: string | null;
  task_due_date: string | null;
  format: string | null;
  ad_set_id: string | null;
  ad_set_relation_ids: string[];
}
interface AotAdSet {
  ad_set_id: string;
  url: string;
  ad_title: string | null;
  ad_id_code: string | null;
  client_code: string | null;
  client_relation_ids: string[];
}
interface Entry {
  title: string;
  code: string | null;
  url: string | null;
  due: string | null;
  format: string | null;
}

/** Build the grouped backlog message (exported for dry-run + manual-trigger reuse). Null if empty. */
export async function buildReadyToUploadMessage(
  trigger: 'morning' | 'evening',
): Promise<{ message: string; count: number } | null> {
  const rawTasks = await queryAotTasks({ status_group: 'active', task_name_contains: 'upload' });
  const tasksParsed = JSON.parse(rawTasks) as { tasks?: AotTask[]; error?: string };
  if (tasksParsed.error) throw new Error(`query_aot_tasks error: ${tasksParsed.error}`);
  // Canonical "Ready to Upload" view excludes Blocked (active group already drops
  // Done/Cancelled/Archived/Complete).
  const tasks = (tasksParsed.tasks ?? []).filter((t) => t.status !== 'Blocked');
  if (tasks.length === 0) return null;

  // Resolve parent ad sets (best-effort — fall back to task name if unavailable).
  const adsetById = new Map<string, AotAdSet>();
  try {
    const rawAdsets = await queryAotAdSets({ limit: 1000 });
    const adsetsParsed = JSON.parse(rawAdsets) as { adsets?: AotAdSet[] };
    for (const a of adsetsParsed.adsets ?? []) adsetById.set(a.ad_set_id, a);
  } catch (err) {
    logger.warn({ err }, 'ready-to-upload: ad-set resolve failed; falling back to task names');
  }
  const adsetFor = (t: AotTask): AotAdSet | undefined =>
    (t.ad_set_id ? adsetById.get(t.ad_set_id) : undefined) ??
    t.ad_set_relation_ids.map((id) => adsetById.get(id)).find(Boolean);

  // Resolve client relation IDs → readable names ("Forpeople") for grouping.
  const clientRelIds = new Set<string>();
  for (const t of tasks) for (const id of adsetFor(t)?.client_relation_ids ?? []) clientRelIds.add(id);
  let nameMap = new Map<string, string>();
  try {
    nameMap = await getClientNameMap([...clientRelIds]);
  } catch (err) {
    logger.warn({ err }, 'ready-to-upload: client name resolve failed; using client codes');
  }

  const byClient = new Map<string, Entry[]>();
  for (const t of tasks) {
    const a = adsetFor(t);
    const client =
      a?.client_relation_ids.map((id) => nameMap.get(id)).find(Boolean) ??
      a?.client_code ??
      '(unknown client)';
    const entry: Entry = {
      title: a?.ad_title ?? t.task_name ?? '(untitled)',
      code: a?.ad_id_code ?? null,
      url: a?.url ?? null,
      due: t.task_due_date,
      format: t.format ?? null,
    };
    if (!byClient.has(client)) byClient.set(client, []);
    byClient.get(client)!.push(entry);
  }

  const sections: string[] = [];
  for (const client of [...byClient.keys()].sort()) {
    sections.push(`*${client}*`);
    for (const e of byClient.get(client)!) {
      const label = e.code ? `${e.title} (${e.code})` : e.title;
      const linked = e.url ? `<${e.url}|${label}>` : label; // Slack mrkdwn hyperlink to the Notion page
      const meta = [e.format, e.due ? `due ${e.due}` : null].filter(Boolean).join(' · ');
      sections.push(`  • ${linked}${meta ? ` — _${meta}_` : ''}`);
    }
  }

  const header =
    `<@${DAN_USER_ID}> <@${NINA_USER_ID}> — *${tasks.length} ad set${tasks.length === 1 ? '' : 's'} ready to upload* ` +
    `(${trigger} check)`;
  const footer =
    `\n\nReply in this thread to start one and I'll walk the gates — ` +
    `scan → upload → analysis → QC → preview → confirm → launch (paused) → verify. ` +
    `E.g. _"Ada, run the upload for <ad set>"_.`;
  return { message: `${header}\n\n${sections.join('\n')}${footer}`, count: tasks.length };
}

export async function runReadyToUploadCheck(trigger: 'morning' | 'evening'): Promise<void> {
  let built: { message: string; count: number } | null;
  try {
    built = await buildReadyToUploadMessage(trigger);
  } catch (err) {
    logger.error({ err, trigger }, 'ready-to-upload check: query failed');
    return;
  }
  if (!built) {
    logger.info({ trigger }, 'ready-to-upload check: backlog empty — not posting');
    return;
  }
  try {
    await getDedicatedBotClient('ada').chat.postMessage({ channel: ADA_CHANNEL, text: built.message });
    logger.info({ trigger, count: built.count }, 'ready-to-upload check posted to #ada');
  } catch (err) {
    logger.error({ err, channel: ADA_CHANNEL }, 'ready-to-upload check: Slack post failed');
  }
}
