/**
 * Ada eval harness — runs the golden questions through the real agent loop, then
 * GRADES each response against its rubric with an LLM judge (Ada 2.0 Phase 1).
 *
 *   pnpm exec tsx scripts/eval-ada.ts                       # all, SDK loop, judged
 *   pnpm exec tsx scripts/eval-ada.ts --only jva-minicourse-launch
 *   pnpm exec tsx scripts/eval-ada.ts --runner slack       # the hand-rolled runner
 *   pnpm exec tsx scripts/eval-ada.ts --no-judge           # capture only (old behaviour)
 *   pnpm exec tsx scripts/eval-ada.ts --target http        # hit the LIVE /chat SSE endpoint
 *
 * Runs are sequential (live Opus + live tools — costs real money and a few
 * minutes). Results land in tests/eval/runs/<timestamp>.json. Sessions use
 * internal-eval-* channel ids so no Slack context is injected and nothing posts
 * to Slack. Writes are denied (default guard policy) — this is a read/reasoning
 * net, not a launch test.
 *
 * --target in-process (DEFAULT) drives runAgentSDK in this process. --target http
 * sends each question to the LIVE ada-console-assist /chat SSE endpoint (the exact
 * production surface team-Ada runs on) — set ADA_ASSIST_SECRET (X-Assist-Key) and
 * optionally ADA_CHAT_URL (default http://localhost:8092/chat). It accumulates the
 * `text` events and records the server's honest done.ok/subtype + cost_usd.
 *
 * --runner sdk (DEFAULT, in-process only) drives runAgentSDK — the loop web-Ada
 * actually runs (per the 2026-06-28 "one Ada brain" decision: eval what ships). It
 * needs the skills dir; set ADA_SDK_SKILLS_CWD locally (defaults to the droplet path).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { runAgent } from '../src/agents/runner.js';
import { runAgentSDK } from '../src/agents/sdk/runAgentSDK.js';
import { buildJudgePrompt, parseJudgeVerdict, type JudgeVerdict } from '../src/agents/sdk/eval-judge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = join(__dirname, '..', 'tests', 'eval');

interface GoldenQuestion {
  id: string;
  question: string;
  expect: string;
}

const { questions } = JSON.parse(
  readFileSync(join(EVAL_DIR, 'golden-questions.json'), 'utf-8'),
) as { questions: GoldenQuestion[] };

const argv = process.argv;
const onlyArg = argv.find((a) => a.startsWith('--only'));
const onlyIds = onlyArg
  ? new Set((argv[argv.indexOf(onlyArg) + 1] ?? onlyArg.split('=')[1] ?? '').split(','))
  : null;
const runner = (argv.includes('--runner') ? argv[argv.indexOf('--runner') + 1] : 'sdk') as 'sdk' | 'slack';
const target = (argv.includes('--target') ? argv[argv.indexOf('--target') + 1] : 'in-process') as 'in-process' | 'http';
const doJudge = !argv.includes('--no-judge');
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? 'claude-opus-4-8';

const CHAT_URL = process.env.ADA_CHAT_URL ?? 'http://localhost:8092/chat';
const ASSIST_SECRET = process.env.ADA_ASSIST_SECRET ?? '';
const HTTP_TIMEOUT_MS = Number(process.env.EVAL_HTTP_TIMEOUT_MS ?? 180_000);

if (target === 'http' && !ASSIST_SECRET) {
  console.error('--target http needs ADA_ASSIST_SECRET in env (X-Assist-Key for the /chat endpoint).');
  process.exit(1);
}

interface ChatTurn { response: string; ok: boolean; subtype: string; costUsd: number; }

/**
 * Drive one golden question through the LIVE /chat SSE endpoint. Accumulates
 * `text` events (resetting on `reset`, mirroring the server's own fullText
 * reset so the captured answer matches what the client renders), and reads the
 * honest done frame (ok/subtype/cost_usd). This tests the EXACT production surface.
 */
