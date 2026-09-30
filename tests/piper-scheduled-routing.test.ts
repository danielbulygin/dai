import { beforeEach, describe, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  runAgent: vi.fn(async (_input: unknown) => ({ response: 'Checked the identified task.', usage: {} })),
  finalize: vi.fn(),
  onText: vi.fn(),
  posts: [] as Array<Record<string, unknown>>,
}));
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
async function restartedListener() {
  vi.resetModules(); // process-local ownership and deduplication caches disappear
  const { registerDedicatedBotListeners } = await import('../src/slack/dedicated-bots.js');
  const messages: Handler[] = [];
  registerDedicatedBotListeners({ message: (h: Handler) => messages.push(h), event: vi.fn() } as never, 'piper');
  return messages[1]!;
}
const client = {
  auth: { test: async () => ({ user_id: 'UPIPER' }) },
  chat: { postMessage: async (input: Record<string, unknown>) => { fake.posts.push(input); return { ok: true, ts: 'receipt' }; } },
};
const reply = (text: string, channel = 'C_PIPER', ts = '100.2') => ({
  message: { channel, thread_ts: '100.1', ts, text, user: 'U_FIONA', channel_type: 'channel' }, client,
});
beforeEach(() => {
  vi.clearAllMocks(); fake.posts.length = 0;
  fake.sessions = [{ id: 'durable', channel_id: 'C_PIPER', thread_ts: '100.1', agent_id: 'piper', status: 'active', summary: '[piper-scheduled-my-moves:v1]{"task_ids":["task-1","task-2"]}' }];
  vi.stubGlobal('fetch', () => { throw new Error('Unregistered network call'); });
});
describe('Piper scheduled reply recovery through real sessions repository', () => {
  it('routes an unmentioned exact-task reply after restart and deduplicates its current-process redelivery', async () => {
    const handler = await restartedListener();
    await handler(reply('Task 2 is blocked on the client'));
    await handler(reply('Task 2 is blocked on the client'));
    expect(fake.runAgent).toHaveBeenCalledTimes(1);
    expect(fake.runAgent.mock.calls[0]?.[0]).toMatchObject({ agentId: 'piper', channelId: 'C_PIPER', threadTs: '100.1' });
    expect(fake.runAgent.mock.calls[0]?.[0]).toHaveProperty('onText', undefined);
    expect(fake.finalize).toHaveBeenCalledOnce();
  });
  it('asks which task on a bare done without running the model or writes', async () => {
    const handler = await restartedListener();
    await handler(reply('done'));
    expect(fake.runAgent).not.toHaveBeenCalled();
    expect(fake.posts[0]).toMatchObject({ channel: 'C_PIPER', thread_ts: '100.1' });
    expect(fake.posts[0]?.text).toContain('Which task');
  });
  it('does not let a cached timestamp claim an unrelated channel', async () => {
    const handler = await restartedListener();
    await handler(reply('Task 2 is blocked'));
    await handler(reply('Task 2 is blocked', 'C_OTHER', '100.3'));
    expect(fake.runAgent).toHaveBeenCalledTimes(1);
  });
  it('does not intercept a reply mentioning another person', async () => {
    const handler = await restartedListener();
    await handler(reply('<@UOTHER> task 2 is blocked'));
    expect(fake.runAgent).not.toHaveBeenCalled();
  });
});
