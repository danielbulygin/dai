import Anthropic from '@anthropic-ai/sdk';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import type { CondensedReport, ReportResult } from './types.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const REPORT_MODEL = 'claude-opus-4-6';

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

// ---------------------------------------------------------------------------
// Client context loader
// ---------------------------------------------------------------------------

async function loadClientContext(clientCode: string): Promise<string> {
  const contextPath = join(
    process.cwd(),
    'agents',
    'ada',
    'clients',
    `${clientCode.toUpperCase()}.md`,
  );
  try {
    return await readFile(contextPath, 'utf-8');
  } catch {
    logger.warn({ clientCode, contextPath }, 'No client context file found');
    return '';
  }
}

// ---------------------------------------------------------------------------
// Report template
// ---------------------------------------------------------------------------

function buildSystemPrompt(clientContext: string): string {
  const parts = [
    'You are Ada, an expert media buyer and advertising analyst at Ads on Tap.',
    'You are writing a weekly performance report for a client account.',
    '',
    'RULES:',
    '- Write in Slack mrkdwn format (NOT markdown). Use *bold*, _italic_, ~strikethrough~.',
    '- Use *bold* for section headers (not # headers).',
    '- Use bullet points with - (not *).',
    '- Numbers must be specific — never say "improved" without the exact percentage.',
    '- Every claim must be backed by data from the condensed report.',
    '- Be direct and analytical, not salesy. This is for Daniel (agency owner) to review before sending to client.',
    '- Root cause analysis: don\'t just say what changed — explain WHY (algorithm behavior, audience shifts, creative fatigue, etc.).',
    '- When ROAS or CPA changes, trace it through the funnel — which stage broke?',
    '- Flag anything anomalous — days with unusual spikes/dips, campaigns behaving unexpectedly.',
    '- If client targets exist, compare actuals vs targets.',
    '- Currency: use the currency from the report data.',
    '- Keep the report focused and scannable — Daniel reviews 10+ of these.',
    '- Do NOT use markdown headers (# or ##). Use *bold text* on its own line for sections.',
    '',
    'REPORT STRUCTURE:',
    '',
    '*{Client Name} — Weekly Report*',
    '_{period}_',
    '',
    '*Bottom Line*',
    '1-3 sentences: the story of this week. What was the dominant theme?',
    '',
    '*Key Numbers*',
    '- Spend, primary KPI, frequency, health — each with WoW change',
    '',
    '*What Worked*',
    '2-4 bullets with specific numbers and why they worked',
    '',
    '*What Didn\'t Work*',
    '2-4 bullets with root cause analysis',
    '',
    '*Changes This Week*',
    'Account changes + their measured impact (if data allows correlation)',
    '',
    '*Funnel Analysis*',
    'Where does conversion drop? Compare rates WoW.',
    '',
    '*Creative Status*',
    'Fatigued count, top performers, pipeline needs',
    '',
    '*Recommendations*',
    '1. {action} — {rationale} → {expected impact}',
    '',
    '*Next Week Focus*',
    'What to watch, what to act on',
  ];

  if (clientContext) {
    parts.push('', '---', '', 'CLIENT CONTEXT:', clientContext);
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Stage 3: Narrative Generation
// ---------------------------------------------------------------------------

export async function generateNarrative(
  condensed: CondensedReport,
): Promise<ReportResult> {
  logger.info({ clientCode: condensed.clientCode }, 'Generating report narrative');

  const clientContext = await loadClientContext(condensed.clientCode);
  const systemPrompt = buildSystemPrompt(clientContext);

  // Build the data payload for the LLM — readable format
  const dataPayload = formatCondensedForLLM(condensed);

  const response = await getClient().messages.create({
    model: REPORT_MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: `Generate the weekly performance report based on this condensed data:\n\n${dataPayload}`,
      },
    ],
  });

  const reportText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  logger.info(
    {
      clientCode: condensed.clientCode,
      reportLength: reportText.length,
      inputTokens,
      outputTokens,
    },
    'Report narrative generated',
  );

  return {
    reportText,
    condensedData: condensed,
    inputTokens,
    outputTokens,
  };
}

// ---------------------------------------------------------------------------
// Format condensed data for LLM consumption
// ---------------------------------------------------------------------------

