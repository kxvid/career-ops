#!/usr/bin/env node
// Build a single-file static dashboard from the career-ops data.
// Reads cv.md, config/profile.yml, data/applications.md, data/pipeline.md,
// data/scan-history.tsv, and reports/*.md, then writes web/index.html
// with all data inlined.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const out = path.join(__dirname, 'index.html');

const readOpt = (p) => {
  try { return fs.readFileSync(path.join(root, p), 'utf8'); }
  catch { return ''; }
};

const cvMd = readOpt('cv.md');
const profileYml = readOpt('config/profile.yml');
const applicationsMd = readOpt('data/applications.md');
const pipelineMd = readOpt('data/pipeline.md');
const scanHistoryTsv = readOpt('data/scan-history.tsv');
const profileMd = readOpt('modes/_profile.md');
const gmailStateJson = readOpt('data/gmail-state.json');
const gmailEventsTsv = readOpt('data/gmail-events.tsv');

const profile = profileYml ? yaml.load(profileYml) : {};

// -- Parse applications.md table --
function parseApplications(md) {
  const lines = md.split('\n');
  const rows = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('|') || t.startsWith('| #') || t.startsWith('|---')) continue;
    const cells = t.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 9) continue;
    if (cells[0] === '#' || /^[-:]+$/.test(cells[0])) continue;
    rows.push({
      num: cells[0], date: cells[1], company: cells[2], role: cells[3],
      score: cells[4], status: cells[5], pdf: cells[6], report: cells[7], notes: cells[8],
    });
  }
  return rows;
}
const applications = parseApplications(applicationsMd);

// -- Parse pipeline.md (- [ ] url | company | title) --
function parsePipeline(md) {
  const items = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^- \[([ x])\] (\S+) \| ([^|]+) \| (.+)$/);
    if (!m) continue;
    items.push({
      done: m[1] === 'x',
      url: m[2].trim(),
      company: m[3].trim(),
      title: m[4].trim(),
    });
  }
  return items;
}
const pipeline = parsePipeline(pipelineMd);

// -- Parse scan-history.tsv for first_seen dates --
function parseScanHistory(tsv) {
  const lines = tsv.split('\n').filter(l => l.trim());
  if (lines.length < 2) return {};
  const map = {};
  for (let i = 1; i < lines.length; i++) {
    const [url, first_seen, portal, title, company, status] = lines[i].split('\t');
    if (url) map[url] = { first_seen, portal, status };
  }
  return map;
}
const scanIndex = parseScanHistory(scanHistoryTsv);

// Enrich pipeline with first_seen
for (const item of pipeline) {
  const meta = scanIndex[item.url];
  if (meta) {
    item.first_seen = meta.first_seen;
    item.portal = meta.portal;
  }
}

// -- Gmail state + recent events --
let gmailState = null;
try { gmailState = gmailStateJson ? JSON.parse(gmailStateJson) : null; } catch { gmailState = null; }

function parseGmailEvents(tsv) {
  const lines = tsv.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t');
  return lines.slice(1).map(l => {
    const cells = l.split('\t');
    const o = {};
    headers.forEach((h, i) => { o[h] = cells[i] || ''; });
    return o;
  }).reverse(); // newest first
}
const gmailEvents = parseGmailEvents(gmailEventsTsv);

// -- Fit scoring ------------------------------------------------------------
// Deterministic, archetype-driven. 0-100. See README for weights.
const ARCHETYPE_KEYWORDS = {
  'IT Systems / Infrastructure Engineer': {
    pos: ['it systems', 'infrastructure', 'sysadmin', 'system administrator', 'endpoint', 'corporate it', 'enterprise it', 'site reliability', 'sre ', 'reliability engineer', 'corporate engineer', 'business systems'],
    weight: 1.0,
  },
  'Cloud Engineer (Azure Gov / AWS / M365)': {
    pos: ['cloud engineer', 'cloud infrastructure', 'cloud operations', 'cloudops', 'cloud architect', 'azure', 'aws engineer', 'gcp engineer', 'public sector', 'govcloud', 'federal'],
    weight: 1.0,
  },
  'Cybersecurity / Compliance Engineer (CMMC, NIST, GRC)': {
    pos: ['security engineer', 'cybersecurity', 'cyber security', 'information security', 'infosec', 'secops', 'security operations', 'detection', 'compliance', 'grc', 'governance risk', 'risk engineer', 'audit', 'cmmc', 'nist', 'fedramp', 'zero trust', 'security architect', 'vulnerability', 'application security', 'product security', 'cloud security', 'platform security', 'corporate security'],
    weight: 1.0,
  },
  'Identity & Access Management Engineer': {
    pos: ['iam ', 'identity engineer', 'identity & access', 'identity and access', 'access management', 'okta', 'sso', 'single sign-on', 'pam ', 'privileged access'],
    weight: 0.85,
  },
  'DevOps / Platform Engineer': {
    pos: ['devops', 'platform engineer', 'reliability', 'observability', 'kubernetes', 'k8s'],
    weight: 0.6,
  },
  'Data / Analytics Engineer (Snowflake/SQL)': {
    pos: ['data engineer', 'analytics engineer', 'snowflake'],
    weight: 0.5,
  },
  'Solutions / Customer Engineer (Technical)': {
    pos: ['solutions engineer', 'solutions architect', 'forward deployed', 'customer engineer', 'implementation engineer', 'technical account manager', 'deployed engineer'],
    weight: 0.6,
  },
};

const SKILL_TOKENS = [
  'aws', 'azure', 'gcp', 'm365', 'microsoft 365', 'gcc high', 'snowflake', 'sql',
  'python', 'powershell', 'okta', 'duo', 'beyondtrust', 'crowdstrike', 'splunk',
  'sumologic', 'tenable', 'tanium', 'sccm', 'active directory', 'cisco', 'vlan',
  'cmmc', 'nist', 'fedramp', 'dfars', 'cui', 'zero trust', 'salesforce',
  'servicenow', 'tableau', 'power bi', 'rpa', 'uipath', 'ansible', 'terraform',
  'docker', 'kubernetes', 'github', 'gitlab', 'jenkins', 'circleci',
];

