/**
 * PHASE 0 SPIKE — Agent-SDK Ada go/no-go.
 *
 * Proves the five primitives the whole bet rests on, each with real evidence:
 *   1. wrap dai tool handlers as an in-process MCP server + the model calls one
 *   2. load an `ada-*` skill via settingSources:['project'] + cwd + skills:[]
 *   3. resume a session across two query() calls
 *   4. a PreToolUse hook DENIES a write tool (proved via result.permission_denials)
 *   5. run one golden-eval question through query() and show the answer
 *
 * Throwaway driver. Run ON THE DROPLET from the scratch dir (working key + tokens):
 *   cd /root/ada-sdk-spike && set -a && . /root/.env && set +a && \
 *     node_modules/.bin/tsx scripts/ada-sdk-spike.ts
 *
 * Mechanics tests (1-4) use haiku to save cost; test 5 uses Ada's real model.
 */
import { mkdirSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { getAgent } from '../src/agents/registry.js';
import type { ToolContext } from '../src/agents/tool-registry.js';
import { buildAdaToolBridge } from '../src/agents/sdk/tool-bridge.js';
import { makePreToolUseHook, makeCanUseTool, defaultPolicy, type GuardDecision } from '../src/agents/sdk/guard.js';

const ADA_MODEL = 'claude-opus-4-8';
const CHEAP_MODEL = 'claude-haiku-4-5-20251001';

// --- skills dir (clean: only ada-* skills, no stray CLAUDE.md/settings) ------
const SKILLS_ROOT = '/root/ada-sdk-spike/skills-root';
const BMAD_SKILLS = '/root/bmad/.claude/skills';
const ADA_SKILLS = [
  'ada-media-library', 'ada-sweetspot-namer', 'ada-ready-to-upload',
  'ada-website-walk', 'ada-call-insights', 'ada-client-change-alerts',
];

function setupSkillsDir(): void {
  const dest = join(SKILLS_ROOT, '.claude', 'skills');
  mkdirSync(dest, { recursive: true });
  for (const s of ADA_SKILLS) {
    const link = join(dest, s);
    const target = join(BMAD_SKILLS, s);
    if (!existsSync(target)) { console.warn(`[skills] missing ${target}`); continue; }
    try { if (existsSync(link)) rmSync(link, { recursive: true, force: true }); symlinkSync(target, link); }
    catch (e) { console.warn(`[skills] link ${s} failed`, e); }
  }
}

// --- shared options ----------------------------------------------------------
const ada = getAgent('ada');
if (!ada) throw new Error('ada agent not found');
const systemPrompt = [ada.persona, ada.instructions, ...ada.extras.map((e) => e.content)].join('\n\n');

const decisions: GuardDecision[] = [];
const policy = defaultPolicy({ onDecision: (d) => decisions.push(d) });

function ctx(): ToolContext {
  return { agentId: 'ada', channelId: 'internal-spike', userId: 'eval-harness' };
}

const bridge = buildAdaToolBridge('media_buyer', { getContext: ctx });

interface RunOut { text: string; toolUses: string[]; sessionId?: string; cost?: number; denials: string[]; numTurns?: number; resultSubtype?: string; systemTools?: string[]; systemSlash?: string[]; }

async function runQuery(prompt: string, opts: { model: string; resume?: string; skills?: string[]; maxTurns?: number }): Promise<RunOut> {
  const out: RunOut = { text: '', toolUses: [], denials: [] };
  const q = query({
    prompt,
    options: {
      model: opts.model,
      systemPrompt,
      cwd: SKILLS_ROOT,
      settingSources: ['project'],
      ...(opts.skills ? { skills: opts.skills } : {}),
      mcpServers: { [bridge.serverName]: bridge.server },
      hooks: { PreToolUse: [{ hooks: [makePreToolUseHook(policy)] }] },
      canUseTool: makeCanUseTool(policy),
      permissionMode: 'default',
      maxTurns: opts.maxTurns ?? 12,
      maxBudgetUsd: 2,
      ...(opts.resume ? { resume: opts.resume } : {}),
    },
  });
  for await (const msg of q) {
    if (msg.type === 'system') {
      const m = msg as Record<string, unknown>;
      if (m.subtype === 'init') {
        out.systemTools = (m.tools as string[]) ?? [];
        out.systemSlash = (m.slash_commands as string[]) ?? [];
      }
    } else if (msg.type === 'assistant') {
      const content = (msg as { message?: { content?: unknown[] } }).message?.content ?? [];
      for (const b of content) {
        const blk = b as { type?: string; text?: string; name?: string };
        if (blk.type === 'text' && blk.text) out.text += blk.text;
        if (blk.type === 'tool_use' && blk.name) out.toolUses.push(blk.name);
      }
    } else if (msg.type === 'result') {
      const r = msg as Record<string, unknown>;
      out.sessionId = r.session_id as string;
      out.cost = r.total_cost_usd as number;
      out.numTurns = r.num_turns as number;
      out.resultSubtype = r.subtype as string;
      if (typeof r.result === 'string' && r.result && !out.text) out.text = r.result as string;
      const denials = (r.permission_denials as Array<{ tool_name?: string }>) ?? [];
      out.denials = denials.map((d) => d.tool_name ?? '?');
    }
  }
  return out;
}

function line(s: string) { console.log(s); }

async function main() {
  setupSkillsDir();
  line(`\n##### PHASE 0 SPIKE — ${new Date().toISOString()} #####`);
  line(`bridge: ${bridge.toolNames.length} tools wrapped as mcp server "${bridge.serverName}"`);
  let totalCost = 0;

  // ---- TEST 1: tool wrap — model calls a wrapped dai read tool, real data ----
  line(`\n=== TEST 1: tool wrap (list_clients via in-process MCP) ===`);
  try {
    const r = await runQuery('Call list_clients and tell me how many clients we have and name three of them. One short sentence.', { model: CHEAP_MODEL, maxTurns: 6 });
    totalCost += r.cost ?? 0;
    const calledOurTool = r.toolUses.some((t) => t.startsWith('mcp__ada-tools__'));
    line(`tool_uses: ${JSON.stringify(r.toolUses)}`);
    line(`answer: ${r.text.slice(0, 400)}`);
    line(`RESULT: ${calledOurTool && r.text.length > 0 ? 'PASS' : 'FAIL'} (calledWrappedTool=${calledOurTool}, cost=$${(r.cost ?? 0).toFixed(4)})`);
    // skill-load evidence captured from the same query's init message
    line(`\n=== TEST 2: skill load (init message) ===`);
    const hasSkillTool = (r.systemTools ?? []).some((t) => t === 'Skill' || /skill/i.test(t));
    line(`system tools incl Skill? ${hasSkillTool}; tool count=${(r.systemTools ?? []).length}`);
    line(`slash_commands (skills surface here): ${JSON.stringify(r.systemSlash)}`);
  } catch (e) { line(`TEST 1/2 ERROR: ${e}`); }

  // ---- TEST 2b: functional skill check — does an ada-* skill actually load? ----
  line(`\n=== TEST 2b: functional skill load (ada-media-library) ===`);
  try {
    const r = await runQuery('Use your Skill tool to load the skill named "ada-media-library", then in ONE sentence state the routing rule it gives for which Business Manager Teethlovers and Laori upload to.', { model: CHEAP_MODEL, skills: ['ada-media-library'], maxTurns: 6 });
    totalCost += r.cost ?? 0;
    const usedSkill = r.toolUses.some((t) => t === 'Skill' || /skill/i.test(t));
    const mentionsGrowthSquad = /growth\s*squad/i.test(r.text);
    line(`tool_uses: ${JSON.stringify(r.toolUses)}`);
    line(`answer: ${r.text.slice(0, 400)}`);
    line(`RESULT: ${usedSkill || mentionsGrowthSquad ? 'PASS' : 'INCONCLUSIVE'} (usedSkillTool=${usedSkill}, citesRoutingRule=${mentionsGrowthSquad})`);
  } catch (e) { line(`TEST 2b ERROR: ${e}`); }

  // ---- TEST 3: session resume across two query() calls ----
  line(`\n=== TEST 3: session resume ===`);
  try {
    const r1 = await runQuery('Remember this for later: the project codeword is BANANA-42. Reply with just "noted".', { model: CHEAP_MODEL, maxTurns: 3 });
    totalCost += r1.cost ?? 0;
    line(`turn1 session_id=${r1.sessionId} answer=${r1.text.slice(0, 120)}`);
    const r2 = await runQuery('What was the project codeword I told you? Reply with just the codeword.', { model: CHEAP_MODEL, resume: r1.sessionId, maxTurns: 3 });
    totalCost += r2.cost ?? 0;
    const persisted = /BANANA-42/i.test(r2.text);
    line(`turn2 answer=${r2.text.slice(0, 120)}`);
    line(`RESULT: ${persisted ? 'PASS' : 'FAIL'} (codeword recalled across resume=${persisted})`);
  } catch (e) { line(`TEST 3 ERROR: ${e}`); }

  // ---- TEST 4: PreToolUse hook DENIES a write tool ----
  line(`\n=== TEST 4: PreToolUse deny (post_message must be blocked) ===`);
  try {
    const before = decisions.length;
    const r = await runQuery('Post the message "spike test, please ignore" to Slack channel C0SPIKETEST using your post_message tool. If it is blocked, just say it was blocked.', { model: CHEAP_MODEL, maxTurns: 5 });
    totalCost += r.cost ?? 0;
    const denyDecisions = decisions.slice(before).filter((d) => d.decision === 'deny');
    const postDenied = denyDecisions.some((d) => d.bareName === 'post_message') || r.denials.some((t) => /post_message/.test(t));
    line(`guard deny decisions this test: ${JSON.stringify(denyDecisions.map((d) => `${d.bareName}:${d.reason}`))}`);
    line(`result.permission_denials: ${JSON.stringify(r.denials)}`);
    line(`answer: ${r.text.slice(0, 300)}`);
    line(`RESULT: ${postDenied ? 'PASS' : 'FAIL'} (post_message denied=${postDenied})`);
  } catch (e) { line(`TEST 4 ERROR: ${e}`); }

  // ---- TEST 5: one golden eval (capability-rename) on Ada's real model ----
  line(`\n=== TEST 5: golden eval [capability-rename] on ${ADA_MODEL} ===`);
  try {
    const r = await runQuery('Can you rename assets in a Google Drive folder?', { model: ADA_MODEL, skills: ['ada-media-library', 'ada-sweetspot-namer'], maxTurns: 8 });
    totalCost += r.cost ?? 0;
    line(`tool_uses: ${JSON.stringify(r.toolUses)}`);
    line(`turns=${r.numTurns} cost=$${(r.cost ?? 0).toFixed(4)} subtype=${r.resultSubtype}`);
    line(`--- ANSWER ---\n${r.text.slice(0, 1600)}`);
    line(`(rubric: concrete YES + scan→rename→upload flow + asks for folder link; judge in report)`);
  } catch (e) { line(`TEST 5 ERROR: ${e}`); }

  line(`\n##### PHASE 0 cumulative cost: $${totalCost.toFixed(4)} #####`);
  line(`##### guard decisions total: ${decisions.length} (allow=${decisions.filter((d) => d.decision === 'allow').length}, deny=${decisions.filter((d) => d.decision === 'deny').length}) #####`);
  process.exit(0);
}

main().catch((e) => { console.error('SPIKE FATAL', e); process.exit(1); });
