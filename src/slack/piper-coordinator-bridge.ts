/** Explicit reviewer entry into the durable Piper worker; no model or creator sender. */
import { getSupabase } from '../integrations/supabase.js';
import type { WebClient } from '@slack/web-api';

type Command = {
  command: 'review' | 'status' | 'approve' | 'correct' | 'help';
  clientCode: string | null; adSetCode: string | null; referenceId: string | null; text: string | null;
};
export const isPiperPilotCommand = (text: string): boolean => /^\s*pilot(?:\s|$)/i.test(text);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export function parsePiperPilotCommand(text: string): Command | null {
  if (/^pilot\s+help$/i.test(text.trim())) return { command: 'help', clientCode: null, adSetCode: null, referenceId: null, text: null };
  const review = text.trim().match(/^pilot\s+review\s+([A-Za-z][A-Za-z0-9_-]{0,39})\s+([A-Za-z]+[xX]\d{1,12})(?:\s+([\s\S]+))?$/i);
  if (review) return { command: 'review', clientCode: review[1]!.toUpperCase(),
    adSetCode: review[2]!.replace(/^([A-Za-z]+?)[xX](\d+)$/, (_, prefix: string, digits: string) => `${prefix.toUpperCase()}x${digits}`),
    referenceId: null, text: review[3]?.trim() ?? null };
  const referenced = text.trim().match(new RegExp(`^pilot\\s+(status|approve|correct)\\s+(${UUID})(?:\\s+([\\s\\S]+))?$`, 'i'));
  if (!referenced) return null;
  const command = referenced[1]!.toLowerCase() as 'status' | 'approve' | 'correct';
  const body = referenced[3]?.trim() ?? null;
  if (command === 'correct' ? !body : body !== null) return null;
  if (body && body.length > 4000) return null;
  return { command, clientCode: null, adSetCode: null, referenceId: referenced[2]!.toLowerCase(), text: body };
}

type Rpc = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
interface BridgeOptions {
  client: WebClient; text: string; userId: string; channel: string; messageTs: string;
  threadTs?: string; source?: string;
}
interface BridgeDependencies { rpc?: Rpc; pilotId?: string | null }
interface Reply {
  status: 'queued' | 'status' | 'reviewed' | 'corrected' | 'help'; pilot_id?: string;
  job_id?: string; job?: { id: string; status: string; stale?: boolean; result?: { model_summary?: string }; last_error?: { code?: string } };
  proposals?: Array<{ id: string; kind: string; object_id: string; object_version: string; status?: string; proposal: { message?: string } }>;
  review?: { decision?: string }; correction?: { event_id?: number };
}
const identifier = (value: unknown): value is string => typeof value === 'string' && new RegExp(`^${UUID}$`, 'i').test(value);
const plain = (value: unknown, max = 1200): string => typeof value === 'string'
  ? value.slice(0, max).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, max) : '';

