/**
 * The constitution — the six operating principles every agent runs by, loaded
 * once at startup and prepended to EVERY agent's system prompt (both prompt
 * paths: runner.ts buildSystemBlocks Block 1 and runAgentSDK.ts
 * buildSystemPrompt — Ada's SDK loop does NOT pass through buildSystemBlocks,
 * so wiring only the runner would silently skip her).
 *
 * Source file: agents/_constitution.md (dai copy; canonical text lives in the
 * bmad repo, docs/agent-memory-system/agent-operating-principles.md).
 * Per-agent opt-out: `constitution: false` in the agent's agent.yaml
 * (default ON via the registry schema).
 *
 * Fail-soft by design: a missing file must never take an agent down — but the
 * Ada-load verify gate (a real run's composed prompt contains "Ask, don't
 * assume") catches a silent miss before it ships.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let cached: string | null | undefined;

/** The constitution text (leading source-pointer comment stripped), or '' if missing. */
export function getConstitution(): string {
  if (cached !== undefined) return cached ?? '';
  try {
    const raw = readFileSync(join(process.cwd(), 'agents', '_constitution.md'), 'utf-8');
    // Strip the leading HTML source-pointer comment — it's for humans editing
    // the file, not for every agent's context window.
    cached = raw.replace(/^\s*<!--[\s\S]*?-->\s*/, '').trim();
  } catch {
    cached = null;
    try { console.warn('[constitution] agents/_constitution.md not found — agents are running WITHOUT the operating principles'); } catch { /* noop */ }
  }
  return cached ?? '';
}

/** For tests: force a re-read. */
export function resetConstitutionCache(): void {
  cached = undefined;
}
