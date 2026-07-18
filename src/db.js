import { randomUUID } from 'node:crypto';
import { db } from './sqlite.js';
export { db };

db.exec(`
  CREATE TABLE IF NOT EXISTS colleges (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS students (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    college_id    INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    username      TEXT NOT NULL,
    profile_url   TEXT,
    ranking       INTEGER,
    contest_rating INTEGER,
    solved_easy   INTEGER DEFAULT 0,
    solved_medium INTEGER DEFAULT 0,
    solved_hard   INTEGER DEFAULT 0,
    solved_total  INTEGER DEFAULT 0,
    found         INTEGER DEFAULT 1,          -- 0 if profile not found / private
    sync_status   TEXT DEFAULT 'pending',     -- pending | ok | error
    sync_error    TEXT,
    last_synced_at TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(college_id, username)
  );

  -- Monthly submission activity derived from the LeetCode submission calendar.
  CREATE TABLE IF NOT EXISTS monthly_activity (
    student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    ym          TEXT NOT NULL,                -- 'YYYY-MM'
    submissions INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (student_id, ym)
  );

  -- Periodic snapshots of solved-by-difficulty totals so per-month *solved*
  -- growth can be computed by diffing snapshots over time.
  CREATE TABLE IF NOT EXISTS stat_snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    taken_at    TEXT NOT NULL DEFAULT (datetime('now')),
    solved_easy INTEGER, solved_medium INTEGER, solved_hard INTEGER, solved_total INTEGER
  );

  CREATE TABLE IF NOT EXISTS practice_problems (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    college_id  INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    slug        TEXT NOT NULL,
    url         TEXT NOT NULL,
    difficulty  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(college_id, slug)
  );

  CREATE TABLE IF NOT EXISTS practice_completions (
    student_id        INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    problem_id        INTEGER NOT NULL REFERENCES practice_problems(id) ON DELETE CASCADE,
    completed_at      TEXT NOT NULL DEFAULT (datetime('now')),
    solved_timestamp  INTEGER,
    PRIMARY KEY (student_id, problem_id)
  );

  -- Custom ordering for domains/topics (admin drag-to-reorder).
  CREATE TABLE IF NOT EXISTS practice_order (
    college_id INTEGER NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,            -- 'domain' | 'topic'
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL,
    PRIMARY KEY (college_id, kind, name)
  );
`);

// Indexes for the hot paths (foreign keys used in joins/aggregates).
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_students_college ON students(college_id);
  CREATE INDEX IF NOT EXISTS idx_problems_college ON practice_problems(college_id);
  CREATE INDEX IF NOT EXISTS idx_snap_student ON stat_snapshots(student_id);
  CREATE INDEX IF NOT EXISTS idx_ma_student ON monthly_activity(student_id);
  CREATE INDEX IF NOT EXISTS idx_pc_student ON practice_completions(student_id);
  CREATE INDEX IF NOT EXISTS idx_pc_problem ON practice_completions(problem_id);
