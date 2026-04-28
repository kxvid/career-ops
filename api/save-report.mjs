// Vercel serverless: POST /api/save-report
// Persists an evaluation to GitHub:
//   1. reports/{NNN}-{slug}-{date}.md
//   2. data/applications.md (appended row)
//   3. batch/tracker-additions/{NNN}-{slug}.tsv (audit trail)
//
// Requires Vercel env vars:
//   - GITHUB_TOKEN (fine-grained PAT, contents:write on the repo)
//   - GITHUB_REPO (e.g. "kxvid/career-ops")
//   - GITHUB_BRANCH (e.g. "claude/job-application-tracker-M3nL4")

const GITHUB_API = 'https://api.github.com';

function slugify(s) {
  return String(s).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
}
function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ghHeaders() {
  return {
    'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'career-ops-orchestrator',
  };
}
function repo() { return process.env.GITHUB_REPO; }
function branch() { return process.env.GITHUB_BRANCH || 'main'; }

async function ghGet(p) {
  const r = await fetch(`${GITHUB_API}/repos/${repo()}/contents/${p}?ref=${encodeURIComponent(branch())}`, { headers: ghHeaders() });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub GET ${p}: ${r.status} ${await r.text()}`);
  return await r.json();
}

async function ghList(p) {
  const r = await fetch(`${GITHUB_API}/repos/${repo()}/contents/${p}?ref=${encodeURIComponent(branch())}`, { headers: ghHeaders() });
  if (r.status === 404) return [];
  if (!r.ok) return [];
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}

async function ghPut(p, content, message, sha = null) {
  const body = {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: branch(),
  };
  if (sha) body.sha = sha;
  const r = await fetch(`${GITHUB_API}/repos/${repo()}/contents/${p}`, {
    method: 'PUT', headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GitHub PUT ${p}: ${r.status} ${await r.text()}`);
  return await r.json();
}

function renderReport({ jd, evalResult, num, slug, date }) {
  const e = evalResult;
  const fitEmoji = e.match_score >= 80 ? '🟢' : e.match_score >= 60 ? '🔵' : e.match_score >= 40 ? '🟡' : '🔴';
  return `# ${jd.company || 'Unknown'} — ${jd.title || 'Unknown role'}

**Score:** ${e.match_score}/100 ${fitEmoji}
**Recommendation:** ${e.recommendation.toUpperCase()}
**URL:** ${jd.url}
**Legitimacy:** ${e.block_g_legitimacy}
**PDF:** ❌
**Date:** ${date}
**Archetype match:** ${e.archetype}

## TL;DR

${e.tldr}

## Strengths

${(e.strengths || []).map(s => `- ${s}`).join('\n')}

## Concerns

${(e.concerns || []).map(s => `- ${s}`).join('\n')}

---

## Block A — Role Summary

${e.block_a_role_summary}

## Block B — CV Match

${e.block_b_cv_match}

## Block C — Gaps & Mitigation

${e.block_c_gaps}

## Block D — Interview Difficulty

${e.block_d_interview_difficulty}

## Block E — Cover Letter Draft

${e.block_e_cover_letter_draft}

## Block G — Posting Legitimacy

**Tier:** ${e.block_g_legitimacy}

${e.block_g_legitimacy_reasoning}
`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  try {
    if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
      res.status(500).json({ error: 'Server missing GITHUB_TOKEN or GITHUB_REPO env vars' });
      return;
    }
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { eval: evalResult, url, company, title } = body;
    if (!evalResult || !url) { res.status(400).json({ error: 'Missing eval or url' }); return; }

    const date = todayStamp();
    const slug = slugify(company || 'unknown');

    // Compute next report number from current reports/ contents
    const existing = await ghList('reports');
    const nums = existing.map(f => +(f.name.match(/^(\d+)-/)?.[1] || 0)).filter(Boolean);
    const num = String(nums.length === 0 ? 1 : Math.max(...nums) + 1).padStart(3, '0');

    const jd = { company, title, url };
    const reportPath = `reports/${num}-${slug}-${date}.md`;
    const reportContent = renderReport({ jd, evalResult, num, slug, date });
    await ghPut(reportPath, reportContent, `eval(${num}): ${company} — ${title}`.slice(0, 70));

    // Append to applications.md
    const appsFile = await ghGet('data/applications.md');
    let appsContent;
    let appsSha = null;
    if (appsFile) {
      appsContent = Buffer.from(appsFile.content, 'base64').toString('utf8');
      appsSha = appsFile.sha;
    } else {
      appsContent = `# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n`;
    }
    const status = evalResult.recommendation === 'skip' ? 'SKIP' : 'Evaluated';
    const score = `${(evalResult.match_score / 20).toFixed(1)}/5`;
    const note = (evalResult.tldr || '').slice(0, 80).replace(/\|/g, '/');
    const reportLink = `[${num}](reports/${num}-${slug}-${date}.md)`;
    const newRow = `| ${num} | ${date} | ${company} | ${title} | ${score} | ${status} | ❌ | ${reportLink} | ${note} |`;
    const newAppsContent = appsContent.trimEnd() + '\n' + newRow + '\n';
    await ghPut('data/applications.md', newAppsContent, `tracker: +${company} ${title}`.slice(0, 70), appsSha);

    res.status(200).json({
      ok: true,
      num,
      reportPath,
      reportUrl: `https://github.com/${repo()}/blob/${encodeURIComponent(branch())}/${reportPath}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export const config = { maxDuration: 30 };
