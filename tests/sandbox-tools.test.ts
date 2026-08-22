import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * run_analysis_script — sandboxed compute over fetched data.
 *
 * What these tests actually protect is the containment contract, which is
 * invisible at runtime when it silently erodes:
 *
 *  - the sandbox is created with networkPolicy 'deny-all' and NO env — a
 *    credential or an open network in the create params is the whole design
 *    failing, not a config nit;
 *  - the VM is stopped even when the run throws (it bills until stopped);
 *  - the size caps refuse BEFORE a sandbox is created (no billed VM for an
 *    input that was never going to run);
 *  - missing credentials degrade with a self-describing error, never a throw;
 *  - the guard classifies the tool as a read, and the client-facing Tinkers
 *    profile does NOT carry it.
 */

const { envState } = vi.hoisted(() => ({
  envState: {
    values: {} as Record<string, string | undefined>,
  },
}));

vi.mock('../src/env.js', () => ({
  env: new Proxy(
    {},
    {
      get: (_, k) => {
        if (k in envState.values) return envState.values[k as string];
        if (k === 'LOG_LEVEL') return 'silent';
        return process.env[k as string];
      },
    },
  ),
}));

const {
  runAnalysisScript, clampTimeoutSeconds, _setSandboxFactory,
} = await import('../src/agents/tools/sandbox-tools.js');
const { decide, defaultPolicy } = await import('../src/agents/sdk/guard.js');
const { toolProfiles } = await import('../src/agents/profiles/index.js');

const CREDS = {
  VERCEL_TOKEN: 'tok_test',
  VERCEL_TEAM_ID: 'team_test',
  VERCEL_PROJECT_ID: 'prj_test',
};

interface FakeCalls {
  createParams: Record<string, unknown> | null;
  writtenFiles: Array<{ path: string; content: string | Uint8Array }>;
  runParams: Record<string, unknown> | null;
  stopped: number;
}

function installFakeSandbox(opts?: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  runThrows?: Error;
  createThrows?: Error;
}): FakeCalls {
  const calls: FakeCalls = { createParams: null, writtenFiles: [], runParams: null, stopped: 0 };
  _setSandboxFactory(async (params) => {
    if (opts?.createThrows) throw opts.createThrows;
    calls.createParams = params as unknown as Record<string, unknown>;
    return {
      async writeFiles(files) {
        calls.writtenFiles.push(...files);
      },
      async runCommand(runParams) {
        calls.runParams = runParams as unknown as Record<string, unknown>;
        if (opts?.runThrows) throw opts.runThrows;
        return {
          exitCode: opts?.exitCode ?? 0,
          stdout: async () => opts?.stdout ?? '',
          stderr: async () => opts?.stderr ?? '',
        };
      },
      async stop() {
        calls.stopped += 1;
      },
    };
  });
  return calls;
}

beforeEach(() => {
  envState.values = { ...CREDS };
});

afterEach(() => {
  _setSandboxFactory(null);
  envState.values = {};
});

describe('containment contract', () => {
  it('creates the sandbox with deny-all networking and passes NO env vars in', async () => {
    const calls = installFakeSandbox({ stdout: 'ok' });
    await runAnalysisScript({ script: 'console.log("ok")' });
    expect(calls.createParams).not.toBeNull();
    expect(calls.createParams!.networkPolicy).toBe('deny-all');
    // No credential or environment reaches the VM. The three create-call
    // fields are auth for the Vercel API, consumed by the SDK on OUR side.
    expect(calls.createParams).not.toHaveProperty('env');
    expect(calls.createParams!.runtime).toBe('node24');
  });

  it('writes the script and the input as files, runs node in that directory', async () => {
    const calls = installFakeSandbox({ stdout: '42' });
    const result = JSON.parse(await runAnalysisScript({
      script: 'console.log(6 * 7)',
      inputJson: { rows: [1, 2, 3] },
    }));
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe('42');
    const paths = calls.writtenFiles.map((f) => f.path);
    expect(paths).toContain('/tmp/analysis/script.mjs');
    expect(paths).toContain('/tmp/analysis/input.json');
    const input = calls.writtenFiles.find((f) => f.path.endsWith('input.json'));
    expect(JSON.parse(String(input!.content))).toEqual({ rows: [1, 2, 3] });
    expect(calls.runParams!.cmd).toBe('node');
    expect(calls.runParams!.args).toEqual(['script.mjs']);
    expect(calls.runParams!.cwd).toBe('/tmp/analysis');
  });

  it('stops the sandbox on success', async () => {
    const calls = installFakeSandbox({ stdout: 'ok' });
    await runAnalysisScript({ script: 'console.log(1)' });
    expect(calls.stopped).toBe(1);
  });

  it('stops the sandbox even when the run throws', async () => {
    const calls = installFakeSandbox({ runThrows: new Error('boom mid-run') });
    const result = JSON.parse(await runAnalysisScript({ script: 'console.log(1)' }));
    expect(result.error).toContain('boom mid-run');
    expect(calls.stopped).toBe(1);
  });
});

