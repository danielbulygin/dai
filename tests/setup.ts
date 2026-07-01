// Set test environment variables before any module imports
process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
process.env.SLACK_APP_TOKEN = 'xapp-test-token';
process.env.SLACK_SIGNING_SECRET = 'test-signing-secret';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
process.env.SLACK_OWNER_USER_ID = 'U_TEST_OWNER';
process.env.LOG_LEVEL = 'silent';
process.env.NODE_ENV = 'test';
process.env.DB_PATH = '/tmp/dai-test.db';
// Required by src/env.ts since the Supabase migration — without these, ANY test
// that (transitively) imports the tool registry dies on env validation before
// it runs. Fake host: network calls fail fast and the fail-soft paths kick in.
process.env.DAI_SUPABASE_URL = 'http://127.0.0.1:1';
process.env.DAI_SUPABASE_SERVICE_KEY = 'test-service-key';
