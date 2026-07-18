# LeetCode Progress — Admin + Student app

A small web app for tracking college students' LeetCode progress and assigning practice problems. It has **two sides**:

- **Admin** (`/`) — open on the machine that runs the app. Upload rosters, sync stats, assign practice, manage everything, set the per-college student access code.
- **Student** (`/student`) — gated by a college access code. A student picks their college, enters the code, picks their name, and sees **only** their own stats + a class leaderboard, plus the **practice questions** to solve. No admin controls. If their name isn't listed, they can **add themselves** (name + LeetCode profile) — it's gated by the same code, deduplicated by username, and appears on the admin roster right away.

How data flows:

- Upload a student roster (Excel: `Name`, `LeetCode Profile`).
- Each public profile is read for **global rank**, **Easy / Medium / Hard / Total solved**, and a **monthly submission** breakdown — either by the built-in server-side scraper *or* by your Chrome extension pushing data in (see below).
- A **Practice** tab lets you assign LeetCode problem links. When a student solves an assigned problem, it's detected on the next sync/push and shown as completed.
- Everything is grouped per college and stored locally in SQLite.

## The two sides at a glance

| | Admin (`/`) | Student (`/student`) |
|---|---|---|
| Who | You, on the host machine | Students, with the access code |
| Login | None (local access) | College + access code + their name |
| Can see | Everything, all students | Their own stats + class leaderboard + practice list |
| Can do | Upload, sync, assign/delete practice, set code | View only; click a problem to solve it on LeetCode |

**Share a read-only view of one college:** Admin → Colleges tab → "Get link" on a college row → copy the `/view/<token>` URL and send it. Whoever opens it sees that college's dashboard (totals, student table, monthly chart) and assigned-problem completion — read-only, scoped to that college, no login, auto-refreshing every 30s. Use "↻" to rotate the token, which invalidates the old link. Note: because the admin API is itself unauthenticated, the token is for a clean scoped page, not a strong security boundary — treat the link as semi-public.

**Set up a college so students can log in:** Admin → **Colleges tab** → "Add a college" → enter the college name + an access code (e.g. `ABC-2026`) → Add. Then go to the **Upload tab** and upload that college's roster — students log in by picking their name, so a code with no roster has nobody to pick. (You can also set/replace a code from the Colleges table or the Dashboard tab.) Share the code + the `/student` URL with the cohort. The code is never exposed by any endpoint — only a "code is set" flag — so you can overwrite it but not read it back.

---

## Read this first — what is and isn't possible

This is the honest part. It changes what you should expect.

1. **No real-time "on click" updates.** LeetCode has no official API and no webhooks. The app *polls* each student's public profile and matches assigned problems against their **recent accepted submissions**. Completion shows up on a sync, not the instant a student clicks "Accepted".

2. **Only recent solves are visible.** The recent-submissions list LeetCode exposes is short (~20). If a student solved an assigned problem long ago, it may not appear until they submit again. Best results when you assign problems *then* have students solve them.

3. **It relies on an unofficial endpoint.** The app talks to `leetcode.com/graphql` (the same one the site uses). It can rate-limit or IP-block you, and may change without notice. Keep the roster modest and the poll interval sane. This is fine for an internal tool; don't promise anyone uptime.

4. **"Questions solved per month by difficulty" builds up over time.** LeetCode gives a daily *submission* calendar (shown as the monthly chart) and *current* totals by difficulty — but not historical per-month solved-by-difficulty. The app stores a snapshot on every sync and computes per-month growth by diffing them, so that table fills in as the app keeps running.

5. **Profiles must be public.** Private profiles show up as "private / not found".

---

## Requirements

- **Node.js 18 or newer** (macOS, Windows, or Linux).
- Internet access to `leetcode.com`.

## Install & run

```bash
cd "Leetcode course"
npm install
npm start
```

Then open **http://localhost:3000**.

`npm install` builds `better-sqlite3` (prebuilt binaries download automatically on macOS/Windows/Linux). If that build ever fails, the app automatically falls back to Node's built-in SQLite — in that case run with Node 22.5+ like this:

```bash
node --experimental-sqlite src/server.js
```

## How to use it

1. **Upload tab** → enter a college name, choose your Excel file (`samples/students_sample.xlsx` is a working example), click **Upload & sync**. A background sync starts immediately.
2. **Dashboard tab** → pick the college in the top-right selector. See totals, the monthly submission chart, and the ranked student table. Click any student for a detail drawer (monthly chart, per-month solved growth, practice status). Use **⟳ Sync now** to refresh on demand, or the small ⟳ on a row to sync one student.
3. **Practice tab** → paste LeetCode problem links (one per line) or upload an Excel with a `URL` column (`samples/practice_sample.xlsx`). The table shows how many students have solved each problem.

## Using Supabase (cloud database)

By default the app stores everything in a local SQLite file. You can switch the **database** to Supabase (cloud Postgres) with an env toggle — the Node server, scraper, scheduler, and extension all stay exactly the same. (Auth and Realtime are planned next phases and are *not* wired up yet; the keys for them are in `.env.example` ahead of time.)

