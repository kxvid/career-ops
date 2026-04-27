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
      <div class="bg-white rounded-lg shadow-sm p-4 mb-4 flex flex-wrap gap-3 items-center">
        <input id="pl-search" type="search" placeholder="Search role or company…" class="border rounded-md px-3 py-2 text-sm flex-1 min-w-[200px]" />
        <select id="pl-company" class="border rounded-md px-3 py-2 text-sm"></select>
        <label class="text-sm flex items-center gap-2"><input type="checkbox" id="pl-us-only" /> US only</label>
        <label class="text-sm flex items-center gap-2"><input type="checkbox" id="pl-no-junior" checked /> Hide Junior/New Grad/Manager</label>
        <span class="text-xs text-gray-500" id="pl-summary"></span>
      </div>
      <div class="bg-white rounded-lg shadow-sm overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-gray-100 text-left">
            <tr>
              <th class="px-3 py-2">Company</th>
              <th class="px-3 py-2">Title</th>
              <th class="px-3 py-2">First seen</th>
              <th class="px-3 py-2">Action</th>
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
  </main>

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

  const recent = D.pipeline.slice(0, 8);
  document.getElementById('overview-recent').innerHTML = recent.length === 0
    ? '<p class="text-sm text-gray-500">No listings yet.</p>'
    : '<ul class="divide-y text-sm">' + recent.map(p =>
        \`<li class="py-2 flex justify-between gap-3"><span><b>\${esc(p.company)}</b> · \${esc(p.title)}</span><a class="text-blue-600 underline shrink-0" href="\${esc(p.url)}" target="_blank">open ↗</a></li>\`
      ).join('') + '</ul>';
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }

// -- Pipeline --
function renderPipeline() {
  const search = document.getElementById('pl-search').value.toLowerCase();
  const co = document.getElementById('pl-company').value;
  const usOnly = document.getElementById('pl-us-only').checked;
  const noJunior = document.getElementById('pl-no-junior').checked;
  const nonUS = ['London', 'Bengaluru', 'Bangalore', 'Hyderabad', 'Tokyo', 'Korea', 'Japan', 'Berlin', 'Paris', 'Amsterdam', 'Singapore', 'India', 'Canberra', 'Australia', 'Ottawa', 'Canada', 'Czech', 'Russian', 'Ukrainian', 'Nordics', 'Benelux', 'Shanghai', 'France', 'Germany'];
  const junior = /\\b(Junior|New Grad|Intern|Internship|Manager|Director|Head of|Principal|Staff)\\b/i;

  let rows = D.pipeline.filter(p => {
    if (co && p.company !== co) return false;
    if (search) {
      const hay = (p.company + ' ' + p.title).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    if (usOnly && nonUS.some(k => p.title.includes(k))) return false;
    if (noJunior && junior.test(p.title)) return false;
    return true;
  });

  document.getElementById('pl-summary').textContent = rows.length + ' / ' + D.pipeline.length + ' listings';
  document.getElementById('pl-rows').innerHTML = rows.map(p => \`
    <tr class="border-t hover:bg-gray-50">
      <td class="px-3 py-2 font-medium">\${esc(p.company)}</td>
      <td class="px-3 py-2">\${esc(p.title)}</td>
      <td class="px-3 py-2 text-gray-500 text-xs">\${esc(p.first_seen || '')}</td>
      <td class="px-3 py-2"><a class="text-blue-600 underline" href="\${esc(p.url)}" target="_blank">Open ↗</a></td>
    </tr>\`).join('');

  if (rows.length === 0) {
    document.getElementById('pl-rows').innerHTML = '<tr><td colspan="4" class="text-center py-8 text-gray-500">No matches.</td></tr>';
  }
}
function setupPipelineFilters() {
  const companies = [...new Set(D.pipeline.map(p => p.company))].sort();
  const sel = document.getElementById('pl-company');
  sel.innerHTML = '<option value="">All companies</option>' + companies.map(c => \`<option>\${esc(c)}</option>\`).join('');
  ['pl-search', 'pl-company', 'pl-us-only', 'pl-no-junior'].forEach(id =>
    document.getElementById(id).addEventListener('input', renderPipeline)
  );
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
