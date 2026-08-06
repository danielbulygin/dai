/**
 * Loop 6 — the onboarding intake: call transcripts → proposed client config.
 *
 * Reads onboarding-call transcripts that the Fireflies sync already landed in
 * the DAI Supabase (meetings + meeting_sentences), extracts the answers to the
 * 12-question interview kit (tinkers docs/factory/day-2026-08-06/
 * media-buyer-gap-and-plan.md §5) with a quote and timestamp for every claim,
 * and writes a human-reviewable proposal to
 * agents/ada/clients/_intake/<CODE>-proposed.md.
 *
 * EXTRACTION PROPOSES, A HUMAN MERGES — the standing doctrine. The output is
 * a proposal document, not a config write: Daniel reviews, then merges into
 * agents/ada/clients/<CODE>.md, the clients row, and clients.goal_bands.
 * Anything the calls did not answer renders as an explicit gap list — the
 * follow-up questions for the next touchpoint.
 *
 * Modelled on bmad's JVA extract.py (system prompt + strict JSON out +
 * deterministic fields computed in code, not by the model). Deviation from
 * JVA's DB idempotency: the output here is a reviewable file, so re-running
 * simply regenerates the proposal (stamped with its inputs).
 *
 *   pnpm exec tsx --env-file=.env scripts/onboarding-intake.ts \
 *     --code BRIAN --meetings 01KZ4944RTFY2JVCBP35R1ENJ7,01KZ91WVEDWENCANSWPGQCYS3K \
 *     [--validate]   # print to stdout, write nothing
 */

import Anthropic from '@anthropic-ai/sdk';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDaiSupabase } from '../src/integrations/dai-supabase.js';
import { env } from '../src/env.js';

const MODEL = 'claude-sonnet-4-6';

// ---------------------------------------------------------------------------
// The 12-question kit (the extraction frame AND the gap-list checklist).
// Source of truth: media-buyer-gap-and-plan.md §5 — keep in step.
// ---------------------------------------------------------------------------

const KIT_QUESTIONS = [
  'Money: what do they sell, at what price(s), margin/LTV, and the ONE metric they steer by',
  'The four bands: ecstatic / happy / nervous / kill numbers for the primary metric',
  'Volume vs efficiency: 10 sales at $60 or 25 at $90 — do kill thresholds bend under scale',
  'The funnel: where traffic lands page by page, what converts today, what happens after',
  'Measurement: pixel/events owner, what counts as a conversion, do they trust the number, backend truth',
  'Brand: what they are for, for whom, what competitors get wrong, what Ada must never sound like or promise',
  'Creative: who makes ads, cadence, formats, off-limits',
  'Competitors: three names, which they actually fear and why',
  'History: who ran the account before, anything sacred, known bad-data periods',
  'Autonomy & guidance: watch-only → ask-first → act-alone, per action type',
  'Rules they already live by: "I always kill an ad when…" — verbatim',
  'Communication: which channel they actually read, cadence, who else gets reports',
] as const;

// Rule templates the guard rules engine knows (tinkers src/lib/guard/rules.ts
// RULE_LIBRARY; mirrored in dai on the account-guard branch). The extractor
// tags each verbatim rule with the closest template, or "custom".
const RULE_TEMPLATE_KEYS =
  'ad_spend_watch (one ad spent a lot), weekly_cost_line (weekly CPA over a line, account), ' +
  'campaign_cost_line (weekly CPA over a line, per campaign), daily_spend_ceiling (one day spends past ceiling), ' +
  'quiet_day (a spending day with zero results), ad_fatigue (frequency too high), breakeven_floor (ROAS under 1)';