`);

// ---- Migrations -------------------------------------------------------------

// Add colleges.access_code if it doesn't exist yet (student-login gate).
const collegeCols = db.prepare('PRAGMA table_info(colleges)').all();
if (!collegeCols.some((c) => c.name === 'access_code')) {
  db.exec('ALTER TABLE colleges ADD COLUMN access_code TEXT');
}
if (!collegeCols.some((c) => c.name === 'view_token')) {
  db.exec('ALTER TABLE colleges ADD COLUMN view_token TEXT');
}
// Per-college switch: show practice video links to students (1 = show, 0 = hide).
if (!collegeCols.some((c) => c.name === 'show_video')) {
  db.exec('ALTER TABLE colleges ADD COLUMN show_video INTEGER NOT NULL DEFAULT 1');
}
// Per-college auto-sync and auto-refresh mode ('on'|'off'|'scheduled') + time windows.
for (const [col, def] of [
  ['sync_mode', "'on'"], ['sync_from', 'NULL'], ['sync_to', 'NULL'],
  ['refresh_mode', "'on'"], ['refresh_from', 'NULL'], ['refresh_to', 'NULL'],
]) {
  if (!collegeCols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE colleges ADD COLUMN ${col} TEXT DEFAULT ${def}`);
  }
}
const problemCols = db.prepare('PRAGMA table_info(practice_problems)').all();
if (!problemCols.some((c) => c.name === 'topic')) {
  db.exec('ALTER TABLE practice_problems ADD COLUMN topic TEXT');
}
if (!problemCols.some((c) => c.name === 'domain')) {
  db.exec('ALTER TABLE practice_problems ADD COLUMN domain TEXT');
}
if (!problemCols.some((c) => c.name === 'video_url')) {
  db.exec('ALTER TABLE practice_problems ADD COLUMN video_url TEXT');
}
if (!problemCols.some((c) => c.name === 'due_date')) {
  db.exec('ALTER TABLE practice_problems ADD COLUMN due_date TEXT'); // ISO yyyy-mm-dd, nullable
}
// Denormalize college_id onto monthly_activity so the whole-college chart is a
// single indexed scan instead of a per-student join. Backfill existing rows.
const maCols = db.prepare('PRAGMA table_info(monthly_activity)').all();
if (!maCols.some((c) => c.name === 'college_id')) {
  db.exec('ALTER TABLE monthly_activity ADD COLUMN college_id INTEGER');
  db.exec(`UPDATE monthly_activity SET college_id =
    (SELECT college_id FROM students WHERE students.id = monthly_activity.student_id)
    WHERE college_id IS NULL`);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_ma_college_ym ON monthly_activity(college_id, ym)');
// Global key/value settings (e.g. server-sync mode). Not per-college.
db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)');
// Baseline = the stats captured on a student's FIRST successful sync, so we can
// show progress (current minus baseline) on every sync afterwards.
const studentCols = db.prepare('PRAGMA table_info(students)').all();
for (const col of ['baseline_ranking', 'baseline_easy', 'baseline_medium', 'baseline_hard', 'baseline_total']) {
  if (!studentCols.some((c) => c.name === col)) db.exec(`ALTER TABLE students ADD COLUMN ${col} INTEGER`);
}
if (!studentCols.some((c) => c.name === 'baseline_at')) {
  db.exec('ALTER TABLE students ADD COLUMN baseline_at TEXT');
}
// Roster metadata columns.
for (const col of ['register_number', 'email', 'department', 'section', 'year', 'campus']) {
  if (!studentCols.some((c) => c.name === col)) db.exec(`ALTER TABLE students ADD COLUMN ${col} TEXT`);
}

// No-op for SQLite (schema is created at import above). Mirrors pgstore's API.
export async function initStore() {
  console.log('[db] driver: sqlite');
}

// ---- College helpers --------------------------------------------------------

export async function getOrCreateCollege(name) {
  const clean = String(name).trim();
  db.prepare('INSERT OR IGNORE INTO colleges(name) VALUES (?)').run(clean);
  return db.prepare('SELECT * FROM colleges WHERE name = ?').get(clean);
}

// Public-safe list (never exposes the access code).
export const listColleges = async () =>
  db.prepare(
    `SELECT c.id, c.name, c.created_at,
       c.sync_mode, c.sync_from, c.sync_to, c.refresh_mode, c.refresh_from, c.refresh_to,
       CASE WHEN c.access_code IS NOT NULL AND c.access_code != '' THEN 1 ELSE 0 END AS has_code,
       (SELECT COUNT(*) FROM students s WHERE s.college_id = c.id) AS student_count
     FROM colleges c ORDER BY c.name`
  ).all();

// Master on/off: set one mode across EVERY college at once (windows untouched).
export async function setAllCollegesMode({ sync_mode, refresh_mode }) {
  if (sync_mode) db.prepare('UPDATE colleges SET sync_mode=?').run(sync_mode);
  if (refresh_mode) db.prepare('UPDATE colleges SET refresh_mode=?').run(refresh_mode);
}

// Save a college's auto-sync / auto-refresh settings.
export async function setCollegeSettings(id, s) {
  db.prepare(
    `UPDATE colleges SET sync_mode=?, sync_from=?, sync_to=?, refresh_mode=?, refresh_from=?, refresh_to=? WHERE id=?`
  ).run(s.sync_mode, s.sync_from || null, s.sync_to || null, s.refresh_mode, s.refresh_from || null, s.refresh_to || null, id);
}

// Global settings key/value.
export const getSetting = async (key) => {
  const r = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  return r ? r.value : null;
};
export const setSetting = async (key, value) =>
  db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, value);