export function renderPiperPilotReply(value: unknown): string {
  const reply = value as Reply | null;
  if (reply?.status === 'help') return 'Piper pilot commands:\npilot review CLIENT ADSET [request]\npilot status JOB_UUID\npilot approve PROPOSAL_UUID\npilot correct JOB_UUID correction details\nStart and select a bounded pilot at https://bmad-lac.vercel.app/pipeline/pilot. Drafts are for reviewer inspection; these commands send no creator messages and change no tasks.';
  if (!reply || !['queued', 'status', 'reviewed', 'corrected'].includes(reply.status) || !identifier(reply.pilot_id)) {
    throw new Error('PIPER_BRIDGE_INVALID_RESPONSE');
  }
  if (reply.status === 'queued' || reply.status === 'corrected') {
    if (reply.status === 'corrected' && reply.job_id == null && (reply as Reply & { job_not_queued?: string }).job_not_queued === 'budget_exhausted'
        && typeof reply.correction?.event_id === 'number') {
      return 'Correction recorded; case held. Pilot attempt budget exhausted, so no new review was queued. No creator action was sent.';
    }
    if (!identifier(reply.job_id)) throw new Error('PIPER_BRIDGE_INVALID_RESPONSE');
    return `${reply.status === 'corrected' ? 'Correction recorded; this case is held for human review. Reconciliation queued.' : 'Case review queued for the persistent Piper worker.'}\nJob: ${reply.job_id}\nUse “pilot status ${reply.job_id}” to read its draft. No creator action was sent.`;
  }
  if (reply.status === 'reviewed') {
    if (reply.review?.decision !== 'accept') throw new Error('PIPER_BRIDGE_INVALID_RESPONSE');
    return 'Marked draft accepted for review; no message sent or task changed.';
  }
  if (!identifier(reply.job?.id) || !['pending', 'running', 'completed', 'failed', 'cancelled'].includes(reply.job?.status ?? '')) {
    throw new Error('PIPER_BRIDGE_INVALID_RESPONSE');
  }
  const lines = [`Piper pilot job ${reply.job!.id}: ${reply.job!.status}.`];
  if (reply.job!.stale === true) {
    lines.push('This historical draft was superseded by newer evidence or corrections.');
    const historical = plain(reply.job!.result?.model_summary, 1000);
    if (historical) lines.push(`Historical summary: ${historical}`);
    lines.push('Request a fresh case review in /pipeline/pilot. No creator action was sent.');
    return lines.join('\n');
  }
  if (reply.job!.status === 'completed') {
    lines.push('Draft for reviewer inspection. No creator action was sent.');
    const summary = plain(reply.job!.result?.model_summary, 1000);
    if (summary) lines.push(summary);
    const current = (reply.proposals ?? []).filter(proposal => proposal.status !== 'superseded');
    for (const proposal of current.slice(0, 3)) {
      if (!identifier(proposal.id)) throw new Error('PIPER_BRIDGE_INVALID_RESPONSE');
      lines.push(`Draft ${proposal.id}: ${plain(proposal.kind, 40)} · ${plain(proposal.object_id, 100)} @ ${plain(proposal.object_version, 80)}`, plain(proposal.proposal?.message, 400));
    }
    if (current.length > 3) lines.push('Additional drafts are available in /pipeline/pilot.');
    lines.push(`Review: “pilot approve PROPOSAL_UUID” or “pilot correct ${reply.job!.id} correction details”.`);
  } else if (reply.job!.status === 'failed') lines.push(`Worker could not complete this review${reply.job!.last_error?.code ? ` (${plain(reply.job!.last_error.code, 80)})` : ''}. Check /pipeline/pilot.`);
  return lines.join('\n');
}

/** Returns true for reserved commands even on refusal: they must never fall into the legacy model. */
export async function tryPiperPilotCommand(opts: BridgeOptions, deps: BridgeDependencies = {}): Promise<boolean> {
  if (!isPiperPilotCommand(opts.text)) return false;
  if (opts.source === 'agent-mention' || !/^[UW][A-Z0-9]+$/.test(opts.userId)
      || !/^[CDG][A-Z0-9]+$/.test(opts.channel) || !/^\d+\.\d+$/.test(opts.messageTs)
      || (opts.threadTs !== undefined && !/^\d+\.\d+$/.test(opts.threadTs))) return true;
  const parsed = parsePiperPilotCommand(opts.text);
  const command: Command = parsed && (parsed.text?.length ?? 0) <= 4000 ? parsed
    : { command: 'help', clientCode: null, adSetCode: null, referenceId: null, text: null };
  // auth.test identifies the authenticated bot workspace. Reviewer identity comes
  // only from the authenticated Bolt event's user, never a name in message text.
  const auth = await opts.client.auth.test();
  if (auth.ok !== true || !auth.team_id || !/^T[A-Z0-9]+$/.test(auth.team_id)) return true;
  const rpc = deps.rpc ?? ((name, args) => getSupabase().rpc(name, args));
  const { data, error } = await rpc('piper_coordinator_slack_command', {
    p_command: command.command, p_slack_user_id: opts.userId, p_team_id: auth.team_id,
    p_channel_id: opts.channel, p_message_ts: opts.messageTs, p_thread_ts: opts.threadTs ?? opts.messageTs,
    p_ad_set_code: command.adSetCode, p_client_code: command.clientCode,
    p_reference_id: command.referenceId, p_text: command.text, p_pilot_id: deps.pilotId ?? null,
  });
  // Failure gives no authority to send, and never falls back into the model.
  // The server RPC checks exact reviewer/team/channel, finite pilot, case and
  // current source/rule versions before returning any source-bound draft.
  const code = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  if (error && code !== 'PIPER_PILOT_REQUIRED') return true;
  const response = error ? 'Start a bounded pilot at https://bmad-lac.vercel.app/pipeline/pilot (Mikel or Daniel can select cases).'
    : renderPiperPilotReply(data);
  const receipt = await opts.client.chat.postMessage({ channel: opts.channel, thread_ts: opts.threadTs ?? opts.messageTs,
    text: response, mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false });
  if (receipt.ok !== true || !receipt.ts || receipt.channel !== opts.channel) throw new Error('PIPER_BRIDGE_DELIVERY_UNCONFIRMED');
  return true;
}
