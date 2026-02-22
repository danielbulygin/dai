import { App } from "@slack/bolt";
import { env } from "../env.js";

export const slackApp = new App({
  token: env.SLACK_BOT_TOKEN,
  appToken: env.SLACK_APP_TOKEN,
  signingSecret: env.SLACK_SIGNING_SECRET,
  socketMode: true,
});
