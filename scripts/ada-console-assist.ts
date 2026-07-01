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
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { runAgentSDK } from '../src/agents/sdk/runAgentSDK.js';
import { getAgent } from '../src/agents/registry.js';

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

const MAX_BUDGET_USD = Number(process.env.ADA_ASSIST_MAX_BUDGET ?? 1.5);
const MAX_TURNS = Number(process.env.ADA_ASSIST_MAX_TURNS ?? 15);

// Chat (the full-page /launch/ada surface) gets a slightly higher ceiling than
// the one-shot error /assist — a real conversation may run a few read tools.
const CHAT_MAX_BUDGET_USD = Number(process.env.ADA_CHAT_MAX_BUDGET ?? 2.0);
const CHAT_MAX_TURNS = Number(process.env.ADA_CHAT_MAX_TURNS ?? 24);

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

/** Build the chat framing message. Deliberately NOT error-shaped — a data
 *  question gets a data answer, never a "nothing to fix" button. */
function buildChatPrompt(req: AssistRequest, ledgerEvents: LedgerEvent[] = [], recentLedger: RecentLedgerEvent[] = []): string {
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

  parts.push(
    `### When the operator corrects or teaches you, SAVE it (remember) — then CONFIRM the save\n` +
    `Chat corrections do NOT persist on their own — they vanish when this session ends. So when the operator corrects you, states a preference for how to analyze/report, or teaches you a durable fact about a client or the account, CALL **remember** to store it as a learning (pass client_code when it's client-specific; omit it for a general analysis principle). The remember tool returns the saved record. ONLY after that call succeeds, end your reply with an explicit, PAST-TENSE confirmation that quotes back what you saved — e.g. \`✅ Saved to memory — "<the exact generalized learning>" (TL)\` — so the operator can see it's been written, not merely promised. Do NOT say a vague "I'll remember that", and NEVER claim you saved something if the remember call didn't actually run or it errored — say so plainly and retry instead. That confirmed save is the ONLY way it carries into future sessions. Save the GENERALIZED rule, not the one-off phrasing; skip ephemeral chit-chat and anything already in your Key Learnings.`,
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

async function handleChatStream(req: AssistRequest, res: http.ServerResponse): Promise<void> {
  const threadTs = req.session_id || `chat-${randomUUID()}`;
  const channelId = `launch-ada-chat-${req.context?.client_code ?? 'x'}`;
  const [ledgerEvents, recentLedger] = await Promise.all([
    fetchLedger(req.context?.asset_code),
    fetchRecentLedger(),
  ]);

  sseHead(res);
  sseEvent(res, 'meta', { session_id: threadTs });

  let closed = false;
  res.on('close', () => { closed = true; });
  const heartbeat = setInterval(() => { if (!closed) { try { res.write(': ping\n\n'); } catch { /* noop */ } } }, 15_000);
  const safe = (event: string, data: unknown) => { if (!closed) { try { sseEvent(res, event, data); } catch { /* noop */ } } };

  let fullText = '';
  let costUsd = 0;
  let toolsUsed: string[] = [];
  // Honest done (Ada 2.0): the SDK's authoritative result subtype. 'unknown'
  // means the stream died before a result message — NEVER treated as success.
  let subtype = 'unknown';

  try {
    await runAgentSDK(
      {
        source: 'api-console-chat',
        agentId: 'ada',
        userMessage: buildChatPrompt(req, ledgerEvents, recentLedger),
        userId: 'launch-console',
        channelId,
        threadTs,
        onText: (t) => { fullText += t; safe('text', { text: t }); },
        onThinking: (t) => safe('thinking', { text: t }),
        onToolUse: (name) => safe('tool', { name, label: toolLabel(name) }),
        onTurnReset: () => { fullText = ''; safe('reset', {}); },
      },
      {
        // Full production-write parity (Dan, 2026-06-20): the web /launch/ada chat is
        // now the team's MAIN Ada, so it gets the same legitimate write surface as the
        // Slack media_buyer Ada — Notion task writes, media uploads, paused-bank
        // launches, Slack posts, learning/decision edits (guard.ts PRODUCTION_WRITES).
        // The load-bearing rails are below the guard and ALWAYS on: launch_ads/
        // upload_to_media_library create PAUSED-bank-only objects via SafeMetaAPI (zero
        // spend; a human enables to go live), and the delete rail hard-blocks every
        // delete in any mode. NOT allowProductionWrites + paused-launch test flags —
        // those test-client gates aren't needed once allowProductionWrites is on.
        policy: { allowProductionWrites: true },
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
      session_id: threadTs, cost_usd: round(costUsd),
      used_skills: inferUsedSkills(fullText, toolsUsed),
      ok, subtype, ...(ok ? {} : { error: `runner subtype=${subtype}` }),
    });
  } catch (e) {
    console.error('[ada-console-assist] /chat error:', e);
    const errMsg = (e as Error).message || 'chat failed';
    safe('error', { error: errMsg });
    safe('done', { session_id: threadTs, cost_usd: round(costUsd), used_skills: [], ok: false, subtype: subtype === 'unknown' ? 'exception' : subtype, error: errMsg });
  } finally {
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
      // Streams its own SSE response (never sendJson on success).
      await handleChatStream(parsed, res);
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

server.listen(PORT, HOST, () => {
  console.log(`[ada-console-assist] listening on http://${HOST}:${PORT} (model=${MODEL}, assist[budget=${MAX_BUDGET_USD},turns=${MAX_TURNS}], chat[budget=${CHAT_MAX_BUDGET_USD},turns=${CHAT_MAX_TURNS}], auth=${ASSIST_SECRET ? 'on' : 'MISSING'})`);
});
