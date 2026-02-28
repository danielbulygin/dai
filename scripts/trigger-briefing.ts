#!/usr/bin/env node
/**
 * Trigger a briefing manually for testing.
 * Usage: pnpm tsx scripts/trigger-briefing.ts [morning|eod|weekly]
 */
import { generateMorningBriefing, generateEodBriefing, generateWeeklyBriefing } from '../src/scheduler/briefings.js';

const type = process.argv[2] ?? 'morning';

const generators: Record<string, () => Promise<string>> = {
  morning: generateMorningBriefing,
  eod: generateEodBriefing,
  weekly: generateWeeklyBriefing,
};

const fn = generators[type];
if (!fn) {
  console.error(`Unknown briefing type: ${type}. Use: morning, eod, weekly`);
  process.exit(1);
}

console.log(`Triggering ${type} briefing...`);
fn()
  .then(() => {
    console.log('Done.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Failed:', err);
    process.exit(1);
  });
