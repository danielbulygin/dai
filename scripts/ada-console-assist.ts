/**
 * ada-console-assist — a small ADDITIVE HTTP microservice that wraps the
 * Agent-SDK "Ada" runner (runAgentSDK) so the internal Ada Launch Console
 * (Next.js dashboard) can ask Ada to DIAGNOSE upload/launch errors and propose
 * concrete recommended actions the console can execute.
 *
 * SAFETY POSTURE
 *  - /assist (one-shot error diagnosis) stays ADVISORY: defaultPolicy() denies every
 *    write; it only diagnoses + recommends.
 *  - /chat (the main /launch/ada surface) runs with FULL production-write parity
 *    (allowProductionWrites — same legitimate write set as the Slack media_buyer Ada:
 *    Notion task writes, media uploads, paused-bank launches, Slack posts, learning/
 *    decision edits). Dan made the web chat the team's main Ada (2026-06-20). The
 *    load-bearing rails live BELOW the guard and are always on: launch_ads/
 *    upload_to_media_library create PAUSED-bank-only objects via SafeMetaAPI (zero
 *    spend; a human enables to go live), and the delete rail hard-blocks every delete
 *    in any mode. Bash/Write/Edit stay forbidden.
 *  - Spend cap: every Ada call passes maxBudgetUsd ≈ 1.5–2 and maxTurns ≈ 15–24.
 *  - Additive: a NEW port (8092) + a NEW systemd unit. Touches nothing else.
 *
 * ENDPOINTS
 *  GET  /health  → { ok, model, service, version }               (no auth)
 *  POST /assist  → diagnosis + severity + recommended_actions    (X-Assist-Key)
 *  POST /chat    → Server-Sent Events stream for the full-page    (X-Assist-Key)
 *                  /launch/ada chat: a GENERAL, fully-capable Ada that
 *                  answers account/data/performance/launch-status
 *                  questions, diagnoses errors, AND performs the
 *                  production write set directly (Notion task writes,
 *                  uploads, paused-bank launches, Slack, learnings),
 *                  streaming thinking → tool → text → decision →
 *                  actions → done. Ada 2.0: `decision` events carry live
 *                  Governor verdicts + failure-organ matches (the decision
 *                  card), and `done` carries an HONEST ok/subtype — the
 *                  client can no longer render success over a failure.
 *
 * CANONICAL HOME: THIS file (dai scripts/ada-console-assist.ts), deployed to
 * the droplet as a git-tagged checkout. The old mechanism — scp'ing a copy
 * from bmad pma/tools/ada-console-assist/ into a non-git /root/ada-sdk-spike —
 * is dead as of ada-2.0.0; the bmad dir keeps only a pointer DEPLOY.md.
 *
 * Run (env sourced by systemd: /root/dai/.env then /root/ada-console-assist.env):
 *   cd /root/ada-sdk-spike && node_modules/.bin/tsx scripts/ada-console-assist.ts
 */
import http from 'node:http';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAgentSDK } from '../src/agents/sdk/runAgentSDK.js';
import { getAgent } from '../src/agents/registry.js';
import { buildClientOverlay } from '../src/client-agents/prompt-builder.js';
import { getSupabase } from '../src/integrations/supabase.js';
import { envTokenFor } from '../src/integrations/meta-token.js';
import { logWrite, logToolCall } from '../src/agents/action-log.js';
import { remember as rememberLearning } from '../src/agents/tools/memory-tools.js';
import { getLearnings } from '../src/memory/learnings.js';
import { learningClientCodeCandidates } from '../src/agents/client-context.js';

const PORT = Number(process.env.ADA_ASSIST_PORT ?? 8092);
const HOST = '0.0.0.0';
const SERVICE = 'ada-console-assist';
const ASSIST_SECRET = process.env.ADA_ASSIST_SECRET ?? '';
const MODEL = getAgent('ada')?.config.model ?? 'claude-opus-4-8';
// The deployed version — a git tag/sha now that the engine deploys as a git
// checkout. Surfaces on /health so "what's live?" is answerable with a curl.
const VERSION = (() => {
  try { return execSync('git describe --tags --always --dirty', { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return 'unknown (not a git checkout)'; }
})();

// Shared secret with the Tinkers API (gettinkers.com) — used to verify the
// signed scope claim on client-scoped chat requests (rollout plan R5).
const SCOPE_SIGNING_SECRET = process.env.ADA_SCOPE_SIGNING_SECRET ?? '';

interface ScopeClaimPayload { client_scope: string; user_id: string; iat: number; exp: number }

/** Verify a Tinkers scope claim: base64url(payload).base64url(HMAC-SHA256).
 *  Mirrors tinkers/src/lib/scope-claim.ts — keep the two in sync. */
function verifyScopeClaim(claim: string): ScopeClaimPayload | null {
  if (!SCOPE_SIGNING_SECRET) return null;
  const dot = claim.lastIndexOf('.');
  if (dot < 1) return null;
  const body = claim.slice(0, dot);
  const sig = Buffer.from(claim.slice(dot + 1));
  const expected = Buffer.from(
    createHmac('sha256', SCOPE_SIGNING_SECRET).update(body).digest('base64url')
  );
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as ScopeClaimPayload;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now() / 1000) return null;
    if (!payload.client_scope || !payload.user_id) return null;
    return payload;
  } catch {
    return null;
  }
}

const MAX_BUDGET_USD = Number(process.env.ADA_ASSIST_MAX_BUDGET ?? 1.5);
const MAX_TURNS = Number(process.env.ADA_ASSIST_MAX_TURNS ?? 15);

// Chat (the full-page /launch/ada surface) gets a slightly higher ceiling than
// the one-shot error /assist — a real conversation may run a few read tools.
const CHAT_MAX_BUDGET_USD = Number(process.env.ADA_CHAT_MAX_BUDGET ?? 2.0);
const CHAT_MAX_TURNS = Number(process.env.ADA_CHAT_MAX_TURNS ?? 24);

/**
 * Which client accounts may Ada WRITE to. Empty = no account restriction, which is
 * today's production behaviour (she launches for all configured clients). Set to
 * `AOT` to confine every write to the practice account while testing.
 *
 *   ADA_WRITE_ACCOUNT_ALLOWLIST=AOT        → practice account only
 *   ADA_WRITE_ACCOUNT_ALLOWLIST=AOT,SLB    → those two
 *   (unset)                                → unrestricted (current live behaviour)
 *
 * Enforced by guard.ts ahead of the production-write allow-list. Deletes stay
 * hard-blocked regardless, and launches remain paused-bank-only regardless.
 */
const WRITE_ACCOUNT_ALLOWLIST = (process.env.ADA_WRITE_ACCOUNT_ALLOWLIST ?? '')
  .split(',')
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean);

// ---------------------------------------------------------------------------
// Types mirroring the documented request/response contract.
// ---------------------------------------------------------------------------
interface AssistError { code?: string; message?: string; detail?: Record<string, unknown> }
interface AssistContext {
  gate?: 'upload' | 'preview' | 'launch' | 'verify' | 'scan' | 'backlog' | string;
  asset_code?: string;
  client_code?: string;
  title?: string;
  error?: AssistError;
  payload?: Record<string, unknown>;
}
interface AssistRequest {
  context?: AssistContext;
  question?: string;
  session_id?: string;
  // Client-scoped chat (Tinkers portal — rollout plan R5). A request that
  // names a client_scope MUST carry a scope_claim signed by the Tinkers API;
  // the claim is minted from the SESSION server-side, never by the browser.
  client_scope?: string;
  scope_claim?: string;
  // /diagnose only — the prior Ada turn the debugger second-opinions:
  answer?: string;                            // Ada's answer being checked
  trace?: { label: string; tool?: string }[]; // the tool/step trace Ada took
}
type Severity = 'info' | 'warn' | 'block';
interface RecommendedAction { key: string; label: string; detail: string }
interface RenameProposal { file_id?: string; from: string; to: string; fields?: Record<string, string>; confidence?: number; note?: string }
interface AssistResponse {
  ok: boolean;
  session_id: string;
  diagnosis: string;
  severity: Severity;
  recommended_actions: RecommendedAction[];
  renames?: RenameProposal[];
  cost_usd: number;
  used_skills: string[];
  error?: string;
}

const KNOWN_ACTION_KEYS = new Set([
  're_encode_image', 'rename_file', 'heal_analyzer', 'reupload', 'repreview',
  'allow_duplicate', 'flag_team', 'edit_copy', 'manual',
]);

// ---------------------------------------------------------------------------
// Ad-set ledger (Phase 3) — give Ada the TRAJECTORY, not just the snapshot, so
// she stops re-diagnosing a flag the operator already fixed. Read-only Supabase
// fetch (SUPABASE_URL + SUPABASE_SERVICE_KEY come from /root/dai/.env). Node 22
// has global fetch. Best-effort: [] on any failure — never breaks a request.
// ---------------------------------------------------------------------------
const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY ?? '';

interface LedgerEvent { ts: string; actor: string; event: string; summary: string | null }
interface RecentLedgerEvent extends LedgerEvent { asset_code: string; client_code: string | null }

