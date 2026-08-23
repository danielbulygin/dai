/**
 * Nightly eval notifier — after both suites run, posts the WEB-PARITY suite's
 * verdicts to Slack (#piper via PIPER_CHANNEL_ID, or EVAL_SLACK_CHANNEL_ID) and,
 * when anything failed, writes a fix brief next to the run file for the
 * auto-fix step (eval-autofix.sh) and for humans.
 *
 * Deliberately dependency-free and best-effort: a broken notification must never
 * mark the eval unit failed, so every path exits 0.
 */
import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR = join(__dirname, '..', 'tests', 'eval', 'runs');
const TOKEN = process.env.EVAL_SLACK_BOT_TOKEN ?? process.env.PIPER_BOT_TOKEN ?? process.env.SLACK_BOT_TOKEN ?? '';
const CHANNEL = process.env.EVAL_SLACK_CHANNEL_ID ?? process.env.PIPER_CHANNEL_ID ?? '';
const WEB_SUITE = 'golden-questions-web.json';
const FRESH_MS = 6 * 60 * 60 * 1000;

interface RunResult {
  id: string;
  question: string;
  expect: string;
  verdict: string;
  judge_reason?: string;
  response?: string;
  infra_failure?: boolean;
  error?: string;
}
interface RunFile {
  run_id: string;
  suite?: string;
  scope?: string | null;
  git?: string;
  summary: { pass: number; partial: number; fail: number; infra_failures?: number; total_cost_usd?: number };
  results: RunResult[];
  __path?: string;
}

function newestFreshRun(match: (r: RunFile) => boolean): RunFile | null {
  const files = readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse();
  for (const f of files) {
    const path = join(RUNS_DIR, f);
    if (Date.now() - statSync(path).mtimeMs > FRESH_MS) return null;
    try {
      const run = JSON.parse(readFileSync(path, 'utf-8')) as RunFile;
      if (match(run)) return { ...run, __path: path };
    } catch {
      // a half-written or malformed run file is not this script's problem
    }
  }
  return null;
}

async function postSlack(text: string): Promise<void> {
  if (!TOKEN || !CHANNEL) {
    console.warn('[eval-notify] SLACK_BOT_TOKEN or channel id missing — printing instead:\n' + text);
    return;
  }
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ channel: CHANNEL, text, unfurl_links: false }),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!body.ok) console.warn(`[eval-notify] Slack post failed: ${body.error ?? res.status}`);
}

function writeFixBrief(run: RunFile, fails: RunResult[]): string {
  const briefPath = (run.__path ?? '').replace(/\.json$/, '-web-fix-brief.md');
  const lines: string[] = [
    `# Web-parity eval failures — run ${run.run_id} (scope ${run.scope ?? '?'}, git ${run.git ?? '?'})`,
    '',
    'Each failure below is a judged miss on the CUSTOMER door (client-scoped /chat).',
    'Fence-probe failures (ids starting web-fence-) are potential cross-tenant leaks — treat as highest severity.',
    '',
    'Where to look:',
    '- Serving code (LIVE, do not edit in place): /root/ada-sdk-spike/scripts/ada-console-assist.ts (scoped branch + client prompt)',
    '- Client overlay: /root/ada-sdk-spike/agents/ada/clients/AOTUS.md',
    '- This repo (fix here, founder reviews + deploys): /root/dai',
    '',
  ];
  for (const f of fails) {
    lines.push(
      `## ${f.id}`,
      `**Question:** ${f.question}`,
      `**Expected:** ${f.expect}`,
      `**Judge:** ${f.judge_reason ?? f.error ?? '(no reason recorded)'}`,
      '**Answer (first 1500 chars):**',
      '```',
      (f.response ?? '(none)').slice(0, 1500),
      '```',
      '',
    );
  }
  writeFileSync(briefPath, lines.join('\n'));
  return briefPath;
}

async function main(): Promise<void> {
  const web = newestFreshRun((r) => r.suite === WEB_SUITE);
  if (!web) {
    await postSlack(':warning: Nightly web-parity eval: no fresh run file found — the customer-door suite did not produce results tonight.');
    return;
  }
  const s = web.summary;
  const fails = web.results.filter((r) => r.verdict === 'fail');
  const fenceFails = fails.filter((r) => r.id.startsWith('web-fence-'));

  if (fails.length === 0) {
    await postSlack(
      `:white_check_mark: Nightly web-Ada check (customer door, scope ${web.scope}): ` +
        `${s.pass} pass · ${s.partial} partial · 0 fail` +
        (s.total_cost_usd ? ` · $${s.total_cost_usd.toFixed(2)}` : ''),
    );
    return;
  }

  const briefPath = writeFixBrief(web, fails);
  const failLines = fails
    .map((f) => `• *${f.id}*${f.id.startsWith('web-fence-') ? ' :rotating_light: FENCE' : ''} — ${(f.judge_reason ?? f.error ?? '').slice(0, 200)}`)
    .join('\n');
  await postSlack(
    `${fenceFails.length ? ':rotating_light:' : ':x:'} Nightly web-Ada check (customer door, scope ${web.scope}): ` +
      `${s.fail} FAIL · ${s.pass} pass · ${s.partial} partial` +
      (fenceFails.length ? ` — ${fenceFails.length} FENCE failure(s): possible cross-tenant leak, look first` : '') +
      `\n${failLines}\nFix brief: \`${briefPath}\` — the auto-fix step prepares a branch; nothing deploys without a founder.`,
  );
}

main()
  .catch((err) => console.warn('[eval-notify] failed:', err instanceof Error ? err.message : err))
  .finally(() => process.exit(0));
