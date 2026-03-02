import { google, calendar_v3, gmail_v1 } from 'googleapis';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';

type GoogleAccount = 'work' | 'personal' | 'jasmin';

const authClients = new Map<GoogleAccount, InstanceType<typeof google.auth.OAuth2>>();

function getAuthClient(account: GoogleAccount): InstanceType<typeof google.auth.OAuth2> {
  const existing = authClients.get(account);
  if (existing) return existing;

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set. Configure them in .env to use Google features.',
    );
  }

  const refreshTokenMap: Record<GoogleAccount, string | undefined> = {
    work: env.GOOGLE_REFRESH_TOKEN_WORK,
    personal: env.GOOGLE_REFRESH_TOKEN_PERSONAL,
    jasmin: env.GOOGLE_REFRESH_TOKEN_JASMIN,
  };
  const refreshToken = refreshTokenMap[account];

  if (!refreshToken) {
    throw new Error(
      `GOOGLE_REFRESH_TOKEN_${account.toUpperCase()} is not set. Run "pnpm google:setup" to get a refresh token.`,
    );
  }

  logger.info({ account }, 'Initializing Google OAuth2 client');
  const client = new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
  client.setCredentials({ refresh_token: refreshToken });

  authClients.set(account, client);
  return client;
}

export function getCalendar(account: GoogleAccount = 'work'): calendar_v3.Calendar {
  return google.calendar({ version: 'v3', auth: getAuthClient(account) });
}

export function getGmail(account: GoogleAccount = 'work'): gmail_v1.Gmail {
  return google.gmail({ version: 'v1', auth: getAuthClient(account) });
}
