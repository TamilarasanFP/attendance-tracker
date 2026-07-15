'use strict';

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- admin auth config ----
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
if (ADMIN_PASSWORD === 'admin123') {
  console.warn('\n[WARN] Using the DEFAULT admin password "admin123". ' +
    'Set ADMIN_PASSWORD before real use, e.g.  ADMIN_PASSWORD=yourSecret npm start\n');
}
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const sessions = new Map(); // token -> expiry timestamp

function newSession() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}
function validSession(token) {
  if (!token || !sessions.has(token)) return false;
  if (Date.now() > sessions.get(token)) { sessions.delete(token); return false; }
  return true;
}
function passwordMatches(given) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length) return false;         // timingSafeEqual needs equal length
  return crypto.timingSafeEqual(a, b);
}
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
// Gate: 401 for /api/* requests, redirect to login for page requests.
function requireAdmin(req, res, next) {
  if (validSession(getCookie(req, 'admin_session'))) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated.' });
  return res.redirect('/admin/login');
}

const DATA_DIR = path.join(__dirname, 'data');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const DATA_FILE = path.join(DATA_DIR, 'records.json');
const EMP_FILE = path.join(DATA_DIR, 'employees.json');
for (const d of [DATA_DIR, PHOTO_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');
if (!fs.existsSync(EMP_FILE)) fs.writeFileSync(EMP_FILE, '[]');

// ---- storage helpers (simple JSON file store) ----
function loadRecords() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return []; }
}
function saveRecords(records) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(records, null, 2));
}

// ---- employee roster (master list, keyed by employee id) ----
function loadEmployees() {
  try { return JSON.parse(fs.readFileSync(EMP_FILE, 'utf8')); }
  catch (e) { return []; }
}
function saveEmployees(list) {
  fs.writeFileSync(EMP_FILE, JSON.stringify(list, null, 2));
}
function findEmployee(empId) {
  const id = String(empId || '').trim();
  return loadEmployees().find(e => e.empId === id) || null;
}

// ---- uploads held in memory, then written to disk under data/photos ----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 } // 12 MB
});

// Split a Date into local date + time strings for display/storage.
function splitDateTime(d) {
  const p = n => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return { date, time };
}

