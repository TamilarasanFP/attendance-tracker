import express from 'express';
import multer from 'multer';
import XLSX from 'xlsx';
import { randomUUID } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { store } from './store.js';
import { parseUsername, parseProblemSlug, fetchProfileStats } from './leetcode.js';
import { runSync, runSyncStudent, getSyncState } from './sync.js';
import { ingestResults } from './ingest.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
export const router = express.Router();

// Throttle auth endpoints to slow brute-forcing.
const adminLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many login attempts. Try again in a few minutes.' } });
// Student login/register throttle. skipSuccessfulRequests => only FAILED attempts
// count, so a whole class on one shared campus IP can log in without being blocked;
// only repeated bad attempts (brute-force) get throttled. Tunable via env.
const studentAuthLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: Number(process.env.STUDENT_RATE_MAX) || 100, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many failed attempts. Please wait a moment and retry.' } });

// ---- Admin authentication ---------------------------------------------------
// Single shared password (config.adminPassword). Login returns a token kept in
// memory; admin requests must send it as the x-admin-token header.
const adminTokens = new Map(); // token -> expiry (ms epoch)
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // sessions expire after 12 hours
function tokenValid(token) {
  if (!token) return false;
  const exp = adminTokens.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { adminTokens.delete(token); return false; }
  return true;
}

// Videos are shown by default; only an explicit "off" (0 / false) hides them.
// This keeps videos visible even if the show_video column is missing/unset.
const videoShown = (col) => !(col && (col.show_video === 0 || col.show_video === false));

// Endpoints that stay open regardless of admin auth (student + shared-link + auth itself).
function isPublicReq(req) {
  const p = req.path, m = req.method;
  if (m === 'OPTIONS') return true;
  if (p === '/admin/login' || p === '/admin/status' || p === '/admin/logout' || p === '/meta') return true;
  if (m === 'GET' && (p === '/template' || p === '/practice-template')) return true; // blank downloads, no data
  if (m === 'GET' && p === '/colleges') return true;                       // student login dropdown
  if (m === 'GET' && /^\/colleges\/\d+\/options$/.test(p)) return true;    // student register dropdowns
  if (m === 'POST' && (p === '/student/login' || p === '/student/register')) return true;
  if (m === 'GET' && /^\/student\/\d+\/dashboard$/.test(p)) return true;
  if (m === 'GET' && /^\/view\/[^/]+(\/student\/\d+|\/practice-completers|\/practice\/\d+\/completion)?$/.test(p)) return true; // shared read-only link
  if (m === 'GET' && /^\/public\/practice\/[^/]+$/.test(p)) return true; // public questions-only list
  return false;
}

router.use((req, res, next) => {
  if (!config.adminPassword) return next(); // auth disabled
  if (isPublicReq(req)) return next();
  if (tokenValid(req.get('x-admin-token'))) return next();
  return res.status(401).json({ error: 'Admin login required.' });
});

router.get('/admin/status', (req, res) => res.json({ authRequired: !!config.adminPassword }));

// Which database is actually live (so the admin can confirm Supabase vs local SQLite).
router.get('/meta', (req, res) => res.json({
  driver: config.dbDriver === 'supabase' ? 'Supabase (Postgres)' : 'SQLite (local)',
  driverKey: config.dbDriver === 'supabase' ? 'supabase' : 'sqlite',
}));

router.post('/admin/login', adminLoginLimiter, (req, res) => {
  if (!config.adminPassword) return res.json({ ok: true, authRequired: false, token: '' });
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (username === config.adminUsername && password === config.adminPassword) {
    const token = randomUUID();
    adminTokens.set(token, Date.now() + TOKEN_TTL_MS);
    return res.json({ ok: true, token });
  }
  return res.status(401).json({ error: 'Incorrect admin username or password.' });
});

router.post('/admin/logout', (req, res) => {
  const t = req.get('x-admin-token');
  if (t) adminTokens.delete(t); // invalidate server-side
  res.json({ ok: true });
});

// Wrap async handlers so a rejected promise becomes a 500 instead of a hung request.
// The detailed error is logged server-side; the client gets a generic message.
const h = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error('[route]', req.method, req.path, '-', e);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error.' });
  });

const titleize = (slug) =>
  slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

// Email is used for login only — never send it to the browser (admin or shared link).
const omitEmail = (s) => { const { email, ...rest } = s; return rest; };

