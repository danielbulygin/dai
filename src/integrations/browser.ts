import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_SESSIONS = 3;
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BrowserSession {
  context: BrowserContext;
  page: Page;
  lastUsedAt: number;
  idleTimer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Singleton browser + session map
// ---------------------------------------------------------------------------

let browser: Browser | null = null;
const sessions = new Map<string, BrowserSession>();

function sessionKey(agentId: string, channelId: string, threadTs?: string): string {
  return `${agentId}:${channelId}:${threadTs ?? 'root'}`;
}

async function launchBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;

  logger.info({ chromiumPath: CHROMIUM_PATH }, 'Launching Chromium');
  browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
    ],
  });

  browser.on('disconnected', () => {
    logger.warn('Chromium disconnected');
    browser = null;
  });

  return browser;
}

function resetIdleTimer(key: string, session: BrowserSession): void {
  clearTimeout(session.idleTimer);
  session.lastUsedAt = Date.now();
  session.idleTimer = setTimeout(() => {
    logger.info({ sessionKey: key }, 'Browser session idle timeout — closing');
    closeSessionInternal(key).catch((err) =>
      logger.error({ err, sessionKey: key }, 'Failed to close idle session'),
    );
  }, IDLE_TIMEOUT_MS);
}

async function evictOldest(): Promise<void> {
  if (sessions.size < MAX_SESSIONS) return;

  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [key, s] of sessions) {
    if (s.lastUsedAt < oldestTime) {
      oldestTime = s.lastUsedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) {
    logger.info({ sessionKey: oldestKey }, 'Evicting oldest browser session');
    await closeSessionInternal(oldestKey);
  }
}

async function closeSessionInternal(key: string): Promise<void> {
  const session = sessions.get(key);
  if (!session) return;

  clearTimeout(session.idleTimer);
  sessions.delete(key);

  try {
    await session.page.close().catch(() => {});
    await session.context.close().catch(() => {});
  } catch {
    // Already closed
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getSession(
  agentId: string,
  channelId: string,
  threadTs?: string,
): Promise<{ page: Page; isNew: boolean }> {
  const key = sessionKey(agentId, channelId, threadTs);
  const existing = sessions.get(key);

  if (existing) {
    resetIdleTimer(key, existing);
    return { page: existing.page, isNew: false };
  }

  await evictOldest();
  const b = await launchBrowser();
  const context = await b.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // Block heavy resources to save bandwidth/time
  await page.route('**/*.{mp4,webm,ogg,mp3,wav,flac,aac,woff2,woff,ttf,otf}', (route) =>
    route.abort(),
  );

  const session: BrowserSession = {
    context,
    page,
    lastUsedAt: Date.now(),
    idleTimer: setTimeout(() => {}, 0), // Placeholder, reset below
  };

  sessions.set(key, session);
  resetIdleTimer(key, session);

  logger.info({ sessionKey: key }, 'Created new browser session');
  return { page, isNew: true };
}

export async function closeSession(
  agentId: string,
  channelId: string,
  threadTs?: string,
): Promise<void> {
  const key = sessionKey(agentId, channelId, threadTs);
  await closeSessionInternal(key);
  logger.info({ sessionKey: key }, 'Browser session closed');
}

export async function shutdownBrowser(): Promise<void> {
  logger.info({ activeSessions: sessions.size }, 'Shutting down browser');

  for (const [key] of sessions) {
    await closeSessionInternal(key);
  }

  if (browser) {
    try {
      await browser.close();
    } catch {
      // Already closed
    }
    browser = null;
  }
}
