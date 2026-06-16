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
import { queryAotTasks, getAotAdSetsByIds, getClientNameMap } from '../agents/tools/aot-notion-tools.js';
import { getClientCapabilities } from '../agents/tools/ad-launch-tools.js';
import { getSupabase } from '../integrations/supabase.js';
import { getStalePendingBatches, formatStaleBatchSection } from '../agents/launch-state.js';
import { getAgentState, setAgentState } from '../memory/agent-state.js';
import { createSession } from '../memory/sessions.js';

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
  client_relation_ids: string[];
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

// ---------------------------------------------------------------------------
// Digest state — the digest diffs against its own last post so it reports
// deltas instead of re-listing the same backlog verbatim twice a day.
// (JVAx3864 was re-listed 20+ times over 3 weeks; SLBx4068's upload_error
// repeated for 7 days with no detail and no escalation.)
// ---------------------------------------------------------------------------

const DIGEST_STATE_KEY = 'ready_to_upload_digest';
const ESCALATE_AFTER_DAYS = 7;

interface DigestItemState {
  first_seen: string; // ISO date
  flag_sig: string;
  escalated: boolean;
}
interface DigestState {
  items: Record<string, DigestItemState>;
  last_signature: string;
  last_posted_at: string;
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

function flagSignature(s: PreuploadStatus | undefined): string {
  if (!s) return '';
  const types = [...new Set((s.flags ?? []).map((f) => f.type))].sort();
  return `${types.join(',')}|${s.analysis_complete ? 'ok' : 'pending'}`;
}

function preuploadBadge(s: PreuploadStatus | undefined): string {
  if (!s) return '';
  const flags = s.flags ?? [];
  if (flags.length > 0) {
    // Show the actual error detail, not just the flag type — "upload_error"
    // alone gives the reader nothing to act on.
    const first = flags[0]!;
    const detail = [first.file, first.detail].filter(Boolean).join(': ');
    const flagTypes = [...new Set(flags.map((f) => f.type))];
    return ` — :warning: pre-upload blocked: ${flagTypes.join(', ')}${detail ? ` (${detail.slice(0, 120)})` : ''}`;
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

  // Resolve parent ad sets by id (scale-proof). We fetch ONLY the backlog's
  // parents, not a globally-capped/oldest-sorted slice — `queryAotAdSets({ limit })`
  // silently drops the backlog once the Ad Sets DB grows past the cap, which broke
  // client resolution on 2026-06-05 (2396 ad sets vs a 1000-row delivery_date_asc
  // fetch → every task fell back to "(unknown client)" with no title/code/link).
  // Note: task.ad_set_id is the human ad-id code (rollup), NOT a page id — only
  // ad_set_relation_ids are page ids, so we join on those.
  const adsetById = new Map<string, AotAdSet>();
  try {
    const parentIds = [...new Set(tasks.flatMap((t) => t.ad_set_relation_ids).filter(Boolean))];
    const resolved = await getAotAdSetsByIds(parentIds);
    for (const [id, a] of resolved) {
      adsetById.set(id, {
        ad_set_id: a.ad_set_id,
        url: a.url,
        ad_title: a.ad_title,
        ad_id_code: a.ad_id_code,
        client_code: a.client_code,
        client_relation_ids: a.client_relation_ids,
      });
    }
  } catch (err) {
    logger.warn({ err }, 'ready-to-upload: ad-set resolve failed; falling back to task client + names');
  }
  const adsetFor = (t: AotTask): AotAdSet | undefined =>
    t.ad_set_relation_ids.map((id) => adsetById.get(id)).find(Boolean);

  // Resolve client relation IDs → readable names ("Forpeople") for grouping.
  // Gather from BOTH the task's own Client relation (always present) and the
  // resolved ad set — so grouping survives even if an ad-set retrieve fails.
  const clientRelIds = new Set<string>();
  for (const t of tasks) {
    for (const id of t.client_relation_ids ?? []) clientRelIds.add(id);
    for (const id of adsetFor(t)?.client_relation_ids ?? []) clientRelIds.add(id);
  }
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
      t.client_relation_ids.map((id) => nameMap.get(id)).find(Boolean) ??
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
    const grp = byClient.get(client)!;
    // The launch-config flag keys off `code`. Don't let it depend on iteration
    // order: if the first task's ad set didn't resolve a code but a later one
    // does, adopt it — otherwise a launchable client can be mis-flagged as
    // "no launch config" when only its first entry's retrieve came back thin.
    if (!grp.code && a?.client_code) grp.code = a.client_code;
    grp.entries.push(entry);
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

  // ------ digest state: diff against what we said last time --------------
  const prior = (await getAgentState<DigestState>(DIGEST_STATE_KEY)) ?? {
    items: {},
    last_signature: '',
    last_posted_at: '',
  };
  const today = new Date().toISOString().slice(0, 10);
  const nextItems: Record<string, DigestItemState> = {};
  const newKeys = new Set<string>();
  const escalations: string[] = [];

  const entryKey = (client: string, e: Entry): string => e.code ?? `${client}:${e.title}`;

  for (const [client, grp] of byClient) {
    for (const e of grp.entries) {
      const key = entryKey(client, e);
      const sig = flagSignature(e.code ? preupload.get(e.code) : undefined);
      const prev = prior.items[key];
      if (!prev) newKeys.add(key);
      nextItems[key] = {
        first_seen: prev?.first_seen ?? today,
        flag_sig: sig,
        escalated: prev?.escalated ?? false,
      };
    }
  }

  const resolvedKeys = Object.keys(prior.items).filter((k) => !(k in nextItems));

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
      const key = entryKey(client, e);
      const state = nextItems[key]!;
      const age = daysSince(state.first_seen);
      const label = e.code ? `${e.title} (${e.code})` : e.title;
      const linked = e.url ? `<${e.url}|${label}>` : label; // Slack mrkdwn hyperlink to the Notion page
      const meta = [e.format, e.due ? `due ${e.due}` : null].filter(Boolean).join(' · ');
      const badge = preuploadBadge(e.code ? preupload.get(e.code) : undefined);
      const newBadge = newKeys.has(key) ? ' :new:' : '';
      const ageNote = !newKeys.has(key) && age >= 3 ? ` — _listed ${age}d_` : '';
      sections.push(`  • ${linked}${meta ? ` — _${meta}_` : ''}${badge}${newBadge}${ageNote}`);

      // One-time escalation for long-stuck items: after this they keep their
      // age note but never re-escalate.
      if (age >= ESCALATE_AFTER_DAYS && !state.escalated) {
        state.escalated = true;
        escalations.push(
          `• ${linked} has been on this list for *${age} days*` +
            (state.flag_sig.startsWith('|') || state.flag_sig === ''
              ? ' with no blocker recorded — if it is actually waiting on something (e.g. a question, a client decision), set its Notion task to Blocked so it drops off this digest.'
              : ` — blocker: ${state.flag_sig.split('|')[0]}. It will not resolve itself; someone needs to act or Block the task.`),
        );
      }
    }
  }

