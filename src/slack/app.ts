import { App } from "@slack/bolt";
import { env } from "../env.js";

export const slackApp = new App({
  token: env.SLACK_BOT_TOKEN,
  appToken: env.SLACK_APP_TOKEN,
  signingSecret: env.SLACK_SIGNING_SECRET,
  socketMode: true,
});

export const jasminApp: App | null =
  env.JASMIN_BOT_TOKEN && env.JASMIN_APP_TOKEN
    ? new App({
        token: env.JASMIN_BOT_TOKEN,
        appToken: env.JASMIN_APP_TOKEN,
        socketMode: true,
      })
    : null;
