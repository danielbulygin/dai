#!/usr/bin/env tsx
/**
 * One-time Google OAuth setup script.
 * Launches a local HTTP server, opens the Google consent URL,
 * captures the auth code, and exchanges it for a refresh token.
 *
 * Usage: pnpm google:setup
 */

import http from 'node:http';
import { google } from 'googleapis';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
];

const PORT = 3000;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('Error: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',
});

console.log('\n=== Google OAuth Setup ===\n');
console.log('Open this URL in your browser:\n');
console.log(authUrl);
console.log('\nWaiting for callback on http://localhost:' + PORT + ' ...\n');

const server = http.createServer(async (req, res) => {
  if (!req.url?.startsWith('/callback')) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const code = url.searchParams.get('code');

  if (!code) {
    res.writeHead(400);
    res.end('Missing authorization code');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>Success!</h1><p>You can close this tab. Check your terminal for the refresh token.</p>');

    console.log('=== Token received ===\n');
    console.log('Add this to your .env file (use the appropriate key for your account):\n');
    console.log(`GOOGLE_REFRESH_TOKEN_WORK=${tokens.refresh_token}`);
    console.log(`GOOGLE_REFRESH_TOKEN_PERSONAL=${tokens.refresh_token}`);
    console.log(`GOOGLE_REFRESH_TOKEN_JASMIN=${tokens.refresh_token}`);
    console.log('\n(Copy the line matching the account you just authorized — WORK, PERSONAL, or JASMIN)\n');

    server.close();
    process.exit(0);
  } catch (err) {
    res.writeHead(500);
    res.end('Token exchange failed: ' + String(err));
    console.error('Token exchange failed:', err);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT);
