// Postgres / Supabase implementation of the data layer.
// Exposes the SAME async API as db.js (the SQLite store). Selected when
// DB_DRIVER=supabase. Talks to Postgres over a direct connection string using
// the `pg` driver, keeping the SQL close to the SQLite version.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.supabase.sql');

let pool;
const q = (text, params) => pool.query(text, params);

// Timestamps are returned as 'YYYY-MM-DD HH24:MI:SS' text so the frontend's
// date helpers behave the same as on the SQLite path.
const TS = (col, alias) => `to_char(${col}, 'YYYY-MM-DD HH24:MI:SS') AS ${alias}`;
const STUDENT_COLS = `id, college_id, name, username, profile_url, ranking, contest_rating,
  solved_easy, solved_medium, solved_hard, solved_total, found, sync_status, sync_error,
  baseline_ranking, baseline_easy, baseline_medium, baseline_hard, baseline_total,
  register_number, email, department, section, year, campus,
  ${TS('last_synced_at', 'last_synced_at')}, ${TS('baseline_at', 'baseline_at')}, ${TS('created_at', 'created_at')}`;

// WHERE clause + params ($n) for student filters.
function studentWhere(collegeId, f = {}) {
  const params = [collegeId];
  // Qualify college_id — monthly_activity also has it, so the filtered monthly
  // JOIN would otherwise be an ambiguous-column error.
  const cond = ['students.college_id = $1'];
  const p = (v) => { params.push(v); return '$' + params.length; };
  if (f.batch) cond.push(`section = ${p(f.batch)}`);
  if (f.department) cond.push(`department = ${p(f.department)}`);
  if (f.campus) cond.push(`campus = ${p(f.campus)}`);
  if (f.q) {
    const l = '%' + f.q + '%';
    cond.push(`(name ILIKE ${p(l)} OR username ILIKE ${p(l)} OR register_number ILIKE ${p(l)})`);
  }
  return { where: cond.join(' AND '), params };
}

