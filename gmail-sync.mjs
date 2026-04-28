#!/usr/bin/env node
// Gmail → applications.md sync.
// Polls Gmail with the OAuth refresh token in .env, matches recruiter
// emails to companies in data/applications.md, and updates status.
//
// Usage:
//   node gmail-sync.mjs                    # default: poll last 14 days, write changes
//   node gmail-sync.mjs --dry-run          # show what would change, don't write
//   node gmail-sync.mjs --since=2026-04-01 # absolute date floor
//   node gmail-sync.mjs --days=30          # relative (default 14)
//
// First-time setup: see GMAIL_SETUP.md

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const ROOT = __dirname;
const APPS_FILE = path.join(ROOT, 'data/applications.md');
const STATE_FILE = path.join(ROOT, 'data/gmail-state.json');
const EVENTS_FILE = path.join(ROOT, 'data/gmail-events.tsv');

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const DRY_RUN = !!args['dry-run'];
const DAYS = Number(args.days || 14);
const SINCE = args.since;

// -- Status hierarchy --------------------------------------------------------
const ORDER = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer'];
const TERMINAL = new Set(['Rejected', 'Discarded', 'SKIP']);

function statusRank(s) {
  const i = ORDER.indexOf(s);
  return i >= 0 ? i : -1;
}

// Decide the new status given (current, candidate). Conservative: never
// downgrade in ORDER. Rejected always wins (terminal). Discarded/SKIP locked.
function transition(current, candidate) {
  if (TERMINAL.has(current)) return current;
  if (candidate === 'Rejected') return 'Rejected';
  if (TERMINAL.has(candidate)) return current;
  const a = statusRank(current);
  const b = statusRank(candidate);
  if (b > a) return candidate;
  return current;
}

// -- Email classifier --------------------------------------------------------
const PATTERNS = [
  // Rejected first (specific signal beats generic confirmations)
  { status: 'Rejected', re: /\b(not moving forward|will not be moving|decided to (?:move forward with )?other(?:wise)? (?:candidates|applicants)|pursue other candidates|after careful (?:review|consideration).*?(?:we|unfortunately|regret)|regret to inform|unable to (?:move forward|advance|offer)|not selected|no longer (?:under consideration|considered)|position has been (?:filled|closed)|wish you (?:the best|success).*?future|other applicants whose|will not be (?:advancing|continuing))\b/i },

  { status: 'Offer', re: /\b(offer of employment|offer letter|formal offer|extending an offer|verbal offer|compensation package|signing bonus|start(?:ing)? (?:date|salary)|welcome to the team|we'?re excited to (?:offer|extend))\b/i },

  { status: 'Interview', re: /\b(technical interview|onsite (?:interview|round)|panel interview|virtual onsite|coding (?:assessment|interview|challenge)|take[- ]home (?:assignment|test)|hiring manager (?:interview|round|chat)|loop interview|final round|next round|interview (?:invitation|invite|request)|coderpad|hackerrank|codility)\b/i },

  { status: 'Responded', re: /\b(would like to (?:schedule|set up|chat|connect|talk)|interested in (?:speaking|chatting|learning more)|phone screen|recruiter (?:screen|call|chat)|initial (?:conversation|call|chat)|brief (?:chat|call)|15[- ]minute|30[- ]minute|find a time|schedul(?:e|ing) a call|are you available|let'?s (?:set up|connect|chat)|meet to discuss)\b/i },

  { status: 'Applied', re: /\b(thank(?:s)? for (?:applying|your application|your interest)|received your application|application (?:received|submitted|confirmation)|we'?ve received|your application (?:to|for)|application for the .* position)\b/i },
];

function classify(subject, snippet, fromAddr) {
  const hay = [subject, snippet, fromAddr].filter(Boolean).join(' \n ');
  for (const p of PATTERNS) {
    if (p.re.test(hay)) return p.status;
  }
  return null;
}

// -- Company matcher ---------------------------------------------------------
function normalizeCo(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[,.]/g, '')
    .replace(/\b(inc|llc|llp|corp|corporation|ltd|limited|co|company)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function domainOf(addr) {
  const m = String(addr || '').match(/@([^>\s]+)/);
  if (!m) return '';
  return m[1].toLowerCase().replace(/\.(com|io|co|ai|net|org|app|dev)$/, '');
}

function matchCompany(apps, subject, fromAddr) {
  const subjectLow = (subject || '').toLowerCase();
  const dom = domainOf(fromAddr);
  let best = null;
  let bestScore = 0;
  for (const app of apps) {
    const co = normalizeCo(app.company);
    if (!co) continue;
    let score = 0;
    if (subjectLow.includes(co)) score += 3;
    if (dom && (dom.includes(co) || co.includes(dom))) score += 4;
    // Single-word brands occasionally collide; require length >= 3.
    if (co.length < 3) score = 0;
    if (score > bestScore) { best = app; bestScore = score; }
  }
  return best;
}

// -- Applications.md parser/writer ------------------------------------------
function readApps() {
  if (!fs.existsSync(APPS_FILE)) return { rows: [], lines: [] };
  const text = fs.readFileSync(APPS_FILE, 'utf8');
  const lines = text.split('\n');
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith('|')) continue;
    if (t.startsWith('| #') || /^\|[\s\-:|]+\|$/.test(t)) continue;
    const cells = t.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 9) continue;
    if (cells[0] === '#') continue;
    rows.push({
      lineIndex: i,
      num: cells[0], date: cells[1], company: cells[2], role: cells[3],
      score: cells[4], status: cells[5], pdf: cells[6], report: cells[7], notes: cells[8],
    });
  }
  return { rows, lines };
}

function writeApps(rows, lines) {
  for (const r of rows) {
    if (!r._dirty) continue;
    lines[r.lineIndex] = `| ${r.num} | ${r.date} | ${r.company} | ${r.role} | ${r.score} | ${r.status} | ${r.pdf} | ${r.report} | ${r.notes} |`;
  }
  fs.writeFileSync(APPS_FILE, lines.join('\n'));
}

// -- State + events ---------------------------------------------------------
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function appendEvent(evt) {
  fs.mkdirSync(path.dirname(EVENTS_FILE), { recursive: true });
  if (!fs.existsSync(EVENTS_FILE)) {
    fs.writeFileSync(EVENTS_FILE, 'ts\tcompany\trole\tfrom\tsubject\tdetected\told_status\tnew_status\taction\n');
  }
  const row = [
    evt.ts, evt.company || '', evt.role || '', evt.from || '',
    (evt.subject || '').replace(/\t/g, ' '),
    evt.detected || '', evt.old_status || '', evt.new_status || '', evt.action || '',
  ].join('\t');
  fs.appendFileSync(EVENTS_FILE, row + '\n');
}

// -- Gmail client -----------------------------------------------------------
function getGmail() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    console.error('Missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN.');
    console.error('Run: node gmail-setup.mjs   (see GMAIL_SETUP.md)');
    process.exit(1);
  }
  const oauth2 = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, 'http://localhost:53682');
  oauth2.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: oauth2 });
}

