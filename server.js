'use strict';

require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
app.disable('x-powered-by');
app.set('trust proxy', 1); // correct client IP behind a proxy/HTTPS terminator (for rate limiting)

// ---- security headers (CSP tuned for this app's inline scripts/styles) ----
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],   // clickjacking protection
      baseUri: ["'self'"],
      formAction: ["'self'"],
      objectSrc: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

// ---- optional HTTPS redirect (behind a proxy that sets x-forwarded-proto) ----
if (process.env.FORCE_HTTPS === 'true') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] === 'http') return res.redirect(301, 'https://' + req.headers.host + req.url);
    next();
  });
}

// ---- rate limiters ----
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many login attempts. Try again in a few minutes.' } });
const publicLimiter = rateLimit({ windowMs: 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests. Please slow down.' } });
const generalLimiter = rateLimit({ windowMs: 60 * 1000, max: 600, standardHeaders: true, legacyHeaders: false, skip: req => req.path.startsWith('/api/photo'), message: { error: 'Too many requests.' } });

// ---- CSRF defense: mutating API requests must be same-origin ----
function sameOriginGuard(req, res, next) {
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  if (!mutating || !req.path.startsWith('/api/')) return next();
  const origin = req.headers.origin || req.headers.referer;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return res.status(403).json({ error: 'Cross-origin request blocked.' }); }
    catch (e) { return res.status(403).json({ error: 'Invalid origin.' }); }
  }
  next();
}

// ---- input guards ----
const MAXLEN = 120;
const tooLong = (...vals) => vals.some(v => typeof v === 'string' && v.length > MAXLEN);
const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d);

// ---- audit logging of sensitive actions ----
function clientIp(req) { return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || req.socket.remoteAddress || '?'; }
function audit(req, msg) { console.log(`[AUDIT] ${new Date().toISOString()} ip=${clientIp(req)} ${msg}`); }

if (!db.isConfigured()) {
  console.warn('\n[WARN] Supabase is NOT configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY ' +
    'in a .env file — data operations will fail until you do.\n');
}

// ---- admin auth config ----
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
if (ADMIN_PASSWORD === 'admin123') {
  console.warn('[WARN] Using the DEFAULT admin password "admin123". Set ADMIN_PASSWORD before real use.\n');
} else if (ADMIN_PASSWORD.length < 10) {
  console.warn('[WARN] ADMIN_PASSWORD is short (<10 chars). Use a longer, unique passphrase.\n');
}
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();
// Set COOKIE_SECURE=true once you're serving over HTTPS (recommended for production).
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const cookieBase = `admin_session=`;
const cookieFlags = `HttpOnly; SameSite=Strict; Path=/${COOKIE_SECURE ? '; Secure' : ''}`;
// purge expired sessions hourly
setInterval(() => { const now = Date.now(); for (const [t, exp] of sessions) if (now > exp) sessions.delete(t); }, 60 * 60 * 1000).unref();

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
  if (validSession(getCookie(req, 'admin_session'))) {
    res.setHeader('Cache-Control', 'no-store'); // don't cache sensitive admin data (handlers may override, e.g. photos)
    return next();
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated.' });
  return res.redirect('/admin/login');
}

// ---- employee (user) sessions ----
const userSessions = new Map(); // token -> { empId, mustChange, exp }
const DEFAULT_USER_PASSWORD = 'Welcome@123'; // seeded default until admin sets one
function newUserSession(empId, mustChange) {
  const token = crypto.randomBytes(24).toString('hex');
  userSessions.set(token, { empId, mustChange: !!mustChange, exp: Date.now() + SESSION_TTL_MS });
  return token;
}
function getUserSession(req) {
  const t = getCookie(req, 'user_session');
  if (!t || !userSessions.has(t)) return null;
  const s = userSessions.get(t);
  if (Date.now() > s.exp) { userSessions.delete(t); return null; }
  return { token: t, ...s };
}
function requireUser(req, res, next) {
  const s = getUserSession(req);
  if (!s) return res.status(401).json({ error: 'Not logged in.' });
  res.setHeader('Cache-Control', 'no-store');
  req.user = s;
  next();
}
setInterval(() => { const now = Date.now(); for (const [t, s] of userSessions) if (now > s.exp) userSessions.delete(t); }, 60 * 60 * 1000).unref();
// The effective default password: admin-set hash in settings, else the seeded constant.
async function defaultPasswordValid(password) {
  const hash = await db.getSetting('default_user_password');
  if (hash) return bcrypt.compare(String(password), hash);
  return String(password) === DEFAULT_USER_PASSWORD;
}

