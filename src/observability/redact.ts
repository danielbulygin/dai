/**
 * Redaction for observability payloads.
 *
 * Everything Ada emits about a failure — the error stream, the LangSmith trace,
 * the Slack ping — passes through here first. Error text is the one place a
 * credential reliably leaks: Meta returns the access token inside the failing
 * URL, Slack echoes the bot token in an `invalid_auth` body, and a stack trace
 * happily prints whatever was in scope. An observability layer that leaks the
 * secret it was watching over is worse than no observability at all.
 *
 * Pure and dependency-free so it unit-tests without a runtime.
 */

/** Longest error text kept on an event. Beyond this the tail is dropped. */
export const MAX_MESSAGE_CHARS = 600;

/**
 * Credential shapes, by prefix, that appear in real dai error text. Matching on
 * the KNOWN shapes rather than on entropy keeps ordinary ids (campaign ids, ad
 * ids, uuids) readable — an error whose ids are redacted is not diagnosable.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Meta / Facebook access tokens
  [/\bEAA[A-Za-z0-9_-]{20,}/g, '[redacted:meta-token]'],
  // Slack tokens (bot, app, user, legacy) + signing secrets
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[redacted:slack-token]'],
  [/\bxapp-[A-Za-z0-9-]{10,}/g, '[redacted:slack-token]'],
  // Anthropic / OpenAI style keys
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted:api-key]'],
  // LangSmith
  [/\blsv2_[A-Za-z0-9_-]{16,}/g, '[redacted:langsmith-key]'],
  // Supabase / JWT-shaped tokens
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted:jwt]'],
  // A Tinkers scope claim (base64url payload "." base64url HMAC)
  [
    /\bscope_claim["'\s:=]+[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/gi,
    'scope_claim=[redacted:scope-claim]',
  ],
  // Anything carried as a query/body parameter whose NAME says secret
  [
    /\b(access_token|api[_-]?key|secret|password|authorization|bearer)["'\s]*[:=]\s*"?[A-Za-z0-9._~+/-]{8,}"?/gi,
    '$1=[redacted]',
  ],
];

/**
 * Strip known credential shapes from free text. Applied before truncation so a
 * secret can never survive by sitting past the cut and being restored later.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Redact, collapse whitespace, and cap length. The one entry point for message text. */
export function safeMessage(input: unknown, maxChars = MAX_MESSAGE_CHARS): string {
  const raw =
    input instanceof Error
      ? input.message || String(input)
      : typeof input === 'string'
        ? input
        : (() => {
            try {
              return JSON.stringify(input);
            } catch {
              return String(input);
            }
          })();
  const cleaned = redactSecrets(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars)}…[truncated, ${cleaned.length} chars]`;
}

/**
 * A coarse, greppable class for an error — what you group by when asking "what
 * is breaking for customers this week". Derived from the text because most dai
 * tools fail by RETURNING an error string rather than throwing a typed error.
 */
export function classifyError(text: string): string {
  const t = text.toLowerCase();
  if (/rate.?limit|too many requests|\b429\b|user request limit/.test(t)) return 'rate_limit';
  if (/\b(401|403)\b|unauthorized|invalid.?auth|access token|permission|oauth/.test(t))
    return 'auth';
  if (/timed? ?out|timeout|etimedout|abort/.test(t)) return 'timeout';
  if (/econnrefused|enotfound|econnreset|fetch failed|socket hang up|network/.test(t))
    return 'network';
  if (/\b(500|502|503|504)\b|internal server error|bad gateway/.test(t)) return 'upstream_5xx';
  if (/\b400\b|invalid parameter|unsupported|validation|schema|required/.test(t))
    return 'bad_request';
  if (/not found|\b404\b|does not exist/.test(t)) return 'not_found';
  if (/budget|maxturns|max_turns|exceeded/.test(t)) return 'limit_exceeded';
  return 'unknown';
}
