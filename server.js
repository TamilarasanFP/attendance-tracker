'use strict';

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

if (!db.isConfigured()) {
  console.warn('\n[WARN] Supabase is NOT configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY ' +
    'in a .env file — data operations will fail until you do.\n');
}

// ---- admin auth config ----
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
if (ADMIN_PASSWORD === 'admin123') {
  console.warn('[WARN] Using the DEFAULT admin password "admin123". ' +
    'Set ADMIN_PASSWORD before real use.\n');
}
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();

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
  if (a.length !== b.length) return false;
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
function requireAdmin(req, res, next) {
  if (validSession(getCookie(req, 'admin_session'))) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated.' });
  return res.redirect('/admin/login');
}

// ---- uploads held in memory (then pushed to Supabase Storage) ----
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });

// ---- helpers ----
// Format an absolute instant into date + time in a fixed timezone (default IST),
// so the recorded wall-clock is correct no matter where the server runs.
const DISPLAY_TZ = process.env.DISPLAY_TZ || 'Asia/Kolkata';
function splitDateTime(d) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: DISPLAY_TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(d).reduce((o, p) => (o[p.type] = p.value, o), {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`
  };
}
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
const VIEWS = path.join(__dirname, 'views');

// ---- ADMIN AUTH ----
app.get('/admin/login', (req, res) => {
  if (validSession(getCookie(req, 'admin_session'))) return res.redirect('/admin');
  res.sendFile(path.join(VIEWS, 'login.html'));
});
app.post('/api/admin/login', (req, res) => {
  if (!passwordMatches(req.body && req.body.password)) return res.status(401).json({ error: 'Incorrect password.' });
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

// ---- CHECK-IN (public) ----
app.post('/api/checkin', upload.single('photo'), async (req, res) => {
  try {
    let name = (req.body.name || '').trim();
    const empId = (req.body.empId || '').trim();
    const type = req.body.type === 'end' ? 'end' : 'start';
    if (!name || !empId) return res.status(400).json({ error: 'Name and Employee ID are required.' });
    if (!req.file) return res.status(400).json({ error: 'Capture a photo with the camera before submitting.' });

    const rosterEmp = await db.findEmployee(empId);
    if (rosterEmp) name = rosterEmp.name; // roster name is authoritative

    // Location is required.
    const lat = parseFloat(req.body.lat), lng = parseFloat(req.body.lng);
    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ error: 'Location is required. Please allow location access and capture again.' });
    }

    const serverNow = new Date();
    let captureTime = new Date(req.body.captureTime || '');
    if (isNaN(captureTime.getTime())) captureTime = serverNow;
    const skewMin = Math.abs(serverNow - captureTime) / 60000;
    if (skewMin > 5) {
      return res.status(422).json({ error: `Device clock is off by ${Math.round(skewMin)} min from the server. Fix the device time and retry.` });
    }

    const { date, time } = splitDateTime(captureTime);
    const safeId = empId.replace(/[^A-Za-z0-9._-]/g, '') || 'unknown';
    const slot = type === 'start' ? 'startoftheday' : 'endoftheday';
    const id = `${safeId}_${date}_${slot}`;
    const photoFile = id + '.jpg';

    await db.uploadPhoto(photoFile, req.file.buffer);
    await db.insertRecord({
      id, name, empId, type, date, time,
      capturedAt: captureTime.toISOString(), serverTime: serverNow.toISOString(), photo: photoFile,
      lat, lng
    });

    res.json({ ok: true, type, name, empId, date, time, lat, lng });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Processing failed: ' + err.message });
  }
});

// ---- PUBLIC: name lookup for check-in auto-fill ----
app.get('/api/lookup/:empId', async (req, res) => {
  try {
    const e = await db.findEmployee(req.params.empId);
    res.json({ name: e ? e.name : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- ADMIN: employee roster ----
app.get('/api/employees', requireAdmin, async (req, res) => {
  try { res.json(await db.listEmployees()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/employees', requireAdmin, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const empId = (req.body.empId || '').trim();
    const businessUnit = (req.body.businessUnit || '').trim();
    const team = (req.body.team || '').trim();
    const campus = (req.body.campus || '').trim();
    if (!name || !empId) return res.status(400).json({ error: 'Name and Associate ID are required.' });
    if (await db.findEmployee(empId)) {
      return res.status(409).json({ error: `Associate ID "${empId}" already exists — not added.` });
    }
    await db.upsertEmployee(empId, name, businessUnit, team, campus);
    const count = (await db.listEmployees()).length;
    res.json({ ok: true, count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/employees/bulk', requireAdmin, async (req, res) => {
  try {
    const text = String(req.body.text || '');
    const existing = new Set((await db.listEmployees()).map(e => e.empId));
    const seen = new Set();
    const rows = [];
    let added = 0, duplicates = 0, skipped = 0;
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const parts = t.split(/[,\t]/).map(s => s.trim());
      const name = parts[0], empId = parts[1], businessUnit = parts[2] || '', team = parts[3] || '', campus = parts[4] || '';
      if (!empId || !name) { skipped++; continue; }
      if (/^name$/i.test(name) || /^(associate\s*id|emp(loyee)?\s*id|id)$/i.test(empId)) { skipped++; continue; } // header row
      if (existing.has(empId) || seen.has(empId)) { duplicates++; continue; } // already in roster or repeated in paste
      seen.add(empId);
      rows.push({ empId, name, businessUnit, team, campus });
      added++;
    }
    await db.upsertEmployees(rows);
    const count = (await db.listEmployees()).length;
    res.json({ ok: true, added, duplicates, skipped, count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.patch('/api/employees/:empId', requireAdmin, async (req, res) => {
  try {
    const empId = req.params.empId;
    if (!(await db.findEmployee(empId))) return res.status(404).json({ error: 'Employee not found.' });
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    await db.updateEmployee(empId, { name, businessUnit: (req.body.businessUnit || '').trim(), team: (req.body.team || '').trim(), campus: (req.body.campus || '').trim() });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/employees', requireAdmin, async (req, res) => {
  try { await db.clearEmployees(); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/employees/:empId', requireAdmin, async (req, res) => {
  try { await db.deleteEmployee(req.params.empId); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- ADMIN: attendance for one date, mapped against roster (incl. absentees) ----
app.get('/api/day/:date', requireAdmin, async (req, res) => {
  try {
    const date = req.params.date;
    const byEmp = {};
    for (const r of await db.recordsByDate(date)) {
      if (!byEmp[r.empId]) byEmp[r.empId] = { name: r.name, start: null, end: null };
      if (r.type === 'start') byEmp[r.empId].start = r; else byEmp[r.empId].end = r;
    }
    const buildRow = (empId, name, businessUnit, team, campus, rec, inRoster) => {
      const start = rec ? rec.start : null, end = rec ? rec.end : null;
      const status = (start && end) ? 'complete' : (start || end) ? 'partial' : 'absent';
      return { empId, name, businessUnit: businessUnit || '', team: team || '', campus: campus || '', inRoster, start, end, worked: workedLabel(start, end), status };
    };
    const rows = [];
    const seen = new Set();
    for (const e of await db.listEmployees()) { seen.add(e.empId); rows.push(buildRow(e.empId, e.name, e.businessUnit, e.team, e.campus, byEmp[e.empId], true)); }
    for (const id of Object.keys(byEmp)) { if (!seen.has(id)) rows.push(buildRow(id, byEmp[id].name, '', '', '', byEmp[id], false)); }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- ADMIN: stored photo (proxied from Storage; bucket is private) ----
app.get('/api/photo/:file', requireAdmin, async (req, res) => {
  try {
    const file = path.basename(req.params.file);
    const buf = await db.downloadPhoto(file);
    if (!buf) return res.status(404).end();
    res.type('jpg').send(buf);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- ADMIN: grouped records (employee x date) ----
app.get('/api/records', requireAdmin, async (req, res) => {
  try {
    const groups = {};
    for (const r of await db.listRecords()) {
      const key = r.empId + '||' + (r.date || 'no-date');
      if (!groups[key]) groups[key] = { name: r.name, empId: r.empId, date: r.date || '', start: null, end: null };
      groups[key].name = r.name;
      if (r.type === 'start') groups[key].start = r; else groups[key].end = r;
    }
    const rows = Object.values(groups).sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.name.localeCompare(b.name));
    for (const g of rows) g.worked = workedLabel(g.start, g.end);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- ADMIN: CSV export for a date — EVERY roster employee (absentees included) ----
app.get('/api/export', requireAdmin, async (req, res) => {
  try {
    const date = req.query.date || splitDateTime(new Date()).date;
    const byEmp = {};
    for (const r of await db.recordsByDate(date)) {
      if (!byEmp[r.empId]) byEmp[r.empId] = { name: r.name, start: null, end: null };
      if (r.type === 'start') byEmp[r.empId].start = r; else byEmp[r.empId].end = r;
    }
    const loc = r => (r && r.lat != null && r.lng != null) ? `${r.lat},${r.lng}` : '';
    const statusOf = (s, e) => (s && e) ? 'present' : (s || e) ? 'partial' : 'absent';
    const lines = [['Name', 'Associate ID', 'Business Unit', 'Team', 'Campus', 'Date', 'Status', 'Start Time', 'End Time', 'Worked', 'Start Location', 'End Location']];
    const push = (empId, name, bu, team, campus, rec) => {
      const s = rec ? rec.start : null, e = rec ? rec.end : null;
      lines.push([name, empId, bu || '', team || '', campus || '', date, statusOf(s, e), s ? s.time : '', e ? e.time : '', workedLabel(s, e), loc(s), loc(e)]);
    };
    const seen = new Set();
    const roster = (await db.listEmployees()).sort((a, b) => a.name.localeCompare(b.name));
    for (const emp of roster) { seen.add(emp.empId); push(emp.empId, emp.name, emp.businessUnit, emp.team, emp.campus, byEmp[emp.empId]); }
    for (const id of Object.keys(byEmp)) { if (!seen.has(id)) push(id, byEmp[id].name, '', '', '', byEmp[id]); } // walk-ins
    const csv = lines.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="attendance-${date}.csv"`);
    res.send(csv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- ADMIN: edit one entry's time (recomputes capture instant + Worked) ----
app.patch('/api/records/:id', requireAdmin, async (req, res) => {
  try {
    const rec = await db.getRecord(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Record not found.' });
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(req.body.time || '').trim());
    if (!m) return res.status(400).json({ error: 'Time must be HH:MM or HH:MM:SS (24-hour).' });
    const hh = +m[1], mm = +m[2], ss = m[3] ? +m[3] : 0;
    if (hh > 23 || mm > 59 || ss > 59) return res.status(400).json({ error: 'Invalid time value.' });
    const p = n => String(n).padStart(2, '0');
    const time = `${p(hh)}:${p(mm)}:${p(ss)}`;
    // India Standard Time has no DST, so the offset is always +05:30.
    const capturedAt = new Date(`${rec.date}T${time}+05:30`).toISOString();
    await db.updateRecord(rec.id, { time, capturedAt });
    res.json({ ok: true, time });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- ADMIN: delete one entry (record row + its photo) ----
app.delete('/api/records/:id', requireAdmin, async (req, res) => {
  try { await db.deleteRecord(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- ADMIN: clear all (records + stored photos) ----
app.delete('/api/records', requireAdmin, async (req, res) => {
  try { await db.clearRecords(); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Attendance Tracker running at http://localhost:${PORT}`));
}

module.exports = { app, splitDateTime, workedLabel, ADMIN_PASSWORD };