// Normalize a deadline input (ISO string, date, or Excel serial) to 'yyyy-mm-dd' or null.
function normDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') { // Excel serial date
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Find a value in a row object by trying several header aliases (case-insensitive).
function pick(row, aliases) {
  const keys = Object.keys(row);
  for (const alias of aliases) {
    const k = keys.find((kk) => kk.trim().toLowerCase() === alias.toLowerCase());
    if (k && row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
  }
  return null;
}

// ---- Colleges ---------------------------------------------------------------

router.get('/colleges', h(async (req, res) => {
  res.json(await store.listColleges());
}));

// Admin: create a college and (optionally) set its student access code in one go.
router.post('/colleges', h(async (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'College name is required.' });
  const c = await store.getOrCreateCollege(name);
  const code = req.body?.code;
  if (code != null && String(code).trim() !== '') await store.setAccessCode(c.id, code);
  const fresh = await store.getCollege(c.id);
  res.json({ id: fresh.id, name: fresh.name, has_code: !!fresh.access_code });
}));

// Admin: read basic college info (whether a student code is set).
router.get('/colleges/:id', h(async (req, res) => {
  const c = await store.getCollege(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'college not found' });
  res.json({ id: c.id, name: c.name, has_code: !!c.access_code });
}));

// Admin: delete a college and everything under it.
router.delete('/colleges/:id', h(async (req, res) => {
  await store.deleteCollege(Number(req.params.id));
  res.json({ ok: true });
}));

// Admin: set/clear the student access code for a college.
router.post('/colleges/:id/access-code', h(async (req, res) => {
  const c = await store.getCollege(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'college not found' });
  await store.setAccessCode(c.id, req.body?.code || '');
  res.json({ ok: true, has_code: !!(req.body?.code || '').trim() });
}));

// Admin: create (or rotate) a read-only share link for a college.
router.post('/colleges/:id/view-link', h(async (req, res) => {
  const c = await store.getCollege(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'college not found' });
  const token = await store.ensureViewToken(c.id, !!req.body?.regenerate);
  res.json({ token, path: `/view/${token}` });
}));

// Public read-only dashboard for ONE college, resolved by share token.
// Mirrors the admin dashboard: filters, pagination, per-student progress.
router.get('/view/:token', h(async (req, res) => {
  const c = await store.getCollegeByToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'Invalid or expired link.' });

  const f = {
    batch: (req.query.batch || '').trim(),
    department: (req.query.department || '').trim(),
    campus: (req.query.campus || '').trim(),
    q: (req.query.q || '').trim(),
    sort: (req.query.sort || '').trim(),
    dir: (req.query.dir || '').trim(),
    risk: req.query.risk === '1',
    page: Math.max(1, Number(req.query.page) || 1),
    pageSize: Math.min(500, Math.max(1, Number(req.query.pageSize) || 100)),
  };

  const light = req.query.light === '1';
  // Independent queries run together; only the per-page completion counts wait on rows.
  const [problems, pageData, problemCounts, collegeTotalsAll, totals, monthly, filters,
    domainOrder, topicOrder, completionDist] = await Promise.all([
    store.listPracticeProblems(c.id),
    store.getStudentsPage(c.id, f),
    store.getCompletedCountsByProblem(c.id),
    store.getCollegeTotals(c.id, {}),
    store.getCollegeTotals(c.id, f),
    light ? Promise.resolve([]) : store.getCollegeMonthly(c.id, f),
    light ? Promise.resolve(null) : store.getFilterOptions(c.id),
    store.listDomains(c.id),
    store.listTopics(c.id),
    store.getPracticeDistribution(c.id),
  ]);
  const { rows, total, offset } = pageData;
  const studentCounts = await store.getCompletedCountsForStudents(rows.map((s) => s.id));
  const collegeStudentCount = collegeTotalsAll.students;

  res.json({
    college: { name: c.name },
    totals,
    monthly,
    filters,
    page: f.page,
    pageSize: f.pageSize,
    total,
    practiceTotal: problems.length,
    students: rows.map((s, i) => ({
      ...omitEmail(s),
      classRank: offset + i + 1,
      practiceCompleted: studentCounts[s.id] || 0,
      practiceTotal: problems.length,
    })),
    studentCount: collegeStudentCount,
    domainOrder,
    topicOrder,
    completionDist,
    showVideo: videoShown(c),
    practice: problems.map((p) => ({
      id: p.id,
      title: p.title,
      url: p.url,
      difficulty: p.difficulty,
      topic: p.topic || null,
      domain: p.domain || null,
      video_url: videoShown(c) ? (p.video_url || null) : null,
      due_date: p.due_date || null,
      completedCount: problemCounts[p.id] || 0,
    })),
  });
}));

// Read-only drill-down: students who completed exactly N problems (token-scoped).
router.get('/view/:token/practice-completers', h(async (req, res) => {
  const c = await store.getCollegeByToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'Invalid or expired link.' });
  const count = Math.max(0, Number(req.query.count) || 0);
  const students = await store.getStudentsByCompletedCount(c.id, count);
  res.json({ count, students: students.map((s) => omitEmail(s)) });
}));

