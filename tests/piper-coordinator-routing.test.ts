import { beforeEach, describe, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  rpc: vi.fn(),
  runAgent: vi.fn(async (_input: unknown) => ({ response: 'Checked the identified task.', usage: {} })),
  finalize: vi.fn(),
  onText: vi.fn(),
  posts: [] as Array<Record<string, unknown>>,
}));
vi.mock('../src/integrations/supabase.js', () => ({ getSupabase: () => ({ rpc: fake.rpc }) }));
vi.mock('../src/env.js', () => ({ env: {} }));
vi.mock('../src/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/agents/runner.js', () => ({ runAgent: fake.runAgent }));
vi.mock('../src/agents/registry.js', () => ({ getAgent: () => ({ config: { display_name: 'Piper' } }) }));
vi.mock('../src/client-agents/config.js', () => ({ getClientAgentByChannel: vi.fn() }));
vi.mock('../src/agents/agent-directory.js', () => ({ AGENT_OFFICE_CHANNEL_ID: 'C_OFFICE' }));
vi.mock('../src/orchestrator/queue.js', () => ({ agentQueue: { enqueue: async (_channel: string, run: () => unknown) => run() } }));
vi.mock('../src/slack/stream-responder.js', () => ({ createStreamResponder: () => ({ onText: fake.onText, finalize: fake.finalize, resetAccumulated: vi.fn(), onError: vi.fn() }) }));
vi.mock('../src/slack/listeners/reactions.js', () => ({ registerReactionListener: vi.fn() }));
vi.mock('../src/slack/listeners/insight-actions.js', () => ({ registerInsightActions: vi.fn() }));
vi.mock('../src/slack/listeners/email-actions.js', () => ({ registerEmailActions: vi.fn() }));
vi.mock('../src/slack/listeners/triage-actions.js', () => ({ registerTriageActions: vi.fn() }));
vi.mock('../src/slack/app.js', () => ({ slackApp: {} }));
vi.mock('../src/slack/voice.js', () => ({ transcribeAudioFiles: vi.fn() }));
vi.mock('@slack/bolt', () => ({ App: class {} }));
vi.mock('../src/integrations/dai-supabase.js', () => ({ getDaiSupabase: () => ({
  from: () => {
    const filters: Array<[string, unknown]> = [];
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      order: () => query, limit: () => query,
      maybeSingle: async () => ({ data: fake.sessions.find(s => filters.every(([k, v]) => s[k] === v)) ?? null }),
    };
    return query;
  },
}) }));

type Handler = (input: { message: Record<string, unknown>; client: unknown }) => Promise<void>;
async function restartedListener(agentId = 'piper') {
  vi.resetModules(); // process-local ownership and deduplication caches disappear
  const { registerDedicatedBotListeners } = await import('../src/slack/dedicated-bots.js');
  const messages: Handler[] = [];
  registerDedicatedBotListeners({ message: (h: Handler) => messages.push(h), event: vi.fn() } as never, agentId);
  return messages[1]!;
}
const client = {
  auth: { test: async () => ({ ok: true, user_id: 'UPIPER', team_id: 'TTEAM' }) },
  chat: { postMessage: async (input: Record<string, unknown>) => { fake.posts.push(input); return { ok: true, ts: 'receipt', channel: input.channel }; } },
};
const reply = (text: string, channel = 'CPIPER', ts = '100.2') => ({
  message: { channel, thread_ts: '100.1', ts, text, user: 'UFIONA', channel_type: 'channel' }, client,
});
beforeEach(() => {
  vi.clearAllMocks(); fake.posts.length = 0;
  fake.sessions = [{ id: 'durable', channel_id: 'CPIPER', thread_ts: '100.1', agent_id: 'piper', status: 'active', summary: '[piper-scheduled-my-moves:v1]{"task_ids":["task-1","task-2"]}' }];
  vi.stubGlobal('fetch', () => { throw new Error('Unregistered network call'); });
});

describe('Piper persistent coordinator through actual dedicated listeners', () => {
  it('recovers an explicit reviewer status command in an unowned thread after restart', async () => {
    fake.sessions = [];
    const handler = await restartedListener();
    fake.rpc.mockResolvedValue({ data: { status: 'status', pilot_id: '00000000-0000-4000-8000-000000000001', job: { id: '00000000-0000-4000-8000-000000000002', status: 'pending' } }, error: null });
    await handler(reply('pilot status 00000000-0000-4000-8000-000000000002'));
    expect(fake.rpc).toHaveBeenCalledOnce();
    expect(fake.runAgent).not.toHaveBeenCalled();
    expect(fake.finalize).not.toHaveBeenCalled();
    expect(fake.posts[0]).toMatchObject({ channel: 'CPIPER', thread_ts: '100.1', mrkdwn: false });
  });
  it('refuses a non-reviewer server receipt without model fallback or post', async () => {
    fake.sessions = [];
    const handler = await restartedListener();
    fake.rpc.mockResolvedValue({ data: null, error: { message: 'PIPER_REVIEWER_FORBIDDEN' } });
    await handler(reply('pilot review TL TLx4101'));
    expect(fake.rpc).toHaveBeenCalledOnce();
    expect(fake.runAgent).not.toHaveBeenCalled();
    expect(fake.posts).toEqual([]);
  });
  it('preserves the normal legacy Piper conversation route', async () => {
    const handler = await restartedListener();
    await handler(reply('Task 2 is blocked on client'));
    expect(fake.rpc).not.toHaveBeenCalled();
    expect(fake.runAgent).toHaveBeenCalledOnce();
  });
  it('does not intercept another agent’s pilot text', async () => {
    fake.sessions[0]!.agent_id = 'ada';
    const handler = await restartedListener('ada');
    await handler(reply('pilot review TL TLx4101'));
    expect(fake.rpc).not.toHaveBeenCalled();
    expect(fake.runAgent).toHaveBeenCalledOnce();
    expect(fake.runAgent.mock.calls[0]?.[0]).toMatchObject({ agentId: 'ada' });
  });
});
