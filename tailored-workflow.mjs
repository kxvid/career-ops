#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import yaml from 'js-yaml';

const parseYaml = yaml.load;

const args = process.argv.slice(2);
const flags = {
  scan: args.includes('--scan'),
  top: Number(getArgValue('--top', '15')),
  job: getArgValue('--job', ''),
};

const paths = {
  profile: 'config/profile.yml',
  pipeline: 'data/pipeline.md',
  cv: 'cv.md',
  outDir: 'output',
};

main().catch((err) => {
  console.error(`❌ tailored-workflow failed: ${err.message}`);
  process.exit(1);
});

async function main() {
  validatePrereqs();

  if (flags.scan) {
    runScan();
  }

  const profile = loadProfile(paths.profile);
  const cvText = readFileSync(paths.cv, 'utf-8');
  const jobs = parsePendingJobs(readFileSync(paths.pipeline, 'utf-8'));

  const rankedJobs = rankJobs(jobs, profile);
  const boardPath = writeBoard(rankedJobs, profile, flags.top);

  console.log(`✅ Tailored job board updated: ${boardPath}`);

  if (!flags.job) {
    console.log('ℹ️ No --job selected. Use one of these:');
    rankedJobs.slice(0, Math.max(1, Math.min(flags.top, 10))).forEach((job, idx) => {
      console.log(`   ${idx + 1}. ${job.company} — ${job.title} (${job.fit.toFixed(2)})`);
    });
    console.log('   Example: node tailored-workflow.mjs --job=1');
    return;
  }

  const selectedJob = pickJob(flags.job, rankedJobs);
  if (!selectedJob) {
    throw new Error(`job "${flags.job}" not found. Pick an index or exact URL from the board.`);
  }

  const jdText = await fetchJobText(selectedJob.url, selectedJob, profile);

  const keywords = extractKeywords(jdText);
  const analysis = analyzeCvCoverage(cvText, keywords);

  const optimizerPath = writeCvOptimizer(selectedJob, analysis, profile);
  const applierPath = writeApplierPack(selectedJob, analysis, profile);

  console.log(`✅ CV optimizer generated: ${optimizerPath}`);
  console.log(`✅ Application pack generated: ${applierPath}`);
  console.log('ℹ️ Reminder: this tool prepares materials, but never submits applications for you.');
}

function getArgValue(name, fallback = '') {
  const prefix = `${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function validatePrereqs() {
  const missing = Object.values(paths).filter((p) => p !== paths.outDir && !existsSync(p));
  if (missing.length > 0) {
    throw new Error(`missing required files: ${missing.join(', ')}`);
  }
  mkdirSync(paths.outDir, { recursive: true });
}

function runScan() {
  const res = spawnSync('node', ['scan.mjs'], { stdio: 'inherit' });
  if (res.status !== 0) {
    throw new Error('scan step failed');
  }
}

function loadProfile(path) {
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw) || {};
  const roleKeywords = [
    ...(parsed?.target_roles?.primary || []),
    ...((parsed?.target_roles?.archetypes || []).map((a) => a?.name).filter(Boolean)),
  ]
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter(Boolean);

  const superpowers = parsed?.narrative?.superpowers || [];
  const proofPoints = parsed?.narrative?.proof_points || [];

  return {
    candidateName: parsed?.candidate?.full_name || 'Candidate',
    roleKeywords,
    superpowers,
    proofPoints,
  };
}

function parsePendingJobs(markdown) {
  const lines = markdown.split('\n');
  const jobs = [];
  for (const line of lines) {
    const m = line.match(/^- \[[ x]\] (https?:\/\/\S+) \|\s*([^|]+)\|\s*(.+)$/);
    if (!m) continue;
    jobs.push({ url: m[1].trim(), company: m[2].trim(), title: m[3].trim() });
  }
  return jobs;
}

function rankJobs(jobs, profile) {
  return jobs
    .map((job) => {
      const textTokens = `${job.title} ${job.company}`.toLowerCase().split(/[^a-z0-9+#]+/).filter(Boolean);
      const overlap = textTokens.filter((t) => profile.roleKeywords.includes(t));
      const fit = overlap.length / Math.max(1, new Set(profile.roleKeywords).size / 8);
      const normalizedFit = Math.min(5, Math.max(0, fit * 5));
      return { ...job, fit: normalizedFit, overlap: Array.from(new Set(overlap)) };
    })
    .sort((a, b) => b.fit - a.fit || a.company.localeCompare(b.company));
}

function writeBoard(rankedJobs, profile, topN) {
  const ts = new Date().toISOString();
  const rows = rankedJobs.slice(0, topN).map((job, idx) =>
    `| ${idx + 1} | ${job.fit.toFixed(2)} | ${job.company} | ${job.title} | ${job.overlap.join(', ') || '—'} | ${job.url} |`
  );

  const md = `# Tailored Job Board\n\nGenerated: ${ts}\nCandidate: ${profile.candidateName}\n\n| Rank | Fit (/5) | Company | Role | Match Signals | URL |\n|---|---:|---|---|---|---|\n${rows.join('\n')}\n`;

  const out = `${paths.outDir}/tailored-job-board.md`;
  writeFileSync(out, md, 'utf-8');
  return out;
}