// Public questions-only list (no login, no student data) — just the assigned
// questions with difficulty and (if enabled) video links.
router.get('/public/practice/:token', h(async (req, res) => {
  const c = await store.getCollegeByToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'Invalid or expired link.' });
  const [problems, domainOrder, topicOrder] = await Promise.all([
    store.listPracticeProblems(c.id), store.listDomains(c.id), store.listTopics(c.id),
  ]);
  const show = videoShown(c);
  res.json({
    college: { name: c.name },
    showVideo: show,
    domainOrder,
    topicOrder,
    problems: problems.map((p) => ({
      title: p.title,
      url: p.url,
      difficulty: p.difficulty,
      topic: p.topic || null,
      domain: p.domain || null,
      video_url: show ? (p.video_url || null) : null,
      due_date: p.due_date || null,
    })),
  });
}));

// Read-only drill-down: who completed / didn't complete ONE problem (token-scoped).
router.get('/view/:token/practice/:problemId/completion', h(async (req, res) => {
  const c = await store.getCollegeByToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'Invalid or expired link.' });
  const r = await store.getProblemCompletion(c.id, Number(req.params.problemId));
  res.json(r);
}));

// Read-only individual student detail, scoped to the share token's college.
router.get('/view/:token/student/:studentId', h(async (req, res) => {
  const c = await store.getCollegeByToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'Invalid or expired link.' });
  const s = await store.getStudent(Number(req.params.studentId));
  if (!s || s.college_id !== c.id) return res.status(404).json({ error: 'Student not found.' });

  const completions = await store.getCompletionsForStudent(s.id);
  const compIds = new Set(completions.map((x) => x.problem_id));
  const problems = await store.getPracticeProblemsByCollege(s.college_id);
  res.json({
    student: omitEmail(s),
    monthlyActivity: await store.getMonthlyActivity(s.id),
    monthlySolvedGrowth: await store.getMonthlySolvedGrowth(s.id),
    practice: problems.map((p) => ({
      ...p,
      completed: compIds.has(p.id),
      completed_at: completions.find((x) => x.problem_id === p.id)?.completed_at || null,
    })),
  });
}));

// Existing batches / departments / campuses for a college — used to populate
// the student self-register dropdowns. Non-sensitive metadata, no code needed.
router.get('/colleges/:id/options', h(async (req, res) => {
  const c = await store.getCollege(Number(req.params.id));
  if (!c) return res.status(404).json({ error: 'college not found' });
  res.json(await store.getFilterOptions(c.id));
}));

// ---- Student side (gated by college access code) ----------------------------

// Student logs in with college + access code + their registered email.
router.post('/student/login', studentAuthLimiter, h(async (req, res) => {
  const collegeId = Number(req.body?.collegeId);
  const code = req.body?.code;
  const email = (req.body?.email || '').trim();
  const college = await store.getCollege(collegeId);
  if (!college) return res.status(404).json({ error: 'College not found.' });
  if (!college.access_code)
    return res.status(403).json({ error: 'No access code set for this college yet. Ask your admin.' });
  if (!(await store.checkAccessCode(collegeId, code)))
    return res.status(401).json({ error: 'Incorrect access code.' });
  if (!email) return res.status(400).json({ error: 'Enter your email.' });
  const student = await store.getStudentByEmail(collegeId, email);
  if (!student)
    return res.status(404).json({ error: 'No student found with that email in this college. Check it, or add yourself below.' });
  res.json({
    ok: true,
    college: { id: college.id, name: college.name },
    student: { id: student.id, name: student.name, username: student.username },
  });
}));

// Self-register: if a student isn't on the roster, they add themselves
// (gated by the same college access code). Deduplicated by LeetCode username.
router.post('/student/register', studentAuthLimiter, h(async (req, res) => {
  const collegeId = Number(req.body?.collegeId);
  const college = await store.getCollege(collegeId);
  if (!college) return res.status(404).json({ error: 'College not found.' });
  if (!(await store.checkAccessCode(collegeId, req.body?.code)))
    return res.status(401).json({ error: 'Incorrect access code.' });

  const name = (req.body?.name || '').trim();
  const profile = (req.body?.profile || '').trim();
  const email = (req.body?.email || '').trim();
  const section = (req.body?.section || '').trim() || null;
  const department = (req.body?.department || '').trim() || null;
  if (!name) return res.status(400).json({ error: 'Enter your name.' });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: 'Enter a valid email.' });
  const username = parseUsername(profile);
  if (!username)
    return res.status(400).json({ error: 'Enter a valid LeetCode profile link or username.' });

  // Duplicate checks — tell them which field already exists.
  if (await store.getStudentByEmail(collegeId, email))
    return res.status(409).json({ error: 'You are already a user — this email is already registered. Please log in instead.' });
  if (await store.getStudentByUsername(collegeId, username))
    return res.status(409).json({ error: 'You are already a user — this LeetCode profile is already registered. Please log in instead.' });

  // Validate the LeetCode profile actually exists (public profile).
  let stats = null;
  try { stats = await fetchProfileStats(username); } catch { stats = null; }
  if (!stats || !stats.found)
    return res.status(400).json({ error: 'Enter a valid LeetCode profile — we couldn’t find that user on LeetCode.' });

  const profileUrl = profile.includes('leetcode.com') ? profile : `https://leetcode.com/u/${username}/`;
  const id = await store.upsertStudent({ college_id: collegeId, name, username, profile_url: profileUrl, email, section, department });
  try { await store.saveStudentStats(id, stats); } catch { /* already validated */ }
  try { await runSyncStudent(id); } catch { /* practice matching is best-effort */ }

  res.json({ ok: true, student: { id, name, username } });
}));

