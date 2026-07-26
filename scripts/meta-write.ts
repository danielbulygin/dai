/**
 * Guarded, self-verifying, self-logging write to a Meta ad account.
 *
 * WHY THIS EXISTS (2026-07-26)
 * ---------------------------
 * Direct Graph API access bypasses the safety layer entirely, so it writes to NO audit
 * trail and gets NO verification. Two failures inside one session proved both halves:
 *
 *   1. I logged the first direct action by hand, then forgot the next five while working.
 *      Anything that depends on remembering eventually does not happen — so here, the
 *      write and its log entry are one action.
 *
 *   2. Adding a campaign `daily_budget` silently set `bid_strategy` to bid cap. It was
 *      caught only because that field happened to be in one read-back. Verifying the
 *      field you changed checks what you thought to ask about, not what happened. Since
 *      bid strategy can NEVER be changed after creation (Dan's rule), missing this on a
 *      real campaign would be unrecoverable. So verification diffs the WHOLE object.
 *
 * Every write here:
 *   - refuses any account other than the practice account
 *   - refuses to set a campaign ACTIVE (the only action that can spend money)
 *   - dry-runs via validate_only first
 *   - snapshots the whole object before and after, then asserts THREE things:
 *       a) every field asked for actually took        (silently-dropped params)
 *       b) no field we did NOT ask for changed        (Meta's unrequested defaults)
 *       c) reports both, and marks the row 'partial' if (a) failed
 *   - logs before/after/reverse through the same logWrite the agents use
 *
 * Docs + the growing test corpus: docs/meta-api-capability-tests.md
 *
 * Usage as a module:
 *   const r = await metaWrite({
 *     target: '120247186199170225', objectType: 'campaign', action: 'rename_campaign',
 *     params: { name: 'new name' }, reason: 'why', reverse: { set_name: 'old name' },
 *   });
 *   if (r.unexpected.length) { ...Meta changed something we did not ask for... }
 */
import { logWrite } from '../src/agents/action-log.js';
import type { ToolContext } from '../src/agents/tool-registry.js';

const API = 'https://graph.facebook.com/v22.0';

/** The ONLY account this module will write to. */
export const PRACTICE_ACCOUNT = 'act_1570076840279279';
export const PRACTICE_CLIENT_CODE = 'AOT';

/**
 * Read-back field sets, deliberately far wider than anything we change — the point is
 * catching what Meta alters without being asked.
 */
const FIELDS: Record<string, string> = {
  campaign:
    'id,name,status,effective_status,objective,buying_type,daily_budget,lifetime_budget,' +
    'bid_strategy,is_adset_budget_sharing_enabled,special_ad_categories,spend_cap,start_time,stop_time',
  adset:
    'id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,bid_amount,' +
    'bid_strategy,billing_event,optimization_goal,promoted_object,targeting,start_time,end_time,' +
    'attribution_spec,destination_type',
  ad: 'id,name,status,effective_status,adset_id,campaign_id,creative,tracking_specs,conversion_domain',
};

/** Fields Meta legitimately recomputes — a change here is not a surprise. */
const DERIVED = new Set(['effective_status', 'updated_time', 'id']);

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface MetaWriteResult {
  ok: boolean;
  id?: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** Every field that changed, requested or not. */
  changes: FieldChange[];
  /** Fields that changed WITHOUT being asked for. Non-empty means read carefully. */
  unexpected: FieldChange[];
  /** Fields we asked for that did not take. Non-empty means the write half-failed. */
  notApplied: FieldChange[];
  error?: unknown;
}

function token(): string {
  const t = process.env.META_ADS_ACCESS_TOKEN;
  if (!t) throw new Error('META_ADS_ACCESS_TOKEN is not set');
  return t;
}

function diffObjects(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): FieldChange[] {
  if (!before || !after) return [];
  const out: FieldChange[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (DERIVED.has(key)) continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      out.push({ field: key, from: before[key] ?? null, to: after[key] ?? null });
    }
  }
  return out;
}

async function readObject(id: string, fields: string): Promise<Record<string, unknown> | null> {
  const r = await fetch(`${API}/${id}?fields=${encodeURIComponent(fields)}&access_token=${token()}`);
  const j = (await r.json()) as Record<string, unknown>;
  return j.error ? null : j;
}

async function isCampaign(id: string): Promise<boolean> {
  const o = await readObject(id, 'objective');
  return o?.objective != null;
}

export interface MetaWriteArgs {
  /** Object id, or an edge like `act_.../campaigns` to create. */
  target: string;
  params: Record<string, string>;
  reason: string;
  objectType?: 'campaign' | 'adset' | 'ad';
  action?: string;
  /** Machine-readable undo, or null when there genuinely is none. */
  reverse?: unknown;
  context?: ToolContext;
  /** Override the read-back field list. Prefer the defaults — they are wide on purpose. */
  readBack?: string;
}