const SYSTEM_PROMPT = `You are extracting an onboarding configuration for a Meta ads account from call transcripts between adsontap (the agency — Daniel) and a new client. The extraction feeds a review document; a human merges it into the live config. Accuracy and provenance beat completeness.

Non-negotiable rules:
- NEVER invent or infer a number, name, or preference that is not in the transcripts. If a question was not discussed, leave its field null and list it under "unanswered".
- EVERY extracted value carries provenance: the verbatim quote (the shortest span that proves the value), the call number it came from, and the [m:ss] timestamp of that line.
- Quotes must be verbatim from the transcript (transcription glitches included).
- Prices, bands and thresholds: keep the speaker's own numbers and currency. Do not convert.
- The four goal bands are distinct: dream (ecstatic), happy, nervous, kill. Only fill the ones explicitly given.

Return STRICT JSON only — no markdown fences, no commentary — with this shape (any leaf may be null; provenance objects are {"value": ..., "quote": "...", "call": 1, "ts": "12:34"}):

{
  "client_display_name": string|null,
  "money": {
    "offering": prov|null, "prices": [prov, ...], "margin_or_ltv": prov|null,
    "primary_metric": prov|null  // value one of "cpa" | "cpl" | "roas"
  },
  "goal_bands": {
    "metric": string|null, "currency": string|null,
    "dream": prov|null, "happy": prov|null, "nervous": prov|null, "kill": prov|null
  },
  "volume_vs_efficiency": prov|null,
  "funnel": { "landing": prov|null, "converts_today": prov|null, "after_conversion": prov|null },
  "measurement": { "setup_owner": prov|null, "conversion_definition": prov|null, "trusts_numbers": prov|null, "backend_truth": prov|null },
  "brand": {
    "what_for": prov|null, "audience": prov|null, "competitors_get_wrong": prov|null,
    "never": prov|null, "tone_words": [string, ...]
  },
  "creative": { "who_makes": prov|null, "cadence": prov|null, "formats": prov|null, "off_limits": prov|null },
  "competitors": [ { "name": string, "feared": boolean|null, "why": string|null, "quote": string, "call": 1, "ts": "0:00" } ],
  "history": { "prior_management": prov|null, "sacred": prov|null, "bad_data": prov|null },
  "autonomy": prov|null,
  "rules_verbatim": [ { "rule": string, "template_match": string, "quote": string, "call": 1, "ts": "0:00" } ],
  "communication": { "channel": prov|null, "cadence": prov|null, "recipients": prov|null },
  "business_facts": [prov, ...],   // durable facts worth remembering that fit nowhere above
  "unanswered": [ { "question": 1, "note": string } ]  // kit question numbers the calls did not answer
}

Rule templates for "template_match" (use the key, or "custom"): ${RULE_TEMPLATE_KEYS}.

The 12 interview-kit questions, numbered for "unanswered":
${KIT_QUESTIONS.map((q, i) => `${i + 1}. ${q}`).join('\n')}`;

// ---------------------------------------------------------------------------

interface SentenceRow {
  sentence_index: number;
  speaker_name: string | null;
  text: string | null;
  start_time: number | null;
}