// Step 2: student views ONLY their own data (stats, progress, practice).
router.get('/student/:studentId/dashboard', h(async (req, res) => {
  const student = await store.getStudent(Number(req.params.studentId));
  if (!student) return res.status(404).json({ error: 'Student not found.' });
  if (!(await store.checkAccessCode(student.college_id, req.query.code)))
    return res.status(401).json({ error: 'Incorrect or missing access code.' });

  const classSize = (await store.getCollegeTotals(student.college_id, {})).students;
  const classRank = await store.getRankInCollege(student.college_id, student.solved_total);

  const completions = await store.getCompletionsForStudent(student.id);
  const compIds = new Set(completions.map((c) => c.problem_id));
  const problems = await store.getPracticeProblemsByCollege(student.college_id);
  const college = await store.getCollege(student.college_id);
  const showVideo = videoShown(college);

  res.json({
    me: {
      id: student.id,
      name: student.name,
      username: student.username,
      profile_url: student.profile_url,
      ranking: student.ranking,
      contest_rating: student.contest_rating,
      easy: student.solved_easy,
      medium: student.solved_medium,
      hard: student.solved_hard,
      total: student.solved_total,
      classRank,
      classSize,
      found: !!student.found,
      last_synced_at: student.last_synced_at,
      // academic details (the student's own info)
      register_number: student.register_number,
      section: student.section,
      department: student.department,
      campus: student.campus,
      year: student.year,
      // baseline for the "progress since first tracked" view
      baseline_ranking: student.baseline_ranking,
      baseline_easy: student.baseline_easy,
      baseline_medium: student.baseline_medium,
      baseline_hard: student.baseline_hard,
      baseline_total: student.baseline_total,
      baseline_at: student.baseline_at,
    },
    monthlyActivity: await store.getMonthlyActivity(student.id),
    monthlySolvedGrowth: await store.getMonthlySolvedGrowth(student.id),
    domainOrder: await store.listDomains(student.college_id),
    topicOrder: await store.listTopics(student.college_id),
    showVideo,
    practice: problems.map((p) => ({
      id: p.id,
      title: p.title,
      url: p.url,
      difficulty: p.difficulty,
      topic: p.topic || null,
      domain: p.domain || null,
      video_url: showVideo ? (p.video_url || null) : null,
      due_date: p.due_date || null,
      completed: compIds.has(p.id),
      completed_at: completions.find((c) => c.problem_id === p.id)?.completed_at || null,
    })),
  });
}));

// ---- Student roster upload --------------------------------------------------

router.post('/upload', upload.single('file'), h(async (req, res) => {
  const collegeName = (req.body.college || '').trim();
  if (!collegeName) return res.status(400).json({ error: 'College name is required.' });
  if (!req.file) return res.status(400).json({ error: 'No Excel file uploaded.' });

  const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (!rows.length) return res.status(400).json({ error: 'The sheet appears to be empty.' });

  const college = await store.getOrCreateCollege(collegeName);
  const result = { added: 0, skipped: [], total: rows.length };

  for (const [i, row] of rows.entries()) {
    const name = pick(row, ['name', 'student name', 'student', 'full name']);
    const profile = pick(row, [
      'leetcode profile', 'leetcode', 'profile', 'profile url', 'leetcode url',
      'leetcode id', 'username', 'url', 'link',
    ]);
    const username = parseUsername(profile);
    if (!name || !username) {
      result.skipped.push({ row: i + 2, reason: 'missing name or LeetCode profile' });
      continue;
    }
    const profileUrl = profile.includes('leetcode.com')
      ? profile
      : `https://leetcode.com/u/${username}/`;
    await store.upsertStudent({
      college_id: college.id,
      name,
      username,
      profile_url: profileUrl,
      register_number: pick(row, ['register number', 'registration number', 'reg number', 'register no', 'roll number', 'roll no', 'regno']),
      email: pick(row, ['email id', 'email', 'mail', 'e-mail']),
      department: pick(row, ['department', 'dept', 'branch']),
      section: pick(row, ['section', 'batch', 'batch no', 'batch number']),
      year: pick(row, ['year', 'passing year', 'graduation year', 'batch year', 'passout year']),
      campus: pick(row, ['campus name', 'campus', 'location', 'centre', 'center']),
    });
    result.added++;
  }

  res.json({ college, ...result });
}));

