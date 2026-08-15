/**
 * The Ada error stream — one structured event per thing that went wrong in a
 * customer-facing run.
 *
 * Matrinova churned because Ada narrated a campaign-create that never happened
 * and NOBODY SAW THE ERROR. The tool failed, the failure was swallowed into a
 * result string, and the only trace of it was a `piper_actions` row nobody
 * queries. This module is the answer to the second half of that sentence: every
 * tool failure, upstream API error and write-verification miss in a scoped run
 * lands in one append-only stream, and — when it is a customer's run — pings a
 * founder in Slack.
 *
 * Design constraints, all load-bearing:
 *   - NEVER throws, never blocks, never fails a run. Emission is fire-and-forget;
 *     a broken log must not become a broken Ada.
 *   - Zero new dependencies. The droplet's fast path (`git pull && pnpm build &&
 *     systemctl restart`) skips `pnpm install`, so a new runtime dep would be a
 *     module-not-found on restart.
 *   - Every message passes through `safeMessage` — no tokens, no claims, no keys.
 *   - Slack pings are throttled per (client, tool, class); a tool failing in a
 *     retry loop must not bury the channel it is supposed to alert.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { logger } from '../utils/logger.js';
import { classifyError, safeMessage } from './redact.js';

/** Which customer-facing surface the run came in on. */
export type ErrorSurface =
  | 'chat'
  | 'chat-scoped'
  | 'assist'
  | 'diagnose'
  | 'execute-action'
  | 'slack'
  | 'unknown';

/** What kind of thing went wrong. The first axis you group the stream by. */
export type ErrorKind =
  | 'tool_failure'
  /** A write tool reported failure INSIDE a successful-looking result — the Matrinova shape. */
  | 'silent_write_failure'
  /** The run ended with a non-success SDK subtype (budget, turns, died stream). */
  | 'run_failed'
  /** An exception escaped the request handler. */
  | 'handler_exception'
  /** An upstream API (Meta Graph, Notion, Slack) returned an error. */
  | 'api_error'
  /** A write executed but the read-back did not confirm the intended state. */
  | 'verification_miss'
  /** The Governor or the guard refused a write. Expected behavior — recorded, never paged. */
  | 'refusal';

export interface AdaErrorEvent {
  /** ISO-8601, always UTC. */
  ts: string;
  kind: ErrorKind;
  surface: ErrorSurface;
  /** Correlates every event, log line and LangSmith trace from one request. */
  run_id: string;
  /** The customer this run belongs to. Null for internal/team runs. */
  client_code: string | null;
  session_id: string | null;
  user_id: string | null;
  tool_name: string | null;
  error_class: string;
  /** Redacted and truncated. Never raw upstream text. */
  message: string;
  /** Small, non-sensitive extras (ids, counts, statuses). */
  detail?: Record<string, unknown>;
}

export interface EmitErrorInput {
  kind: ErrorKind;
  surface: ErrorSurface;
  runId: string;
  clientCode?: string | null;
  sessionId?: string | null;
  userId?: string | null;
  toolName?: string | null;
  /** Raw error text or Error — redacted here, so callers never pre-sanitize. */
  error: unknown;
  /** Override the derived class when the caller knows better. */
  errorClass?: string;
  detail?: Record<string, unknown>;
}

/** Where the JSONL stream lands. `data/` is gitignored; systemd may point this at /var/log. */
function logPath(): string {
  return resolve(process.env.ADA_ERROR_LOG_PATH ?? 'data/ada-errors.jsonl');
}

/** Kinds that are real failures rather than the system correctly saying no. */
function isPageworthy(kind: ErrorKind): boolean {
  return kind !== 'refusal';
}