function mmss(seconds: number | null): string {
  const s = Math.max(0, Math.round(seconds ?? 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function fetchTranscript(meetingId: string): Promise<{
  header: string;
  body: string;
  title: string;
  date: string;
}> {
  const dai = getDaiSupabase();
  const { data: meeting, error } = await dai
    .from('meetings')
    .select('id, title, date, duration, speakers')
    .eq('id', meetingId)
    .maybeSingle();
  if (error || !meeting) {
    throw new Error(`meeting ${meetingId} not found in DAI Supabase: ${error?.message ?? 'no row'}`);
  }

  const sentences: SentenceRow[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error: sErr } = await dai
      .from('meeting_sentences')
      .select('sentence_index, speaker_name, text, start_time')
      .eq('meeting_id', meetingId)
      .order('sentence_index', { ascending: true })
      .range(from, from + pageSize - 1);
    if (sErr) throw new Error(`sentences fetch failed: ${sErr.message}`);
    sentences.push(...((data ?? []) as SentenceRow[]));
    if (!data || data.length < pageSize) break;
  }
  if (!sentences.length) throw new Error(`meeting ${meetingId} has no sentences`);

  const body = sentences
    .map((s) => `[${mmss(s.start_time)}] ${s.speaker_name ?? '?'}: ${s.text ?? ''}`)
    .join('\n');
  const date = String(meeting.date).slice(0, 10);
  return {
    title: String(meeting.title),
    date,
    header: `${meeting.title} — ${date}, ${meeting.duration} min, speakers: ${(meeting.speakers as string[])?.join(', ')}`,
    body,
  };
}

// ---------------------------------------------------------------------------

type Prov = { value: unknown; quote?: string; call?: number; ts?: string } | null;

function provLine(label: string, p: Prov): string {
  if (!p || p.value === null || p.value === undefined) return `- **${label}:** _not discussed_`;
  const src = p.quote ? `\n  > "${p.quote}" _(call ${p.call ?? '?'}, ${p.ts ?? '?'})_` : '';
  return `- **${label}:** ${String(p.value)}${src}`;
}

function renderProposal(
  code: string,
  extraction: Record<string, any>,
  calls: Array<{ title: string; date: string; id: string }>,
): string {
  const x = extraction;
  const bands = x.goal_bands ?? {};
  const lines: string[] = [];

  lines.push(`# ${code} — proposed onboarding config (EXTRACTION — human merge required)`);
  lines.push('');
  lines.push(
    `Generated ${new Date().toISOString().slice(0, 16)}Z by scripts/onboarding-intake.ts from:`,
  );
  for (const [i, c] of calls.entries()) lines.push(`- call ${i + 1}: ${c.title} (${c.date}, Fireflies \`${c.id}\`)`);
  lines.push('');
  lines.push('Every value below carries the quote and timestamp it came from. Nothing here is');
  lines.push('live until a human merges it (client .md, clients row, goal_bands).');
  lines.push('');

  lines.push('## Goal bands (→ clients.goal_bands after review)');
  lines.push(provLine('metric', bands.metric ? { value: bands.metric } : null));
  lines.push(provLine('currency', bands.currency ? { value: bands.currency } : null));
  for (const band of ['dream', 'happy', 'nervous', 'kill'] as const) {
    lines.push(provLine(band, bands[band]));
  }
  const ready =
    bands.metric && (bands.dream ?? bands.happy ?? bands.nervous ?? bands.kill);
  if (ready) {
    const bandVal = (b: Prov) => (b && b.value !== null && b.value !== undefined ? Number(b.value) : null);
    lines.push('');
    lines.push('```json');
    lines.push(
      JSON.stringify(
        {
          metric: bands.metric,
          currency: bands.currency ?? 'USD',
          dream: bandVal(bands.dream),
          happy: bandVal(bands.happy),
          nervous: bandVal(bands.nervous),
          kill: bandVal(bands.kill),
          source: `onboarding calls ${calls.map((c) => c.date).join(' + ')} (intake extraction, reviewed by ___)`,
          updated_at: new Date().toISOString().slice(0, 10),
        },
        null,
        2,
      ),
    );
    lines.push('```');
  }
  lines.push('');

  lines.push('## Money');
  lines.push(provLine('offering', x.money?.offering));
  for (const p of x.money?.prices ?? []) lines.push(provLine('price', p));
  lines.push(provLine('margin / LTV', x.money?.margin_or_ltv));
  lines.push(provLine('primary metric', x.money?.primary_metric));
  lines.push('');

  lines.push('## Volume vs efficiency');
  lines.push(provLine('stance', x.volume_vs_efficiency));
  lines.push('');

  lines.push('## Funnel');
  lines.push(provLine('traffic lands', x.funnel?.landing));
  lines.push(provLine('converts today', x.funnel?.converts_today));
  lines.push(provLine('after the conversion', x.funnel?.after_conversion));
  lines.push('');

  lines.push('## Measurement');
  lines.push(provLine('setup owner', x.measurement?.setup_owner));
  lines.push(provLine('conversion definition', x.measurement?.conversion_definition));
  lines.push(provLine('trusts the numbers', x.measurement?.trusts_numbers));
  lines.push(provLine('backend truth', x.measurement?.backend_truth));
  lines.push('');

  lines.push('## Brand');
  lines.push(provLine('what they are for', x.brand?.what_for));
  lines.push(provLine('audience', x.brand?.audience));
  lines.push(provLine('competitors get wrong', x.brand?.competitors_get_wrong));
  lines.push(provLine('Ada must never', x.brand?.never));
  if (x.brand?.tone_words?.length) lines.push(`- **tone words:** ${x.brand.tone_words.join(', ')}`);
  lines.push('');

  lines.push('## Creative');
  lines.push(provLine('who makes ads', x.creative?.who_makes));
  lines.push(provLine('cadence', x.creative?.cadence));
  lines.push(provLine('formats', x.creative?.formats));
  lines.push(provLine('off-limits', x.creative?.off_limits));
  lines.push('');

  lines.push('## Competitors');
  if (x.competitors?.length) {
    for (const c of x.competitors) {
      lines.push(
        `- **${c.name}**${c.feared ? ' (feared)' : ''}${c.why ? ` — ${c.why}` : ''}\n  > "${c.quote}" _(call ${c.call}, ${c.ts})_`,
      );
    }
  } else lines.push('- _not discussed_');
  lines.push('');

  lines.push('## History');
  lines.push(provLine('prior management', x.history?.prior_management));
  lines.push(provLine('sacred / do not touch', x.history?.sacred));
  lines.push(provLine('known bad-data periods', x.history?.bad_data));
  lines.push('');

  lines.push('## Autonomy & guidance');
  lines.push(provLine('starting level', x.autonomy));
  lines.push('');

  lines.push('## Starter rules (verbatim → rules engine after review)');
  if (x.rules_verbatim?.length) {
    for (const r of x.rules_verbatim) {
      lines.push(
        `- ${r.rule} — template: \`${r.template_match}\`\n  > "${r.quote}" _(call ${r.call}, ${r.ts})_`,
      );
    }
  } else lines.push('- _none captured_');
  lines.push('');

  lines.push('## Communication');
  lines.push(provLine('channel they actually read', x.communication?.channel));
  lines.push(provLine('cadence', x.communication?.cadence));
  lines.push(provLine('other recipients', x.communication?.recipients));
  lines.push('');

  if (x.business_facts?.length) {
    lines.push('## Other durable facts');
    for (const f of x.business_facts) lines.push(provLine('fact', f));
    lines.push('');
  }

  lines.push('## Gap list — ask at the next touchpoint');
  const unanswered = (x.unanswered ?? []) as Array<{ question: number; note?: string }>;
  if (unanswered.length) {
    for (const u of unanswered) {
      const q = KIT_QUESTIONS[u.question - 1] ?? `question ${u.question}`;
      lines.push(`- [ ] Q${u.question} — ${q}${u.note ? ` _(${u.note})_` : ''}`);
    }
  } else {
    lines.push('- all 12 kit questions answered (verify against the checklist by hand once)');
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const val = (p: string) => args.find((a) => a.startsWith(`${p}=`))?.slice(p.length + 1);
  const code = val('--code');
  const meetingIds = val('--meetings')?.split(',').map((s) => s.trim()).filter(Boolean);
  const validate = args.includes('--validate');

  if (!code || !meetingIds?.length) {
    console.error(
      'Usage: tsx --env-file=.env scripts/onboarding-intake.ts --code=<CODE> --meetings=<id,id> [--validate]',
    );
    process.exit(1);
  }

  const calls: Array<{ title: string; date: string; id: string }> = [];
  const transcriptBlocks: string[] = [];
  for (const [i, id] of meetingIds.entries()) {
    const t = await fetchTranscript(id);
    calls.push({ title: t.title, date: t.date, id });
    transcriptBlocks.push(`=== CALL ${i + 1}: ${t.header} ===\n${t.body}`);
    console.error(`call ${i + 1}: ${t.title} (${t.date}) — ${t.body.split('\n').length} lines`);
  }

  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  console.error(`extracting with ${MODEL}…`);
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 8000,
    temperature: 0,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: `Client code: ${code}. Extract the onboarding configuration from these ${meetingIds.length} call(s).\n\n${transcriptBlocks.join('\n\n')}`,
      },
    ],
  });

  const raw = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```$/, '');

  let extraction: Record<string, unknown>;
  try {
    extraction = JSON.parse(raw);
  } catch (err) {
    console.error('Model did not return valid JSON. Raw output follows:\n', raw.slice(0, 2000));
    throw err;
  }

  const md = renderProposal(code, extraction, calls);

  if (validate) {
    console.log(md);
    console.error('\n--validate: nothing written.');
    return;
  }

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const outPath = join(repoRoot, 'agents', 'ada', 'clients', '_intake', `${code}-proposed.md`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, md, 'utf8');
  console.error(`written: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