// Add ONE student individually (admin). Mirrors a single roster row.
router.post('/students', h(async (req, res) => {
  const collegeName = (req.body.college || '').trim();
  const name = (req.body.name || '').trim();
  const profile = (req.body.url || req.body.profile || req.body.leetcode || '').trim();
  if (!collegeName) return res.status(400).json({ error: 'College is required.' });
  if (!name) return res.status(400).json({ error: 'Student name is required.' });
  const username = parseUsername(profile);
  if (!username) return res.status(400).json({ error: 'Enter a valid LeetCode profile URL or username.' });
  const college = await store.getOrCreateCollege(collegeName);
  const clean = (k) => { const v = (req.body[k] || '').trim(); return v || null; };
  const id = await store.upsertStudent({
    college_id: college.id,
    name,
    username,
    profile_url: profile.includes('leetcode.com') ? profile : `https://leetcode.com/u/${username}/`,
    register_number: clean('register_number'),
    email: clean('email'),
    department: clean('department'),
    section: clean('section'),
    year: clean('year'),
    campus: clean('campus'),
  });
  res.json({ ok: true, id, username, college });
}));

// ---- Dashboard --------------------------------------------------------------

router.get('/colleges/:id/dashboard', h(async (req, res) => {
  const collegeId = Number(req.params.id);
  const f = {
    batch: (req.query.batch || '').trim(),
    department: (req.query.department || '').trim(),
    campus: (req.query.campus || '').trim(),
    q: (req.query.q || '').trim(),
    sort: (req.query.sort || '').trim(),
    dir: (req.query.dir || '').trim(),
    risk: req.query.risk === '1',
    page: Math.max(1, Number(req.query.page) || 1),
    pageSize: Math.min(500, Math.max(1, Number(req.query.pageSize) || 100)),
  };

  const light = req.query.light === '1'; // auto-refresh: skip the filter query

  // The monthly chart is fetched separately (its own cached endpoint) so the
  // students table never waits on that heavy college-wide aggregate.
  const [practiceTotal, pageData, totals, filters] = await Promise.all([
    store.countPracticeProblems(collegeId),
    store.getStudentsPage(collegeId, f),
    store.getCollegeTotals(collegeId, f),
    light ? Promise.resolve(null) : store.getFilterOptions(collegeId),
  ]);
  const { rows, total, offset } = pageData;

  // completion counts depend on the page rows, so this one runs after.
  const counts = await store.getCompletedCountsForStudents(rows.map((s) => s.id));

  const students = rows.map((s, i) => ({
    ...omitEmail(s),
    classRank: offset + i + 1,
    practiceCompleted: counts[s.id] || 0,
    practiceTotal,
  }));

  res.json({ students, practiceTotal, totals, monthly: [], filters, page: f.page, pageSize: f.pageSize, total });
}));

// Export the (filtered/sorted) student roster + stats + practice completion to Excel.
router.get('/colleges/:id/export', h(async (req, res) => {
  const collegeId = Number(req.params.id);
  const f = {
    batch: (req.query.batch || '').trim(),
    department: (req.query.department || '').trim(),
    campus: (req.query.campus || '').trim(),
    q: (req.query.q || '').trim(),
    sort: (req.query.sort || '').trim(),
    dir: (req.query.dir || '').trim(),
    risk: req.query.risk === '1',
    all: true,
  };
  const [college, practiceTotal, pageData] = await Promise.all([
    store.getCollege(collegeId),
    store.countPracticeProblems(collegeId),
    store.getStudentsPage(collegeId, f),
  ]);
  const rows = pageData.rows;
  const counts = await store.getCompletedCountsForStudents(rows.map((s) => s.id));

  const header = ['#', 'Name', 'Username', 'Register Number', 'Email', 'Department', 'Batch / Section',
    'Year', 'Campus', 'Global Rank', 'Easy', 'Medium', 'Hard', 'Total Solved', 'Solved Since Start',
    'Practice Completed', 'Practice Total', 'Inactive', 'Profile Found', 'Sync Status', 'Last Synced'];
  const aoa = [header];
  rows.forEach((s, i) => {
    const sinceStart = (s.baseline_total != null) ? (s.solved_total - s.baseline_total) : '';
    aoa.push([
      i + 1, s.name || '', s.username || '', s.register_number || '', s.email || '', s.department || '',
      s.section || '', s.year || '', s.campus || '', s.ranking || '', s.solved_easy || 0, s.solved_medium || 0,
      s.solved_hard || 0, s.solved_total || 0, sinceStart, counts[s.id] || 0, practiceTotal,
      s.at_risk ? 'Yes' : 'No', s.found ? 'Yes' : 'No', s.sync_status || '', s.last_synced_at || '',
    ]);
  });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  XLSX.utils.book_append_sheet(wb, ws, 'Students');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const safe = (college?.name || 'college').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '');
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="${safe}_progress_${stamp}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
}));