export const getCollege = async (id) => db.prepare('SELECT * FROM colleges WHERE id = ?').get(id);

// Deletes the college and cascades to its students, practice problems,
// completions and snapshots (FK ON DELETE CASCADE + PRAGMA foreign_keys=ON).
export const deleteCollege = async (id) => db.prepare('DELETE FROM colleges WHERE id = ?').run(id);

export const setAccessCode = async (id, code) =>
  db.prepare('UPDATE colleges SET access_code = ? WHERE id = ?').run((code || '').trim(), id);

export async function checkAccessCode(id, code) {
  const c = await getCollege(id);
  if (!c || !c.access_code) return false;
  return String(code || '').trim() === String(c.access_code).trim();
}

// Read-only share link (unguessable token per college).
export const getCollegeByToken = async (t) =>
  t ? db.prepare('SELECT * FROM colleges WHERE view_token = ?').get(t) : undefined;

export async function ensureViewToken(id, regenerate = false) {
  const c = await getCollege(id);
  if (!c) return null;
  if (c.view_token && !regenerate) return c.view_token;
  const token = randomUUID();
  db.prepare('UPDATE colleges SET view_token = ? WHERE id = ?').run(token, id);
  return token;
}

// Names only — for the student login name-picker (no stats leaked).
export const studentsBasic = async (collegeId) =>
  db.prepare('SELECT id, name, username FROM students WHERE college_id = ? ORDER BY name')
    .all(collegeId);

// ---- Student helpers --------------------------------------------------------

export async function upsertStudent({
  college_id, name, username, profile_url,
  register_number = null, email = null, department = null, section = null, year = null, campus = null,
}) {
  const stmt = db.prepare(`
    INSERT INTO students (college_id, name, username, profile_url, register_number, email, department, section, year, campus)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(college_id, username) DO UPDATE SET
      name = excluded.name,
      profile_url     = COALESCE(excluded.profile_url, profile_url),
      register_number = COALESCE(excluded.register_number, register_number),
      email           = COALESCE(excluded.email, email),
      department      = COALESCE(excluded.department, department),
      section         = COALESCE(excluded.section, section),
      year            = COALESCE(excluded.year, year),
      campus          = COALESCE(excluded.campus, campus)
    RETURNING id`);
  return stmt.get(college_id, name, username, profile_url, register_number, email, department, section, year, campus).id;
}

export const listStudents = async (collegeId) =>
  db.prepare('SELECT * FROM students WHERE college_id = ? ORDER BY solved_total DESC, name')
    .all(collegeId);

// Build a WHERE clause + params for the student filters (batch/dept/campus/search).
function studentWhere(collegeId, f = {}) {
  // Qualify college_id — monthly_activity also has it now, so the filtered
  // monthly JOIN would otherwise be "ambiguous column name: college_id".
  const cond = ['students.college_id = ?'];
  const params = [collegeId];
  if (f.batch) { cond.push('section = ?'); params.push(f.batch); }
  if (f.department) { cond.push('department = ?'); params.push(f.department); }
  if (f.campus) { cond.push('campus = ?'); params.push(f.campus); }
  if (f.q) {
    cond.push('(name LIKE ? OR username LIKE ? OR register_number LIKE ?)');
    const l = '%' + f.q + '%';
    params.push(l, l, l);
  }
  return { where: cond.join(' AND '), params };
}

// At-risk = tracked for at least a week but zero solved-growth since the first
// snapshot (i.e. the student hasn't solved anything new while being tracked).
const RISK_SQL = "(baseline_at IS NOT NULL AND baseline_at <= datetime('now','-7 days') AND (solved_total - COALESCE(baseline_total,0)) <= 0)";

function studentOrderBy(f) {
  const dir = f.dir === 'asc' ? 'ASC' : f.dir === 'desc' ? 'DESC' : null;
  switch (f.sort) {
    case 'name': return `name ${dir || 'ASC'}`;
    case 'rank': return `(ranking IS NULL), ranking ${dir || 'ASC'}, name`;
    case 'practice': return `(SELECT COUNT(*) FROM practice_completions pc WHERE pc.student_id = students.id) ${dir || 'DESC'}, name`;
    case 'total':
    default: return `solved_total ${dir || 'DESC'}, name`;
  }
}