function formatCondensedForLLM(c: CondensedReport): string {
  const lines: string[] = [];

  lines.push(`CLIENT: ${c.clientName} (${c.clientCode})`);
  lines.push(`CURRENCY: ${c.currency}`);
  lines.push(`PERIOD: ${c.periodStart} to ${c.periodEnd}`);
  lines.push(`HEALTH: ${c.healthScore}`);
  lines.push(`HEALTH REASONS: ${c.healthReasons.join('; ')}`);
  lines.push('');

  // WoW deltas
  lines.push('=== WEEK-OVER-WEEK ===');
  lines.push(`Primary KPI (${c.wow.primaryKpiName}): ${c.wow.primaryKpi.current} (prior: ${c.wow.primaryKpi.prior}, ${fmtPct(c.wow.primaryKpi.changePct)})`);
  lines.push(`Spend: ${fmtNum(c.wow.spend.current)} (prior: ${fmtNum(c.wow.spend.prior)}, ${fmtPct(c.wow.spend.changePct)})`);
  lines.push(`Impressions: ${fmtNum(c.wow.impressions.current)} (${fmtPct(c.wow.impressions.changePct)})`);
  lines.push(`Purchases: ${c.wow.purchases.current} (${fmtPct(c.wow.purchases.changePct)})`);
  lines.push(`Revenue: ${fmtNum(c.wow.revenue.current)} (${fmtPct(c.wow.revenue.changePct)})`);
  lines.push(`Frequency: ${c.wow.frequency.current} (${fmtPct(c.wow.frequency.changePct)})`);
  lines.push(`CTR: ${c.wow.ctr.current}% (${fmtPct(c.wow.ctr.changePct)})`);
  lines.push(`CPM: ${fmtNum(c.wow.cpm.current)} (${fmtPct(c.wow.cpm.changePct)})`);
  lines.push('');

  // Targets
  if (c.targets) {
    lines.push('=== TARGETS ===');
    lines.push(JSON.stringify(c.targets, null, 2));
    lines.push('');
  }

  // Anomalies
  if (c.anomalies.length > 0) {
    lines.push('=== DAILY ANOMALIES ===');
    for (const a of c.anomalies) {
      lines.push(`${a.date}: ${a.metric} = ${a.value} (avg: ${a.weekAvg}, ${fmtPct(a.deviationPct)} deviation)`);
    }
    lines.push('');
  }

  // Top campaigns
  if (c.topCampaigns.length > 0) {
    lines.push('=== TOP CAMPAIGNS (by spend) ===');
    for (const camp of c.topCampaigns) {
      const flags = camp.flags.length > 0 ? ` [${camp.flags.join(', ')}]` : '';
      lines.push(`- ${camp.campaignName}: spend ${fmtNum(camp.spend)} (${fmtPct(camp.spendChange)}), ${c.wow.primaryKpiName} ${camp.primaryKpi} (${fmtPct(camp.primaryKpiChange)})${flags}`);
    }
    lines.push('');
  }

  // Flagged campaigns
  if (c.flaggedCampaigns.length > 0) {
    lines.push('=== FLAGGED CAMPAIGNS ===');
    for (const camp of c.flaggedCampaigns) {
      lines.push(`- ${camp.campaignName}: ${camp.flags.join(', ')} | spend ${fmtNum(camp.spend)} (${fmtPct(camp.spendChange)}), ${c.wow.primaryKpiName} ${camp.primaryKpi} (${fmtPct(camp.primaryKpiChange)})`);
    }
    lines.push('');
  }

  // Bottom campaigns
  if (c.bottomCampaigns.length > 0) {
    lines.push('=== BOTTOM CAMPAIGNS ===');
    for (const camp of c.bottomCampaigns) {
      lines.push(`- ${camp.campaignName}: spend ${fmtNum(camp.spend)}, ${c.wow.primaryKpiName} ${camp.primaryKpi}`);
    }
    lines.push('');
  }

  // Funnel
  if (c.funnel.length > 0) {
    lines.push('=== FUNNEL ===');
    for (const f of c.funnel) {
      lines.push(`${f.stage}: ${fmtNum(f.value)} (rate: ${f.rate}%, prior: ${f.priorRate}%, change: ${f.rateChange > 0 ? '+' : ''}${f.rateChange}pp)`);
    }
    lines.push('');
  }

  // Breakdowns
  if (c.breakdownInsights.length > 0) {
    lines.push('=== BREAKDOWNS ===');
    for (const b of c.breakdownInsights) {
      lines.push(`--- ${b.type} ---`);
      for (const s of b.topSegments) {
        lines.push(`  ${s.value}: spend ${fmtNum(s.spend)}, ROAS ${s.roas}x, CPA ${fmtNum(s.cpa)}`);
      }
      if (b.shifts.length > 0) {
        lines.push(`  Insights: ${b.shifts.join('; ')}`);
      }
    }
    lines.push('');
  }

  // Change correlations
  if (c.changeCorrelations.length > 0) {
    lines.push('=== CHANGE CORRELATIONS ===');
    for (const ch of c.changeCorrelations) {
      lines.push(`${ch.date}: ${ch.change} → ${ch.impact}`);
    }
    lines.push('');
  }

  // Creative
  lines.push('=== CREATIVE STATUS ===');
  lines.push(`Active: ${c.creative.totalActive}, Fatigued: ${c.creative.fatiguedCount}, Recent launches: ${c.creative.recentLaunches}`);
  if (c.creative.topPerformers.length > 0) {
    lines.push('Top performers:');
    for (const tp of c.creative.topPerformers) {
      lines.push(`  - ${tp.name}: ${tp.metric} = ${tp.score}`);
    }
  }
  lines.push('');

  // Drill-downs
  if (c.drilldowns.length > 0) {
    lines.push('=== CAMPAIGN DRILL-DOWNS ===');
    for (const d of c.drilldowns) {
      lines.push(`${d.campaignName} (${d.reason}): ${d.details}`);
    }
    lines.push('');
  }

  // Methodology context
  if (c.methodology.length > 0) {
    lines.push('=== ACCOUNT METHODOLOGY ===');
    for (const m of c.methodology.slice(0, 10)) {
      lines.push(`- ${m}`);
    }
    lines.push('');
  }

  // Learnings context
  if (c.learnings.length > 0) {
    lines.push('=== ACCUMULATED LEARNINGS ===');
    for (const l of c.learnings.slice(0, 10)) {
      lines.push(`- ${l}`);
    }
  }

  return lines.join('\n');
}

function fmtNum(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(2);
}

function fmtPct(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}
