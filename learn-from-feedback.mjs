#!/usr/bin/env node
// Reads feedback.tsv (exported from the dashboard's Pipeline tab),
// computes which keywords correlate with Interested/Applied vs Not Interested,
// and prints suggested filter additions for portals.yml.
//
// Usage:
//   node learn-from-feedback.mjs feedback.tsv
//   node learn-from-feedback.mjs feedback.tsv --min-count 3

import fs from 'node:fs';

const FILE = process.argv[2];
const minCountIdx = process.argv.indexOf('--min-count');
const MIN_COUNT = minCountIdx !== -1 ? +process.argv[minCountIdx + 1] : 3;

if (!FILE || !fs.existsSync(FILE)) {
  console.error('Usage: node learn-from-feedback.mjs <feedback.tsv>');
  console.error('Export feedback.tsv from the dashboard Pipeline tab.');
  process.exit(1);
}

const text = fs.readFileSync(FILE, 'utf8');
const lines = text.split('\n').filter(l => l.trim());
if (lines.length < 2) {
  console.error('Empty feedback file.');
  process.exit(1);
}

const headers = lines[0].split('\t');
const rows = lines.slice(1).map(l => {
  const cells = l.split('\t');
  return Object.fromEntries(headers.map((h, i) => [h, cells[i] || '']));
});

const POSITIVE = new Set(['interested', 'applied']);
const NEGATIVE = new Set(['not', 'rejected']);

const STOPWORDS = new Set(['the', 'and', 'or', 'of', 'to', 'in', 'at', 'for', 'a', 'an', 'on', 'with', 'as', 'by', 'is', 'be', 'this', 'that', 'we', 'you', 'our', 'your', 'i', 'ii', 'iii']);

function tokenize(s) {
  return String(s || '').toLowerCase().match(/[a-z][a-z0-9'-]+/g) || [];
}

const tokenStats = new Map();
const companyStats = new Map();
const fitBuckets = { pos: [], neg: [], all: [] };

for (const r of rows) {
  const sentiment = POSITIVE.has(r.decision) ? 'pos' : NEGATIVE.has(r.decision) ? 'neg' : null;
  if (!sentiment) continue;

  const fit = +r.fit || 0;
  fitBuckets[sentiment].push(fit);
  fitBuckets.all.push(fit);

  // Company tally
  const cs = companyStats.get(r.company) || { pos: 0, neg: 0 };
  cs[sentiment]++;
  companyStats.set(r.company, cs);

  // Token tally (from title)
  const seen = new Set();
  for (const tok of tokenize(r.title)) {
    if (STOPWORDS.has(tok) || tok.length < 3) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    const ts = tokenStats.get(tok) || { pos: 0, neg: 0 };
    ts[sentiment]++;
    tokenStats.set(tok, ts);
  }
}

function score(stats) {
  const total = stats.pos + stats.neg;
  if (total < MIN_COUNT) return null;
  // Laplace-smoothed conditional: P(positive | seen this token)
  const p = (stats.pos + 1) / (total + 2);
  return { ...stats, total, ratio: p };
}

const tokenScored = [...tokenStats.entries()]
  .map(([t, s]) => ({ token: t, ...score(s) || { skip: true }, raw: s }))
  .filter(t => !t.skip);

const positives = [...tokenScored].filter(t => t.ratio >= 0.7).sort((a, b) => b.ratio - a.ratio || b.total - a.total).slice(0, 30);
const negatives = [...tokenScored].filter(t => t.ratio <= 0.3).sort((a, b) => a.ratio - b.ratio || b.total - a.total).slice(0, 30);

console.log('# Feedback analysis\n');
console.log(`Decisions analyzed: ${fitBuckets.all.length} (positive: ${fitBuckets.pos.length}, negative: ${fitBuckets.neg.length})`);
console.log(`Min count threshold: ${MIN_COUNT}\n`);

const avg = a => a.length === 0 ? 0 : (a.reduce((s, x) => s + x, 0) / a.length).toFixed(1);
console.log('## Fit-score calibration');
console.log(`  Avg fit on Positive decisions: ${avg(fitBuckets.pos)}`);
console.log(`  Avg fit on Negative decisions: ${avg(fitBuckets.neg)}`);
const overlap = fitBuckets.pos.filter(f => f < 50).length + fitBuckets.neg.filter(f => f >= 50).length;
console.log(`  Mis-classified (positive <50 OR negative >=50): ${overlap}`);
console.log('  → If overlap is high, the scoring weights need tuning.\n');

console.log('## Tokens that strongly predict POSITIVE decisions');
console.log('  (likely candidates for emphasizing in your scoring or adding to title_filter.positive)');
positives.forEach(t => console.log(`    ${(t.ratio * 100).toFixed(0)}%  n=${t.total}  "${t.token}"`));

console.log('\n## Tokens that strongly predict NEGATIVE decisions');
console.log('  (candidates for adding to title_filter.negative in portals.yml)');
negatives.forEach(t => console.log(`    ${(t.ratio * 100).toFixed(0)}%  n=${t.total}  "${t.token}"`));

console.log('\n## Company tally');
const companies = [...companyStats.entries()]
  .map(([c, s]) => ({ company: c, ...s, total: s.pos + s.neg, ratio: (s.pos + 1) / (s.pos + s.neg + 2) }))
  .filter(c => c.total >= 2)
  .sort((a, b) => b.total - a.total);
console.log('  Company        Positive  Negative  Pos%');
companies.forEach(c => console.log(`  ${c.company.padEnd(15)}${String(c.pos).padStart(8)}${String(c.neg).padStart(10)}   ${(c.ratio * 100).toFixed(0)}%`));

console.log('\n## Suggested actions');
if (negatives.length > 0) {
  console.log('  - Add these to portals.yml title_filter.negative:');
  console.log('      ' + negatives.slice(0, 10).map(t => `"${t.token}"`).join(', '));
}
if (positives.length > 0) {
  console.log('  - These titles match what you actually like — make sure portals.yml positives cover them:');
  console.log('      ' + positives.slice(0, 10).map(t => `"${t.token}"`).join(', '));
}
const lowFitPositives = positives.filter(p => avg(fitBuckets.pos) < 50);
if (lowFitPositives.length > 0 && fitBuckets.pos.length >= 5) {
  console.log('  - Some positive decisions have low fit scores → check ARCHETYPE_KEYWORDS in web/build.mjs.');
}
