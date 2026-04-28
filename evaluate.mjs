#!/usr/bin/env node
// evaluate.mjs — End-to-end JD evaluator. Local CLI orchestrator.
//
// Usage:
//   node evaluate.mjs <url>                         # fetch + evaluate + write report + update tracker
//   node evaluate.mjs <url> --pipeline-row=42       # also marks the pipeline row as evaluated
//   node evaluate.mjs --jd-file=path/to/jd.txt --company=X --title=Y
//   node evaluate.mjs <url> --no-write              # eval only, no files written
//   node evaluate.mjs <url> --model=claude-sonnet-4-6  # override model
//
// Requires ANTHROPIC_API_KEY in .env (free $5 credit on signup at console.anthropic.com).
// Falls back to GEMINI_API_KEY via gemini-eval.mjs if no Anthropic key (less structured).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const ROOT = __dirname;
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) return [m[1], m[2] ?? true];
    if (!a.startsWith('-')) return ['_url', a];
    return [a, true];
  })
);
const URL_ARG = args._url || '';
const NO_WRITE = !!args['no-write'];
const MODEL = args.model || 'claude-opus-4-7';
const JD_FILE = args['jd-file'];
const COMPANY_ARG = args.company || '';
const TITLE_ARG = args.title || '';

if (!URL_ARG && !JD_FILE) {
  console.error('Usage: node evaluate.mjs <url> | --jd-file=path');
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY in .env.');
  console.error('Get a free key with $5 credit at https://console.anthropic.com');
  console.error('Then: echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env');
  process.exit(1);
}

// -- Helpers ----------------------------------------------------------------
const slugify = s => String(s).toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function nextReportNumber() {
  const dir = path.join(ROOT, 'reports');
  if (!fs.existsSync(dir)) return 1;
  const nums = fs.readdirSync(dir)
    .map(f => +(f.match(/^(\d+)-/)?.[1] || 0))
    .filter(Boolean);
  return nums.length === 0 ? 1 : Math.max(...nums) + 1;
}

// -- Fetch JD ---------------------------------------------------------------
async function fetchJD(url) {
  console.log(`Fetching ${url}...`);
  // Greenhouse JSON endpoint for job-boards.greenhouse.io URLs
  const ghMatch = url.match(/(?:job-boards\.greenhouse\.io|boards\.greenhouse\.io)\/([^/]+)\/jobs\/(\d+)/);
  if (ghMatch) {
    const [, board, jobId] = ghMatch;
    const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${jobId}`;
    const r = await fetch(apiUrl);
    if (r.ok) {
      const j = await r.json();
      return {
        title: j.title,
        company: board.replace(/-/g, ' '),
        location: j.location?.name || '',
        content: stripHtml(j.content || ''),
        url,
      };
    }
  }
  // Lever JSON endpoint
  const leverMatch = url.match(/jobs\.lever\.co\/([^/]+)\/([0-9a-f-]+)/);
  if (leverMatch) {
    const [, board, jobId] = leverMatch;
    const apiUrl = `https://api.lever.co/v0/postings/${board}/${jobId}`;
    const r = await fetch(apiUrl);
    if (r.ok) {
      const j = await r.json();
      return {
        title: j.text,
        company: board,
        location: j.categories?.location || '',
        content: stripHtml(j.descriptionPlain || j.description || ''),
        url,
      };
    }
  }
  // Fallback: HTML fetch
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (career-ops/1.0)' },
    redirect: 'follow',
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
  const html = await r.text();
  return {
    title: TITLE_ARG || extractMeta(html, 'og:title') || extractTag(html, 'title') || '',
    company: COMPANY_ARG || extractMeta(html, 'og:site_name') || '',
    location: '',
    content: stripHtml(html).slice(0, 30000),
    url,
  };
}

