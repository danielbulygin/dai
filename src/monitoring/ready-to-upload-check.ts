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
import { getClientCapabilities } from '../agents/tools/ad-launch-tools.js';
import { getSupabase } from '../integrations/supabase.js';
import { getStalePendingBatches, formatStaleBatchSection } from '../agents/launch-state.js';

const ADA_CHANNEL = (env as unknown as Record<string, string | undefined>).ADA_UPLOAD_CHECK_CHANNEL_ID || 'C0AHX94CBF0';
const NINA_USER_ID = (env as unknown as Record<string, string | undefined>).NINA_SLACK_USER_ID || 'U08LEQVHDRU';
const DAN_USER_ID = (env as unknown as Record<string, string | undefined>).SLACK_OWNER_USER_ID || 'U084AS8QRA7';

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

// Row written by the hourly droplet pre-upload worker (scheduler-ada_preupload,
// pma/tools/creative-uploader/preupload_worker.py). It pre-warms Media Library
// upload + AssemblyAI/Gemini analysis for every backlog ad set so the gated
// launch flow starts hot.
interface PreuploadStatus {
  asset_id: string;
  files_total: number;
  analysis_complete: boolean;
  analysis_summary: {
    videos?: number;
    images?: number;
    transcripts_done?: number;
    visuals_done?: number;
  } | null;
  flags: Array<{ type: string; detail?: string; file?: string }>;
}

async function getPreuploadStatuses(codes: string[]): Promise<Map<string, PreuploadStatus>> {
  if (codes.length === 0) return new Map();
  try {
    const { data, error } = await getSupabase()
      .from('ada_preupload_status')
      .select('asset_id, files_total, analysis_complete, analysis_summary, flags')
      .in('asset_id', codes);
    if (error) throw error;
    return new Map(((data ?? []) as PreuploadStatus[]).map((r) => [r.asset_id, r]));
  } catch (err) {
    logger.warn({ err }, 'ready-to-upload: pre-upload status fetch failed; omitting badges');
    return new Map(); // fail-soft: backlog message still posts, just unbadged
  }
}

function preuploadBadge(s: PreuploadStatus | undefined): string {
  if (!s) return '';
  const flagTypes = [...new Set((s.flags ?? []).map((f) => f.type))];
  if (flagTypes.length > 0) {
    return ` — :warning: pre-upload blocked: ${flagTypes.join(', ')}`;
  }
  if (s.analysis_complete) {
    const a = s.analysis_summary ?? {};
    const parts = [
      a.videos ? `${a.videos} video${a.videos === 1 ? '' : 's'}` : null,
      a.images ? `${a.images} static${a.images === 1 ? '' : 's'}` : null,
    ].filter(Boolean);
    return ` — :white_check_mark: pre-warmed (${parts.join(' + ') || `${s.files_total} files`} uploaded + analyzed)`;
  }
  if (s.files_total > 0) {
    return ' — :hourglass_flowing_sand: uploaded, analysis running';
  }
  return '';
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

  const byClient = new Map<string, { code: string | null; entries: Entry[] }>();
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
    if (!byClient.has(client)) byClient.set(client, { code: a?.client_code ?? null, entries: [] });
    byClient.get(client)!.entries.push(entry);
  }

  // Flag config gaps per client so nobody clicks "start" on a client Ada can't launch.
  // See feedback_flag_missing_client_config.
  const codes = [...new Set([...byClient.values()].map((g) => g.code).filter(Boolean))] as string[];
  const capByCode = new Map<string, { launch: boolean; hasConfig: boolean; hasVoiceQc: boolean }>();
  await Promise.all(
    codes.map(async (code) => {
      try {
        const cap = JSON.parse(await getClientCapabilities({ client_code: code })) as {
          launch?: boolean;
          has_meta_config?: boolean;
          has_voice_qc?: boolean;
        };
        capByCode.set(code, { launch: !!cap.launch, hasConfig: !!cap.has_meta_config, hasVoiceQc: !!cap.has_voice_qc });
      } catch {
        /* leave unset → treated as no-config below */
      }
    }),
  );

  // Pre-upload worker state → per-entry badge (✅ pre-warmed / ⏳ analyzing /
  // ⚠️ blocked). Fail-soft: an empty map just means no badges.
  const entryCodes = [...byClient.values()].flatMap((g) =>
    g.entries.map((e) => e.code).filter((c): c is string => !!c),
  );
  const preupload = await getPreuploadStatuses([...new Set(entryCodes)]);

  const sections: string[] = [];
  for (const client of [...byClient.keys()].sort()) {
    const { code, entries } = byClient.get(client)!;
    const cap = code ? capByCode.get(code) : undefined;
    let flag = '';
    if (!code || !cap || !cap.launch) {
      flag = ' — :warning: *no launch config* — needs `/meta-launch-config` before Ada can launch';
    } else if (!cap.hasVoiceQc) {
      flag = ' — :warning: no client-voice QC skill (generic compliance checks only)';
    }
    sections.push(`*${client}*${code ? ` (${code})` : ''}${flag}`);
    for (const e of entries) {
      const label = e.code ? `${e.title} (${e.code})` : e.title;
      const linked = e.url ? `<${e.url}|${label}>` : label; // Slack mrkdwn hyperlink to the Notion page
      const meta = [e.format, e.due ? `due ${e.due}` : null].filter(Boolean).join(' · ');
      const badge = preuploadBadge(e.code ? preupload.get(e.code) : undefined);
      sections.push(`  • ${linked}${meta ? ` — _${meta}_` : ''}${badge}`);
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
  let built: { message: string; count: number } | null = null;
  try {
    built = await buildReadyToUploadMessage(trigger);
  } catch (err) {
    logger.error({ err, trigger }, 'ready-to-upload check: query failed');
    // fall through — the stale-pending backstop below should still post
  }

  // Stale-pending launch batches (fail-soft, posts even when the upload backlog is empty)
  let staleSection: string | null = null;
  try {
    staleSection = formatStaleBatchSection(await getStalePendingBatches(), Date.now());
  } catch (err) {
    logger.warn({ err }, 'ready-to-upload check: stale-pending sweep failed');
  }

  if (!built && !staleSection) {
    logger.info({ trigger }, 'ready-to-upload check: backlog empty — not posting');
    return;
  }

  const text = [built?.message, staleSection].filter(Boolean).join('\n\n');
  try {
    await getDedicatedBotClient('ada').chat.postMessage({ channel: ADA_CHANNEL, text });
    logger.info(
      { trigger, count: built?.count ?? 0, staleBatches: staleSection ? true : false },
      'ready-to-upload check posted to #ada',
    );
  } catch (err) {
    logger.error({ err, channel: ADA_CHANNEL }, 'ready-to-upload check: Slack post failed');
  }
}
