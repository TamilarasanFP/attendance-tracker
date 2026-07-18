// LeetCode data client.
//
// IMPORTANT REALITY CHECK: LeetCode has no official public API. This module talks
// to the same undocumented GraphQL endpoint (https://leetcode.com/graphql) that
// the website uses. It works for PUBLIC profiles only, can rate-limit or block
// the calling IP, and may change shape without notice. Treat it as best-effort.
import { config } from './config.js';

const GRAPHQL_URL = 'https://leetcode.com/graphql';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Accepts a raw username or any LeetCode profile URL and returns the username.
//   https://leetcode.com/u/jdoe/        -> jdoe
//   https://leetcode.com/jdoe/          -> jdoe
//   https://leetcode.com/u/jdoe         -> jdoe
//   jdoe                                -> jdoe
export function parseUsername(input) {
  if (!input) return null;
  let s = String(input).trim();
  if (!s) return null;
  if (s.includes('leetcode.com')) {
    try {
      const url = new URL(s.startsWith('http') ? s : `https://${s}`);
      const parts = url.pathname.split('/').filter(Boolean); // drop empty segments
      // strip a leading "u" segment used by the newer profile URLs
      const cleaned = parts[0] === 'u' ? parts.slice(1) : parts;
      s = cleaned[0] || '';
    } catch {
      // fall through and try to salvage the last path-ish token
      const m = s.match(/leetcode\.com\/(?:u\/)?([^/?#]+)/i);
      s = m ? m[1] : s;
    }
  }
  return s.replace(/[/?#].*$/, '').trim() || null;
}

async function gql(query, variables) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Referer: 'https://leetcode.com',
      Origin: 'https://leetcode.com',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'));
    const e = new Error('LeetCode rate-limited the request (HTTP 429)');
    e.rateLimited = true;
    e.retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0; // honor Retry-After
    throw e;
  }
  if (res.status >= 500) { const e = new Error(`LeetCode HTTP ${res.status}`); e.transient = true; throw e; }
  if (!res.ok) throw new Error(`LeetCode HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join('; '));
  }
  return json.data;
}

// Exponential backoff with jitter. Honors Retry-After on 429; doesn't waste
// retries on hard 4xx (those won't succeed on retry).
async function gqlWithRetry(query, variables) {
  const base = config.requestDelayMs || 500;
  let lastErr;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await gql(query, variables);
    } catch (err) {
      lastErr = err;
      if (attempt === config.maxRetries) break;
      const isHard4xx = !err.rateLimited && !err.transient && /HTTP 4\d\d/.test(err.message || '');
      if (isHard4xx) break; // e.g. 403/404 — retrying won't help
      let wait = base * Math.pow(2, attempt) + Math.floor(Math.random() * 250); // jitter
      if (err.rateLimited) wait = Math.max(wait, err.retryAfterMs || base * Math.pow(2, attempt + 1));
      await sleep(wait);
    }
  }
  throw lastErr;
}

// ---- Queries ----------------------------------------------------------------

const PROFILE_QUERY = `
  query userProfile($username: String!) {
    matchedUser(username: $username) {
      username
      profile { ranking realName userAvatar }
      submitStatsGlobal { acSubmissionNum { difficulty count } }
    }
    userContestRanking(username: $username) { rating globalRanking }
  }`;

const CALENDAR_QUERY = `
  query userCalendar($username: String!) {
    matchedUser(username: $username) {
      userCalendar { submissionCalendar }
    }
  }`;

const RECENT_AC_QUERY = `
  query recentAc($username: String!, $limit: Int!) {
    recentAcSubmissionList(username: $username, limit: $limit) {
      title titleSlug timestamp
    }
  }`;

// ---- Mock data (LC_MOCK=true) ----------------------------------------------

function mockProfile(username) {
  const seed = [...username].reduce((a, c) => a + c.charCodeAt(0), 0);
  const easy = 40 + (seed % 60);
  const medium = 20 + (seed % 90);
  const hard = seed % 25;
  // a calendar with activity over the last ~120 days
  const cal = {};
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 120; i++) {
    if ((seed + i) % 3 === 0) {
      const day = now - i * 86400;
      const dayStart = day - (day % 86400);
      cal[dayStart] = ((seed + i) % 4) + 1;
    }
  }
  return {
    username,
    found: true,
    ranking: 100000 + ((seed * 37) % 900000),
    realName: '',
    avatar: '',
    contestRating: seed % 2 ? 1400 + (seed % 600) : null,
    solved: { easy, medium, hard, total: easy + medium + hard },
    submissionCalendar: cal,
  };
}

function mockRecentAc(username) {
  // deterministically "solve" a couple of common problems
  const pool = [
    { title: 'Two Sum', titleSlug: 'two-sum' },
    { title: 'Add Two Numbers', titleSlug: 'add-two-numbers' },
    { title: 'Valid Parentheses', titleSlug: 'valid-parentheses' },
    { title: 'Merge Two Sorted Lists', titleSlug: 'merge-two-sorted-lists' },
    { title: 'Maximum Subarray', titleSlug: 'maximum-subarray' },
  ];
  const seed = [...username].reduce((a, c) => a + c.charCodeAt(0), 0);
  const n = 1 + (seed % pool.length);
  const now = Math.floor(Date.now() / 1000);
  return pool.slice(0, n).map((p, i) => ({ ...p, timestamp: now - i * 3600 }));
}

// ---- Public API -------------------------------------------------------------

// Returns normalized stats for a username, or { found:false } if the profile
// does not exist / is private.
export async function fetchProfileStats(username) {
  if (config.mock) return mockProfile(username);

  const data = await gqlWithRetry(PROFILE_QUERY, { username });
  const user = data?.matchedUser;
  if (!user) return { username, found: false };

  const counts = { easy: 0, medium: 0, hard: 0, total: 0 };
  for (const row of user.submitStatsGlobal?.acSubmissionNum || []) {
    const d = row.difficulty.toLowerCase();
    if (d === 'all') counts.total = row.count;
    else if (counts[d] !== undefined) counts[d] = row.count;
  }
  if (!counts.total) counts.total = counts.easy + counts.medium + counts.hard;

  // calendar (separate query keeps the main one light)
  let submissionCalendar = {};
  try {
    const cal = await gqlWithRetry(CALENDAR_QUERY, { username });
    const raw = cal?.matchedUser?.userCalendar?.submissionCalendar;
    if (raw) submissionCalendar = JSON.parse(raw);
  } catch {
    /* calendar is best-effort */
  }

  return {
    username: user.username,
    found: true,
    ranking: user.profile?.ranking ?? null,
    realName: user.profile?.realName || '',
    avatar: user.profile?.userAvatar || '',
    contestRating: data?.userContestRanking?.rating
      ? Math.round(data.userContestRanking.rating)
      : null,
    solved: counts,
    submissionCalendar,
  };
}

// Returns [{ title, titleSlug, timestamp }] of the student's most recent
// accepted submissions (used to detect completion of assigned problems).
export async function fetchRecentAc(username, limit = config.recentAcLimit) {
  if (config.mock) return mockRecentAc(username);
  const data = await gqlWithRetry(RECENT_AC_QUERY, { username, limit });
  return data?.recentAcSubmissionList || [];
}

// Convert a LeetCode problem URL or slug into a canonical titleSlug.
//   https://leetcode.com/problems/two-sum/   -> two-sum
//   two-sum                                  -> two-sum
export function parseProblemSlug(input) {
  if (!input) return null;
  let s = String(input).trim();
  const m = s.match(/problems\/([^/?#]+)/i);
  if (m) return m[1].toLowerCase();
  return s.replace(/[/?#].*$/, '').toLowerCase() || null;
}

export const _internals = { sleep };
