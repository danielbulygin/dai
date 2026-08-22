import { Sandbox } from '@vercel/sandbox';
import { env } from '../../env.js';
import { logger } from '../../utils/logger.js';

/**
 * Sandboxed script execution — the COMPUTE half of the investigation surface
 * (capability 1 of project_ada_web_capability_gap.md; the read half shipped as
 * meta_graph_get / look_at_media / read_repo_file / grep_repo).
 *
 * The gap this closes: the decisive middle step of a real investigation is
 * usually a throwaway computation over fetched data — "compute the max
 * discount across 171 catalog products", "join these two ID lists", "which of
 * these 54 ads is in neither set". A language model doing that arithmetic
 * in-context is exactly where it quietly gets numbers wrong; a script is
 * exact. The terminal session this design copies wrote ~15 such scripts in
 * one day (Dan approved this build 2026-08-23).
 *
 * Containment is structural, not behavioural — three independent walls:
 *   1. NO CREDENTIALS ENTER THE SANDBOX. Ada's authenticated tools fetch the
 *      data first; it goes in as a plain file. There is no token, no key, no
 *      connection string inside the VM to steal or misuse.
 *   2. networkPolicy 'deny-all': the VM has NO internet egress. The script
 *      cannot call Meta, Supabase, or anything else — data in via writeFiles,
 *      results out via stdout, nothing in between.
 *   3. The VM is ephemeral (Firecracker microVM) and always stopped in a
 *      finally block; a runaway script is killed by the exec-time timeout.
 *
 * House style: every failure is RETURNED as {"error": ...} JSON, never thrown.
 */

/** The model's script. Big enough for any honest analysis, small enough to read. */
const SCRIPT_CAP_BYTES = 128 * 1024;
/** Serialized input data ceiling — matches the Graph response cap's order of magnitude. */
const INPUT_CAP_BYTES = 5 * 1024 * 1024;
/** Stdout returned to the model. Past this it is truncated with a notice. */
const STDOUT_CAP_BYTES = 200 * 1024;
/** Stderr is diagnostics, not results — keep it tight. */
const STDERR_CAP_BYTES = 16 * 1024;

const DEFAULT_TIMEOUT_S = 60;
const MIN_TIMEOUT_S = 5;
const MAX_TIMEOUT_S = 120;
/** VM lifetime = script timeout + fixed grace for boot/write/teardown. */
const SANDBOX_GRACE_MS = 60_000;

const WORKDIR = '/tmp/analysis';

/** Structural view of the SDK surface we use — lets tests inject a fake. */
export interface SandboxLike {
  writeFiles(files: Array<{ path: string; content: string | Uint8Array }>): Promise<void>;
  runCommand(params: {
    cmd: string;
    args?: string[];
    cwd?: string;
    timeoutMs?: number;
  }): Promise<{
    exitCode: number;
    stdout(): Promise<string>;
    stderr(): Promise<string>;
  }>;
  stop(): Promise<unknown>;
}

export type SandboxFactory = (params: {
  token: string;
  teamId: string;
  projectId: string;
  runtime: 'node24';
  timeout: number;
  networkPolicy: 'deny-all';
}) => Promise<SandboxLike>;

let sandboxFactory: SandboxFactory = (params) =>
  Sandbox.create(params) as unknown as Promise<SandboxLike>;

/** Test seam. Production never calls this. */
export function _setSandboxFactory(factory: SandboxFactory | null): void {
  sandboxFactory = factory ?? ((params) => Sandbox.create(params) as unknown as Promise<SandboxLike>);
}

interface SandboxCredentials {
  token: string;
  teamId: string;
  projectId: string;
}

function sandboxCredentials(): SandboxCredentials | null {
  const e = env as unknown as Record<string, string | undefined>;
  const token = e.VERCEL_TOKEN;
  const teamId = e.VERCEL_TEAM_ID;
  const projectId = e.VERCEL_PROJECT_ID;
  if (!token || !teamId || !projectId) return null;
  return { token, teamId, projectId };
}

