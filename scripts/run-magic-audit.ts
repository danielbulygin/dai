/**
 * Run a magic audit for a client and print the report row/token.
 *
 *   pnpm exec tsx scripts/run-magic-audit.ts FPL
 */
import { runMagicAudit } from '../src/audit/magic-audit.js';

const clientCode = process.argv[2];
if (!clientCode) {
  console.error('Usage: pnpm exec tsx scripts/run-magic-audit.ts <CLIENT_CODE>');
  process.exit(1);
}

const { auditId, token } = await runMagicAudit(clientCode);
console.log(`audit_id: ${auditId}`);
console.log(`token:    ${token}`);
console.log(`(report page will live at /audit/${token} once the dashboard route ships)`);
process.exit(0);