const TARGET_METROS_TOKENS = [
  'remote', 'united states', 'usa', ' u.s.', ' us ',
  'los angeles', 'la,', 'orange county', 'irvine', 'san diego', 'san francisco',
  'sf,', 'bay area', 'palo alto', 'menlo park', 'mountain view', 'sunnyvale',
  'santa clara', 'cupertino', 'fremont',
  'seattle', 'redmond', 'bellevue',
  'new york', 'nyc', 'manhattan', 'brooklyn',
  'austin', 'dallas', 'houston', 'plano', 'frisco',
  'miami', 'tampa', 'orlando', 'jacksonville',
];

const NON_TARGET_METROS = [
  'london', 'berlin', 'paris', 'amsterdam', 'lisbon', 'munich', 'dublin',
  'madrid', 'barcelona', 'milan', 'rome', 'stockholm', 'copenhagen', 'brussels',
  'tokyo', 'osaka', 'seoul', 'singapore', 'hong kong', 'shanghai', 'shenzhen',
  'sydney', 'melbourne', 'canberra', 'tel aviv',
  'bangalore', 'bengaluru', 'hyderabad', 'pune', 'mumbai', 'delhi', 'chennai',
  'mexico city', 'são paulo', 'sao paulo', 'buenos aires',
  'toronto', 'montreal', 'vancouver', 'ottawa',
  'india', 'japan', 'korea', 'china', 'germany', 'france', 'spain', 'italy',
  'netherlands', 'australia', 'canada',
];

const SENIORITY_BAD = [
  /\bengineering manager\b/i, /\bmanager,/i, /\bmanager of\b/i, /\bdirector,/i,
  /\bdirector of\b/i, /\bhead of\b/i, /\bvp,/i, /\bvp /i, /\bvice president\b/i,
  /\bdistinguished\b/i, /\bfellow engineer\b/i, /\bprincipal\b/i, /\bstaff\b/i,
];

const SENIORITY_GREAT = [/\bmid\b/i, /\bsenior\b/i, /\bii\b/i, /\biii\b/i];
const SENIORITY_TOO_LOW = [/\bjunior\b/i, /\bnew[- ]grad\b/i, /\bintern(ship)?\b/i, /\bassociate\b/i];

const NEGATIVE_TITLES = [
  /\bmachine learning engineer\b/i, /\bml engineer\b/i, /\bdeep learning\b/i,
  /\bnlp engineer\b/i, /\bresearch (scientist|engineer|er)\b/i, /\bresearcher\b/i,
  /\bapplied scientist\b/i, /\bdata scientist\b/i, /\bquant\b/i,
  /\bios\b/i, /\bandroid\b/i, /\bmobile (developer|engineer)\b/i,
  /\bfront[- ]?end\b/i, /\bui engineer\b/i, /\bgame\b/i,
  /\bembedded\b/i, /\bfirmware\b/i, /\brf engineer\b/i,
  /\b(russian|korean|mandarin|cantonese|japanese|czech|polish|ukrainian|portuguese|italian|spanish|dutch|german|french)\s+(speaker|speaking)\b/i,
];

const TIER1_BRANDS = new Set(['Anthropic', 'OpenAI', 'xAI', 'Anduril', 'Palantir', 'Shield AI', 'Microsoft', 'Amazon / AWS', 'Google', 'Apple', 'Meta', 'Cloudflare', 'Stripe', 'CrowdStrike', 'Okta', 'Wiz', 'Snowflake', 'Databricks']);

const FED_KEYWORDS = ['us government', 'federal', 'public sector', 'cmmc', 'nist', 'fedramp', 'dod', 'department of defense', 'defense', 'cleared'];
const DEFENSE_COMPANIES = new Set(['Anduril', 'Palantir', 'Shield AI', 'Saronic', 'Vannevar Labs', 'Skydio', 'Rebellion Defense', 'Saildrone', 'Hadrian', 'Lockheed Martin', 'Northrop Grumman', 'RTX (Raytheon)', 'General Dynamics', 'L3Harris', 'Booz Allen Hamilton', 'Leidos', 'SAIC']);

// Convert a token list into word-boundary regex patterns. Phrases use \b at
// start/end only. Handles tokens with hyphens, spaces, dots, ampersands.
function compileTokens(tokens) {
  return tokens.map(t => {
    const escaped = t.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i');
  });
}

const ARCHETYPE_REGEX = Object.fromEntries(
  Object.entries(ARCHETYPE_KEYWORDS).map(([name, def]) => [name, { regex: compileTokens(def.pos), weight: def.weight }])
);
const SKILL_REGEX = compileTokens(SKILL_TOKENS);
const FED_REGEX = compileTokens(FED_KEYWORDS);
const TARGET_METROS_REGEX = compileTokens(TARGET_METROS_TOKENS.map(t => t.replace(/^\s+|\s+$/g, '').replace(/,$/, '')));
const NON_TARGET_METROS_REGEX = compileTokens(NON_TARGET_METROS);

