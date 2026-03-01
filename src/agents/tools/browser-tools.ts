import type { Page } from 'playwright-core';
import { getSession, closeSession } from '../../integrations/browser.js';
import { logger } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

const BLOCKED_PROTOCOLS = ['file:', 'javascript:', 'data:'];
const BLOCKED_DOMAINS = [
  'paypal.com', 'stripe.com', 'checkout.stripe.com',
  'bank', 'banking', 'pay.google.com', 'apple.com/apple-pay',
];

function validateUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (BLOCKED_PROTOCOLS.includes(parsed.protocol)) {
      return `Blocked protocol: ${parsed.protocol}`;
    }
    const host = parsed.hostname.toLowerCase();
    for (const blocked of BLOCKED_DOMAINS) {
      if (host.includes(blocked)) {
        return `Blocked domain: ${host}`;
      }
    }
    return null;
  } catch {
    return `Invalid URL: ${url}`;
  }
}

// ---------------------------------------------------------------------------
// Content extraction helper
// ---------------------------------------------------------------------------

interface InteractiveElement {
  tag: string;
  text: string;
  selector: string;
  type?: string;
  name?: string;
  placeholder?: string;
}

interface PageSummary {
  url: string;
  title: string;
  text: string;
  interactiveElements: InteractiveElement[];
}

// These functions run inside the browser via page.evaluate — defined as strings
// to avoid TypeScript checking DOM types in this Node.js project.

const EXTRACT_TEXT_JS = `() => {
  const body = document.body;
  if (!body) return '';
  const clone = body.cloneNode(true);
  for (const el of clone.querySelectorAll('script, style, noscript, svg, path')) {
    el.remove();
  }
  return (clone.innerText || clone.textContent || '').replace(/\\n{3,}/g, '\\n\\n').trim();
}`;

const EXTRACT_ELEMENTS_JS = `() => {
  const elements = [];
  const sel = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [onclick]';
  const nodes = document.querySelectorAll(sel);
  for (const el of Array.from(nodes).slice(0, 50)) {
    const tag = el.tagName.toLowerCase();
    const text = (el.innerText || '').trim().slice(0, 80);
    const type = el.getAttribute('type') || undefined;
    const name = el.getAttribute('name') || undefined;
    const placeholder = el.getAttribute('placeholder') || undefined;
    let selector = '';
    const id = el.getAttribute('id');
    if (id) {
      selector = '#' + CSS.escape(id);
    } else if (name) {
      selector = tag + '[name="' + CSS.escape(name) + '"]';
    } else if (el.getAttribute('aria-label')) {
      selector = tag + '[aria-label="' + CSS.escape(el.getAttribute('aria-label')) + '"]';
    } else if (text && tag !== 'input' && tag !== 'textarea') {
      selector = 'text=' + JSON.stringify(text.slice(0, 40));
    } else if (type) {
      selector = tag + '[type="' + type + '"]';
    } else {
      const parent = el.parentElement;
      if (parent) {
        const siblings = Array.from(parent.querySelectorAll(':scope > ' + tag));
        const idx = siblings.indexOf(el) + 1;
        selector = tag + ':nth-of-type(' + idx + ')';
      }
    }
    if (selector) {
      elements.push({ tag, text, selector, type, name, placeholder });
    }
  }
  return elements;
}`;

async function extractPageSummary(page: Page, maxTextLength = 8000): Promise<PageSummary> {
  const url = page.url();
  const title = await page.title();

  const text = await page.evaluate(EXTRACT_TEXT_JS) as string;

  const interactiveElements = await page.evaluate(EXTRACT_ELEMENTS_JS) as InteractiveElement[];

  return {
    url,
    title,
    text: text.slice(0, maxTextLength),
    interactiveElements,
  };
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

export async function browseNavigate(params: {
  url: string;
  agentId: string;
  channelId: string;
  threadTs?: string;
}): Promise<string> {
  const urlError = validateUrl(params.url);
  if (urlError) return JSON.stringify({ error: urlError });

  try {
    const { page } = await getSession(params.agentId, params.channelId, params.threadTs);
    await page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait a bit for dynamic content
    await page.waitForTimeout(1000);

    const summary = await extractPageSummary(page, 8000);
    logger.debug({ url: params.url, title: summary.title }, 'Navigated to page');
    return JSON.stringify(summary);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, url: params.url }, 'browse_navigate failed');
    return JSON.stringify({ error: msg });
  }
}

