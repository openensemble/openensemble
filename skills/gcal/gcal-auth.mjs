#!/usr/bin/env node
/**
 * Google Calendar OAuth setup.
 * Run once to authorize OpenEnsemble to access your Google Calendar.
 * Reuses the same OAuth credentials as Gmail (gmail-credentials.json).
 *
 * Usage: node skills/gcal/gcal-auth.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';
import { execSync } from 'child_process';

const BASE_DIR    = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CREDS_PATH  = path.join(BASE_DIR, 'gmail-credentials.json');
const TOKEN_PATH  = path.join(BASE_DIR, 'gcal-token.json');
const SCOPES      = ['https://www.googleapis.com/auth/calendar'];
const REDIRECT_URI = 'http://localhost:9876/callback';

if (!fs.existsSync(CREDS_PATH)) {
  console.error(`Credentials not found at: ${CREDS_PATH}`);
  console.error('Download OAuth credentials from Google Cloud Console and save as gmail-credentials.json');
  process.exit(1);
}

const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
const c = creds.installed || creds.web;

// Build auth URL
const params = new URLSearchParams({
  client_id:     c.client_id,
  redirect_uri:  REDIRECT_URI,
  response_type: 'code',
  scope:         SCOPES.join(' '),
  access_type:   'offline',
  prompt:        'consent',
});
const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

console.log('\nOpening browser for Google Calendar authorization...');
console.log(`\nAuth URL:\n${authUrl}\n`);

// Try to open browser
try { execSync(`xdg-open "${authUrl}" 2>/dev/null || open "${authUrl}" 2>/dev/null`, { stdio: 'ignore' }); } catch {}

// Local callback server
const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost:9876');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (error) {
      res.end(`<html><body><h2>Authorization failed: ${error}</h2></body></html>`);
      server.close();
      reject(new Error(error));
      return;
    }
    if (code) {
      res.end('<html><body><h2>Authorization successful! You can close this tab.</h2></body></html>');
      server.close();
      resolve(code);
    }
  });
  server.listen(9876, () => console.log('Waiting for authorization (listening on port 9876)...'));
  server.on('error', reject);
});

// Exchange code for tokens
const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id:     c.client_id,
    client_secret: c.client_secret,
    redirect_uri:  REDIRECT_URI,
    grant_type:    'authorization_code',
  })
});

const tokens = await tokenRes.json();
if (!tokens.access_token) {
  console.error('Token exchange failed:', JSON.stringify(tokens));
  process.exit(1);
}

tokens.expiry_date = Date.now() + (tokens.expires_in * 1000);
fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
console.log(`\nSuccess! Token saved to: ${TOKEN_PATH}`);
console.log('Google Calendar is now authorized for OpenEnsemble.');
