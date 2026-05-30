/**
 * Run Piper's morning digest from the terminal.
 *
 *   pnpm digest:piper            # dry-run: generate + print, DO NOT post
 *   pnpm digest:piper --post     # generate + post to #piper (PIPER_CHANNEL_ID)
 *   pnpm digest:piper --post --channel C0123  # override channel
 *
 * Dry-run needs no Slack tokens. Posting needs PIPER_BOT_TOKEN + PIPER_CHANNEL_ID.
 */

import { runPiperDigest } from '../src/digest/piper-digest.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const post = args.includes('--post');
  const channelIdx = args.indexOf('--channel');
  const channelId = channelIdx >= 0 ? args[channelIdx + 1] : undefined;

  const result = await runPiperDigest({ dryRun: !post, channelId });

  process.stdout.write('\n' + result.digest + '\n\n');
  if (result.posted) {
    console.error(`posted to ${result.channel} (ts=${result.ts}, turns=${result.turns})`);
  } else {
    console.error(`dry-run — not posted (turns=${result.turns}, ${result.digest.length} chars)`);
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('piper-digest failed:', (err as Error).message);
  process.exit(1);
});