// Paginated + filtered student list. Supports sort (f.sort/f.dir), an at-risk
// filter (f.risk), and an unpaginated export mode (f.all). Returns { rows, total, offset }.
export async function getStudentsPage(collegeId, f = {}) {
  const { where, params } = studentWhere(collegeId, f);
  const fullWhere = f.risk ? `${where} AND ${RISK_SQL}` : where;
  const total = db.prepare(`SELECT COUNT(*) AS c FROM students WHERE ${fullWhere}`).get(...params).c;
  const all = f.all === true || f.all === '1';
  const pageSize = all ? total || 1 : Math.min(500, Math.max(1, f.pageSize || 100));
  const page = Math.max(1, f.page || 1);
  const offset = all ? 0 : (page - 1) * pageSize;
  const sql = `SELECT *, ${RISK_SQL} AS at_risk FROM students WHERE ${fullWhere} ORDER BY ${studentOrderBy(f)}`
    + (all ? '' : ' LIMIT ? OFFSET ?');
  const rows = all ? db.prepare(sql).all(...params) : db.prepare(sql).all(...params, pageSize, offset);
  return { rows, total, offset };
}

export async function getCollegeTotals(collegeId, f = {}) {
  const { where, params } = studentWhere(collegeId, f);
  return db.prepare(`
    SELECT COUNT(*) AS students,
      COALESCE(SUM(solved_easy),0) AS easy,
      COALESCE(SUM(solved_medium),0) AS medium,
      COALESCE(SUM(solved_hard),0) AS hard,
      COALESCE(SUM(solved_total),0) AS total
    FROM students WHERE ${where}`).get(...params);
}

export async function getCollegeMonthly(collegeId, f = {}) {
  // Fast path (the common "whole college" case): no student-attribute filters,
  // so read straight off the denormalized column + index — no join.
  if (!f.batch && !f.department && !f.campus && !f.q) {
    return db.prepare(
      `SELECT ym, SUM(submissions) AS submissions FROM monthly_activity
       WHERE college_id = ? GROUP BY ym ORDER BY ym`).all(collegeId);
  }
  const { where, params } = studentWhere(collegeId, f);
  return db.prepare(`
    SELECT ym, SUM(submissions) AS submissions
    FROM monthly_activity JOIN students ON students.id = monthly_activity.student_id
    WHERE ${where} GROUP BY ym ORDER BY ym`).all(...params);
}

export async function getFilterOptions(collegeId) {
  const distinct = (col) =>
    db.prepare(`SELECT DISTINCT ${col} AS v FROM students WHERE college_id=? AND ${col} IS NOT NULL AND ${col}<>'' ORDER BY ${col}`)
      .all(collegeId).map((r) => r.v);
  return { batches: distinct('section'), departments: distinct('department'), campuses: distinct('campus'), years: distinct('year') };
}

export const getAllStudents = async () => db.prepare('SELECT * FROM students').all();
// The N students least-recently synced (never-synced first) — for staggered refresh.
// allowedCollegeIds (optional array) restricts to those colleges; [] => none.
export async function getStaleStudents(limit, allowedCollegeIds) {
  if (Array.isArray(allowedCollegeIds)) {
    if (!allowedCollegeIds.length) return [];
    const ph = allowedCollegeIds.map(() => '?').join(',');
    return db.prepare(`SELECT * FROM students WHERE college_id IN (${ph}) ORDER BY last_synced_at ASC LIMIT ?`)
      .all(...allowedCollegeIds, limit);
  }
  return db.prepare('SELECT * FROM students ORDER BY last_synced_at ASC LIMIT ?').all(limit);
}
// A student's rank within their college by total solved (ties share a rank).
export const getRankInCollege = async (collegeId, solvedTotal) =>
  db.prepare('SELECT COUNT(*) AS c FROM students WHERE college_id=? AND solved_total > ?')
    .get(collegeId, solvedTotal).c + 1;
export const getStudent = async (id) => db.prepare('SELECT * FROM students WHERE id = ?').get(id);
export const getStudentByUsername = async (collegeId, username) =>
  db.prepare('SELECT * FROM students WHERE college_id=? AND username=?').get(collegeId, username);
export const getStudentByEmail = async (collegeId, email) =>
  db.prepare('SELECT * FROM students WHERE college_id=? AND LOWER(email)=LOWER(?)').get(collegeId, String(email).trim());
