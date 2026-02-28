import type { App } from "@slack/bolt";
import { logger } from "../../utils/logger.js";
import { addFeedback } from "../../memory/feedback.js";

/**
 * Register the `/dai` slash command and its subcommands.
 *
 * Subcommands:
 *   help      — Show available agents and commands
 *   feedback  — Submit explicit text feedback
 *   status    — Show system status
 *   agents    — List available agents
 */
export function registerCommandListener(app: App): void {
  app.command("/dai", async ({ command, ack, respond }) => {
    await ack();

    const rawText = command.text.trim();
    const spaceIdx = rawText.indexOf(" ");
    const subcommand = spaceIdx === -1 ? rawText : rawText.slice(0, spaceIdx);
    const args = spaceIdx === -1 ? "" : rawText.slice(spaceIdx + 1).trim();

    logger.info(
      { user: command.user_id, subcommand, args },
      "Received /dai command",
    );

    try {
      switch (subcommand.toLowerCase()) {
        case "help":
        case "": {
          await respond({
            response_type: "ephemeral",
            text: [
              "*DAI — Daniel's AI Multi-Agent System*",
              "",
              "*Available Commands:*",
              "`/dai help` — Show this help message",
              "`/dai feedback <text>` — Submit feedback about the system",
              "`/dai status` — Show system status",
              "`/dai agents` — List available agents",
              "",
              "*Agents:*",
              "• *Otto* — Orchestrator: routes requests to the right agent",
              "• *Coda* — Developer: writes and reviews code",
              "• *Rex* — Researcher: finds information and answers questions",
              "• *Sage* — Reviewer: reviews work and provides feedback",
              "",
              "Mention me in a channel or send me a DM to get started!",
            ].join("\n"),
          });
          break;
        }

        case "feedback": {
          if (!args) {
            await respond({
              response_type: "ephemeral",
              text: "Please provide feedback text: `/dai feedback <your feedback here>`",
            });
            break;
          }

          await addFeedback({
            agent_id: "system",
            user_id: command.user_id,
            type: "explicit",
            sentiment: "neutral",
            content: args,
          });

          await respond({
            response_type: "ephemeral",
            text: "Thank you for your feedback! It has been recorded and will help improve the system.",
          });

          logger.info(
            { user: command.user_id, feedback: args },
            "Explicit feedback submitted via /dai command",
          );
          break;
        }

        case "status": {
          // TODO: Pull real counts from the database once status queries are available
          await respond({
            response_type: "ephemeral",
            text: [
              "*DAI System Status*",
              "",
              "• *Status:* Online",
              "• *Agents:* 4 (Otto, Coda, Rex, Sage)",
              "• *Active Sessions:* —",
              "",
              "_Detailed metrics coming soon._",
            ].join("\n"),
          });
          break;
        }

        case "agents": {
          await respond({
            response_type: "ephemeral",
            text: [
              "*Available Agents:*",
              "",
              "• *Otto* (orchestrator) — Routes requests to the best agent for the job",
              "• *Coda* (developer) — Writes, reviews, and debugs code",
              "• *Rex* (researcher) — Searches the web and finds information",
              "• *Sage* (reviewer) — Reviews work and provides structured feedback",
            ].join("\n"),
          });
          break;
        }

        default: {
          await respond({
            response_type: "ephemeral",
            text: `Unknown subcommand: \`${subcommand}\`. Run \`/dai help\` to see available commands.`,
          });
        }
      }
    } catch (err) {
      logger.error({ err, command: command.text, user: command.user_id }, "Error handling /dai command");
      await respond({
        response_type: "ephemeral",
        text: "Something went wrong processing your command. Please try again.",
      });
    }
  });
}