export async function initStore() {
  if (!config.supabase.connectionString) {
    throw new Error(
      'DB_DRIVER=supabase but SUPABASE_DB_URL (Postgres connection string) is not set.'
    );
  }
  pool = new pg.Pool({
    connectionString: config.supabase.connectionString,
    ssl: { rejectUnauthorized: false }, // Supabase requires SSL
    max: Number(process.env.DB_POOL_MAX) || 15, // concurrent connections; raise for big cohorts
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  await q('SELECT 1');
  // Ensure schema exists (idempotent).
  await q(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  console.log('[db] driver: supabase (postgres)');
}

// ---- College helpers --------------------------------------------------------

export async function getOrCreateCollege(name) {
  const clean = String(name).trim();
  await q('INSERT INTO colleges(name) VALUES ($1) ON CONFLICT(name) DO NOTHING', [clean]);
  const { rows } = await q('SELECT * FROM colleges WHERE name=$1', [clean]);
  return rows[0];
}

export async function listColleges() {
  const { rows } = await q(
    `SELECT c.id, c.name, ${TS('c.created_at', 'created_at')},
       c.sync_mode, c.sync_from, c.sync_to, c.refresh_mode, c.refresh_from, c.refresh_to,
       (CASE WHEN c.access_code IS NOT NULL AND c.access_code <> '' THEN 1 ELSE 0 END) AS has_code,
       (SELECT COUNT(*) FROM students s WHERE s.college_id = c.id)::int AS student_count
     FROM colleges c ORDER BY c.name`
  );
  return rows;
}

export async function setAllCollegesMode({ sync_mode, refresh_mode }) {
  if (sync_mode) await q('UPDATE colleges SET sync_mode=$1', [sync_mode]);
  if (refresh_mode) await q('UPDATE colleges SET refresh_mode=$1', [refresh_mode]);
}

export async function setCollegeSettings(id, s) {
  await q(
    `UPDATE colleges SET sync_mode=$1, sync_from=$2, sync_to=$3, refresh_mode=$4, refresh_from=$5, refresh_to=$6 WHERE id=$7`,
    [s.sync_mode, s.sync_from || null, s.sync_to || null, s.refresh_mode, s.refresh_from || null, s.refresh_to || null, id]
  );
}

export async function getCollege(id) {
  const { rows } = await q('SELECT * FROM colleges WHERE id=$1', [id]);
  return rows[0];
}

export async function getSetting(key) {
  const { rows } = await q('SELECT value FROM app_settings WHERE key=$1', [key]);
  return rows[0] ? rows[0].value : null;
}
export async function setSetting(key, value) {
  await q('INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [key, value]);
}

export async function deleteCollege(id) {
  await q('DELETE FROM colleges WHERE id=$1', [id]); // cascades via FK ON DELETE CASCADE
}

export async function setAccessCode(id, code) {
  await q('UPDATE colleges SET access_code=$1 WHERE id=$2', [(code || '').trim(), id]);
}

export async function checkAccessCode(id, code) {
  const c = await getCollege(id);
  if (!c || !c.access_code) return false;
  return String(code || '').trim() === String(c.access_code).trim();
}

export async function getCollegeByToken(t) {
  if (!t) return undefined;
  const { rows } = await q('SELECT * FROM colleges WHERE view_token=$1', [t]);
  return rows[0];
}

export async function ensureViewToken(id, regenerate = false) {
  const c = await getCollege(id);
  if (!c) return null;
  if (c.view_token && !regenerate) return c.view_token;
  const token = randomUUID();
  await q('UPDATE colleges SET view_token=$1 WHERE id=$2', [token, id]);
  return token;
}

export async function studentsBasic(collegeId) {
  const { rows } = await q(
    'SELECT id, name, username FROM students WHERE college_id=$1 ORDER BY name',
    [collegeId]
  );
  return rows;
}

// ---- Student helpers --------------------------------------------------------

export async function upsertStudent({
  college_id, name, username, profile_url,
  register_number = null, email = null, department = null, section = null, year = null, campus = null,
}) {
  const { rows } = await q(
    `INSERT INTO students (college_id, name, username, profile_url, register_number, email, department, section, year, campus)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (college_id, username) DO UPDATE SET
       name = EXCLUDED.name,
       profile_url     = COALESCE(EXCLUDED.profile_url, students.profile_url),
       register_number = COALESCE(EXCLUDED.register_number, students.register_number),
       email           = COALESCE(EXCLUDED.email, students.email),
       department      = COALESCE(EXCLUDED.department, students.department),
       section         = COALESCE(EXCLUDED.section, students.section),
       year            = COALESCE(EXCLUDED.year, students.year),
       campus          = COALESCE(EXCLUDED.campus, students.campus)
     RETURNING id`,
    [college_id, name, username, profile_url, register_number, email, department, section, year, campus]
  );
  return rows[0].id;
}

export async function listStudents(collegeId) {
  const { rows } = await q(
    `SELECT ${STUDENT_COLS} FROM students WHERE college_id=$1 ORDER BY solved_total DESC, name`,
    [collegeId]
  );
  return rows;
}

const RISK_SQL_PG = "(baseline_at IS NOT NULL AND baseline_at <= now() - interval '7 days' AND (solved_total - COALESCE(baseline_total,0)) <= 0)";

function studentOrderByPg(f) {
  const dir = f.dir === 'asc' ? 'ASC' : f.dir === 'desc' ? 'DESC' : null;
  switch (f.sort) {
    case 'name': return `name ${dir || 'ASC'}`;
    case 'rank': return `(ranking IS NULL), ranking ${dir || 'ASC'}, name`;
    case 'practice': return `(SELECT COUNT(*) FROM practice_completions pc WHERE pc.student_id = students.id) ${dir || 'DESC'}, name`;
    case 'total':
    default: return `solved_total ${dir || 'DESC'}, name`;
  }
}

export async function getStudentsPage(collegeId, f = {}) {
  const { where, params } = studentWhere(collegeId, f);
  const fullWhere = f.risk ? `${where} AND ${RISK_SQL_PG}` : where;
  const total = (await q(`SELECT COUNT(*)::int AS c FROM students WHERE ${fullWhere}`, params)).rows[0].c;
  const all = f.all === true || f.all === '1';
  const sel = `SELECT ${STUDENT_COLS}, ${RISK_SQL_PG} AS at_risk FROM students WHERE ${fullWhere} ORDER BY ${studentOrderByPg(f)}`;
  let rows;
  if (all) {
    rows = (await q(sel, params)).rows;
    return { rows, total, offset: 0 };
  }
  const pageSize = Math.min(500, Math.max(1, f.pageSize || 100));
  const page = Math.max(1, f.page || 1);
  const offset = (page - 1) * pageSize;
  rows = (await q(`${sel} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, pageSize, offset])).rows;
  return { rows, total, offset };
}

export async function getCollegeTotals(collegeId, f = {}) {
  const { where, params } = studentWhere(collegeId, f);
  const { rows } = await q(`
    SELECT COUNT(*)::int AS students,
      COALESCE(SUM(solved_easy),0)::int AS easy,
      COALESCE(SUM(solved_medium),0)::int AS medium,
      COALESCE(SUM(solved_hard),0)::int AS hard,
      COALESCE(SUM(solved_total),0)::int AS total
    FROM students WHERE ${where}`, params);
  return rows[0];
}

export async function getCollegeMonthly(collegeId, f = {}) {
  // Fast path (whole college, no student-attribute filters): denormalized column + index, no join.
  if (!f.batch && !f.department && !f.campus && !f.q) {
    const { rows } = await q(
      `SELECT ym, SUM(submissions)::int AS submissions FROM monthly_activity
       WHERE college_id = $1 GROUP BY ym ORDER BY ym`, [collegeId]);
    return rows;
  }
  const { where, params } = studentWhere(collegeId, f);
  const { rows } = await q(`
    SELECT ym, SUM(submissions)::int AS submissions
    FROM monthly_activity JOIN students ON students.id = monthly_activity.student_id
    WHERE ${where} GROUP BY ym ORDER BY ym`, params);
  return rows;
}

export async function getFilterOptions(collegeId) {
  const distinct = async (col) =>
    (await q(`SELECT DISTINCT ${col} AS v FROM students WHERE college_id=$1 AND ${col} IS NOT NULL AND ${col}<>'' ORDER BY ${col}`, [collegeId])).rows.map((r) => r.v);
  return { batches: await distinct('section'), departments: await distinct('department'), campuses: await distinct('campus'), years: await distinct('year') };
}

export async function getAllStudents() {
  const { rows } = await q(`SELECT ${STUDENT_COLS} FROM students`);
  return rows;
}
// The N students least-recently synced (never-synced first) — for staggered refresh.
// allowedCollegeIds (optional array) restricts to those colleges; [] => none.
export async function getStaleStudents(limit, allowedCollegeIds) {
  if (Array.isArray(allowedCollegeIds)) {
    if (!allowedCollegeIds.length) return [];
    const { rows } = await q(
      `SELECT ${STUDENT_COLS} FROM students WHERE college_id = ANY($1) ORDER BY last_synced_at ASC NULLS FIRST LIMIT $2`,
      [allowedCollegeIds, limit]);
    return rows;
  }
  const { rows } = await q(
    `SELECT ${STUDENT_COLS} FROM students ORDER BY last_synced_at ASC NULLS FIRST LIMIT $1`, [limit]);
  return rows;
}

export async function getRankInCollege(collegeId, solvedTotal) {
  const { rows } = await q(
    'SELECT COUNT(*)::int AS c FROM students WHERE college_id=$1 AND solved_total > $2',
    [collegeId, solvedTotal]
  );
  return rows[0].c + 1;
}

export async function getStudent(id) {
  const { rows } = await q(`SELECT ${STUDENT_COLS} FROM students WHERE id=$1`, [id]);
  return rows[0];
}

export async function getStudentByUsername(collegeId, username) {
  const { rows } = await q(
    `SELECT ${STUDENT_COLS} FROM students WHERE college_id=$1 AND username=$2`,
    [collegeId, username]
  );
  return rows[0];
}

export async function getStudentByEmail(collegeId, email) {
  const { rows } = await q(
    `SELECT ${STUDENT_COLS} FROM students WHERE college_id=$1 AND LOWER(email)=LOWER($2)`,
    [collegeId, String(email).trim()]
  );
  return rows[0];
}

export async function deleteStudent(id) {
  await q('DELETE FROM students WHERE id=$1', [id]);
}

export async function saveStudentStats(id, stats) {
  if (!stats.found) {
    await q(
      `UPDATE students SET found=0, sync_status='error',
       sync_error='Profile not found or private', last_synced_at=now() WHERE id=$1`,
      [id]
    );
    return;
  }

  const monthly = {};
  for (const [ts, count] of Object.entries(stats.submissionCalendar || {})) {
    const d = new Date(Number(ts) * 1000);
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    monthly[ym] = (monthly[ym] || 0) + Number(count);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE students SET
         found=1, ranking=$1, contest_rating=$2,
         solved_easy=$3, solved_medium=$4, solved_hard=$5, solved_total=$6,
         baseline_ranking=COALESCE(baseline_ranking, $8),
         baseline_easy=COALESCE(baseline_easy, $9),
         baseline_medium=COALESCE(baseline_medium, $10),
         baseline_hard=COALESCE(baseline_hard, $11),
         baseline_total=COALESCE(baseline_total, $12),
         baseline_at=COALESCE(baseline_at, now()),
         sync_status='ok', sync_error=NULL, last_synced_at=now()
       WHERE id=$7`,
      [
        stats.ranking ?? null,
        stats.contestRating ?? null,
        stats.solved.easy,
        stats.solved.medium,
        stats.solved.hard,
        stats.solved.total,
        id,
        stats.ranking ?? null,
        stats.solved.easy,
        stats.solved.medium,
        stats.solved.hard,
        stats.solved.total,
      ]
    );
    await client.query(
      `INSERT INTO stat_snapshots(student_id, solved_easy, solved_medium, solved_hard, solved_total)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, stats.solved.easy, stats.solved.medium, stats.solved.hard, stats.solved.total]
    );
    for (const [ym, count] of Object.entries(monthly)) {
      await client.query(
        `INSERT INTO monthly_activity(student_id, ym, submissions, college_id)
         VALUES ($1,$2,$3, (SELECT college_id FROM students WHERE id=$1))
         ON CONFLICT (student_id, ym) DO UPDATE SET submissions=EXCLUDED.submissions, college_id=EXCLUDED.college_id`,
        [id, ym, count]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function resetBaseline(id) {
  await q(
    `UPDATE students SET
       baseline_ranking=ranking, baseline_easy=solved_easy, baseline_medium=solved_medium,
       baseline_hard=solved_hard, baseline_total=solved_total, baseline_at=now()
     WHERE id=$1`,
    [id]
  );
}

export async function setSyncError(id, message) {
  await q(
    `UPDATE students SET sync_status='error', sync_error=$1, last_synced_at=now() WHERE id=$2`,
    [message, id]
  );
}

export async function getMonthlyActivity(studentId) {
  const { rows } = await q(
    'SELECT ym, submissions FROM monthly_activity WHERE student_id=$1 ORDER BY ym',
    [studentId]
  );
  return rows;
}

export async function getMonthlySolvedGrowth(studentId) {
  const { rows: snaps } = await q(
    `SELECT to_char(taken_at,'YYYY-MM') AS ym,
            solved_easy, solved_medium, solved_hard, solved_total
     FROM stat_snapshots WHERE student_id=$1 ORDER BY taken_at`,
    [studentId]
  );
  if (snaps.length < 2) return [];
  const lastByMonth = new Map();
  for (const s of snaps) lastByMonth.set(s.ym, s);
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
  const { rows } = await q(
    `INSERT INTO practice_problems(college_id, title, slug, url, difficulty, topic, domain, video_url, due_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (college_id, slug) DO UPDATE SET
       title=EXCLUDED.title, url=EXCLUDED.url, difficulty=EXCLUDED.difficulty,
       topic=EXCLUDED.topic, domain=EXCLUDED.domain,
       video_url=COALESCE(EXCLUDED.video_url, practice_problems.video_url),
       due_date=COALESCE(EXCLUDED.due_date, practice_problems.due_date)
     RETURNING id`,
    [college_id, title, slug, url, difficulty, topic ?? null, domain ?? null, video_url ?? null, due_date ?? null]
  );
  return rows[0].id;
}

export async function setShowVideo(collegeId, show) {
  await q('UPDATE colleges SET show_video=$1 WHERE id=$2', [show ? true : false, collegeId]);
}

export async function listPracticeProblems(collegeId) {
  const { rows } = await q(
    `SELECT id, college_id, title, slug, url, difficulty, topic, domain, video_url, due_date, ${TS('created_at', 'created_at')}
     FROM practice_problems WHERE college_id=$1 ORDER BY domain NULLS FIRST, topic NULLS FIRST, created_at DESC`,
    [collegeId]
  );
  return rows;
}

export async function listTopics(collegeId) {
  const { rows } = await q(
    `SELECT DISTINCT pp.topic AS name, COALESCE(po.position, 1000000) AS pos
     FROM practice_problems pp
     LEFT JOIN practice_order po ON po.college_id=pp.college_id AND po.kind='topic' AND po.name=pp.topic
     WHERE pp.college_id=$1 AND pp.topic IS NOT NULL AND pp.topic<>''
     ORDER BY pos, name`,
    [collegeId]
  );
  return rows.map((r) => r.name);
}

export async function listDomains(collegeId) {
  const { rows } = await q(
    `SELECT DISTINCT pp.domain AS name, COALESCE(po.position, 1000000) AS pos
     FROM practice_problems pp
     LEFT JOIN practice_order po ON po.college_id=pp.college_id AND po.kind='domain' AND po.name=pp.domain
     WHERE pp.college_id=$1 AND pp.domain IS NOT NULL AND pp.domain<>''
     ORDER BY pos, name`,
    [collegeId]
  );
  return rows.map((r) => r.name);
}

export async function setPracticeOrder(collegeId, kind, names) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM practice_order WHERE college_id=$1 AND kind=$2', [collegeId, kind]);
    for (let i = 0; i < names.length; i++) {
      await client.query('INSERT INTO practice_order(college_id, kind, name, position) VALUES ($1,$2,$3,$4)', [collegeId, kind, names[i], i]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getPracticeProblemsByCollege(collegeId) {
  const { rows } = await q('SELECT * FROM practice_problems WHERE college_id=$1', [collegeId]);
  return rows;
}

export async function getProblemBySlug(collegeId, slug) {
  const { rows } = await q(
    'SELECT * FROM practice_problems WHERE college_id=$1 AND slug=$2',
    [collegeId, slug]
  );
  return rows[0];
}

export async function countPracticeProblems(collegeId) {
  const { rows } = await q('SELECT COUNT(*)::int AS c FROM practice_problems WHERE college_id=$1', [collegeId]);
  return rows[0].c;
}

export async function deletePracticeProblem(id) {
  await q('DELETE FROM practice_problems WHERE id=$1', [id]);
}

// Remove every question under one domain+topic. null matches "Uncategorized".
export async function deletePracticeByTopic(collegeId, domain, topic) {
  const params = [collegeId];
  let n = 1;
  const domCond = domain === null ? "(domain IS NULL OR domain='')" : `domain=$${++n}`;
  if (domain !== null) params.push(domain);
  const topCond = topic === null ? "(topic IS NULL OR topic='')" : `topic=$${++n}`;
  if (topic !== null) params.push(topic);
  const { rowCount } = await q(
    `DELETE FROM practice_problems WHERE college_id=$1 AND ${domCond} AND ${topCond}`, params);
  return rowCount;
}

export async function markCompletion(studentId, problemId, solvedTimestamp) {
  const r = await q(
    `INSERT INTO practice_completions(student_id, problem_id, solved_timestamp)
     VALUES ($1,$2,$3) ON CONFLICT (student_id, problem_id) DO NOTHING`,
    [studentId, problemId, solvedTimestamp ?? null]
  );
  return r.rowCount > 0;
}

export async function unmarkCompletion(studentId, problemId) {
  const r = await q('DELETE FROM practice_completions WHERE student_id=$1 AND problem_id=$2', [studentId, problemId]);
  return r.rowCount > 0;
}

export async function getCompletionsForCollege(collegeId) {
  const { rows } = await q(
    `SELECT pc.student_id, pc.problem_id, ${TS('pc.completed_at', 'completed_at')}
     FROM practice_completions pc
     JOIN practice_problems pp ON pp.id = pc.problem_id
     WHERE pp.college_id = $1`,
    [collegeId]
  );
  return rows;
}

export async function getCompletedCountsForStudents(studentIds) {
  if (!studentIds || !studentIds.length) return {};
  const { rows } = await q(
    'SELECT student_id, COUNT(*)::int AS c FROM practice_completions WHERE student_id = ANY($1) GROUP BY student_id',
    [studentIds]
  );
  const m = {};
  for (const r of rows) m[r.student_id] = r.c;
  return m;
}
export async function getCompletedCountsByProblem(collegeId) {
  const { rows } = await q(
    `SELECT pc.problem_id AS pid, COUNT(*)::int AS c
     FROM practice_completions pc JOIN practice_problems pp ON pp.id = pc.problem_id
     WHERE pp.college_id = $1 GROUP BY pc.problem_id`,
    [collegeId]
  );
  const m = {};
  for (const r of rows) m[r.pid] = r.c;
  return m;
}

export async function getCompletionsForStudent(studentId) {
  const { rows } = await q(
    `SELECT problem_id, ${TS('completed_at', 'completed_at')}
     FROM practice_completions WHERE student_id=$1`,
    [studentId]
  );
  return rows;
}

// Distribution: for each "number of assigned problems completed", how many students.
export async function getPracticeDistribution(collegeId) {
  const { rows } = await q(
    `SELECT cnt, COUNT(*)::int AS students FROM (
       SELECT s.id AS sid, COUNT(pp.id)::int AS cnt
       FROM students s
       LEFT JOIN practice_completions pc ON pc.student_id = s.id
       LEFT JOIN practice_problems pp ON pp.id = pc.problem_id AND pp.college_id = s.college_id
       WHERE s.college_id = $1
       GROUP BY s.id
     ) t GROUP BY cnt ORDER BY cnt`,
    [collegeId]
  );
  return rows.map((r) => ({ completed: r.cnt, students: r.students }));
}

// The students who completed exactly `count` assigned problems (on-demand drill-down).
export async function getProblemCompletion(collegeId, problemId) {
  const cols = 's.id, s.name, s.username, s.register_number, s.section, s.department';
  const completed = (await q(
    `SELECT ${cols} FROM students s
     JOIN practice_completions pc ON pc.student_id = s.id AND pc.problem_id = $1
     WHERE s.college_id = $2 ORDER BY s.name`, [problemId, collegeId])).rows;
  const notCompleted = (await q(
    `SELECT ${cols} FROM students s
     WHERE s.college_id = $1 AND s.id NOT IN (SELECT student_id FROM practice_completions WHERE problem_id = $2)
     ORDER BY s.name`, [collegeId, problemId])).rows;
  return { completed, notCompleted };
}

export async function getStudentsByCompletedCount(collegeId, count) {
  const { rows } = await q(
    `SELECT s.id, s.name, s.username, s.register_number, s.section, s.department, COUNT(pp.id)::int AS cnt
     FROM students s
     LEFT JOIN practice_completions pc ON pc.student_id = s.id
     LEFT JOIN practice_problems pp ON pp.id = pc.problem_id AND pp.college_id = s.college_id
     WHERE s.college_id = $1
     GROUP BY s.id HAVING COUNT(pp.id) = $2 ORDER BY s.name`,
    [collegeId, count]
  );
  return rows;
}
