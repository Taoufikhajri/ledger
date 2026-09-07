# Ledger — Supplier Link Tracker

A Next.js app for tracking activation links by supplier and batch, so
expired links can be traced back to whoever sold them to you for a refund
claim.

Data is stored in a real database (Redis via Vercel's Marketplace), so
it's the same ledger whether you open it from your laptop or your phone.
No password gate — the app is open to anyone with the URL.

## What's inside

- `app/page.js` — the whole UI (suppliers, batches, links, filters, CSV export)
- `app/api/data/route.js` — a tiny API that reads/writes your data in Redis
- `app/globals.css` — styling

## 1. Push it to GitHub

Unzip this project first. Then, **from inside that unzipped folder**
(the one that directly contains `package.json` and `app/`):

```bash
git init
git add .
git commit -m "Initial commit: ledger app"
gh repo create ledger-app --private --source=. --push
# (or create a repo on github.com and `git remote add origin ...` + `git push`)
```

This matters: `package.json` and `app/` need to sit at the **root of the
repo**, not inside a subfolder — see Troubleshooting below if you hit a
build error about this.

## 2. Deploy on Vercel

1. Go to https://vercel.com/new and import the GitHub repo.
2. Keep the defaults (Vercel auto-detects Next.js) and click **Deploy**.

Your first deploy will 500 on the data endpoint until you add the database
in the next step — that's expected.

## 3. Add the database

1. In your Vercel project, go to the **Storage** tab.
2. Click **Create Database** (or **Marketplace**) → choose a **Redis**
   option (Upstash-backed, has a free tier).
3. Connect it to your project when prompted — this automatically adds
   `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` /
   `UPSTASH_REDIS_REST_TOKEN`) environment variables for you. The app
   reads either naming.
4. Redeploy (Vercel usually prompts you to; otherwise go to
   **Deployments → ⋯ → Redeploy**).

## Local development

```bash
npm install
vercel env pull .env.local   # requires the Vercel CLI, pulls your DB credentials
npm run dev
```

Without those DB env vars set locally, `/api/data` will error — either
pull them as above, or just develop against the deployed version.

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
