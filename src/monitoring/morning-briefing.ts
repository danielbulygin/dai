/**
 * Ada Morning Briefing — formats heartbeat results and posts to Slack.
 */

import { getDedicatedBotClient } from '../slack/dedicated-bots.js';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import { runDailyHeartbeat, type ClientHeartbeat, type HeartbeatReport } from './account-heartbeat.js';
import type { AnomalySignal } from './anomaly-detector.js';

// ---------------------------------------------------------------------------
// Metric formatting
// ---------------------------------------------------------------------------

const METRIC_LABELS: Record<string, string> = {
  spend: 'Spend',
  cpm: 'CPM',
  cpc: 'CPC',
  ctr: 'CTR',
  frequency: 'Freq',
  roas: 'ROAS',
  purchases: 'Purchases',
  purchase_value: 'Revenue',
  cost_per_result: 'CPA',
  leads: 'Leads',
  complete_registrations: 'Registrations',
  results: 'Results',
  add_to_carts: 'ATCs',
  checkouts_initiated: 'Checkouts',
  content_views: 'Content Views',
  impressions: 'Impressions',
  reach: 'Reach',
};

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}K`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(2);
}

function formatMetricValue(metric: string, value: number): string {
  switch (metric) {
    case 'spend':
    case 'purchase_value':
      return `$${formatCompact(value)}`;
    case 'cpm':
    case 'cpc':
    case 'cost_per_result':
      return `$${value.toFixed(2)}`;
    case 'roas':
      return value.toFixed(2);
    case 'ctr':
    case 'ctr_link':
      return `${value.toFixed(2)}%`;
    case 'frequency':
      return value.toFixed(1);
    default:
      return value >= 10_000
        ? formatCompact(value)
        : value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
}

/** Pick the most impactful anomaly to headline the account line. */
function pickPrimaryAnomaly(hb: ClientHeartbeat): AnomalySignal | null {
  if (hb.anomalies.length === 0) return null;

  // Prefer KPI metrics by client type
  const kpiOrder: Record<string, string[]> = {
    ecom: ['roas', 'purchases', 'cost_per_result', 'cpm', 'ctr'],
    lead_gen: ['cost_per_result', 'leads', 'results', 'cpm', 'ctr'],
    app: ['cost_per_result', 'results', 'cpm', 'ctr'],
    unknown: ['spend', 'cpm', 'ctr'],
  };

  const preferred = kpiOrder[hb.clientType] ?? kpiOrder['unknown']!;

  // Sort by: severity (P0 first), then KPI preference, then abs % change
  const sorted = [...hb.anomalies].sort((a, b) => {
    const sevDiff = severityRank(a.severity) - severityRank(b.severity);
    if (sevDiff !== 0) return sevDiff;
    const aIdx = preferred!.indexOf(a.metric);
    const bIdx = preferred!.indexOf(b.metric);
    const aPref = aIdx >= 0 ? aIdx : 99;
    const bPref = bIdx >= 0 ? bIdx : 99;
    if (aPref !== bPref) return aPref - bPref;
    return Math.abs(b.percentChange) - Math.abs(a.percentChange);
  });

  return sorted[0] ?? null;
}

function severityRank(severity: string): number {
  switch (severity) {
    case 'P0': return 0;
    case 'P1': return 1;
    case 'P2': return 2;
    case 'P3': return 3;
    default: return 4;
  }
}

// ---------------------------------------------------------------------------
// Briefing formatting
// ---------------------------------------------------------------------------

function formatAnomalyBrief(a: AnomalySignal): string {
  const label = METRIC_LABELS[a.metric] ?? a.metric;
  const current = formatMetricValue(a.metric, a.currentValue);
  const arrow = a.direction === 'up' ? '\u2191' : '\u2193';
  return `${label} ${current} ${arrow}${Math.abs(a.percentChange)}%`;
}

function formatAccountLine(hb: ClientHeartbeat): string {
  const primary = pickPrimaryAnomaly(hb);
  const parts: string[] = [];

  if (primary) {
    const label = METRIC_LABELS[primary.metric] ?? primary.metric;
    const current = formatMetricValue(primary.metric, primary.currentValue);
    const arrow = primary.direction === 'up' ? '\u2191' : '\u2193';

    // Show target if available, otherwise baseline avg
    let comparison = '';
    const targetValue = hb.targets?.[primary.metric];
    if (typeof targetValue === 'number') {
      comparison = ` (target ${formatMetricValue(primary.metric, targetValue)})`;
    } else {
      comparison = ` (avg ${formatMetricValue(primary.metric, primary.baselineAvg)})`;
    }

    let headline = `*${hb.clientName}* \u2014 ${label} ${current}${comparison} ${arrow}${Math.abs(primary.percentChange)}%`;

    // Add frequency if elevated
    if (
      hb.todayFrequency &&
      hb.todayFrequency > 2.5 &&
      primary.metric !== 'frequency'
    ) {
      headline += ` | Freq ${hb.todayFrequency.toFixed(1)}`;
    }

    // Add data staleness warning
    if (hb.dataStale) {
      headline += ` :warning: _stale (${hb.latestDate})_`;
    }

    parts.push(headline);

    // Show 1 additional anomaly for critical/alert (sorted by relevance)
    if (hb.health === 'critical' || hb.health === 'alert') {
      const kpiOrder: Record<string, string[]> = {
        ecom: ['roas', 'purchases', 'cost_per_result', 'cpm', 'ctr'],
        lead_gen: ['cost_per_result', 'leads', 'results', 'cpm', 'ctr'],
        app: ['cost_per_result', 'results', 'cpm', 'ctr'],
        unknown: ['spend', 'cpm', 'ctr'],
      };
      const preferred = kpiOrder[hb.clientType] ?? kpiOrder['unknown']!;
      const others = [...hb.anomalies]
        .filter((a) => a.metric !== primary.metric)
        .sort((a, b) => {
          const sevDiff = severityRank(a.severity) - severityRank(b.severity);
          if (sevDiff !== 0) return sevDiff;
          const aIdx = preferred!.indexOf(a.metric);
          const bIdx = preferred!.indexOf(b.metric);
          return (aIdx >= 0 ? aIdx : 99) - (bIdx >= 0 ? bIdx : 99);
        })
        .slice(0, 1);
      if (others.length > 0) {
        parts.push(`  also: ${others.map(formatAnomalyBrief).join(', ')}`);
      }
    }
  } else {
    let headline = `*${hb.clientName}*`;
    if (hb.dataStale) {
      headline += ` :warning: _stale (${hb.latestDate})_`;
    }
    parts.push(headline);
  }

  // Add compound signal descriptions
  for (const compound of hb.compounds) {
    parts.push(`  \u2192 ${compound.description}`);
  }

  return parts.join('\n');
}

function formatBriefingMessage(report: HeartbeatReport): string {
  const lines: string[] = [];

  const date = new Date().toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  lines.push(
    `:chart_with_upwards_trend: *Ada Morning Briefing* \u2014 ${date}`,
  );
  lines.push('');

  // Group by health tier
  const critical = report.clients.filter((c) => c.health === 'critical');
  const alert = report.clients.filter((c) => c.health === 'alert');
  const watch = report.clients.filter((c) => c.health === 'watch');
  const healthy = report.clients.filter((c) => c.health === 'healthy');

  // Platform-wide issue
  if (report.platformIssue) {
    lines.push(
      `:globe_with_meridians: *PLATFORM ISSUE*`,
    );
    lines.push(report.platformIssue.description);
    lines.push(report.platformIssue.evidence.join(', '));
    lines.push('');
  }

  // Critical
  if (critical.length > 0) {
    lines.push(`:red_circle: *CRITICAL* (${critical.length})`);
    for (const c of critical) {
      lines.push(formatAccountLine(c));
    }
    lines.push('');
  }

  // Alert
  if (alert.length > 0) {
    lines.push(`:warning: *ALERT* (${alert.length})`);
    for (const a of alert) {
      lines.push(formatAccountLine(a));
    }
    lines.push('');
  }

  // Watch — compact one-liner per account
  if (watch.length > 0) {
    lines.push(`:eyes: *WATCH* (${watch.length})`);
    for (const w of watch) {
      const primary = pickPrimaryAnomaly(w);
      if (primary) {
        const label = METRIC_LABELS[primary.metric] ?? primary.metric;
        const arrow = primary.direction === 'up' ? '\u2191' : '\u2193';
        lines.push(
          `*${w.clientName}* \u2014 ${label} ${arrow}${Math.abs(primary.percentChange)}%`,
        );
      } else {
        lines.push(`*${w.clientName}*`);
      }
    }
    lines.push('');
  }

  // Healthy
  if (healthy.length > 0) {
    lines.push(`:white_check_mark: *HEALTHY* (${healthy.length})`);
    if (healthy.length <= 3) {
      for (const h of healthy) {
        lines.push(`*${h.clientName}*`);
      }
    } else {
      lines.push('All other accounts within targets.');
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main: sendMorningBriefing
// ---------------------------------------------------------------------------

export async function sendMorningBriefing(): Promise<HeartbeatReport> {
  logger.info('Generating Ada morning briefing');

  const report = await runDailyHeartbeat({ persistAlerts: true });
  const message = formatBriefingMessage(report);

  // Post via Ada's dedicated bot
  const channel = env.SLACK_REVIEW_CHANNEL_ID ?? env.SLACK_OWNER_USER_ID;

  try {
    await getDedicatedBotClient('ada').chat.postMessage({
      channel,
      text: message,
    });
    logger.info(
      { channel, summary: report.summary },
      'Ada morning briefing sent',
    );
  } catch (err) {
    logger.error({ err, channel }, 'Failed to send morning briefing via Ada bot');
    // Fallback: try main bot
    try {
      const { postMessage } = await import('../agents/tools/slack-tools.js');
      await postMessage({ channel, text: message });
      logger.info('Morning briefing sent via fallback bot');
    } catch (fallbackErr) {
      logger.error({ err: fallbackErr }, 'Fallback briefing send also failed');
    }
  }

  return report;
}

/** Format report for console output (used by CLI script). */
export function formatReportConsole(report: HeartbeatReport): string {
  const lines: string[] = [];

  lines.push(`\n=== Ada Heartbeat Report ===`);
  lines.push(`Timestamp: ${report.timestamp}`);
  lines.push(
    `Summary: ${report.summary.critical} critical, ${report.summary.alert} alert, ${report.summary.watch} watch, ${report.summary.healthy} healthy (${report.summary.total} total)`,
  );

  if (report.platformIssue) {
    lines.push(`\nPLATFORM ISSUE: ${report.platformIssue.description}`);
  }

  const tiers: [string, ClientHeartbeat[]][] = [
    ['CRITICAL', report.clients.filter((c) => c.health === 'critical')],
    ['ALERT', report.clients.filter((c) => c.health === 'alert')],
    ['WATCH', report.clients.filter((c) => c.health === 'watch')],
  ];

  for (const [tier, clients] of tiers) {
    if (clients.length === 0) continue;
    lines.push(`\n--- ${tier} ---`);
    for (const c of clients) {
      lines.push(`  ${c.clientName} (${c.clientCode}) [${c.clientType}]`);
      if (c.dataStale) lines.push(`    DATA STALE: latest ${c.latestDate}`);
      for (const a of c.anomalies) {
        lines.push(
          `    ${a.severity} ${a.metric}: ${a.currentValue} (avg ${a.baselineAvg}) ${a.direction} ${a.percentChange}% (${a.deviations}σ)`,
        );
      }
      for (const comp of c.compounds) {
        lines.push(`    → ${comp.type}: ${comp.description}`);
        for (const e of comp.evidence) {
          lines.push(`      ${e}`);
        }
      }
      if (c.topCampaignIssues.length > 0) {
        const ci = c.topCampaignIssues[0]!;
        lines.push(
          `    Top campaign: ${ci.campaignName} ($${ci.spend.toFixed(0)})`,
        );
      }
    }
  }

  const healthy = report.clients.filter((c) => c.health === 'healthy');
  if (healthy.length > 0) {
    lines.push(`\n--- HEALTHY (${healthy.length}) ---`);
    for (const h of healthy) {
      const notes = [];
      if (h.insufficientData) notes.push('insufficient data');
      if (h.dataStale) notes.push(`stale: ${h.latestDate}`);
      if (h.todaySpend !== undefined && h.todaySpend < 10) notes.push('paused/low spend');
      const suffix = notes.length > 0 ? ` (${notes.join(', ')})` : '';
      lines.push(`  ${h.clientName} (${h.clientCode})${suffix}`);
    }
  }

  return lines.join('\n');
}
