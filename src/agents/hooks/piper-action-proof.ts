import { detectExtraClaims, detectFabricatedTranscript, detectLaunchClaim } from './launch-claim-guard.js';
import type { ExecutedToolCall } from './launch-claim-guard.js';

export interface PiperToolEvidence extends ExecutedToolCall {
  input?: Record<string, unknown>;
  result?: string;
}

function payload(result?: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(result ?? '');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return; }
}

/** The returned failure remains visible to the model as an actual tool error. */
export function piperToolFailed(result: string): boolean {
  const value = payload(result);
  return value?.ok === false || value?.verified === false || Boolean(value?.error);
}

export function toolEvidenceForAgent(agentId: string, name: string, isError: boolean, input: Record<string, unknown>, result: string): PiperToolEvidence {
  return agentId === 'piper'
    ? { name, isError: isError || piperToolFailed(result), input, result }
    : { name, isError };
}

export function agentTextCallback(agentId: string, callback?: (text: string) => void): ((text: string) => void) | undefined {
  return agentId === 'piper' ? undefined : callback;
}

const NOTION_WRITES = new Set(['update_aot_task_status', 'update_aot_task_due_date', 'update_aot_ad_set_stage', 'create_aot_task']);
const SLACK_WRITES = new Set(['post_message', 'reply_in_thread', 'send_as_daniel']);
const ACTIONS = new Set([...NOTION_WRITES, ...SLACK_WRITES, 'log_pipeline_correction']);
const sameId = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.replace(/-/g, '').toLowerCase() === b.replace(/-/g, '').toLowerCase();
const safe = (value: unknown) => String(value ?? 'unknown').replace(/[<>&\n\r]/g, ' ').slice(0, 180);

function receipt(call: PiperToolEvidence): { verified: boolean; line: string } {
  const result = payload(call.result);
  const input = call.input ?? {};
  const objectId = result?.task_id ?? result?.ad_set_id ?? input.task_id ?? input.ad_set_id;
  let verified = !call.isError && !!result && result.ok === true && !piperToolFailed(call.result ?? '');
  let detail = '';
  if (NOTION_WRITES.has(call.name)) {
    verified &&= result?.verified === true && typeof objectId === 'string';
    if (input.task_id !== undefined) verified &&= sameId(input.task_id, result?.task_id);
    if (input.ad_set_id !== undefined && call.name !== 'create_aot_task') verified &&= sameId(input.ad_set_id, result?.ad_set_id);
    if (input.new_status !== undefined) verified &&= input.new_status === result?.after;
    if (input.new_stage !== undefined) verified &&= input.new_stage === result?.after;
    if (input.new_due_date !== undefined) verified &&= input.new_due_date === result?.after;
    // Future versioned adapters cannot borrow a receipt from another version.
    if (input.version_id !== undefined) verified &&= input.version_id === result?.version_id;
    const requestedId = input.task_id ?? (call.name === 'create_aot_task' ? undefined : input.ad_set_id);
    detail = `object ${safe(objectId)}${requestedId !== undefined && !sameId(requestedId, objectId) ? `; requested object ${safe(requestedId)}` : ''}${result?.after !== undefined ? `; ${verified ? 'confirmed' : 'returned'} value ${safe(result.after)}` : ''}${result?.version_id !== undefined ? `; version ${safe(result.version_id)}` : ''}`;
  } else if (SLACK_WRITES.has(call.name)) {
    verified &&= typeof result?.ts === 'string' && result.ts.length > 0;
    if (result?.channel !== undefined) verified &&= result.channel === input.channel;
    detail = `channel ${safe(input.channel)}; message ${safe(result?.ts)}`;
  } else {
    const logged = result?.logged as Record<string, unknown> | undefined;
    verified &&= !!logged && logged.target_id === (input.task_id ?? input.ad_set_code) && logged.kind === input.kind;
    detail = `correction target ${safe(logged?.target_id ?? input.task_id ?? input.ad_set_code)}; event logged only, no Notion change`;
  }
  return {
    verified,
    line: `${verified ? 'Verified' : 'Unresolved'} ${call.name}: ${detail}${!verified ? '; no completion receipt' : ''}.`,
  };
}

/**
 * Completion prose is replaced by exact adapter receipts rather than guessed
 * prose/object matching. One successful task can never attest to four tasks.
 * This conservative boundary is intentionally Piper-only in the runner.
 */
export function guardPiperActionResponse(response: string, calls: PiperToolEvidence[]): string {
  const actions = calls.filter(call => ACTIONS.has(call.name));
  const claims = detectExtraClaims(response).length > 0 || detectLaunchClaim(response) || detectFabricatedTranscript(response)
    || /^\s*(all\s+)?done[.!\s—-]/i.test(response) || /^\s*(all\s+)?done\s*$/i.test(response);
  if (actions.length === 0 && !claims) return response;
  const receipts = actions.map(receipt);
  const verified = receipts.filter(r => r.verified).length;
  return [
    `Action verification: ${verified} verified, ${receipts.length - verified} unresolved.`,
    ...receipts.map(r => r.line),
    ...(claims && receipts.length === 0 ? ['No exact action receipt was returned. Completion is unconfirmed; check the target before retrying.'] : []),
    ...(receipts.some(r => !r.verified) ? ['Unresolved operations may have been partly applied. Reconcile their current state before retrying.'] : []),
  ].join('\n');
}
