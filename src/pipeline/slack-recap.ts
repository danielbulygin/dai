/**
 * Post a shadow-mode meeting recap to Slack using Block Kit.
 */

import { getDedicatedBotClient } from '../slack/dedicated-bots.js';
import { getSlackChannelForDomain } from '../config/client-domains.js';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import type { MeetingClassification } from './classifier.js';
import type { UniversalExtraction } from './extractor.js';

// Map client codes to their primary domain for channel lookup
const CLIENT_CODE_TO_DOMAIN: Record<string, string> = {
  AB: 'audibene.de',
  TL: 'teethlovers.de',
};

export async function postMeetingRecap(
  meetingId: string,
  meetingTitle: string,
  classification: MeetingClassification,
  extraction: UniversalExtraction,
): Promise<void> {
  const slack = getDedicatedBotClient('otto');

  // Determine target channel: client channel if available, else review channel
  let channel: string | undefined;
  if (classification.client_code) {
    const domain = CLIENT_CODE_TO_DOMAIN[classification.client_code];
    if (domain) channel = getSlackChannelForDomain(domain);
  }
  channel ??= env.SLACK_REVIEW_CHANNEL_ID ?? env.SLACK_OWNER_USER_ID;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks: any[] = [];

  // Header
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: `Meeting Recap: ${truncate(meetingTitle, 100)}` },
  });

  // Classification context
  const classLines = [
    classification.client_code
      ? `*Client:* ${classification.client_code} (${classification.client_name})`
      : '*Client:* Unknown',
    `*Type:* ${classification.meeting_type.replace(/_/g, ' ')}`,
    `*External:* ${classification.is_external ? 'Yes' : 'No'}`,
    `*Confidence:* ${(classification.confidence * 100).toFixed(0)}%`,
  ];
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: classLines.join('  |  ') },
  });

  // Action items
  if (extraction.action_items.length > 0) {
    const items = extraction.action_items
      .slice(0, 10)
      .map((a) => {
        let line = `• ${a.text}`;
        if (a.assignee) line += ` _(${a.assignee})_`;
        if (a.deadline) line += ` — ${a.deadline}`;
        return line;
      })
      .join('\n');
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Action Items (${extraction.action_items.length})*\n${items}` },
    });
  }

  // Decisions
  if (extraction.decisions.length > 0) {
    const items = extraction.decisions
      .slice(0, 8)
      .map((d) => `• ${d.text}${d.account_code ? ` [${d.account_code}]` : ''}`)
      .join('\n');
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Decisions (${extraction.decisions.length})*\n${items}` },
    });
  }

  // Account insights (Ada)
  if (extraction.account_insights.length > 0) {
    const items = extraction.account_insights
      .slice(0, 8)
      .map((i) => `• [${i.account_code}] ${i.insight}`)
      .join('\n');
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Account Insights (${extraction.account_insights.length})*\n${items}` },
    });
  }

  // Creative feedback (Maya)
  if (extraction.creative_feedback.length > 0) {
    const items = extraction.creative_feedback
      .slice(0, 5)
      .map((f) => `• ${f.feedback}${f.account_code ? ` [${f.account_code}]` : ''}`)
      .join('\n');
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Creative Feedback (${extraction.creative_feedback.length})*\n${items}` },
    });
  }

  // Routing signals
  const rs = extraction.routing_signals;
  const signalParts = [
    `Media buying: ${rs.media_buying_depth}`,
    `Creative content: ${rs.has_creative_content ? 'yes' : 'no'}`,
  ];
  if (rs.urgency_signals.length > 0) {
    signalParts.push(`Urgency: ${rs.urgency_signals.join(', ')}`);
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `${signalParts.join('  |  ')}  |  Sentiment: ${extraction.sentiment}\n_Shadow mode — review only_`,
      },
    ],
  });

  try {
    await slack.chat.postMessage({
      channel,
      text: `Meeting Recap: ${meetingTitle}`,
      blocks,
      unfurl_links: false,
    });
    logger.info({ meetingId, channel }, 'Posted meeting recap to Slack');
  } catch (err) {
    logger.error({ err, meetingId, channel }, 'Failed to post meeting recap');
  }
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}
