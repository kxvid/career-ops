# Career-Ops as a Job Orchestrator

The dashboard is no longer just a viewer. From the **Pipeline** tab, every row has an **Evaluate** button. Click it, Claude reads the JD against your profile, and 15-40 seconds later you get back:

- A 0-100 fit score with apply / maybe / skip recommendation
- 3 specific strengths (with quotes from your CV)
- 3 specific concerns (gaps and risks)
- Block A — role summary
- Block B — CV match table (each JD requirement → CV evidence)
- Block C — gaps with mitigation strategy
- Block D — interview difficulty 1-5 + likely round structure
- Block E — 200-word cover letter draft using your exit narrative
- Block G — posting legitimacy tier (gold / silver / bronze / red)

Evaluations are cached in `localStorage`, so re-clicks are instant. The button text changes to "View (78)" once cached.

## Setup (one time, ~3 minutes)

The Evaluate button calls `/api/evaluate.mjs` (a Vercel serverless function). It needs your Anthropic API key.

1. Get an Anthropic API key at <https://console.anthropic.com>. New accounts get **$5 free credit** — enough for ~50-100 evaluations.
2. In your Vercel dashboard for the `career-ops` project: **Settings → Environment Variables**.
3. Add `ANTHROPIC_API_KEY` = `sk-ant-...` (Production scope).
4. **Redeploy** (Vercel will rebuild with the new env var). Or trigger a redeploy via `git commit --allow-empty -m "redeploy" && git push`.

Done. Click any Evaluate button.

## What the orchestrator does

Behind the button, on each click:

1. **Fetch the JD** — for Greenhouse/Lever URLs, hits the public JSON API directly (no LLM tokens). For other URLs, fetches HTML and strips it.
2. **Build the prompt** with prompt caching:
   - Cached prefix (~5K tokens): system prompt with the A-G rubric, your `cv.md`, your `config/profile.yml`, your `modes/_profile.md` archetype mapping.
   - Volatile suffix (~1-3K tokens): the JD text, company, title.
3. **Call Claude Opus 4.7** with adaptive thinking and JSON-schema structured output. The schema enforces all the blocks so output is always parseable.
4. **Return** the structured result. Dashboard renders it inline in a modal.

First call writes the cache (~$0.04 in tokens). Subsequent calls within 5 minutes hit the cache (~0.1× cost).

## Local CLI alternative

If you want to evaluate from the terminal (and have the report committed to the repo so it shows in the dashboard's Reports tab), use the local CLI instead:

```bash
node evaluate.mjs https://job-boards.greenhouse.io/anthropic/jobs/4887952008
```

This:
- Fetches JD and calls Claude (same prompt as the API)
- Writes a markdown report to `reports/{NNN}-{slug}-{YYYY-MM-DD}.md`
- Adds a row to `data/applications.md` (status: Evaluated)
- Triggers `merge-tracker.mjs` so the tracker stays clean

Then `node web/build.mjs && git push` and the new report appears on the dashboard.

Flags:
- `--no-write` — evaluate only, don't write files
- `--model=claude-sonnet-4-6` — cheaper, faster (recommended for batch runs)
- `--jd-file=path/to/jd.txt --company=X --title=Y` — paste a JD instead of fetching
- `--pipeline-row=42` — also marks pipeline row as evaluated

## Cost guardrails

Each evaluation with Opus 4.7 + adaptive thinking + prompt caching:

| Scenario | Cost |
|----------|------|
| First eval of the session (cache write) | ~$0.04 |
| Subsequent eval within 5 minutes (cache read) | ~$0.01-0.02 |
| Batch of 50 evals back-to-back | ~$1-2 |

To keep costs lower, switch to Sonnet 4.6 in `evaluate.mjs --model=claude-sonnet-4-6` or in `api/evaluate.mjs` (line `model: 'claude-opus-4-7'`). Sonnet is ~3× cheaper and quality is very close for this task.

## Decisions: what they mean

The 4 buttons per pipeline row are now meaningful:

| Button | Meaning |
|--------|---------|
| 👍 Interested | Bookmark for evaluation. Stays in pipeline, hidden by default once any decision is set. |
| 👎 Not interested | Actively wrong fit. Hidden from default view. |
| ✓ Applied | You submitted. Status feeds into Gmail sync — the inbox-watcher will start tracking replies. |
| ✗ Rejected | They passed. Terminal state. |

Decisions persist in `localStorage` (per device). Export them via the **Export feedback (TSV)** button, then run `node learn-from-feedback.mjs feedback.tsv` to learn which keywords correlate with your taste — and update your `portals.yml` filter accordingly.

## What's still missing

- **Auto-commit reports from the API.** The `/api/evaluate` endpoint returns the eval but does not push the markdown report to the repo. To commit a report from Vercel, the function needs a GitHub PAT and a `/api/save-report` endpoint. Skipped for now — easy follow-up.
- **Tailored CV per evaluation.** The cover letter draft is in Block E. The full PDF generation still requires `node generate-pdf.mjs` locally. Building this into the API needs Playwright in the Vercel function, which is heavier.
- **Gmail → Applications still requires `applications.md` to have rows.** The Evaluate button doesn't auto-add to applications.md (no GitHub commit). If you want Gmail to track a role, run the local CLI version instead.

The shape is right; the gaps are infrastructure (PATs, Playwright bundling), not design.
