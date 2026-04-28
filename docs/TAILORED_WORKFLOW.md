# Tailored Workflow (Job Board + CV Optimizer + Applier Pack)

This workflow gives you one-command orchestration on top of existing career-ops scripts and data files.

## What it does

- Builds a **tailored job board** from `data/pipeline.md`, ranked against role signals in `config/profile.yml`.
- Optionally runs the existing zero-token scanner first (`scan.mjs`).
- For a selected job, fetches the JD page and extracts high-signal keywords.
- Compares those keywords against `cv.md` and produces a **CV optimizer brief**.
- Produces an **application pack** with reusable, personalized draft answers.

All output files are written to `output/` and are meant for review + manual use.

## Command

```bash
npm run tailor -- --scan --top=20 --job=1
```

## Flags

- `--scan` : run `scan.mjs` before ranking jobs.
- `--top=N` : number of ranked jobs in the board (default: 15).
- `--job=<index|url>` : select a job from the ranked list for CV/application assets.

## Generated files

- `output/tailored-job-board.md`
- `output/cv-optimizer-{company}-{role}.md`
- `output/applier-pack-{company}-{role}.md`

## Notes

- The ranking is deterministic keyword-fit, not LLM scoring.
- The workflow prepares targeted materials but **never submits an application**.
- For full A–G evaluation reports and tracker entries, continue using the existing career-ops modes/pipeline flow.
