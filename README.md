# Attendance Tracker (Node.js)

Employee attendance app with two sides:

- **Employee Check-in** — enter Employee ID (the name **auto-fills from the roster** if the ID is registered), pick Start/End of day, **open the camera and take a photo**. The current date & time is stamped onto the photo and recorded automatically.
- **Admin Dashboard** — two tabs:
  - **Attendance** — pick a date and see every registered employee mapped to their attendance for that day: Start, End, Worked, a **Present / Partial / Absent** status, and the stored photos. Absentees (registered but no check-in) are flagged; check-ins from IDs not in the roster show as **walk-in**.
  - **Employees** — the master roster. Add employees one at a time or **bulk-import** `Name, EmployeeID` lines. Remove employees (their past records are kept).

Data is stored in **Supabase** (Postgres for records + roster, Storage for photos).

## Setup (one time)

1. **Create the tables + bucket.** In your Supabase project open **SQL Editor → New query**, paste the contents of [`supabase_setup.sql`](./supabase_setup.sql), and Run. (It also creates the private `attendance-photos` storage bucket.)
2. **Get your keys.** Supabase → **Project Settings → API**. You need the **Project URL** and the **`service_role`** key (under "Project API keys").
3. **Configure `.env`.** Copy the template and fill it in:
   ```bash
   cp .env.example .env
   ```
   Then edit `.env`:
   ```
   SUPABASE_URL=https://YOUR-ref.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   SUPABASE_BUCKET=attendance-photos
   ADMIN_PASSWORD=yourSecret
   ```
   > 🔐 The `service_role` key is full admin access to your database. Keep it in `.env` only — never commit it, never share it. `.env` is git-ignored.

## Run

```bash
npm install
npm run checkdb   # verifies the Supabase connection, tables, and bucket
npm start
```

`checkdb` should print three ✓ lines. If it errors, re-check step 1 (SQL was run) and your keys.

### URLs

| URL | Who | Purpose |
|-----|-----|---------|
| `http://localhost:3000/` | employees | check-in page (public, no password) |
| `http://localhost:3000/admin/login` | admin | password login |
| `http://localhost:3000/admin` | admin | dashboard (redirects to login if not signed in) |

## Admin login

- Password-only login (set via the `ADMIN_PASSWORD` env var). Checked with a timing-safe compare.
- On success the server sets an **httpOnly** session cookie that lasts 8 hours; "Log out" clears it.
- The dashboard, CSV export, record data, **and the stored photos** all require a valid session — none are public.

> Live camera capture requires a **secure context**: `localhost` works out of the box. If employees connect from their phones over a plain `http://<lan-ip>` address, the browser will block the camera — you'll need to serve over HTTPS (e.g. a reverse proxy or an `ngrok`/`cloudflared` tunnel).

## How attendance is captured

1. Employee opens the camera in the browser and taps **Capture photo**.
2. The app draws the current timestamp onto the captured frame and sends it to the server along with the capture time.
3. The server **validates the capture time against its own clock** (rejects if the device clock is off by more than 5 minutes) so attendance can't be back/post-dated.
4. The image is uploaded to the **Supabase Storage** bucket, and the record (name, id, type, date, time, timestamps, photo filename) is inserted into the **`records`** table.

The timestamp comes from the moment of capture — not from reading text off the image — so it's reliable and needs no OCR.

## Data & storage

- **`records`** table — attendance records (photo filename referenced, not the bytes).
- **`employees`** table — the roster (`emp_id`, `name`).
- **`attendance-photos`** Storage bucket (private) — the captured images. The admin dashboard streams them through the server; the bucket itself is never public.
- **Clear all records** deletes the rows and removes the associated photos from the bucket.

> ⚠️ You are storing employee photos. That's personal data — put a retention policy and access control in place before using this beyond a prototype.

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/checkin` | public | multipart: `name`, `empId`, `type` (start\|end), `captureTime`, `photo` |
| GET | `/api/lookup/:empId` | public | roster name for an ID (check-in auto-fill) → `{ name }` |
| POST | `/api/admin/login` | public | body `{ password }` → sets session cookie |
| POST | `/api/admin/logout` | — | clears session |
| GET | `/api/day/:date` | admin | all employees mapped to that date, incl. absentees |
| GET | `/api/employees` | admin | list roster |
| POST | `/api/employees` | admin | add/update one `{ name, empId }` |
| POST | `/api/employees/bulk` | admin | body `{ text }` of `Name,EmployeeID` lines |
| DELETE | `/api/employees/:empId` | admin | remove from roster |
| GET | `/api/records` | admin | grouped records (employee × date) |
| GET | `/api/photo/:file` | admin | serve a stored photo |
| GET | `/api/export` | admin | CSV download |
| DELETE | `/api/records` | admin | clear all records + photos |

## Tests

```bash
npm run checkdb   # live check: Supabase connection, table read/write, bucket upload/download
npm test          # offline check: auth, route gating, validation, time helpers (no DB needed)
```

## Production gaps (not yet done)

- **Sessions are in-memory** — restarting the server logs the admin out. Fine for one instance; use a session store for multi-instance.
- **HTTPS** — required for camera access off localhost, and for the login cookie to be truly safe in transit. Add `Secure` to the cookie once you're on HTTPS.
- **RLS policies** — the app relies on the service_role key server-side; tables have RLS enabled with no policies (deny-all to anon). Don't expose the anon key with permissive policies unless you intend to.