export async function browseClick(params: {
  selector?: string;
  text?: string;
  agentId: string;
  channelId: string;
  threadTs?: string;
}): Promise<string> {
  if (!params.selector && !params.text) {
    return JSON.stringify({ error: 'Either selector or text must be provided' });
  }

  try {
    const { page } = await getSession(params.agentId, params.channelId, params.threadTs);

    if (params.selector) {
      await page.click(params.selector, { timeout: 10000 });
    } else {
      await page.getByText(params.text!, { exact: false }).first().click({ timeout: 10000 });
    }

    // Wait for navigation or content update
    await page.waitForTimeout(1500);

    const summary = await extractPageSummary(page, 8000);
    logger.debug({ selector: params.selector, text: params.text }, 'Clicked element');
    return JSON.stringify(summary);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, selector: params.selector, text: params.text }, 'browse_click failed');
    return JSON.stringify({ error: msg });
  }
}

export async function browseType(params: {
  selector: string;
  text: string;
  submit?: boolean;
  clearFirst?: boolean;
  agentId: string;
  channelId: string;
  threadTs?: string;
}): Promise<string> {
  try {
    const { page } = await getSession(params.agentId, params.channelId, params.threadTs);

    if (params.clearFirst) {
      await page.fill(params.selector, '', { timeout: 10000 });
    }

    await page.fill(params.selector, params.text, { timeout: 10000 });

    if (params.submit) {
      await page.press(params.selector, 'Enter');
      await page.waitForTimeout(2000);
    }

    const summary = await extractPageSummary(page, 8000);
    logger.debug({ selector: params.selector, submit: params.submit }, 'Typed into field');
    return JSON.stringify({ ok: true, page: summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, selector: params.selector }, 'browse_type failed');
    return JSON.stringify({ error: msg });
  }
}

export async function browseReadPage(params: {
  maxLength?: number;
  agentId: string;
  channelId: string;
  threadTs?: string;
}): Promise<string> {
  try {
    const { page } = await getSession(params.agentId, params.channelId, params.threadTs);
    const summary = await extractPageSummary(page, params.maxLength ?? 12000);
    logger.debug({ url: summary.url }, 'Read page content');
    return JSON.stringify(summary);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'browse_read_page failed');
    return JSON.stringify({ error: msg });
  }
}

export async function browseScreenshot(params: {
  fullPage?: boolean;
  agentId: string;
  channelId: string;
  threadTs?: string;
}): Promise<string> {
  try {
    const { page } = await getSession(params.agentId, params.channelId, params.threadTs);
    const buffer = await page.screenshot({
      fullPage: params.fullPage ?? false,
      type: 'png',
    });

    const base64 = buffer.toString('base64');
    const url = page.url();
    const title = await page.title();

    logger.debug({ url, fullPage: params.fullPage }, 'Took screenshot');

    // Return a structured object the runner will detect for multimodal content
    return JSON.stringify({
      screenshot: {
        type: 'base64',
        media_type: 'image/png',
        data: base64,
      },
      url,
      title,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'browse_screenshot failed');
    return JSON.stringify({ error: msg });
  }
}

export async function browseSelect(params: {
  selector: string;
  value: string;
  agentId: string;
  channelId: string;
  threadTs?: string;
}): Promise<string> {
  try {
    const { page } = await getSession(params.agentId, params.channelId, params.threadTs);
    await page.selectOption(params.selector, params.value, { timeout: 10000 });

    await page.waitForTimeout(500);
    const summary = await extractPageSummary(page, 8000);
    logger.debug({ selector: params.selector, value: params.value }, 'Selected option');
    return JSON.stringify({ ok: true, page: summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, selector: params.selector }, 'browse_select failed');
    return JSON.stringify({ error: msg });
  }
}

export async function browseClose(params: {
  agentId: string;
  channelId: string;
  threadTs?: string;
}): Promise<string> {
  try {
    await closeSession(params.agentId, params.channelId, params.threadTs);
    logger.debug('Browser session closed by tool');
    return JSON.stringify({ ok: true, message: 'Browser session closed' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'browse_close failed');
    return JSON.stringify({ error: msg });
  }
}
