/**
 * SSE accumulator for the eval harness's --target http mode (eval-ada.ts).
 *
 * Pure state machine — feed it raw SSE chunks from the ada-console-assist
 * /chat stream and it accumulates `text` events (resetting on `reset`) and
 * captures the honest `done` frame (ok/subtype/cost_usd). Extracted from the
 * harness so the truncation path is unit-testable:
 *
 *   - `sawDone` is TRUE only if a `done` event actually arrived. A stream that
 *     ends without one (server crash / timeout mid-answer) leaves sawDone=false
 *     → the harness records an infra FAIL and does NOT judge the partial text.
 *   - `flush()` parses any residual buffered frame after the read loop — SSE
 *     frames are normally terminated by a blank line, but the FINAL frame can
 *     arrive without one; without the flush a valid done.ok/cost would be lost
 *     to framing.
 */

export interface ChatStreamState {
  response: string;
  ok: boolean;
  subtype: string;
  costUsd: number;
  /** True only if a `done` event was actually received. */
  sawDone: boolean;
}

export interface SseAccumulator {
  state: ChatStreamState;
  /** Feed a decoded chunk; parses every complete (blank-line-terminated) frame. */
  push(chunk: string): void;
  /** Parse any residual buffered frame (a final frame without trailing \n\n). */
  flush(): void;
}

export function createSseAccumulator(): SseAccumulator {
  const state: ChatStreamState = { response: '', ok: false, subtype: 'unknown', costUsd: 0, sawDone: false };
  let buf = '';

  const processFrame = (frame: string): void => {
    let event = 'message';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
      // lines starting with ':' are comments (heartbeats) — ignore.
    }
    if (!data) return;
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(data) as Record<string, unknown>; } catch { return; }
    if (event === 'text' && typeof payload.text === 'string') state.response += payload.text;
    else if (event === 'reset') state.response = '';
    else if (event === 'done') {
      state.sawDone = true;
      state.ok = payload.ok === true;
      state.subtype = String(payload.subtype ?? 'unknown');
      state.costUsd = Number(payload.cost_usd ?? 0);
    } else if (event === 'error' && typeof payload.error === 'string' && !state.response) {
      state.response = `[chat error] ${payload.error}`;
    }
  };

  return {
    state,
    push(chunk: string): void {
      buf += chunk;
      let sep;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        processFrame(buf.slice(0, sep));
        buf = buf.slice(sep + 2);
      }
    },
    flush(): void {
      if (buf.trim()) processFrame(buf);
      buf = '';
    },
  };
}
