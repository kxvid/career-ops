#!/usr/bin/env node
// One-time OAuth bootstrap for gmail-sync.mjs.
//
// Prerequisites (see GMAIL_SETUP.md for screenshots):
//   1. https://console.cloud.google.com/  -> create project
//   2. APIs & Services -> Library -> enable "Gmail API"
//   3. APIs & Services -> OAuth consent screen
//        - User Type: External
//        - Add yourself as a Test User
//        - Scope: gmail.readonly
//   4. APIs & Services -> Credentials -> Create Credentials -> OAuth client ID
//        - Application type: Desktop app
//        - Save the JSON file as: credentials.json (in this repo root)
//
// Then run:
//   node gmail-setup.mjs
//
// This script will:
//   - Read credentials.json
//   - Open your browser to authorize the Gmail readonly scope
//   - Receive the auth code on http://localhost:53682
//   - Exchange it for a refresh token
//   - Append GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN to .env

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { google } from 'googleapis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const CRED_FILE = path.join(ROOT, 'credentials.json');
const ENV_FILE = path.join(ROOT, '.env');
const REDIRECT_PORT = 53682;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

if (!fs.existsSync(CRED_FILE)) {
  console.error('credentials.json not found in repo root.');
  console.error('See GMAIL_SETUP.md for how to get it from Google Cloud Console.');
  process.exit(1);
}

const cred = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
const block = cred.installed || cred.web;
if (!block) {
  console.error('credentials.json must be a Desktop or Web OAuth client.');
  process.exit(1);
}

const { client_id, client_secret } = block;
const oauth2 = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);
const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',
});

console.log('Opening browser for Gmail authorization...');
console.log('If it doesn\'t open, paste this URL manually:');
console.log('  ' + authUrl);

const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start ""' : 'xdg-open';
exec(`${opener} "${authUrl}"`, () => {});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, REDIRECT_URI);
    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('No code in URL.');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>Authorized.</h2><p>You can close this tab and return to the terminal.</p>');

    const { tokens } = await oauth2.getToken(code);
    if (!tokens.refresh_token) {
      console.error('No refresh_token returned. Try again with prompt=consent (this script does set that).');
      console.error('If it persists, revoke the app at https://myaccount.google.com/permissions and rerun.');
      process.exit(1);
    }

    let envText = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
    const setKv = (key, val) => {
      const line = `${key}=${val}`;
      if (new RegExp(`^${key}=`, 'm').test(envText)) {
        envText = envText.replace(new RegExp(`^${key}=.*$`, 'm'), line);
      } else {
        if (envText && !envText.endsWith('\n')) envText += '\n';
        envText += line + '\n';
      }
    };
    setKv('GMAIL_CLIENT_ID', client_id);
    setKv('GMAIL_CLIENT_SECRET', client_secret);
    setKv('GMAIL_REFRESH_TOKEN', tokens.refresh_token);
    fs.writeFileSync(ENV_FILE, envText);
    fs.chmodSync(ENV_FILE, 0o600);

    console.log('--');
    console.log('Saved to .env (mode 600). Try a dry-run:');
    console.log('  node gmail-sync.mjs --dry-run');
    server.close();
    process.exit(0);
  } catch (e) {
    console.error('OAuth exchange failed:', e.message);
    process.exit(1);
  }
});

server.listen(REDIRECT_PORT, () => {
  console.log(`Listening on ${REDIRECT_URI} for the auth redirect...`);
});
