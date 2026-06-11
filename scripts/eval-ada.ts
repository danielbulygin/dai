/**
 * Ada eval harness — runs the golden questions through the real agent loop
 * and records the responses for before/after comparison when changing
 * prompts, knowledge wiring, or the runner.
 *
 *   pnpm exec tsx scripts/eval-ada.ts                 # all questions
 *   pnpm exec tsx scripts/eval-ada.ts --only laori-net-profit,capability-rename
 *
 * Runs are sequential (live Opus + live tools — costs real money and a few
 * minutes). Results land in tests/eval/runs/<timestamp>.json. Sessions use
 * internal-eval-* channel ids so no Slack context is injected and nothing
 * posts to Slack.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from '../src/agents/runner.js';

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

const onlyArg = process.argv.find((a) => a.startsWith('--only'));
const onlyIds = onlyArg
  ? new Set((process.argv[process.argv.indexOf(onlyArg) + 1] ?? onlyArg.split('=')[1] ?? '').split(','))
  : null;

const selected = onlyIds ? questions.filter((q) => onlyIds.has(q.id)) : questions;
if (selected.length === 0) {
  console.error('No questions selected. Ids:', questions.map((q) => q.id).join(', '));
  process.exit(1);
}

const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const results: Array<Record<string, unknown>> = [];

for (const q of selected) {
  console.log(`\n=== ${q.id} ===\n${q.question}`);
  const started = Date.now();
  try {
    const result = await runAgent({
      source: 'eval',
      agentId: 'ada',
      userMessage: q.question,
      userId: 'eval-harness',
      channelId: `internal-eval-${q.id}-${runId}`,
    });
    const duration = Math.round((Date.now() - started) / 1000);
    console.log(`--- response (${result.turns} turns, ${duration}s) ---\n${result.response.slice(0, 1500)}\n`);
    results.push({
      id: q.id,
      question: q.question,
      expect: q.expect,
      response: result.response,
      turns: result.turns,
      usage: result.usage,
      duration_s: duration,
    });
  } catch (err) {
    console.error(`!!! ${q.id} FAILED:`, err);
    results.push({
      id: q.id,
      question: q.question,
      expect: q.expect,
      error: err instanceof Error ? err.message : String(err),
      duration_s: Math.round((Date.now() - started) / 1000),
    });
  }
}

mkdirSync(join(EVAL_DIR, 'runs'), { recursive: true });
const outPath = join(EVAL_DIR, 'runs', `${runId}.json`);
writeFileSync(outPath, JSON.stringify({ run_id: runId, git: process.env.GIT_SHA ?? 'local', results }, null, 2));
console.log(`\nSaved ${results.length} results → ${outPath}`);
console.log(`Failures: ${results.filter((r) => r.error).length}`);
process.exit(0);