function stripHtml(s) {
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
const extractMeta = (html, name) => html.match(new RegExp(`<meta[^>]+property=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'))?.[1] || '';
const extractTag = (html, tag) => html.match(new RegExp(`<${tag}[^>]*>([^<]+)<\\/${tag}>`, 'i'))?.[1]?.trim() || '';

// -- Build prompt -----------------------------------------------------------
const STABLE_SYSTEM = `You are a senior career coach evaluating a job description against a candidate's profile. You produce a rigorous, structured A-G evaluation following the career-ops methodology.

You MUST return valid JSON conforming to the provided schema. No prose outside the JSON.

Scoring rubric:
- match_score 0-100: 80+ = strong fit, apply with priority. 60-79 = good fit, apply. 40-59 = partial fit, only if user has specific reason. <40 = SKIP.
- recommendation: "apply" | "maybe" | "skip" — be honest, do not inflate.
- archetype: pick the candidate's best-fit archetype from their profile.
- strengths: 3 specific things from the candidate's CV that match the JD's stated requirements. Use direct quotes from CV.
- concerns: 3 specific gaps or risks. Be honest about hard requirements not met.
- block_a_role_summary: a markdown table of role facts (level, location, salary if disclosed, team size, must-haves).
- block_b_cv_match: a markdown table with two columns "JD requirement" and "CV evidence" — quote CV lines verbatim.
- block_c_gaps: markdown bullet list of gaps with mitigation strategy each (cover-letter framing, parallel project, or honest acknowledgement).
- block_d_interview_difficulty: 1-5 difficulty score with 2-sentence reasoning + likely round structure.
- block_e_cover_letter_draft: 200-word first-person cover letter using the candidate's exit narrative and 2-3 proof points.
- block_g_legitimacy: "gold" (well-known company, posted directly) | "silver" (smaller co, posted on official board) | "bronze" (third-party reposting, ambiguous) | "red" (suspicious patterns, ghost job indicators)
- block_g_legitimacy_reasoning: 1-2 sentences justifying the tier.

When the JD's compensation is below the candidate's floor, lower the recommendation to "skip" unless brand/role compensates strongly. When the JD requires a clearance/citizenship the candidate doesn't have, flag as concern; recommend "maybe" if naturalization is in progress and timeline allows.`;

function buildPrompt(jd, cv, profile, profileMd) {
  const stableUserContext = `# Candidate Profile

## CV (cv.md)

${cv}

## Profile Configuration (config/profile.yml)

\`\`\`yaml
${profile}
\`\`\`

## Personalization (modes/_profile.md)

${profileMd}`;

  const volatileJD = `# Job Description to Evaluate

**Company:** ${jd.company || '(unknown)'}
**Title:** ${jd.title || '(unknown)'}
**Location:** ${jd.location || '(unspecified)'}
**URL:** ${jd.url}

## Description

${jd.content}

---

Evaluate this role against the candidate profile above. Return JSON conforming to the schema.`;

  return { stableUserContext, volatileJD };
}

// -- Schema for structured output ------------------------------------------
const SCHEMA = {
  type: 'object',
  properties: {
    match_score: { type: 'integer', minimum: 0, maximum: 100 },
    recommendation: { type: 'string', enum: ['apply', 'maybe', 'skip'] },
    tldr: { type: 'string' },
    archetype: { type: 'string' },
    strengths: { type: 'array', items: { type: 'string' } },
    concerns: { type: 'array', items: { type: 'string' } },
    block_a_role_summary: { type: 'string' },
    block_b_cv_match: { type: 'string' },
    block_c_gaps: { type: 'string' },
    block_d_interview_difficulty: { type: 'string' },
    block_e_cover_letter_draft: { type: 'string' },
    block_g_legitimacy: { type: 'string', enum: ['gold', 'silver', 'bronze', 'red'] },
    block_g_legitimacy_reasoning: { type: 'string' },
  },
  required: ['match_score', 'recommendation', 'tldr', 'archetype', 'strengths', 'concerns',
    'block_a_role_summary', 'block_b_cv_match', 'block_c_gaps', 'block_d_interview_difficulty',
    'block_e_cover_letter_draft', 'block_g_legitimacy', 'block_g_legitimacy_reasoning'],
  additionalProperties: false,
};

// -- Call Claude ------------------------------------------------------------
async function callClaude({ stableUserContext, volatileJD }) {
  const client = new Anthropic();
  console.log(`Calling ${MODEL} (with prompt caching + adaptive thinking)...`);
  const t0 = Date.now();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: [
      { type: 'text', text: STABLE_SYSTEM, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: stableUserContext, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: volatileJD },
        ],
      },
    ],
    output_config: {
      format: { type: 'json_schema', schema: SCHEMA },
    },
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const u = response.usage;
  console.log(`  ${dt}s · in=${u.input_tokens} cache_w=${u.cache_creation_input_tokens || 0} cache_r=${u.cache_read_input_tokens || 0} out=${u.output_tokens}`);

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No text content in response');
  return JSON.parse(textBlock.text);
}

// -- Render report markdown -------------------------------------------------
function renderReport({ jd, evalResult, num, slug, date }) {
  const e = evalResult;
  const fitEmoji = e.match_score >= 80 ? '🟢' : e.match_score >= 60 ? '🔵' : e.match_score >= 40 ? '🟡' : '🔴';
  return `# ${jd.company || 'Unknown'} — ${jd.title || 'Unknown role'}

**Score:** ${e.match_score}/100 ${fitEmoji}
**Recommendation:** ${e.recommendation.toUpperCase()}
**URL:** ${jd.url}
**Legitimacy:** ${e.block_g_legitimacy}
**PDF:** ❌ (not generated yet — run \`node generate-pdf.mjs ${num}\` if you want one)
**Date:** ${date}
**Archetype match:** ${e.archetype}

## TL;DR

${e.tldr}

## Strengths

${e.strengths.map(s => `- ${s}`).join('\n')}

## Concerns

${e.concerns.map(s => `- ${s}`).join('\n')}

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

// -- Write tracker TSV ------------------------------------------------------
function writeTrackerTsv({ num, date, company, role, evalResult, slug }) {
  const dir = path.join(ROOT, 'batch/tracker-additions');
  fs.mkdirSync(dir, { recursive: true });
  const status = evalResult.recommendation === 'skip' ? 'SKIP' : 'Evaluated';
  const score = `${(evalResult.match_score / 20).toFixed(1)}/5`;
  const note = evalResult.tldr.slice(0, 80).replace(/\t/g, ' ');
  const reportLink = `[${num}](reports/${num}-${slug}-${date}.md)`;
  const row = [num, date, company, role, status, score, '❌', reportLink, note].join('\t');
  fs.writeFileSync(path.join(dir, `${num}-${slug}.tsv`), row + '\n');
}

// -- Main --------------------------------------------------------------------
async function main() {
  const cv = fs.readFileSync(path.join(ROOT, 'cv.md'), 'utf8');
  const profileYml = fs.readFileSync(path.join(ROOT, 'config/profile.yml'), 'utf8');
  const profileMd = fs.readFileSync(path.join(ROOT, 'modes/_profile.md'), 'utf8');

  let jd;
  if (JD_FILE) {
    jd = {
      title: TITLE_ARG, company: COMPANY_ARG, location: '',
      content: fs.readFileSync(JD_FILE, 'utf8'),
      url: URL_ARG || `local:${JD_FILE}`,
    };
  } else {
    jd = await fetchJD(URL_ARG);
  }
  if (TITLE_ARG) jd.title = TITLE_ARG;
  if (COMPANY_ARG) jd.company = COMPANY_ARG;
  console.log(`JD: ${jd.company} | ${jd.title} (${jd.content.length} chars)`);

  const prompts = buildPrompt(jd, cv, profileYml, profileMd);
  const evalResult = await callClaude(prompts);

  console.log('--');
  console.log(`Score: ${evalResult.match_score}/100  ·  Recommendation: ${evalResult.recommendation.toUpperCase()}`);
  console.log(`Archetype: ${evalResult.archetype}`);
  console.log(`TL;DR: ${evalResult.tldr}`);

  if (NO_WRITE) {
    console.log('\n(--no-write: skipping file writes)');
    return;
  }

  const num = String(nextReportNumber()).padStart(3, '0');
  const slug = slugify(jd.company || 'unknown');
  const date = todayStamp();
  const reportPath = path.join(ROOT, `reports/${num}-${slug}-${date}.md`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, renderReport({ jd, evalResult, num, slug, date }));
  console.log(`Report: ${path.relative(ROOT, reportPath)}`);

  writeTrackerTsv({ num, date, company: jd.company, role: jd.title, evalResult, slug });
  try {
    execSync('node merge-tracker.mjs', { cwd: ROOT, stdio: 'pipe' });
    console.log('Tracker updated (data/applications.md)');
  } catch (e) {
    console.warn('merge-tracker failed:', e.message);
  }

  console.log('\nNext: rebuild dashboard with `node web/build.mjs`');
}

main().catch(err => {
  if (err instanceof Anthropic.APIError) {
    console.error(`Anthropic API error ${err.status}:`, err.message);
  } else {
    console.error('Failed:', err.message);
  }
  process.exit(1);
});