function scoreListing(item) {
  const title = (item.title || '');
  let score = 0;
  let factors = {};

  // Archetype match — primary signal
  let archMax = 0;
  let archHit = '';
  let archHitTokens = [];
  for (const [name, def] of Object.entries(ARCHETYPE_REGEX)) {
    const hits = def.regex.filter(r => r.test(title));
    if (hits.length > 0) {
      const v = Math.min(55, hits.length * 18) * def.weight;
      if (v > archMax) { archMax = v; archHit = name; archHitTokens = hits.map(r => r.source); }
    }
  }
  score += archMax;
  factors.archetype = { score: archMax, match: archHit, hits: archHitTokens };

  // Skills overlap
  const skillHits = SKILL_REGEX.filter(r => r.test(title)).length;
  const skillScore = Math.min(20, skillHits * 5);
  score += skillScore;
  factors.skills = { score: skillScore, hits: skillHits };

  // Seniority
  let senScore = 0;
  if (SENIORITY_BAD.some(re => re.test(title))) senScore -= 40;
  else if (SENIORITY_TOO_LOW.some(re => re.test(title))) senScore -= 35;
  else if (SENIORITY_GREAT.some(re => re.test(title))) senScore += 6;
  score += senScore;
  factors.seniority = { score: senScore };

  // Location (often missing from title — only bonus/penalty if explicit)
  let locScore = 0;
  if (TARGET_METROS_REGEX.some(r => r.test(title))) locScore += 10;
  if (NON_TARGET_METROS_REGEX.some(r => r.test(title))) locScore -= 35;
  score += locScore;
  factors.location = { score: locScore };

  // Federal / clearance bonus
  let fedScore = 0;
  if (FED_REGEX.some(r => r.test(title))) fedScore += 10;
  if (DEFENSE_COMPANIES.has(item.company)) fedScore += 8;
  score += fedScore;
  factors.federal = { score: fedScore };

  // Negative keywords (catches what filter missed)
  let negScore = 0;
  for (const re of NEGATIVE_TITLES) if (re.test(title)) negScore -= 35;
  negScore = Math.max(-60, negScore);
  score += negScore;
  factors.negatives = { score: negScore };

  // Brand bonus
  let brand = 0;
  if (TIER1_BRANDS.has(item.company)) brand += 10;
  score += brand;
  factors.brand = { score: brand };

  return { score: Math.max(0, Math.min(100, Math.round(score))), factors };
}

for (const item of pipeline) {
  const { score, factors } = scoreListing(item);
  item.fit = score;
  item.fit_factors = factors;
}

// -- Reports list --
let reports = [];
const reportsDir = path.join(root, 'reports');
if (fs.existsSync(reportsDir)) {
  reports = fs.readdirSync(reportsDir)
    .filter(f => f.endsWith('.md') && !f.startsWith('.'))
    .map(f => ({ name: f, path: `reports/${f}` }))
    .sort();
}

