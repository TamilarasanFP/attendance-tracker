# Attendance Tracker (Node.js)

Employee attendance app with two sides:

- **Employee Check-in** — enter Employee ID (the name **auto-fills from the roster** if the ID is registered), pick Start/End of day, **open the camera and take a photo**. The current date & time is stamped onto the photo and recorded automatically.
- **Admin Dashboard** — two tabs:
  - **Attendance** — pick a date and see every registered employee mapped to their attendance for that day: Start, End, Worked, a **Present / Partial / Absent** status, and the stored photos. Absentees (registered but no check-in) are flagged; check-ins from IDs not in the roster show as **walk-in**.
  - **Employees** — the master roster. Add employees one at a time or **bulk-import** `Name, EmployeeID` lines. Remove employees (their past records are kept).

## Run

```bash
npm install
ADMIN_PASSWORD=yourSecret npm start
```

(Without `ADMIN_PASSWORD` it falls back to the default `admin123` and prints a warning — fine for testing, change it for real use.)

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
4. The image is saved under `data/photos/`, and the record (name, id, type, date, time) is saved to `data/records.json`.

The timestamp comes from the moment of capture — not from reading text off the image — so it's reliable and needs no OCR.

## Data & storage

- Records: `data/records.json`
- Photos: `data/photos/<id>.jpg`
- **Clear all records** also deletes the associated photos.

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

## Data files

- `data/records.json` — attendance records
- `data/employees.json` — the roster (`{ empId, name }`)
- `data/photos/` — stored capture images

## Tests

```bash
npm test   # in-process smoke test: validation, storage, skew rejection, photo retrieval, traversal guard
```

## Production gaps (not yet done)

- **Sessions are in-memory** — restarting the server logs the admin out. Fine for one instance; use a session store for multi-instance.
- **JSON file store** — fine for one server; move to SQLite/Postgres for real load.
- **HTTPS** — required for camera access off localhost, and for the login cookie to be truly safe in transit. Add `Secure` to the cookie once you're on HTTPS.
