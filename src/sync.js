// Sync engine: refresh student stats and detect practice-problem completions.
import { config } from './config.js';
import { store } from './store.js';
import { fetchProfileStats, fetchRecentAc } from './leetcode.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let running = false;
let lastRun = null;

export const getSyncState = () => ({ running, lastRun });

// Refresh a single student: stats + practice matching for their college.
async function syncStudent(student, problemsByCollege) {
  try {
    const stats = await fetchProfileStats(student.username);
    await store.saveStudentStats(student.id, stats);

    if (!stats.found) return { id: student.id, ok: false, reason: 'not found' };

    // Practice matching: pull recent accepted submissions and mark any assigned
    // problem whose slug appears. NOTE: only recent submissions are visible
    // (config.recentAcLimit), so very old solves before assignment may be missed
    // unless the student re-submits.
    const problems = problemsByCollege.get(student.college_id) || [];
    let newlyCompleted = 0;
    if (problems.length) {
      const recent = await fetchRecentAc(student.username);
      const bySlug = new Map(recent.map((r) => [r.titleSlug, r]));
      for (const p of problems) {
        const hit = bySlug.get(p.slug);
        if (hit && (await store.markCompletion(student.id, p.id, Number(hit.timestamp)))) {
          newlyCompleted++;
        }
      }
    }
    return { id: student.id, ok: true, newlyCompleted };
  } catch (err) {
    await store.setSyncError(student.id, err.message || String(err));
    return { id: student.id, ok: false, reason: err.message };
  }
}

// Refresh every student (optionally just one college). Politely paced.
export async function runSync({ collegeId = null, batch = null, allowedCollegeIds = null } = {}) {
  if (running) return { skipped: true, reason: 'a sync is already running' };
  running = true;
  const started = Date.now();
  const summary = { students: 0, ok: 0, failed: 0, newCompletions: 0 };

  try {
    let students;
    if (collegeId) {
      // Manual "sync this college now" — refresh the whole college.
      students = (await store.getAllStudents()).filter((s) => s.college_id === collegeId);
    } else if (batch && batch > 0) {
      // Staggered scheduled run: only the N most-stale students this tick, so the
      // load on LeetCode is spread evenly and the host IP doesn't get blocked.
      // allowedCollegeIds restricts to colleges whose sync is active right now.
      students = await store.getStaleStudents(batch, allowedCollegeIds);
    } else {
      students = await store.getAllStudents();
    }

    // Pre-load assigned problems per college once.
    const problemsByCollege = new Map();
    const collegeIds = [...new Set(students.map((s) => s.college_id))];
    for (const cid of collegeIds) {
      problemsByCollege.set(cid, await store.getPracticeProblemsByCollege(cid));
    }

    for (let i = 0; i < students.length; i++) {
      const r = await syncStudent(students[i], problemsByCollege);
      summary.students++;
      if (r.ok) {
        summary.ok++;
        summary.newCompletions += r.newlyCompleted || 0;
      } else {
        summary.failed++;
      }
      if (i < students.length - 1) await sleep(config.requestDelayMs); // be polite
    }
  } finally {
    running = false;
    lastRun = {
      at: new Date().toISOString(),
      durationMs: Date.now() - started,
      ...summary,
    };
  }
  return lastRun;
}

// Sync just one student on demand (used by the "Sync now" button per student).
export async function runSyncStudent(studentId) {
  const student = await store.getStudent(studentId);
  if (!student) throw new Error('student not found');
  const problemsByCollege = new Map([
    [student.college_id, await store.getPracticeProblemsByCollege(student.college_id)],
  ]);
  return syncStudent(student, problemsByCollege);
}
