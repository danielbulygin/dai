import { Hono } from 'hono';
import crypto from 'node:crypto';
import { env } from '../env.js';
import { getNotion } from '../integrations/notion.js';
import { getDedicatedBotClient } from '../slack/dedicated-bots.js';
import { logger } from '../utils/logger.js';

const COMMENT_CHANNEL = 'C0AK6DQ1KST'; // #temp-notion-comments

// Only forward comments from these email domains (empty = forward all)
const ALLOWED_DOMAINS = ['teethlovers.de', 'audibene.de'];

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
  const parentId = event.data.parent?.id;
  const parentType = event.data.parent?.type;

  logger.info({ commentId, authorId, pageId, parentId, parentType }, 'Processing comment.created');

  // Try fetching comments from the parent block first (where the comment is anchored),
  // fall back to page-level comments
  async function fetchCommentText(): Promise<string> {
    const idsToTry = parentId && parentId !== pageId ? [parentId, pageId] : [pageId];
    for (const blockId of idsToTry) {
      try {
        const response = await notion.comments.list({ block_id: blockId });
        const comment = response.results.find((c) => c.id === commentId);
        if (comment && 'rich_text' in comment) {
          return (comment.rich_text as Array<{ plain_text: string }>)
            .map((t) => t.plain_text)
            .join('');
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message, blockId }, 'Failed to fetch comments from block');
      }
    }
    return '(could not fetch comment text)';
  }

  // Fetch comment text, author info, and page title concurrently (all gracefully fallible)
  const [commentText, authorData, pageData] = await Promise.all([
    fetchCommentText(),
    authorId
      ? notion.users.retrieve({ user_id: authorId }).catch(() => null)
      : null,
    notion.pages.retrieve({ page_id: pageId }).catch(() => null),
  ]);

  // Extract author info
  let authorName = 'Unknown';
  let authorEmail = '';
  if (authorData && 'name' in authorData) {
    authorName = (authorData.name as string) || 'Unknown';
  }
  if (authorData && 'person' in authorData) {
    authorEmail = ((authorData as { person: { email?: string } }).person?.email) || '';
  }

  // Filter: only forward comments from allowed domains
  if (ALLOWED_DOMAINS.length > 0) {
    const domain = authorEmail.split('@')[1]?.toLowerCase();
    if (!domain || !ALLOWED_DOMAINS.includes(domain)) {
      logger.info({ authorName, authorEmail, commentId }, 'Skipping comment — author not in allowed domains');
      return;
    }
  }

  // Extract page title
  let pageTitle = 'Untitled';
  if (pageData && 'properties' in pageData) {
    const titleProp = Object.values(pageData.properties).find(
      (p: unknown) => (p as { type: string }).type === 'title',
    ) as { title: Array<{ plain_text: string }> } | undefined;
    if (titleProp?.title?.length) {
      pageTitle = titleProp.title.map((t) => t.plain_text).join('');
    }
  }

  // Build Notion URL
  const notionUrl = `https://www.notion.so/${pageId.replace(/-/g, '')}`;

  // Post to Slack — always send, even with partial data
  const slack = getDedicatedBotClient('otto');
  await slack.chat.postMessage({
    channel: COMMENT_CHANNEL,
    unfurl_links: false,
    text: `New comment on "${pageTitle}" by ${authorName}: ${commentText}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `> ${escapeSlackMrkdwn(commentText)}`,
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `*${escapeSlackMrkdwn(authorName)}* commented on *${escapeSlackMrkdwn(pageTitle)}* · ${formatTimestamp(event.timestamp)}`,
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open in Notion' },
            url: notionUrl,
            action_id: 'notion_comment_open',
          },
        ],
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