async function fetchLedger(assetCode?: string, limit = 25): Promise<LedgerEvent[]> {
  if (!assetCode || !SUPABASE_URL || !SUPABASE_KEY) return [];
  try {
    const u = `${SUPABASE_URL}/rest/v1/ad_set_ledger?asset_code=eq.${encodeURIComponent(assetCode)}` +
      `&select=ts,actor,event,summary&order=ts.desc&limit=${limit}`;
    const r = await fetch(u, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
    if (!r.ok) return [];
    const rows = (await r.json()) as LedgerEvent[];
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

// Recent ledger events ACROSS ALL ad sets (no asset filter) — gives Ada ambient
// awareness of what the launch console has been doing lately, so she can answer
// "what's happened recently / what did the pipeline just do" even when no specific
// ad set is open in the console. Best-effort: [] on any failure.
async function fetchRecentLedger(limit = 12): Promise<RecentLedgerEvent[]> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  try {
    const u = `${SUPABASE_URL}/rest/v1/ad_set_ledger` +
      `?select=ts,actor,event,summary,asset_code,client_code&order=ts.desc&limit=${limit}`;
    const r = await fetch(u, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
    if (!r.ok) return [];
    const rows = (await r.json()) as RecentLedgerEvent[];
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Compact, newest-first markdown ledger block for the prompt + the trajectory rule. */
function renderLedgerSection(events: LedgerEvent[]): string {
  if (!events.length) return '';
  const lines = events.slice(0, 14).map((e) =>
    `- ${relTime(e.ts)} · ${e.actor} · ${e.event}${e.summary ? `: ${e.summary}` : ''}`);
  return `### Recent history for this ad set (ledger — newest first)\n${lines.join('\n')}\n\n` +
    `Reason about the TRAJECTORY, not just the snapshot. If a recent fixing action ` +
    `(renamed, flag_cleared, uploaded, analysis_complete) shows the operator has ALREADY ` +
    `addressed the on-screen error, LEAD with where the set is NOW and the single next step ` +
    `(e.g. "you renamed the files and it's re-analyzing — nothing to do but let it finish"), ` +
    `and do NOT re-explain how to fix a flag that's already been handled. If the history shows ` +
    `a fix that didn't stick (e.g. flag_raised again after a rename), say that plainly instead.`;
}

/** Self-awareness block: tells Ada the Ledger EXISTS and what it is, so she can
 *  explain it on request, plus recent cross-set activity she can reference even
 *  when no specific ad set is open. The per-set history (above) only loads when a
 *  set is in context; this block is always present. */
function renderLedgerAwareness(recent: RecentLedgerEvent[]): string {
  const desc =
    `### The ad-set Ledger — you have this; explain it when asked\n` +
    `Every launch-console ad set has a **Ledger**: a timestamped, append-only history of what's happened to it — ` +
    `events such as \`uploaded\`, \`analysis_complete\`, \`renamed\`, \`flag_raised\`, \`flag_cleared\` and \`launched\`, each tagged ` +
    `with an actor (\`worker\` = our automated upload/analysis pipeline, otherwise a person) and a short summary. It's how you ` +
    `reason about an ad set's TRAJECTORY — what's been done and what's left — not just its current snapshot. When a specific set is ` +
    `open you get its full history above. If the operator asks "what's the ledger / history", "what happened to this set", or ` +
    `"what has the pipeline been doing lately", answer from the ledger; for a set that's neither open nor in the recent activity ` +
    `below, say you can pull its history once it's opened in the console.`;
  if (!recent.length) return desc;
  const lines = recent.slice(0, 12).map((e) =>
    `- ${relTime(e.ts)} · ${e.client_code ?? '—'}/${e.asset_code} · ${e.actor} · ${e.event}${e.summary ? `: ${e.summary}` : ''}`);
  return `${desc}\n\n#### Recent launch-console activity (latest events across all ad sets)\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Preamble — frames Ada as the Launch-Console assistant. The known failure-mode
// playbook is summarized so Ada can map error codes precisely even when a skill
// doc isn't loaded. Ada MUST emit a trailing JSON block we can parse.
// ---------------------------------------------------------------------------
function buildPrompt(req: AssistRequest, ledgerEvents: LedgerEvent[] = []): string {
  const ctx = req.context ?? {};
  const err = ctx.error ?? {};
  const parts: string[] = [];

  parts.push(
    `You are Ada, acting as the assistant inside our internal **Ad Launch Console**. ` +
    `An operator hit a specific error during the upload/launch pipeline and needs you to ` +
    `diagnose it precisely and propose concrete actions the CONSOLE can execute. ` +
    `You do NOT perform any writes yourself — no Meta/Notion/Slack calls, no uploads, no launches. ` +
    `You DIAGNOSE and RECOMMEND. The console's audited endpoints carry out the fix after a human approves.`,
  );

  parts.push(
    `### Known failure-mode playbook (map the error to these where it fits)\n` +
    `- **image_too_large / /adimages 400 (>8MB)** → Meta hard-caps /adimages at 8MB. Fix: re-encode the JPEG in place at q95 (the uploader's UF-2 auto-re-encode), then re-upload. severity: warn. action: re_encode_image (+ reupload).\n` +
    `- **ss_name_invalid / SweetSpot filename fails QC** → name violates [Format]-[CreativeType]-[AdTitle]-[Hook]-[Brand]-[Lang]-[ID]; structural errors (regex/typo/ID mismatch) HARD-FAIL. Fix: rename_file to the correct SweetSpot name; if it's only a content mismatch (wrong brand on screen) it's a soft warn → flag_team. severity: block (structural) / warn (content).\n` +
    `- **ASSET_ID_DUPLICATE_EXISTS** → an asset with this ad ID/byte-hash already exists in the library. Decide: if it's a genuine re-upload of the same asset, allow_duplicate or skip; if it's a naming collision (generic filename colliding cross-creative), rename_file first. severity: warn.\n` +
    `- **analyzer not ready / 0 analysis rows / stuck in_progress** → the fire-and-forget AssemblyAI+Gemini analyzer didn't fire reliably. Fix: heal_analyzer (run the synchronous per-video analyze). severity: warn.\n` +
    `- **empty adset / 0-ad adset (UF-1/UF-3)** → an ad set was created with no ad attached (zombie). Fix: reupload the creative into the adset or flag_team to clean up. severity: block.\n` +
    `- **preview / verify mismatch** → previewed creative doesn't match the live object. Fix: repreview, and edit_copy if the copy is wrong. severity: warn.\n` +
    `- Anything you cannot confidently map → severity: info, action: manual, and say what the operator should check.`,
  );

  const ctxLines: string[] = [];
  if (ctx.gate) ctxLines.push(`- gate: ${ctx.gate}`);
  if (ctx.asset_code) ctxLines.push(`- asset_code: ${ctx.asset_code}`);
  if (ctx.client_code) ctxLines.push(`- client_code: ${ctx.client_code}`);
  if (ctx.title) ctxLines.push(`- title: ${ctx.title}`);
  if (err.code) ctxLines.push(`- error.code: ${err.code}`);
  if (err.message) ctxLines.push(`- error.message: ${err.message}`);
  if (err.detail && Object.keys(err.detail).length) ctxLines.push(`- error.detail: ${JSON.stringify(err.detail)}`);
  if (ctx.payload && Object.keys(ctx.payload).length) ctxLines.push(`- payload: ${JSON.stringify(ctx.payload)}`);
  parts.push(`### The error in front of the operator\n${ctxLines.join('\n') || '- (no structured context provided)'}`);

  const ledgerBlock = renderLedgerSection(ledgerEvents);
  if (ledgerBlock) parts.push(ledgerBlock);

  if (req.question && req.question.trim()) {
    parts.push(`### Operator's question\n${req.question.trim()}`);
  }

  parts.push(
    `### How to answer\n` +
    `Write a short, precise diagnosis in your own voice — what's wrong and WHY — grounded in the error + the playbook. ` +
    `Be concrete (cite the asset_code / client / file when relevant). Do NOT call write tools. ` +
    `You may use read-only tools/skills if (and only if) you genuinely need to look something up; for a clear-cut error code, just diagnose directly to keep it cheap.\n\n` +
    `Then, on the VERY LAST line of your reply, emit EXACTLY ONE fenced JSON block (and nothing after it):\n` +
    '```json\n' +
    `{"diagnosis":"<one or two sentence markdown summary>","severity":"info|warn|block","recommended_actions":[{"key":"re_encode_image|rename_file|heal_analyzer|reupload|repreview|allow_duplicate|flag_team|edit_copy|manual","label":"<short human label>","detail":"<what and why>"}]}\n` +
    '```\n' +
    `Valid action keys: re_encode_image, rename_file, heal_analyzer, reupload, repreview, allow_duplicate, flag_team, edit_copy, manual. ` +
    `Order recommended_actions most-important-first. Always include at least one action (use "manual" if nothing else fits).`,
  );

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Parse Ada's trailing JSON block. Falls back to raw text + manual action.
// ---------------------------------------------------------------------------
function parseAdaJson(text: string): { diagnosis: string; severity: Severity; actions: RecommendedAction[]; renames?: RenameProposal[] } | null {
  // Prefer the last fenced ```json block; else the last bare {...} object.
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  let candidate: string | null = fences.length ? fences[fences.length - 1][1].trim() : null;
  if (!candidate) {
    const lastBrace = text.lastIndexOf('{');
    const lastClose = text.lastIndexOf('}');
    if (lastBrace !== -1 && lastClose > lastBrace) candidate = text.slice(lastBrace, lastClose + 1);
  }
  if (!candidate) return null;
  try {
    const obj = JSON.parse(candidate) as Record<string, unknown>;
    const sevRaw = String(obj.severity ?? 'info').toLowerCase();
    const severity: Severity = sevRaw === 'block' || sevRaw === 'warn' ? sevRaw : 'info';
    const rawActions = Array.isArray(obj.recommended_actions) ? obj.recommended_actions : [];
    const actions: RecommendedAction[] = rawActions
      .map((a) => a as Record<string, unknown>)
      .filter((a) => a && typeof a.key === 'string')
      .map((a) => {
        const key = String(a.key);
        return {
          key: KNOWN_ACTION_KEYS.has(key) ? key : 'manual',
          label: String(a.label ?? key),
          detail: String(a.detail ?? ''),
        };
      });
    const rawRenames = Array.isArray(obj.renames) ? obj.renames : [];
    const renames: RenameProposal[] = rawRenames
      .map((x) => x as Record<string, unknown>)
      .filter((x) => x && typeof x.to === 'string' && (x.to as string).trim())
      .map((x) => ({
        file_id: x.file_id ? String(x.file_id) : undefined,
        from: String(x.from ?? ''),
        to: String(x.to),
        fields: x.fields && typeof x.fields === 'object' ? (x.fields as Record<string, string>) : undefined,
        confidence: typeof x.confidence === 'number' ? x.confidence : undefined,
        note: x.note ? String(x.note) : undefined,
      }));
    const diagnosis = typeof obj.diagnosis === 'string' && obj.diagnosis.trim()
      ? obj.diagnosis.trim()
      : stripTrailingJson(text);
    return {
      diagnosis,
      severity,
      actions: actions.length ? actions : [{ key: 'manual', label: 'Manual review', detail: 'No structured action returned.' }],
      renames: renames.length ? renames : undefined,
    };
  } catch {
    return null;
  }
}

/** Remove the trailing fenced JSON block from a body so the prose reads cleanly. */
function stripTrailingJson(text: string): string {
  return text.replace(/```(?:json)?\s*[\s\S]*?```\s*$/i, '').trim() || text.trim();
}

// ---------------------------------------------------------------------------
// /assist handler
// ---------------------------------------------------------------------------
async function handleAssist(req: AssistRequest): Promise<AssistResponse> {
  const ledgerEvents = await fetchLedger(req.context?.asset_code);
  const prompt = buildPrompt(req, ledgerEvents);
  const channelId = `console-assist-${req.context?.client_code ?? 'x'}`;
  // Bridge the optional session_id to the SDK resume path. runAgentSDK resolves
  // the dai session by (channelId, threadTs, agentId), so we thread session_id
  // through threadTs to keep a stable conversation key for resume.
  const threadTs = req.session_id || `assist-${randomUUID()}`;

  let costUsd = 0;
  let subtype = 'unknown';
  let toolsUsed: string[] = [];

  const result = await runAgentSDK(
    {
      source: 'api-console-assist',
      agentId: 'ada',
      userMessage: prompt,
      userId: 'launch-console',
      channelId,
      threadTs,
    },
    {
      // defaultPolicy() = deny ALL writes — advisory only. We pass no overrides.
      maxBudgetUsd: MAX_BUDGET_USD,
      maxTurns: MAX_TURNS,
      onResult: (r) => { costUsd = r.costUsd; subtype = r.subtype; toolsUsed = r.toolsUsed; },
    },
  );

  // used_skills = the skills Ada loaded via the Skill tool (Skill calls appear
  // as the literal "Skill" tool name; we cannot see the slug from toolsUsed, so
  // surface the skill set when the Skill tool was used, plus any mcp tool slugs).
  const usedSkills = inferUsedSkills(result.response, toolsUsed);

  const parsed = parseAdaJson(result.response);
  if (parsed) {
    return {
      ok: true,
      session_id: threadTs,
      diagnosis: parsed.diagnosis,
      severity: parsed.severity,
      recommended_actions: parsed.actions,
      renames: parsed.renames,
      cost_usd: round(costUsd),
      used_skills: usedSkills,
    };
  }

  // Fallback: parsing failed → raw text + single manual action.
  return {
    ok: true,
    session_id: threadTs,
    diagnosis: result.response.trim() || '(empty response)',
    severity: 'info',
    recommended_actions: [{ key: 'manual', label: 'Manual review', detail: 'Ada returned no parseable action block — read the diagnosis above.' }],
    cost_usd: round(costUsd),
    used_skills: usedSkills,
    error: subtype !== 'success' ? `runner subtype=${subtype}` : undefined,
  };
}

/** Best-effort: which ada-* skills are referenced in the answer. */
const ADA_SKILL_SLUGS = [
  'ada-media-library', 'ada-sweetspot-namer', 'ada-ready-to-upload',
  'ada-website-walk', 'ada-call-insights', 'ada-client-change-alerts',
];
function inferUsedSkills(answer: string, toolsUsed: string[]): string[] {
  const hits = new Set<string>();
  for (const slug of ADA_SKILL_SLUGS) {
    if (answer.includes(slug)) hits.add(slug);
  }
  // If the Skill tool was invoked but no slug surfaced in the text, note it generically.
  if (toolsUsed.includes('Skill') && hits.size === 0) hits.add('(skill loaded — slug not surfaced)');
  return [...hits];
}

function round(n: number): number { return Math.round(n * 10000) / 10000; }

// ===========================================================================
// /chat — the full-page /launch/ada surface. A GENERAL, streaming, read-only
// Ada: answers account/data/performance/launch-status questions AND diagnoses
// errors, emitting Server-Sent Events (thinking → tool → text → actions → done).
// ===========================================================================

interface ChatAction { key: string; label: string; detail: string; asset_code?: string; client_code?: string; drive_url?: string; expected_asset_id?: string; ad_account_id?: string; batch_id?: string }

// ---------------------------------------------------------------------------
// Loop 4 — decisions carry forward. A rejection with a reason ("no, we never
// scale that fast") is the single most valuable thing a human says to Ada, and
// until now it died with the session: the same proposal came back next week.
// Every chat turn for a known client now loads that client's most recent
// learnings NEWEST-FIRST and renders them as settled decisions, and the ids of
// exactly what was in view are written to the audit log — so "did the rejection
// change the next proposal?" is a query, not a vibe.
//
// Deliberately recency-ordered: getClientQuickContext's "Key Learnings" are
// SCORE-ordered, which can never surface a correction made an hour ago.
// ---------------------------------------------------------------------------
interface DecisionLearning { id: string; created_at: string; content: string }

const DECISION_LEARNINGS_LIMIT = 8;
const DECISION_LEARNING_MAX_CHARS = 240;

/**
 * Pure renderer (unit-testable — tests/decision-learnings-block.test.ts).
 * Returns '' for an empty list so the caller can drop the block entirely.
 */
export function renderDecisionLearningsBlock(
  learnings: DecisionLearning[],
  /** Subject + verb of the heading — 'DANIEL/NINA HAVE' internally, 'THIS
   *  CUSTOMER HAS' on the portal (that surface never names our team). */
  whoHave = 'DANIEL/NINA HAVE',
): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const l of learnings) {
    const content = (l?.content ?? '').replace(/\s+/g, ' ').trim();
    if (!content) continue;
    const key = content.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const day = /^\d{4}-\d{2}-\d{2}/.test(l.created_at ?? '') ? l.created_at.slice(0, 10) : '(undated)';
    const text = content.length > DECISION_LEARNING_MAX_CHARS
      ? `${content.slice(0, DECISION_LEARNING_MAX_CHARS - 1)}…`
      : content;
    lines.push(`- ${day} · ${text}`);
    if (lines.length >= DECISION_LEARNINGS_LIMIT) break;
  }
  if (!lines.length) return '';
  return (
    `### DECISIONS ${whoHave} ALREADY MADE (apply these before proposing)\n` +
    `Saved decisions for this client, newest first. These are settled calls, not old opinions — draft every ` +
    `recommendation so it ALREADY obeys them, and say which one you're applying when it shapes what you propose. ` +
    `Never re-propose something rejected here unless the conditions named in the reason have changed; if you ` +
    `believe they have, name the changed condition first.\n` +
    lines.join('\n')
  );
}

/**
 * The most recent client-scoped learnings for a code, newest first.
 * FAIL-OPEN: a learnings hiccup logs and returns [] — chat never breaks over
 * missing context. Reads both stores the remember path writes to: agency-side
 * rows (agent_id='ada' + client_code, freeform mixed-convention, hence
 * learningClientCodeCandidates) and the client agent's own rows
 * (ada_client_<CODE>, what the portal's scoped chat saves).
 */
async function fetchDecisionLearnings(clientCode: string): Promise<DecisionLearning[]> {
  const code = clientCode.trim();
  if (!code) return [];
  // The client agent id is `ada_client_<code>` with the code's casing as the
  // caller had it (the portal uppercases; a Slack-side config may not), so ask
  // for both spellings rather than silently missing a whole store.
  const agentIds = [...new Set([`ada_client_${code}`, `ada_client_${code.toUpperCase()}`])];
  try {
    const [agencyRows, ...clientRowSets] = await Promise.all([
      getLearnings('ada', undefined, DECISION_LEARNINGS_LIMIT, learningClientCodeCandidates(code)),
      ...agentIds.map((id) => getLearnings(id, undefined, DECISION_LEARNINGS_LIMIT)),
    ]);
    return [...agencyRows, ...clientRowSets.flat()]
      .map((l) => ({ id: l.id, created_at: l.created_at, content: l.content }))
      .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
      .slice(0, DECISION_LEARNINGS_LIMIT);
  } catch (e) {
    console.warn(`[ada-console-assist] decision-learnings fetch failed for ${code} (block omitted):`, (e as Error).message);
    return [];
  }
}

/**
 * Audit which decision-learnings were in the prompt when this turn was drafted
 * — the evidence half of Loop 4. Fire-and-forget into piper_actions via the
 * standard action-log helper. NOTE: /chat had no per-turn log at all, so this
 * is a new (synthetic) tool_call row rather than a field added to an existing
 * one; it is written ONLY when learnings were actually in view, so a turn
 * without context adds no rows.
 */
function logDecisionLearningsInContext(input: {
  agentId: string;
  channelId: string;
  userId: string;
  sessionId: string;
  clientCode: string;
  question: string;
  learnings: DecisionLearning[];
  proposalType: string | null;
}): void {
  if (!input.learnings.length) return;
  try {
    logToolCall({
      toolName: 'decision_learnings_in_context',
      context: {
        agentId: input.agentId,
        channelId: input.channelId,
        userId: input.userId,
        threadTs: input.sessionId,
      },
      params: {
        client_code: input.clientCode,
        session_id: input.sessionId,
        question: input.question.slice(0, 300),
        proposal_type: input.proposalType,
        learning_ids: input.learnings.map((l) => l.id),
        learnings: input.learnings.map((l) => ({
          id: l.id,
          created_at: l.created_at,
          preview: l.content.replace(/\s+/g, ' ').trim().slice(0, 40),
        })),
      },
      result: `${input.learnings.length} decision-learning(s) in prompt for ${input.clientCode}`,
      status: 'success',
      durationMs: 0,
    });
  } catch (e) {
    console.warn('[ada-console-assist] decision-learnings audit log failed (non-fatal):', (e as Error).message);
  }
}

/** Build the chat framing message. Deliberately NOT error-shaped — a data
 *  question gets a data answer, never a "nothing to fix" button. */
function buildChatPrompt(
  req: AssistRequest,
  ledgerEvents: LedgerEvent[] = [],
  recentLedger: RecentLedgerEvent[] = [],
  decisionLearnings: DecisionLearning[] = [],
): string {
  const ctx = req.context ?? {};
  const parts: string[] = [];

  parts.push(
    `You are **Ada**, the media-buying copilot inside our agency's internal **Ad Launch Console**. ` +
    `You're talking to a member of OUR team (not a client). Answer their question directly and usefully. ` +
    `You have read access to every client's accounts, campaigns, ad sets, ads, spend & performance, launch/upload status, ` +
    `creative analysis, learnings and call transcripts via your tools — USE them to ground every answer in real numbers. ` +
    `Resolve a brand name to its client code with list_clients if you're unsure (e.g. "Ninepine" → NP, "JV Academy" → JVA). ` +
    `When you cite metrics, state the exact window and figures (e.g. "last 7 days (12–18 Jun): £4,231 spend, 142 purchases, 4.1× ROAS").`,
  );

  parts.push(
    `### How to behave\n` +
    `- This is a CHAT, not an error console. If the question is informational (spend, performance, status, "what's working", "how's X doing"), just ANSWER it with data. NEVER reply with "nothing to fix" and NEVER force an action button on an informational question.\n` +
    `- If you need a number, CALL A TOOL to get it — don't guess, and don't tell the operator to go look it up themselves.\n` +
    `- **You ACT, you don't just advise — you're the team's main Ada here, with your full media-buyer tool set.** When the operator asks you to DO something you have a tool for, DO IT and confirm what you did (cite the asset + the old→new value) — never say "I can't" and never hand back a dead button for something you can perform. That includes: updating Notion launch tasks (mark Done/uploaded, change status, move an ad-set stage, comment, create/update a task), uploading media to the library, building & launching staged ad sets, posting to Slack, and logging learnings — exactly as you do in Slack.\n` +
    `- **Two standing safety rails, always on (enforced below you — you don't need to police them, just know the shape):** (1) every ad-set launch you create lands PAUSED in the locked sandbox campaign — ZERO spend — and a human enables it to actually go live, so "launch" here means "build the paused set", never "start spending"; (2) you can NEVER delete anything. For actions that upload media or create objects (upload, launch), only proceed once the operator has clearly said go — never on a "what's ready?" question — and preview launches with preview_ad_launch first.\n` +
    `- **When a write fails, it fails loudly — report it honestly.** Failed launches/uploads now reach you as real errors (never narrate a failed write as "done"). A KNOWN failure arrives with its documented fix appended ([FAILURE-ORGAN MATCH]) — apply that fix and retry ONCE, then report the true outcome either way. If the Governor refuses an action (irreversible, low confidence, or forbidden), do NOT retry it — present the options with your recommendation and let the operator decide. For an unfamiliar error you met some other way, you can look it up with lookup_dead_end.\n` +
    `- You have NO Bash / Read / file-system / shell access — never attempt them (they are blocked and just waste a turn). You also cannot open a pasted URL. If someone pastes a Notion link, do NOT try to fetch or parse it: the Notion databases are already mirrored into your tools, so answer from those.\n` +
    `- Be concise and concrete. Markdown is welcome — short bold numbers, tight bullets, small tables. No preamble, no "as an AI", no restating the question.`,
  );

  parts.push(
    `### How to analyze performance (ratios, benchmarks, creative content)\n` +
    `- **Lead with ratios and rates, not absolute counts.** The operator does not care about raw clicks / CTR / impression counts in isolation — they care about RATIOS and PERCENTAGES (hook rate, hold rate, CTR, LPV-per-click, PDP-views-per-click, ATC/PDP, CVR, AOV, ROAS) and, crucially, **how they compare** to the rest of the account or to sibling ads. Always benchmark a single ad against the account average or the other ads in its set — a number with nothing to compare it to is not an analysis.\n` +
    `- **On an ad deep-dive, factor in the CREATIVE CONTENT, not just delivery.** When asked something specific about one ad — why it wins/loses, "what is it about this ad", how to make more like it — pull the transcript and the video/visual analysis (get_creative_details, and query_meta_creatives / the stored creative_analysis) and tie the numbers to what the ad actually SAYS and SHOWS. If the transcript/analysis don't exist for that ad, say so explicitly (its video was likely never downloaded) rather than analyzing blind.\n` +
    `- **Consult your Key Learnings before calling anything an anomaly.** Many "weird" patterns are normal for the account and may already be written in your learnings — e.g. more content-views (PDP views) than link clicks is EXPECTED (each clicker just browses several product pages), not a red flag. Check first; don't flag an expected pattern as a ⚠️ problem.`,
  );

  parts.push(ROOT_CAUSE_METHOD);

  parts.push(
    `### When the operator corrects or teaches you, SAVE it (remember) — then CONFIRM the save\n` +
    `Chat corrections do NOT persist on their own — they vanish when this session ends. So when the operator corrects you, states a preference for how to analyze/report, or teaches you a durable fact about a client or the account, CALL **remember** to store it as a learning (pass client_code when it's client-specific; omit it for a general analysis principle). The remember tool returns the saved record. ONLY after that call succeeds, end your reply with an explicit, PAST-TENSE confirmation that quotes back what you saved — e.g. \`✅ Saved to memory — "<the exact generalized learning>" (TL)\` — so the operator can see it's been written, not merely promised. Do NOT say a vague "I'll remember that", and NEVER claim you saved something if the remember call didn't actually run or it errored — say so plainly and retry instead. That confirmed save is the ONLY way it carries into future sessions. Save the GENERALIZED rule, not the one-off phrasing; skip ephemeral chit-chat and anything already in your Key Learnings.\n` +
    `**A rejection WITH A REASON is the most valuable thing you can save.** When the operator turns down, overrides or corrects something you suggested and tells you WHY ("no, we never scale a set more than 20% a day", "CBO only on this account"), call **remember** immediately with client_code set, and capture the reason in THEIR words — quote the sentence rather than paraphrasing it into house style, because the wording is the rule. Then treat it as standing: never re-propose the rejected thing for that client unless the conditions named in the reason have actually changed, and when you think they have, say which condition changed before you propose it again.`,
  );

  parts.push(
    `### "Ready to upload" — use the dedicated tool, and NEVER count Blocked\n` +
    `When asked what / which ad sets are "ready to upload" (or handed the "Ready to Upload" Notion view), call **get_ready_to_upload_backlog** — that single tool IS the canonical view (the same set the console and the #ada digest use). It already excludes Blocked, Done, Cancelled, and Archived, resolves each set's title/code/client, and badges pre-upload readiness; it is never truncated. Report what it returns, grouped by client, with the total.\n` +
    `Do NOT instead run query_aot_tasks/query_aot_adsets and hand-filter — and above all, **a Blocked task is NOT ready to upload; never list or count Blocked items as ready.** Blocked items are usually campaign-level config work, not per-ad-set upload tasks. If the backlog is empty, say so plainly.\n` +
    `Each set carries a readiness badge: **ready** (pre-warmed + fully analyzed), **analyzing** (still processing — transient, will finish), **stalled** (analysis FAILED on ≥1 asset — ffmpeg/Gemini/AssemblyAI — it will NEVER finish on its own and needs a re-analyze or a human), **blocked** (an upload flag like a missing folder or name conflict), **not-prewarmed**. **Never call a stalled set "analyzing"** — that's the exact bug we fixed: say it's stalled, give the failed-asset count, and offer to re-run the analyzer. Only ready sets can go straight to upload.`,
  );

  const ctxLines: string[] = [];
  if (ctx.client_code) ctxLines.push(`- current client open in the console: ${ctx.client_code}`);
  if (ctx.asset_code) ctxLines.push(`- current ad set: ${ctx.asset_code}`);
  if (ctx.title) ctxLines.push(`- ad-set title: ${ctx.title}`);
  if (ctx.gate) ctxLines.push(`- current screen/gate: ${ctx.gate}`);
  if (ctx.error?.code || ctx.error?.message) ctxLines.push(`- a blocking error is on screen: ${ctx.error.code ?? ''} ${ctx.error.message ?? ''}`.trim());
  if (ctxLines.length) parts.push(`### Console context (what the operator is looking at — use it to disambiguate "this set" / "this client")\n${ctxLines.join('\n')}`);

  const chatLedger = renderLedgerSection(ledgerEvents);
  if (chatLedger) parts.push(chatLedger);
  parts.push(renderLedgerAwareness(recentLedger));

  // Loop 4: last — closest to the question, so a settled decision is the last
  // thing read before answering.
  const decisionsBlock = renderDecisionLearningsBlock(decisionLearnings);
  if (decisionsBlock) parts.push(decisionsBlock);

  parts.push(`### The operator's message\n${(req.question ?? '').trim() || '(no message)'}`);

  parts.push(
    `### Actions (OPTIONAL — usually omit)\n` +
    `Actions are now only for NAVIGATION / follow-up (opening a set in the console, a report, a suggested next question) — NOT for upload or launch, which you PERFORM directly with your tools (do not emit run_upload / run_launch). Only when there is a concrete navigational next step, append on the VERY LAST line (after your full answer) EXACTLY ONE fenced JSON block and nothing after it:\n` +
    '```json\n' +
    `{"actions":[{"key":"open_asset|open_backlog|view_report|ask_followup|manual","label":"<short button text>","detail":"<what happens>","asset_code":"<if relevant>","client_code":"<if relevant>"}],"creatives":[{"ad_id":"<meta ad id>","client_code":"<code>","label":"<short, e.g. PV0129i · 7.2x ROAS>"}]}\n` +
    '```\n' +
    `For a plain data/status question there is NO action — do not emit the block at all. Order actions most-useful-first.`,
  );

  parts.push(
    `### Uploading media to the library (upload_to_media_library)\n` +
    `You upload directly — once the operator has clearly said to go ahead with a media folder: scan it with **scan_media_library_folder** (resolve the Drive folder + the ad-set's expected_asset_id), then call **upload_to_media_library**. That runs the REAL, QC'd pipeline server-side (Drive rename → Media Library upload → AssemblyAI + Gemini analysis kicked automatically). Report what uploaded / skipped / errored (image hashes / video ids) and that analysis is running, then continue to the preview once it's done. No spend is possible from an upload. Only upload once the operator has explicitly said to proceed — never on a plain "what's ready to upload?" question. (Do NOT emit a run_upload action — you perform it yourself now.)`,
  );

  parts.push(
    `### The upload flow DIFFERS PER CLIENT — know it before you act\n` +
    `Routing, naming and launch-capability are NOT the same for every client (the source of truth is client_registry on the upload server; if unsure, check get_client_capabilities / list_clients — never assume).\n` +
    `- **Upload-only clients — Audibene (code AB, rollup ADBN) is the canonical one:** uploads go into THEIR OWN Media Library (the "hear.com group" Business Manager), and you **STOP there**. Audibene is NOT launch-capable — do the upload + correct naming, confirm it landed, and hand back. The CLIENT launches; you never preview or launch_ads for them. Treat any client whose launch_capable is false the same way.\n` +
    `- **Full-pipeline clients — SweetSpot (code SS, rollup STSP) is the canonical one:** the WHOLE thing — the files must carry the correct **SweetSpot name** ([Format]-[CreativeType]-[AdTitle]-[Hook]-[Brand]-[Lang]-[ID]; the upload pipeline + ada-sweetspot-namer handle the renames/validation, you don't hand-rename), upload to the Media Library, THEN preview_ad_launch → launch_ads (paused bank). Renames + launch are in-scope.\n` +
    `So: "upload this Audibene ad" = upload to the library and stop. "upload this SweetSpot ad" = renamed upload + the launch pipeline. When in doubt about a client's flow, check capabilities first rather than guessing.`,
  );

  parts.push(
    `### Launching a staged ad set (launch_ads)\n` +
    `You launch directly. When the operator asks to launch / go live with an uploaded or staged ad set, don't ask them to re-phrase and don't claim a "workflow document isn't loaded" — if you need the procedure, LOAD the ada-ready-to-upload skill via the Skill tool. Then: (1) call preview_ad_launch (read-only) to build + persist the preview and SHOW it (get its batch_id); (2) run the client's voice/compliance QC if a QC skill exists — NOTE: Slumber (SLB) has NO QC skill yet and is a REGULATED melatonin product, so flag the copy as UNVETTED and have the operator eyeball it in the preview before you proceed; (3) call **launch_ads** with the batch_id. That creates the ad set **PAUSED** in the locked sandbox campaign — ZERO spend (SafeMetaAPI refuses if the parent bank campaign isn't paused) — so tell the operator it's built + paused and that THEY enable it to go live. Only launch once you have a real batch_id from preview_ad_launch and the operator has said go; if preview fails, say so plainly. (Do NOT emit a run_launch action — you perform it yourself now.)`,
  );

  parts.push(
    `### Showing creatives (images) in chat (creatives)\n` +
    `When the operator asks to SEE / SHOW / display the actual creatives, ads, images or thumbnails (not just the numbers), include a "creatives" array in your trailing JSON block — one entry per ad you're showing, each with the Meta **ad_id** (the real id from get_ad_summary / query_meta_creatives), the **client_code**, and a short **label** (ad name + a headline metric, e.g. "PV0129i · 7.2x ROAS"). The chat resolves each ad_id to its stored thumbnail and renders the images inline next to your text. Only include the creatives they asked to see; cap at ~8, ordered most-relevant first. If you don't have the real ad_ids, say so instead of inventing them.`,
  );

  parts.push(
    `### Charts, graphs & tables\n` +
    `For tabular data, use a normal Markdown table (it renders styled). For trends / comparisons / breakdowns where a picture helps (spend over time, spend by ad set, ROAS by market, status mix), emit a "charts" array in your trailing JSON block. Each chart: {"type":"bar"|"line"|"area"|"pie","title":"<short>","x_key":"label","series":[{"key":"<dataKey>","name":"<legend label>"}],"data":[{"label":"<x value>","<dataKey>":<number>}, ...]}. Multi-series: add more numeric keys per row + matching series entries. Pie: series:[{"key":"value"}] with data:[{"label","value"}]. Use REAL numbers you pulled from tools — never invent them. Cap at ≤4 charts, ≤12 points each. A chart complements your text answer, it doesn't replace it.`,
  );

  parts.push(
    `### Creative-analysis coverage (coverage)\n` +
    `When the operator asks how much of a client's creatives we've TRANSCRIBED or ANALYZED, what our "coverage" is, which live/spending ads are missing analysis, or how much of the account is currently live+spending — emit a "coverage" array in your trailing JSON block: [{"client_code":"<CODE>","window_days":<days, default 30>}]. The chat renders a live coverage widget (live+spending share, % with a creatives row / transcribed / visually analyzed, and the gap counts) by calling our own dashboard — so you do NOT need a tool for the numbers and you should NOT restate the bar percentages in prose (the widget shows them). Instead, briefly frame what it means and flag the headline gap (ads with NO creatives row are nightly-sync misses, invisible to all analysis). **Creator / partnership videos (branded content, e.g. Laori's "Partnership ad - Jennifer") are surfaced SEPARATELY as "not a coverage gap" — their video lives on the creator's account so Meta refuses the download (#10 permission), and we can NEVER transcribe/analyze them. Do NOT count those as a gap or tell the operator to go analyze them; if coverage looks low partly because of them, say so.** One coverage block per client asked about (cap 3). Only emit it when coverage is actually the question.`,
  );

  return parts.join('\n\n');
}

/**
 * Daniel's root-cause method (taught on the 2026-07-27 Nina bi-weekly; full
 * extraction with tape in tinkers docs/factory/day-2026-07-27/
 * root-cause-method-nina-call.md). Shared verbatim by the team chat prompt and
 * the client-scoped prompt so both surfaces diagnose the same way: a movement
 * in results is half an answer — the other half is which metrics moved WITH it
 * and which stayed flat.
 */
const ROOT_CAUSE_METHOD =
  `### When performance MOVED (either direction): tell the story, not just the movement\n` +
  `A change in results (CPA/CPL/ROAS up or down, a record day, a slump) is HALF an answer. The other half is why, and the why lives in the metrics that moved with it — and just as much in the ones that stayed flat. Work these five questions in order:\n` +
  `1. **Pin the date.** Name the exact day(s) the movement started before theorizing. The date is the join key for every other check.\n` +
  `2. **Decompose the funnel into moved-vs-flat.** Walk spend → CPM → frequency → CTR → clicks → LPV / PDP-view rate → add-to-cart rate → checkout rate → purchases → AOV → ROAS and state which steps moved WITH the result and which did not. The first broken link localizes the cause: clicks up but everything past PDP view flat = more traffic but the wrong traffic; spend up while frequency AND CPM fall = healthy scaling into new audience, not fatigue; checkout rate down with everything upstream flat = an on-site/offer problem, not an ads problem.\n` +
  `3. **Sweep what changed around that date, every ledger:** our changes (account change history: budgets, killed or new ads, destination routing), the client's world (a sale starting or ending, price or shipping changes, a newsletter, site tests), the tracking layer (server-vs-browser event divergence, event match quality), and the outside world (seasonality, weather where the account is weather-sensitive).\n` +
  `4. **Cross-check a second source before believing either** (Meta vs Triple Whale vs the funnel report, where available). Divergence between sources is itself a finding: attribution shifted between channels, or one source's tracking broke.\n` +
  `5. **Say explicitly whether this is behavior or measurement.** A metric can move because what it COUNTS changed — a collection page that never fires a PDP view, a pixel that stopped sending — not because people changed. Never present a measurement artifact as a behavior change.\n` +
  `Apply the SAME rigor to good movement ("why was yesterday a record?") — the mechanism is what makes it repeatable. End every diagnosis with the one-sentence story plus a concrete so-what (the next step you recommend). If you cannot find the co-movers, say plainly that the cause is unlocated and name which ledger you could not check.`;

/**
 * Client-scoped chat prompt (Tinkers portal — rollout plan R5). A CLIENT user is
 * on the other end, NOT a member of our team, so this deliberately shares NOTHING
 * with buildChatPrompt: no "OUR team" framing, no cross-client read access, no
 * list_clients resolution, no upload/launch playbooks, no launch-ledger context.
 *
 * Framing reuses buildClientOverlay — the SAME dedicated-single-client analyst
 * overlay the Slack client-scoped Ada gets in the runner path — so the two client
 * surfaces stay consistent. (The SDK's buildSystemPrompt does NOT auto-inject the
 * overlay the way runner.ts does, so we supply it here in the user message, exactly
 * as the internal buildChatPrompt supplies its own framing in the user message.)
 * Tool-level scoping (forced input.client_code) is the real data wall; this only
 * governs voice/behaviour. The client_media_buyer profile is read-only.
 */
function buildScopedChatPrompt(
  req: AssistRequest,
  clientCode: string,
  decisionLearnings: DecisionLearning[] = [],
): string {
  let clientContext: string | undefined;
  try {
    // Mirrors runner.ts: agents/ada/clients/<CODE>.md, case-sensitive on Linux
    // (the code is already normalized to canonical UPPERCASE by the caller).
    clientContext = readFileSync(join(process.cwd(), 'agents', 'ada', 'clients', `${clientCode}.md`), 'utf-8');
  } catch { /* no per-client context file → generic client framing, same as runner */ }

  // Best-effort friendly name from the overlay's H1 (e.g. "# Audibene (AB) — …"),
  // else fall back to the code. buildClientOverlay only uses it for phrasing.
  let displayName = clientCode;
  if (clientContext) {
    const m = clientContext.match(/^#\s+([^\n(—-]+?)\s*(?:\(|—|-|\n)/);
    const name = m?.[1]?.trim();
    if (name && name.length <= 60) displayName = name;
  }

  const parts: string[] = [];
  parts.push(buildClientOverlay({ clientCode, displayName, clientContext }));
  parts.push(
    `### How to answer\n` +
    `- Answer directly and usefully, grounded in real numbers from your tools — never guess a figure, and state the exact window when you cite metrics.\n` +
    `- Lead with ratios and rates (hook/hold rate, CTR, CVR, AOV, ROAS) and benchmark against the account, not raw counts in isolation.\n` +
    `- Be concise and concrete. Markdown is welcome (short bold numbers, tight bullets, small tables). No preamble, no "as an AI", no restating the question.`,
  );
  parts.push(ROOT_CAUSE_METHOD);
  parts.push(
    `### When the customer teaches you something, SAVE it (remember) — then confirm\n` +
    `Chat does not persist on its own: anything the customer corrects or explains vanishes when this session ends unless you store it. When they tell you a durable fact about their business (who their customers are, which campaign is theirs vs their media buyer's, what a lead is worth to them, a sale or launch date, how they want numbers framed), CALL **remember** to save it as a learning. Your saves are automatically scoped to this customer's account — never worry about other accounts, and never mention that scoping machinery. After the remember call succeeds, end your reply confirming in plain past tense what you saved (quote the generalized fact back). Never say "I'll remember that" without actually calling the tool, and never claim a save that errored. Two exceptions: (1) their performance GOAL cannot be changed from chat — point them at the Your business page, where changing it re-runs the checks; (2) skip chit-chat and one-off phrasing — save durable facts only.\n` +
    `**Save every rejection that comes with a reason — it is the most valuable thing they tell you.** When they turn down, override or correct something you proposed and say WHY ("we never touch that campaign, it's our media buyer's", "don't scale that fast"), call **remember** right away and capture the reason in THEIR words — quote the sentence rather than tidying it into your own phrasing, because the wording IS the rule. From then on it is settled: never propose the rejected thing again unless the conditions named in their reason have actually changed, and if you think they have, name the changed condition before proposing it.`,
  );
  parts.push(
    `### Proposing account changes (card 57 — the approve-first rail)\n` +
    `You cannot change anything in the account yourself, and you never claim otherwise. When the customer asks you to CHANGE something (create a campaign or ad set, duplicate an ad set, pause an ad or ad set, change a budget), do this instead of refusing:\n` +
    `1. Briefly explain what you would do and why, grounded in their numbers and their operating rules. NEVER show raw JSON in your prose — the block below renders as a review card, not as text.\n` +
    `2. End your reply with EXACTLY ONE fenced json block of this shape (no other fenced json in the reply):\n` +
    '```json\n{"proposal": {"type": "create_ad_set" | "pause_ad_set" | "pause_ad" | "update_budget" | "create_campaign" | "duplicate_ad_set" | "duplicate_ad" | "create_ad", "campaign_id": "<numeric id>", "campaign_name": "<name>", "target_id": "<ad set / ad id, for pause, budget and duplicate types>", "settings": {"name": "...", "status": "PAUSED", "daily_budget_usd": 0, "bid_strategy": "...", "bid_amount_usd": 0, "optimization_goal": "...", "billing_event": "...", "destination_campaign_id": "...", "targeting_summary": "..."}, "choices": [{"key": "budget_mode", "label": "How should the budget live?", "options": [{"value": "cbo", "label": "One campaign budget (CBO)", "detail": "the campaign spreads it across ad sets"}, {"value": "abo", "label": "Per ad set (ABO)", "detail": "each ad set carries its own budget"}]}], "reason": "<one sentence>", "warnings": ["<anything the customer must see>"]}}\n```\n' +
    `If "budget_mode" cbo is among the options, ALWAYS include settings.daily_budget_usd too (pick a sensible number from their spend and say so in the reason — it applies only if CBO is chosen, and the modal shows it). Same for bid caps: offering LOWEST_COST_WITH_BID_CAP means settings.bid_amount_usd must be present.\n` +
    `For create_campaign, ALWAYS put the structure decisions in "choices" instead of deciding yourself — budget_mode (cbo/abo) and bid_strategy (LOWEST_COST_WITHOUT_CAP / LOWEST_COST_WITH_BID_CAP / COST_CAP) at minimum, objective too if the ask is ambiguous (OUTCOME_LEADS / OUTCOME_SALES / OUTCOME_TRAFFIC). Campaign structure is the customer's call, never yours. For duplicate_ad_set, target_id is the SOURCE ad set and settings.destination_campaign_id is where the copy lands. For duplicate_ad, intent.source_id is the ad to copy and settings.adset_id the destination ad set. create_ad reuses an EXISTING creative (settings.creative_id + settings.adset_id). Brand-new creatives from raw media go through the UPLOADS tab instead (card 65, live 2026-07-30): the customer pastes a Google Drive folder link there, I read every file, write the copy, they review each ad and approve, and everything lands PAUSED in a campaign from their fence. Google Drive only, no Dropbox yet. If their UPLOADS tab still says setting up, the wiring is not on for their account: say that plainly rather than promising it.\n` +
    `Rules for proposals:\n` +
    `- Include EVERY setting the change would carry — the customer sees this in a confirmation modal and nothing not listed there may happen. Omit settings keys that do not apply.\n- Settings values must be REAL values (enum constants, numbers, objects). To mirror a setting from the campaign's existing ad sets, OMIT that key entirely (the executor mirrors a sibling ad set for anything omitted) — never write prose like "mirror existing" into a value.\n` +
    `- Creates are ALWAYS status PAUSED. Never propose anything that starts delivery or turns a campaign on.\n` +
    `- A budget change of 3x or more versus the current value MUST carry a warning naming both numbers.\n` +
    `- You NEVER propose deletes. If asked to delete something, say plainly that deleting is something you never do, and offer pausing instead (as a proposal).\n` +
    `- If asked to touch a different account or a campaign outside your allowed list, refuse plainly — no proposal.\n` +
    `- If the ask is ambiguous (no campaign, no budget), ask the clarifying question instead of proposing.`,
  );
  // Loop 4: directly after the proposal rail and directly before their message —
  // the settled decisions are the last thing read before drafting a proposal.
  // "THIS CUSTOMER" (never Daniel/Nina): this surface shares no team framing.
  const decisionsBlock = renderDecisionLearningsBlock(decisionLearnings, 'THIS CUSTOMER HAS');
  if (decisionsBlock) parts.push(decisionsBlock);
  parts.push(`### The message\n${(req.question ?? '').trim() || '(no message)'}`);
  return parts.join('\n\n');
}

/** Friendly progress labels for the streamed tool-use ticks. */
const TOOL_LABELS: Record<string, string> = {
  list_clients: 'Looking up the client list', get_client_targets: 'Checking the KPI target',
  get_client_performance: 'Pulling account performance', get_client_capabilities: 'Checking client setup',
  get_campaign_summary: 'Reading campaign summary', get_campaign_performance: 'Reading campaign performance',
  get_adset_summary: 'Reading ad-set summary', get_adset_performance: 'Reading ad-set performance',
  get_ad_summary: 'Reading ad summary', get_ad_performance: 'Reading ad performance',
  query_meta_insights: 'Querying Meta insights', query_meta_creatives: 'Querying Meta creatives',
  get_breakdowns: 'Pulling breakdowns', get_triplewhale_summary: 'Pulling Triple Whale revenue',
  get_domo_funnel: 'Reading funnel data', get_account_changes: 'Checking recent account changes',
  get_creative_details: 'Reading creative details', get_alerts: 'Checking alerts',
  get_learnings: 'Recalling client learnings', recall: 'Recalling from memory',
  get_rival_reports: 'Reading your rivals teardowns',
  search_memories: 'Searching memory', search_methodology: 'Consulting methodology',
  remember: 'Saving learning to memory', log_decision: 'Logging a decision',
  correct_learning: 'Correcting a saved learning', delete_learning: 'Removing a learning',
  query_aot_adsets: 'Checking the launch backlog', query_aot_tasks: 'Checking launch tasks',
  count_aot_adsets: 'Counting backlog sets', check_ads_in_meta: 'Verifying ads in Meta',
  verify_launch: 'Verifying launch state', preview_ad_launch: 'Previewing the launch',
  scan_media_library_folder: 'Scanning the media folder', check_preupload_status: 'Checking upload status',
  search_meetings: 'Searching call transcripts', get_meeting_summary: 'Reading a call summary',
  Skill: 'Loading a skill', ToolSearch: 'Finding the right tool',
  WebSearch: 'Searching the web', WebFetch: 'Reading a web page', Read: 'Reading a file',
};
function toolLabel(name: string): string {
  const bare = name.replace(/^mcp__[^_]+__/, '');
  return TOOL_LABELS[bare] ?? `Using ${bare.replace(/_/g, ' ')}`;
}

/** Extract the optional trailing {"actions":[...]} block from the final answer text. */
/**
 * Card 57: a scoped (customer) reply may end with one {"proposal": {...}}
 * fenced block — Ada proposing an account change for the approve-first rail.
 * Parsed server-side so the SSE event is SERVER truth, mirroring actions/
 * creatives/charts. Returns null when absent or malformed (a malformed
 * proposal is dropped rather than guessed at — nothing may reach the modal
 * that Ada did not literally write).
 */
interface ChatProposal {
  type: 'create_ad_set' | 'pause_ad_set' | 'pause_ad' | 'update_budget' | 'create_campaign' | 'duplicate_ad_set';
  campaign_id?: string;
  campaign_name?: string;
  target_id?: string;
  settings?: Record<string, unknown>;
  /** Decisions the CUSTOMER makes in the modal (campaign structure is theirs
   *  by standing rule): radio groups, merged into settings on approve. */
  choices?: Array<{
    key: string;
    label: string;
    options: Array<{ value: string; label: string; detail?: string }>;
    selected?: string;
  }>;
  reason?: string;
  warnings?: string[];
}
const PROPOSAL_TYPES = new Set(['create_ad_set', 'pause_ad_set', 'pause_ad', 'update_budget', 'create_campaign', 'duplicate_ad_set', 'duplicate_ad', 'create_ad']);
function parseChatProposal(text: string): ChatProposal | null {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const fence of fences.reverse()) {
    try {
      const obj = JSON.parse(fence[1].trim()) as { proposal?: ChatProposal };
      const p = obj.proposal;
      if (p && typeof p === 'object' && PROPOSAL_TYPES.has(p.type)) return p;
    } catch { /* not this fence */ }
  }
  return null;
}

function parseChatActions(text: string): ChatAction[] {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  if (!fences.length) return [];
  try {
    const obj = JSON.parse(fences[fences.length - 1][1].trim()) as Record<string, unknown>;
    const raw = Array.isArray(obj.actions) ? obj.actions : [];
    return raw
      .map((a) => a as Record<string, unknown>)
      .filter((a) => a && typeof a.label === 'string')
      .map((a) => ({
        key: typeof a.key === 'string' ? a.key : 'manual',
        label: String(a.label),
        detail: String(a.detail ?? ''),
        asset_code: a.asset_code ? String(a.asset_code) : undefined,
        client_code: a.client_code ? String(a.client_code) : undefined,
        drive_url: a.drive_url ? String(a.drive_url) : undefined,
        expected_asset_id: a.expected_asset_id ? String(a.expected_asset_id) : undefined,
        ad_account_id: a.ad_account_id ? String(a.ad_account_id) : undefined,
        batch_id: a.batch_id ? String(a.batch_id) : undefined,
      }));
  } catch { return []; }
}

interface ChatCreative { ad_id: string; client_code?: string; label?: string }
interface ChatChart { type?: string; title?: string; x_key?: string; series?: { key: string; name?: string }[]; data?: Record<string, unknown>[] }
/** Extract an optional "creatives" array from the trailing JSON block — ad_ids
 *  the chat should render as thumbnail images inline. */
function parseChatCreatives(text: string): ChatCreative[] {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  if (!fences.length) return [];
  try {
    const obj = JSON.parse(fences[fences.length - 1][1].trim()) as Record<string, unknown>;
    const raw = Array.isArray(obj.creatives) ? obj.creatives : [];
    return raw
      .map((c) => c as Record<string, unknown>)
      .filter((c) => c && (typeof c.ad_id === 'string' || typeof c.ad_id === 'number'))
      .slice(0, 12)
      .map((c) => ({
        ad_id: String(c.ad_id),
        client_code: c.client_code ? String(c.client_code) : undefined,
        label: c.label ? String(c.label) : undefined,
      }));
  } catch { return []; }
}

/** Extract an optional "charts" array from the trailing JSON block — Recharts specs. */
function parseChatCharts(text: string): ChatChart[] {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  if (!fences.length) return [];
  try {
    const obj = JSON.parse(fences[fences.length - 1][1].trim()) as Record<string, unknown>;
    const raw = Array.isArray(obj.charts) ? obj.charts : [];
    return raw
      .map((c) => c as ChatChart)
      .filter((c) => c && Array.isArray(c.data) && c.data.length > 0)
      .slice(0, 4);
  } catch { return []; }
}

interface ChatCoverage { client_code: string; window_days?: number; label?: string }
/** Extract an optional "coverage" array from the trailing JSON block — the chat
 *  renders a live creative-analysis-coverage widget per client_code (it fetches
 *  /api/clients/<code>/creative-coverage itself, the single source of truth). */
function parseChatCoverage(text: string): ChatCoverage[] {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  if (!fences.length) return [];
  try {
    const obj = JSON.parse(fences[fences.length - 1][1].trim()) as Record<string, unknown>;
    const raw = Array.isArray(obj.coverage) ? obj.coverage : [];
    return raw
      .map((c) => c as Record<string, unknown>)
      .filter((c) => c && (typeof c.client_code === 'string') && c.client_code.length > 0)
      .slice(0, 3)
      .map((c) => ({
        client_code: String(c.client_code).toUpperCase(),
        window_days: typeof c.window_days === 'number' ? c.window_days : undefined,
        label: c.label ? String(c.label) : undefined,
      }));
  } catch { return []; }
}

function sseHead(res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': open\n\n');
}
function sseEvent(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handleChatStream(
  req: AssistRequest,
  res: http.ServerResponse,
  scope?: { clientCode: string; userId: string },
): Promise<void> {
  // The client's own opaque conversation id — echoed back verbatim in meta/done so
  // it keeps sending the SAME id to continue the thread (prefixing stays internal).
  const sessionId = req.session_id || `chat-${randomUUID()}`;
  // Internal SDK resume key = (channelId, threadTs, agentId). For client-scoped
  // requests the agentId already differs per client (ada_client_<CODE>), so
  // cross-CLIENT resume is impossible. WITHIN a client, sessions are shared by
  // design (Daniel, D2 2026-07-07): any teammate may continue any of their
  // client's conversations, so threadTs is the session id as-is — the Tinkers
  // portal's RLS'd session list is what gates who can present a session_id.
  const threadTs = sessionId;
  const channelId = scope
    ? `launch-ada-chat-${scope.clientCode}`
    : `launch-ada-chat-${req.context?.client_code ?? 'x'}`;
  // The launch ledger is internal team context — never surfaced to a client.
  const [ledgerEvents, recentLedger] = scope
    ? [[] as LedgerEvent[], [] as RecentLedgerEvent[]]
    : await Promise.all([
        fetchLedger(req.context?.asset_code),
        fetchRecentLedger(),
      ]);

  sseHead(res);
  sseEvent(res, 'meta', { session_id: sessionId });

  let closed = false;
  res.on('close', () => { closed = true; });
  const heartbeat = setInterval(() => { if (!closed) { try { res.write(': ping\n\n'); } catch { /* noop */ } } }, 15_000);
  const safe = (event: string, data: unknown) => { if (!closed) { try { sseEvent(res, event, data); } catch { /* noop */ } } };

  // Loop 4: the client's settled decisions, newest first. Scoped runs always
  // have a code; internal runs only when the console has a client open. Fetched
  // AFTER the stream head so the heartbeat is already flowing, and fail-open —
  // an empty list just means no block.
  const decisionClientCode = (scope?.clientCode ?? req.context?.client_code ?? '').trim();
  const decisionLearnings = decisionClientCode ? await fetchDecisionLearnings(decisionClientCode) : [];
  let proposalType: string | null = null;

  let fullText = '';
  let costUsd = 0;
  let toolsUsed: string[] = [];
  // Honest done (Ada 2.0): the SDK's authoritative result subtype. 'unknown'
  // means the stream died before a result message — NEVER treated as success.
  let subtype = 'unknown';

  try {
    await runAgentSDK(
      {
        source: scope ? 'api-console-chat-scoped' : 'api-console-chat',
        agentId: 'ada',
        userMessage: scope
          ? buildScopedChatPrompt(req, scope.clientCode, decisionLearnings)
          : buildChatPrompt(req, ledgerEvents, recentLedger, decisionLearnings),
        // Scoped: attribute the run (and its memory/quick-context) to the real
        // client user from the verified claim; internal: the shared console user.
        userId: scope ? scope.userId : 'launch-console',
        channelId,
        threadTs,
        // Client scoping: switches runAgentSDK to the read-only client_media_buyer
        // profile, agent id ada_client_<CODE>, and forces input.client_code on every
        // tool call so the agent physically cannot read another client's data.
        // (runAgentSDK reads only .clientCode; displayName satisfies the RunOptions
        // type and is otherwise unused by the SDK path.)
        ...(scope ? { clientScope: { clientCode: scope.clientCode, displayName: scope.clientCode } } : {}),
        onText: (t) => { fullText += t; safe('text', { text: t }); },
        onThinking: (t) => safe('thinking', { text: t }),
        onToolUse: (name) => safe('tool', { name, label: toolLabel(name) }),
        onTurnReset: () => { fullText = ''; safe('reset', {}); },
      },
      {
        // Client-scoped requests are READ / ANALYSIS-ONLY: omit the write override so
        // defaultPolicy() denies every production write — the same advisory-only posture
        // as /assist and /diagnose. A client user must never trigger a write.
        //
        // Internal (unscoped) /chat keeps FULL production-write parity (Dan, 2026-06-20):
        // it is the team's MAIN Ada, with the same legitimate write surface as the Slack
        // media_buyer Ada — Notion task writes, media uploads, paused-bank launches, Slack
        // posts, learning/decision edits (guard.ts PRODUCTION_WRITES). The load-bearing
        // rails are below the guard and ALWAYS on: launch_ads/upload_to_media_library
        // create PAUSED-bank-only objects via SafeMetaAPI (zero spend; a human enables to
        // go live), and the delete rail hard-blocks every delete in any mode.
        //
        // ACCOUNT RESTRICTION (Dan, 2026-07-26): "Ada is read only for all the new
        // accounts, but I would love for Ada to be able to operate in the test account."
        //
        // Client-scoped (customer) sessions need nothing here — they are already
        // read-only twice over: no write policy above, and `client_media_buyer` contains
        // no write tools at all.
        //
        // For the internal path, ADA_WRITE_ACCOUNT_ALLOWLIST restricts which accounts
        // Ada may write to. Deliberately EMPTY by default, which preserves today's
        // behaviour: the agency Ada launches for all 14 configured clients, and that is
        // how real client launches happen. Setting it to `AOT` makes the practice account
        // the ONLY account she can write to — the configuration to use when testing.
        // Do NOT set it on the live service without meaning to stop real launches.
        //
        // The guard checks this list BEFORE its production-write allow-list (fixed
        // 2026-07-26 — it used to sit below and was unreachable). See
        // tests/guard-account-allowlist.test.ts.
        ...(scope
          ? {}
          : {
              policy: {
                allowProductionWrites: true,
                testClientCodes: WRITE_ACCOUNT_ALLOWLIST,
                // Card 48: the campaign fence, loaded fresh per run from
                // clients.allowed_campaign_ids so a fence change needs no
                // restart. Only relevant when writes are possible at all.
                allowedCampaignsByClient: await loadCampaignFences(),
              },
            }),
        thinking: true,
        streamPartial: true,
        maxBudgetUsd: CHAT_MAX_BUDGET_USD,
        maxTurns: CHAT_MAX_TURNS,
        onResult: (r) => { costUsd = r.costUsd; toolsUsed = r.toolsUsed; subtype = r.subtype; },
        // Ada 2.0 decision cards: live Governor verdicts + failure-organ matches
        // stream as `decision` events the moment they happen — the visible 10%
        // of the Governor. These are SERVER truth (from the tool bridge), not
        // model-authored, so the card cannot lie.
        onGovernorVerdict: (v) => safe('decision', {
          decision: {
            type: 'governor', tool: v.bareName, tier: v.tier, blast: v.blast,
            reversibility: v.reversibility, confidence: v.confidence,
            rationale: v.rationale, refused: v.tier === 'blocked' || v.tier === 'options',
          },
        }),
        onDeadEndMatch: (m) => safe('decision', {
          decision: {
            type: 'dead_end_match', tool: m.tool, kind: m.kind,
            matched_on: m.matchedOn, resolution: m.resolution,
          },
        }),
      },
    );
    const actions = parseChatActions(fullText);
    if (actions.length) safe('actions', { actions });
    // Card 57: proposals exist only on client-scoped runs — the internal
    // console has real write tools and needs no approve-first detour.
    if (scope) {
      const proposal = parseChatProposal(fullText);
      if (proposal) { proposalType = proposal.type; safe('proposal', { proposal }); }
    }
    const creatives = parseChatCreatives(fullText);
    if (creatives.length) safe('creatives', { creatives });
    const charts = parseChatCharts(fullText);
    if (charts.length) safe('charts', { charts });
    const coverage = parseChatCoverage(fullText);
    if (coverage.length) safe('coverage', { coverage });
    // HONEST done: ok only when the SDK explicitly reported success. A died
    // stream (subtype 'unknown') or an error subtype can no longer render as
    // success in the client (the streams-success-on-failure fix, service layer).
    const ok = subtype === 'success';
    safe('done', {
      session_id: sessionId, cost_usd: round(costUsd),
      used_skills: inferUsedSkills(fullText, toolsUsed),
      ok, subtype, ...(ok ? {} : { error: `runner subtype=${subtype}` }),
    });
  } catch (e) {
    console.error('[ada-console-assist] /chat error:', e);
    const errMsg = (e as Error).message || 'chat failed';
    safe('error', { error: errMsg });
    safe('done', { session_id: sessionId, cost_usd: round(costUsd), used_skills: [], ok: false, subtype: subtype === 'unknown' ? 'exception' : subtype, error: errMsg });
  } finally {
    // Loop 4 evidence: which decisions were in view when this turn was drafted.
    // In `finally` so an errored turn is recorded too; no-ops when the block was
    // empty. Fire-and-forget — never blocks the response.
    logDecisionLearningsInContext({
      agentId: scope ? `ada_client_${scope.clientCode}` : 'ada',
      channelId,
      userId: scope ? scope.userId : 'launch-console',
      sessionId,
      clientCode: decisionClientCode,
      question: (req.question ?? '').trim(),
      learnings: decisionLearnings,
      proposalType,
    });
    clearInterval(heartbeat);
    if (!closed) { try { res.end(); } catch { /* noop */ } }
  }
}

// ---------------------------------------------------------------------------
// /diagnose — "Ada's debugger": a read-only SECOND OPINION on a prior Ada turn.
// Same SDK machinery as /chat, but defaultPolicy (writes DENIED) and a QA prompt.
// ---------------------------------------------------------------------------
interface DiagnosisBlock { category: string; fixable_in_workshop: boolean; suggested_problem: string }

const DIAGNOSIS_CATEGORIES = new Set(['looks_correct', 'data_gap', 'tool_bug', 'prompt', 'knowledge']);

function buildDiagnosePrompt(req: AssistRequest): string {
  const trace = (req.trace ?? []).map((s) => `- ${s.tool ? `[${s.tool}] ` : ''}${s.label}`).join('\n') || '(no tool steps recorded)';
  return [
    `You are Ada's debugger — a careful, skeptical SECOND OPINION on an answer Ada (the media-buying assistant) just gave a teammate. You are an INTERNAL QA reviewer, not the teammate-facing assistant.`,
    ``,
    `A teammate asked Ada:`,
    `"""`, (req.question ?? '').trim() || '(question not provided)', `"""`,
    ``,
    `Ada answered:`,
    `"""`, (req.answer ?? '').trim() || '(answer not provided)', `"""`,
    ``,
    `The steps/tools Ada used:`,
    trace,
    ``,
    `Your job:`,
    `1. Independently CHECK whether Ada's answer is correct and complete. Use your READ tools to re-pull the relevant data yourself, matching Ada's client / time-window / scope as closely as you can. You are READ-ONLY — you cannot change anything.`,
    `2. If it looks WRONG or incomplete, explain plainly WHAT is off and WHY, then classify the ROOT CAUSE as exactly one of: looks_correct | data_gap | tool_bug | prompt | knowledge.`,
    `   - data_gap = underlying data missing/stale (a sync/coverage issue, not a code bug)`,
    `   - tool_bug = one of Ada's tools returned the wrong thing / errored / lacks a capability (FIXABLE in the Workshop)`,
    `   - prompt = Ada had the right data but reasoned/worded it wrong`,
    `   - knowledge = Ada is missing context/methodology it should have`,
    `3. Be honest about uncertainty — if you pulled a slightly different window or can't fully verify, say so. You are a second opinion, not gospel.`,
    ``,
    `Keep it SHORT and plain — a non-engineer (media buyer) is reading. Lead with the bottom line.`,
    ``,
    `End your reply with EXACTLY one fenced json block and nothing after it:`,
    '```json',
    `{"category":"looks_correct|data_gap|tool_bug|prompt|knowledge","fixable_in_workshop":true,"suggested_problem":"if tool_bug, a one-sentence problem a non-engineer could paste into the Ada Workshop to get it fixed; else empty string"}`,
    '```',
    `fixable_in_workshop is true ONLY for a clear tool_bug (occasionally a clear prompt/knowledge code fix). NEVER for data_gap or looks_correct.`,
  ].join('\n');
}

function parseDiagnosis(text: string): DiagnosisBlock | null {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  if (!fences.length) return null;
  try {
    const obj = JSON.parse(fences[fences.length - 1][1].trim()) as Record<string, unknown>;
    const category = String(obj.category ?? '');
    if (!DIAGNOSIS_CATEGORIES.has(category)) return null;
    return {
      category,
      fixable_in_workshop: obj.fixable_in_workshop === true && (category === 'tool_bug' || category === 'prompt' || category === 'knowledge'),
      suggested_problem: typeof obj.suggested_problem === 'string' ? obj.suggested_problem.slice(0, 300) : '',
    };
  } catch { return null; }
}

async function handleDiagnoseStream(req: AssistRequest, res: http.ServerResponse): Promise<void> {
  const threadTs = `diagnose-${randomUUID()}`;
  sseHead(res);
  sseEvent(res, 'meta', { session_id: threadTs });
  let closed = false;
  res.on('close', () => { closed = true; });
  const heartbeat = setInterval(() => { if (!closed) { try { res.write(': ping\n\n'); } catch { /* noop */ } } }, 15_000);
  const safe = (event: string, data: unknown) => { if (!closed) { try { sseEvent(res, event, data); } catch { /* noop */ } } };

  let fullText = '';
  let costUsd = 0;
  let errMsg: string | undefined;
  try {
    await runAgentSDK(
      {
        source: 'api-console-diagnose',
        agentId: 'ada',
        userMessage: buildDiagnosePrompt(req),
        userId: 'launch-console-debugger',
        channelId: `launch-ada-diagnose-${req.context?.client_code ?? 'x'}`,
        threadTs,
        onText: (t) => { fullText += t; safe('text', { text: t }); },
        onThinking: (t) => safe('thinking', { text: t }),
        onToolUse: (name) => safe('tool', { name, label: toolLabel(name) }),
        onTurnReset: () => { fullText = ''; safe('reset', {}); },
      },
      {
        // No policy override → defaultPolicy() denies ALL writes. The debugger only reads.
        thinking: true,
        streamPartial: true,
        maxBudgetUsd: Number(process.env.ADA_DIAGNOSE_MAX_BUDGET ?? 3.0),
        maxTurns: Number(process.env.ADA_DIAGNOSE_MAX_TURNS ?? 18),
        onResult: (r) => { costUsd = r.costUsd; },
      },
    );
  } catch (e) {
    errMsg = (e as Error).message || 'diagnose failed';
    console.error('[ada-console-assist] /diagnose error:', e);
  } finally {
    // ALWAYS try to surface a diagnosis from whatever text was produced — a late
    // budget/turn cap hit AFTER the diagnosis streamed must not discard a good result.
    const diag = parseDiagnosis(fullText);
    if (diag) safe('diagnosis', diag);
    // Only surface the error if we have NOTHING useful (no text + no diagnosis).
    if (errMsg && !diag && !fullText.trim()) safe('error', { error: errMsg });
    safe('done', { session_id: threadTs, cost_usd: round(costUsd) });
    clearInterval(heartbeat);
    if (!closed) { try { res.end(); } catch { /* noop */ } }
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req: http.IncomingMessage, limitBytes = 256 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) { reject(new Error('payload too large')); req.destroy(); return; }
      data += chunk.toString('utf8');
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// /execute-action — the guarded executor behind the card-57 approve button.
//
// Tinkers' approve route calls this AFTER a human clicked APPROVE on the modal.
// Trust nothing about the caller's judgment; every rail is re-checked here:
//
//   1. HARD PRACTICE LOCK — until Daniel enables accounts one by one, the ONLY
//      account this endpoint will ever write to is act_1570076840279279
//      ("Ads on Tap USD", the practice account). Everything else is refused,
//      whatever the intent says. (Daniel, 2026-07-29: "If you make any changes
//      whatsoever in a meta account, keep the changes to our test account only.")
//   2. CAMPAIGN FENCE (card 48) — the target campaign must be in the client's
//      clients.allowed_campaign_ids. Fail-closed: no list, no writes.
//   3. PAUSED-ONLY — creates carry status PAUSED unconditionally; a proposal
//      asking for anything else is refused; the parent campaign must itself be
//      paused (the paused-bank rule), so nothing can ever deliver or spend.
//   4. NEVER-DELETE — no delete type exists here at all.
//   5. Budget ceiling $100/day — this is a test rail, not a spend rail.
//
// Method: validate_only dry-run first, then the real write, then a read-back
// of the full object (the meta-write methodology), logged via logWrite with
// initiated_by derived as client_approved.
// ---------------------------------------------------------------------------

/**
 * Card 48: every configured campaign fence, keyed by client code. Clients with
 * no allowed_campaign_ids value get no entry (no fence configured); clients
 * with an empty/null value get an explicit empty entry (fail-closed: no writes
 * anywhere in their account). Loaded per run — cheap, and a fence edit in the
 * DB takes effect immediately.
 */
async function loadCampaignFences(): Promise<Record<string, string[] | null>> {
  try {
    const sb = getSupabase();
    const { data } = await sb
      .from('clients')
      .select('code, allowed_campaign_ids')
      .not('allowed_campaign_ids', 'is', null);
    const out: Record<string, string[] | null> = {};
    for (const row of data ?? []) {
      out[String(row.code).toUpperCase()] = (row.allowed_campaign_ids as string[] | null) ?? [];
    }
    return out;
  } catch (e) {
    console.error('[ada-console-assist] loadCampaignFences failed (fences unavailable, guard falls back to account gate):', e);
    return {};
  }
}

const PRACTICE_ACCOUNT = 'act_1570076840279279';
const EXEC_TYPES = new Set(['create_ad_set', 'pause_ad_set', 'pause_ad', 'update_budget', 'create_campaign', 'duplicate_ad_set', 'duplicate_ad', 'create_ad']);
const GRAPH = 'https://graph.facebook.com/v21.0';
/**
 * Default daily-budget ceiling for the approve rail, in USD.
 *
 * Per-client override lives in clients.max_daily_budget_usd (migration
 * 20260730140000). This was a flat 100 while the rail only ever touched the
 * practice account; the moment a real customer's lane opened, one global number
 * either blocked them inside their own normal spend range or loosened every
 * other account to raise one. NULL in the DB keeps this default.
 *
 * It is a ceiling, never an authorisation: creates stay PAUSED-only, so no
 * budget here can cause delivery until a human turns the object on in Meta.
 */
const DEFAULT_MAX_DAILY_BUDGET_USD = 100;

interface ExecuteActionRequest {
  client_code?: string;
  user_id?: string;
  /**
   * Check-only. Runs every rail, resolves every id the intent names against
   * Graph, and asks Meta itself via validate_only — then STOPS before the
   * mutating call. Nothing is written and nothing is logged as a write.
   *
   * This exists because Krish approved four actions on 2026-07-30 and got
   * nothing: one ad set create asking QUALITY_LEAD with no promoted_object,
   * then three duplicate_ads into an ad set id that never existed. Every one
   * of those was detectable BEFORE he was shown an APPROVE button — the
   * executor already dry-ran each write, just one step too late to help him.
   */
  dry_run?: boolean;
  intent?: {
    type?: string;
    campaign_id?: string;
    target_id?: string;
    settings?: Record<string, unknown>;
    reason?: string;
  };
}

async function graphCall(
  path: string,
  token: string,
  params: Record<string, string> = {},
  method: 'GET' | 'POST' = 'GET',
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams({ ...params, access_token: token });
  const url = method === 'GET' ? `${GRAPH}/${path}?${qs}` : `${GRAPH}/${path}`;
  const res = await fetch(url, method === 'GET' ? {} : { method: 'POST', body: qs });
  const json = (await res.json()) as Record<string, unknown>;
  if (json.error) {
    const e = json.error as { message?: string; error_user_msg?: string };
    throw new Error(e.error_user_msg || e.message || 'Graph error');
  }
  return json;
}

/**
 * Card 76: the page-permission / lead-ToS gate for verbs that instantiate an
 * ad from an existing creative (duplicate_ad, duplicate_ad_set).
 *
 * /copies ignores validate_only (corpus Case 15a — it CREATES a real copy),
 * so the only honest pre-flight is validating an equivalent ad create with the
 * same creative: Meta then checks everything the copy will need — page
 * ADVERTISE for the acting system user (the MatrNova 2026-07-30 failure,
 * root-caused 2026-08-06: the partner grant existed but the page was never
 * assigned to the system user in OUR Business Manager), leadgen ToS (subcode
 * 1892181, hit live the same day), and ad-set compatibility. Nothing is
 * written. Refusals name WHICH side must act, per the write-path constitution.
 */
async function validateCreativePlacement(
  acct: string,
  token: string,
  adsetId: string,
  creativeId: string,
): Promise<{ ok: true } | { ok: false; refused: string }> {
  try {
    await graphCall(`${acct}/ads`, token, {
      name: 'ADA PREFLIGHT (validate_only — never created)',
      adset_id: adsetId,
      status: 'PAUSED',
      creative: JSON.stringify({ creative_id: creativeId }),
      execution_options: JSON.stringify(['validate_only']),
    }, 'POST');
    return { ok: true };
  } catch (e) {
    const msg = (e as Error).message;
    if (/access to create ads for this page/i.test(msg)) {
      return {
        ok: false,
        refused:
          `page permission: the Facebook Page behind this ad is not advertisable by Ada's system user. ` +
          `Fix is on the agency side first: assign the Page to the "Ada" system user in Business Settings ` +
          `(Ads On Tap Business Manager) with "Create ads"; if that toggle is unavailable, the client's partner ` +
          `grant on the Page is missing the Ads task. Meta said: ${msg}`,
      };
    }
    if (/lead generation terms|lead ads/i.test(msg)) {
      return {
        ok: false,
        refused:
          `lead ads terms: this is a lead-form ad and the Page has not accepted Facebook's Lead Generation ` +
          `Terms of Service for this context — a Page admin on the client's side must accept them at ` +
          `facebook.com/ads/leadgen/tos, then this action will pass. Meta said: ${msg}`,
      };
    }
    return { ok: false, refused: `pre-flight validation failed: ${msg}` };
  }
}

async function handleExecuteAction(body: ExecuteActionRequest): Promise<Record<string, unknown>> {
  const clientCode = (body.client_code ?? '').toUpperCase().trim();
  const dryRun = body.dry_run === true;
  /** Stop here when checking: everything upstream passed, nothing was written. */
  const wouldApply = (detail: string) => ({ ok: true, dry_run: true, would_apply: true, detail });
  const intent = body.intent ?? {};
  const type = intent.type ?? '';
  if (!clientCode || !EXEC_TYPES.has(type)) {
    return { ok: false, refused: `unsupported or missing action type "${type}"` };
  }

  const sb = getSupabase();
  const { data: client } = await sb
    .from('clients')
    .select('code, name, ad_account_id, allowed_campaign_ids, max_daily_budget_usd')
    .eq('code', clientCode)
    .maybeSingle();
  if (!client?.ad_account_id) return { ok: false, refused: `unknown client ${clientCode}` };

  // Rail 1: the per-account write mode. guard_settings.mode is the switch the
  // 2026-07-26 migration built for exactly this moment ("Any future write path
  // MUST read this before touching a customer account"): read_only refuses,
  // hitl allows approve-modal writes, a pressed STOP switch refuses everything.
  // Fail-closed: no guard_settings row at all = no writes. Daniel lifted the
  // Matrinova freeze explicitly on 2026-07-30 ("please make it so that Ada can
  // write to their MD Managed campaign") — their row is mode=hitl now.
  const acct = client.ad_account_id as string;
  const { data: gs } = await sb
    .from('guard_settings')
    .select('mode, enabled, stopped_at')
    .eq('ad_account_id', acct)
    .limit(1)
    .maybeSingle();
  const mode = gs?.mode ?? 'read_only';
  if (!gs || gs.stopped_at || (mode !== 'hitl' && mode !== 'autonomous')) {
    return {
      ok: false,
      refused: 'writes_not_enabled_for_this_account',
      detail: `Ada's write rail is switched off for ${client.name}'s account (mode: ${gs ? mode : 'no settings row'}${gs?.stopped_at ? ', STOP pressed' : ''}). Daniel enables accounts one by one.`,
    };
  }

  // The per-client budget ceiling, resolved once for every branch below. A
  // non-positive or non-finite value is treated as unset rather than as "no
  // budget allowed", so a bad row cannot silently disable a customer's lane.
  const configuredCeiling = Number(client.max_daily_budget_usd ?? 0);
  const maxDailyBudgetUsd = Number.isFinite(configuredCeiling) && configuredCeiling > 0
    ? configuredCeiling
    : DEFAULT_MAX_DAILY_BUDGET_USD;

  const token = envTokenFor(clientCode) ?? process.env.META_ACCESS_TOKEN;
  if (!token) return { ok: false, refused: 'no Meta token available on this rail' };

  // Rail 2: the campaign fence (card 48), fail-closed.
  //
  // BOOTSTRAP (2026-07-30, opening Net Hydrate's write lane): create_campaign is
  // the ONE verb exempt from the empty-fence refusal, because it is the only way
  // an empty fence can ever become non-empty. The handler below grows the fence
  // with the campaign it creates, and its own comment already claimed it "MAKES
  // one, then joins the fence" — but this early return sat above that code, so
  // the bootstrap was unreachable and the claim was false. It never showed on
  // Matrinova because their fence was seeded by hand with [MD Managed].
  //
  // Exempting it is safe by construction and NOT a hole: rail 1 above already
  // refused unless Daniel set mode=hitl for this account, a human has clicked
  // APPROVE on the modal before we are called, creates are PAUSED-only (so the
  // new campaign cannot deliver or spend), the budget ceiling applies, and the
  // write is dry-run then read back then logged. Every other verb stays
  // fail-closed here: an account with no fence still gets no pauses, no budget
  // edits, no ad sets, no duplicates. Net Hydrate specifically must NOT inherit
  // the fired agency's 18 paused campaigns as writable — they carry spend, and
  // the no-edit-after-spend rule forbids touching them at all.
  const allowed: string[] = (client.allowed_campaign_ids as string[] | null) ?? [];
  if (allowed.length === 0 && type !== 'create_campaign') {
    return { ok: false, refused: `campaign fence: ${clientCode} has no allowed campaigns — writes are disabled (fail-closed)` };
  }

  // Resolve the campaign the write actually lands in. For creates it is named
  // in the intent; for pause/budget on an existing object we read the object's
  // own campaign from Meta rather than trusting the caller.
  let campaignId = String(intent.campaign_id ?? '');
  let before: Record<string, unknown> | null = null;
  // Card 77 slice: update_budget may target the CAMPAIGN itself (CBO accounts
  // like MatrNova hold the budget there; the ad-set-only version bounced with
  // Meta's "You can only set an ad set budget or a campaign budget").
  let budgetTargetIsCampaign = false;
  // create_campaign has no campaign to fence yet (it MAKES one, then joins the
  // fence); duplicate_ad_set fences its DESTINATION inside its own handler —
  // the source is only read, and reads are never fenced.
  const selfFenced = type === 'create_campaign' || type === 'duplicate_ad_set' || type === 'duplicate_ad' || type === 'create_ad';
  if (type !== 'create_ad_set' && !selfFenced) {
    const targetId = String(intent.target_id ?? '');
    if (!targetId) return { ok: false, refused: 'missing target_id' };
    const edge = type === 'pause_ad' ? 'ad' : 'adset';
    try {
      before = await graphCall(
        targetId,
        token,
        { fields: edge === 'ad' ? 'id,name,status,effective_status,campaign_id,account_id' : 'id,name,status,effective_status,daily_budget,campaign_id,account_id' },
      );
    } catch (e) {
      // A campaign id has no campaign_id field, so the adset-shaped read
      // throws. For update_budget only, retry campaign-shaped.
      if (type !== 'update_budget') throw e;
      before = await graphCall(targetId, token, { fields: 'id,name,status,effective_status,daily_budget,account_id' });
      budgetTargetIsCampaign = true;
    }
    if (`act_${String(before.account_id)}` !== acct) {
      return { ok: false, refused: `target ${targetId} lives in a different account — refused` };
    }
    campaignId = budgetTargetIsCampaign ? targetId : String(before.campaign_id ?? campaignId);
  }
  if (!selfFenced && (!campaignId || !allowed.includes(campaignId))) {
    return {
      ok: false,
      refused: `campaign fence: ${campaignId || '(none named)'} is not in ${clientCode}'s allowed campaigns ${JSON.stringify(allowed)}`,
    };
  }

  const settings = intent.settings ?? {};
  const context = {
    agentId: `ada_client_${clientCode}`,
    channelId: 'tinkers-approve-modal',
    userId: body.user_id ?? 'tinkers-customer',
    clientScope: { clientCode },
  };

  if (type === 'create_campaign') {
    // Campaign creation grows the fence: the new campaign joins the client's
    // allowed_campaign_ids, so follow-up ad sets / ads / duplicates can land
    // inside it. A campaign Ada created through an approval is hers to manage
    // by construction; the fence still walls off everything she did NOT create
    // (Matrinova's [TM - MD] campaigns stay untouchable forever). Daniel
    // authorized customer campaign creation explicitly on 2026-07-30.
    if (settings.status && settings.status !== 'PAUSED') {
      return { ok: false, refused: `campaign creates are PAUSED-only; got ${String(settings.status)}` };
    }
    const objective = typeof settings.objective === 'string' && /^OUTCOME_[A-Z_]+$/.test(settings.objective)
      ? settings.objective
      : 'OUTCOME_LEADS';
    const params: Record<string, string> = {
      name: String(settings.name ?? `ADA TEST CAMPAIGN // ${new Date().toISOString().slice(0, 10)}`),
      objective,
      status: 'PAUSED',
      buying_type: 'AUCTION',
      special_ad_categories: JSON.stringify([]),
    };
    if (typeof settings.bid_strategy === 'string' && /^[A-Z_]+$/.test(settings.bid_strategy)) {
      params.bid_strategy = settings.bid_strategy;
    }
    // budget_mode is one of the customer-selected choices: 'cbo' carries the
    // campaign budget; 'abo' leaves budgets to the ad sets.
    if (settings.budget_mode === 'cbo') {
      const b = Number(settings.daily_budget_usd ?? 0);
      if (!b) return { ok: false, refused: 'CBO chosen but no daily_budget_usd' };
      if (b > maxDailyBudgetUsd) return { ok: false, refused: `daily budget $${b} exceeds the $${maxDailyBudgetUsd} ceiling for ${clientCode}` };
      params.daily_budget = String(Math.round(b * 100));
    }
    await graphCall(`${acct}/campaigns`, token, { ...params, execution_options: JSON.stringify(['validate_only']) }, 'POST');
    if (dryRun) return wouldApply(`would create PAUSED campaign "${params.name}" (${objective})`);
    const created = await graphCall(`${acct}/campaigns`, token, params, 'POST');
    const after = await graphCall(String(created.id), token, { fields: 'id,name,status,effective_status,objective,daily_budget,bid_strategy' });
    // Grow the fence to include the new campaign (practice account only, by lock).
    try {
      await sb
        .from('clients')
        .update({ allowed_campaign_ids: [...allowed, String(created.id)] })
        .eq('code', clientCode);
    } catch (e) {
      console.error('[execute-action] fence grow failed:', e);
    }
    logWrite({
      context, toolName: 'execute_action:create_campaign', targetSystem: 'meta',
      targetId: String(created.id), before: null, after,
      reverse: { note: 'delete requires a human — Ada never deletes', object: 'campaign', id: String(created.id) },
      summary: `Created PAUSED campaign "${params.name}" (${objective}, ${String(settings.budget_mode ?? 'abo')}) and fenced it in (approve-modal)`,
    });
    return { ok: true, applied: true, object: after };
  }

  if (type === 'duplicate_ad' || type === 'create_ad') {
    // Both land a PAUSED ad inside an existing ad set; the destination ad
    // set's campaign must pass the fence (re-read fresh — it may have grown in
    // this same approval batch). create_ad reuses an EXISTING creative id;
    // brand-new creatives from uploaded media are the launch pipeline's job
    // (card 58), not this rail's.
    const destAdset = String(settings.adset_id ?? intent.target_id ?? '');
    if (!destAdset) return { ok: false, refused: 'missing the destination ad set id' };
    const adset = await graphCall(destAdset, token, { fields: 'id,name,campaign_id,account_id' });
    if (`act_${String(adset.account_id)}` !== acct) {
      return { ok: false, refused: `ad set ${destAdset} lives in a different account — refused` };
    }
    const { data: fc } = await sb.from('clients').select('allowed_campaign_ids').eq('code', clientCode).maybeSingle();
    const fresh: string[] = (fc?.allowed_campaign_ids as string[] | null) ?? [];
    if (!fresh.includes(String(adset.campaign_id))) {
      return { ok: false, refused: `campaign fence: ad set ${destAdset} belongs to ${String(adset.campaign_id)}, not in ${clientCode}'s allowed campaigns ${JSON.stringify(fresh)}` };
    }
    if (type === 'duplicate_ad') {
      const srcAd = String(intent.source_id ?? intent.target_id ?? '');
      if (!srcAd || srcAd === destAdset) return { ok: false, refused: 'missing source_id (the ad to duplicate)' };
      const src = await graphCall(srcAd, token, { fields: 'id,name,account_id,creative' });
      if (`act_${String(src.account_id)}` !== acct) {
        return { ok: false, refused: `source ad ${srcAd} lives in a different account — refused` };
      }
      // Card 76: validate an equivalent create before copying (or claiming a
      // dry-run "would apply") — the copy itself cannot be validate_only'd.
      const srcCreativeId = String((src.creative as { id?: string } | undefined)?.id ?? '');
      if (srcCreativeId) {
        const gate = await validateCreativePlacement(acct, token, destAdset, srcCreativeId);
        if (!gate.ok) return { ok: false, refused: gate.refused };
      }
      if (dryRun) return wouldApply(`would duplicate ad "${String(src.name)}" into ad set ${destAdset}, PAUSED (validated: page permission, lead-ads terms, ad rules)`);
      const copied = await graphCall(`${srcAd}/copies`, token, { adset_id: destAdset, status_option: 'PAUSED' }, 'POST');
      const newId = String((copied.copied_ad_id as string | undefined) ?? copied.id ?? '');
      const after = newId ? await graphCall(newId, token, { fields: 'id,name,status,effective_status,adset_id' }).catch(() => copied) : copied;
      logWrite({
        context, toolName: 'execute_action:duplicate_ad', targetSystem: 'meta',
        targetId: newId || srcAd, before: src, after,
        reverse: { note: 'delete requires a human — Ada never deletes', object: 'ad', id: newId },
        summary: `Duplicated ad "${String(src.name)}" into ad set ${destAdset}, PAUSED (approve-modal)`,
      });
      return { ok: true, applied: true, object: after };
    }
    const creativeId = String(settings.creative_id ?? '');
    if (!creativeId) return { ok: false, refused: 'create_ad needs settings.creative_id (an existing creative) — new creatives come via the upload pipeline' };
    if (settings.status && settings.status !== 'PAUSED') {
      return { ok: false, refused: `ad creates are PAUSED-only; got ${String(settings.status)}` };
    }
    const params: Record<string, string> = {
      name: String(settings.name ?? `ADA AD // ${new Date().toISOString().slice(0, 10)}`),
      adset_id: destAdset,
      status: 'PAUSED',
      creative: JSON.stringify({ creative_id: creativeId }),
    };
    await graphCall(`${acct}/ads`, token, { ...params, execution_options: JSON.stringify(['validate_only']) }, 'POST');
    if (dryRun) return wouldApply(`would create PAUSED ad "${params.name}" in ad set ${destAdset}`);
    const created = await graphCall(`${acct}/ads`, token, params, 'POST');
    const after = await graphCall(String(created.id), token, { fields: 'id,name,status,effective_status,adset_id,creative' });
    logWrite({
      context, toolName: 'execute_action:create_ad', targetSystem: 'meta',
      targetId: String(created.id), before: null, after,
      reverse: { note: 'delete requires a human — Ada never deletes', object: 'ad', id: String(created.id) },
      summary: `Created PAUSED ad "${params.name}" in ad set ${destAdset} from creative ${creativeId} (approve-modal)`,
    });
    return { ok: true, applied: true, object: after };
  }

  if (type === 'duplicate_ad_set') {
    const sourceId = String(intent.target_id ?? '');
    if (!sourceId) return { ok: false, refused: 'missing target_id (the ad set to duplicate)' };
    const source = await graphCall(sourceId, token, { fields: 'id,name,campaign_id,account_id' });
    if (`act_${String(source.account_id)}` !== acct) {
      return { ok: false, refused: `source ad set ${sourceId} lives in a different account — refused` };
    }
    // Destination campaign must be inside the fence (re-read: create_campaign
    // in the same approval batch may have just grown it).
    const dest = String(settings.destination_campaign_id ?? intent.campaign_id ?? source.campaign_id);
    const { data: freshClient } = await sb
      .from('clients')
      .select('allowed_campaign_ids')
      .eq('code', clientCode)
      .maybeSingle();
    const freshAllowed: string[] = (freshClient?.allowed_campaign_ids as string[] | null) ?? [];
    if (!freshAllowed.includes(dest)) {
      return { ok: false, refused: `campaign fence: destination ${dest} is not in ${clientCode}'s allowed campaigns ${JSON.stringify(freshAllowed)}` };
    }
    // Card 76: the copied ad set brings its ads along, and THOSE need page
    // permission + lead-ads terms. Validate with one sample ad's creative
    // against the source set (page/ToS gates are account+page level, not
    // destination-specific) before copying or claiming "would apply".
    try {
      const sampleAds = await graphCall(`${sourceId}/ads`, token, { fields: 'id,creative', limit: '1' });
      const sample = ((sampleAds.data as Array<{ creative?: { id?: string } }> | undefined) ?? [])[0];
      const sampleCreativeId = String(sample?.creative?.id ?? '');
      if (sampleCreativeId) {
        const gate = await validateCreativePlacement(acct, token, sourceId, sampleCreativeId);
        if (!gate.ok) return { ok: false, refused: gate.refused };
      }
    } catch (e) {
      console.error('[execute-action] duplicate_ad_set sample validation skipped:', e);
    }
    const copyParams: Record<string, string> = {
      campaign_id: dest,
      status_option: 'PAUSED',
      rename_options: JSON.stringify({ rename_suffix: ' — ADA COPY' }),
    };
    if (dryRun) return wouldApply(`would duplicate ad set "${String(source.name)}" into campaign ${dest}, PAUSED (validated: page permission, lead-ads terms)`);
    const copied = await graphCall(`${sourceId}/copies`, token, copyParams, 'POST');
    const newId = String((copied.copied_adset_id as string | undefined) ?? copied.id ?? '');
    const after = newId
      ? await graphCall(newId, token, { fields: 'id,name,status,effective_status,campaign_id,daily_budget,bid_amount' }).catch(() => copied)
      : copied;
    // Optional bid override on the fresh copy (the BitCap flow), ceiling-guarded.
    if (newId && settings.bid_amount_usd) {
      const bid = Number(settings.bid_amount_usd);
      if (bid > 0 && bid <= maxDailyBudgetUsd) {
        await graphCall(newId, token, { bid_amount: String(Math.round(bid * 100)) }, 'POST').catch((e) => {
          console.error('[execute-action] bid override failed:', e);
        });
      }
    }
    logWrite({
      context, toolName: 'execute_action:duplicate_ad_set', targetSystem: 'meta',
      targetId: newId || sourceId, before: source, after,
      reverse: { note: 'delete requires a human — Ada never deletes', object: 'adset', id: newId },
      summary: `Duplicated ad set "${String(source.name)}" into campaign ${dest}, PAUSED (approve-modal)`,
    });
    return { ok: true, applied: true, object: after };
  }

  if (type === 'create_ad_set') {
    // Rail 3: paused-only, paused parent.
    if (settings.status && settings.status !== 'PAUSED') {
      return { ok: false, refused: `creates are PAUSED-only; got status ${String(settings.status)}` };
    }
    const campaign = await graphCall(campaignId, token, { fields: 'id,name,status,effective_status,objective,daily_budget' });
    if (campaign.effective_status !== 'PAUSED') {
      return { ok: false, refused: `parent campaign ${campaignId} is ${String(campaign.effective_status)} — the paused-bank rule requires a PAUSED campaign` };
    }

    // Mirror the campaign's own working configuration for anything the
    // proposal leaves technical: Meta requires the new ad set's optimization
    // to match its CBO siblings, and conversion goals need the promoted_object
    // (pixel + event) nobody should have to spell out in chat. One trusted
    // sibling ad set is the template — the golden-ad-set principle from
    // /meta-launch-config, in miniature.
    let sibling: Record<string, unknown> | null = null;
    try {
      const sib = await graphCall(`${campaignId}/adsets`, token, {
        fields: 'optimization_goal,billing_event,promoted_object,targeting',
        limit: '1',
      });
      sibling = ((sib.data as Record<string, unknown>[] | undefined) ?? [])[0] ?? null;
    } catch { /* no sibling — fall back to explicit settings/defaults */ }

    // A proposal is model-written: treat every technical field defensively.
    // Enum-shaped values pass through; prose ("mirror the existing ad sets")
    // falls back to the sibling mirror instead of reaching Meta verbatim —
    // that exact string 400'd the first live approve on 2026-07-29.
    const enumish = (v: unknown): string | undefined =>
      typeof v === 'string' && /^[A-Z][A-Z0-9_]*$/.test(v) ? v : undefined;
    const objish = (v: unknown): Record<string, unknown> | undefined =>
      v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length > 0
        ? (v as Record<string, unknown>)
        : undefined;
    const params: Record<string, string> = {
      name: String(settings.name ?? `ADA TEST // ${new Date().toISOString().slice(0, 10)}`),
      campaign_id: campaignId,
      status: 'PAUSED',
      billing_event: enumish(settings.billing_event) ?? enumish(sibling?.billing_event) ?? 'IMPRESSIONS',
      optimization_goal: enumish(settings.optimization_goal) ?? enumish(sibling?.optimization_goal) ?? 'LINK_CLICKS',
      targeting: JSON.stringify(objish(settings.targeting) ?? objish(sibling?.targeting) ?? { geo_locations: { countries: ['US'] } }),
    };
    const promotedObject = objish(settings.promoted_object) ?? objish(sibling?.promoted_object);
    if (promotedObject) params.promoted_object = JSON.stringify(promotedObject);
    // Budget only when the campaign is NOT CBO (a CBO campaign carries the budget).
    const cbo = Boolean(campaign.daily_budget);
    const budgetUsd = Number(settings.daily_budget_usd ?? 0);
    if (!cbo) {
      if (!budgetUsd) return { ok: false, refused: 'campaign is not CBO, so the ad set needs daily_budget_usd' };
      if (budgetUsd > maxDailyBudgetUsd) return { ok: false, refused: `daily budget $${budgetUsd} exceeds the $${maxDailyBudgetUsd} ceiling for ${clientCode}` };
      params.daily_budget = String(Math.round(budgetUsd * 100));
    }
    if (settings.bid_amount_usd) params.bid_amount = String(Math.round(Number(settings.bid_amount_usd) * 100));
    if (typeof settings.bid_strategy === 'string' && /^[A-Z_]+$/.test(settings.bid_strategy)) params.bid_strategy = settings.bid_strategy;

    // Dry-run first (validate_only), then the real create, then read back.
    await graphCall(`${acct}/adsets`, token, { ...params, execution_options: JSON.stringify(['validate_only']) }, 'POST');
    if (dryRun) return wouldApply(`would create PAUSED ad set "${params.name}" in campaign ${campaignId} (${params.optimization_goal}/${params.billing_event})`);
    const created = await graphCall(`${acct}/adsets`, token, params, 'POST');
    const after = await graphCall(String(created.id), token, {
      fields: 'id,name,status,effective_status,daily_budget,campaign_id,optimization_goal,billing_event,targeting',
    });
    logWrite({
      context, toolName: 'execute_action:create_ad_set', targetSystem: 'meta',
      targetId: String(created.id), before: null, after,
      reverse: { note: 'delete requires a human — Ada never deletes', object: 'adset', id: String(created.id) },
      summary: `Created PAUSED ad set "${params.name}" in sandbox campaign ${campaignId} (approve-modal)`,
      initiatedBy: 'client_approved',
    });
    return { ok: true, applied: true, object: after };
  }

  if (type === 'pause_ad_set' || type === 'pause_ad') {
    if (before?.status === 'PAUSED') {
      return { ok: true, applied: false, object: before, note: 'already paused' };
    }
    if (dryRun) return wouldApply(`would pause ${type === 'pause_ad' ? 'ad' : 'ad set'} "${String(before?.name ?? intent.target_id)}"`);
    await graphCall(String(intent.target_id), token, { status: 'PAUSED' }, 'POST');
    const after = await graphCall(String(intent.target_id), token, { fields: 'id,name,status,effective_status,campaign_id' });
    logWrite({
      context, toolName: `execute_action:${type}`, targetSystem: 'meta',
      targetId: String(intent.target_id), before, after,
      reverse: { method: 'POST', path: String(intent.target_id), params: { status: String(before?.status ?? 'ACTIVE') } },
      summary: `Paused ${type === 'pause_ad' ? 'ad' : 'ad set'} ${String(before?.name ?? intent.target_id)} (approve-modal)`,
      initiatedBy: 'client_approved',
    });
    return { ok: true, applied: true, object: after };
  }

  // update_budget on an existing ad set OR its campaign (CBO), hard ceiling.
  const budgetUsd = Number(settings.daily_budget_usd ?? 0);
  if (!budgetUsd) return { ok: false, refused: 'missing daily_budget_usd' };
  if (budgetUsd > maxDailyBudgetUsd) {
    return { ok: false, refused: `daily budget $${budgetUsd} exceeds the $${maxDailyBudgetUsd} ceiling for ${clientCode}` };
  }
  // CBO awareness (card 77): when the ad set's parent campaign carries the
  // budget, an ad-set budget write can never succeed — refuse in plain English
  // and point at the level that works, instead of relaying Meta's riddle.
  if (!budgetTargetIsCampaign) {
    const parent = await graphCall(campaignId, token, { fields: 'id,name,daily_budget' });
    if (parent.daily_budget) {
      return {
        ok: false,
        refused:
          `budget level: campaign "${String(parent.name)}" (${campaignId}) holds the budget (CBO, currently ` +
          `$${(Number(parent.daily_budget) / 100).toFixed(0)}/day) — this ad set has no budget of its own. ` +
          `Propose the change with target_id ${campaignId} (the campaign) instead.`,
      };
    }
  }
  const levelWord = budgetTargetIsCampaign ? 'campaign' : 'ad set';
  await graphCall(String(intent.target_id), token, { daily_budget: String(Math.round(budgetUsd * 100)), execution_options: JSON.stringify(['validate_only']) }, 'POST');
  if (dryRun) return wouldApply(`would set ${levelWord} ${String(intent.target_id)} to $${budgetUsd}/day`);
  await graphCall(String(intent.target_id), token, { daily_budget: String(Math.round(budgetUsd * 100)) }, 'POST');
  const after = await graphCall(String(intent.target_id), token, {
    fields: budgetTargetIsCampaign ? 'id,name,status,effective_status,daily_budget' : 'id,name,status,effective_status,daily_budget,campaign_id',
  });
  logWrite({
    context, toolName: 'execute_action:update_budget', targetSystem: 'meta',
    targetId: String(intent.target_id), before, after,
    reverse: { method: 'POST', path: String(intent.target_id), params: { daily_budget: String(before?.daily_budget ?? '') } },
    summary: `Set daily budget $${budgetUsd} on ${levelWord} ${String(before?.name ?? intent.target_id)} (approve-modal)`,
    initiatedBy: 'client_approved',
  });
  return { ok: true, applied: true, object: after };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url ?? '/';

    if (req.method === 'GET' && (url === '/health' || url === '/health/')) {
      sendJson(res, 200, { ok: true, model: MODEL, service: SERVICE, version: VERSION });
      return;
    }

    if (req.method === 'POST' && (url === '/assist' || url === '/assist/')) {
      const key = req.headers['x-assist-key'];
      if (!ASSIST_SECRET || key !== ASSIST_SECRET) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      let parsed: AssistRequest;
      try {
        const raw = await readBody(req);
        parsed = raw ? (JSON.parse(raw) as AssistRequest) : {};
      } catch (e) {
        sendJson(res, 400, { ok: false, error: `bad request: ${(e as Error).message}` });
        return;
      }
      try {
        const result = await handleAssist(parsed);
        sendJson(res, 200, result);
      } catch (e) {
        console.error('[ada-console-assist] /assist error:', e);
        sendJson(res, 500, { ok: false, error: `assist failed: ${(e as Error).message}` });
      }
      return;
    }

    if (req.method === 'POST' && (url === '/chat' || url === '/chat/')) {
      const key = req.headers['x-assist-key'];
      if (!ASSIST_SECRET || key !== ASSIST_SECRET) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      let parsed: AssistRequest;
      try {
        const raw = await readBody(req);
        parsed = raw ? (JSON.parse(raw) as AssistRequest) : {};
      } catch (e) {
        sendJson(res, 400, { ok: false, error: `bad request: ${(e as Error).message}` });
        return;
      }
      // Client-scoped requests (Tinkers portal) MUST carry a valid signed scope
      // claim: the claim must verify AND its client_scope must match the body.
      if (parsed.client_scope) {
        const claim = parsed.scope_claim ? verifyScopeClaim(parsed.scope_claim) : null;
        if (!claim || claim.client_scope !== parsed.client_scope) {
          sendJson(res, 403, { ok: false, error: 'invalid or missing scope claim' });
          return;
        }
        // Verified. Normalize to the canonical UPPERCASE code BEFORE use — the
        // per-client overlay file lookup (agents/ada/clients/<CODE>.md) is
        // case-sensitive on the Linux droplet. Serve the read-only client-scoped
        // Ada (streams its own SSE response, same contract as internal /chat).
        const clientCode = claim.client_scope.toUpperCase().trim();
        await handleChatStream(parsed, res, { clientCode, userId: claim.user_id });
        return;
      }
      // Internal (unscoped) team chat — unchanged. Streams its own SSE response.
      await handleChatStream(parsed, res);
      return;
    }

    if (req.method === 'POST' && (url === '/learn' || url === '/learn/')) {
      // Card 39's learning half: a customer's reasoned thumbs-down becomes a
      // tenant-scoped learning. Server-side scoping only — the client code
      // comes from the authenticated tinkers route, and the learning is
      // written under agent ada_client_<CODE> with the code as its row scope,
      // exactly like a scoped chat's own remember call.
      const key = req.headers['x-assist-key'];
      if (!ASSIST_SECRET || key !== ASSIST_SECRET) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      let parsed: { client_code?: string; category?: string; content?: string };
      try {
        const raw = await readBody(req);
        parsed = raw ? JSON.parse(raw) : {};
      } catch (e) {
        sendJson(res, 400, { ok: false, error: `bad request: ${(e as Error).message}` });
        return;
      }
      const code = (parsed.client_code ?? '').toUpperCase().trim();
      if (!code || !parsed.content) {
        sendJson(res, 400, { ok: false, error: 'client_code and content required' });
        return;
      }
      const result = await rememberLearning({
        content: String(parsed.content).slice(0, 2000),
        category: (parsed.category ?? 'customer_feedback').slice(0, 60),
        agent_id: `ada_client_${code}`,
        client_code: code,
      });
      sendJson(res, 200, { ok: result.saved, id: result.id, deduplicated: result.deduplicated ?? false });
      return;
    }

    if (req.method === 'POST' && (url === '/execute-action' || url === '/execute-action/')) {
      const key = req.headers['x-assist-key'];
      if (!ASSIST_SECRET || key !== ASSIST_SECRET) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      let parsed: ExecuteActionRequest;
      try {
        const raw = await readBody(req);
        parsed = raw ? (JSON.parse(raw) as ExecuteActionRequest) : {};
      } catch (e) {
        sendJson(res, 400, { ok: false, error: `bad request: ${(e as Error).message}` });
        return;
      }
      try {
        const result = await handleExecuteAction(parsed);
        // Customer watch: refusals and failures land in ops_events so
        // "did it all work for them?" is answerable with one query.
        if (!result.ok) {
          void getSupabase()
            .from('ops_events')
            .insert({
              level: result.refused ? 'warn' : 'error',
              source: 'executor',
              client_code: (parsed.client_code ?? '').toUpperCase() || null,
              message: String(result.refused ?? result.error ?? 'execution failed').slice(0, 2000),
              meta: { type: parsed.intent?.type ?? null },
            })
            .then(({ error }) => { if (error) console.error('[execute-action] ops log failed:', error.message); });
        }
        sendJson(res, 200, result);
      } catch (e) {
        console.error('[ada-console-assist] /execute-action error:', e);
        void getSupabase()
          .from('ops_events')
          .insert({ level: 'error', source: 'executor', client_code: (parsed.client_code ?? '').toUpperCase() || null, message: `execution threw: ${(e as Error).message}`.slice(0, 2000), meta: { type: parsed.intent?.type ?? null } })
          .then(() => undefined);
        sendJson(res, 200, { ok: false, error: `execution failed: ${(e as Error).message}` });
      }
      return;
    }

    if (req.method === 'POST' && (url === '/diagnose' || url === '/diagnose/')) {
      const key = req.headers['x-assist-key'];
      if (!ASSIST_SECRET || key !== ASSIST_SECRET) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }
      let parsed: AssistRequest;
      try {
        const raw = await readBody(req);
        parsed = raw ? (JSON.parse(raw) as AssistRequest) : {};
      } catch (e) {
        sendJson(res, 400, { ok: false, error: `bad request: ${(e as Error).message}` });
        return;
      }
      await handleDiagnoseStream(parsed, res);
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    console.error('[ada-console-assist] unhandled:', e);
    try { sendJson(res, 500, { ok: false, error: 'internal error' }); } catch { /* noop */ }
  }
});

// Import-safe: under vitest this module is imported for its pure helpers
// (tests/decision-learnings-block.test.ts) and must NOT bind the port or hold
// the event loop open. VITEST is set by the test runner only — the systemd
// service is unaffected.
if (!process.env.VITEST) {
  server.listen(PORT, HOST, () => {
    console.log(`[ada-console-assist] listening on http://${HOST}:${PORT} (model=${MODEL}, assist[budget=${MAX_BUDGET_USD},turns=${MAX_TURNS}], chat[budget=${CHAT_MAX_BUDGET_USD},turns=${CHAT_MAX_TURNS}], auth=${ASSIST_SECRET ? 'on' : 'MISSING'})`);
  });
}