// ---- uploads held in memory (then pushed to Supabase Storage) ----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)) // accept images only; others silently dropped
});
const uploadExcel = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

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

app.use(compression());                 // gzip JSON/HTML/CSS responses
app.use(express.json({ limit: '2mb' })); // bounded body (bulk import can be sizeable)
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h', etag: true,
  setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); } // always revalidate the check-in page
}));
const VIEWS = path.join(__dirname, 'views');

app.use('/api/', generalLimiter);        // volumetric protection (photos excluded)
app.use(sameOriginGuard);                // CSRF: block cross-origin mutations
// throttle the public + auth endpoints (brute-force / abuse protection)
app.use('/api/admin/login', loginLimiter);
app.use('/api/checkin', publicLimiter);
app.use('/api/lookup', publicLimiter);

// ---- ADMIN AUTH ----
app.get('/admin/login', (req, res) => {
  if (validSession(getCookie(req, 'admin_session'))) return res.redirect('/admin');
  res.sendFile(path.join(VIEWS, 'login.html'));
});
app.post('/api/admin/login', (req, res) => {
  if (!passwordMatches(req.body && req.body.password)) {
    audit(req, 'login FAIL');
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  audit(req, 'login OK');
  const token = newSession();
  res.setHeader('Set-Cookie', `${cookieBase}${token}; ${cookieFlags}; Max-Age=${SESSION_TTL_MS / 1000}`);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => {
  const t = getCookie(req, 'admin_session');
  if (t) sessions.delete(t);
  res.setHeader('Set-Cookie', `${cookieBase}; ${cookieFlags}; Max-Age=0`);
  res.json({ ok: true });
});
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(VIEWS, 'admin.html')));

// ---- USER (employee) AUTH ----
app.get('/login', (req, res) => res.sendFile(path.join(VIEWS, 'user-login.html')));

