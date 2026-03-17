/**
 * Test the Fireflies team sync.
 * Usage: pnpm tsx scripts/test-fireflies-sync.ts
 */

import { syncTeamMeetings } from '../src/integrations/fireflies-sync.js';

async function run(): Promise<void> {
  console.log('Starting Fireflies team sync test...\n');
  const synced = await syncTeamMeetings();
  console.log(`\nDone. Synced ${synced} new meetings.`);
}

run().catch(console.error);
