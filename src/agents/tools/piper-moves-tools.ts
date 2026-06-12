// "My Real Moves" agent tools (master plan 2026-06-09 §3.2-3.3).
//
// get_my_moves       — read the pre-ranked Tier-1 list from the SQL brain
//                      (piper_my_moves / piper_my_moves_all RPCs, bmad Supabase).
// logPipelineCorrection — file a human correction into piper_event_log
//                      (actor='human-correction'), the one narrative log.
//
// The data layer is shared with the deterministic Mon/Wed/Fri channel post
// (src/digest/piper-my-moves.ts) so the tool and the post never disagree.

import { getSupabase } from '../../integrations/supabase.js';
import {
  fetchMyMovesAll,
  fetchMyMovesFor,
  fetchDerivedStateFreshness,
  bucketLabel,
  type MyMoveRow,
} from '../../digest/piper-my-moves.js';
import { insertPiperEvent } from '../piper-event-log.js';

// ---------------------------------------------------------------------------
// Person resolution (against piper_case_file_person)
// ---------------------------------------------------------------------------

interface PersonRow {
  person_id: string;
  display: string | null;
  slack_id: string | null;
}

async function fetchPeople(): Promise<PersonRow[]> {
  const { data, error } = await getSupabase()
    .from('piper_case_file_person')
    .select('person_id, display, slack_id');
  if (error) throw new Error(`piper_case_file_person read failed: ${error.message}`);
  return (data ?? []) as PersonRow[];
}

/**
 * Resolve a person reference to a person_id. Accepts:
 *  - the slug itself ("zyra", case-insensitive)
 *  - a display-name substring ("Zyr", case-insensitive)
 *  - a Slack user ID ("U097RJ2KMEU"), with or without <@…> wrapping
 * Returns { personId } on a unique match, otherwise { error } with guidance.
 */
async function resolvePerson(ref: string): Promise<{ personId?: string; error?: string }> {
  const people = await fetchPeople();
  const raw = ref.trim();
  // Strip Slack mention wrapping: <@U123>, <@U123|name>
  const mention = raw.match(/^<@([A-Z0-9]+)(?:\|[^>]*)?>$/i);
  const needle = (mention?.[1] ?? raw).trim();
  const lower = needle.toLowerCase();

  // 1. Slack ID (exact, case-insensitive)
  const bySlack = people.find((p) => p.slack_id?.toLowerCase() === lower);
  if (bySlack) return { personId: bySlack.person_id };

  // 2. Exact slug
  const bySlug = people.find((p) => p.person_id.toLowerCase() === lower);
  if (bySlug) return { personId: bySlug.person_id };

  // 3. Display-name substring (case-insensitive)
  const byDisplay = people.filter((p) => p.display?.toLowerCase().includes(lower));
  if (byDisplay.length === 1 && byDisplay[0]) return { personId: byDisplay[0].person_id };
  if (byDisplay.length > 1) {
    return {
      error: `Ambiguous person "${ref}" — matches: ${byDisplay
        .map((p) => `${p.display ?? p.person_id} (${p.person_id})`)
        .join(', ')}. Use the slug.`,
    };
  }

  return {
    error: `No person matches "${ref}". Known people: ${people
      .map((p) => p.person_id)
      .sort()
      .join(', ')}.`,
  };
}

// ---------------------------------------------------------------------------
// get_my_moves
// ---------------------------------------------------------------------------

function presentRow(row: MyMoveRow) {
  return {
    rank: row.rank,
    task_id: row.task_id,
    task_name: row.task_name,
    task_url: row.task_url,
    derived_status: row.derived_status,
    notion_blocked: row.notion_blocked ?? false,
    due_date: row.due_date,
    // plan_slip = vs the ORIGINAL plan date (a set-level fact, do not present as
    // personal lateness); days_held = how long it has been actionable with the owner.
    plan_slip_days: row.days_overdue,
    days_held: row.days_held,
    typical_days: row.typical_days,
    days_in_status: row.days_in_status,
    ad_set_code: row.ad_set_code,
    ad_set_url: row.ad_set_url,
    client_code: row.client_code,
    bucket: row.bucket,
    bucket_label: bucketLabel(row.bucket),
    ad_delivery_date: row.ad_delivery_date,
    data_confidence: row.data_confidence,
  };
}

export async function getMyMoves(input: { person?: string }): Promise<string> {
  const freshness = await fetchDerivedStateFreshness();
  const freshnessNote = freshness
    ? `derived state as of ${freshness.toISOString()}`
    : 'derived-state freshness unknown (rendering live RPC output)';

  if (input.person) {
    const resolved = await resolvePerson(input.person);
    if (!resolved.personId) {
      return JSON.stringify({ ok: false, error: resolved.error });
    }
    const rows = await fetchMyMovesFor(resolved.personId);
    return JSON.stringify({
      ok: true,
      person_id: resolved.personId,
      person_display: rows[0]?.person_display ?? null,
      freshness: freshnessNote,
      move_count: rows.length,
      moves: rows.map(presentRow),
      note: 'Rows are pre-ranked by the brain (gate proximity -> due date -> delivery date). Render in this order — do not re-rank. Hyperlink every task and ad-set code via task_url / ad_set_url.',
    });
  }

  // No person → all-people summary counts.
  const rows = await fetchMyMovesAll();
  const byPerson = new Map<string, { person_id: string; display: string | null; moves: number; overdue: number; in_progress: number }>();
  for (const row of rows) {
    let entry = byPerson.get(row.person_id);
    if (!entry) {
      entry = { person_id: row.person_id, display: row.person_display, moves: 0, overdue: 0, in_progress: 0 };
      byPerson.set(row.person_id, entry);
    }
    entry.moves += 1;
    // held 2d+ with the person, NOT plan slip — see presentRow note
    if ((row.days_held ?? 0) >= 2) entry.overdue += 1;
    if (row.derived_status === 'in_progress') entry.in_progress += 1;
  }
  const people = [...byPerson.values()].sort((a, b) => b.overdue - a.overdue || b.moves - a.moves);
  return JSON.stringify({
    ok: true,
    freshness: freshnessNote,
    people_count: people.length,
    total_moves: rows.length,
    people,
    note: 'Summary counts only. Pass { person } to get one person\'s ranked move list.',
  });
}

