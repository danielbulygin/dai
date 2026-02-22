import { env } from "../../env.js";

/**
 * Check whether a Slack user ID belongs to the system owner (admin).
 * Used to gate admin-only commands and operations.
 */
export function isOwner(userId: string): boolean {
  return userId === env.SLACK_OWNER_USER_ID;
}

/**
 * Check whether a Slack message event originates from a bot.
 * Used to avoid infinite loops where the bot responds to its own messages.
 */
export function isBotMessage(event: { bot_id?: string; subtype?: string }): boolean {
  return event.bot_id !== undefined || event.subtype === "bot_message";
}
