/**
 * Twice-daily "Ready to Upload" check (10:00 + 17:00 Europe/Berlin).
 *
 * Queries the AOT Tasks DB for "Upload and Configure" tasks that aren't Done/
 * Cancelled/Archived, and if the backlog is non-empty, posts to #ada tagging Dan +
 * Nina so they can kick off the gated launch flow right there in-thread.
 *
 * Posts AS Ada (same dedicated-bot client the morning briefing uses). Silent when the
 * backlog is empty — no noise.
 */

import { getDedicatedBotClient } from '../slack/dedicated-bots.js';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import { queryAotTasks } from '../agents/tools/aot-notion-tools.js';

// #ada channel. Overridable via env; defaults to the live #ada channel id.
const ADA_CHANNEL = (env as Record<string, string | undefined>).ADA_UPLOAD_CHECK_CHANNEL_ID || 'C0AHX94CBF0';
const NINA_USER_ID = (env as Record<string, string | undefined>).NINA_SLACK_USER_ID || 'U08LEQVHDRU';
const DAN_USER_ID = (env as Record<string, string | undefined>).SLACK_OWNER_USER_ID || 'U084AS8QRA7';

interface AotTask {
  task_id: string;
  task_name: string | null;
  status: string | null;
  task_due_date: string | null;
  format: string | null;
}

/** Build the backlog message (exported for dry-run testing). Returns null if empty. */
export async function buildReadyToUploadMessage(
  trigger: 'morning' | 'evening',
): Promise<{ message: string; count: number } | null> {
  const raw = await queryAotTasks({
    status_group: 'active',
    task_name_contains: 'upload',
  });
  const parsed = JSON.parse(raw) as { tasks?: AotTask[]; error?: string };
  if (parsed.error) {
    throw new Error(`query_aot_tasks error: ${parsed.error}`);
  }
  // The canonical "Ready to Upload" Notion view excludes Blocked (status_group:'active'
  // already drops Done/Cancelled/Archived/Complete). Mirror that here.
  const tasks = (parsed.tasks ?? []).filter((t) => t.status !== 'Blocked');
  if (tasks.length === 0) return null;

  // Tasks come sorted by due date ascending. Cap the displayed list and state the
  // overflow explicitly — never silently truncate.
  const MAX_SHOWN = 15;
  const shown = tasks.slice(0, MAX_SHOWN);
  const lines = shown.map((t) => {
    const due = t.task_due_date ? ` _(due ${t.task_due_date})_` : '';
    const fmt = t.format ? ` · ${t.format}` : '';
    return `  • ${t.task_name ?? '(untitled task)'}${fmt}${due}`;
  });
  if (tasks.length > MAX_SHOWN) {
    lines.push(`  • …and ${tasks.length - MAX_SHOWN} more — see the *Ready to Upload* view in Notion`);
  }

  const header =
    `<@${DAN_USER_ID}> <@${NINA_USER_ID}> — *${tasks.length} ad set${tasks.length === 1 ? '' : 's'} ready to upload* ` +
    `(${trigger} check)`;
  const footer =
    `\n\nReply in this thread to start one and I'll walk the gates — ` +
    `scan → upload → analysis → QC → preview → confirm → launch (paused) → verify. ` +
    `E.g. _"Ada, run the upload for <task>"_.`;
  return { message: `${header}\n${lines.join('\n')}${footer}`, count: tasks.length };
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
    await getDedicatedBotClient('ada').chat.postMessage({
      channel: ADA_CHANNEL,
      text: built.message,
    });
    logger.info({ trigger, count: built.count }, 'ready-to-upload check posted to #ada');
  } catch (err) {
    logger.error({ err, channel: ADA_CHANNEL }, 'ready-to-upload check: Slack post failed');
  }
}
