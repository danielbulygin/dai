/**
 * Manual trigger for the intraday pulse.
 *
 *   pnpm exec tsx scripts/run-intraday-pulse.ts                 # dry run → console
 *   pnpm exec tsx scripts/run-intraday-pulse.ts --post          # post to #ada
 *   pnpm exec tsx scripts/run-intraday-pulse.ts --pilots=PL     # different client(s)
 *   pnpm exec tsx scripts/run-intraday-pulse.ts --ledger        # write dedupe rows on a dry run
 *   pnpm exec tsx scripts/run-intraday-pulse.ts --no-ledger     # post WITHOUT burning the dedupe slot
 *   pnpm exec tsx scripts/run-intraday-pulse.ts --now=2026-08-07T11:40:00Z
 *       # pretend it is another afternoon (the dark rule needs a past-noon
 *       # account-local clock, so pick "now" accordingly)
 *
 * Note: unlike the morning brief, a dry run writes NOTHING by default — the
 * ledger rows are this job's dedupe memory, and burning them silently would
 * suppress the real post later the same day.
 */

import { runIntradayPulse } from '../src/monitoring/intraday-pulse.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const has = (f: string) => args.includes(f);
  const val = (p: string) =>
    args.find((a) => a.startsWith(`${p}=`))?.slice(p.length + 1);

  const result = await runIntradayPulse({
    post: has('--post'),
    pilots: val('--pilots')?.split(','),
    writeToLedger: has('--ledger') ? true : has('--no-ledger') ? false : undefined,
    now: val('--now') ? new Date(val('--now')!) : undefined,
  });

  console.log('────────────────────────────────────────────');
  console.log(result.text || '(silence — nothing event-worthy today)');
  console.log('────────────────────────────────────────────');
  console.log(
    `events: ${result.events.length}${
      result.events.length
        ? ` (${result.events.map((e) => `${e.clientCode}:${e.kind}`).join(' ')})`
        : ''
    } · insights written: ${result.insightsWritten} · posted: ${result.posted}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
