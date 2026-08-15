/**
 * LangSmith tracing for Ada's customer-facing runs — a hand-rolled, zero-dependency
 * client over the LangSmith ingest REST API.
 *
 * WHY NOT the `langsmith` SDK: the droplet's fast deploy path is
 * `git pull --ff-only && pnpm build && systemctl restart dai` — no `pnpm install`.
 * A new runtime dependency would restart into a module-not-found. This file speaks
 * the two REST calls the SDK would make (POST /runs, PATCH /runs/{id}) and nothing
 * else, so it costs a deploy nothing.
 *
 * GATING: `LANGSMITH_TRACING=true` AND `LANGSMITH_API_KEY` set. Anything else and
 * every function here is an inert no-op — unset means zero behavior change, zero
 * network calls, zero latency.
 *
 * The tracer NEVER throws and never awaits on the request path: a trace is a
 * report about the run, not a step in it.
 */
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { safeMessage } from './redact.js';

const DEFAULT_ENDPOINT = 'https://api.smith.langchain.com';

export function isTracingEnabled(): boolean {
  return (
    (process.env.LANGSMITH_TRACING ?? '').toLowerCase() === 'true' &&
    Boolean(process.env.LANGSMITH_API_KEY)
  );
}

function config() {
  return {
    endpoint: (process.env.LANGSMITH_ENDPOINT ?? DEFAULT_ENDPOINT).replace(/\/+$/, ''),
    apiKey: process.env.LANGSMITH_API_KEY ?? '',
    project: process.env.LANGSMITH_PROJECT ?? 'ada-droplet',
  };
}

/**
 * LangSmith orders a trace's runs by `dotted_order`: one
 * `<start-timestamp><run-id>` segment per ancestor, joined by dots. The
 * timestamp is `%Y%m%dT%H%M%S%fZ` with MICROsecond precision — JS gives
 * milliseconds, so the last three digits are padded.
 */
function dottedSegment(runId: string, startedAt: Date): string {
  const iso = startedAt.toISOString(); // 2026-08-15T10:20:30.123Z
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}${iso.slice(20, 23)}000Z`;
  return `${stamp}${runId}`;
}

type RunType = 'chain' | 'tool' | 'llm';

interface RunHandleInit {
  id: string;
  traceId: string;
  dottedOrder: string;
}

async function post(path: string, method: 'POST' | 'PATCH', body: unknown): Promise<void> {
  const { endpoint, apiKey } = config();
  const res = await fetch(`${endpoint}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`langsmith ${method} ${path} → ${res.status} ${safeMessage(text, 200)}`);
  }
}

/** Fire-and-forget wrapper: a failed trace call is a warn, never an exception. */
function send(path: string, method: 'POST' | 'PATCH', body: unknown): void {
  void post(path, method, body).catch((err) => {
    logger.warn(
      { err: (err as Error).message },
      'langsmith: ingest call failed (tracing degraded)',
    );
  });
}

/**
 * A live span. `end()` closes it; `child()` opens a nested one (a tool call
 * inside the run). Calling either on a disabled tracer is a no-op.
 */
export interface TraceSpan {
  /** The LangSmith run id. Equal to the caller's run id for a root span. */
  readonly id: string;
  child(name: string, runType: RunType, inputs: Record<string, unknown>): TraceSpan;
  end(outcome: { outputs?: Record<string, unknown>; error?: unknown }): void;
}

const NOOP_SPAN: TraceSpan = {
  id: 'tracing-disabled',
  child: () => NOOP_SPAN,
  end: () => {},
};

export interface StartTraceInput {
  /** The run name shown in LangSmith. */
  name: string;
  /** OUR run id — reused as the LangSmith run id so one id correlates log, event and trace. */
  runId: string;
  /** Tagged on the trace so a customer's runs are one filter away. */
  clientCode?: string | null;
  surface: string;
  sessionId?: string | null;
  userId?: string | null;
  inputs: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Open the root span for a run. Returns the inert no-op span when tracing is
 * off, so call sites need no `if (enabled)` guard.
 */
export function startTrace(input: StartTraceInput): TraceSpan {
  if (!isTracingEnabled()) return NOOP_SPAN;

  const startedAt = new Date();
  const runId = isUuid(input.runId) ? input.runId : randomUUID();
  const tags = ['ada', `surface:${input.surface}`];
  if (input.clientCode) tags.push(`client:${input.clientCode.toUpperCase()}`);
  tags.push(`run:${input.runId}`);

  const init: RunHandleInit = {
    id: runId,
    traceId: runId,
    dottedOrder: dottedSegment(runId, startedAt),
  };

  send('/runs', 'POST', {
    id: init.id,
    trace_id: init.traceId,
    dotted_order: init.dottedOrder,
    name: input.name,
    run_type: 'chain' satisfies RunType,
    start_time: startedAt.toISOString(),
    inputs: input.inputs,
    session_name: config().project,
    tags,
    extra: {
      metadata: {
        run_id: input.runId,
        surface: input.surface,
        client_code: input.clientCode ?? null,
        session_id: input.sessionId ?? null,
        user_id: input.userId ?? null,
        ...input.metadata,
      },
    },
  });

  return makeSpan(init, tags);
}

function makeSpan(init: RunHandleInit, tags: string[]): TraceSpan {
  let ended = false;
  return {
    id: init.id,
    child(name, runType, inputs) {
      const childStart = new Date();
      const childId = randomUUID();
      const childInit: RunHandleInit = {
        id: childId,
        traceId: init.traceId,
        dottedOrder: `${init.dottedOrder}.${dottedSegment(childId, childStart)}`,
      };
      send('/runs', 'POST', {
        id: childInit.id,
        trace_id: childInit.traceId,
        parent_run_id: init.id,
        dotted_order: childInit.dottedOrder,
        name,
        run_type: runType,
        start_time: childStart.toISOString(),
        inputs,
        session_name: config().project,
        tags,
      });
      return makeSpan(childInit, tags);
    },
    end({ outputs, error }) {
      if (ended) return; // a span closed twice would overwrite the real outcome
      ended = true;
      send(`/runs/${init.id}`, 'PATCH', {
        end_time: new Date().toISOString(),
        dotted_order: init.dottedOrder,
        trace_id: init.traceId,
        ...(outputs ? { outputs } : {}),
        ...(error !== undefined && error !== null ? { error: safeMessage(error) } : {}),
      });
    },
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
