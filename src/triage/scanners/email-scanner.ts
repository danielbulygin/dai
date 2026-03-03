/**
 * Email scanner: polls Gmail for unread emails and classifies them.
 * Runs every 5 minutes during work hours.
 */

import { logger } from '../../utils/logger.js';
import { classifyEmail, type EmailClassifyInput } from '../classifier.js';
import { upsertTriageItem } from '../queue.js';
import { getScanWatermark, updateScanWatermark } from '../queue.js';

export async function scanEmails(): Promise<void> {
  const { searchEmails } = await import('../../agents/tools/google-tools.js');

  const accounts = ['work', 'personal'] as const;

  for (const account of accounts) {
    try {
      await scanAccount(account, searchEmails);
    } catch (err) {
      logger.error({ err, account }, `Triage email scan failed for ${account}`);
    }
  }
}

async function scanAccount(
  account: 'work' | 'personal',
  searchEmails: (params: {
    query: string;
    maxResults?: number;
    account?: string;
  }) => Promise<string>,
): Promise<void> {
  const stateKey = `email_${account}`;

  // Get watermark (set of already-seen message IDs stored as JSON)
  const watermarkRaw = await getScanWatermark(stateKey);
  const seenIds: Set<string> = new Set();
  if (watermarkRaw) {
    try {
      const parsed = JSON.parse(watermarkRaw) as string[];
      for (const id of parsed) seenIds.add(id);
    } catch {
      // Watermark was not JSON — ignore
    }
  }

  // Query unread emails from last day
  const rawResult = await searchEmails({
    query: 'is:unread newer_than:1d',
    maxResults: 20,
    account,
  });

  const data = JSON.parse(rawResult) as {
    account: string;
    count: number;
    emails: Array<{
      id: string;
      threadId: string;
      from: string;
      to: string;
      subject: string;
      date: string;
      snippet: string;
    }>;
    error?: string;
  };

  if (data.error || !data.emails) {
    logger.debug({ account, error: data.error }, 'Email scan returned no results');
    return;
  }

  const newEmails = data.emails.filter((e) => !seenIds.has(e.id));
  if (newEmails.length === 0) {
    logger.debug({ account }, 'No new unread emails');
    return;
  }

  logger.info({ account, count: newEmails.length }, 'Triage: new unread emails found');

  const now = Date.now();

  for (const email of newEmails) {
    // Estimate unread time from date header
    const emailDate = email.date ? new Date(email.date).getTime() : now;
    const unreadMinutes = Math.max(0, Math.floor((now - emailDate) / 60_000));

    const input: EmailClassifyInput = {
      messageId: email.id,
      from: email.from ?? 'Unknown',
      subject: email.subject ?? '(no subject)',
      snippet: email.snippet ?? '',
      account,
      unreadMinutes,
      isReplyToMyEmail: (email.subject ?? '').startsWith('Re:'),
    };

    const item = classifyEmail(input);
    await upsertTriageItem(item);
    seenIds.add(email.id);
  }

  // Keep watermark to last 200 IDs (rolling window)
  const watermarkIds = [...seenIds].slice(-200);
  await updateScanWatermark(stateKey, JSON.stringify(watermarkIds));

  logger.info({ account, classified: newEmails.length }, 'Triage: email scan complete');
}