describe('degradation and refusals (all BEFORE a VM is billed)', () => {
  it('missing credentials → self-describing error, no sandbox created', async () => {
    envState.values = {};
    const calls = installFakeSandbox();
    const result = JSON.parse(await runAnalysisScript({ script: 'console.log(1)' }));
    expect(result.error).toContain('VERCEL_TOKEN');
    expect(calls.createParams).toBeNull();
  });

  it('empty script is refused', async () => {
    const result = JSON.parse(await runAnalysisScript({ script: '   ' }));
    expect(result.error).toContain('script is required');
  });

  it('oversized script is refused without creating a sandbox', async () => {
    const calls = installFakeSandbox();
    const result = JSON.parse(await runAnalysisScript({ script: 'x'.repeat(128 * 1024 + 1) }));
    expect(result.error).toContain('cap');
    expect(calls.createParams).toBeNull();
  });

  it('oversized input is refused without creating a sandbox', async () => {
    const calls = installFakeSandbox();
    const result = JSON.parse(await runAnalysisScript({
      script: 'console.log(1)',
      inputJson: { blob: 'y'.repeat(5 * 1024 * 1024) },
    }));
    expect(result.error).toContain('input_json');
    expect(calls.createParams).toBeNull();
  });

  it('unserializable input is refused', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = JSON.parse(await runAnalysisScript({
      script: 'console.log(1)',
      inputJson: circular,
    }));
    expect(result.error).toContain('not serializable');
  });

  it('sandbox create failure is returned as an error, never thrown', async () => {
    installFakeSandbox({ createThrows: new Error('quota exceeded') });
    const result = JSON.parse(await runAnalysisScript({ script: 'console.log(1)' }));
    expect(result.error).toContain('quota exceeded');
  });
});

describe('output shaping', () => {
  it('non-zero exit carries stderr and a fix-it note', async () => {
    installFakeSandbox({ exitCode: 1, stdout: '', stderr: 'ReferenceError: x is not defined' });
    const result = JSON.parse(await runAnalysisScript({ script: 'x' }));
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toContain('ReferenceError');
    expect(result.note).toContain('Non-zero exit');
  });

  it('giant stdout is truncated with a notice', async () => {
    installFakeSandbox({ stdout: 'z'.repeat(200 * 1024 + 500) });
    const result = JSON.parse(await runAnalysisScript({ script: 'console.log(1)' }));
    expect(Buffer.byteLength(result.stdout, 'utf-8')).toBeLessThanOrEqual(200 * 1024);
    expect(result.stdout_truncated).toContain('print less');
  });

  it('timeout is clamped into [5, 120] and defaults to 60', () => {
    expect(clampTimeoutSeconds(undefined)).toBe(60);
    expect(clampTimeoutSeconds('nonsense')).toBe(60);
    expect(clampTimeoutSeconds(1)).toBe(5);
    expect(clampTimeoutSeconds(900)).toBe(120);
    expect(clampTimeoutSeconds(30)).toBe(30);
  });

  it('the command timeout follows the clamped seconds', async () => {
    const calls = installFakeSandbox({ stdout: 'ok' });
    await runAnalysisScript({ script: 'console.log(1)', timeoutSeconds: 900 });
    expect(calls.runParams!.timeoutMs).toBe(120_000);
  });
});

describe('wiring (guard + profiles)', () => {
  // The guard is FAIL-CLOSED: a name missing from READ_TOOLS is denied on the
  // web-chat surface even when the profile grants it. That failure mode looks
  // like "the tool does nothing", so it is asserted here rather than discovered.
  it('the fail-closed guard classifies run_analysis_script as a read', () => {
    const d = decide('run_analysis_script', { script: 'console.log(1)' }, defaultPolicy());
    expect(d.decision).toBe('allow');
    expect(d.reason).toBe('read/analysis tool');
  });

  it('internal profiles carry it; the client-facing Tinkers profile does NOT', () => {
    expect(toolProfiles.media_buyer).toContain('run_analysis_script');
    expect(toolProfiles.full).toContain('run_analysis_script');
    expect(toolProfiles.client_media_buyer).not.toContain('run_analysis_script');
  });
});