export function buildErrorEvent(input: EmitErrorInput): AdaErrorEvent {
  const message = safeMessage(input.error);
  return {
    ts: new Date().toISOString(),
    kind: input.kind,
    surface: input.surface,
    run_id: input.runId,
    client_code: input.clientCode ? input.clientCode.toUpperCase() : null,
    session_id: input.sessionId ?? null,
    user_id: input.userId ?? null,
    tool_name: input.toolName ?? null,
    error_class: input.errorClass ?? classifyError(message),
    message,
    ...(input.detail ? { detail: input.detail } : {}),
  };
}

/**
 * Record an error event. Fire-and-forget: returns immediately, and every sink
 * failure is swallowed into a warn so observability can never take Ada down.
 */
export function emitErrorEvent(input: EmitErrorInput): AdaErrorEvent {
  const event = buildErrorEvent(input);

  // journalctl is the sink that always works, even when the disk sink or Slack
  // is misconfigured — so it gets the event first and unconditionally.
  logger.error(
    {
      kind: event.kind,
      surface: event.surface,
      runId: event.run_id,
      clientCode: event.client_code,
      tool: event.tool_name,
      errorClass: event.error_class,
    },
    `ada-error: ${event.kind} ${event.tool_name ?? event.surface} — ${event.message}`,
  );

  void appendEvent(event).catch((err) => {
    logger.warn(
      { err: (err as Error).message },
      'ada-error: JSONL append failed (event kept in journal)',
    );
  });

  if (isPageworthy(event.kind) && event.client_code) {
    void pingFounders(event).catch((err) => {
      logger.warn({ err: (err as Error).message }, 'ada-error: Slack ping failed');
    });
  }

  return event;
}

async function appendEvent(event: AdaErrorEvent): Promise<void> {
  const path = logPath();
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
}

// --- Slack ping -------------------------------------------------------------

/**
 * Posted over raw `fetch` against the Web API rather than through dai's Bolt
 * app: ada-console-assist is its own systemd unit with no Slack listener, and
 * constructing a Bolt client there would open a socket connection to serve one
 * message.
 */
const SLACK_POST_URL = 'https://slack.com/api/chat.postMessage';

/** Per-signature cooldown. A tool failing in a loop pings once, not fifty times. */
const PING_COOLDOWN_MS = Number(process.env.ADA_ERROR_PING_COOLDOWN_MS ?? 10 * 60 * 1000);
const lastPingAt = new Map<string, number>();

/** Exported for tests — the throttle is per-process state. */
export function resetPingThrottle(): void {
  lastPingAt.clear();
}

function shouldPing(event: AdaErrorEvent, now: number): boolean {
  const signature = `${event.client_code}:${event.tool_name ?? event.surface}:${event.error_class}:${event.kind}`;
  const previous = lastPingAt.get(signature);
  if (previous !== undefined && now - previous < PING_COOLDOWN_MS) return false;
  lastPingAt.set(signature, now);
  return true;
}

function formatPing(event: AdaErrorEvent): string {
  const lines = [
    `:rotating_light: *Ada error — ${event.client_code}*`,
    `*${event.kind}*${event.tool_name ? ` in \`${event.tool_name}\`` : ''} (${event.error_class}) on \`${event.surface}\``,
    `> ${event.message}`,
    `run \`${event.run_id}\`${event.session_id ? ` · session \`${event.session_id}\`` : ''}`,
  ];
  if (event.kind === 'silent_write_failure') {
    lines.splice(
      1,
      0,
      '_A write failed but the model was not told — Ada may narrate this as done._',
    );
  }
  return lines.join('\n');
}

async function pingFounders(event: AdaErrorEvent): Promise<void> {
  const token = process.env.ADA_ERROR_SLACK_BOT_TOKEN || process.env.SLACK_BOT_TOKEN;
  const channel = process.env.ADA_ERROR_SLACK_CHANNEL;
  if (!token || !channel) return; // unset = feature off, silently
  if (!shouldPing(event, Date.now())) return;

  const res = await fetch(SLACK_POST_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      channel,
      text: formatPing(event),
      unfurl_links: false,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
  };
  if (!body.ok) {
    throw new Error(`slack chat.postMessage failed: ${body.error ?? res.status}`);
  }
}
