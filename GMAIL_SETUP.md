# Gmail Sync Setup

`gmail-sync.mjs` reads your inbox (read-only) and updates `data/applications.md` status as recruiters reply. It runs locally (or in GitHub Actions) — no third-party server sees your email.

## What it does

- Polls Gmail for messages matching recruiter patterns (configurable date range; default 14 days).
- Classifies each message into `Applied | Responded | Interview | Offer | Rejected` using regex on subject + snippet + sender.
- Matches it to a row in `data/applications.md` by company name (subject substring or sender domain).
- Applies a forward-only status transition (won't downgrade `Interview` to `Applied`, except `Rejected` which is terminal).
- Logs every match to `data/gmail-events.tsv` (timestamps + decisions).
- Saves the last-run timestamp to `data/gmail-state.json`.

## Privacy & scope

- **Scope requested**: `https://www.googleapis.com/auth/gmail.readonly` — read-only access. Cannot send, delete, or modify mail.
- **Where data goes**: stays on your machine (or your GitHub Actions runner). Nothing is sent to Anthropic, the career-ops upstream repo, or any third party.
- **What's stored**: subject, sender, and snippet are written to `data/gmail-events.tsv` for transparency. If you don't want this, don't commit that file (it's gitignored unless force-added).

## One-time setup

### 1. Enable the Gmail API in Google Cloud

1. Go to <https://console.cloud.google.com/>. Sign in with your `kovidrastogi@gmail.com` account.
2. Top-bar → **New Project** → name it `career-ops` → Create.
3. Search **Gmail API** in the top search bar → click it → **Enable**.

### 2. Configure the OAuth consent screen

1. **APIs & Services** → **OAuth consent screen**.
2. **User Type**: External → Create.
3. App name: `career-ops`. User support email: your email. Developer contact: your email. Save & continue.
4. **Scopes**: Add `https://www.googleapis.com/auth/gmail.readonly`. Save.
5. **Test users**: add your own email (`kovidrastogi@gmail.com`). Save.
6. **Publishing status**: leave as `Testing`. Refresh tokens last 7 days in Testing mode — fine for development. To get permanent tokens, hit **Publish App** later (no review needed for `gmail.readonly` if you stay under verification thresholds, but Google may show a "this app isn't verified" warning until you do verify).

### 3. Create the OAuth client

1. **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth client ID**.
2. **Application type**: **Desktop app**. Name: `career-ops-cli`.
3. Click **Create** → **Download JSON**.
4. Save the JSON file in this repo root as `credentials.json`. (It's gitignored.)

### 4. Run the bootstrap

```bash
node gmail-setup.mjs
```

This will:

- Open your browser to Google's auth page.
- After you click **Allow**, redirect back to `http://localhost:53682` where the script catches the code.
- Exchange the code for a refresh token.
- Append `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, and `GMAIL_REFRESH_TOKEN` to `.env` (mode 600).

If you see an "unverified app" warning during Allow, click **Advanced** → **Go to career-ops (unsafe)**. This is normal for Testing mode.

### 5. First sync (dry-run)

```bash
node gmail-sync.mjs --dry-run
```

This won't write anything — it just logs what it would change. Inspect the output, then run for real:

```bash
node gmail-sync.mjs
```

## Recurring sync

### Option A — Local cron (simplest)

```bash
crontab -e
# Every 4 hours:
0 */4 * * * cd /path/to/career-ops && /usr/local/bin/node gmail-sync.mjs && /usr/local/bin/node web/build.mjs >> /tmp/gmail-sync.log 2>&1
```

### Option B — GitHub Action (auto-redeploys Vercel)

The workflow at `.github/workflows/gmail-sync.yml` runs every 6 hours. To enable:

1. Settings → Secrets and variables → **Actions** → New repository secret. Add:
   - `GMAIL_CLIENT_ID`
   - `GMAIL_CLIENT_SECRET`
   - `GMAIL_REFRESH_TOKEN`
2. The workflow file is committed but commented-out by default. Uncomment the `on.schedule` block to enable.
3. The workflow commits status changes back to the branch, which triggers Vercel auto-redeploy.

⚠️ **Caveat**: GitHub Actions secrets are repo-scoped. If your fork is or ever becomes public, anyone with collaborator access can read them indirectly (e.g., by adding a workflow that prints them). Keep the fork private or use a separate fork dedicated to this.

### Option C — Vercel Cron

Possible but more wiring (need to expose a serverless endpoint that imports this script). Skip unless you specifically want it.

## Troubleshooting

**"No refresh_token returned"** — Revoke the app at <https://myaccount.google.com/permissions> and re-run setup. Google only emits a refresh token on first consent.

**"Token expired"** — In Testing mode, refresh tokens expire after 7 days. Either re-run setup, or click **Publish App** in the OAuth consent screen.

**Status not updating for a company** — Check `data/gmail-events.tsv`. If `action=no-match`, the company name in your applications.md doesn't match the email's subject/sender. Either rename the company in applications.md, or extend `matchCompany` in `gmail-sync.mjs` with an alias map.

**False positives** — The classifier prioritizes specific signals (Rejected/Offer) over generic ones. If a "we received your application" email is mis-classified as `Interview`, look at `data/gmail-events.tsv`, find the row, and add an exclusion to the regex in `gmail-sync.mjs`.

## What's not built yet

- Two-way sync (e.g., draft replies, mark-as-read). Out of scope.
- Calendar events for scheduled interviews. Could add via Calendar API if useful.
- Per-company alias mapping. Trivial extension; ask if you want it.
