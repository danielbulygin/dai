/**
 * SDK-Ada eval harness — the A/B counterpart to scripts/eval-ada.ts.
 * Runs the golden questions through `runAgentSDK` (Claude Agent SDK) instead of
 * the hand-rolled loop, so the answers can be diffed against the current-Ada
 * baseline. Read-only policy (no writes), full ada-* skills enabled.
 *
 *   cd /root/ada-sdk-spike && set -a && . /root/dai/.env && set +a && \
 *     node_modules/.bin/tsx scripts/eval-ada-sdk.ts [--only id1,id2]
 *
 * Results → tests/eval/runs-sdk/<runid>.json (same shape as eval-ada.ts + cost/tools).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentSDK } from '../src/agents/sdk/runAgentSDK.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = join(__dirname, '..', 'tests', 'eval');

interface GoldenQuestion { id: string; question: string; expect: string; }
const { questions } = JSON.parse(readFileSync(join(EVAL_DIR, 'golden-questions.json'), 'utf-8')) as { questions: GoldenQuestion[] };

const onlyArg = process.argv.find((a) => a.startsWith('--only'));
const onlyIds = onlyArg
  ? new Set((process.argv[process.argv.indexOf(onlyArg) + 1] ?? onlyArg.split('=')[1] ?? '').split(','))
  : null;
const selected = onlyIds ? questions.filter((q) => onlyIds.has(q.id)) : questions;
if (selected.length === 0) { console.error('No questions selected. Ids:', questions.map((q) => q.id).join(', ')); process.exit(1); }

const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const results: Array<Record<string, unknown>> = [];
let totalCost = 0;

for (const q of selected) {
  console.log(`\n=== ${q.id} ===\n${q.question}`);
  const started = Date.now();
  let costUsd = 0; let subtype = ''; let toolsUsed: string[] = [];
  try {
    const result = await runAgentSDK(
      { source: 'eval', agentId: 'ada', userMessage: q.question, userId: 'eval-harness', channelId: `internal-eval-sdk-${q.id}-${runId}` },
      { onResult: (r) => { costUsd = r.costUsd; subtype = r.subtype; toolsUsed = r.toolsUsed; }, maxBudgetUsd: 3 },
    );
    totalCost += costUsd;
    const duration = Math.round((Date.now() - started) / 1000);
    console.log(`--- response (${result.turns} turns, ${duration}s, $${costUsd.toFixed(4)}, tools=${JSON.stringify(toolsUsed)}) ---\n${result.response.slice(0, 1500)}\n`);
    results.push({ id: q.id, question: q.question, expect: q.expect, response: result.response, turns: result.turns, usage: result.usage, cost_usd: costUsd, subtype, tools_used: toolsUsed, duration_s: duration });
  } catch (err) {
    console.error(`!!! ${q.id} FAILED:`, err);
    results.push({ id: q.id, question: q.question, expect: q.expect, error: err instanceof Error ? err.message : String(err), duration_s: Math.round((Date.now() - started) / 1000) });
  }
}

mkdirSync(join(EVAL_DIR, 'runs-sdk'), { recursive: true });
const outPath = join(EVAL_DIR, 'runs-sdk', `${runId}.json`);
writeFileSync(outPath, JSON.stringify({ run_id: runId, runner: 'sdk', git: process.env.GIT_SHA ?? 'local', total_cost_usd: totalCost, results }, null, 2));
console.log(`\nSaved ${results.length} results → ${outPath}`);
console.log(`Total cost: $${totalCost.toFixed(4)} | Failures: ${results.filter((r) => r.error).length}`);
process.exit(0);