What you do (I can't do this part — it needs your project):

1. Create a project at supabase.com.
2. Get the **connection string**: Project Settings → Database → Connection string → **URI** (use the pooler URI). Put it in `.env` as `SUPABASE_DB_URL`.
3. Set `DB_DRIVER=supabase` in `.env`.
4. Start with the env file loaded:

   ```bash
   cp .env.example .env      # then edit .env
   npm run start:env
   ```

On first boot the server connects and **creates the tables automatically** (it runs `db/schema.supabase.sql`, which is idempotent). You can also paste that file into the Supabase SQL editor yourself if you prefer.

To go back to local SQLite, set `DB_DRIVER=sqlite` (or just run `npm start`).

Notes / honest caveats:

- This swaps the **database** only. The unauthenticated-admin-API caveats elsewhere in this README still apply until the Auth phase lands.
- The whole data layer is now async and was regression-tested on the SQLite path (18 checks). The Postgres path is code-complete but should be smoke-tested against your live project the first time you connect — tell me if anything errors and I'll fix the dialect.
- `SUPABASE_DB_URL` is a secret (it contains your DB password). Keep it in `.env`, which is git-ignored.

## Using your Chrome extension as the scraper (recommended)

The `Leetcode/` extension folder scrapes LeetCode **from your own logged-in browser** — this avoids server-side IP blocking and is the more reliable way to fetch data. It now talks to this dashboard directly.

1. Load the extension: Chrome → `chrome://extensions` → enable Developer mode → **Load unpacked** → select the extension folder.
2. Start this dashboard (`npm start`) and, in the admin UI, upload a roster and assign practice problems for a college.
3. Open the extension popup:
   - **Dashboard URL** is `http://localhost:3000` by default → click **Connect** → pick the college.
   - Click **Load roster + questions** — it pulls the profiles and practice slugs from the dashboard into the boxes.
   - Click **Run Bulk Check** to scrape.
   - Click **⬆ Push results to Dashboard** — stats, monthly activity, and practice completions land in the dashboard.
4. **Export CSV** still works; the dashboard can also ingest that CSV via `POST /api/import-csv` if you prefer files over a live push.

Notes:
- The extension's manifest allows `http://localhost:3000`. If you run the dashboard on another port/host, add it to `host_permissions` in `Leetcode/manifest.json`.
- Pushing requires the dashboard to be running at that moment.
- This and the server-side scraper write the same tables — use either or both. If you rely solely on the extension, you can quiet the server scraper with `POLL_ON_STARTUP=false` and a long `POLL_CRON`.

## Auto-poll (scheduler)

The app re-syncs every student and re-checks practice completions automatically. Default: **every hour**. Change it with environment variables:

```bash
POLL_CRON="*/30 * * * *" npm start     # every 30 minutes
POLL_ON_STARTUP=false npm start         # don't sync on boot
```

## Configuration (environment variables)

| Variable           | Default        | Meaning                                                        |
|--------------------|----------------|----------------------------------------------------------------|
| `PORT`             | `3000`         | Web server port                                                |
| `POLL_CRON`        | `0 * * * *`    | Auto-poll schedule (cron syntax)                               |
| `POLL_ON_STARTUP`  | `true`         | Run one sync a few seconds after boot                          |
| `LC_DELAY_MS`      | `1500`         | Delay between profile fetches (raise this if you get blocked)  |
| `LC_RECENT_LIMIT`  | `20`           | How many recent accepted submissions to scan per student       |
| `DB_PATH`          | `data/app.db`  | SQLite file location                                           |
| `LC_MOCK`          | `false`        | Use fake data (no network) to demo the UI                      |

To preview the whole app with no internet / no real scraping:

```bash
LC_MOCK=true npm start
```

## Manual refresh from the terminal

```bash
npm run refresh
```

## Project layout

```
src/
  server.js      Express app entry (+ CORS for the extension, /student route)
  routes.js      REST API (upload, dashboard, practice, sync, ingest, student login)
  db.js          SQLite schema + all queries (incl. access_code migration)
  sqlite.js      Driver selector (better-sqlite3 → node:sqlite fallback)
  leetcode.js    Unofficial GraphQL client + URL/username parsing (+ mock data)
  sync.js        Polling engine: refresh stats + match practice completions
  ingest.js      Accept scraped results from the extension / CSV
  scheduler.js   node-cron auto-poll
public/
  index.html/app.js    Admin SPA (dashboard + practice + upload + access code)
  student.html/student.js  Student SPA (login + own stats + leaderboard + practice)
  styles.css           Shared styling
samples/         Example roster and practice spreadsheets
data/            SQLite database (created on first run)

Key APIs: `POST /api/ingest` (extension push), `GET /api/colleges/:id/scrape-config`
(extension pull), `POST /api/import-csv`, `POST /api/student/login`,
`GET /api/student/:id/dashboard?code=…`, `POST /api/colleges/:id/access-code`.
```

## Notes & limits

- Data lives in `data/app.db`. Delete it to reset everything.
- This is a single-admin local tool — there's no login/auth. Don't expose it to the public internet as-is.
- If a sync reports failures, you're likely being rate-limited: increase `LC_DELAY_MS` and/or lengthen `POLL_CRON`.
