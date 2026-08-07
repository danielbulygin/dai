/**
 * Simulated-Dan groundwork: mine Daniel's calls for how he interrogates
 * reports and numbers. Per meeting, extracts his questioning patterns as
 * JSON; a human (Fable) synthesizes the rubric from the outputs.
 * Board card 86; consumed by src/monitoring/daniel-judge.ts.
 *
 *   pnpm exec tsx --env-file=.env scripts/distill-daniel-rubric.ts --meetings=id1,id2
 */

import Anthropic from '@anthropic-ai/sdk';
import { getDaiSupabase } from '../src/integrations/dai-supabase.js';
import { env } from '../src/env.js';

const MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `You are studying how Daniel (agency owner, adsontap) interrogates performance reports on calls with his media buyer Nina. The goal is a reusable rubric: what he demands from any report line before he trusts or acts on it.

From the transcript, extract STRICT JSON only:

{
  "interrogation_questions": [
    {"quote": "...", "ts": "m:ss", "pattern": "one-line generalization of what he is demanding"}
  ],  // verbatim questions Daniel asks when shown a number/report/claim — the drill-downs
  "approval_moments": [
    {"quote": "...", "ts": "m:ss", "what_earned_it": "why this satisfied him"}
  ],  // where he says some form of "good / nice / okay do it" — what was present
  "dismissal_moments": [
    {"quote": "...", "ts": "m:ss", "what_was_missing": "why this failed him"}
  ],  // where he pushes back, asks "so what", or is unsatisfied
  "voiced_standards": [
    {"quote": "...", "ts": "m:ss", "standard": "the rule as a reusable statement"}
  ],  // any rule of thumb, threshold, or methodological demand he states
  "followup_chains": [
    {"sequence": ["first question", "then", "then"], "ts": "m:ss", "trigger": "what kind of claim started the chain"}
  ]   // multi-step drill-downs: what he asks after what
}

Rules: quotes verbatim, timestamps from the lines. Only DANIEL's demands (Nina's answers matter only as context). Nothing invented; empty arrays are fine.`;

async function transcript(meetingId: string): Promise<string> {
  const dai = getDaiSupabase();
  const rows: Array<{ speaker_name: string | null; text: string | null; start_time: number | null }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await dai
      .from('meeting_sentences')
      .select('sentence_index, speaker_name, text, start_time')
      .eq('meeting_id', meetingId)
      .order('sentence_index', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return rows
    .map((s) => {
      const sec = Math.round(s.start_time ?? 0);
      return `[${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}] ${s.speaker_name ?? '?'}: ${s.text ?? ''}`;
    })
    .join('\n');
}

async function main(): Promise<void> {
  const ids = process.argv
    .slice(2)
    .find((a) => a.startsWith('--meetings='))
    ?.slice('--meetings='.length)
    .split(',');
  if (!ids?.length) {
    console.error('Usage: --meetings=id1,id2');
    process.exit(1);
  }
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const out: Record<string, unknown> = {};
  for (const id of ids) {
    console.error(`extracting ${id}…`);
    const text = await transcript(id);
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 6000,
      temperature: 0,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: text }],
    });
    const raw = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```$/, '');
    out[id] = JSON.parse(raw);
  }
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
