import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  posts: [] as Array<Record<string, unknown>>,
  sessions: [] as Array<Record<string, unknown>>,
  messages: [] as Array<Record<string, unknown>>,
  rows: [] as Array<Record<string, unknown>>,
  failedPost: -1,
}));
vi.mock('../src/env.js', () => ({ env: { PIPER_BOT_TOKEN: 'fake', PIPER_CHANNEL_ID: 'C_PIPER' } }));
vi.mock('../src/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/slack/dedicated-bots.js', () => ({ getDedicatedBotClient: vi.fn(() => { throw new Error('unexpected fallback'); }) }));
vi.mock('@slack/web-api', () => ({ WebClient: class {
  chat = { postMessage: async (input: Record<string, unknown>) => {
    fake.posts.push(input);
    return { ok: fake.posts.length !== fake.failedPost, ts: `100.${fake.posts.length}` };
  } };
} }));
vi.mock('../src/integrations/supabase.js', () => ({ getSupabase: () => ({
  rpc: async () => ({ data: fake.rows }),
  from: () => ({ select: () => ({ order: () => ({ limit: async () => ({ data: [] }) }) }) }),
}) }));
vi.mock('../src/memory/sessions.js', () => ({
  createSession: async (input: Record<string, unknown>) => {
    const session = { ...input, id: `session-${fake.sessions.length}` };
    fake.sessions.push(session); return session;
  },
  updateSession: async (id: string, update: Record<string, unknown>) => Object.assign(fake.sessions.find(s => s.id === id)!, update),
}));
vi.mock('../src/memory/messages.js', () => ({ addMessage: async (input: Record<string, unknown>) => { fake.messages.push(input); return input; } }));

import { runPiperMyMoves, renderMyMoves, type MyMoveRow } from '../src/digest/piper-my-moves.js';

const row = (person: string, rank = 1): MyMoveRow => ({
  person_id: person, person_display: person, person_slack_id: `U_${person}`, rank,
  task_id: `task-${person}-${rank}`, task_name: `Edit ${rank}`, task_url: 'https://notion.test/task',
  canonical_type: 'edit', derived_status: 'ready', notion_blocked: false, due_date: null,
  days_overdue: null, days_in_status: 2, ad_set_code: `SET-${person}-${rank}`, ad_set_url: null,
  client_code: 'TEST', bucket: 'editing', ad_delivery_date: null, data_confidence: null,
  days_held: 2, typical_days: 3,
});

beforeEach(() => {
  fake.posts.length = fake.sessions.length = fake.messages.length = 0;
  fake.failedPost = -1;
  fake.rows = [row('Fiona', 1), row('Fiona', 2), row('Mikel')];
  vi.stubGlobal('fetch', () => { throw new Error('Unregistered network call'); });
});

describe('scheduled My Moves delivery', () => {
  it('gives each person an independent reply root and durable exact task context', async () => {
    const result = await runPiperMyMoves({ post: true });
    expect(result.posted).toBe(true);
    expect(fake.posts).toHaveLength(3);
    expect(fake.posts.every(p => !p.thread_ts)).toBe(true);
    expect(fake.sessions).toHaveLength(2);
    expect(fake.sessions.map(s => s.thread_ts)).toEqual(['100.2', '100.3']);
    expect(fake.sessions.map(s => s.user_id)).toEqual(['U_Fiona', 'U_Mikel']);
    expect(fake.messages[0]?.content).toContain('task-Fiona-2');
    expect(fake.messages[0]?.content).not.toContain('task-Mikel');
  });
  it('never announces success when Slack returns ok:false even with a timestamp', async () => {
    fake.failedPost = 2;
    await expect(runPiperMyMoves({ post: true })).rejects.toThrow(/failed|accepted/i);
    expect(fake.sessions).toHaveLength(0);
  });
  it('dry run creates no Slack effects or sessions', async () => {
    await runPiperMyMoves();
    expect(fake.posts).toEqual([]);
    expect(fake.sessions).toEqual([]);
  });
  it('keeps unavailable freshness unknown and requests an exact task', () => {
    const render = renderMyMoves(fake.rows as unknown as MyMoveRow[], { freshness: null });
    expect(render.parent).toContain('freshness unavailable');
    expect(render.parent).toContain('task');
    expect(render.parent).not.toContain("and I'll update Notion");
  });
});