function gmailQueryDate() {
  if (SINCE) return SINCE.replace(/-/g, '/');
  const d = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

async function listMessages(gmail) {
  const after = gmailQueryDate();
  // Cast a wide net; classify locally.
  const q = `after:${after} (subject:(application OR interview OR offer OR position OR opportunity OR role) OR from:(jobs OR careers OR talent OR recruiting OR no-reply OR noreply))`;
  const out = [];
  let pageToken;
  do {
    const res = await gmail.users.messages.list({ userId: 'me', q, maxResults: 100, pageToken });
    if (res.data.messages) out.push(...res.data.messages);
    pageToken = res.data.nextPageToken;
  } while (pageToken && out.length < 500);
  return out;
}

async function fetchMessage(gmail, id) {
  const res = await gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] });
  const headers = res.data.payload?.headers || [];
  const get = (n) => headers.find(h => h.name?.toLowerCase() === n.toLowerCase())?.value || '';
  return {
    id,
    subject: get('Subject'),
    from: get('From'),
    date: get('Date'),
    snippet: res.data.snippet || '',
  };
}

// -- Main --------------------------------------------------------------------
async function main() {
  const { rows, lines } = readApps();
  if (rows.length === 0) {
    console.log('applications.md is empty. Nothing to update. Add some applications first.');
    writeState({ ...readState(), last_run: new Date().toISOString(), reason: 'empty-tracker' });
    return;
  }

  const gmail = getGmail();
  console.log(`Fetching Gmail (after ${gmailQueryDate()})...`);
  const list = await listMessages(gmail);
  console.log(`Found ${list.length} candidate messages.`);

  let processed = 0, matched = 0, updated = 0;
  for (const m of list) {
    processed++;
    const meta = await fetchMessage(gmail, m.id);
    const detected = classify(meta.subject, meta.snippet, meta.from);
    if (!detected) continue;

    const app = matchCompany(rows, meta.subject, meta.from);
    if (!app) {
      appendEvent({ ts: new Date().toISOString(), from: meta.from, subject: meta.subject, detected, action: 'no-match' });
      continue;
    }
    matched++;
    const next = transition(app.status, detected);
    if (next === app.status) {
      appendEvent({ ts: new Date().toISOString(), company: app.company, role: app.role, from: meta.from, subject: meta.subject, detected, old_status: app.status, new_status: next, action: 'no-change' });
      continue;
    }

    if (DRY_RUN) {
      console.log(`  [DRY] #${app.num} ${app.company} / ${app.role}: ${app.status} → ${next}  ←  ${meta.subject}`);
    } else {
      app.status = next;
      app._dirty = true;
      console.log(`  ✓ #${app.num} ${app.company} / ${app.role}: ${next}  ←  ${meta.subject}`);
    }
    appendEvent({ ts: new Date().toISOString(), company: app.company, role: app.role, from: meta.from, subject: meta.subject, detected, old_status: rows.find(r => r.num === app.num)?.status, new_status: next, action: DRY_RUN ? 'would-update' : 'updated' });
    updated++;
  }

  if (!DRY_RUN && updated > 0) writeApps(rows, lines);

  const state = {
    ...readState(),
    last_run: new Date().toISOString(),
    last_query_date: gmailQueryDate(),
    processed, matched, updated,
    dry_run: DRY_RUN,
  };
  writeState(state);

  console.log('--');
  console.log(`Processed: ${processed}  ·  Matched: ${matched}  ·  ${DRY_RUN ? 'Would update' : 'Updated'}: ${updated}`);
  console.log(`State: ${path.relative(ROOT, STATE_FILE)}`);
  console.log(`Events log: ${path.relative(ROOT, EVENTS_FILE)}`);
}

main().catch(err => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
