/**
 * Run Piper's "My Real Moves" post from the terminal. Deterministic — no LLM.
 *
 *   pnpm digest:piper-moves            # dry-run: render + print, DO NOT post
 *   pnpm digest:piper-moves --post     # render + post to #piper (PIPER_CHANNEL_ID)
 *   pnpm digest:piper-moves --post --channel C0123  # override channel
 *
 * Dry-run needs only SUPABASE_URL + SUPABASE_SERVICE_KEY (the bmad Supabase
 * where the piper brain lives). Posting needs PIPER_BOT_TOKEN + PIPER_CHANNEL_ID.
 */

import { runPiperMyMoves } from '../src/digest/piper-my-moves.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const post = args.includes('--post');
  const channelIdx = args.indexOf('--channel');
  const channelId = channelIdx >= 0 ? args[channelIdx + 1] : undefined;

  const result = await runPiperMyMoves({ post, channelId });

  process.stdout.write('\n' + result.text + '\n\n');
  if (result.posted) {
    console.error(
      `posted to ${result.channel} (ts=${result.parentTs}, ${result.peopleCount} people, ${result.moveCount} moves)`,
    );
  } else {
    console.error(
      `dry-run — not posted (${result.peopleCount} people, ${result.moveCount} moves, ${result.text.length} chars)`,
    );
  }
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('piper-my-moves failed:', (err as Error).message);
  process.exit(1);
});
