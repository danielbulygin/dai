/**
 * One-off manual trigger for the Ready-to-Upload check — builds the SAME grouped
 * message the scheduled job builds, and posts it to #ada AS Ada (via ADA_BOT_TOKEN),
 * labeled as a manual test so it's distinguishable from the scheduled 10:00/17:00 runs.
 * Run on the droplet: npx tsx --env-file=.env scripts/fire-ready-to-upload.ts
 */
import { WebClient } from '@slack/web-api';
import { buildReadyToUploadMessage } from '../src/monitoring/ready-to-upload-check.js';

const built = await buildReadyToUploadMessage('evening');
if (!built) {
  console.log('backlog empty — nothing to post');
  process.exit(0);
}
const token = process.env.ADA_BOT_TOKEN;
if (!token) {
  console.error('ADA_BOT_TOKEN not set');
  process.exit(1);
}
const message = `:test_tube: _(manual test of the twice-daily check)_\n${built.message}`;
const res = await new WebClient(token).chat.postMessage({ channel: 'C0AHX94CBF0', text: message });
console.log('posted ok=', res.ok, 'ts=', res.ts);
