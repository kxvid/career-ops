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

## Action buttons in the eval modal

After Evaluate finishes, three action buttons appear:

### 1. Save report to repo

Calls `/api/save-report` which uses the GitHub API to commit:
- `reports/{NNN}-{slug}-{date}.md` — the full A-G evaluation as markdown
- `data/applications.md` — appends the row (Score, Status, Report link, etc.)

Vercel auto-redeploys on push, so the dashboard's **Reports** and **Applications** tabs update within ~30s.

**Required env vars on Vercel:**
- `GITHUB_TOKEN` — fine-grained PAT with `Contents: Read and write` on the repo
- `GITHUB_REPO` — `kxvid/career-ops`
- `GITHUB_BRANCH` — `claude/job-application-tracker-M3nL4` (or your default branch once merged)

To create the PAT: <https://github.com/settings/personal-access-tokens/new> → Resource owner = your account → Repository access = Only select repositories (`kxvid/career-ops`) → Repository permissions: **Contents = Read and write**, **Metadata = Read-only** → Generate.

### 2. Tailor my CV for this role

Calls `/api/tailor-cv` which sends `cv.md` + the JD + the eval's archetype/strengths to Claude with a strict prompt and returns a tailored CV markdown.

**The hard constraints baked into the prompt** (and verified by the schema):
- NEVER invent experience, employers, dates, projects, certifications, or skills not in `cv.md`.
- NEVER change metrics — if `cv.md` says "200+ endpoints", the tailored version says "200+ endpoints", not "300+" or "thousands".
- NEVER change titles, dates, or company names.

What it CAN do:
- Reorder bullets within a role to lead with the most JD-relevant.
- Rephrase bullets using JD vocabulary (only when the underlying fact is the same).
- Trim less-relevant bullets.
- Rewrite the summary to lead with the archetype that matches.
- Prune skills to ~15 most JD-relevant.

The output drops into a two-pane editor:
- **Left**: editable markdown textarea — tweak anything before exporting
- **Right**: live HTML preview, updates as you type
- **Download .md** — the textarea content as a markdown file
- **Download .html** — the live preview wrapped in a styled, printable HTML document. Open it and use Cmd/Ctrl+P → "Save as PDF" for an ATS-friendly PDF without needing Playwright
- **Copy** — markdown to clipboard
- **Revert** — restore the original tailored output

### 3. Mark as applied

Saves your decision in `localStorage` and updates the row's status. Once you push the report to the repo (button 1), the Gmail sync will start tracking recruiter replies for that role.

## Status Log tab

A unified timeline of every status event across the pipeline, sourced from:

- **Manual entries** — log a status update (Applied / Phone Screen / Interview / Offer / Rejected / Note) per application via the form at the top of the tab. Stored in `localStorage`.
- **Decisions** — your 👍 / 👎 / ✓ / ✗ clicks on pipeline rows.
- **Evaluations** — every Evaluate run (with score and TL;DR).
- **Gmail** — auto-detected status changes from recruiter replies (once Gmail sync is configured per `GMAIL_SETUP.md`).
- **Tracker** — current applications.md state.

Filter by source or search by company/role/note. **Export TSV** dumps the full unified log for archival, analysis, or import into a spreadsheet.

This is your "what's happening across all my applications" view — chronological, every signal, in one place.

## Local CLI

All three actions also work from the terminal:

```bash
node evaluate.mjs <url>          # eval + writes report locally + tracker entry
node tailor-cv.mjs <url>         # tailor CV locally → output/cv-{slug}-{date}.md
node tailor-cv.mjs <url> --report=NNN  # use existing report's archetype
```

The local CLI writes directly to disk; no GitHub PAT needed. After a `git push`, Vercel redeploys.

## End-to-end flow (full orchestrator)

1. **Scan**: `node scan.mjs` (or schedule via GitHub Action) populates `data/pipeline.md`.
2. **Score**: dashboard auto-scores every listing 0-100 against your archetypes.
3. **Filter**: set Min fit slider to 50, sort by score.
4. **Evaluate**: click Evaluate on a row. ~30s later you have a structured A-G eval inline.
5. **Save**: click "Save report to repo" — committed to GitHub, applications.md updated, dashboard refreshes.
6. **Tailor**: click "Tailor my CV for this role" — get a JD-specific CV markdown to download.
7. **Apply**: paste tailored CV + cover letter (Block E) into the application form. Hit submit.
8. **Track**: click "Mark as applied". Gmail sync (if enabled) starts watching for replies.
9. **Learn**: after 20+ decisions, export feedback and run `node learn-from-feedback.mjs` to tighten the filter.

## What's still missing

- **PDF tailored CV via API.** Block E gives you a cover letter; the API returns CV markdown; PDF generation still needs Playwright locally (`node generate-pdf.mjs`). Vercel functions can run Playwright but the bundle is heavier — doable as a follow-up if you want one-click PDF.
- **Decisions persistence across devices.** Decisions still live in `localStorage` on the device. To sync across browsers, decisions would need to commit to applications.md status updates — straightforward extension of `/api/save-report`.
- **Auto-redeploy lag.** Vercel redeploy after a commit takes ~30s. If you click Evaluate on the same row immediately after saving, the cached result still shows from localStorage — that's fine.

The orchestrator shape is now in place: every row in the dashboard can become a tracked, evaluated, tailored, applied-to job entirely through the UI.
