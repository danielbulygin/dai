import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isReadTool, isWriteTool } from '../src/agents/sdk/guard.js';
import {
  type AdaErrorEvent,
  buildErrorEvent,
  emitErrorEvent,
  resetPingThrottle,
} from '../src/observability/error-events.js';
import { isTracingEnabled, startTrace } from '../src/observability/langsmith.js';
import { classifyError, redactSecrets, safeMessage } from '../src/observability/redact.js';

const LOG_PATH = join(tmpdir(), `ada-errors-test-${process.pid}.jsonl`);

/** The JSONL sink is fire-and-forget, so tests wait for the line rather than for a promise. */
async function readEvents(): Promise<AdaErrorEvent[]> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const text = await readFile(LOG_PATH, 'utf8');
      if (text.trim()) {
        return text
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as AdaErrorEvent);
      }
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return [];
}

describe('redaction', () => {
  it('strips a Meta access token out of error text', () => {
    const raw =
      'GET /act_123/campaigns?access_token=EAAGm0PX4ZCpsBAxxxxxxxxxxxxxxxxxxxxxxxx failed';
    const out = redactSecrets(raw);
    expect(out).not.toContain('EAAGm0PX4ZCpsBA');
    expect(out).toContain('redacted');
  });

  it('strips Slack, Anthropic and JWT shaped credentials', () => {
    const out = redactSecrets(
      'xoxb-123456789012-abcdefghijkl and sk-ant-api03-abcdefghijklmnop and eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4',
    );
    expect(out).not.toMatch(/xoxb-123456789012/);
    expect(out).not.toMatch(/sk-ant-api03/);
    expect(out).not.toMatch(/eyJhbGciOiJIUzI1\./);
  });

  it('keeps ordinary ids readable — a redacted id is an undiagnosable error', () => {
    const out = redactSecrets('campaign 120210000000000123 in act_1570076840279279 is PAUSED');
    expect(out).toContain('120210000000000123');
    expect(out).toContain('act_1570076840279279');
  });

  it('truncates long messages and collapses whitespace', () => {
    const out = safeMessage(`a${'x'.repeat(5000)}`, 100);
    expect(out.length).toBeLessThan(200);
    expect(out).toContain('truncated');
    expect(safeMessage('two\n\n  lines')).toBe('two lines');
  });

  it('accepts an Error as well as a string', () => {
    expect(safeMessage(new Error('boom'))).toBe('boom');
  });

  it('classifies the failure shapes that matter', () => {
    expect(classifyError('HTTP 429 user request limit reached')).toBe('rate_limit');
    expect(classifyError('Invalid OAuth access token')).toBe('auth');
    expect(classifyError('request timed out after 30s')).toBe('timeout');
    expect(classifyError('502 Bad Gateway')).toBe('upstream_5xx');
    expect(classifyError('something odd happened')).toBe('unknown');
  });
});

