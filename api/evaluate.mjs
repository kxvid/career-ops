// Vercel serverless function: POST /api/evaluate
// Body: { url: string, company?: string, title?: string }
// Returns: { score, recommendation, tldr, archetype, strengths, concerns,
//           block_a_role_summary, block_b_cv_match, block_c_gaps,
//           block_d_interview_difficulty, block_e_cover_letter_draft,
//           block_g_legitimacy, block_g_legitimacy_reasoning, jd_excerpt }
//
// Requires ANTHROPIC_API_KEY in Vercel project env vars.
// Reads CV/profile/modes from the bundle at build time.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// -- Static prompt assets read once at cold-start ---------------------------
let CACHED_CONTEXT = null;
function loadContext() {
  if (CACHED_CONTEXT) return CACHED_CONTEXT;
  CACHED_CONTEXT = {
    cv: fs.readFileSync(path.join(ROOT, 'cv.md'), 'utf8'),
    profile: fs.readFileSync(path.join(ROOT, 'config/profile.yml'), 'utf8'),
    profileMd: fs.readFileSync(path.join(ROOT, 'modes/_profile.md'), 'utf8'),
  };
  return CACHED_CONTEXT;
}

const SYSTEM_PROMPT = `You are a senior career coach evaluating a job description against a candidate's profile. You produce a rigorous, structured A-G evaluation following the career-ops methodology.

Return valid JSON conforming to the provided schema. No prose outside the JSON.

Scoring rubric:
- match_score 0-100: 80+ = strong fit, apply with priority. 60-79 = good fit, apply. 40-59 = partial fit, only with specific reason. <40 = SKIP.
- recommendation: "apply" | "maybe" | "skip" — be honest, do not inflate.
- archetype: pick the candidate's best-fit archetype from their profile.
- strengths: 3 specific things from the candidate's CV that match the JD's requirements. Quote CV verbatim.
- concerns: 3 specific gaps. Be honest about hard requirements not met.
- block_a_role_summary: markdown table of role facts.
- block_b_cv_match: markdown table mapping JD requirements to CV evidence (quote CV lines).
- block_c_gaps: markdown bullet list of gaps with mitigation strategy each.
- block_d_interview_difficulty: 1-5 difficulty score with 2-sentence reasoning + likely round structure.
- block_e_cover_letter_draft: 200-word first-person cover letter using the candidate's exit narrative and proof points.
- block_g_legitimacy: "gold" | "silver" | "bronze" | "red"
- block_g_legitimacy_reasoning: 1-2 sentences

When the JD's compensation is below the candidate's floor, lower the recommendation to "skip" unless brand/role compensates strongly. When the JD requires a clearance/citizenship the candidate doesn't have, flag as concern; recommend "maybe" if naturalization timeline allows.`;

const SCHEMA = {
  type: 'object',
  properties: {
    match_score: { type: 'integer' },
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

// -- JD fetch --------------------------------------------------------------
function stripHtml(s) {
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

async function fetchJD(url, fallbackCompany, fallbackTitle) {
  // Greenhouse JSON
  const ghMatch = url.match(/(?:job-boards\.greenhouse\.io|boards\.greenhouse\.io)\/([^/]+)\/jobs\/(\d+)/);
  if (ghMatch) {
    const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${ghMatch[1]}/jobs/${ghMatch[2]}`);
    if (r.ok) {
      const j = await r.json();
      return {
        title: j.title || fallbackTitle, company: ghMatch[1].replace(/-/g, ' '),
        location: j.location?.name || '', content: stripHtml(j.content || ''), url,
      };
    }
  }
  // Lever JSON
  const leverMatch = url.match(/jobs\.lever\.co\/([^/]+)\/([0-9a-f-]+)/);
  if (leverMatch) {
    const r = await fetch(`https://api.lever.co/v0/postings/${leverMatch[1]}/${leverMatch[2]}`);
    if (r.ok) {
      const j = await r.json();
      return {
        title: j.text || fallbackTitle, company: leverMatch[1],
        location: j.categories?.location || '',
        content: stripHtml(j.descriptionPlain || j.description || ''), url,
      };
    }
  }
  // Generic fallback
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (career-ops/1.0)' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching JD`);
  const html = await r.text();
  return {
    title: fallbackTitle, company: fallbackCompany, location: '',
    content: stripHtml(html).slice(0, 30000), url,
  };
}

// -- Handler ----------------------------------------------------------------
export default async function handler(req, res) {
  // CORS for the dashboard
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
    const { url, company, title } = body;
    if (!url) { res.status(400).json({ error: 'Missing url' }); return; }

    const ctx = loadContext();
    const jd = await fetchJD(url, company || '', title || '');

    const stableUserContext = `# Candidate Profile

## CV (cv.md)

${ctx.cv}

## Profile Configuration (config/profile.yml)

\`\`\`yaml
${ctx.profile}
\`\`\`

## Personalization (modes/_profile.md)

${ctx.profileMd}`;

    const volatileJD = `# Job Description to Evaluate

**Company:** ${jd.company || '(unknown)'}
**Title:** ${jd.title || '(unknown)'}
**Location:** ${jd.location || '(unspecified)'}
**URL:** ${jd.url}

## Description

${jd.content}

---

Evaluate this role against the candidate profile above. Return JSON conforming to the schema.`;

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
            { type: 'text', text: volatileJD },
          ],
        },
      ],
      output_config: {
        format: { type: 'json_schema', schema: SCHEMA },
      },
    });

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock) throw new Error('No text content in model response');
    const result = JSON.parse(textBlock.text);

    res.status(200).json({
      ok: true,
      ...result,
      jd_company: jd.company,
      jd_title: jd.title,
      jd_excerpt: jd.content.slice(0, 800),
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
