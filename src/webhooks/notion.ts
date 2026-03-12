import { Hono } from 'hono';
import crypto from 'node:crypto';
import { env } from '../env.js';
import { getNotion } from '../integrations/notion.js';
import { getDedicatedBotClient } from '../slack/dedicated-bots.js';
import { logger } from '../utils/logger.js';

const COMMENT_CHANNEL = 'C0AK6DQ1KST'; // #temp-notion-comments

export const notionWebhookRouter = new Hono();

// ── Signature verification ──────────────────────────────────────────────────

function verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader?.startsWith('sha256=') || !env.NOTION_WEBHOOK_SECRET) return false;

  const hmac = crypto.createHmac('sha256', env.NOTION_WEBHOOK_SECRET);
  hmac.update(rawBody);
  const expected = `sha256=${hmac.digest('hex')}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

// ── Webhook endpoint ────────────────────────────────────────────────────────

notionWebhookRouter.post('/webhooks/notion', async (c) => {
  const rawBody = Buffer.from(await c.req.arrayBuffer());
  const body = JSON.parse(rawBody.toString());

  // Step 1: Handle initial verification handshake
  if (body.verification_token && !body.type) {
    logger.info('Notion webhook verification request received');
    logger.info({ token: body.verification_token }, 'Paste this token in the Notion Developer Portal');
    return c.json({ status: 'verification_token_received' });
  }

  // Step 2: Validate HMAC signature on real events
  const signature = c.req.header('x-notion-signature');
  if (!verifySignature(rawBody, signature)) {
    logger.warn('Notion webhook: invalid signature');
    return c.text('Invalid signature', 401);
  }

  // Step 3: Acknowledge immediately
  const eventType = body.type as string;
  const eventId = body.id as string;

  logger.info({ eventType, eventId }, 'Notion webhook received');

  // Step 4: Process comment.created async (don't block response)
  if (eventType === 'comment.created') {
    processCommentCreated(body).catch((err) =>
      logger.error({ err, eventId }, 'Failed to process comment.created'),
    );
  }

  return c.text('OK', 200);
});

// ── Comment processing ──────────────────────────────────────────────────────

interface NotionWebhookEvent {
  id: string;
  timestamp: string;
  type: string;
  authors?: Array<{ id: string; type: string }>;
  entity: { id: string; type: string };
  data: {
    page_id: string;
    parent: { id: string; type: string };
  };
}

async function processCommentCreated(event: NotionWebhookEvent): Promise<void> {
  const notion = getNotion();
  const commentId = event.entity.id;
  const authorId = event.authors?.[0]?.id;
  const pageId = event.data.page_id;

  // Fetch comment text, author info, and page title concurrently
  const [commentsResponse, authorData, pageData] = await Promise.all([
    notion.comments.list({ block_id: pageId }),
    authorId ? notion.users.retrieve({ user_id: authorId }).catch(() => null) : null,
    notion.pages.retrieve({ page_id: pageId }),
  ]);

  // Find the specific comment
  const comment = commentsResponse.results.find((c) => c.id === commentId);
  if (!comment) {
    logger.warn({ commentId, pageId }, 'Comment not found in page comments');
    return;
  }

  // Extract comment text
  const commentText =
    'rich_text' in comment
      ? (comment.rich_text as Array<{ plain_text: string }>).map((t) => t.plain_text).join('')
      : '(no text)';

  // Extract author name
  let authorName = 'Unknown';
  if (authorData && 'name' in authorData) {
    authorName = (authorData.name as string) || 'Unknown';
  }

  // Extract page title
  let pageTitle = 'Untitled';
  if ('properties' in pageData) {
    const titleProp = Object.values(pageData.properties).find(
      (p: unknown) => (p as { type: string }).type === 'title',
    ) as { title: Array<{ plain_text: string }> } | undefined;
    if (titleProp?.title?.length) {
      pageTitle = titleProp.title.map((t) => t.plain_text).join('');
    }
  }

  // Build Notion URL
  const notionUrl = `https://www.notion.so/${pageId.replace(/-/g, '')}`;

  // Post to Slack
  const slack = getDedicatedBotClient('otto');
  await slack.chat.postMessage({
    channel: COMMENT_CHANNEL,
    text: `New comment on "${pageTitle}" by ${authorName}: ${commentText}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*New comment on <${notionUrl}|${escapeSlackMrkdwn(pageTitle)}>*`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `*${escapeSlackMrkdwn(authorName)}* · ${formatTimestamp(event.timestamp)}`,
          },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `> ${escapeSlackMrkdwn(commentText)}`,
        },
      },
    ],
  });

  logger.info({ commentId, authorName, pageTitle }, 'Notion comment forwarded to Slack');
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function escapeSlackMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString('en-GB', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });
}