  // ------ unchanged? post a one-liner instead of the full list ------------
  const signature = Object.entries(nextItems)
    .map(([k, v]) => `${k}=${v.flag_sig}`)
    .sort()
    .join(';');
  const unchanged =
    signature === prior.last_signature && resolvedKeys.length === 0 && escalations.length === 0;

  await setAgentState(DIGEST_STATE_KEY, {
    items: nextItems,
    last_signature: signature,
    last_posted_at: new Date().toISOString(),
  } satisfies DigestState);

  if (unchanged) {
    const oldest = Math.max(...Object.values(nextItems).map((i) => daysSince(i.first_seen)), 0);
    return {
      message:
        `Ready-to-upload backlog unchanged since the last check: *${tasks.length} item${tasks.length === 1 ? '' : 's'}*` +
        `${oldest >= 3 ? ` (oldest listed ${oldest}d)` : ''}. Nothing new to act on — full list in the previous digest.`,
      count: tasks.length,
    };
  }

  // Ping people only when there's something genuinely new to act on —
  // unchanged-and-aging backlogs don't deserve a notification.
  const shouldPing = newKeys.size > 0 || escalations.length > 0;
  const delta = [
    newKeys.size > 0 ? `${newKeys.size} new` : null,
    resolvedKeys.length > 0 ? `${resolvedKeys.length} cleared since last check` : null,
  ]
    .filter(Boolean)
    .join(', ');
  const header =
    `${shouldPing ? `<@${DAN_USER_ID}> <@${NINA_USER_ID}> — ` : ''}` +
    `*${tasks.length} ad set${tasks.length === 1 ? '' : 's'} ready to upload* ` +
    `(${trigger} check${delta ? ` — ${delta}` : ''})`;
  const escalationSection =
    escalations.length > 0 ? `\n\n:alarm_clock: *Needs a human decision*\n${escalations.join('\n')}` : '';
  const resolvedSection =
    resolvedKeys.length > 0
      ? `\n\n:white_check_mark: Cleared since last check: ${resolvedKeys.map((k) => k.split(':').pop()).join(', ')}`
      : '';
  const footer =
    `\n\nReply in this thread to start one and I'll walk the gates — ` +
    `scan → upload → analysis → QC → preview → confirm → launch (paused) → verify. ` +
    `E.g. _"Ada, run the upload for <ad set>"_.`;
  return {
    message: `${header}\n\n${sections.join('\n')}${escalationSection}${resolvedSection}${footer}`,
    count: tasks.length,
  };
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
    const posted = await getDedicatedBotClient('ada').chat.postMessage({ channel: ADA_CHANNEL, text });
    // Register the digest thread as an Ada-owned session so a PLAIN in-thread reply
    // ("Ada, run the upload for X") is recognized by the channel thread-reply listener,
    // which gates on findThreadOwner() (sessions.status='active'). The digest is posted
    // by this scheduled job — not via handleDedicatedBotMessage — so without this its
    // thread is untracked and replies are silently dropped unless the user explicitly
    // @-mentions Ada. Caught 2026-06-16: Nina replied in-thread for Teethlovers exactly
    // as the digest instructed and nothing fired. This survives a dai restart (DB-backed).
    const digestTs = posted?.ts as string | undefined;
    if (digestTs) {
      try {
        await createSession({ agent_id: 'ada', channel_id: ADA_CHANNEL, thread_ts: digestTs, user_id: 'system' });
      } catch (sessErr) {
        logger.warn(
          { err: sessErr, threadTs: digestTs },
          'ready-to-upload check: failed to register digest thread — in-thread replies may not trigger Ada',
        );
      }
    }
    logger.info(
      { trigger, count: built?.count ?? 0, staleBatches: staleSection ? true : false, threadTs: digestTs },
      'ready-to-upload check posted to #ada',
    );
  } catch (err) {
    logger.error({ err, channel: ADA_CHANNEL }, 'ready-to-upload check: Slack post failed');
  }
}