function pickJob(selector, rankedJobs) {
  const asNum = Number(selector);
  if (!Number.isNaN(asNum) && asNum > 0 && asNum <= rankedJobs.length) {
    return rankedJobs[asNum - 1];
  }
  return rankedJobs.find((j) => j.url === selector) || null;
}

async function fetchJobText(url, job, profile) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'career-ops-tailored-workflow/1.0',
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  } catch (err) {
    console.warn(`⚠️ Could not fetch JD (${err.message}). Falling back to title/profile keywords.`);
    return [job.title, job.company, ...(profile.roleKeywords || [])].join(' ');
  }
}

function extractKeywords(text) {
  const lowered = text.toLowerCase();
  const seedSkills = [
    'aws', 'azure', 'gcp', 'terraform', 'kubernetes', 'docker', 'python', 'javascript', 'typescript',
    'sql', 'snowflake', 'okta', 'iam', 'security', 'compliance', 'nist', 'cmmc', 'devops', 'linux',
    'network', 'incident', 'risk', 'automation', 'sre', 'ci/cd', 'cloud', 'api', 'react', 'node',
  ];

  const hits = seedSkills.filter((k) => lowered.includes(k));

  const tokens = lowered
    .split(/[^a-z0-9+#/.-]+/)
    .filter((t) => t.length > 3 && !STOPWORDS.has(t));

  const freq = new Map();
  for (const token of tokens) {
    freq.set(token, (freq.get(token) || 0) + 1);
  }

  const top = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([token]) => token);

  return Array.from(new Set([...hits, ...top])).slice(0, 40);
}

function analyzeCvCoverage(cvText, keywords) {
  const normalizedCv = cvText.toLowerCase();
  const matched = [];
  const missing = [];

  for (const kw of keywords) {
    if (normalizedCv.includes(kw)) matched.push(kw);
    else missing.push(kw);
  }

  return {
    matched: matched.slice(0, 20),
    missing: missing.slice(0, 20),
    score: ((matched.length / Math.max(1, keywords.length)) * 100).toFixed(1),
  };
}

function writeCvOptimizer(job, analysis, profile) {
  const bullets = [
    `Lead with role-relevant keywords in the summary: ${analysis.missing.slice(0, 5).join(', ') || 'none identified'}.`,
    `Keep these proven strengths in your first bullet points: ${(profile.superpowers || []).slice(0, 3).join(' | ') || 'your top achievements'}.`,
    `Add one achievement bullet that combines impact + tooling + domain fit for ${job.company}.`,
  ];

  const md = `# CV Optimizer — ${job.company} — ${job.title}\n\nURL: ${job.url}\n\n## Match Score\n${analysis.score}% of extracted JD keywords currently appear in cv.md.\n\n## Keywords Already Covered\n${analysis.matched.map((k) => `- ${k}`).join('\n') || '- None detected'}\n\n## Candidate Gaps To Add\n${analysis.missing.map((k) => `- ${k}`).join('\n') || '- None detected'}\n\n## Suggested CV Edits\n${bullets.map((b) => `- ${b}`).join('\n')}\n`;

  const out = `${paths.outDir}/cv-optimizer-${slugify(job.company)}-${slugify(job.title)}.md`;
  writeFileSync(out, md, 'utf-8');
  return out;
}

function writeApplierPack(job, analysis, profile) {
  const proof = (profile.proofPoints || []).slice(0, 3);
  const proofLines = proof.length > 0
    ? proof.map((p) => `- ${p.name}: ${p.hero_metric}`).join('\n')
    : '- Add 2-3 concrete proof points from your recent work.';

  const md = `# Application Pack — ${job.company} — ${job.title}\n\nUse this as copy-ready material while filling forms. Review before sending.\n\n## Why this role\nI am targeting ${job.title}-adjacent work where I can contribute quickly with strengths in ${analysis.matched.slice(0, 5).join(', ') || 'infrastructure and security execution'}. The role stands out because it combines technical depth with measurable business impact.\n\n## Why ${job.company}\n${job.company} is aligned with my background in high-accountability environments and the outcomes I care about: secure delivery, reliable operations, and cross-functional execution.\n\n## Top proof points to reuse\n${proofLines}\n\n## Additional info answer (copy-ready)\nI prepare targeted applications with role-specific evidence and measurable outcomes. If useful, I can share a concise project brief mapping my recent work to this role's core requirements.\n\n## Final checks before submit\n- Confirm compensation, location, and authorization answers are accurate.\n- Ensure CV includes the missing high-signal terms: ${analysis.missing.slice(0, 8).join(', ') || 'none'}.\n- Tailor one sentence to the exact team mission from the posting.\n- Submit manually (never automated).\n`;

  const out = `${paths.outDir}/applier-pack-${slugify(job.company)}-${slugify(job.title)}.md`;
  writeFileSync(out, md, 'utf-8');
  return out;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

const STOPWORDS = new Set([
  'with', 'from', 'this', 'that', 'have', 'will', 'your', 'you', 'about', 'their', 'they', 'them',
  'role', 'team', 'work', 'jobs', 'must', 'able', 'across', 'years', 'experience', 'required', 'preferred',
  'including', 'qualifications', 'responsibilities', 'application', 'equal', 'opportunity', 'company',
  'position', 'knowledge', 'skills', 'ability', 'using', 'into', 'more', 'than', 'such', 'other', 'our',
]);
