import { z } from 'zod';

const envSchema = z.object({
  SLACK_BOT_TOKEN: z.string().min(1, 'SLACK_BOT_TOKEN is required'),
  SLACK_APP_TOKEN: z.string().min(1, 'SLACK_APP_TOKEN is required'),
  SLACK_SIGNING_SECRET: z.string().min(1, 'SLACK_SIGNING_SECRET is required'),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  SLACK_OWNER_USER_ID: z.string().min(1, 'SLACK_OWNER_USER_ID is required'),
  LOG_LEVEL: z
    .enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_KEY: z.string().optional(),
  DAI_SUPABASE_URL: z.string().min(1, 'DAI_SUPABASE_URL is required'),
  DAI_SUPABASE_SERVICE_KEY: z.string().min(1, 'DAI_SUPABASE_SERVICE_KEY is required'),
  FIREFLIES_API_KEY: z.string().optional(),
  NOTION_TOKEN: z.string().optional(),
  NOTION_KANBAN_DB_ID: z.string().optional(),
  SLACK_REVIEW_CHANNEL_ID: z.string().optional(),
  SLACK_USER_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

function loadEnv(): Env {
  if (_env) return _env;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    console.error('Invalid environment variables:\n' + msg);
    process.exit(1);
  }
  _env = parsed.data;
  return _env;
}

export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string) {
    return loadEnv()[prop as keyof Env];
  },
});
