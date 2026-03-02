/**
 * Email approval UI + action handlers.
 *
 * When Jasmin sends email from Daniel's accounts (work/personal), a draft is
 * created and a Block Kit approval message is posted to Daniel's DM.
 * Three buttons: Send, Edit in Gmail, Discard.
 */

import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { getGmail } from '../../integrations/google.js';
import { getDedicatedBotClient } from '../dedicated-bots.js';
import { env } from '../../env.js';
import { logger } from '../../utils/logger.js';

type GoogleAccount = 'work' | 'personal';

// Slack Block Kit block — kept loose to avoid importing @slack/types
type SlackBlock = Record<string, unknown>;

interface EmailApprovalParams {
  draftId: string;
  account: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
}

/** Post a Block Kit approval message to Daniel's DM via Jasmin's bot. */
export async function postEmailApproval(params: EmailApprovalParams): Promise<void> {
  const { draftId, account, to, cc, subject, body } = params;
  const payload = JSON.stringify({ draftId, account });

  const bodyPreview = body.length > 500 ? body.slice(0, 500) + '...' : body;

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `Email ready to send (${account})`, emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*To:*\n${to}` },
        ...(cc ? [{ type: 'mrkdwn', text: `*Cc:*\n${cc}` }] : []),
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Subject:*\n${subject}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Body:*\n\`\`\`${bodyPreview}\`\`\`` },
    },
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Send' },
          style: 'primary',
          action_id: 'email_send',
          value: payload,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Edit in Gmail' },
          action_id: 'email_edit',
          url: 'https://mail.google.com/mail/#drafts',
          value: payload,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Discard' },
          style: 'danger',
          action_id: 'email_discard',
          value: payload,
        },
      ],
    },
  ];

  try {
    await getDedicatedBotClient('jasmin').chat.postMessage({
      channel: env.SLACK_OWNER_USER_ID,
      text: `Email approval: "${subject}" to ${to} (${account})`,
      blocks: blocks as never[],
    });
  } catch (err) {
    logger.error({ err }, 'Failed to post email approval message');
  }
}

/** Extract channel + message ts from the action body. */
function getMessageContext(body: Record<string, unknown>): { channel: string; ts: string } | null {
  const channel = body.channel as { id?: string } | undefined;
  const message = body.message as { ts?: string } | undefined;
  if (channel?.id && message?.ts) {
    return { channel: channel.id, ts: message.ts };
  }
  return null;
}

/** Replace action buttons with a status message after action is taken. */
async function clearButtons(
  client: WebClient,
  channel: string,
  ts: string,
  originalBlocks: SlackBlock[],
  statusText: string,
): Promise<void> {
  const updatedBlocks = [
    ...originalBlocks.filter((b) => b.type !== 'actions'),
    { type: 'section', text: { type: 'mrkdwn', text: statusText } },
  ];

  await client.chat.update({
    channel,
    ts,
    blocks: updatedBlocks as never[],
    text: statusText,
  });
}

export function registerEmailActions(app: App): void {
  // Send — send the draft via Gmail API
  app.action('email_send', async ({ action, ack, body, client }) => {
    await ack();
    if (action.type !== 'button') return;
    try {
      const { draftId, account } = JSON.parse(action.value ?? '{}') as {
        draftId: string;
        account: GoogleAccount;
      };

      const gmail = getGmail(account);
      await gmail.users.drafts.send({ userId: 'me', requestBody: { id: draftId } });

      const ctx = getMessageContext(body as unknown as Record<string, unknown>);
      const rawBody = body as unknown as Record<string, unknown>;
      const msg = rawBody.message as { blocks?: SlackBlock[] } | undefined;
      if (ctx) {
        await clearButtons(client, ctx.channel, ctx.ts, msg?.blocks ?? [], '*Sent!*');
      }

      logger.info({ draftId, account }, 'Email sent via approval');
    } catch (err) {
      logger.error({ err }, 'email_send action failed');
    }
  });

  // Edit — button has url prop, just ack (Slack opens the URL automatically)
  app.action('email_edit', async ({ ack }) => {
    await ack();
  });

  // Discard — delete the draft
  app.action('email_discard', async ({ action, ack, body, client }) => {
    await ack();
    if (action.type !== 'button') return;
    try {
      const { draftId, account } = JSON.parse(action.value ?? '{}') as {
        draftId: string;
        account: GoogleAccount;
      };

      const gmail = getGmail(account);
      await gmail.users.drafts.delete({ userId: 'me', id: draftId });

      const ctx = getMessageContext(body as unknown as Record<string, unknown>);
      const rawBody = body as unknown as Record<string, unknown>;
      const msg = rawBody.message as { blocks?: SlackBlock[] } | undefined;
      if (ctx) {
        await clearButtons(client, ctx.channel, ctx.ts, msg?.blocks ?? [], '*Discarded.*');
      }

      logger.info({ draftId, account }, 'Email draft discarded via approval');
    } catch (err) {
      logger.error({ err }, 'email_discard action failed');
    }
  });
}
