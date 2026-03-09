/**
 * Run a migration against DAI Supabase.
 * Usage: pnpm tsx scripts/run-migration.ts
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const url = process.env.DAI_SUPABASE_URL;
const key = process.env.DAI_SUPABASE_SERVICE_KEY;

if (url === undefined || key === undefined) {
  console.error('Missing DAI_SUPABASE_URL or DAI_SUPABASE_SERVICE_KEY');
  process.exit(1);
}

const supabase = createClient(url, key);

async function main(): Promise<void> {
  // Check if table already exists
  const { error: checkError } = await supabase
    .from('client_reports')
    .select('id')
    .limit(1);

  if (checkError === null) {
    console.log('Table client_reports already exists — migration already applied.');
    return;
  }

  if (checkError.message.includes('does not exist') || checkError.message.includes('Could not find') || checkError.code === '42P01') {
    console.log('Table client_reports does not exist. Please run this SQL in the Supabase SQL Editor:\n');
    const sql = readFileSync('supabase/migrations/20260309000000_client_reports.sql', 'utf-8');
    console.log(sql);
    console.log('\nURL: https://supabase.com/dashboard/project/fgwzscafqolpjtmcnxhn/sql/new');
  } else {
    console.error('Unexpected error:', checkError.message);
  }
}

main().catch(console.error);