describe('error events', () => {
  beforeEach(async () => {
    process.env.ADA_ERROR_LOG_PATH = LOG_PATH;
    delete process.env.ADA_ERROR_SLACK_CHANNEL;
    delete process.env.ADA_ERROR_SLACK_BOT_TOKEN;
    resetPingThrottle();
    await rm(LOG_PATH, { force: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(LOG_PATH, { force: true });
  });

  it('builds an event with the run, client, tool and a redacted message', () => {
    const event = buildErrorEvent({
      kind: 'tool_failure',
      surface: 'chat-scoped',
      runId: 'run-1',
      clientCode: 'mtn',
      sessionId: 'sess-1',
      toolName: 'launch_ads',
      error: 'failed with access_token=EAAGm0PX4ZCpsBAxxxxxxxxxxxxxxxxxxxxxx',
    });
    expect(event.run_id).toBe('run-1');
    expect(event.client_code).toBe('MTN');
    expect(event.tool_name).toBe('launch_ads');
    expect(event.message).not.toContain('EAAGm0PX4ZCpsBA');
    expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('appends one JSONL line per event', async () => {
    emitErrorEvent({
      kind: 'silent_write_failure',
      surface: 'chat-scoped',
      runId: 'run-2',
      clientCode: 'MTN',
      toolName: 'create_task',
      error: '{"error":"Notion 400"}',
    });
    const events = await readEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('silent_write_failure');
    expect(events[0]!.tool_name).toBe('create_task');
  });

  it('does not ping Slack when the channel is unconfigured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    emitErrorEvent({
      kind: 'tool_failure',
      surface: 'chat-scoped',
      runId: 'run-3',
      clientCode: 'MTN',
      error: 'boom',
    });
    await readEvents();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('pings once per signature — a tool failing in a loop must not bury the channel', async () => {
    process.env.ADA_ERROR_SLACK_CHANNEL = 'C123';
    process.env.ADA_ERROR_SLACK_BOT_TOKEN = 'xoxb-test';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    for (let i = 0; i < 3; i++) {
      emitErrorEvent({
        kind: 'tool_failure',
        surface: 'chat-scoped',
        runId: `run-loop-${i}`,
        clientCode: 'MTN',
        toolName: 'launch_ads',
        error: 'HTTP 500 from Meta',
      });
    }
    await readEvents();
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string) as {
      channel: string;
      text: string;
    };
    expect(body.channel).toBe('C123');
    expect(body.text).toContain('MTN');
  });

  it('never pings for an internal run or for a refusal', async () => {
    process.env.ADA_ERROR_SLACK_CHANNEL = 'C123';
    process.env.ADA_ERROR_SLACK_BOT_TOKEN = 'xoxb-test';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true })));

    emitErrorEvent({
      kind: 'tool_failure',
      surface: 'chat',
      runId: 'r1',
      error: 'internal blow-up',
    });
    emitErrorEvent({
      kind: 'refusal',
      surface: 'chat-scoped',
      runId: 'r2',
      clientCode: 'MTN',
      toolName: 'launch_ads',
      error: 'Governor refused',
    });
    await readEvents();
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('langsmith tracing', () => {
  beforeEach(() => {
    delete process.env.LANGSMITH_TRACING;
    delete process.env.LANGSMITH_API_KEY;
    process.env.LANGSMITH_PROJECT = 'ada-test';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LANGSMITH_TRACING;
    delete process.env.LANGSMITH_API_KEY;
  });

  it('is off unless BOTH the flag and the key are set — unset means zero behaviour change', () => {
    expect(isTracingEnabled()).toBe(false);
    process.env.LANGSMITH_TRACING = 'true';
    expect(isTracingEnabled()).toBe(false);
    process.env.LANGSMITH_API_KEY = 'lsv2_pt_test';
    expect(isTracingEnabled()).toBe(true);
  });

  it('makes no network call at all when disabled', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const span = startTrace({
      name: 'ada:chat',
      runId: 'r',
      surface: 'chat',
      inputs: {},
    });
    span.child('launch_ads', 'tool', {}).end({ outputs: {} });
    span.end({ outputs: {} });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts a root run tagged with the client and run id, then patches it closed', async () => {
    process.env.LANGSMITH_TRACING = 'true';
    process.env.LANGSMITH_API_KEY = 'lsv2_pt_test';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));

    const span = startTrace({
      name: 'ada:chat-scoped',
      runId: '11111111-2222-3333-4444-555555555555',
      clientCode: 'mtn',
      surface: 'chat-scoped',
      inputs: { message: 'how did we do?' },
    });
    span.end({ outputs: { answer: 'fine' } });
    await new Promise((r) => setTimeout(r, 20));

    const post = fetchSpy.mock.calls.find((c) => (c[1] as RequestInit).method === 'POST')!;
    const posted = JSON.parse((post[1] as RequestInit).body as string) as {
      tags: string[];
      dotted_order: string;
      session_name: string;
      trace_id: string;
    };
    expect(posted.tags).toContain('client:MTN');
    expect(posted.tags).toContain('run:11111111-2222-3333-4444-555555555555');
    expect(posted.session_name).toBe('ada-test');
    expect(posted.dotted_order).toMatch(/^\d{8}T\d{12}Z11111111-2222-3333-4444-555555555555$/);

    const patch = fetchSpy.mock.calls.find((c) => (c[1] as RequestInit).method === 'PATCH');
    expect(patch).toBeDefined();
    expect(String(patch![0])).toContain('/runs/11111111-2222-3333-4444-555555555555');
  });

  it('nests a tool span under its parent run', async () => {
    process.env.LANGSMITH_TRACING = 'true';
    process.env.LANGSMITH_API_KEY = 'lsv2_pt_test';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));

    const span = startTrace({
      name: 'ada:chat',
      runId: '11111111-2222-3333-4444-555555555555',
      surface: 'chat',
      inputs: {},
    });
    span.child('query_meta_insights', 'tool', { args: {} }).end({ error: 'Meta 500' });
    await new Promise((r) => setTimeout(r, 20));

    const childPost = fetchSpy.mock.calls
      .filter((c) => (c[1] as RequestInit).method === 'POST')
      .map((c) => JSON.parse((c[1] as RequestInit).body as string) as Record<string, unknown>)
      .find((b) => b.name === 'query_meta_insights')!;
    expect(childPost.parent_run_id).toBe('11111111-2222-3333-4444-555555555555');
    expect(childPost.run_type).toBe('tool');
    expect(String(childPost.dotted_order)).toContain('11111111-2222-3333-4444-555555555555.');
  });

  it('redacts a secret that reached the trace as an error', async () => {
    process.env.LANGSMITH_TRACING = 'true';
    process.env.LANGSMITH_API_KEY = 'lsv2_pt_test';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));

    const span = startTrace({
      name: 'ada:chat',
      runId: 'r',
      surface: 'chat',
      inputs: {},
    });
    span.end({
      error: 'died with access_token=EAAGm0PX4ZCpsBAxxxxxxxxxxxxxxxxxxxxxx',
    });
    await new Promise((r) => setTimeout(r, 20));

    const patch = fetchSpy.mock.calls.find((c) => (c[1] as RequestInit).method === 'PATCH')!;
    expect((patch[1] as RequestInit).body as string).not.toContain('EAAGm0PX4ZCpsBA');
  });
});

describe('write classification', () => {
  it('names the tools whose failure means something did not happen', () => {
    expect(isWriteTool('launch_ads')).toBe(true);
    expect(isWriteTool('create_task')).toBe(true);
    expect(isWriteTool('upload_to_media_library')).toBe(true);
    expect(isWriteTool('delete_task')).toBe(true);
    expect(isWriteTool('query_meta_insights')).toBe(false);
    expect(isReadTool('query_meta_insights')).toBe(true);
  });
});
