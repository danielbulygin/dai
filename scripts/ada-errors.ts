/**
 * ada-errors — read the Ada error stream.
 *
 * The JSONL stream (src/observability/error-events.ts) is only useful if asking
 * "what broke for customers today?" is one command. On the droplet:
 *
 *   cd /root/dai && pnpm exec tsx scripts/ada-errors.ts --since 24h
 *   pnpm exec tsx scripts/ada-errors.ts --client MTN --kind silent_write_failure
 *   pnpm exec tsx scripts/ada-errors.ts --summary --since 7d
 *
 * Read-only. Never writes, never calls a service.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AdaErrorEvent } from '../src/observability/error-events.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

/** "24h" / "7d" / "90m" → milliseconds. */
function parseSince(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(\d+)([mhd])$/.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n * (m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000);
}

async function main(): Promise<void> {
  const path = resolve(process.env.ADA_ERROR_LOG_PATH ?? 'data/ada-errors.jsonl');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    console.log(`No error stream at ${path} — either nothing has failed yet, or the service has not run since this shipped.`);
    return;
  }

  const sinceMs = parseSince(arg('since'));
  const cutoff = sinceMs ? Date.now() - sinceMs : 0;
  const client = arg('client')?.toUpperCase();
  const kind = arg('kind');
  const tool = arg('tool');
  const limit = Number(arg('limit') ?? 50);

  const events = raw
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line) as AdaErrorEvent]; } catch { return []; }
    })
    .filter((e) => Date.parse(e.ts) >= cutoff)
    .filter((e) => !client || e.client_code === client)
    .filter((e) => !kind || e.kind === kind)
    .filter((e) => !tool || e.tool_name === tool);

  if (!events.length) {
    console.log('No matching error events.');
    return;
  }

  if (flag('summary')) {
    const counts = new Map<string, number>();
    for (const e of events) {
      const key = `${e.client_code ?? 'internal'} · ${e.kind} · ${e.tool_name ?? e.surface} · ${e.error_class}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    console.log(`${events.length} events\n`);
    for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1])) {
      console.log(`${String(count).padStart(5)}  ${key}`);
    }
    return;
  }

  for (const e of events.slice(-limit)) {
    console.log(
      `${e.ts}  ${(e.client_code ?? 'internal').padEnd(10)} ${e.kind.padEnd(21)} ${(e.tool_name ?? e.surface).padEnd(26)} ${e.error_class}\n    ${e.message}\n    run=${e.run_id}${e.session_id ? ` session=${e.session_id}` : ''}`,
    );
  }
  console.log(`\n${events.length} events (showing last ${Math.min(limit, events.length)}) from ${path}`);
}

void main();
