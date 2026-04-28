#!/usr/bin/env node
// tailor-cv.mjs — Generate a tailored CV for a specific JD.
//
// Usage:
//   node tailor-cv.mjs <url>                     # fetch JD + tailor + write output/cv-{slug}.md
//   node tailor-cv.mjs <url> --report=NNN        # use existing report's archetype + strengths
//   node tailor-cv.mjs --jd-file=path --company=X --title=Y
//
// Output: output/cv-{slug}-{date}.md (markdown only — run `node generate-pdf.mjs` for PDF)
//
// HARD CONSTRAINT: never fabricates. Reorders, rephrases, trims only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const REPORT_NUM = args.report;
const JD_FILE = args['jd-file'];
const COMPANY = args.company || '';
const TITLE = args.title || '';

if (!URL_ARG && !JD_FILE) {
  console.error('Usage: node tailor-cv.mjs <url> | --jd-file=path');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY in .env. See evaluate.mjs setup.');
  process.exit(1);
}

const slugify = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
const todayStamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const SYSTEM_PROMPT = `You are tailoring a candidate's resume for a specific job description. Output strict JSON conforming to the schema.

ABSOLUTE RULES — never violated:
1. NEVER invent experience, employers, dates, projects, certifications, or skills the candidate doesn't have in cv.md. If it's not in cv.md, it cannot be in the tailored version.
2. NEVER invent or change metrics. If cv.md says "200+ endpoints", the tailored version says "200+ endpoints" — never "300+" or "thousands".
3. NEVER change employment dates, titles, or company names.
4. NEVER add a skill that isn't in the candidate's existing skills section.

ALLOWED:
1. REORDER bullets within a role to lead with the most JD-relevant.
2. REPHRASE bullets using vocabulary from the JD (only when the underlying fact is the same).
3. TRIM less-relevant bullets.
4. REWRITE the summary to lead with the archetype that best matches this role.
5. PRUNE the skills list to the ~15 most JD-relevant (from the candidate's actual skills).

VERIFICATION: For each bullet, ask "could the candidate honestly defend this in an interview given cv.md?" If no, revise or drop it.`;

const SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    summary: { type: 'string' },
    experience: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          company: { type: 'string' },
          title: { type: 'string' },
          location: { type: 'string' },
          dates: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' } },
        },
        required: ['company', 'title', 'dates', 'bullets'],
        additionalProperties: false,
      },
    },
    skills: { type: 'array', items: { type: 'string' } },
    education: { type: 'string' },
    certifications: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['headline', 'summary', 'experience', 'skills', 'notes'],
  additionalProperties: false,
};

