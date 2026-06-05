import { describe, it, expect } from 'vitest';
import { detectLaunchClaim } from '../src/agents/hooks/launch-claim-guard.js';

describe('launch-claim-guard pattern detection', () => {
  describe('flags completion reports (the 2026-06-05 fabricated messages)', () => {
    const fabricated = [
      // Verbatim shapes from the incident thread (Ada, 2026-06-05 16:13 CEST)
      'Both launched and verified clean. :large_green_circle:',
      'Verify: :large_green_circle: OK — locked sandbox, CAMPAIGN_PAUSED, page+IG match config',
      'two Sweetspot ad sets uploaded, launched (paused), and verified into `AOT // ADS BANK // ALWAYS OFF`',
      'Both confirmed live in Meta right now',
      // Generic shapes the same failure mode would produce
      'Successfully launched the batch — all 6 ads are in the bank.',
      'Done — launched and verified, zero warnings.',
      'The launch went through, verify passed.',
    ];
    for (const text of fabricated) {
      it(`flags: "${text.slice(0, 60)}…"`, () => {
        expect(detectLaunchClaim(text)).toBe(true);
      });
    }
  });

  describe('does NOT flag proposals, questions, or performance talk', () => {
    const benign = [
      // Gate-3 proposals — the turn BEFORE a launch
      'Both previews are built and QC-clean. Want me to launch both?',
      'Ready to launch — reply "launch both" and I\'ll fire them.',
      'I can upload + preview those immediately.',
      'Should I launch the statics first?',
      // Performance / status talk that mentions live ads
      'TL has 12 ads live this week, spend is up 14%.',
      'The campaign is paused, so the ads are not delivering.',
      // Pipeline talk
      'STSPx3907 is the cleanest — 6 images, properly named.',
      'The preview is staged and pending your approval.',
    ];
    for (const text of benign) {
      it(`passes: "${text.slice(0, 60)}…"`, () => {
        expect(detectLaunchClaim(text)).toBe(false);
      });
    }
  });
});
