import { beforeEach, describe, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({
  receive: vi.fn(async()=>({state:'rejected'})),
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
vi.mock('../src/agents/agent-directory.js', () => ({ AGENT_OFFICE_CHANNEL_ID: 'C0B83JXLPK6' }));
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


vi.mock('../src/agents/tools/aot-notion-tools.js',()=>({updateAotTaskStatus:vi.fn()}));
vi.mock('../src/agents/action-log.js',()=>({logWrite:vi.fn()}));
vi.mock('../src/slack/ace-handoff-core.js',async original=>({...await original<Record<string,unknown>>(),receiveAceHandoff:fake.receive}));
async function listener(){vi.resetModules();const {registerDedicatedBotListeners}=await import('../src/slack/dedicated-bots.js');let mention:any;registerDedicatedBotListeners({message:vi.fn(),event:(name:string,handler:any)=>{if(name==='app_mention')mention=handler;}} as never,'piper');return mention;}
const auth=vi.fn(async()=>({ok:true,user_id:'U0B7AF0N3CL',team_id:'T084ZNV068Y'}));
const replies=vi.fn(async()=>({ok:true,messages:[]}));
const client={auth:{test:auth},conversations:{replies},chat:{postMessage:vi.fn()}};
const event=(text:string,patch={})=>({event:{text,channel:'C0B83JXLPK6',user:'U0B4VEG1JLB',bot_id:'BACE',ts:'1791054000.001',...patch},client});
beforeEach(()=>{vi.clearAllMocks();delete process.env.ACE_HANDOFF_RECIPIENT_CONFIG;vi.stubGlobal('fetch',()=>{throw Error('No test network');});replies.mockResolvedValue({ok:true,messages:[]});});
describe('Ace handoff through real dedicated app_mention listener',()=>{
 it('strips recipient mention and reaches deterministic intake before model routing',async()=>{process.env.ACE_HANDOFF_RECIPIENT_CONFIG=JSON.stringify({recipientReleaseId:'f'.repeat(40),pilot:{expiresAt:'2099-01-01T00:00:00Z'},clients:[]});const handle=await listener();await handle(event('<@U0B7AF0N3CL> ace_handoff v1 req-1'));expect(fake.receive).toHaveBeenCalledOnce();expect(fake.receive.mock.calls[0]?.[0]).toMatchObject({requestId:'req-1',agentId:'piper',userId:'U0B4VEG1JLB',workspaceId:'T084ZNV068Y',channelId:'C0B83JXLPK6'});expect(fake.runAgent).not.toHaveBeenCalled();expect(client.chat.postMessage).not.toHaveBeenCalled();});
 it.each(['ace_handoff v1 req-1','ace_handoff malformed'])('consumes disabled/malformed reserved %s without any model',async text=>{const handle=await listener();await handle(event(`<@U0B7AF0N3CL> ${text}`));expect(fake.receive).not.toHaveBeenCalled();expect(fake.runAgent).not.toHaveBeenCalled();});
 it('retains office and hop-budget guards for bot authored commands',async()=>{const handle=await listener();await handle(event('<@U0B7AF0N3CL> ace_handoff v1 req-1',{channel:'COTHER'}));expect(auth).not.toHaveBeenCalled();replies.mockResolvedValue({ok:true,messages:Array.from({length:4},(_,i)=>({ts:`17000.${i}`,bot_id:'BBOT'}))});await handle(event('<@U0B7AF0N3CL> ace_handoff v1 req-1',{thread_ts:'1791053999.001',ts:'1791054000.002'}));expect(auth).not.toHaveBeenCalled();expect(fake.receive).not.toHaveBeenCalled();expect(fake.runAgent).not.toHaveBeenCalled();});
});
