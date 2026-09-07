# Ledger — Supplier Link Tracker

A Next.js app for tracking activation links by supplier and batch, so
expired links can be traced back to whoever sold them to you for a refund
claim.

Unlike a plain static page, this version stores data in a real database
(Vercel KV), so it's the same ledger whether you open it from your laptop
or your phone. It's also gated behind a password so it isn't public to
anyone who finds the URL.

## What's inside

- `app/page.js` — the whole UI (suppliers, batches, links, filters, CSV export)
- `app/api/data/route.js` — a tiny API that reads/writes your data in Vercel KV
- `middleware.js` — a password gate (Basic Auth) using an environment variable
- `app/globals.css` — styling

## 1. Push it to GitHub

```bash
cd ledger-app
git init
git add .
git commit -m "Initial commit: ledger app"
gh repo create ledger-app --private --source=. --push
# (or create a repo on github.com and `git remote add origin ...` + `git push`)
```

## 2. Deploy on Vercel

1. Go to https://vercel.com/new and import the GitHub repo.
2. Keep the defaults (Vercel auto-detects Next.js) and click **Deploy**.

Your first deploy will actually 500 on the data endpoint until you add the
database in the next step — that's expected.

## 3. Add the database (Vercel KV)

1. In your Vercel project, go to the **Storage** tab.
2. Click **Create Database** → choose **KV** (built on Upstash Redis, has a
   free tier).
3. Connect it to your project when prompted — this automatically adds the
   `KV_REST_API_URL` / `KV_REST_API_TOKEN` environment variables for you.
4. Redeploy (Vercel usually prompts you to; otherwise go to
   **Deployments → ⋯ → Redeploy**).

## 4. Set a password

1. Project → **Settings → Environment Variables**.
2. Add `APP_PASSWORD` with whatever password you want to use.
3. Redeploy.

When you visit the site, your browser will prompt for a username (anything
works) and password (what you set). Leave `APP_PASSWORD` unset if you don't
want the gate at all.

## Local development

```bash
npm install
cp .env.example .env.local   # then fill in APP_PASSWORD if you want the gate locally
npm run dev
```

Note: locally, without KV env vars set, the `/api/data` route will error.
Either pull your Vercel env vars locally (`vercel env pull .env.local`
after installing the Vercel CLI) or just develop against the deployed
version.

## Extending it

- **Multiple people/logins**: the current gate is one shared password for
  anyone who has the URL. If you want per-person accounts, that's a bigger
  change (real auth, e.g. NextAuth) — worth doing if more than one person
  needs to use this.
- **Supplier notes/contact info**: add fields to the supplier object in
  `app/page.js` (`addSupplier`) and the KV data will just carry them along,
  no migration needed since it's schemaless JSON.
- **Editing existing batches**: right now you can delete a batch but not
  edit its product name or price after creation — straightforward to add
  if you need it.