// Monthly submission activity for the whole college (the dashboard chart).
// Fetched on its own so it never blocks the table, and cached briefly because
// it only changes on sync — repeated/auto-refresh hits are then instant.
const monthlyCache = new Map(); // key -> { at, data }
const MONTHLY_TTL_MS = 20000;
function invalidateMonthlyCache() { monthlyCache.clear(); }
router.get('/colleges/:id/monthly', h(async (req, res) => {
  const collegeId = Number(req.params.id);
  const f = {
    batch: (req.query.batch || '').trim(),
    department: (req.query.department || '').trim(),
    campus: (req.query.campus || '').trim(),
  };
  const key = collegeId + '|' + JSON.stringify(f);
  const hit = monthlyCache.get(key);
  if (hit && Date.now() - hit.at < MONTHLY_TTL_MS) return res.json({ monthly: hit.data, cached: true });
  const monthly = await store.getCollegeMonthly(collegeId, f);
  monthlyCache.set(key, { at: Date.now(), data: monthly });
  res.json({ monthly });
}));

// ---- Student detail ---------------------------------------------------------

router.get('/students/:id', h(async (req, res) => {
  const s = await store.getStudent(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'student not found' });
  const completions = await store.getCompletionsForStudent(s.id);
  const problems = await store.getPracticeProblemsByCollege(s.college_id);
  const compIds = new Set(completions.map((c) => c.problem_id));
  res.json({
    student: omitEmail(s),
    monthlyActivity: await store.getMonthlyActivity(s.id),
    monthlySolvedGrowth: await store.getMonthlySolvedGrowth(s.id),
    practice: problems.map((p) => ({
      ...p,
      completed: compIds.has(p.id),
      completed_at: completions.find((c) => c.problem_id === p.id)?.completed_at || null,
    })),
  });
}));

router.delete('/students/:id', h(async (req, res) => {
  await store.deleteStudent(Number(req.params.id));
  res.json({ ok: true });
}));

router.post('/students/:id/sync', h(async (req, res) => {
  const r = await runSyncStudent(Number(req.params.id));
  res.json(r);
}));

// Reset a student's progress baseline to their current stats.
router.post('/students/:id/reset-baseline', h(async (req, res) => {
  await store.resetBaseline(Number(req.params.id));
  res.json({ ok: true });
}));

// Manual completion override (admin marks/unmarks a question for a student).
router.post('/students/:id/completions/:problemId', h(async (req, res) => {
  const ok = await store.markCompletion(Number(req.params.id), Number(req.params.problemId), null);
  res.json({ ok: true, added: ok });
}));
router.delete('/students/:id/completions/:problemId', h(async (req, res) => {
  const ok = await store.unmarkCompletion(Number(req.params.id), Number(req.params.problemId));
  res.json({ ok: true, removed: ok });
}));

// ---- Practice tab -----------------------------------------------------------

router.get('/colleges/:id/practice', h(async (req, res) => {
  const collegeId = Number(req.params.id);
  const [problems, problemCounts, totalsAll, topics, domains, completionDist, college] = await Promise.all([
    store.listPracticeProblems(collegeId),
    store.getCompletedCountsByProblem(collegeId),
    store.getCollegeTotals(collegeId, {}),
    store.listTopics(collegeId),
    store.listDomains(collegeId),
    store.getPracticeDistribution(collegeId),
    store.getCollege(collegeId),
  ]);
  res.json({
    studentCount: totalsAll.students,
    topics,
    domains,
    completionDist,
    showVideo: videoShown(college),
    problems: problems.map((p) => ({
      ...p,
      completedCount: problemCounts[p.id] || 0,
    })),
  });
}));

// Toggle whether students see the video links for this college.
router.post('/colleges/:id/video-visibility', h(async (req, res) => {
  const collegeId = Number(req.params.id);
  const show = !!req.body?.show;
  await store.setShowVideo(collegeId, show);
  res.json({ ok: true, showVideo: show });
}));

// Drill-down: who completed / didn't complete ONE specific problem.
router.get('/colleges/:id/practice/:problemId/completion', h(async (req, res) => {
  const r = await store.getProblemCompletion(Number(req.params.id), Number(req.params.problemId));
  res.json(r);
}));

// Drill-down: students who completed exactly N assigned problems.
router.get('/colleges/:id/practice-completers', h(async (req, res) => {
  const collegeId = Number(req.params.id);
  const count = Math.max(0, Number(req.query.count) || 0);
  const students = await store.getStudentsByCompletedCount(collegeId, count);
  res.json({ count, students: students.map((s) => omitEmail(s)) });
}));

