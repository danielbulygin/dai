/**
 * Setup script: creates client_agents table and inserts Ninepine config.
 * Usage: npx tsx scripts/setup-client-agent.ts
 */
import { createClient } from '@supabase/supabase-js';
import { WebClient } from '@slack/web-api';

const DAI_SUPABASE_URL = process.env.DAI_SUPABASE_URL;
const DAI_SUPABASE_SERVICE_KEY = process.env.DAI_SUPABASE_SERVICE_KEY;
const ADA_BOT_TOKEN = process.env.ADA_BOT_TOKEN;

if (!DAI_SUPABASE_URL || !DAI_SUPABASE_SERVICE_KEY) {
  console.error('Missing DAI_SUPABASE_URL or DAI_SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(DAI_SUPABASE_URL, DAI_SUPABASE_SERVICE_KEY);

async function findChannelByName(name: string): Promise<string | null> {
  const slack = new WebClient(ADA_BOT_TOKEN);
  let cursor: string | undefined;

  do {
    const result = await slack.conversations.list({
      types: 'public_channel,private_channel',
      limit: 200,
      cursor,
    });

    for (const ch of result.channels ?? []) {
      if (ch.name === name) return ch.id ?? null;
    }

    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return null;
}

async function main() {
  // Step 1: Create table via raw SQL (using Supabase RPC won't work, try insert)
  console.log('Step 1: Checking if client_agents table exists...');

  const { data: existing, error: checkErr } = await supabase
    .from('client_agents')
    .select('id')
    .limit(1);

  if (checkErr) {
    console.log(`Table does not exist yet (${checkErr.code}). Please create it via Supabase SQL Editor:`);
    console.log('  URL: https://supabase.com/dashboard/project/fgwzscafqolpjtmcnxhn/sql/new');
    console.log('  SQL:');
    console.log(`
CREATE TABLE IF NOT EXISTS client_agents (
  id TEXT PRIMARY KEY,
  client_code TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT 'Ada',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_agents_channel ON client_agents(channel_id) WHERE is_active;
`);
    console.log('After creating the table, run this script again.');
    process.exit(1);
  }

  console.log('  Table exists! Current rows:', existing?.length ?? 0);

  // Step 2: Find the #ninepine-internal channel
  console.log('\nStep 2: Looking up #ninepine-internal channel...');
  const channelId = await findChannelByName('ninepine-internal');

  if (!channelId) {
    console.log('  Channel #ninepine-internal not found. Trying #ninepine...');
    const altId = await findChannelByName('ninepine');
    if (altId) {
      console.log(`  Found #ninepine: ${altId}`);
      await insertConfig('ninepine', altId);
    } else {
      console.log('  No ninepine channel found. You can manually insert later.');
    }
  } else {
    console.log(`  Found #ninepine-internal: ${channelId}`);
    await insertConfig('ninepine', channelId);
  }
}

async function insertConfig(clientCode: string, channelId: string) {
  console.log(`\nStep 3: Inserting client_agents config for ${clientCode}...`);

  const { data, error } = await supabase
    .from('client_agents')
    .upsert({
      id: clientCode,
      client_code: clientCode,
      channel_id: channelId,
      display_name: 'Ninepine',
      is_active: true,
    }, { onConflict: 'id' })
    .select()
    .single();

  if (error) {
    console.error('  Failed:', error.message);
  } else {
    console.log('  Inserted:', data);
  }
}

main().catch(console.error);
