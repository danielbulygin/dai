/**
 * Ada eval harness — runs the golden questions through the real agent loop, then
 * GRADES each response against its rubric with an LLM judge (Ada 2.0 Phase 1).
 *
 *   pnpm exec tsx scripts/eval-ada.ts                       # all, SDK loop, judged
 *   pnpm exec tsx scripts/eval-ada.ts --only jva-minicourse-launch
 *   pnpm exec tsx scripts/eval-ada.ts --runner slack       # the hand-rolled runner
 *   pnpm exec tsx scripts/eval-ada.ts --no-judge           # capture only (old behaviour)
 *
 * Runs are sequential (live Opus + live tools — costs real money and a few
 * minutes). Results land in tests/eval/runs/<timestamp>.json. Sessions use
 * internal-eval-* channel ids so no Slack context is injected and nothing posts
 * to Slack. Writes are denied (default guard policy) — this is a read/reasoning
 * net, not a launch test.
 *
 * --runner sdk (DEFAULT) drives runAgentSDK — the loop web-Ada actually runs (per
 * the 2026-06-28 "one Ada brain" decision: eval what ships). It needs the skills
 * dir; set ADA_SDK_SKILLS_CWD locally (defaults to the droplet path).
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
const doJudge = !argv.includes('--no-judge');
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? 'claude-opus-4-8';

const selected = onlyIds ? questions.filter((q) => onlyIds.has(q.id)) : questions;
if (selected.length === 0) {
  console.error('No questions selected. Ids:', questions.map((q) => q.id).join(', '));
  process.exit(1);
}

const anthropic = doJudge ? new Anthropic() : null;

async function judge(q: GoldenQuestion, response: string): Promise<JudgeVerdict> {
  if (!anthropic) return { verdict: 'pass', reason: '(judging disabled)' };
  try {
    const msg = await anthropic.messages.create({
      model: JUDGE_MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: buildJudgePrompt(q.question, q.expect, response) }],
    });
    const text = msg.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
    return parseJudgeVerdict(text);
  } catch (err) {
    return { verdict: 'fail', reason: `judge error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const results: Array<Record<string, unknown>> = [];

for (const q of selected) {
  console.log(`\n=== ${q.id} ===\n${q.question}`);
  const started = Date.now();
  try {
    const opts = {
      source: 'eval' as const,
      agentId: 'ada',
      userMessage: q.question,
      userId: 'eval-harness',
      channelId: `internal-eval-${q.id}-${runId}`,
    };
    let subtype = 'success';
    const result =
      runner === 'sdk'
        ? await runAgentSDK(opts, { onResult: (r) => { subtype = r.subtype; } })
        : await runAgent(opts);
    const duration = Math.round((Date.now() - started) / 1000);
    const verdict = await judge(q, result.response);
    const mark = verdict.verdict === 'pass' ? '✅' : verdict.verdict === 'partial' ? '🟡' : '❌';
    console.log(`--- ${mark} ${verdict.verdict} (${result.turns} turns, ${duration}s, ${subtype}) — ${verdict.reason}`);
    console.log(`${result.response.slice(0, 1200)}\n`);
    results.push({
      id: q.id, question: q.question, expect: q.expect, runner, subtype,
      response: result.response, verdict: verdict.verdict, judge_reason: verdict.reason,
      turns: result.turns, usage: result.usage, duration_s: duration,
    });
  } catch (err) {
    console.error(`!!! ${q.id} FAILED:`, err);
    results.push({
      id: q.id, question: q.question, expect: q.expect, runner,
      error: err instanceof Error ? err.message : String(err),
      verdict: 'fail', duration_s: Math.round((Date.now() - started) / 1000),
    });
  }
}

mkdirSync(join(EVAL_DIR, 'runs'), { recursive: true });
const outPath = join(EVAL_DIR, 'runs', `${runId}.json`);
const pass = results.filter((r) => r.verdict === 'pass').length;
const partial = results.filter((r) => r.verdict === 'partial').length;
const fail = results.filter((r) => r.verdict === 'fail').length;
writeFileSync(outPath, JSON.stringify({ run_id: runId, runner, judge_model: doJudge ? JUDGE_MODEL : null, git: process.env.GIT_SHA ?? 'local', summary: { pass, partial, fail }, results }, null, 2));
console.log(`\nSaved ${results.length} results → ${outPath}`);
console.log(`Verdicts: ✅ ${pass} pass · 🟡 ${partial} partial · ❌ ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
