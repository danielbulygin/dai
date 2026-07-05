import { describe, it, expect } from 'vitest';
import { createSseAccumulator } from '../src/agents/sdk/eval-http.js';

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe('eval-http — SSE accumulator (the --target http stream parser)', () => {
  it('accumulates text events and captures the done frame', () => {
    const acc = createSseAccumulator();
    acc.push(frame('meta', { session_id: 's1' }));
    acc.push(frame('text', { text: 'Hello ' }));
    acc.push(frame('text', { text: 'world' }));
    acc.push(frame('done', { ok: true, subtype: 'success', cost_usd: 1.23 }));
    acc.flush();
    expect(acc.state).toEqual({ response: 'Hello world', ok: true, subtype: 'success', costUsd: 1.23, sawDone: true });
  });

  it('handles frames split across arbitrary chunk boundaries', () => {
    const acc = createSseAccumulator();
    const raw = frame('text', { text: 'ab' }) + frame('done', { ok: true, subtype: 'success', cost_usd: 0.5 });
    for (const ch of raw) acc.push(ch); // one char at a time
    acc.flush();
    expect(acc.state.response).toBe('ab');
    expect(acc.state.sawDone).toBe(true);
    expect(acc.state.ok).toBe(true);
  });

  it('TRUNCATION: a stream that ends without a done event leaves sawDone=false and ok=false', () => {
    const acc = createSseAccumulator();
    acc.push(frame('text', { text: 'partial answer that got cut o' }));
    // server crashed — no done frame ever arrives
    acc.flush();
    expect(acc.state.sawDone).toBe(false);
    expect(acc.state.ok).toBe(false);
    expect(acc.state.subtype).toBe('unknown');
    expect(acc.state.response).toContain('partial answer');
  });

  it('flush() parses a FINAL frame that arrived without a trailing blank line (done.ok/cost not lost to framing)', () => {
    const acc = createSseAccumulator();
    acc.push(frame('text', { text: 'answer' }));
    // final done frame with NO trailing \n\n
    acc.push('event: done\ndata: {"ok":true,"subtype":"success","cost_usd":2.5}');
    expect(acc.state.sawDone).toBe(false); // not parsed yet — still buffered
    acc.flush();
    expect(acc.state.sawDone).toBe(true);
    expect(acc.state.ok).toBe(true);
    expect(acc.state.costUsd).toBe(2.5);
  });

  it('a done frame with ok=false is sawDone=true but ok=false (runner-reported failure, distinct from truncation)', () => {
    const acc = createSseAccumulator();
    acc.push(frame('text', { text: 'gave up' }));
    acc.push(frame('done', { ok: false, subtype: 'error_max_turns', cost_usd: 3.1 }));
    acc.flush();
    expect(acc.state.sawDone).toBe(true);
    expect(acc.state.ok).toBe(false);
    expect(acc.state.subtype).toBe('error_max_turns');
  });

  it('reset clears accumulated text (mirrors the server fullText reset); heartbeats and bad JSON are ignored', () => {
    const acc = createSseAccumulator();
    acc.push(frame('text', { text: 'draft one' }));
    acc.push('event: reset\ndata: {}\n\n');
    acc.push(': ping\n\n'); // heartbeat comment
    acc.push('event: text\ndata: {not json\n\n'); // malformed — ignored
    acc.push(frame('text', { text: 'final' }));
    acc.push(frame('done', { ok: true, subtype: 'success', cost_usd: 1 }));
    acc.flush();
    expect(acc.state.response).toBe('final');
    expect(acc.state.ok).toBe(true);
  });

  it('error event becomes the response only when no text arrived', () => {
    const acc = createSseAccumulator();
    acc.push(frame('error', { error: 'boom' }));
    acc.flush();
    expect(acc.state.response).toBe('[chat error] boom');
    expect(acc.state.sawDone).toBe(false);
  });
});
