/**
 * Phase-2 self-QC harness for SDK-Ada — the "does Ada break?" battery.
 * Each mode drives runAgentSDK exactly the way the Slack adapter would build
 * RunOptions, captures replies (no real Slack post), and records guard decisions.
 *
 *   cd /root/ada-sdk-spike && set -a && . /root/dai/.env && set +a && \
 *     node_modules/.bin/tsx scripts/ada-sdk-qc.ts <mode>
 *
 * modes: read | resume | blocked-writes | media-scan | media-upload | long
 */
import { runAgentSDK } from '../src/agents/sdk/runAgentSDK.js';
import type { GuardDecision } from '../src/agents/sdk/guard.js';

const JVA_FOLDER = 'https://drive.google.com/drive/folders/1fB7Dic2z9w6qHPKrqhgKNYNrxGGEt5J5';
const mode = process.argv[2] ?? 'read';

const decisions: GuardDecision[] = [];
function banner(s: string) { console.log(`\n########## ${s} ##########`); }
function show(label: string, r: { response: string; turns: number }, cost: number, tools: string[], subtype: string) {
  console.log(`\n--- ${label} | turns=${r.turns} cost=$${cost.toFixed(4)} subtype=${subtype} ---`);
  console.log(`tools: ${JSON.stringify(tools)}`);
  console.log(`denies: ${JSON.stringify(decisions.filter((d) => d.decision === 'deny').map((d) => `${d.bareName}:${d.reason}`))}`);
  console.log(`ANSWER:\n${r.response.slice(0, 1800)}`);
}

async function drive(userMessage: string, opts: {
  channelId?: string; threadTs?: string; policy?: Record<string, unknown>; label: string;
}) {
  decisions.length = 0;
  let cost = 0, subtype = '', tools: string[] = [];
  const r = await runAgentSDK(
    { source: 'qc', agentId: 'ada', userMessage, userId: 'eval-harness', channelId: opts.channelId ?? 'internal-qc', threadTs: opts.threadTs },
    { onDecision: (d) => decisions.push(d), onResult: (x) => { cost = x.costUsd; subtype = x.subtype; tools = x.toolsUsed; }, policy: opts.policy as never, maxBudgetUsd: 3 },
  );
  show(opts.label, r, cost, tools, subtype);
  return { r, cost, tools, subtype, decisions: [...decisions] };
}

async function main() {
  if (mode === 'read') {
    // Multi-step live read (≥2 tool calls) on a REAL client (test acct is not a dai client).
    banner('QC: live multi-step read (cross-account, real data)');
    await drive(
      "Laori's CPA looks high today. Is this a Meta-wide thing or just us? Compare against at least two other accounts before answering.",
      { channelId: 'internal-qc-read', label: 'cross-account read' },
    );
  } else if (mode === 'resume') {
    banner('QC: 3-turn thread resume (context persistence)');
    const ch = 'internal-qc-resume', th = '1781560000.000100';
    await drive('I want to focus on Teethlovers this week. Remember that. Reply briefly.', { channelId: ch, threadTs: th, label: 'turn1' });
    await drive('What CPA target should I hold it to? (use the client I just named)', { channelId: ch, threadTs: th, label: 'turn2' });
    await drive('And which client have we been talking about this whole thread? One word.', { channelId: ch, threadTs: th, label: 'turn3' });
  } else if (mode === 'blocked-writes') {
    banner('QC: blocked-write checks (must DENY)');
    // (1) launch on a NON-test client; (2) a Notion task write. Both must be denied.
    await drive(
      'Please do two things: (1) launch the most recent previewed batch for client LA, and (2) create a Notion task titled "QC test task" assigned to Dan. If anything is blocked, say so.',
      { channelId: 'internal-qc-blocked', label: 'blocked-writes', policy: { allowTestMutations: false } },
    );
  } else if (mode === 'media-scan') {
    // Slack-shaped: reference the JVA Drive folder; READ-ONLY scan only.
    banner('QC: Slack-invoked media capability — SCAN ONLY (read)');
    await drive(
      `Here's a Google Drive folder of creatives: ${JVA_FOLDER} — scan it and tell me what's in it, what the correct SweetSpot/ad-ID names would be, and which Business Manager it would upload to. Do NOT upload yet, just scan.`,
      { channelId: 'C0SLACKSHAPED', threadTs: '1781560000.000200', label: 'media-scan', policy: { allowTestMutations: false } },
    );
  } else if (mode === 'media-upload') {
    // GATED authorized upload (rail 4b). Only run deliberately.
    banner('QC: Slack-invoked media upload (AUTHORIZED, test BM) — gated');
    await drive(
      `Upload exactly ONE creative from this folder to the Media Library: ${JVA_FOLDER}. This is a test upload for the internal Ads on Tap test account.`,
      { channelId: 'C0SLACKSHAPED', threadTs: '1781560000.000300', label: 'media-upload',
        policy: { allowTestMutations: true, allowMediaUpload: true } },
    );
  } else if (mode === 'long') {
    banner('QC: long/ambiguous task (coherence + compaction)');
    await drive(
      'Give me a thorough cross-client health read: for Laori, Teethlovers, and Press London, pull the last 7 days, flag any account whose CPA/CPA-equivalent is worrying vs target, scan for daily anomalies before averaging, and end with the single most urgent thing to look at across all three.',
      { channelId: 'internal-qc-long', label: 'long-task' },
    );
  } else {
    console.error('unknown mode', mode); process.exit(1);
  }
  process.exit(0);
}
main().catch((e) => { console.error('QC FATAL', e); process.exit(1); });
