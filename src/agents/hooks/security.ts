import { logger } from "../../utils/logger.js";

export interface SecurityCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Dangerous shell patterns that should never be executed.
 * Each entry is a regex paired with a human-readable description.
 */
const DANGEROUS_COMMANDS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+.*\/|.*-rf\s)/, reason: "Destructive rm -rf command" },
  { pattern: /\bDROP\s+TABLE\b/i, reason: "DROP TABLE is not allowed" },
  { pattern: /\bDELETE\s+FROM\s+\S+\s*(?:;|$)/i, reason: "DELETE FROM without WHERE clause is not allowed" },
  { pattern: /\bformat\s+[a-zA-Z]:/i, reason: "Disk format command is not allowed" },
  { pattern: /\bmkfs\b/, reason: "mkfs (filesystem creation) is not allowed" },
  { pattern: /\bdd\s+.*\bof=/, reason: "dd with output file is not allowed" },
];

/**
 * Filesystem paths that should never be accessed via shell commands.
 */
const BLOCKED_PATHS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\/etc\/passwd/, reason: "Access to /etc/passwd is blocked" },
  { pattern: /\/etc\/shadow/, reason: "Access to /etc/shadow is blocked" },
  { pattern: /~\/\.ssh|\/\.ssh/, reason: "Access to ~/.ssh is blocked" },
];

/**
 * Git push patterns that are too dangerous to allow.
 */
const DANGEROUS_GIT: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\bgit\s+push\s+.*--force\b.*\b(main|master)\b/,
    reason: "Force push to main/master is not allowed",
  },
  {
    pattern: /\bgit\s+push\s+.*\b(main|master)\b.*--force\b/,
    reason: "Force push to main/master is not allowed",
  },
];

/**
 * Check whether a tool invocation is safe to execute.
 *
 * For Bash tools, inspects the `command` field against a set of known
 * dangerous patterns (destructive shell commands, sensitive file access,
 * force-push to protected branches). All other tools are allowed by default.
 */
export function checkToolSafety(
  toolName: string,
  input: Record<string, unknown>,
): SecurityCheckResult {
  // Only inspect Bash commands for now
  if (toolName !== "Bash") {
    return { allowed: true };
  }

  const command = input["command"];
  if (typeof command !== "string") {
    return { allowed: true };
  }

  // Check dangerous shell commands
  for (const { pattern, reason } of DANGEROUS_COMMANDS) {
    if (pattern.test(command)) {
      logger.warn({ toolName, command, reason }, "Blocked dangerous command");
      return { allowed: false, reason };
    }
  }

  // Check blocked filesystem paths
  for (const { pattern, reason } of BLOCKED_PATHS) {
    if (pattern.test(command)) {
      logger.warn({ toolName, command, reason }, "Blocked access to sensitive path");
      return { allowed: false, reason };
    }
  }

  // Check dangerous git operations
  for (const { pattern, reason } of DANGEROUS_GIT) {
    if (pattern.test(command)) {
      logger.warn({ toolName, command, reason }, "Blocked dangerous git operation");
      return { allowed: false, reason };
    }
  }

  return { allowed: true };
}