export async function metaWrite(args: MetaWriteArgs): Promise<MetaWriteResult> {
  const { target, params, reason } = args;
  const action = args.action ?? 'write';
  const objectType = args.objectType ?? 'campaign';
  const fields = args.readBack ?? FIELDS[objectType] ?? FIELDS.campaign!;
  const empty = { before: null, after: null, changes: [], unexpected: [], notApplied: [] };

  // --- guard 1: practice account only --------------------------------------
  if (target.startsWith('act_') && !target.startsWith(PRACTICE_ACCOUNT)) {
    throw new Error(`REFUSED: ${target} is not the practice account (${PRACTICE_ACCOUNT})`);
  }

  // --- guard 2: never turn a campaign on -----------------------------------
  // A paused campaign means zero delivery regardless of ad/adset status, so this is the
  // single action in the account that can spend money.
  if (String(params.status ?? '').toUpperCase() === 'ACTIVE') {
    const campaignish =
      action.includes('campaign') ||
      target.includes('/campaigns') ||
      (!target.startsWith('act_') && (await isCampaign(target)));
    if (campaignish) throw new Error('REFUSED: never set a campaign to ACTIVE');
  }

  const form = (extra: Record<string, string> = {}) =>
    new URLSearchParams({ ...params, ...extra, access_token: token() });

  // --- guard 3: dry run before any real write -------------------------------
  const dry = (await (
    await fetch(`${API}/${target}`, {
      method: 'POST',
      body: form({ execution_options: JSON.stringify(['validate_only']) }),
    })
  ).json()) as Record<string, any>;

  if (dry.error) {
    const e = dry.error;
    console.error(`DRY RUN FAILED: ${e.error_user_title ?? e.message}`);
    if (e.error_user_msg) console.error(`  ${e.error_user_msg}`);
    return { ok: false, ...empty, error: dry.error };
  }

  // --- snapshot before ------------------------------------------------------
  const before = target.startsWith('act_') ? null : await readObject(target, fields);

  const res = (await (
    await fetch(`${API}/${target}`, { method: 'POST', body: form() })
  ).json()) as Record<string, any>;

  if (res.error) {
    logWrite({
      context: args.context ?? defaultContext(),
      toolName: `graph_api_direct:${action}`,
      targetSystem: 'meta',
      targetId: target,
      before,
      after: null,
      reverse: null,
      summary: `FAILED: ${String(res.error.message ?? res.error).slice(0, 300)}`,
      status: 'failed',
      clientCode: PRACTICE_CLIENT_CODE,
      reason,
      initiatedBy: 'agency_requested',
    });
    return { ok: false, before, after: null, changes: [], unexpected: [], notApplied: [], error: res.error };
  }

  // --- VERIFY: snapshot after, diff the whole object ------------------------
  const id = String(res.id ?? target);
  const after = await readObject(id, fields);

  const asked = new Set(Object.keys(params));
  const changes = diffObjects(before, after);
  const unexpected = changes.filter((c) => !asked.has(c.field));
  const notApplied: FieldChange[] = [];
  for (const [k, wanted] of Object.entries(params)) {
    if (k === 'special_ad_categories' || k === 'execution_options') continue;
    const got = after?.[k];
    if (got == null || (String(got) !== String(wanted) && JSON.stringify(got) !== String(wanted))) {
      notApplied.push({ field: k, from: wanted, to: got ?? null });
    }
  }

  console.error(`verified ${id}: ${changes.length} field(s) changed`);
  for (const c of changes) {
    console.error(`  ${asked.has(c.field) ? ' ' : '⚠'} ${c.field}: ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
  }
  if (unexpected.length) {
    console.error(`⚠ ${unexpected.length} field(s) changed that were NOT requested:`);
    for (const c of unexpected) console.error(`    ${c.field} -> ${JSON.stringify(c.to)}`);
  }
  if (notApplied.length) {
    console.error(`⚠ ${notApplied.length} requested field(s) did NOT take:`);
    for (const c of notApplied) console.error(`    ${c.field}: wanted ${String(c.from)}, got ${JSON.stringify(c.to)}`);
  }

  logWrite({
    context: args.context ?? defaultContext(),
    toolName: `graph_api_direct:${action}`,
    targetSystem: 'meta',
    targetId: id,
    before,
    after,
    reverse: args.reverse ?? null,
    summary:
      `${action} on ${id}: ${JSON.stringify(params).slice(0, 200)}` +
      ` | verified: ${changes.length} field(s) changed` +
      (unexpected.length
        ? ` | ⚠ UNREQUESTED: ${unexpected.map((c) => `${c.field}=${JSON.stringify(c.to)}`).join(', ')}`
        : '') +
      (notApplied.length ? ` | ⚠ DID NOT TAKE: ${notApplied.map((c) => c.field).join(', ')}` : ''),
    status: notApplied.length ? 'partial' : 'success',
    clientCode: PRACTICE_CLIENT_CODE,
    reason,
    initiatedBy: 'agency_requested',
  });

  return { ok: true, id, before, after, changes, unexpected, notApplied };
}

function defaultContext(): ToolContext {
  return {
    // Honest attribution: this is NOT Ada. She has no campaign create/modify ability at
    // all, and this path does not pass through her guard.
    agentId: 'claude-code-session',
    channelId: 'terminal',
    userId: 'daniel',
  };
}

/** Pre-flight the standing safety rule: every campaign off, and no recent spend. */
export async function preflight(): Promise<{ ok: boolean; detail: string }> {
  const t = token();
  const camps = (await (
    await fetch(`${API}/${PRACTICE_ACCOUNT}/campaigns?fields=id,name,status&limit=200&access_token=${t}`)
  ).json()) as { data?: Array<{ name: string; status: string }> };
  const live = (camps.data ?? []).filter((c) => c.status !== 'PAUSED');

  const ins = (await (
    await fetch(`${API}/${PRACTICE_ACCOUNT}/insights?date_preset=last_7d&fields=spend&access_token=${t}`)
  ).json()) as { data?: Array<{ spend?: string }> };
  const spend = (ins.data ?? []).reduce((s, r) => s + Number(r.spend ?? 0), 0);

  if (live.length || spend > 0) {
    return {
      ok: false,
      detail:
        `STOP. ${live.length} campaign(s) not paused` +
        `${live.length ? ` (${live.map((c) => c.name).join(', ')})` : ''}` +
        `, 7-day spend ${spend}. Tell Daniel rather than proceeding.`,
    };
  }
  return { ok: true, detail: `${(camps.data ?? []).length} campaigns, all paused, zero 7-day spend.` };
}
