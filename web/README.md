# Career-Ops Dashboard

A self-contained static dashboard that renders your CV, profile, scanned pipeline, applications tracker, and evaluation reports — all from the markdown/YAML files in this repo.

## New: Web-native Apply Assist (no local runtime)

Once deployed to Vercel, the dashboard includes an **Apply Assist** tab:

1. Pick a listing from your pipeline.
2. Click **Copy Autofill Bookmarklet**.
3. Save that bookmarklet in your browser.
4. Open the target application form and click the bookmarklet.

It fills common fields (name, email, phone, LinkedIn, location, why-role/company text) and highlights submit buttons.

**Safety:** it never submits the application for you; final submit is always manual.

## Local preview (no deploy needed)

```bash
node web/build.mjs
open web/index.html       # macOS
xdg-open web/index.html   # Linux
start web/index.html      # Windows
```

The output is a single self-contained HTML file. No backend required.

## Deploy to Vercel

The repo ships with a `vercel.json` at the root that tells Vercel:

- Run `npm install && node web/build.mjs` on every deploy (regenerates the dashboard from the latest data).
- Serve from `web/`.

### Option 1 — One-click import

1. Go to <https://vercel.com/new>.
2. Import this repo (`kxvid/career-ops`).
3. **Production branch**: pick `claude/job-application-tracker-M3nL4` (or your default branch once merged).
4. Leave defaults — `vercel.json` handles the rest.
5. Click **Deploy**.

You'll get a URL like `career-ops-{hash}.vercel.app`.

### Option 2 — Vercel CLI

```bash
npm i -g vercel
vercel login
vercel --prod
```

## Refreshing the data

The dashboard is regenerated at build time. To refresh:

```bash
node scan.mjs           # pull new listings into data/pipeline.md
node web/build.mjs      # rebuild web/index.html
git add data/ web/
git commit -m "refresh dashboard"
git push                # Vercel auto-redeploys on push
```

## Privacy

The dashboard inlines `cv.md`, `config/profile.yml`, `data/applications.md`, and `data/pipeline.md` into a single HTML file. **Anyone with the deployed URL can read all of it.** Two options:

1. Keep the Vercel deployment **private** (Vercel SSO / password protection on Pro plan).
2. Skip Vercel and just open `web/index.html` locally.

Don't deploy to a public URL unless you're comfortable with that data being public.