// -- Build the HTML --
const data = {
  profile,
  cvMd,
  profileMd,
  applications,
  pipeline,
  reports,
  gmailState,
  gmailEvents: gmailEvents.slice(0, 50),
  builtAt: new Date().toISOString(),
};

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Career Ops · ${(profile.candidate?.full_name || 'Dashboard').replace(/</g, '&lt;')}</title>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .markdown h1 { font-size: 1.6rem; font-weight: 700; margin-top: 1.2rem; margin-bottom: 0.6rem; }
  .markdown h2 { font-size: 1.25rem; font-weight: 700; margin-top: 1rem; margin-bottom: 0.5rem; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.25rem; }
  .markdown h3 { font-size: 1.05rem; font-weight: 600; margin-top: 0.8rem; margin-bottom: 0.3rem; }
  .markdown ul { list-style: disc; margin-left: 1.4rem; margin-top: 0.3rem; margin-bottom: 0.5rem; }
  .markdown li { margin-bottom: 0.2rem; }
  .markdown p { margin-bottom: 0.6rem; }
  .markdown table { border-collapse: collapse; margin: 0.5rem 0; }
  .markdown th, .markdown td { border: 1px solid #e5e7eb; padding: 4px 8px; }
  .markdown a { color: #2563eb; text-decoration: underline; }
  .markdown code { background: #f3f4f6; padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; }
  .pill-primary { background: #dbeafe; color: #1d4ed8; }
  .pill-secondary { background: #ede9fe; color: #6d28d9; }
  .pill-adjacent { background: #fef3c7; color: #92400e; }
  .pill-status { background: #f3f4f6; color: #374151; }
  .tab.active { background: #111827; color: white; }
  .tab { background: #f3f4f6; color: #374151; }
</style>
</head>
<body class="bg-gray-50 text-gray-900">
<div class="max-w-7xl mx-auto px-4 py-6">

  <header class="mb-6">
    <div class="flex flex-wrap items-end justify-between gap-2">
      <div>
        <h1 class="text-3xl font-bold tracking-tight" id="hdr-name"></h1>
        <p class="text-gray-600 text-sm mt-1" id="hdr-meta"></p>
      </div>
      <div class="text-right">
        <p class="text-xs text-gray-500">Built <span id="hdr-built"></span></p>
        <p class="text-xs text-gray-500">Source: career-ops · <a class="underline" href="https://github.com/kxvid/career-ops" target="_blank">repo</a></p>
      </div>
    </div>
  </header>

  <nav class="mb-5 flex flex-wrap gap-2" id="tabs">
    <button data-tab="overview" class="tab active px-4 py-2 rounded-md text-sm font-medium">Overview</button>
    <button data-tab="pipeline" class="tab px-4 py-2 rounded-md text-sm font-medium">Pipeline <span id="pl-count" class="ml-1 text-xs opacity-75"></span></button>
    <button data-tab="applications" class="tab px-4 py-2 rounded-md text-sm font-medium">Applications <span id="ap-count" class="ml-1 text-xs opacity-75"></span></button>
    <button data-tab="cv" class="tab px-4 py-2 rounded-md text-sm font-medium">CV</button>
    <button data-tab="profile" class="tab px-4 py-2 rounded-md text-sm font-medium">Profile</button>
    <button data-tab="reports" class="tab px-4 py-2 rounded-md text-sm font-medium">Reports <span id="rp-count" class="ml-1 text-xs opacity-75"></span></button>
    <button data-tab="gmail" class="tab px-4 py-2 rounded-md text-sm font-medium">Gmail <span id="gm-count" class="ml-1 text-xs opacity-75"></span></button>
  </nav>

  <main>
    <!-- Overview -->
    <section data-section="overview" class="space-y-6">
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3" id="overview-stats"></div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div class="bg-white rounded-lg shadow-sm p-5">
          <h2 class="font-semibold text-lg mb-3">Target archetypes</h2>
          <div id="overview-archetypes"></div>
        </div>
        <div class="bg-white rounded-lg shadow-sm p-5">
          <h2 class="font-semibold text-lg mb-3">Comp & location</h2>
          <div id="overview-comp"></div>
        </div>
      </div>

      <div class="bg-white rounded-lg shadow-sm p-5">
        <h2 class="font-semibold text-lg mb-3">Top recent listings</h2>
        <div id="overview-recent"></div>
      </div>
    </section>

    <!-- Pipeline -->
    <section data-section="pipeline" class="hidden">
      <div class="bg-white rounded-lg shadow-sm p-4 mb-4 grid grid-cols-1 md:grid-cols-2 gap-3 items-center">
        <input id="pl-search" type="search" placeholder="Search role or company…" class="border rounded-md px-3 py-2 text-sm" />
        <select id="pl-company" class="border rounded-md px-3 py-2 text-sm"></select>
        <div class="flex items-center gap-2 text-sm">
          <span class="font-medium">Min fit:</span>
          <input type="range" id="pl-min-fit" min="0" max="100" step="5" value="40" class="flex-1" />
          <span id="pl-min-fit-val" class="font-mono w-10 text-right">40</span>
        </div>
        <div class="flex flex-wrap gap-3 text-sm">
          <label class="flex items-center gap-2"><input type="checkbox" id="pl-hide-decided" checked /> Hide decided</label>
          <label class="flex items-center gap-2"><input type="checkbox" id="pl-us-only" /> US only</label>
          <button id="pl-export" class="ml-auto bg-gray-900 text-white text-xs px-3 py-1.5 rounded">Export feedback (TSV)</button>
        </div>
        <div class="md:col-span-2 text-xs text-gray-500 flex flex-wrap gap-3" id="pl-summary"></div>
      </div>
      <div class="bg-white rounded-lg shadow-sm overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-gray-100 text-left">
            <tr>
              <th class="px-3 py-2 w-16">Fit</th>
              <th class="px-3 py-2">Company</th>
              <th class="px-3 py-2">Title</th>
              <th class="px-3 py-2 w-24">First seen</th>
              <th class="px-3 py-2 w-24">Eval</th>
              <th class="px-3 py-2 w-44">Decision</th>
            </tr>
          </thead>
          <tbody id="pl-rows"></tbody>
        </table>
      </div>
    </section>

    <!-- Applications -->
    <section data-section="applications" class="hidden">
      <div class="bg-white rounded-lg shadow-sm p-4 mb-4 flex flex-wrap gap-3 items-center">
        <input id="ap-search" type="search" placeholder="Search…" class="border rounded-md px-3 py-2 text-sm flex-1 min-w-[200px]" />
        <select id="ap-status" class="border rounded-md px-3 py-2 text-sm"><option value="">All statuses</option></select>
      </div>
      <div class="bg-white rounded-lg shadow-sm overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-gray-100 text-left">
            <tr>
              <th class="px-3 py-2">#</th>
              <th class="px-3 py-2">Date</th>
              <th class="px-3 py-2">Company</th>
              <th class="px-3 py-2">Role</th>
              <th class="px-3 py-2">Score</th>
              <th class="px-3 py-2">Status</th>
              <th class="px-3 py-2">Notes</th>
            </tr>
          </thead>
          <tbody id="ap-rows"></tbody>
        </table>
        <p id="ap-empty" class="text-center text-sm text-gray-500 py-8 hidden">
          No applications yet. Run an evaluation to populate this table.
        </p>
      </div>
    </section>

    <!-- CV -->
    <section data-section="cv" class="hidden">
      <article class="bg-white rounded-lg shadow-sm p-6 markdown" id="cv-content"></article>
    </section>

    <!-- Profile -->
    <section data-section="profile" class="hidden">
      <article class="bg-white rounded-lg shadow-sm p-6 markdown" id="profile-content"></article>
    </section>

    <!-- Reports -->
    <section data-section="reports" class="hidden">
      <div class="bg-white rounded-lg shadow-sm p-5">
        <ul id="rp-list" class="divide-y"></ul>
        <p id="rp-empty" class="text-sm text-gray-500 hidden">No reports yet.</p>
      </div>
    </section>

    <!-- Gmail -->
    <section data-section="gmail" class="hidden">
      <div class="bg-white rounded-lg shadow-sm p-5 mb-4" id="gm-state"></div>
      <div class="bg-white rounded-lg shadow-sm overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-gray-100 text-left">
            <tr>
              <th class="px-3 py-2">When</th>
              <th class="px-3 py-2">Company</th>
              <th class="px-3 py-2">Detected</th>
              <th class="px-3 py-2">Status change</th>
              <th class="px-3 py-2">Subject</th>
            </tr>
          </thead>
          <tbody id="gm-rows"></tbody>
        </table>
        <p id="gm-empty" class="text-sm text-gray-500 py-8 text-center hidden">
          No Gmail events yet. Run <code class="bg-gray-100 px-1">node gmail-sync.mjs</code> after running setup. See <a class="underline" href="https://github.com/kxvid/career-ops/blob/claude/job-application-tracker-M3nL4/GMAIL_SETUP.md" target="_blank">GMAIL_SETUP.md</a>.
        </p>
      </div>
    </section>
  </main>

  <!-- Evaluate modal -->
  <div id="ev-modal" class="hidden fixed inset-0 bg-black/50 z-50 flex items-start justify-center p-4 overflow-y-auto" onclick="if(event.target===this) closeEvalModal()">
    <div class="bg-white rounded-lg shadow-xl max-w-3xl w-full my-8 p-6">
      <div class="flex justify-between items-start mb-4">
        <div>
          <h2 class="text-xl font-semibold" id="ev-title"></h2>
          <p class="text-sm text-gray-600" id="ev-subtitle"></p>
        </div>
        <button onclick="closeEvalModal()" class="text-gray-500 hover:text-gray-900 text-2xl leading-none">×</button>
      </div>
      <div id="ev-body"></div>
    </div>
  </div>

  <footer class="text-center text-xs text-gray-400 mt-10 mb-4">
    Career-Ops dashboard · Static build · Re-run <code class="bg-gray-100 px-1">node web/build.mjs</code> to refresh.
  </footer>
</div>

<script id="data" type="application/json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);

// Header
const c = D.profile?.candidate || {};
document.getElementById('hdr-name').textContent = c.full_name || 'Career Ops';
const meta = [c.location, c.email, c.phone].filter(Boolean).join(' · ');
document.getElementById('hdr-meta').innerHTML = meta + (c.linkedin ? ' · <a class="underline" href="https://' + c.linkedin + '" target="_blank">LinkedIn</a>' : '');
document.getElementById('hdr-built').textContent = new Date(D.builtAt).toLocaleString();

// Counts
document.getElementById('pl-count').textContent = '(' + D.pipeline.length + ')';
document.getElementById('ap-count').textContent = '(' + D.applications.length + ')';
document.getElementById('rp-count').textContent = '(' + D.reports.length + ')';
document.getElementById('gm-count').textContent = '(' + D.gmailEvents.length + ')';

// -- Tabs --
const tabs = document.querySelectorAll('.tab');
const sections = document.querySelectorAll('section[data-section]');
tabs.forEach(b => b.addEventListener('click', () => {
  tabs.forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  sections.forEach(s => s.classList.toggle('hidden', s.dataset.section !== b.dataset.tab));
}));

// -- Overview --
function renderOverview() {
  const stats = [
    { label: 'Pipeline', v: D.pipeline.length, c: 'bg-blue-50 text-blue-800' },
    { label: 'Applications', v: D.applications.length, c: 'bg-indigo-50 text-indigo-800' },
    { label: 'Evaluated', v: D.applications.filter(a => a.status === 'Evaluated').length, c: 'bg-amber-50 text-amber-800' },
    { label: 'Applied', v: D.applications.filter(a => a.status === 'Applied').length, c: 'bg-green-50 text-green-800' },
    { label: 'Interview', v: D.applications.filter(a => a.status === 'Interview').length, c: 'bg-purple-50 text-purple-800' },
    { label: 'Offer', v: D.applications.filter(a => a.status === 'Offer').length, c: 'bg-emerald-50 text-emerald-800' },
  ];
  document.getElementById('overview-stats').innerHTML = stats.map(s =>
    \`<div class="rounded-lg \${s.c} p-4"><div class="text-xs uppercase tracking-wide font-semibold">\${s.label}</div><div class="text-2xl font-bold">\${s.v}</div></div>\`
  ).join('');

  const arch = D.profile?.target_roles?.archetypes || [];
  document.getElementById('overview-archetypes').innerHTML = arch.length === 0
    ? '<p class="text-sm text-gray-500">No archetypes set.</p>'
    : arch.map(a => \`<div class="flex justify-between py-1"><span>\${a.name} <span class="text-xs text-gray-500">(\${a.level || ''})</span></span><span class="pill pill-\${a.fit}">\${a.fit}</span></div>\`).join('');

  const comp = D.profile?.compensation || {};
  const loc = D.profile?.location || {};
  const t1 = (loc.target_metros?.tier_1_strong_preference || []).join(', ');
  const t2 = (loc.target_metros?.tier_2_priority || []).join(', ');
  const t3 = (loc.target_metros?.tier_3_acceptable || []).join(', ');
  document.getElementById('overview-comp').innerHTML = \`
    <div class="text-sm space-y-2">
      <div><b>Target:</b> \${comp.target_range || ''}</div>
      <div><b>Floor:</b> \${comp.minimum || ''} (flex band \${comp.flex_band_pct || 0}%)</div>
      <div><b>Tier 1 (CA):</b> \${t1}</div>
      <div><b>Tier 2:</b> \${t2}</div>
      <div><b>Tier 3:</b> \${t3}</div>
    </div>\`;

  const top = [...D.pipeline].sort((a, b) => (b.fit || 0) - (a.fit || 0)).slice(0, 10);
  document.getElementById('overview-recent').innerHTML = top.length === 0
    ? '<p class="text-sm text-gray-500">No listings yet.</p>'
    : '<ul class="divide-y text-sm">' + top.map(p =>
        \`<li class="py-2 flex justify-between gap-3 items-center"><span><span class="pill \${fitColor(p.fit || 0)} mr-2">\${p.fit || 0}</span><b>\${esc(p.company)}</b> · \${esc(p.title)}</span><a class="text-blue-600 underline shrink-0" href="\${esc(p.url)}" target="_blank">open ↗</a></li>\`
      ).join('') + '</ul>';
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }

// -- Pipeline + decisions --
const DECISIONS_KEY = 'careerops:decisions:v1';
function loadDecisions() {
  try { return JSON.parse(localStorage.getItem(DECISIONS_KEY) || '{}'); } catch { return {}; }
}
function saveDecision(url, decision) {
  const d = loadDecisions();
  if (decision === null) delete d[url];
  else d[url] = { decision, ts: new Date().toISOString() };
  localStorage.setItem(DECISIONS_KEY, JSON.stringify(d));
}
function fitColor(s) {
  if (s >= 70) return 'bg-emerald-100 text-emerald-800';
  if (s >= 50) return 'bg-blue-100 text-blue-800';
  if (s >= 30) return 'bg-amber-100 text-amber-800';
  return 'bg-gray-100 text-gray-600';
}
function decisionPill(d) {
  const map = { interested: 'bg-emerald-50 text-emerald-700', not: 'bg-gray-100 text-gray-500 line-through', applied: 'bg-blue-50 text-blue-700', rejected: 'bg-red-50 text-red-700' };
  const label = { interested: '👍', not: '👎', applied: '✓ applied', rejected: '✗ rejected' };
  if (!d) return '';
  return \`<span class="pill \${map[d] || 'pill-status'}">\${label[d] || d}</span>\`;
}
const NON_US_KEYS = ['London', 'Bengaluru', 'Bangalore', 'Hyderabad', 'Tokyo', 'Korea', 'Japan', 'Berlin', 'Paris', 'Amsterdam', 'Singapore', 'India', 'Canberra', 'Australia', 'Ottawa', 'Canada', 'Czech', 'Russian', 'Ukrainian', 'Nordics', 'Benelux', 'Shanghai', 'France', 'Germany', 'Mexico', 'Brazil', 'Sao Paulo', 'São Paulo'];

function renderPipeline() {
  const search = document.getElementById('pl-search').value.toLowerCase();
  const co = document.getElementById('pl-company').value;
  const usOnly = document.getElementById('pl-us-only').checked;
  const hideDecided = document.getElementById('pl-hide-decided').checked;
  const minFit = +document.getElementById('pl-min-fit').value;
  document.getElementById('pl-min-fit-val').textContent = minFit;
  const decisions = loadDecisions();

  let rows = D.pipeline.filter(p => {
    if (co && p.company !== co) return false;
    if (search) {
      const hay = (p.company + ' ' + p.title).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    if (usOnly && NON_US_KEYS.some(k => p.title.includes(k))) return false;
    if ((p.fit || 0) < minFit) return false;
    if (hideDecided && decisions[p.url]) return false;
    return true;
  });
  rows.sort((a, b) => (b.fit || 0) - (a.fit || 0));

  // Summary stats
  const decided = Object.values(decisions);
  const counts = decided.reduce((acc, d) => { acc[d.decision] = (acc[d.decision] || 0) + 1; return acc; }, {});
  document.getElementById('pl-summary').innerHTML =
    '<span><b>' + rows.length + '</b> / ' + D.pipeline.length + ' shown</span>' +
    '<span>👍 ' + (counts.interested || 0) + '</span>' +
    '<span>👎 ' + (counts.not || 0) + '</span>' +
    '<span>✓ ' + (counts.applied || 0) + '</span>' +
    '<span>✗ ' + (counts.rejected || 0) + '</span>';

  document.getElementById('pl-rows').innerHTML = rows.length === 0
    ? '<tr><td colspan="5" class="text-center py-8 text-gray-500">No matches at this threshold. Lower min-fit or clear filters.</td></tr>'
    : rows.map(p => {
        const dec = decisions[p.url]?.decision;
        const cached = D.evalCache?.[p.url];
        const evalBtn = cached
          ? \`<button data-eval class="px-2 py-1 rounded text-xs bg-emerald-600 text-white hover:bg-emerald-700" title="Re-show evaluation">View (\${cached.match_score})</button>\`
          : \`<button data-eval class="px-2 py-1 rounded text-xs bg-gray-900 text-white hover:bg-gray-700" title="Evaluate with Claude">Evaluate</button>\`;
        return \`<tr class="border-t hover:bg-gray-50" data-url="\${esc(p.url)}" data-company="\${esc(p.company)}" data-title="\${esc(p.title)}">
          <td class="px-3 py-2"><span class="pill \${fitColor(p.fit || 0)}">\${p.fit || 0}</span></td>
          <td class="px-3 py-2 font-medium">\${esc(p.company)}</td>
          <td class="px-3 py-2"><a href="\${esc(p.url)}" target="_blank" class="hover:underline">\${esc(p.title)}</a> \${decisionPill(dec)}</td>
          <td class="px-3 py-2 text-gray-500 text-xs">\${esc(p.first_seen || '')}</td>
          <td class="px-3 py-2">\${evalBtn}</td>
          <td class="px-3 py-2">
            <div class="flex gap-1 text-xs">
              <button data-d="interested" title="Interested" class="px-2 py-1 rounded \${dec==='interested'?'bg-emerald-600 text-white':'bg-gray-100 hover:bg-emerald-100'}">👍</button>
              <button data-d="not" title="Not interested" class="px-2 py-1 rounded \${dec==='not'?'bg-gray-700 text-white':'bg-gray-100 hover:bg-gray-200'}">👎</button>
              <button data-d="applied" title="Applied" class="px-2 py-1 rounded \${dec==='applied'?'bg-blue-600 text-white':'bg-gray-100 hover:bg-blue-100'}">✓</button>
              <button data-d="rejected" title="Rejected by them" class="px-2 py-1 rounded \${dec==='rejected'?'bg-red-600 text-white':'bg-gray-100 hover:bg-red-100'}">✗</button>
            </div>
          </td>
        </tr>\`;
      }).join('');

  // Wire decision buttons
  document.querySelectorAll('#pl-rows tr[data-url]').forEach(tr => {
    tr.querySelectorAll('button[data-d]').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = tr.dataset.url;
        const d = btn.dataset.d;
        const cur = loadDecisions()[url]?.decision;
        saveDecision(url, cur === d ? null : d);
        renderPipeline();
      });
    });
    const evBtn = tr.querySelector('[data-eval]');
    if (evBtn) evBtn.addEventListener('click', () => evaluateRow(tr.dataset));
  });
}

// -- Evaluate via /api/evaluate --------------------------------------------
const EVAL_CACHE_KEY = 'careerops:evals:v1';
function loadEvalCache() {
  try { return JSON.parse(localStorage.getItem(EVAL_CACHE_KEY) || '{}'); } catch { return {}; }
}
function saveEval(url, result) {
  const c = loadEvalCache();
  c[url] = { ...result, ts: new Date().toISOString() };
  localStorage.setItem(EVAL_CACHE_KEY, JSON.stringify(c));
  D.evalCache = c;
}
// Boot the cache from localStorage so cached badges render on first paint
D.evalCache = loadEvalCache();

const EV_MODAL = document.getElementById('ev-modal');
function openEvalModal() { EV_MODAL.classList.remove('hidden'); }
window.closeEvalModal = function() { EV_MODAL.classList.add('hidden'); };

function recColor(rec) {
  if (rec === 'apply') return 'bg-emerald-100 text-emerald-800';
  if (rec === 'maybe') return 'bg-amber-100 text-amber-800';
  return 'bg-gray-100 text-gray-700';
}

function renderEvalResult(target) {
  const body = document.getElementById('ev-body');
  body.innerHTML = \`
    <div class="flex flex-wrap gap-3 items-center mb-4">
      <span class="pill \${fitColor(target.match_score)}" style="font-size:1rem;padding:6px 14px">Score \${target.match_score}/100</span>
      <span class="pill \${recColor(target.recommendation)}" style="font-size:0.9rem;padding:4px 10px">\${target.recommendation.toUpperCase()}</span>
      <span class="pill pill-status">\${esc(target.archetype || '')}</span>
      <span class="pill pill-status">Legitimacy: \${esc(target.block_g_legitimacy || '')}</span>
    </div>
    <p class="mb-4 text-gray-800 italic">"\${esc(target.tldr || '')}"</p>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5">
      <div class="bg-emerald-50 border border-emerald-200 rounded p-3">
        <div class="text-xs font-semibold text-emerald-800 uppercase mb-1">Strengths</div>
        <ul class="text-sm space-y-1">\${(target.strengths || []).map(s => '<li>• ' + esc(s) + '</li>').join('')}</ul>
      </div>
      <div class="bg-red-50 border border-red-200 rounded p-3">
        <div class="text-xs font-semibold text-red-800 uppercase mb-1">Concerns</div>
        <ul class="text-sm space-y-1">\${(target.concerns || []).map(s => '<li>• ' + esc(s) + '</li>').join('')}</ul>
      </div>
    </div>

    <details class="mb-3"><summary class="cursor-pointer text-sm font-semibold py-1">Block A — Role Summary</summary><div class="markdown text-sm pl-4">\${marked.parse(target.block_a_role_summary || '')}</div></details>
    <details class="mb-3"><summary class="cursor-pointer text-sm font-semibold py-1">Block B — CV Match</summary><div class="markdown text-sm pl-4">\${marked.parse(target.block_b_cv_match || '')}</div></details>
    <details class="mb-3"><summary class="cursor-pointer text-sm font-semibold py-1">Block C — Gaps & Mitigation</summary><div class="markdown text-sm pl-4">\${marked.parse(target.block_c_gaps || '')}</div></details>
    <details class="mb-3"><summary class="cursor-pointer text-sm font-semibold py-1">Block D — Interview Difficulty</summary><div class="markdown text-sm pl-4">\${marked.parse(target.block_d_interview_difficulty || '')}</div></details>
    <details class="mb-3"><summary class="cursor-pointer text-sm font-semibold py-1">Block E — Cover Letter Draft</summary><div class="markdown text-sm pl-4">\${marked.parse(target.block_e_cover_letter_draft || '')}</div></details>
    <details class="mb-3"><summary class="cursor-pointer text-sm font-semibold py-1">Block G — Posting Legitimacy</summary><div class="markdown text-sm pl-4">\${esc(target.block_g_legitimacy_reasoning || '')}</div></details>

    <div class="text-xs text-gray-500 mt-4">
      Evaluated \${esc((target.ts || '').slice(0, 16).replace('T', ' '))} via Claude.
      \${target.usage ? \`<span class="ml-2">tokens: in=\${target.usage.input} cache_r=\${target.usage.cache_read} out=\${target.usage.output}</span>\` : ''}
    </div>\`;
}

async function evaluateRow(rowData) {
  const { url, company, title } = rowData;
  document.getElementById('ev-title').textContent = company + ' — ' + title;
  document.getElementById('ev-subtitle').innerHTML = \`<a href="\${esc(url)}" target="_blank" class="text-blue-600 underline">\${esc(url)}</a>\`;
  openEvalModal();

  const cached = loadEvalCache()[url];
  if (cached) {
    renderEvalResult(cached);
    return;
  }

  document.getElementById('ev-body').innerHTML = \`
    <div class="py-8 text-center text-gray-600">
      <div class="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-gray-700 mb-3"></div>
      <p class="text-sm font-medium">Calling Claude (Opus 4.7) — fetching JD, scoring against your profile…</p>
      <p class="text-xs text-gray-500 mt-2">Typically 15–40 seconds. First call writes cache; later calls are faster.</p>
    </div>\`;

  try {
    const r = await fetch('/api/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, company, title }),
    });
    const j = await r.json();
    if (!r.ok) {
      let helper = '';
      if (/ANTHROPIC_API_KEY/.test(j.error || '')) {
        helper = '<p class="mt-3">Add <code class="bg-gray-100 px-1">ANTHROPIC_API_KEY</code> to Vercel: Project → Settings → Environment Variables. Get a key at <a class="underline" href="https://console.anthropic.com" target="_blank">console.anthropic.com</a> ($5 free credit).</p>';
      }
      document.getElementById('ev-body').innerHTML =
        \`<div class="bg-red-50 border border-red-200 rounded p-4 text-red-800 text-sm"><b>Evaluation failed.</b><p class="mt-2 font-mono text-xs">\${esc(j.error || 'unknown error')}</p>\${helper}</div>\`;
      return;
    }
    saveEval(url, j);
    renderEvalResult(j);
    renderPipeline();
  } catch (err) {
    document.getElementById('ev-body').innerHTML =
      \`<div class="bg-red-50 border border-red-200 rounded p-4 text-red-800 text-sm"><b>Network error.</b><p class="mt-2 font-mono text-xs">\${esc(err.message || String(err))}</p><p class="mt-2 text-xs">If you opened the dashboard locally (file:// or :3000), the API call has nowhere to go. Open the deployed Vercel URL.</p></div>\`;
  }
}

function setupPipelineFilters() {
  const companies = [...new Set(D.pipeline.map(p => p.company))].sort();
  const sel = document.getElementById('pl-company');
  sel.innerHTML = '<option value="">All companies</option>' + companies.map(c => \`<option>\${esc(c)}</option>\`).join('');
  ['pl-search', 'pl-company', 'pl-us-only', 'pl-hide-decided', 'pl-min-fit'].forEach(id =>
    document.getElementById(id).addEventListener('input', renderPipeline)
  );
  document.getElementById('pl-export').addEventListener('click', exportFeedback);
}

function exportFeedback() {
  const decisions = loadDecisions();
  const rows = [['decision', 'ts', 'fit', 'company', 'title', 'url'].join('\\t')];
  for (const p of D.pipeline) {
    const d = decisions[p.url];
    if (!d) continue;
    rows.push([d.decision, d.ts, p.fit || 0, p.company, p.title, p.url].join('\\t'));
  }
  const blob = new Blob([rows.join('\\n') + '\\n'], { type: 'text/tab-separated-values' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'feedback.tsv';
  a.click();
}

// -- Applications --
function renderApplications() {
  const search = document.getElementById('ap-search').value.toLowerCase();
  const status = document.getElementById('ap-status').value;
  let rows = D.applications.filter(a => {
    if (status && a.status !== status) return false;
    if (search && !(a.company + ' ' + a.role + ' ' + a.notes).toLowerCase().includes(search)) return false;
    return true;
  });
  const tbody = document.getElementById('ap-rows');
  if (rows.length === 0) {
    tbody.innerHTML = '';
    document.getElementById('ap-empty').classList.remove('hidden');
  } else {
    document.getElementById('ap-empty').classList.add('hidden');
    tbody.innerHTML = rows.map(a => \`
      <tr class="border-t hover:bg-gray-50">
        <td class="px-3 py-2 text-gray-500">\${esc(a.num)}</td>
        <td class="px-3 py-2 text-gray-500 text-xs">\${esc(a.date)}</td>
        <td class="px-3 py-2 font-medium">\${esc(a.company)}</td>
        <td class="px-3 py-2">\${esc(a.role)}</td>
        <td class="px-3 py-2">\${esc(a.score)}</td>
        <td class="px-3 py-2"><span class="pill pill-status">\${esc(a.status)}</span></td>
        <td class="px-3 py-2 text-gray-600">\${esc(a.notes)}</td>
      </tr>\`).join('');
  }
}
function setupApplicationsFilters() {
  const statuses = [...new Set(D.applications.map(a => a.status))].sort();
  const sel = document.getElementById('ap-status');
  sel.innerHTML = '<option value="">All statuses</option>' + statuses.map(s => \`<option>\${esc(s)}</option>\`).join('');
  ['ap-search', 'ap-status'].forEach(id =>
    document.getElementById(id).addEventListener('input', renderApplications)
  );
}

// -- CV / Profile / Reports --
document.getElementById('cv-content').innerHTML = D.cvMd ? marked.parse(D.cvMd) : '<p class="text-gray-500">cv.md missing.</p>';
document.getElementById('profile-content').innerHTML = D.profileMd ? marked.parse(D.profileMd) : '<p class="text-gray-500">modes/_profile.md missing.</p>';

if (D.reports.length === 0) {
  document.getElementById('rp-empty').classList.remove('hidden');
} else {
  document.getElementById('rp-list').innerHTML = D.reports.map(r =>
    \`<li class="py-2 flex justify-between"><span class="font-mono text-sm">\${esc(r.name)}</span><a class="text-blue-600 underline" href="../\${esc(r.path)}" target="_blank">view ↗</a></li>\`
  ).join('');
}

// -- Gmail state + events --
function renderGmail() {
  const stateEl = document.getElementById('gm-state');
  if (!D.gmailState) {
    stateEl.innerHTML = '<p class="text-sm text-gray-600">No sync run yet. After OAuth setup, run <code class="bg-gray-100 px-1">node gmail-sync.mjs --dry-run</code>. See <a class="underline" href="https://github.com/kxvid/career-ops/blob/claude/job-application-tracker-M3nL4/GMAIL_SETUP.md" target="_blank">GMAIL_SETUP.md</a>.</p>';
  } else {
    const s = D.gmailState;
    const last = s.last_run ? new Date(s.last_run).toLocaleString() : '—';
    stateEl.innerHTML = \`
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <div><div class="text-xs text-gray-500 uppercase">Last sync</div><div class="font-medium">\${esc(last)}</div></div>
        <div><div class="text-xs text-gray-500 uppercase">Window</div><div class="font-medium">\${esc(s.last_query_date || '—')}</div></div>
        <div><div class="text-xs text-gray-500 uppercase">Processed</div><div class="font-medium">\${s.processed ?? 0}</div></div>
        <div><div class="text-xs text-gray-500 uppercase">Updated</div><div class="font-medium">\${s.updated ?? 0}\${s.dry_run ? ' (dry-run)' : ''}</div></div>
      </div>\`;
  }
  if (D.gmailEvents.length === 0) {
    document.getElementById('gm-empty').classList.remove('hidden');
  } else {
    document.getElementById('gm-rows').innerHTML = D.gmailEvents.map(e => {
      const change = e.old_status && e.new_status && e.old_status !== e.new_status
        ? \`<span class="text-gray-500">\${esc(e.old_status)}</span> → <b>\${esc(e.new_status)}</b>\`
        : \`<span class="text-gray-500">\${esc(e.action || '—')}</span>\`;
      return \`<tr class="border-t hover:bg-gray-50">
        <td class="px-3 py-2 text-xs text-gray-500">\${esc((e.ts || '').replace('T', ' ').slice(0, 16))}</td>
        <td class="px-3 py-2">\${esc(e.company || '—')}</td>
        <td class="px-3 py-2"><span class="pill pill-status">\${esc(e.detected || '—')}</span></td>
        <td class="px-3 py-2">\${change}</td>
        <td class="px-3 py-2 text-gray-600 truncate max-w-[400px]">\${esc(e.subject || '')}</td>
      </tr>\`;
    }).join('');
  }
}
renderGmail();

// Initial render
renderOverview();
setupPipelineFilters(); renderPipeline();
setupApplicationsFilters(); renderApplications();
</script>
</body>
</html>`;

fs.writeFileSync(out, html);
console.log(`Wrote ${path.relative(root, out)}`);
console.log(`  cv.md:           ${cvMd.length} bytes`);
console.log(`  profile.yml:     ${profileYml.length} bytes`);
console.log(`  applications:    ${applications.length} rows`);
console.log(`  pipeline:        ${pipeline.length} rows`);
console.log(`  reports:         ${reports.length} files`);
