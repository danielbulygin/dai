// Piper Notion-comments tool (2026-06-15).
//
// get_adset_comments — fetch the discussion thread on an ad set's Notion page.
//
// WHY this exists: a huge amount of the real decision history on an ad set lives
// in Notion *comments*, not in task properties or Slack. The product-delay,
// reshoot debates, client-feedback relays, and "let's progress" calls all happen
// in the page comment thread. The piper-sync mirror deliberately does NOT mirror
// comments (see pma/dashboard/src/lib/piper-sync/README.md), so we read them live
// from the Notion API at question time — which also gives us real-time freshness.
//
// The ad-set code → Notion page id mapping comes from the bmad Supabase mirror
// (aot_adsets_current.notion_id), the same place every other Piper brain tool
// reads. We then call the Notion comments API directly (getNotion()).

import { getNotion } from '../../integrations/notion.js';
import { getSupabase } from '../../integrations/supabase.js';
import { normalizeAdSetCode } from './piper-brain-tools.js';
import { logger } from '../../utils/logger.js';

// Author-name cache: Notion user id → display name. Comment authors are almost
// always team members; guests/bots fall back to a short id. Cached for the life
// of the process to avoid re-fetching the same handful of people every call.
const authorNameCache = new Map<string, string>();

async function resolveAuthor(userId: string | undefined): Promise<string> {
  if (!userId) return 'unknown';
  const cached = authorNameCache.get(userId);
  if (cached) return cached;
  try {
    const user = await getNotion().users.retrieve({ user_id: userId });
    const name = user.name ?? `user:${userId.slice(0, 8)}`;
    authorNameCache.set(userId, name);
    return name;
  } catch {
    const fallback = `user:${userId.slice(0, 8)}`;
    authorNameCache.set(userId, fallback);
    return fallback;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${hh}:${mm}`;
}

interface AdSetRow {
  notion_id: string;
  url: string | null;
  ad_title: string | null;
  client_code: string | null;
}

interface RichTextItem {
  plain_text?: string;
}

interface NotionComment {
  created_time?: string;
  created_by?: { id?: string };
  rich_text?: RichTextItem[];
  parent?: { type?: string };
  discussion_id?: string;
}

const DEFAULT_MAX = 40;

/**
 * Fetch the open page-level discussion on an ad set's Notion page.
 *
 * Limitations (stated in the response so Piper relays them honestly):
 *  - Returns OPEN page-level discussions only. Resolved discussions and comments
 *    pinned to individual child blocks are not included (Notion API scoping).
 *  - Mentions are already resolved inline by Notion (`@Name`) in plain_text.
 */
export async function getAdsetComments(input: {
  ad_set_code: string;
  max?: number;
}): Promise<string> {
  const code = normalizeAdSetCode(input.ad_set_code ?? '');
  if (!code) {
    return JSON.stringify({ ok: false, error: 'ad_set_code is required (e.g. "LAx3871").' });
  }
  const max = Math.max(1, Math.min(input.max ?? DEFAULT_MAX, 100));

  // 1. Map code → Notion page id via the Supabase mirror.
  const { data, error } = await getSupabase()
    .from('aot_adsets_current')
    .select('notion_id, url, ad_title, client_code')
    .eq('ad_id_code', code)
    .maybeSingle();
  if (error) throw new Error(`aot_adsets_current lookup failed: ${error.message}`);
  const row = data as AdSetRow | null;
  if (!row?.notion_id) {
    return JSON.stringify({
      ok: false,
      normalized_code: code,
      found: false,
      note: `No Notion page found for ${code} in the mirror. Check the code, or it may be outside the synced Ad Sets DB.`,
    });
  }

  // 2. Fetch comments live from Notion, paginating to completion.
  let comments: NotionComment[] = [];
  try {
    let cursor: string | undefined;
    do {
      const page = await getNotion().comments.list({
        block_id: row.notion_id,
        page_size: 100,
        start_cursor: cursor,
      });
      comments = comments.concat(page.results as NotionComment[]);
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
    } while (cursor && comments.length < 500);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg, code }, 'getAdsetComments: Notion comments.list failed');
    return JSON.stringify({
      ok: false,
      normalized_code: code,
      notion_page_url: row.url,
      error: `Could not read Notion comments: ${msg}. If this is a permission error, the Notion integration needs the "Read comments" capability enabled.`,
    });
  }

  if (comments.length === 0) {
    return JSON.stringify({
      ok: true,
      normalized_code: code,
      ad_title: row.ad_title,
      client_code: row.client_code,
      notion_page_url: row.url,
      count: 0,
      comments: [],
      note: `No open page-level comments on ${code}. (Resolved discussions and block-level comments are not fetched.)`,
    });
  }

  // 3. Chronological, resolve authors, keep the most recent `max`.
  comments.sort((a, b) => (a.created_time ?? '').localeCompare(b.created_time ?? ''));
  const total = comments.length;
  const slice = comments.slice(Math.max(0, total - max));

  const rendered = [];
  for (const c of slice) {
    const author = await resolveAuthor(c.created_by?.id);
    const text = (c.rich_text ?? []).map((t) => t.plain_text ?? '').join('').trim();
    rendered.push({
      author,
      at: c.created_time ? shortDateTime(c.created_time) : null,
      at_iso: c.created_time ?? null,
      text,
    });
  }

  return JSON.stringify({
    ok: true,
    normalized_code: code,
    ad_title: row.ad_title,
    client_code: row.client_code,
    notion_page_url: row.url,
    count: total,
    shown: rendered.length,
    truncated: total > rendered.length,
    comments: rendered,
    note:
      'Live Notion page comments (open page-level discussions only; resolved + block-level not included). ' +
      'This is the real decision/feedback history — product delays, reshoot calls, client revisions, "let\'s progress" sign-offs live here. ' +
      'Quote it attributed + dated; map decisions back to the pipeline state. Freshness = live (now).',
  });
}