// Save a custom order for domains or topics (admin drag-to-reorder).
router.post('/colleges/:id/practice-order', h(async (req, res) => {
  const collegeId = Number(req.params.id);
  const kind = req.body?.kind;
  const names = req.body?.names;
  if (!['domain', 'topic'].includes(kind) || !Array.isArray(names))
    return res.status(400).json({ error: 'kind (domain|topic) and names[] are required.' });
  await store.setPracticeOrder(collegeId, kind, names.map((n) => String(n)));
  res.json({ ok: true });
}));

// Add practice problems. Accepts either:
//   - JSON body { links: "url1\nurl2..." }  (textarea paste), or
//   - a multipart Excel file with Title/URL/Difficulty columns.
router.post('/colleges/:id/practice', upload.single('file'), h(async (req, res) => {
  const collegeId = Number(req.params.id);
  const formTopic = (req.body.topic || '').trim() || null;      // applies to all when set
  const formDomain = (req.body.domain || '').trim() || null;
  const formDifficulty = (req.body.difficulty || '').trim() || null;
  const formVideo = (req.body.video || '').trim() || null;
  const formDue = normDate(req.body.dueDate || req.body.due_date);
  const items = [];

  if (req.file) {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    for (const row of rows) {
      const url = pick(row, ['url', 'link', 'leetcode link', 'problem', 'problem url', 'question', 'question link']);
      if (!url) continue;
      items.push({
        url,
        title: pick(row, ['title', 'name', 'problem name', 'question']),
        difficulty: pick(row, ['difficulty', 'level']) || formDifficulty, // row value wins
        topic: pick(row, ['topic', 'category', 'tag']) || formTopic,
        domain: pick(row, ['domain', 'area', 'subject']) || formDomain,
        video: pick(row, ['video', 'video link', 'video url', 'youtube', 'youtube link']) || formVideo,
        due: normDate(pick(row, ['deadline', 'due', 'due date', 'due_date'])) || formDue,
      });
    }
  } else {
    // Pair the two textareas by line: question on line N ↔ video on line N.
    // Split on newlines only (not commas) so line positions stay aligned.
    const linkLines = (req.body.links || '').split(/\r?\n/);
    const videoLines = (req.body.videos || '').split(/\r?\n/);
    linkLines.forEach((raw, i) => {
      const url = raw.trim();
      if (!url) return;
      const video = (videoLines[i] || '').trim() || formVideo;
      items.push({ url, topic: formTopic, domain: formDomain, difficulty: formDifficulty, video, due: formDue });
    });
  }

  if (!items.length) return res.status(400).json({ error: 'No problem links found.' });

  const added = [];
  const skipped = [];
  for (const it of items) {
    const slug = parseProblemSlug(it.url);
    if (!slug) { skipped.push(it.url); continue; }
    const url = it.url.includes('leetcode.com') ? it.url : `https://leetcode.com/problems/${slug}/`;
    const id = await store.addPracticeProblem({
      college_id: collegeId,
      title: it.title || titleize(slug),
      slug,
      url,
      difficulty: it.difficulty || null,
      topic: it.topic || null,
      domain: it.domain || null,
      video_url: it.video || null,
      due_date: it.due || null,
    });
    added.push({ id, slug });
  }
  res.json({ added: added.length, skipped });
}));

router.delete('/practice/:id', h(async (req, res) => {
  await store.deletePracticeProblem(Number(req.params.id));
  res.json({ ok: true });
}));

// Remove every question under one domain+topic ("Remove all" on a topic header).
router.delete('/colleges/:id/practice-by-topic', h(async (req, res) => {
  const collegeId = Number(req.params.id);
  const domain = (req.query.domain || '') === 'Uncategorized' ? null : (req.query.domain || '');
  const topic = (req.query.topic || '') === 'Uncategorized' ? null : (req.query.topic || '');
  const removed = await store.deletePracticeByTopic(collegeId, domain, topic);
  res.json({ removed });
}));

// ---- Sync controls ----------------------------------------------------------

router.post('/colleges/:id/sync', (req, res) => {
  runSync({ collegeId: Number(req.params.id) }).catch((e) => console.error('sync error', e.message));
  res.json({ started: true });
});

router.post('/sync', (req, res) => {
  runSync().catch((e) => console.error('sync error', e.message));
  res.json({ started: true });
});

router.get('/sync/state', (req, res) => res.json(getSyncState()));

// Master on/off across all colleges at once.
router.post('/colleges/bulk-settings', h(async (req, res) => {
  const clean = (m) => (['on', 'off', 'scheduled'].includes(m) ? m : null);
  await store.setAllCollegesMode({ sync_mode: clean(req.body?.sync_mode), refresh_mode: clean(req.body?.refresh_mode) });
  res.json({ ok: true });
}));

