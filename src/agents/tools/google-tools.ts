import type { gmail_v1 } from 'googleapis';
import { getCalendar, getGmail } from '../../integrations/google.js';
import { logger } from '../../utils/logger.js';

type GoogleAccount = 'work' | 'personal' | 'jasmin';

const TZ = 'Europe/Berlin';

// ---------------------------------------------------------------------------
// Calendar tools
// ---------------------------------------------------------------------------

export async function listEvents(params: {
  startDate: string;
  endDate?: string;
  account?: string;
}): Promise<string> {
  try {
    const account = (params.account ?? 'work') as GoogleAccount;
    const cal = getCalendar(account);

    const timeMin = new Date(params.startDate).toISOString();
    const timeMax = params.endDate
      ? new Date(params.endDate).toISOString()
      : new Date(new Date(params.startDate).getTime() + 86_400_000).toISOString();

    const res = await cal.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: TZ,
      maxResults: 50,
    });

    const events = (res.data.items ?? []).map((e) => ({
      id: e.id,
      summary: e.summary,
      start: e.start?.dateTime ?? e.start?.date,
      end: e.end?.dateTime ?? e.end?.date,
      location: e.location,
      attendees: e.attendees?.map((a) => ({ email: a.email, status: a.responseStatus })),
      htmlLink: e.htmlLink,
    }));

    return JSON.stringify({ account, count: events.length, events });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'listEvents failed');
    return JSON.stringify({ error: msg });
  }
}

export async function searchEvents(params: {
  query: string;
  startDate?: string;
  endDate?: string;
}): Promise<string> {
  try {
    const timeMin = params.startDate
      ? new Date(params.startDate).toISOString()
      : new Date(Date.now() - 30 * 86_400_000).toISOString();
    const timeMax = params.endDate
      ? new Date(params.endDate).toISOString()
      : new Date(Date.now() + 90 * 86_400_000).toISOString();

    const results = await Promise.allSettled(
      (['work', 'personal'] as const).map(async (account) => {
        const cal = getCalendar(account);
        const res = await cal.events.list({
          calendarId: 'primary',
          q: params.query,
          timeMin,
          timeMax,
          singleEvents: true,
          orderBy: 'startTime',
          timeZone: TZ,
          maxResults: 25,
        });
        return (res.data.items ?? []).map((e) => ({
          id: e.id,
          account,
          summary: e.summary,
          start: e.start?.dateTime ?? e.start?.date,
          end: e.end?.dateTime ?? e.end?.date,
          location: e.location,
          htmlLink: e.htmlLink,
        }));
      }),
    );

    const events = results
      .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
      .sort((a, b) => new Date(a.start ?? 0).getTime() - new Date(b.start ?? 0).getTime());

    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => String(r.reason));

    return JSON.stringify({ count: events.length, events, ...(errors.length ? { errors } : {}) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'searchEvents failed');
    return JSON.stringify({ error: msg });
  }
}

export async function createEvent(params: {
  summary: string;
  startTime: string;
  endTime: string;
  description?: string;
  location?: string;
  attendees?: string[];
  account?: string;
}): Promise<string> {
  try {
    const account = (params.account ?? 'work') as GoogleAccount;
    const cal = getCalendar(account);

    const res = await cal.events.insert({
      calendarId: 'primary',
      sendUpdates: params.attendees?.length ? 'all' : 'none',
      requestBody: {
        summary: params.summary,
        description: params.description,
        location: params.location,
        start: { dateTime: new Date(params.startTime).toISOString(), timeZone: TZ },
        end: { dateTime: new Date(params.endTime).toISOString(), timeZone: TZ },
        attendees: params.attendees?.map((email) => ({ email })),
      },
    });

    return JSON.stringify({
      id: res.data.id,
      summary: res.data.summary,
      start: res.data.start?.dateTime,
      end: res.data.end?.dateTime,
      htmlLink: res.data.htmlLink,
      account,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'createEvent failed');
    return JSON.stringify({ error: msg });
  }
}

export async function checkAvailability(params: {
  startTime: string;
  endTime: string;
}): Promise<string> {
  try {
    const timeMin = new Date(params.startTime).toISOString();
    const timeMax = new Date(params.endTime).toISOString();

    const results = await Promise.allSettled(
      (['work', 'personal'] as const).map(async (account) => {
        const cal = getCalendar(account);
        const res = await cal.freebusy.query({
          requestBody: {
            timeMin,
            timeMax,
            timeZone: TZ,
            items: [{ id: 'primary' }],
          },
        });
        const busy = res.data.calendars?.['primary']?.busy ?? [];
        return busy.map((b) => ({ account, start: b.start, end: b.end }));
      }),
    );

    const busySlots = results
      .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
      .sort((a, b) => new Date(a.start ?? 0).getTime() - new Date(b.start ?? 0).getTime());

    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => String(r.reason));

    return JSON.stringify({
      timeMin,
      timeMax,
      busySlots,
      isFree: busySlots.length === 0,
      ...(errors.length ? { errors } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'checkAvailability failed');
    return JSON.stringify({ error: msg });
  }
}

// ---------------------------------------------------------------------------
// Gmail tools
// ---------------------------------------------------------------------------

export async function searchEmails(params: {
  query: string;
  from?: string;
  after?: string;
  before?: string;
  maxResults?: number;
  account?: string;
}): Promise<string> {
  try {
    const account = (params.account ?? 'work') as GoogleAccount;
    const gmail = getGmail(account);

    const parts: string[] = [params.query];
    if (params.from) parts.push(`from:${params.from}`);
    if (params.after) parts.push(`after:${params.after}`);
    if (params.before) parts.push(`before:${params.before}`);
    const q = parts.join(' ');

    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: params.maxResults ?? 10,
    });

    const messageIds = (listRes.data.messages ?? []).map((m) => m.id!);
    if (messageIds.length === 0) {
      return JSON.stringify({ account, count: 0, emails: [] });
    }

    const emails = await Promise.all(
      messageIds.map(async (id) => {
        const msg = await gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Subject', 'Date'],
        });
        const headers = msg.data.payload?.headers ?? [];
        const get = (name: string) => headers.find((h) => h.name === name)?.value;
        return {
          id: msg.data.id,
          threadId: msg.data.threadId,
          from: get('From'),
          to: get('To'),
          subject: get('Subject'),
          date: get('Date'),
          snippet: msg.data.snippet,
        };
      }),
    );

    return JSON.stringify({ account, count: emails.length, emails });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'searchEmails failed');
    return JSON.stringify({ error: msg });
  }
}