app.post('/api/user/login', publicLimiter, async (req, res) => {
  try {
    const empId = (req.body.empId || '').trim();
    const password = String(req.body.password || '');
    if (!empId || !password) return res.status(400).json({ error: 'Employee ID and password are required.' });
    const emp = await db.getEmployeeAuth(empId);
    if (!emp || emp.exited) return res.status(401).json({ error: 'Invalid Employee ID or password.' });
    let ok, mustChange;
    if (emp.passwordHash) { ok = await bcrypt.compare(password, emp.passwordHash); mustChange = emp.mustChange; }
    else { ok = await defaultPasswordValid(password); mustChange = true; } // first login on default
    if (!ok) { audit(req, `user login FAIL ${empId}`); return res.status(401).json({ error: 'Invalid Employee ID or password.' }); }
    const token = newUserSession(emp.empId, mustChange);
    res.setHeader('Set-Cookie', `user_session=${token}; ${cookieFlags}; Max-Age=${SESSION_TTL_MS / 1000}`);
    audit(req, `user login OK ${empId}`);
    res.json({ ok: true, mustChange, name: emp.name });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Login failed.' }); }
});

app.post('/api/user/logout', (req, res) => {
  const s = getUserSession(req);
  if (s) userSessions.delete(s.token);
  res.setHeader('Set-Cookie', `user_session=; ${cookieFlags}; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/user/me', requireUser, async (req, res) => {
  try {
    const emp = await db.findEmployee(req.user.empId);
    if (!emp) return res.status(401).json({ error: 'Not found.' });
    res.json({ empId: emp.empId, name: emp.name, businessUnit: emp.businessUnit, team: emp.team, campus: emp.campus, mustChange: req.user.mustChange });
  } catch (err) { res.status(500).json({ error: 'Failed.' }); }
});

app.post('/api/user/change-password', requireUser, async (req, res) => {
  try {
    const current = String(req.body.currentPassword || '');
    const next = String(req.body.newPassword || '');
    if (next.length < 6 || next.length > 100) return res.status(400).json({ error: 'New password must be 6–100 characters.' });
    const emp = await db.getEmployeeAuth(req.user.empId);
    if (!emp) return res.status(401).json({ error: 'Not found.' });
    const currentOk = emp.passwordHash ? await bcrypt.compare(current, emp.passwordHash) : await defaultPasswordValid(current);
    if (!currentOk) return res.status(401).json({ error: 'Current password is incorrect.' });
    const hash = await bcrypt.hash(next, 10);
    await db.setEmployeePassword(req.user.empId, hash);
    userSessions.get(req.user.token).mustChange = false; // update live session
    audit(req, `user password change ${req.user.empId}`);
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not change password.' }); }
});

// ---- ADMIN: set the global default user password ----
app.post('/api/admin/default-password', requireAdmin, async (req, res) => {
  try {
    const pw = String(req.body.password || '');
    if (pw.length < 6 || pw.length > 100) return res.status(400).json({ error: 'Default password must be 6–100 characters.' });
    const hash = await bcrypt.hash(pw, 10);
    await db.setSetting('default_user_password', hash);
    audit(req, 'set default user password');
    res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Could not set default password.' }); }
});

// ---- CHECK-IN (public) ----
app.post('/api/checkin', requireUser, upload.single('photo'), async (req, res) => {
  try {
    if (req.user.mustChange) return res.status(403).json({ error: 'Please change your password before checking in.' });
    const empId = req.user.empId;                 // identity from the session, not the client
    const type = req.body.type === 'end' ? 'end' : 'start';
    if (!req.file) return res.status(400).json({ error: 'Capture a photo with the camera before submitting.' });

    const rosterEmp = await db.findEmployee(empId);
    if (!rosterEmp) return res.status(400).json({ error: 'Your employee record was not found. Contact the admin.' });
    const name = rosterEmp.name;                   // roster name is authoritative

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
    res.status(500).json({ error: 'Could not process the check-in. Please try again.' });
  }
});

// ---- PUBLIC: name lookup for check-in auto-fill ----
app.get('/api/lookup/:empId', async (req, res) => {
  try {
    const e = await db.findEmployee(req.params.empId);
    res.json(e ? { name: e.name, businessUnit: e.businessUnit, team: e.team, campus: e.campus } : { name: null });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Lookup failed.' }); }
});

// ---- dropdown option lists (seeded once, then admin-managed) ----
const DEFAULT_OPTIONS = {
  business_unit: ['FACE Prep Central', 'FACE Prep Degree Programs', 'FACE Prep Skill Development'],
  team: ['Management', 'Training', 'Talent Acquisition', 'Sales', 'Finance', 'Delivery', 'Talent Management', 'Client Delivery', 'Enterprise Relations', 'DSA', 'Marketing'],
  campus: ['VIT', 'PSG', 'S-Vyasa', 'Kristu University', 'NA', 'Alliance University', 'BCAS', 'NAAS']
};
async function getSeededOptions() {
  let o = await db.listOptions();
  if (!o.business_unit.length && !o.team.length && !o.campus.length) {
    const pairs = [];
    for (const [category, vals] of Object.entries(DEFAULT_OPTIONS)) for (const value of vals) pairs.push({ category, value });
    await db.addOptions(pairs);
    o = await db.listOptions();
  }
  return o;
}
// Register any non-empty BU/Team/Campus values as options (so custom entries persist).
async function registerOptions(emps) {
  const pairs = [];
  for (const e of emps) {
    if (e.businessUnit) pairs.push({ category: 'business_unit', value: e.businessUnit });
    if (e.team) pairs.push({ category: 'team', value: e.team });
    if (e.campus) pairs.push({ category: 'campus', value: e.campus });
  }
  if (pairs.length) { try { await db.addOptions(pairs); } catch (e) { /* non-fatal */ } }
}

app.get('/api/options', requireAdmin, async (req, res) => {
  try { res.json(await getSeededOptions()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/options', requireAdmin, async (req, res) => {
  try {
    const category = (req.body.category || '').trim();
    const value = (req.body.value || '').trim();
    if (!['business_unit', 'team', 'campus'].includes(category)) return res.status(400).json({ error: 'Invalid category.' });
    if (!value || tooLong(value)) return res.status(400).json({ error: 'A valid value is required.' });
    await db.addOptions([{ category, value }]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/options', requireAdmin, async (req, res) => {
  try {
    const category = (req.query.category || '').trim();
    const value = (req.query.value || '').trim();
    if (!category || !value) return res.status(400).json({ error: 'category and value are required.' });
    await db.removeOption(category, value);
    res.json({ ok: true });
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
    if (tooLong(name, empId, businessUnit, team, campus)) return res.status(400).json({ error: 'One or more fields are too long.' });
    if (await db.findEmployee(empId)) {
      return res.status(409).json({ error: `Associate ID "${empId}" already exists — not added.` });
    }
    await db.upsertEmployee(empId, name, businessUnit, team, campus);
    await registerOptions([{ businessUnit, team, campus }]);
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
      const empId = parts[0], name = parts[1], businessUnit = parts[2] || '', team = parts[3] || '', campus = parts[4] || '';
      if (!empId || !name) { skipped++; continue; }
      if (/^(associate\s*id|emp(loyee)?\s*id|id)$/i.test(empId) || /^name$/i.test(name)) { skipped++; continue; } // header row
      if (existing.has(empId) || seen.has(empId)) { duplicates++; continue; } // already in roster or repeated in paste
      seen.add(empId);
      rows.push({ empId, name, businessUnit, team, campus });
      added++;
    }
    await db.upsertEmployees(rows);
    await registerOptions(rows);
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
    const businessUnit = (req.body.businessUnit || '').trim(), team = (req.body.team || '').trim(), campus = (req.body.campus || '').trim();
    if (tooLong(name, businessUnit, team, campus)) return res.status(400).json({ error: 'One or more fields are too long.' });
    await db.updateEmployee(empId, { name, businessUnit, team, campus });
    await registerOptions([{ businessUnit, team, campus }]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/employees/exited', requireAdmin, async (req, res) => {
  try { res.json(await db.listExited()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/employees/:empId/exit', requireAdmin, async (req, res) => {
  try { await db.setExited(req.params.empId, true); audit(req, `exit ${req.params.empId}`); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/employees/:empId/restore', requireAdmin, async (req, res) => {
  try { await db.setExited(req.params.empId, false); audit(req, `restore ${req.params.empId}`); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/employees/:empId/reset-password', requireAdmin, async (req, res) => {
  try {
    const empId = req.params.empId;
    if (!(await db.getEmployeeAuth(empId))) return res.status(404).json({ error: 'Employee not found.' });
    await db.resetEmployeePassword(empId);
    for (const [t, s] of userSessions) if (s.empId === empId) userSessions.delete(t); // force re-login
    audit(req, `reset password ${empId}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/employees', requireAdmin, async (req, res) => {
  try { await db.clearEmployees(); audit(req, 'clear ROSTER'); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/employees/:empId', requireAdmin, async (req, res) => {
  try { await db.deleteEmployee(req.params.empId); audit(req, `delete employee ${req.params.empId}`); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- ADMIN: attendance for one date, mapped against roster (incl. absentees) ----
app.get('/api/day/:date', requireAdmin, async (req, res) => {
  try {
    const date = req.params.date;
    if (!validDate(date)) return res.status(400).json({ error: 'Invalid date.' });
    const byEmp = {};
    for (const r of await db.recordsByDate(date)) {
      if (!byEmp[r.empId]) byEmp[r.empId] = { name: r.name, start: null, end: null };
      if (r.type === 'start') byEmp[r.empId].start = r; else byEmp[r.empId].end = r;
    }
    const overrides = await db.statusByDate(date);
    const buildRow = (empId, name, businessUnit, team, campus, rec, inRoster) => {
      const start = rec ? rec.start : null, end = rec ? rec.end : null;
      const computed = (start && end) ? 'present' : (start || end) ? 'partial' : 'absent';
      const status = overrides[empId] || computed;           // manual override wins
      return { empId, name, businessUnit: businessUnit || '', team: team || '', campus: campus || '', inRoster, start, end, worked: workedLabel(start, end), status, overridden: !!overrides[empId] };
    };
    const rows = [];
    const seen = new Set();
    for (const e of await db.listEmployees()) { seen.add(e.empId); rows.push(buildRow(e.empId, e.name, e.businessUnit, e.team, e.campus, byEmp[e.empId], true)); }
    for (const id of Object.keys(byEmp)) { if (!seen.has(id)) rows.push(buildRow(id, byEmp[id].name, '', '', '', byEmp[id], false)); }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- ADMIN: set a manual status override for one employee on one date ----
app.post('/api/status', requireAdmin, async (req, res) => {
  try {
    const empId = (req.body.empId || '').trim();
    const date = (req.body.date || '').trim();
    const status = (req.body.status || '').trim().toLowerCase();
    if (!empId || !validDate(date)) return res.status(400).json({ error: 'empId and a valid date are required.' });
    if (!['present', 'absent', 'permission', 'normal_leave'].includes(status)) {
      return res.status(400).json({ error: 'status must be present, absent, permission, or normal_leave.' });
    }
    await db.setStatus(empId, date, status);
    audit(req, `status set ${empId} ${date} -> ${status}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- ADMIN: stored photo (proxied from Storage; bucket is private) ----
app.get('/api/photo/:file', requireAdmin, async (req, res) => {
  try {
    const file = path.basename(req.params.file);
    const buf = await db.downloadPhoto(file);
    if (!buf) return res.status(404).end();
    res.setHeader('Cache-Control', 'private, max-age=3600'); // browser caches thumbnails for 1h
    res.type('jpg').send(buf);                                // send() adds an ETag for revalidation
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
    const date = (req.query.date || '').trim() || splitDateTime(new Date()).date;
    if (!validDate(date)) return res.status(400).json({ error: 'Invalid date.' });
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
  try { await db.deleteRecord(req.params.id); audit(req, `delete record ${req.params.id}`); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- ADMIN: import attendance from a biometric Excel export ----
// Matches "E. Code" to Associate ID; "A. InTime" -> start, "A. OutTime" -> end.
const XL_MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
const xlNorm = s => String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
function xlFileDate(rows) {
  for (const row of rows) for (const cell of row) {
    const m = /(\d{1,2})-(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-(\d{4})/i.exec(String(cell || ''));
    if (m) return `${m[3]}-${XL_MONTHS[m[2].toLowerCase()]}-${String(m[1]).padStart(2, '0')}`;
  }
  return null;
}
function xlTime(v) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(v == null ? '' : v).trim());
  if (!m) return '';
  const p = n => String(n).padStart(2, '0');
  const hh = +m[1], mm = +m[2], ss = m[3] ? +m[3] : 0;
  if (hh > 47 || mm > 59 || ss > 59 || (hh === 0 && mm === 0 && ss === 0)) return ''; // skip 00:00 / invalid
  return `${p(hh)}:${p(mm)}:${p(ss)}`;
}
// Normalise a biometric E.Code to the 6-digit Associate ID:
//  - 6 digits: use as-is
//  - 5 digits starting with 8: insert 0 after the 8  (81522 -> 801522)
//  - 5 digits starting with anything else: prefix 1  (35454 -> 135454)
function xlNormCode(raw) {
  const code = String(raw == null ? '' : raw).trim();
  if (!/^\d+$/.test(code)) return code;
  if (code.length === 5) return code[0] === '8' ? code[0] + '0' + code.slice(1) : '1' + code;
  return code;
}
function xlRec(safeId, empId, name, type, date, time, now) {
  const slot = type === 'start' ? 'startoftheday' : 'endoftheday';
  return { id: `${safeId}_${date}_${slot}`, empId, name, type, date, time, capturedAt: new Date(`${date}T${time}+05:30`).toISOString(), serverTime: now, photo: null, lat: null, lng: null };
}

app.post('/api/import-attendance', requireAdmin, uploadExcel.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    let wb;
    try { wb = XLSX.read(req.file.buffer, { type: 'buffer' }); }
    catch (e) { return res.status(400).json({ error: 'Could not read the Excel file.' }); }
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });

    // locate header row + the columns we need
    let hIdx = -1; const col = {};
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].map(xlNorm).includes('e.code')) {
        hIdx = i;
        rows[i].forEach((c, j) => {
          const n = xlNorm(c);
          if (n === 'e.code' || n === 'ecode') col.ecode = j;
          else if (n === 'a.intime') col.intime = j;
          else if (n === 'a.outtime') col.outtime = j;
          else if (n === 'name') col.name = j;
        });
        break;
      }
    }
    if (hIdx < 0 || col.ecode == null || col.intime == null || col.outtime == null) {
      return res.status(400).json({ error: 'Could not find "E. Code", "A. InTime" and "A. OutTime" columns in the sheet.' });
    }

    const date = xlFileDate(rows) || (req.body.date || '').trim();
    if (!validDate(date)) return res.status(400).json({ error: 'Could not determine the attendance date from the file.' });

    const roster = {};
    for (const e of await db.listEmployees()) roster[String(e.empId).trim()] = e;

    const now = new Date().toISOString();
    const recs = [];
    let matched = 0, unmatched = 0, present = 0;
    for (let i = hIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      const code = String(r[col.ecode] == null ? '' : r[col.ecode]).trim();
      if (!code) continue;
      const emp = roster[xlNormCode(code)] || roster[code]; // normalised first, then raw
      if (!emp) { unmatched++; continue; }
      matched++;
      const inT = xlTime(r[col.intime]), outT = xlTime(r[col.outtime]);
      const id = String(emp.empId).trim();                 // store under the roster Associate ID
      const safeId = id.replace(/[^A-Za-z0-9._-]/g, '') || 'unknown';
      if (inT) recs.push(xlRec(safeId, id, emp.name, 'start', date, inT, now));
      if (outT) recs.push(xlRec(safeId, id, emp.name, 'end', date, outT, now));
      if (inT || outT) present++;
    }
    for (let i = 0; i < recs.length; i += 500) await db.insertRecords(recs.slice(i, i + 500));
    audit(req, `import-attendance ${date} matched=${matched} present=${present} recs=${recs.length}`);
    res.json({ ok: true, date, matched, unmatched, present, records: recs.length });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Import failed: ' + err.message }); }
});

// ---- ADMIN: clear records (a single date if ?date= given, else everything) + photos ----
app.delete('/api/records', requireAdmin, async (req, res) => {
  try {
    const date = (req.query.date || '').trim();
    if (date && !validDate(date)) return res.status(400).json({ error: 'Invalid date.' });
    if (date) await db.clearRecordsByDate(date);
    else await db.clearRecords();
    audit(req, `clear records ${date || 'ALL'}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- catch-all error handler (e.g. multer file-too-large) -> JSON, not HTML ----
app.use((err, req, res, next) => {
  if (!err) return next();
  console.error(err);
  const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 12 MB).' : 'Request could not be processed.';
  res.status(400).json({ error: msg });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Attendance Tracker running at http://localhost:${PORT}`));
}

module.exports = { app, splitDateTime, workedLabel, ADMIN_PASSWORD };