function truncate(text: string, capBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.byteLength <= capBytes) return { text, truncated: false };
  return { text: buf.subarray(0, capBytes).toString('utf-8'), truncated: true };
}

export function clampTimeoutSeconds(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT_S;
  return Math.min(MAX_TIMEOUT_S, Math.max(MIN_TIMEOUT_S, Math.round(n)));
}

export async function runAnalysisScript(args: {
  script: string;
  inputJson?: unknown;
  timeoutSeconds?: number;
}): Promise<string> {
  try {
    const script = String(args.script ?? '');
    if (!script.trim()) {
      return JSON.stringify({
        error: 'script is required — plain Node.js (ESM). Read ./input.json for the data, print results to stdout.',
      });
    }
    if (Buffer.byteLength(script, 'utf-8') > SCRIPT_CAP_BYTES) {
      return JSON.stringify({
        error: `Script is over the ${SCRIPT_CAP_BYTES}-byte cap. An analysis script this long is a smell — split the question.`,
      });
    }

    let inputSerialized = 'null';
    if (args.inputJson !== undefined) {
      try {
        inputSerialized = JSON.stringify(args.inputJson) ?? 'null';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: `input_json is not serializable: ${msg}` });
      }
      if (Buffer.byteLength(inputSerialized, 'utf-8') > INPUT_CAP_BYTES) {
        return JSON.stringify({
          error: `input_json serializes to more than ${INPUT_CAP_BYTES} bytes. Pass only the fields the computation needs.`,
        });
      }
    }

    const credentials = sandboxCredentials();
    if (!credentials) {
      return JSON.stringify({
        error:
          'Sandbox credentials are not configured (VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID). ' +
          'Set them in the dai env (droplet /root/dai/.env) and restart — until then, script execution is unavailable.',
      });
    }

    const timeoutS = clampTimeoutSeconds(args.timeoutSeconds);

    let sandbox: SandboxLike;
    try {
      sandbox = await sandboxFactory({
        ...credentials,
        runtime: 'node24',
        timeout: timeoutS * 1000 + SANDBOX_GRACE_MS,
        // No internet egress, ever. Combined with "no credentials go in",
        // the script can only compute over what it was handed.
        networkPolicy: 'deny-all',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ error: msg }, 'run_analysis_script: sandbox create failed');
      return JSON.stringify({ error: `Could not start the sandbox: ${msg}` });
    }

    const startedAt = Date.now();
    try {
      await sandbox.writeFiles([
        { path: `${WORKDIR}/script.mjs`, content: script },
        { path: `${WORKDIR}/input.json`, content: inputSerialized },
      ]);

      const finished = await sandbox.runCommand({
        cmd: 'node',
        args: ['script.mjs'],
        cwd: WORKDIR,
        timeoutMs: timeoutS * 1000,
      });

      const [stdoutRaw, stderrRaw] = await Promise.all([finished.stdout(), finished.stderr()]);
      const stdout = truncate(stdoutRaw, STDOUT_CAP_BYTES);
      const stderr = truncate(stderrRaw, STDERR_CAP_BYTES);

      const out: Record<string, unknown> = {
        exit_code: finished.exitCode,
        duration_ms: Date.now() - startedAt,
        stdout: stdout.text,
      };
      if (stdout.truncated) out.stdout_truncated = `stdout exceeded ${STDOUT_CAP_BYTES} bytes — print less, aggregate more.`;
      if (stderr.text) out.stderr = stderr.text;
      if (stderr.truncated) out.stderr_truncated = true;
      if (finished.exitCode !== 0) {
        out.note = 'Non-zero exit code — the script failed; read stderr, fix the script, and run it again.';
      }
      return JSON.stringify(out);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ error: msg }, 'run_analysis_script: execution failed');
      return JSON.stringify({ error: `Sandbox execution failed: ${msg}` });
    } finally {
      // The VM must die even when the run throws — it bills until stopped.
      await sandbox.stop().catch((err) => {
        logger.warn({ err }, 'run_analysis_script: sandbox stop failed (will auto-expire on its timeout)');
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, 'runAnalysisScript failed');
    return JSON.stringify({ error: msg });
  }
}
