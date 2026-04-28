// Vercel serverless: POST /api/tailor-cv
// Body: { url, company, title, archetype?, evalResult? }
// Returns: tailored CV markdown + structured object.
//
// HARD CONSTRAINT: Claude is instructed to NEVER fabricate. It can only
// reorder, rephrase using JD vocabulary, and trim cv.md content.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let CTX = null;
function loadContext() {
  if (CTX) return CTX;
  CTX = {
    cv: fs.readFileSync(path.join(ROOT, 'cv.md'), 'utf8'),
    profile: fs.readFileSync(path.join(ROOT, 'config/profile.yml'), 'utf8'),
    profileMd: fs.readFileSync(path.join(ROOT, 'modes/_profile.md'), 'utf8'),
  };
  return CTX;
}

const SYSTEM_PROMPT = `You are tailoring a candidate's resume for a specific job description. Output strict JSON conforming to the schema.

ABSOLUTE RULES — never violated:
1. NEVER invent experience, employers, dates, projects, certifications, or skills the candidate doesn't have in cv.md. If it's not in cv.md, it cannot be in the tailored version.
2. NEVER invent or change metrics. If cv.md says "200+ endpoints", the tailored version says "200+ endpoints" — never "300+" or "thousands".
3. NEVER change employment dates, titles, or company names.
4. NEVER add a skill that isn't in the candidate's existing skills section.

ALLOWED — what tailoring means:
1. REORDER bullets within a role to lead with the most JD-relevant.
2. REPHRASE bullets using vocabulary from the JD (e.g. if JD says "zero-trust segmentation" and CV says "network segmentation", you can rephrase to match — only if it's the same concept).
3. TRIM less-relevant bullets (you don't have to include every bullet from cv.md).
4. REWRITE the summary to lead with the archetype that best matches this role.
5. PRUNE the skills list to the ~15 most JD-relevant skills (from the candidate's actual skill set).
6. REORDER experience entries — usually keep reverse chronological, but for early-career candidates the most relevant role can lead.

OUTPUT structure:
- headline: a 1-line professional headline tuned to the role
- summary: 2-3 sentence summary tuned to the archetype
- experience: array of roles with bullets rewritten/reordered/trimmed
- skills: pruned skill list (still grouped, ~15 items)
- notes: 2-3 sentence explanation of what you tailored and why

VERIFICATION: After writing each bullet, mentally check: "Could the candidate honestly defend this in an interview given what's in their cv.md?" If no, revise or drop it.`;

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
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

async function fetchJD(url, fallbackCompany, fallbackTitle) {
  const ghMatch = url.match(/(?:job-boards\.greenhouse\.io|boards\.greenhouse\.io)\/([^/]+)\/jobs\/(\d+)/);
  if (ghMatch) {
    const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${ghMatch[1]}/jobs/${ghMatch[2]}`);
    if (r.ok) {
      const j = await r.json();
      return { title: j.title || fallbackTitle, company: ghMatch[1].replace(/-/g, ' '), content: stripHtml(j.content || '') };
    }
  }
  const leverMatch = url.match(/jobs\.lever\.co\/([^/]+)\/([0-9a-f-]+)/);
  if (leverMatch) {
    const r = await fetch(`https://api.lever.co/v0/postings/${leverMatch[1]}/${leverMatch[2]}`);
    if (r.ok) {
      const j = await r.json();
      return { title: j.text || fallbackTitle, company: leverMatch[1], content: stripHtml(j.descriptionPlain || j.description || '') };
    }
  }
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (career-ops/1.0)' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching JD`);
  const html = await r.text();
  return { title: fallbackTitle, company: fallbackCompany, content: stripHtml(html).slice(0, 30000) };
}

function renderTailoredMarkdown(t, candidate) {
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
  if (t.education) {
    lines.push(''); lines.push('## Education'); lines.push(''); lines.push(t.education);
  }
  if (t.certifications && t.certifications.length) {
    lines.push(''); lines.push('## Certifications'); lines.push('');
    for (const c of t.certifications) lines.push(`- ${c}`);
  }
  if (t.skills && t.skills.length) {
    lines.push(''); lines.push('## Skills'); lines.push('');
    for (const s of t.skills) lines.push(`- ${s}`);
  }
  return lines.join('\n');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      res.status(500).json({ error: 'Server missing ANTHROPIC_API_KEY env var' });
      return;
    }
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { url, company, title, archetype, evalResult } = body;
    if (!url) { res.status(400).json({ error: 'Missing url' }); return; }

    const ctx = loadContext();
    const jd = await fetchJD(url, company || '', title || '');

    const stableUserContext = `# Candidate Source-of-Truth

## cv.md (the ONLY source of facts allowed)

${ctx.cv}

## Profile (config/profile.yml)

\`\`\`yaml
${ctx.profile}
\`\`\`

## Archetype Mapping (modes/_profile.md)

${ctx.profileMd}`;

    const volatile = `# Tailoring Brief

**Company:** ${jd.company || company || ''}
**Title:** ${jd.title || title || ''}
**Best-fit archetype:** ${archetype || '(infer from cv.md + JD)'}
${evalResult ? `\n**Strengths to emphasize (from prior eval):**\n${(evalResult.strengths || []).map(s => '- ' + s).join('\n')}\n\n**Concerns to address (gaps):**\n${(evalResult.concerns || []).map(s => '- ' + s).join('\n')}\n` : ''}

## Job Description

${jd.content}

---

Tailor the candidate's CV for this role. Return JSON conforming to the schema. Remember: NEVER invent. Only reorder, rephrase using JD vocabulary, and trim. Every claim must be verifiable in cv.md above.`;

    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: stableUserContext, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: volatile },
          ],
        },
      ],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    });

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) throw new Error('No text content in model response');
    const result = JSON.parse(textBlock.text);

    // Quick render to markdown
    let candidate = {};
    try {
      const yamlMatch = ctx.profile.match(/candidate:[\s\S]*?(?=\n[a-z_]+:|\n\n|$)/);
      if (yamlMatch) {
        const lines = yamlMatch[0].split('\n');
        for (const l of lines) {
          const m = l.match(/^\s+(\w+):\s*"?([^"]+?)"?\s*$/);
          if (m) candidate[m[1]] = m[2];
        }
      }
    } catch {}

    const markdown = renderTailoredMarkdown(result, candidate);

    res.status(200).json({
      ok: true,
      tailored: result,
      markdown,
      usage: {
        input: response.usage.input_tokens,
        cache_write: response.usage.cache_creation_input_tokens || 0,
        cache_read: response.usage.cache_read_input_tokens || 0,
        output: response.usage.output_tokens,
      },
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      res.status(err.status || 500).json({ error: `Anthropic ${err.status}: ${err.message}` });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
}

export const config = { maxDuration: 60 };