export const deleteStudent = async (id) => db.prepare('DELETE FROM students WHERE id = ?').run(id);

export async function saveStudentStats(id, stats) {
  if (!stats.found) {
    db.prepare(
      `UPDATE students SET found=0, sync_status='error',
       sync_error='Profile not found or private', last_synced_at=datetime('now') WHERE id=?`
    ).run(id);
    return;
  }
  db.prepare(`
    UPDATE students SET
      found=1, ranking=?, contest_rating=?,
      solved_easy=?, solved_medium=?, solved_hard=?, solved_total=?,
      baseline_ranking=COALESCE(baseline_ranking, ?),
      baseline_easy=COALESCE(baseline_easy, ?),
      baseline_medium=COALESCE(baseline_medium, ?),
      baseline_hard=COALESCE(baseline_hard, ?),
      baseline_total=COALESCE(baseline_total, ?),
      baseline_at=COALESCE(baseline_at, datetime('now')),
      sync_status='ok', sync_error=NULL, last_synced_at=datetime('now')
    WHERE id=?`).run(
    stats.ranking ?? null,
    stats.contestRating ?? null,
    stats.solved.easy,
    stats.solved.medium,
    stats.solved.hard,
    stats.solved.total,
    stats.ranking ?? null,
    stats.solved.easy,
    stats.solved.medium,
    stats.solved.hard,
    stats.solved.total,
    id
  );

  db.prepare(
    `INSERT INTO stat_snapshots(student_id, solved_easy, solved_medium, solved_hard, solved_total)
     VALUES (?,?,?,?,?)`
  ).run(id, stats.solved.easy, stats.solved.medium, stats.solved.hard, stats.solved.total);

  // Roll the submission calendar up into monthly buckets.
  const monthly = {};
  for (const [ts, count] of Object.entries(stats.submissionCalendar || {})) {
    const d = new Date(Number(ts) * 1000);
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    monthly[ym] = (monthly[ym] || 0) + Number(count);
  }
  const crow = db.prepare('SELECT college_id FROM students WHERE id=?').get(id);
  const cid = crow ? crow.college_id : null;
  const up = db.prepare(`
    INSERT INTO monthly_activity(student_id, ym, submissions, college_id) VALUES (?,?,?,?)
    ON CONFLICT(student_id, ym) DO UPDATE SET submissions=excluded.submissions, college_id=excluded.college_id`);
  const entries = Object.entries(monthly);
  db.exec('BEGIN');
  try {
    for (const [ym, count] of entries) up.run(id, ym, count, cid);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Re-anchor a student's baseline to their CURRENT stats (start a fresh
// progress-measurement period from now).
export async function resetBaseline(id) {
  db.prepare(`UPDATE students SET
    baseline_ranking=ranking, baseline_easy=solved_easy, baseline_medium=solved_medium,
    baseline_hard=solved_hard, baseline_total=solved_total, baseline_at=datetime('now')
    WHERE id=?`).run(id);
}

export async function setSyncError(id, message) {
  db.prepare(
    `UPDATE students SET sync_status='error', sync_error=?, last_synced_at=datetime('now') WHERE id=?`
  ).run(message, id);
}

export const getMonthlyActivity = async (studentId) =>
  db.prepare('SELECT ym, submissions FROM monthly_activity WHERE student_id=? ORDER BY ym')
    .all(studentId);

// Per-month *solved* growth by difficulty, computed from snapshot diffs.
// Returns [{ ym, easy, medium, hard, total }] — only months with >=2 snapshots
// or a prior baseline produce meaningful numbers.
export async function getMonthlySolvedGrowth(studentId) {
  const snaps = db
    .prepare('SELECT taken_at, solved_easy, solved_medium, solved_hard, solved_total FROM stat_snapshots WHERE student_id=? ORDER BY taken_at')
    .all(studentId);
  if (snaps.length < 2) return [];
  // last snapshot per month
  const lastByMonth = new Map();
  for (const s of snaps) {
    const ym = s.taken_at.slice(0, 7);
    lastByMonth.set(ym, s);
  }
  const months = [...lastByMonth.keys()].sort();
  const out = [];
  let prev = snaps[0];
  for (const ym of months) {
    const cur = lastByMonth.get(ym);
    out.push({
      ym,
      easy: Math.max(0, cur.solved_easy - prev.solved_easy),
      medium: Math.max(0, cur.solved_medium - prev.solved_medium),
      hard: Math.max(0, cur.solved_hard - prev.solved_hard),
      total: Math.max(0, cur.solved_total - prev.solved_total),
    });
    prev = cur;
  }
  return out;
}

// ---- Practice helpers -------------------------------------------------------

export async function addPracticeProblem({ college_id, title, slug, url, difficulty, topic, domain, video_url, due_date }) {
  const stmt = db.prepare(`
    INSERT INTO practice_problems(college_id, title, slug, url, difficulty, topic, domain, video_url, due_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(college_id, slug) DO UPDATE SET
      title=excluded.title, url=excluded.url, difficulty=excluded.difficulty,
      topic=excluded.topic, domain=excluded.domain,
      video_url=COALESCE(excluded.video_url, practice_problems.video_url),
      due_date=COALESCE(excluded.due_date, practice_problems.due_date)
    RETURNING id`);
  return stmt.get(college_id, title, slug, url, difficulty, topic ?? null, domain ?? null, video_url ?? null, due_date ?? null).id;
}

// Per-college toggle for showing video links in the student/shared views.
export async function setShowVideo(collegeId, show) {
  db.prepare('UPDATE colleges SET show_video=? WHERE id=?').run(show ? 1 : 0, collegeId);
}

export const listPracticeProblems = async (collegeId) =>
  db.prepare('SELECT * FROM practice_problems WHERE college_id=? ORDER BY domain, topic, created_at DESC')
    .all(collegeId);

// Distinct topics / domains used by a college (for the add-problem pickers + tabs).
export const listTopics = async (collegeId) =>
  db.prepare(
    `SELECT DISTINCT pp.topic AS name, COALESCE(po.position, 1000000) AS pos
     FROM practice_problems pp
     LEFT JOIN practice_order po ON po.college_id=pp.college_id AND po.kind='topic' AND po.name=pp.topic
     WHERE pp.college_id=? AND pp.topic IS NOT NULL AND pp.topic<>''
     ORDER BY pos, name`
  ).all(collegeId).map((r) => r.name);

export const listDomains = async (collegeId) =>
  db.prepare(
    `SELECT DISTINCT pp.domain AS name, COALESCE(po.position, 1000000) AS pos
     FROM practice_problems pp
     LEFT JOIN practice_order po ON po.college_id=pp.college_id AND po.kind='domain' AND po.name=pp.domain
     WHERE pp.college_id=? AND pp.domain IS NOT NULL AND pp.domain<>''
     ORDER BY pos, name`
  ).all(collegeId).map((r) => r.name);

// Save a custom order for domains or topics (positions = array index).
export async function setPracticeOrder(collegeId, kind, names) {
  const del = db.prepare('DELETE FROM practice_order WHERE college_id=? AND kind=?');
  const ins = db.prepare('INSERT INTO practice_order(college_id, kind, name, position) VALUES (?,?,?,?)');
  db.exec('BEGIN');
  try {
    del.run(collegeId, kind);
    names.forEach((n, i) => ins.run(collegeId, kind, n, i));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const getPracticeProblemsByCollege = async (collegeId) =>
  db.prepare('SELECT * FROM practice_problems WHERE college_id=?').all(collegeId);

export const getProblemBySlug = async (collegeId, slug) =>
  db.prepare('SELECT * FROM practice_problems WHERE college_id=? AND slug=?').get(collegeId, slug);

export const countPracticeProblems = async (collegeId) =>
  db.prepare('SELECT COUNT(*) AS c FROM practice_problems WHERE college_id=?').get(collegeId).c;

export const deletePracticeProblem = async (id) =>
  db.prepare('DELETE FROM practice_problems WHERE id=?').run(id);

// Remove every question under one domain+topic. `domain`/`topic` may be null to
// match the "Uncategorized" bucket (NULL or empty string).
export async function deletePracticeByTopic(collegeId, domain, topic) {
  const domCond = domain === null ? "(domain IS NULL OR domain='')" : 'domain=?';
  const topCond = topic === null ? "(topic IS NULL OR topic='')" : 'topic=?';
  const params = [collegeId];
  if (domain !== null) params.push(domain);
  if (topic !== null) params.push(topic);
  return db.prepare(
    `DELETE FROM practice_problems WHERE college_id=? AND ${domCond} AND ${topCond}`
  ).run(...params).changes;
}

export async function markCompletion(studentId, problemId, solvedTimestamp) {
  const r = db.prepare(`
    INSERT OR IGNORE INTO practice_completions(student_id, problem_id, solved_timestamp)
    VALUES (?,?,?)`).run(studentId, problemId, solvedTimestamp ?? null);
  return r.changes > 0; // true if newly inserted
}

// Manual admin override: remove a single completion record.
export async function unmarkCompletion(studentId, problemId) {
  return db.prepare('DELETE FROM practice_completions WHERE student_id=? AND problem_id=?')
    .run(studentId, problemId).changes > 0;
}

export const getCompletionsForCollege = async (collegeId) =>
  db.prepare(`
    SELECT pc.student_id, pc.problem_id, pc.completed_at
    FROM practice_completions pc
    JOIN practice_problems pp ON pp.id = pc.problem_id
    WHERE pp.college_id = ?`).all(collegeId);

// Aggregated completion counts (scale-friendly — no row dumps).
export async function getCompletedCountsForStudents(studentIds) {
  if (!studentIds || !studentIds.length) return {};
  const ph = studentIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT student_id, COUNT(*) AS c FROM practice_completions WHERE student_id IN (${ph}) GROUP BY student_id`
  ).all(...studentIds);
  const m = {};
  for (const r of rows) m[r.student_id] = r.c;
  return m;
}
export async function getCompletedCountsByProblem(collegeId) {
  const rows = db.prepare(
    `SELECT pc.problem_id AS pid, COUNT(*) AS c
     FROM practice_completions pc JOIN practice_problems pp ON pp.id = pc.problem_id
     WHERE pp.college_id = ? GROUP BY pc.problem_id`
  ).all(collegeId);
  const m = {};
  for (const r of rows) m[r.pid] = r.c;
  return m;
}

export const getCompletionsForStudent = async (studentId) =>
  db.prepare('SELECT problem_id, completed_at FROM practice_completions WHERE student_id=?')
    .all(studentId);

// Distribution: for each "number of assigned problems completed", how many students.
// Students with zero completions are included (cnt = 0).
export async function getPracticeDistribution(collegeId) {
  const rows = db.prepare(
    `SELECT cnt, COUNT(*) AS students FROM (
       SELECT s.id AS sid, COUNT(pp.id) AS cnt
       FROM students s
       LEFT JOIN practice_completions pc ON pc.student_id = s.id
       LEFT JOIN practice_problems pp ON pp.id = pc.problem_id AND pp.college_id = s.college_id
       WHERE s.college_id = ?
       GROUP BY s.id
     ) t GROUP BY cnt ORDER BY cnt`
  ).all(collegeId);
  return rows.map((r) => ({ completed: r.cnt, students: r.students }));
}

// For one problem: which students in the college completed it, and which didn't.
export async function getProblemCompletion(collegeId, problemId) {
  const cols = 's.id, s.name, s.username, s.register_number, s.section, s.department';
  const completed = db.prepare(
    `SELECT ${cols} FROM students s
     JOIN practice_completions pc ON pc.student_id = s.id AND pc.problem_id = ?
     WHERE s.college_id = ? ORDER BY s.name`).all(problemId, collegeId);
  const notCompleted = db.prepare(
    `SELECT ${cols} FROM students s
     WHERE s.college_id = ? AND s.id NOT IN (SELECT student_id FROM practice_completions WHERE problem_id = ?)
     ORDER BY s.name`).all(collegeId, problemId);
  return { completed, notCompleted };
}

// The students who completed exactly `count` assigned problems (on-demand drill-down).
export async function getStudentsByCompletedCount(collegeId, count) {
  return db.prepare(
    `SELECT s.id, s.name, s.username, s.register_number, s.section, s.department, COUNT(pp.id) AS cnt
     FROM students s
     LEFT JOIN practice_completions pc ON pc.student_id = s.id
     LEFT JOIN practice_problems pp ON pp.id = pc.problem_id AND pp.college_id = s.college_id
     WHERE s.college_id = ?
     GROUP BY s.id HAVING cnt = ? ORDER BY s.name`
  ).all(collegeId, count);
}
