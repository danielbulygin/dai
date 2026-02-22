import { z } from "zod";

const envSchema = z.object({
  SLACK_BOT_TOKEN: z.string().min(1, "SLACK_BOT_TOKEN is required"),
  SLACK_APP_TOKEN: z.string().min(1, "SLACK_APP_TOKEN is required"),
  SLACK_SIGNING_SECRET: z.string().min(1, "SLACK_SIGNING_SECRET is required"),
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  SLACK_OWNER_USER_ID: z.string().min(1, "SLACK_OWNER_USER_ID is required"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  DB_PATH: z.string().default("data/dai.db"),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  console.error(parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n"));
  process.exit(1);
}

export const env: Env = parsed.data;
