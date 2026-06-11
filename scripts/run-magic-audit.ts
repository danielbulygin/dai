/**
 * Run a magic audit for a client and print the report row/token.
 *
 *   pnpm exec tsx scripts/run-magic-audit.ts <CLIENT_CODE> \
 *     [--max-cost 10] \
 *     [--competitor "Name:pageId"]... \
 *     [--skip section_key,section_key]
 *
 * Without --competitor, the Ads Library section analyzes the client's OWN
 * public footprint (page resolved from a live ad).
 */
import { runMagicAudit } from '../src/audit/magic-audit.js';
import type { AuditOptions } from '../src/audit/magic-audit.js';

const args = process.argv.slice(2);
const clientCode = args[0];
if (!clientCode || clientCode.startsWith('--')) {
  console.error('Usage: pnpm exec tsx scripts/run-magic-audit.ts <CLIENT_CODE> [--max-cost N] [--competitor "Name:pageId"]... [--skip a,b]');
  process.exit(1);
}

const options: AuditOptions = {};
for (let i = 1; i < args.length; i++) {
  const a = args[i]!;
  if (a === '--max-cost') {
    options.maxCostUsd = Number(args[++i]);
  } else if (a === '--competitor') {
    const spec = args[++i] ?? '';
    const idx = spec.lastIndexOf(':');
    if (idx > 0) {
      options.competitorPages = options.competitorPages ?? [];
      options.competitorPages.push({ name: spec.slice(0, idx), pageId: spec.slice(idx + 1) });
    }
  } else if (a === '--skip') {
    options.skipSections = (args[++i] ?? '').split(',').filter(Boolean);
  }
}

const { auditId, token, costUsd } = await runMagicAudit(clientCode, options);
console.log(`audit_id: ${auditId}`);
console.log(`token:    ${token}`);
console.log(`cost:     $${costUsd}`);
console.log(`report:   https://bmad-lac.vercel.app/audit/${token}`);
process.exit(0);