async function askViaHttp(question: string, sessionId: string): Promise<ChatTurn> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  let response = '';
  let ok = false;
  let subtype = 'unknown';
  let costUsd = 0;
  try {
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Assist-Key': ASSIST_SECRET },
      body: JSON.stringify({ question, session_id: sessionId }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new Error(`/chat HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      let sep;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let event = 'message';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
          // lines starting with ':' are comments (heartbeats) — ignore.
        }
        if (!data) continue;
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
        if (event === 'text' && typeof payload.text === 'string') response += payload.text;
        else if (event === 'reset') response = '';
        else if (event === 'done') {
          ok = payload.ok === true;
          subtype = String(payload.subtype ?? 'unknown');
          costUsd = Number(payload.cost_usd ?? 0);
        } else if (event === 'error' && typeof payload.error === 'string' && !response) {
          response = `[chat error] ${payload.error}`;
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return { response, ok, subtype, costUsd };
}

const selected = onlyIds ? questions.filter((q) => onlyIds.has(q.id)) : questions;
if (selected.length === 0) {
  console.error('No questions selected. Ids:', questions.map((q) => q.id).join(', '));
  process.exit(1);
}

const anthropic = doJudge ? new Anthropic() : null;

async function judge(q: GoldenQuestion, response: string): Promise<JudgeVerdict> {
  if (!anthropic) return { verdict: 'pass', reason: '(judging disabled)', principles_violated: [] };
  try {
    const msg = await anthropic.messages.create({
      model: JUDGE_MODEL,
      // 400 was too tight: an Opus judge writing long reasoning hit the cap
      // before the trailing JSON → fail-safe "unparseable" (catalog case, 2.2.5 run).
      max_tokens: 1024,
      messages: [{ role: 'user', content: buildJudgePrompt(q.question, q.expect, response) }],
    });
    const text = msg.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
    return parseJudgeVerdict(text);
  } catch (err) {
    return { verdict: 'fail', reason: `judge error: ${err instanceof Error ? err.message : String(err)}`, principles_violated: [] };
  }
}

const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const results: Array<Record<string, unknown>> = [];

for (const q of selected) {
  console.log(`\n=== ${q.id} ===\n${q.question}`);
  const started = Date.now();
  try {
    let responseText: string;
    let subtype = 'success';
    let turns: number | undefined;
    let usage: unknown;
    let costUsd: number | undefined;

    if (target === 'http') {
      const turn = await askViaHttp(q.question, `internal-eval-${q.id}-${runId}`);
      responseText = turn.response;
      subtype = turn.subtype;
      costUsd = turn.costUsd;
    } else {
      const opts = {
        source: 'eval' as const,
        agentId: 'ada',
        userMessage: q.question,
        userId: 'eval-harness',
        channelId: `internal-eval-${q.id}-${runId}`,
      };
      const result =
        runner === 'sdk'
          ? await runAgentSDK(opts, { onResult: (r) => { subtype = r.subtype; costUsd = r.costUsd; } })
          : await runAgent(opts);
      responseText = result.response;
      turns = result.turns;
      usage = result.usage;
    }

    const duration = Math.round((Date.now() - started) / 1000);
    const verdict = await judge(q, responseText);
    const mark = verdict.verdict === 'pass' ? '✅' : verdict.verdict === 'partial' ? '🟡' : '❌';
    const viol = verdict.principles_violated.length ? ` · violates ${verdict.principles_violated.join(',')}` : '';
    console.log(`--- ${mark} ${verdict.verdict} (${turns ?? '?'} turns, ${duration}s, ${subtype}${costUsd != null ? `, $${costUsd.toFixed(4)}` : ''})${viol} — ${verdict.reason}`);
    console.log(`${responseText.slice(0, 1200)}\n`);
    results.push({
      id: q.id, question: q.question, expect: q.expect, runner, target, subtype,
      response: responseText, verdict: verdict.verdict, judge_reason: verdict.reason,
      principles_violated: verdict.principles_violated,
      turns, usage, cost_usd: costUsd, duration_s: duration,
    });
  } catch (err) {
    console.error(`!!! ${q.id} FAILED:`, err);
    results.push({
      id: q.id, question: q.question, expect: q.expect, runner, target,
      error: err instanceof Error ? err.message : String(err),
      verdict: 'fail', principles_violated: [], duration_s: Math.round((Date.now() - started) / 1000),
    });
  }
}

mkdirSync(join(EVAL_DIR, 'runs'), { recursive: true });
const outPath = join(EVAL_DIR, 'runs', `${runId}.json`);
const pass = results.filter((r) => r.verdict === 'pass').length;
const partial = results.filter((r) => r.verdict === 'partial').length;
const fail = results.filter((r) => r.verdict === 'fail').length;

// Rollup: how often each general-rubric principle was violated across the suite.
const principleCounts: Record<string, number> = {};
for (const r of results) {
  for (const p of (r.principles_violated as string[] | undefined) ?? []) {
    principleCounts[p] = (principleCounts[p] ?? 0) + 1;
  }
}
const totalCost = results.reduce((s, r) => s + (typeof r.cost_usd === 'number' ? r.cost_usd : 0), 0);

writeFileSync(outPath, JSON.stringify({
  run_id: runId, runner, target, judge_model: doJudge ? JUDGE_MODEL : null,
  git: process.env.GIT_SHA ?? 'local',
  provisional: true,
  note: 'Grades are PROVISIONAL — Dan has not ratified the quality bar (docs/ada-quality-bar-2026-06-21.md). Principles_violated reference the [EVAL] IDs there; A7 is advisory.',
  summary: { pass, partial, fail, principles_violated: principleCounts, total_cost_usd: Number(totalCost.toFixed(4)) },
  results,
}, null, 2));
console.log(`\nSaved ${results.length} results → ${outPath}`);
console.log(`Verdicts: ✅ ${pass} pass · 🟡 ${partial} partial · ❌ ${fail} fail`);
if (Object.keys(principleCounts).length) {
  const rollup = Object.entries(principleCounts).sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id}×${n}`).join(' · ');
  console.log(`Principles violated: ${rollup}`);
}
if (totalCost > 0) console.log(`Total cost: $${totalCost.toFixed(4)}`);
console.log('Grades are PROVISIONAL (quality bar not yet ratified).');
process.exit(fail > 0 ? 1 : 0);
