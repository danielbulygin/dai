/**
 * Run the simulated-Dan judge over any report text (board card 86).
 *
 *   pnpm exec tsx --env-file=.env scripts/judge-report.ts --file=report.txt
 *   cat report.txt | pnpm exec tsx --env-file=.env scripts/judge-report.ts
 */

import { readFileSync } from 'node:fs';
import { judgeBrief, selfCheckLine } from '../src/monitoring/daniel-judge.js';

async function main(): Promise<void> {
  const fileArg = process.argv.slice(2).find((a) => a.startsWith('--file='));
  const text = fileArg
    ? readFileSync(fileArg.slice('--file='.length), 'utf8')
    : readFileSync(0, 'utf8');
  if (!text.trim()) {
    console.error('No report text (use --file= or pipe on stdin).');
    process.exit(1);
  }
  const v = await judgeBrief(text);
  console.log(JSON.stringify(v, null, 2));
  const check = selfCheckLine(v);
  console.error(`\n${check ?? `⚖️ passes the bar (${v.overall}/10, no linter findings)`}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