// ---------------------------------------------------------------------------
// log_pipeline_correction
// ---------------------------------------------------------------------------

export type CorrectionKind = 'not_mine' | 'already_done' | 'blocked_external' | 'other';

export interface LogCorrectionInput {
  task_id?: string;
  ad_set_code?: string;
  kind: CorrectionKind;
  note: string;
  reporter: string;
}

const CORRECTION_KINDS: CorrectionKind[] = ['not_mine', 'already_done', 'blocked_external', 'other'];

export async function logPipelineCorrection(input: LogCorrectionInput): Promise<string> {
  if (!CORRECTION_KINDS.includes(input.kind)) {
    return JSON.stringify({
      ok: false,
      error: `kind must be one of: ${CORRECTION_KINDS.join(', ')}`,
    });
  }
  if (!input.task_id && !input.ad_set_code) {
    return JSON.stringify({
      ok: false,
      error: 'Provide task_id (Notion task page id) or ad_set_code (e.g. "TLx4101") so the correction targets something.',
    });
  }
  if (!input.note?.trim() || !input.reporter?.trim()) {
    return JSON.stringify({ ok: false, error: 'note and reporter are both required.' });
  }

  const targetType = input.task_id ? 'task' : 'ad_set';
  const targetId = input.task_id ?? input.ad_set_code ?? null;

  await insertPiperEvent({
    actor: 'human-correction',
    action: `correction:${input.kind}`,
    targetType,
    targetId,
    why: input.note.trim(),
    channel: 'slack',
    after: { reporter: input.reporter.trim() },
  });

  return JSON.stringify({
    ok: true,
    logged: {
      kind: input.kind,
      target_type: targetType,
      target_id: targetId,
      reporter: input.reporter.trim(),
    },
    note: 'Filed in piper_event_log. Ownership corrections are reviewed in the weekly batch — no Notion write was made.',
  });
}

// ---------------------------------------------------------------------------
// get_recovery_plan — Recovery Quarterback v1 (Dan 2026-06-12)
// docs/piper-recovery-quarterback-plan-2026-06-12.md (bmad repo)
// ---------------------------------------------------------------------------

interface RecoveryPlayRow {
  rank: number;
  client_code: string;
  deficit_per_week: number;
  pct_of_target: number;
  play: string;
  kind: 'drain' | 'refill';
  bottleneck_bucket: string | null;
  volume: number;
  leverage: number;
  est_effort_days: number;
  suggested_owner: string | null;
  owner_display: string | null;
  owner_ratio: number | null;
  alt_owner: string | null;
  alt_display: string | null;
  alt_ratio: number | null;
  contract_note: string | null;
}

export async function getRecoveryPlan(input: { exclude_person?: string }): Promise<string> {
  const { data, error } = await getSupabase().rpc('piper_recovery_plays');
  if (error) return JSON.stringify({ ok: false, error: `piper_recovery_plays failed: ${error.message}` });
  let plays = ((data ?? []) as RecoveryPlayRow[]).map((p) => ({ ...p }));

  // "What if X is unavailable" — swap them out of every suggestion.
  const ex = input.exclude_person?.trim().toLowerCase();
  let constraint: string | null = null;
  if (ex) {
    constraint = `excluding ${input.exclude_person}`;
    for (const p of plays) {
      const isAlt =
        p.alt_owner?.toLowerCase().includes(ex) || p.alt_display?.toLowerCase().includes(ex);
      if (isAlt) {
        p.alt_owner = null;
        p.alt_display = null;
        p.alt_ratio = null;
      }
      const isOwner =
        p.suggested_owner?.toLowerCase().includes(ex) || p.owner_display?.toLowerCase().includes(ex);
      if (isOwner) {
        if (p.alt_owner) {
          p.suggested_owner = p.alt_owner;
          p.owner_display = `${p.alt_display} (stand-in)`;
          p.owner_ratio = p.alt_ratio;
          p.alt_owner = null;
          p.alt_display = null;
          p.alt_ratio = null;
        } else {
          p.owner_display = `NO STAND-IN AVAILABLE (was ${p.owner_display})`;
          p.suggested_owner = null;
        }
      }
    }
  }

  // Sanctioned sums: portfolio debt = one deficit per client (clients carry <=2 plays).
  const perClient = new Map<string, number>();
  for (const p of plays) perClient.set(p.client_code, p.deficit_per_week);
  const debt = [...perClient.values()].reduce((s, d) => s + d, 0);

  const freshness = await fetchDerivedStateFreshness();
  return JSON.stringify({
    ok: true,
    freshness_note: freshness ? `brain as of ${freshness.toISOString()}` : 'freshness unknown',
    constraint,
    summary: {
      behind_contract_clients: perClient.size,
      pipeline_debt_sets_per_week: Math.round(debt * 100) / 100,
    },
    plays,
    rendering_rules:
      'Plays are PROPOSALS for Dan/Vanessa/leads to relay — never address doers directly. ' +
      'Sequence drain plays before refill plays per client. If owner_ratio > 1.5 the suggested ' +
      'owner is overloaded — lead with the alternate. Close with: which plays are approved, ' +
      'and reply with a name if someone is unavailable (re-run with exclude_person).',
  });
}
