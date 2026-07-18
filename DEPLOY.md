# Deploying the LeetCode Dashboard (free, on Render)

This app needs a host that keeps a Node process running (for the auto-sync
scheduler and admin sessions). Render's free tier does that. The free instance
**sleeps after ~15 minutes of inactivity** — see "Keeping it awake" below.

Your database is separate (Supabase) and is not deployed here.

---

## Before you start

- [ ] Code is in a **GitHub** repo (steps below if not).
- [ ] You have your **Supabase connection string** (Supabase → Project → Settings → Database → Connection string → URI).
- [ ] You ran `db/schema.supabase.sql` once in the Supabase SQL editor.
- [ ] You know your admin **username** and **password**.

> Never commit `.env`. Secrets go in the Render dashboard, not in git.

---

## 1. Put the code on GitHub (skip if already there)

```bash
cd "your project folder"
git init
git add .
git commit -m "Deploy"
# create an empty repo on github.com first, then:
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

## 2. Create the Render service

1. Sign up at **render.com** (no credit card needed for the free tier).
2. Click **New → Blueprint**.
3. Connect your GitHub and pick this repo. Render reads `render.yaml`.
4. When prompted, paste the three secret values:
   - `SUPABASE_DB_URL` — your Supabase URI connection string
   - `ADMIN_USERNAME`
   - `ADMIN_PASSWORD`
5. Click **Apply / Deploy**.

(No Blueprint? Use **New → Web Service** instead: Build `npm install`,
Start `node src/server.js`, Instance type **Free**, then add the same four
environment variables manually: `DB_DRIVER=supabase` plus the three secrets.)

## 3. Verify

- Open the Render URL (e.g. `https://leetcode-dashboard.onrender.com`).
- The footer should read **DB: Supabase (Postgres)** (green). If it says
  SQLite, your `SUPABASE_DB_URL` is wrong or unset.
- Log into the admin with your username/password.

## 4. Point the Chrome extension at the live URL

In the extension popup, set the dashboard URL to your Render URL (not localhost),
and enter the admin username/password.

---

## Keeping it awake (so auto-sync keeps running on the free tier)

The free instance sleeps when idle, which pauses the 30-second sync. To keep it
awake for free, set up an uptime pinger to hit the URL every ~10 minutes:

1. Go to **uptimerobot.com** or **cron-job.org** (both free).
2. Add an HTTP(s) monitor for `https://<your-app>.onrender.com/api/meta`,
   interval 5–10 minutes.

This keeps the process alive so the scheduler runs. (Or upgrade to Render's
$7/month instance, which never sleeps — cleaner, no pinger needed.)