// Per-college auto-sync + auto-refresh settings.
router.post('/colleges/:id/settings', h(async (req, res) => {
  const clean = (m) => (['on', 'off', 'scheduled'].includes(m) ? m : 'on');
  const t = (v) => { const s = (v || '').trim(); return /^\d{2}:\d{2}$/.test(s) ? s : null; };
  const s = {
    sync_mode: clean(req.body?.sync_mode),
    sync_from: t(req.body?.sync_from),
    sync_to: t(req.body?.sync_to),
    refresh_mode: clean(req.body?.refresh_mode),
    refresh_from: t(req.body?.refresh_from),
    refresh_to: t(req.body?.refresh_to),
  };
  await store.setCollegeSettings(Number(req.params.id), s);
  res.json({ ok: true, settings: s });
}));

// ---- Chrome-extension integration ------------------------------------------

router.get('/colleges/:id/scrape-config', h(async (req, res) => {
  const collegeId = Number(req.params.id);
  const students = await store.listStudents(collegeId);
  const problems = await store.listPracticeProblems(collegeId);
  res.json({
    collegeId,
    profiles: students.map((s) => s.profile_url || s.username),
    usernames: students.map((s) => s.username),
    questions: problems.map((p) => ({ slug: p.slug, title: p.title, url: p.url })),
  });
}));

// The extension POSTs scraped results here. `college` may be an id or a name.
router.post('/ingest', h(async (req, res) => {
  const { college, results } = req.body || {};
  if (!Array.isArray(results)) return res.status(400).json({ error: 'results[] required' });
  let collegeId = Number(college);
  if (!collegeId || Number.isNaN(collegeId)) {
    if (!college) return res.status(400).json({ error: 'college (id or name) required' });
    collegeId = (await store.getOrCreateCollege(String(college))).id;
  }
  const summary = await ingestResults(collegeId, results);
  invalidateMonthlyCache(); // fresh submissions arrived — drop the cached chart
  res.json({ ok: true, collegeId, ...summary });
}));

// Import the CSV the extension exports (fallback when not pushing live).
router.post('/import-csv', upload.single('file'), h(async (req, res) => {
  const collegeName = (req.body.college || '').trim();
  if (!collegeName) return res.status(400).json({ error: 'College name is required.' });
  if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded.' });

  const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  if (!rows.length) return res.status(400).json({ error: 'The file appears to be empty.' });

  const KNOWN = new Set([
    'username', 'profile url', 'rank', 'easy questions', 'medium questions',
    'hard questions', 'error/comment', 'easy', 'medium', 'hard', 'total',
  ]);
  const results = rows.map((row) => {
    const get = (alias) => pick(row, [alias]);
    const questions = {};
    for (const [k, v] of Object.entries(row)) {
      if (!KNOWN.has(k.trim().toLowerCase())) questions[k] = v;
    }
    return {
      username: get('username') || get('profile url'),
      profileUrl: get('profile url'),
      rank: get('rank'),
      easy: get('easy questions') || get('easy'),
      medium: get('medium questions') || get('medium'),
      hard: get('hard questions') || get('hard'),
      total: get('total'),
      comment: get('error/comment'),
      questions,
    };
  });

  const collegeId = (await store.getOrCreateCollege(collegeName)).id;
  const summary = await ingestResults(collegeId, results);
  invalidateMonthlyCache(); // fresh submissions arrived — drop the cached chart
  res.json({ ok: true, collegeId, ...summary });
}));

// ---- Excel template download ------------------------------------------------

router.get('/template', (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Student Name', 'Register Number', 'Email ID', 'Department', 'Section', 'Year', 'Campus name', 'LeetCode URL'],
    ['Asha Rao', '2023002199', 'arao@gitam.in', 'CSE', 'Batch-16', '2027', 'Vizag', 'https://leetcode.com/u/asharao/'],
    ['Vivek Kumar', '2023008288', 'vkumar@gitam.in', 'CSE', 'Batch-11', '2027', 'Vizag', 'vivekk'],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Students');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="student_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// Practice-problems upload template.
router.get('/practice-template', (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['URL', 'Domain', 'Topic', 'Difficulty', 'Title', 'Video', 'Deadline'],
    ['https://leetcode.com/problems/missing-number/', 'Fundamentals of Programming', 'Array', 'Easy', 'Missing Number', 'https://youtu.be/WnPLSRLSANE', '2026-07-15'],
    ['https://leetcode.com/problems/add-two-numbers/', 'Data Structures', 'Linked List', 'Medium', '', '', ''],
    ['trapping-rain-water', 'Algorithms', 'Two Pointers', 'Hard', '', '', ''],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Problems');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="practice_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});
