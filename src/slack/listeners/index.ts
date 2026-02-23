import type { App } from "@slack/bolt";
import { registerMentionListener } from "./mentions.js";
import { registerMessageListener } from "./messages.js";
import { registerReactionListener } from "./reactions.js";
import { registerCommandListener } from "./commands.js";
import { registerChannelMonitor } from "./channel-monitor.js";

export function registerAllListeners(app: App): void {
  registerMentionListener(app);
  registerMessageListener(app);
  registerReactionListener(app);
  registerCommandListener(app);
  registerChannelMonitor(app);
}
