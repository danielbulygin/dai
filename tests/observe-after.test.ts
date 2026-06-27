import { describe, it, expect } from 'vitest';
import { detectSoftError, surfaceWriteFailure } from '../src/agents/sdk/observe-after.js';

// Observe-after is the structural fix for "streams success on a dead-end": a
// failed WRITE must reach the model as isError=true, not a narratable success.
// READ tools are untouched (an {error} in a read is data). Pure + deterministic.
describe('observe-after — surface write failures', () => {
  // The exact JVA dead-end shape: launch_ads returns the Meta SafetyError as JSON.
  const JVA_FAIL = JSON.stringify({
    error: 'SafetyError: Meta rejected LEAD on an OUTCOME_SALES campaign (error_subcode 2446814)',
  });
  const LAUNCH_OK = JSON.stringify({ batch_id: 'b_123', status: 'launched', ads: 12 });
  const UPLOAD_PARTIAL = JSON.stringify({ summary: { total: 5, failed: 2 } });

  it('THE wedge: a launch_ads soft-failure (subcode 2446814) surfaces as isError=true', () => {
    expect(surfaceWriteFailure('launch_ads', JVA_FAIL, false)).toBe(true);
  });

  it('a healthy launch_ads result stays isError=false', () => {
    expect(surfaceWriteFailure('launch_ads', LAUNCH_OK, false)).toBe(false);
  });

  it('a batch upload with summary.failed>0 surfaces as a failure', () => {
    expect(surfaceWriteFailure('upload_to_media_library', UPLOAD_PARTIAL, false)).toBe(true);
  });

  it('READ tools are NOT changed — an {error} in a read is data, not a failed action', () => {
    expect(surfaceWriteFailure('get_briefs', JVA_FAIL, false)).toBe(false);
    expect(surfaceWriteFailure('query_meta_insights', JVA_FAIL, false)).toBe(false);
  });

  it('an already-thrown error (isError=true) passes through as a failure', () => {
    expect(surfaceWriteFailure('launch_ads', LAUNCH_OK, true)).toBe(true);
    expect(surfaceWriteFailure('get_briefs', '{"error":"x"}', true)).toBe(true);
  });

  it('a non-JSON / plain-text write result is healthy', () => {
    expect(surfaceWriteFailure('launch_ads', 'Created 12 ads, paused.', false)).toBe(false);
  });

  describe('detectSoftError convention', () => {
    it('catches a truthy top-level error', () => {
      expect(detectSoftError('{"error":"boom"}')).toBe('boom');
    });
    it('catches summary.failed>0', () => {
      expect(detectSoftError('{"summary":{"failed":2,"total":5}}')).toContain('failed=2');
    });
    it('treats an empty error string as healthy', () => {
      expect(detectSoftError('{"error":""}')).toBeUndefined();
    });
    it('treats healthy JSON / plain text / empty as healthy', () => {
      expect(detectSoftError('{"status":"ok"}')).toBeUndefined();
      expect(detectSoftError('all good')).toBeUndefined();
      expect(detectSoftError('')).toBeUndefined();
    });
  });
});