// Worked time between a start and end record, from precise capture timestamps.
// Returns '' if either side is missing or the interval is invalid (end <= start).
function workedLabel(start, end) {
  if (!start || !end) return '';
  const a = new Date(start.capturedAt).getTime();
  const b = new Date(end.capturedAt).getTime();
  if (isNaN(a) || isNaN(b) || b <= a) return '';
  let mins = Math.round((b - a) / 60000);
  const h = Math.floor(mins / 60);
  mins = mins % 60;
  return h ? `${h}h ${mins}m` : `${mins}m`;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const VIEWS = path.join(__dirname, 'views'); // gated pages live here, NOT in /public

// ---- ADMIN AUTH: login page, login/logout API, gated dashboard ----
app.get('/admin/login', (req, res) => {
  if (validSession(getCookie(req, 'admin_session'))) return res.redirect('/admin');
  res.sendFile(path.join(VIEWS, 'login.html'));
});

app.post('/api/admin/login', (req, res) => {
  if (!passwordMatches(req.body && req.body.password)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  const token = newSession();
  res.setHeader('Set-Cookie',
    `admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  const t = getCookie(req, 'admin_session');
  if (t) sessions.delete(t);
  res.setHeader('Set-Cookie', 'admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(VIEWS, 'admin.html')));

// ---- CHECK-IN: live photo captured in the browser is uploaded here ----
app.post('/api/checkin', upload.single('photo'), (req, res) => {
  try {
    let name = (req.body.name || '').trim();
    const empId = (req.body.empId || '').trim();
    const type = req.body.type === 'end' ? 'end' : 'start';
    if (!name || !empId) return res.status(400).json({ error: 'Name and Employee ID are required.' });
    if (!req.file) return res.status(400).json({ error: 'Capture a photo with the camera before submitting.' });

    // If this ID is in the roster, the roster's name is authoritative (maps the
    // check-in to the registered employee regardless of what was typed).
    const rosterEmp = findEmployee(empId);
    if (rosterEmp) name = rosterEmp.name;

    // The moment the photo was taken. The client sends its capture time; we
    // validate it against the server clock so a spoofed/skewed device clock
    // can't backdate or postdate attendance.
    const serverNow = new Date();
    let captureTime = new Date(req.body.captureTime || '');
    if (isNaN(captureTime.getTime())) captureTime = serverNow;
    const skewMin = Math.abs(serverNow - captureTime) / 60000;
    if (skewMin > 5) {
      return res.status(422).json({
        error: `Device clock is off by ${Math.round(skewMin)} min from the server. Fix the device time and retry.`
      });
    }

    const { date, time } = splitDateTime(captureTime);

    // Filename: <employeeId>_<date>_<startoftheday|endoftheday>.jpg
    // empId is sanitised so it can't break the path or escape the folder.
    const safeId = empId.replace(/[^A-Za-z0-9._-]/g, '') || 'unknown';
    const slot = type === 'start' ? 'startoftheday' : 'endoftheday';
    const id = `${safeId}_${date}_${slot}`;
    const photoFile = id + '.jpg';
    fs.writeFileSync(path.join(PHOTO_DIR, photoFile), req.file.buffer); // image IS stored now (overwrites a re-check-in for the same slot)
    const records = loadRecords();
    records.push({
      id, name, empId, type, date, time,
      capturedAt: captureTime.toISOString(),
      serverTime: serverNow.toISOString(),
      photo: photoFile
    });
    saveRecords(records);

    res.json({ ok: true, type, name, empId, date, time });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Processing failed: ' + err.message });
  }
});

// ---- PUBLIC: look up an employee's name by ID (for check-in auto-fill) ----
app.get('/api/lookup/:empId', (req, res) => {
  const e = findEmployee(req.params.empId);
  res.json({ name: e ? e.name : null });
});

// ---- ADMIN: employee roster CRUD ----
app.get('/api/employees', requireAdmin, (req, res) => {
  res.json(loadEmployees().slice().sort((a, b) => a.name.localeCompare(b.name)));
});

app.post('/api/employees', requireAdmin, (req, res) => {
  const name = (req.body.name || '').trim();
  const empId = (req.body.empId || '').trim();
  if (!name || !empId) return res.status(400).json({ error: 'Name and Employee ID are required.' });
  const list = loadEmployees();
  const i = list.findIndex(e => e.empId === empId);
  if (i >= 0) list[i].name = name; else list.push({ empId, name });
  saveEmployees(list);
  res.json({ ok: true, count: list.length });
});

// Bulk import: text of "name,employeeId" (or tab-separated) lines.
app.post('/api/employees/bulk', requireAdmin, (req, res) => {
  const text = String(req.body.text || '');
  const list = loadEmployees();
  let added = 0, updated = 0, skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/[,\t]/).map(s => s.trim());
    const name = parts[0], empId = parts[1];
    if (!name || !empId || /^name$/i.test(name)) { skipped++; continue; } // skip blanks / header row
    const i = list.findIndex(e => e.empId === empId);
    if (i >= 0) { list[i].name = name; updated++; } else { list.push({ empId, name }); added++; }
  }
  saveEmployees(list);
  res.json({ ok: true, added, updated, skipped, count: list.length });
});

app.delete('/api/employees/:empId', requireAdmin, (req, res) => {
  const list = loadEmployees().filter(e => e.empId !== req.params.empId);
  saveEmployees(list);
  res.json({ ok: true, count: list.length });
});

// ---- ADMIN: attendance for one date, mapped against the roster (incl. absentees) ----
app.get('/api/day/:date', requireAdmin, (req, res) => {
  const date = req.params.date;
  const byEmp = {};
  for (const r of loadRecords()) {
    if (r.date !== date) continue;
    if (!byEmp[r.empId]) byEmp[r.empId] = { name: r.name, start: null, end: null };
    if (r.type === 'start') byEmp[r.empId].start = r; else byEmp[r.empId].end = r;
  }
  const buildRow = (empId, name, rec, inRoster) => {
    const start = rec ? rec.start : null;
    const end = rec ? rec.end : null;
    const status = (start && end) ? 'complete' : (start || end) ? 'partial' : 'absent';
    return { empId, name, inRoster, start, end, worked: workedLabel(start, end), status };
  };
  const rows = [];
  const seen = new Set();
  for (const e of loadEmployees()) {
    seen.add(e.empId);
    rows.push(buildRow(e.empId, e.name, byEmp[e.empId], true));
  }
  for (const id of Object.keys(byEmp)) {           // walk-ins not in the roster
    if (seen.has(id)) continue;
    rows.push(buildRow(id, byEmp[id].name, byEmp[id], false));
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  res.json(rows);
});

// ---- serve a stored attendance photo (admin only — these are employee faces) ----
app.get('/api/photo/:file', requireAdmin, (req, res) => {
  const file = path.basename(req.params.file); // prevent path traversal
  const full = path.join(PHOTO_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).end();
  res.type('jpg').sendFile(full);
});

// ---- ADMIN: grouped records (one row per employee per date) ----
app.get('/api/records', requireAdmin, (req, res) => {
  const records = loadRecords();
  const groups = {};
  for (const r of records) {
    const key = r.empId + '||' + (r.date || 'no-date');
    if (!groups[key]) groups[key] = { name: r.name, empId: r.empId, date: r.date || '', start: null, end: null };
    groups[key].name = r.name;
    if (r.type === 'start') groups[key].start = r; else groups[key].end = r;
  }
  const rows = Object.values(groups).sort((a, b) =>
    (b.date || '').localeCompare(a.date || '') || a.name.localeCompare(b.name));
  for (const g of rows) g.worked = workedLabel(g.start, g.end);
  res.json(rows);
});

// ---- ADMIN: CSV export ----
app.get('/api/export', requireAdmin, (req, res) => {
  const records = loadRecords();
  const groups = {};
  for (const r of records) {
    const key = r.empId + '||' + (r.date || 'no-date');
    if (!groups[key]) groups[key] = { name: r.name, empId: r.empId, date: r.date || '', start: null, end: null };
    if (r.type === 'start') groups[key].start = r; else groups[key].end = r;
  }
  const lines = [['Name', 'Employee ID', 'Date', 'Start Time', 'End Time', 'Worked']];
  for (const g of Object.values(groups)) {
    lines.push([g.name, g.empId, g.date, g.start ? g.start.time : '', g.end ? g.end.time : '', workedLabel(g.start, g.end)]);
  }
  const csv = lines.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="attendance.csv"');
  res.send(csv);
});

// ---- ADMIN: clear all (records + stored photos) ----
app.delete('/api/records', requireAdmin, (req, res) => {
  for (const r of loadRecords()) {
    if (r.photo) { try { fs.unlinkSync(path.join(PHOTO_DIR, r.photo)); } catch (e) {} }
  }
  saveRecords([]);
  res.json({ ok: true });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Attendance Tracker running at http://localhost:${PORT}`));
}

module.exports = { app, splitDateTime, workedLabel, ADMIN_PASSWORD };
