// Ingest scraped results pushed by the Chrome extension (or imported from its CSV).
// Writes into the same tables the server-side scraper uses, so the dashboard
// renders identically regardless of how the data arrived.
import { store } from './store.js';
import { parseUsername, parseProblemSlug } from './leetcode.js';

const num = (v) => {
  if (v == null) return 0;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const slugify = (s) =>
  String(s).toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

// results: array of objects shaped like the extension's per-profile result:
//   { username|profile|profileUrl, rank, easy, medium, hard, total?,
//     contestRating?, submissionCalendar?, solvedSlugs?: [...], questions?: {title: score}, comment? }
export async function ingestResults(collegeId, results = []) {
  const summary = { received: results.length, updated: 0, notFound: 0, newCompletions: 0, skipped: 0 };

  for (const r of results) {
    const username = parseUsername(r.username || r.profileUrl || r.profile);
    if (!username) { summary.skipped++; continue; }

    const student = await store.getStudentByUsername(collegeId, username);
    const studentId = student
      ? student.id
      : await store.upsertStudent({
          college_id: collegeId,
          name: r.name || username, // only used when the student is brand new
          username,
          profile_url: r.profileUrl || `https://leetcode.com/u/${username}/`,
        });

    const notFound = r.notFound || (r.comment && /not found|invalid/i.test(r.comment));
    if (notFound) {
      await store.setSyncError(studentId, r.comment || 'Profile not found / private');
      summary.notFound++;
      continue;
    }

    const easy = num(r.easy), medium = num(r.medium), hard = num(r.hard);
    const total = r.total != null && r.total !== '' ? num(r.total) : easy + medium + hard;
    const ranking = r.rank == null || r.rank === 'N/A' || r.rank === '' ? null : num(r.rank);

    await store.saveStudentStats(studentId, {
      found: true,
      ranking,
      contestRating: r.contestRating != null && r.contestRating !== '' ? num(r.contestRating) : null,
      solved: { easy, medium, hard, total },
      submissionCalendar: r.submissionCalendar || {},
    });
    summary.updated++;

    // Resolve solved problem slugs.
    const slugs = new Set();
    for (const s of r.solvedSlugs || []) {
      const sl = parseProblemSlug(s);
      if (sl) slugs.add(sl);
    }
    // Fallback: a {questionTitle: score} map (this is what the CSV carries).
    if (r.questions && typeof r.questions === 'object') {
      for (const [title, score] of Object.entries(r.questions)) {
        if (num(score) > 0) slugs.add(slugify(title));
      }
    }
    for (const sl of slugs) {
      const p = await store.getProblemBySlug(collegeId, sl);
      if (p && (await store.markCompletion(studentId, p.id, null))) summary.newCompletions++;
    }
  }
  return summary;
}
