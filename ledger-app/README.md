# Ledger — Supplier Link Tracker

A Next.js app for tracking activation links by supplier and batch, so
expired links can be traced back to whoever sold them to you for a refund
claim.

Data is stored in a real database (Redis via Upstash), so it's the same
ledger whether you open it from your laptop or your phone. No password
gate — the app is open to anyone with the URL.

## What's inside

- `app/page.js` — the whole UI (suppliers, types, batches, links, filters, CSV export, link testing)
- `app/api/data/route.js` — reads/writes your ledger data in Redis
- `app/api/check-link/route.js` — visits a link server-side and checks for "already used" text
- `app/globals.css` — styling

## Features

- **Suppliers**: who sold you each batch of links.
- **Types** (optional, per batch): group links by product (Gemini Pro,
  Netflix, etc.). Each type can store comma-separated phrases that appear
  on that service's page when a link is already used — used by the Test
  button.
- **Bulk paste**: paste any text into the batch form — numbered lists,
  bot messages, extra formatting — and every `http://` / `https://` link
  in it is picked out automatically.
- **Test / Test all links**: visits a link from the server and checks the
  page for common "already used" phrases (plus any you set for its type).
  This is a best-effort heuristic, not a guarantee — some activation
  pages (including some of Google's) render their status with
  JavaScript, which a server-side check can't see. A clean result means
  "no used-link text found," not "confirmed working." Keep verifying
  anything you're about to act on for a refund claim.

## 1. Push it to GitHub

From inside this folder (the one that directly contains `package.json`
and `app/`):

```bash
git init
git add .
git commit -m "Initial commit: ledger app"
gh repo create ledger-app --private --source=. --push
# (or create a repo on github.com and `git remote add origin ...` + `git push`)
```

`package.json` and `app/` need to sit at the root of whatever folder you
push — see Troubleshooting below if you hit a build error about this.

## 2. Deploy on Vercel

1. Go to https://vercel.com/new and import the GitHub repo.
2. Keep the defaults (Vercel auto-detects Next.js) and click **Deploy**.

Your first deploy will 500 on the data endpoint until you add the database
in the next step — that's expected.

## 3. Add the database

The free tier is easiest to set up directly through Upstash rather than
Vercel's Marketplace flow:

1. Go to https://upstash.com, sign up, and create a **Redis** database on
   the **Free** plan.
2. On the database's page, copy `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN` from the REST API section.
3. In your Vercel project: **Settings → Environment Variables**, add both
   as variables (matching those exact names), targeting Production.
4. Redeploy: **Deployments → ⋯ on the latest one → Redeploy**.

## Local development

```bash
npm install
# create .env.local with UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN
npm run dev
```

## Troubleshooting

**Build error: "Couldn't find any `pages` or `app` directory"**

This means Vercel is looking for `app/` in the wrong place — almost
always because the repo has an extra folder wrapping the project (e.g.
your repo root contains `ledger-app/app/` instead of just `app/`).

Fix either by:
- Moving the contents of the inner folder up to the repo root and
  pushing again, **or**
- In Vercel: Project → **Settings → General → Root Directory**, set it
  to the subfolder name (e.g. `ledger-app`) instead of leaving it blank,
  then redeploy.

**Site looks unchanged after pushing new files**

- Check the **Deployments** tab for a new one matching your latest
  commit, and that it says **Ready**.
- Hard-refresh the page (Ctrl/Cmd+Shift+R) or open it in a private
  window — this is often just a cached copy in your browser.

## Extending it

- **A password or login**: this version has none — anyone with the URL
  can see and edit the data. If that matters, the simplest fix is a
  shared password via middleware, or real per-person accounts (e.g.
  NextAuth) if more than one person needs separate access.
- **Supplier notes/contact info**: add fields to the supplier object in
  `app/page.js` (`addSupplier`) — the database just carries them along,
  no migration needed since it's schemaless JSON.
- **Editing existing batches**: right now you can delete a batch but not
  edit its product name or price after creation — straightforward to add
  if you need it.

