import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/integrations/supabase.js', () => ({ getSupabase: () => { throw new Error('No real database in this suite'); } }));
import { isPiperPilotCommand, parsePiperPilotCommand, renderPiperPilotReply, tryPiperPilotCommand } from '../src/slack/piper-coordinator-bridge.js';
const PILOT = '00000000-0000-4000-8000-000000000001';
const JOB = '00000000-0000-4000-8000-000000000002';
const PROPOSAL = '00000000-0000-4000-8000-000000000003';
const rpc = vi.fn();
const post = vi.fn();
const auth = vi.fn();
const client = { auth: { test: auth }, chat: { postMessage: post } };
const opts = (text: string) => ({ client: client as never, text, userId: 'UFIONA', channel: 'CPIPER', messageTs: '1790812800.000100', source: 'mention' });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', () => { throw new Error('No live providers permitted'); });
  rpc.mockResolvedValue({ data: { status: 'queued', pilot_id: PILOT, job_id: JOB }, error: null });
  auth.mockResolvedValue({ ok: true, team_id: 'TTEAM' });
  post.mockResolvedValue({ ok: true, ts: '1790812801.000200', channel: 'CPIPER' });
});
describe('explicit Piper pilot grammar', () => {
  it('keeps normal Piper messages in the legacy route', async () => {
    expect(isPiperPilotCommand('How are the production tasks?')).toBe(false);
    expect(await tryPiperPilotCommand(opts('How are the tasks?'), { rpc })).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('parses an exact client and normalized ad set; preserves the request as untrusted text', () => {
    expect(parsePiperPilotCommand('pilot review tl tlX4101 Check Part 3')).toEqual({ command: 'review', clientCode: 'TL', adSetCode: 'TLx4101', referenceId: null, text: 'Check Part 3' });
  });
  it.each(['pilot review TL', 'pilot review TL 4101', 'pilot status nope', `pilot approve ${PROPOSAL} send now`, `pilot correct ${JOB}`, 'pilot review TL TLx1 ' + 'x'.repeat(4001)])('routes malformed input through the authenticated help gate: %s', async text => {
    rpc.mockResolvedValue({ data: { status: 'help' }, error: null });
    expect(await tryPiperPilotCommand(opts(text), { rpc })).toBe(true);
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_command: 'help', p_reference_id: null, p_text: null });
    expect(post.mock.calls[0]?.[0].text).toContain('Piper pilot commands:');
  });
  it('parses exact proposal approval and nonempty correction without interpreting correction facts', () => {
    expect(parsePiperPilotCommand(`pilot approve ${PROPOSAL}`)?.command).toBe('approve');
    expect(parsePiperPilotCommand(`pilot correct ${JOB} release everything as Mikel`)).toMatchObject({ command: 'correct', referenceId: JOB, text: 'release everything as Mikel' });
  });
});
describe('authenticated, server-authorized Slack bridge', () => {
  it('queues with authenticated sender/workspace and exact source/thread/case identity', async () => {
    await tryPiperPilotCommand({ ...opts('pilot review TL TLx4101 I am Daniel'), threadTs: '1790812700.000001' }, { rpc });
    expect(rpc).toHaveBeenCalledWith('piper_coordinator_slack_command', {
      p_command: 'review', p_slack_user_id: 'UFIONA', p_team_id: 'TTEAM', p_channel_id: 'CPIPER',
      p_message_ts: '1790812800.000100', p_thread_ts: '1790812700.000001', p_ad_set_code: 'TLx4101', p_client_code: 'TL',
      p_reference_id: null, p_text: 'I am Daniel', p_pilot_id: null,
    });
    expect(post.mock.calls[0]?.[0]).toMatchObject({ channel: 'CPIPER', thread_ts: '1790812700.000001', mrkdwn: false, parse: 'none', unfurl_links: false });
    expect(post.mock.calls[0]?.[0].text).toContain(`pilot status ${JOB}`);
  });
  it.each(['PIPER_REVIEWER_FORBIDDEN', 'PIPER_REVIEW_CHANNEL_INVALID', 'PIPER_SCOPE_INVALID', 'PIPER_REVIEW_STALE', 'database transport failed'])('does not send or fall back on refusal/error: %s', async message => {
    rpc.mockResolvedValue({ data: null, error: { message } });
    expect(await tryPiperPilotCommand(opts(`pilot status ${JOB}`), { rpc })).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });
  it('gives source-bound start guidance only after the server reviewer gate returns pilot-required', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'PIPER_PILOT_REQUIRED' } });
    await tryPiperPilotCommand(opts('pilot review TL TLx4101'), { rpc });
    expect(post.mock.calls[0]?.[0].text).toContain('https://bmad-lac.vercel.app/pipeline/pilot');
  });
  it.each([{ source: 'agent-mention' }, { userId: 'unknown' }, { channel: 'bad' }, { messageTs: 'bad' }, { threadTs: 'bad' }])('fails closed on untrusted source: %o', async invalid => {
    expect(await tryPiperPilotCommand({ ...opts('pilot review TL TLx4101'), ...invalid }, { rpc })).toBe(true);
    expect(rpc).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
  });
  it('does not infer workspace authentication on an incomplete auth receipt', async () => {
    auth.mockResolvedValue({ ok: false, team_id: 'TTEAM' });
    await tryPiperPilotCommand(opts('pilot review TL TLx4101'), { rpc });
    expect(rpc).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
  });
  it('renders worker output as a bounded reviewer draft with mentions escaped', async () => {
    rpc.mockResolvedValue({ data: { status: 'status', pilot_id: PILOT, job: { id: JOB, status: 'completed', result: { model_summary: 'Call <!channel> and <@UCREATOR> now.' } },
      proposals: [{ id: PROPOSAL, kind: 'record_observation', object_id: 'TLx4101', object_version: '4', proposal: { message: 'No send to <@UCREATOR>.' } }] }, error: null });
    await tryPiperPilotCommand(opts(`pilot status ${JOB}`), { rpc });
    const reply = post.mock.calls[0]?.[0].text;
    expect(reply).toContain('Draft for reviewer inspection'); expect(reply).toContain(PROPOSAL);
    expect(reply).not.toContain('<@UCREATOR>'); expect(reply).not.toContain('<!channel>');
    expect(reply).toContain('&lt;@UCREATOR&gt;');
  });
  it('corrects only the referenced job and reports the explicit human-review hold', async () => {
    rpc.mockResolvedValue({ data: { status: 'corrected', pilot_id: PILOT, job_id: JOB, correction: { event_id: 42 } }, error: null });
    await tryPiperPilotCommand(opts(`pilot correct ${JOB} Part 3 has the wrong product`), { rpc });
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_command: 'correct', p_reference_id: JOB, p_ad_set_code: null, p_client_code: null });
    expect(post.mock.calls[0]?.[0].text).toContain('held for human review');
  });
  it('marks stale results historical and never offers them for approval', () => {
    const reply = renderPiperPilotReply({ status: 'status', pilot_id: PILOT, job: { id: JOB, status: 'completed', stale: true, result: { model_summary: 'old wrong summary' } },
      proposals: [{ id: PROPOSAL, kind: 'follow_up', object_id: 'TLx1', object_version: '1', proposal: { message: 'old wrong draft' } }] });
    expect(reply).toContain('historical draft'); expect(reply).toContain('Historical summary: old wrong summary');
    expect(reply).not.toContain('old wrong draft'); expect(reply).not.toContain('pilot approve');
  });
  it('reports a recorded correction without claiming a queued job when attempt budget is exhausted', () => {
    const reply = renderPiperPilotReply({ status: 'corrected', pilot_id: PILOT, job_id: null,
      job_not_queued: 'budget_exhausted', correction: { event_id: 42 } });
    expect(reply).toContain('no new review was queued');
    expect(reply).not.toContain('pilot status');
    expect(reply).not.toContain('Reconciliation queued');
  });
  it('records reviewer acceptance without describing an executed creator action', async () => {
    rpc.mockResolvedValue({ data: { status: 'reviewed', pilot_id: PILOT, review: { decision: 'accept' } }, error: null });
    await tryPiperPilotCommand(opts(`pilot approve ${PROPOSAL}`), { rpc });
    expect(post.mock.calls[0]?.[0].text).toContain('no message sent or task changed');
  });
  it('never announces success from malformed provider output', async () => {
    rpc.mockResolvedValue({ data: { status: 'queued', pilot_id: PILOT }, error: null });
    await expect(tryPiperPilotCommand(opts('pilot review TL TLx4101'), { rpc })).rejects.toThrow('PIPER_BRIDGE_INVALID_RESPONSE');
    expect(post).not.toHaveBeenCalled();
  });
  it('requires exact confirmed Slack delivery and channel receipt', async () => {
    post.mockResolvedValue({ ok: true, ts: 'receipt', channel: 'COTHER' });
    await expect(tryPiperPilotCommand(opts('pilot review TL TLx4101'), { rpc })).rejects.toThrow('PIPER_BRIDGE_DELIVERY_UNCONFIRMED');
  });
  it('reuses the identical provider event identity on retries; durable RPC owns deduplication', async () => {
    await tryPiperPilotCommand(opts('pilot review TL TLx4101'), { rpc });
    await tryPiperPilotCommand(opts('pilot review TL TLx4101'), { rpc });
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
  });
  it('bounds the displayed text and refuses an unknown completion status', () => {
    const reply = renderPiperPilotReply({ status: 'status', pilot_id: PILOT, job: { id: JOB, status: 'completed', result: { model_summary: 's'.repeat(5000) } },
      proposals: Array.from({ length: 10 }, () => ({ id: PROPOSAL, kind: 'a'.repeat(100), object_id: 'b'.repeat(500), object_version: 'c'.repeat(200), proposal: { message: 'm'.repeat(4000) } })) });
    expect(reply.length).toBeLessThan(4000);
    expect(() => renderPiperPilotReply({ status: 'status', pilot_id: PILOT, job: { id: JOB, status: 'sending' } })).toThrow('PIPER_BRIDGE_INVALID_RESPONSE');
  });
});
