/**
 * Manual trigger for the Loop 1 agency morning brief.
 *
 *   pnpm exec tsx scripts/run-agency-brief.ts                 # dry run → console
 *   pnpm exec tsx scripts/run-agency-brief.ts --post          # post to the channel
 *   pnpm exec tsx scripts/run-agency-brief.ts --pilots=SS     # different client(s)
 *   pnpm exec tsx scripts/run-agency-brief.ts --no-ledger     # skip ada_insights writes
 *   pnpm exec tsx scripts/run-agency-brief.ts --now=2026-08-03T06:05:00Z
 *       # pretend it is another morning (seeded could-not-verify failure test:
 *       # pick a "now" whose yesterday the sync never completed)
 */

import { runAgencyMorningBrief } from '../src/monitoring/agency-morning-brief.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const has = (f: string) => args.includes(f);
  const val = (p: string) =>
    args.find((a) => a.startsWith(`${p}=`))?.slice(p.length + 1);

  const result = await runAgencyMorningBrief({
    post: has('--post'),
    pilots: val('--pilots')?.split(','),
    writeToLedger: !has('--no-ledger'),
    now: val('--now') ? new Date(val('--now')!) : undefined,
    judge: has('--judge') ? true : undefined,
  });

  console.log('────────────────────────────────────────────');
  console.log(result.text);
  console.log('────────────────────────────────────────────');
  console.log(
    `accounts: ${result.accounts
      .map((a) => `${a.clientRow.code}:${a.status}`)
      .join(' ')} · insights written: ${result.insightsWritten} · posted: ${result.posted}`,
  );
  if (result.judge) {
    console.log(`judge: ${JSON.stringify(result.judge)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