function extractTextFromParts(parts: gmail_v1.Schema$MessagePart[]): string {
  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64url').toString('utf-8');
    }
    if (part.parts) {
      const nested = extractTextFromParts(part.parts);
      if (nested) return nested;
    }
  }
  return '';
}

export async function readEmail(params: {
  threadId: string;
  account?: string;
}): Promise<string> {
  try {
    const account = (params.account ?? 'work') as GoogleAccount;
    const gmail = getGmail(account);

    const thread = await gmail.users.threads.get({
      userId: 'me',
      id: params.threadId,
      format: 'full',
    });

    const messages = (thread.data.messages ?? []).map((msg) => {
      const headers = msg.payload?.headers ?? [];
      const get = (name: string) => headers.find((h) => h.name === name)?.value;

      let body = '';
      if (msg.payload?.body?.data) {
        body = Buffer.from(msg.payload.body.data, 'base64url').toString('utf-8');
      } else if (msg.payload?.parts) {
        body = extractTextFromParts(msg.payload.parts);
      }

      if (body.length > 3000) {
        body = body.slice(0, 3000) + '\n[...truncated]';
      }

      return {
        id: msg.id,
        from: get('From'),
        to: get('To'),
        date: get('Date'),
        subject: get('Subject'),
        body,
      };
    });

    return JSON.stringify({ account, threadId: params.threadId, messages });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'readEmail failed');
    return JSON.stringify({ error: msg });
  }
}

export async function draftEmail(params: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  threadId?: string;
  account?: string;
}): Promise<string> {
  try {
    const account = (params.account ?? 'work') as GoogleAccount;
    const gmail = getGmail(account);

    const lines = [
      `To: ${params.to}`,
      params.cc ? `Cc: ${params.cc}` : null,
      `Subject: ${params.subject}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      params.body,
    ]
      .filter(Boolean)
      .join('\r\n');

    const raw = Buffer.from(lines).toString('base64url');

    const res = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: {
          raw,
          threadId: params.threadId,
        },
      },
    });

    return JSON.stringify({
      draftId: res.data.id,
      messageId: res.data.message?.id,
      threadId: res.data.message?.threadId,
      account,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'draftEmail failed');
    return JSON.stringify({ error: msg });
  }
}

export async function sendEmail(params: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  threadId?: string;
  account?: string;
}): Promise<string> {
  try {
    const account = (params.account ?? 'jasmin') as GoogleAccount;

    // Jasmin's own account — send directly
    if (account === 'jasmin') {
      const gmail = getGmail('jasmin');

      const lines = [
        `To: ${params.to}`,
        params.cc ? `Cc: ${params.cc}` : null,
        `Subject: ${params.subject}`,
        'Content-Type: text/plain; charset="UTF-8"',
        '',
        params.body,
      ]
        .filter(Boolean)
        .join('\r\n');

      const raw = Buffer.from(lines).toString('base64url');

      const res = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw, threadId: params.threadId },
      });

      return JSON.stringify({
        status: 'sent',
        messageId: res.data.id,
        threadId: res.data.threadId,
        account,
      });
    }

    // Daniel's accounts — create draft + post approval to Slack
    const draftResult = await draftEmail({
      to: params.to,
      subject: params.subject,
      body: params.body,
      cc: params.cc,
      threadId: params.threadId,
      account,
    });

    const draft = JSON.parse(draftResult);
    if (draft.error) return draftResult;

    const { postEmailApproval } = await import('../../slack/listeners/email-actions.js');
    await postEmailApproval({
      draftId: draft.draftId,
      account,
      to: params.to,
      cc: params.cc,
      subject: params.subject,
      body: params.body,
    });

    return JSON.stringify({
      status: 'pending_approval',
      draftId: draft.draftId,
      account,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'sendEmail failed');
    return JSON.stringify({ error: msg });
  }
}