function stripHtml(s) {
  return String(s).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

async function fetchJD(url) {
  const ghMatch = url.match(/(?:job-boards\.greenhouse\.io|boards\.greenhouse\.io)\/([^/]+)\/jobs\/(\d+)/);
  if (ghMatch) {
    const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${ghMatch[1]}/jobs/${ghMatch[2]}`);
    if (r.ok) {
      const j = await r.json();
      return { title: TITLE || j.title, company: COMPANY || ghMatch[1].replace(/-/g, ' '), content: stripHtml(j.content || '') };
    }
  }
  const leverMatch = url.match(/jobs\.lever\.co\/([^/]+)\/([0-9a-f-]+)/);
  if (leverMatch) {
    const r = await fetch(`https://api.lever.co/v0/postings/${leverMatch[1]}/${leverMatch[2]}`);
    if (r.ok) {
      const j = await r.json();
      return { title: TITLE || j.text, company: COMPANY || leverMatch[1], content: stripHtml(j.descriptionPlain || j.description || '') };
    }
  }
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (career-ops/1.0)' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  return { title: TITLE, company: COMPANY, content: stripHtml(html).slice(0, 30000) };
}

function renderMarkdown(t, candidate) {
  const lines = [];
  lines.push(`# ${candidate.full_name || 'Candidate'}`);
  lines.push('');
  lines.push([candidate.location, candidate.phone, candidate.email].filter(Boolean).join(' · '));
  if (candidate.linkedin) lines.push(`[${candidate.linkedin}](https://${candidate.linkedin})`);
  lines.push('');
  lines.push(`*${t.headline}*`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(t.summary);
  lines.push('');
  lines.push('## Experience');
  for (const e of t.experience || []) {
    lines.push('');
    lines.push(`### ${e.title} — ${e.company}`);
    lines.push(`*${[e.location, e.dates].filter(Boolean).join(' · ')}*`);
    lines.push('');
    for (const b of e.bullets || []) lines.push(`- ${b}`);
  }
  if (t.education) { lines.push(''); lines.push('## Education'); lines.push(''); lines.push(t.education); }
  if (t.certifications?.length) {
    lines.push(''); lines.push('## Certifications'); lines.push('');
    for (const c of t.certifications) lines.push(`- ${c}`);
  }
  if (t.skills?.length) {
    lines.push(''); lines.push('## Skills'); lines.push('');
    for (const s of t.skills) lines.push(`- ${s}`);
  }
  return lines.join('\n');
}

async function main() {
  const cv = fs.readFileSync(path.join(ROOT, 'cv.md'), 'utf8');
  const profileYml = fs.readFileSync(path.join(ROOT, 'config/profile.yml'), 'utf8');
  const profileMd = fs.readFileSync(path.join(ROOT, 'modes/_profile.md'), 'utf8');

  let jd;
  if (JD_FILE) {
    jd = { title: TITLE, company: COMPANY, content: fs.readFileSync(JD_FILE, 'utf8') };
  } else {
    jd = await fetchJD(URL_ARG);
  }
  console.log(`Tailoring CV for: ${jd.company} | ${jd.title}`);

  // Optional: pull eval context from existing report
  let evalContext = '';
  if (REPORT_NUM) {
    const reportFiles = fs.readdirSync(path.join(ROOT, 'reports')).filter(f => f.startsWith(`${REPORT_NUM}-`));
    if (reportFiles.length) {
      const report = fs.readFileSync(path.join(ROOT, 'reports', reportFiles[0]), 'utf8');
      const archetype = report.match(/Archetype match:\*\*\s*(.+)/)?.[1];
      const strengths = report.match(/## Strengths\n\n([\s\S]+?)\n\n##/)?.[1];
      if (archetype) evalContext += `\n**Best-fit archetype:** ${archetype}`;
      if (strengths) evalContext += `\n\n**Strengths to emphasize:**\n${strengths}`;
    }
  }

  const stableContext = `# Candidate Source-of-Truth

## cv.md (the ONLY source of facts)

${cv}

## Profile

\`\`\`yaml
${profileYml}
\`\`\`

## Archetype Mapping

${profileMd}`;

  const volatile = `# Tailoring Brief

**Company:** ${jd.company}
**Title:** ${jd.title}
${evalContext}

## Job Description

${jd.content}

---

Tailor the candidate's CV. Return JSON. Never invent. Only reorder, rephrase, trim.`;

  console.log('Calling Claude (Opus 4.7, adaptive thinking)...');
  const t0 = Date.now();
  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: stableContext, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: volatile },
      ],
    }],
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
  });
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s · in=${response.usage.input_tokens} cache_r=${response.usage.cache_read_input_tokens || 0} out=${response.usage.output_tokens}`);

  const textBlock = response.content.find(b => b.type === 'text');
  const result = JSON.parse(textBlock.text);

  // Extract candidate from profile.yml
  const candidate = {};
  const m = profileYml.match(/candidate:\s*\n([\s\S]*?)(?=\n[a-z_]+:|\n\n|$)/);
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = line.match(/^\s+(\w+):\s*"?([^"]*?)"?\s*$/);
      if (kv && kv[2]) candidate[kv[1]] = kv[2];
    }
  }

  const md = renderMarkdown(result, candidate);
  const slug = slugify(jd.company || 'unknown');
  const date = todayStamp();
  const outDir = path.join(ROOT, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `cv-${slug}-${date}.md`);
  fs.writeFileSync(outPath, md);

  console.log('--');
  console.log(`Tailored CV: ${path.relative(ROOT, outPath)}`);
  console.log(`\nNotes from Claude:\n  ${result.notes}`);
  console.log(`\nNext: node generate-pdf.mjs ${slug}  (renders to PDF via cv-template.html)`);
}

main().catch(err => {
  if (err instanceof Anthropic.APIError) console.error(`Anthropic ${err.status}: ${err.message}`);
  else console.error('Failed:', err.message);
  process.exit(1);
});
