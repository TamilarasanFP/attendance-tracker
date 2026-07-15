// Offline smoke test — the parts that do NOT need a live Supabase connection:
// auth, route gating, request validation, and the pure time helpers.
// For end-to-end database/storage verification, run:  npm run checkdb
// Run: node selftest.js
const http = require('http');
const { app, workedLabel, splitDateTime, ADMIN_PASSWORD } = require('./server.js');

function request(server, { method, path, headers, body }, cb) {
  const { port } = server.address();
  const r = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
    const chunks = [];
    res.on('data', d => chunks.push(d));
    res.on('end', () => cb(res.statusCode, Buffer.concat(chunks), res.headers));
  });
  if (body) r.write(body);
  r.end();
}
function json(obj) { return { body: Buffer.from(JSON.stringify(obj)), headers: { 'Content-Type': 'application/json' } }; }

const results = [];
function check(label, cond) { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); }

const server = app.listen(0, async () => {
  const req = opts => new Promise(res => request(server, opts, (code, buf, headers) => res({ code, buf, headers })));

  // ---- pure helpers (no DB) ----
  check('workedLabel 8h30m', workedLabel({ capturedAt: '2026-07-15T09:00:00Z' }, { capturedAt: '2026-07-15T17:30:00Z' }) === '8h 30m');
  check('workedLabel 45m', workedLabel({ capturedAt: '2026-07-15T09:00:00Z' }, { capturedAt: '2026-07-15T09:45:00Z' }) === '45m');
  check('workedLabel missing end -> empty', workedLabel({ capturedAt: '2026-07-15T09:00:00Z' }, null) === '');
  check('workedLabel end<=start -> empty', workedLabel({ capturedAt: '2026-07-15T10:00:00Z' }, { capturedAt: '2026-07-15T09:00:00Z' }) === '');
  const dt = splitDateTime(new Date('2026-07-15T13:05:09'));
  check('splitDateTime formats date/time', /^\d{4}-\d{2}-\d{2}$/.test(dt.date) && /^\d{2}:\d{2}:\d{2}$/.test(dt.time));

  // ---- auth + gating (no DB) ----
  check('GET /admin/login -> 200', (await req({ method: 'GET', path: '/admin/login' })).code === 200);
  check('GET /admin without session -> 302', (await req({ method: 'GET', path: '/admin' })).code === 302);
  check('GET /api/records without session -> 401', (await req({ method: 'GET', path: '/api/records' })).code === 401);
  check('GET /api/employees without session -> 401', (await req({ method: 'GET', path: '/api/employees' })).code === 401);
  check('POST /api/admin/login wrong pw -> 401', (await req({ method: 'POST', path: '/api/admin/login', ...json({ password: 'nope' }) })).code === 401);

  const login = await req({ method: 'POST', path: '/api/admin/login', ...json({ password: ADMIN_PASSWORD }) });
  check('POST /api/admin/login correct pw -> 200', login.code === 200);
  const cookie = ((login.headers['set-cookie'] || [])[0] || '').split(';')[0];
  check('login sets admin_session cookie', /^admin_session=.+/.test(cookie));
  check('GET /admin with session -> 200', (await req({ method: 'GET', path: '/admin', headers: { Cookie: cookie } })).code === 200);

  // ---- validation runs before any DB access ----
  const mp = () => {
    const b = '----t' + Date.now();
    const parts = [Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="name"\r\n\r\n\r\n`),
                   Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="empId"\r\n\r\n\r\n`),
                   Buffer.from(`--${b}--\r\n`)];
    return { body: Buffer.concat(parts), headers: { 'Content-Type': `multipart/form-data; boundary=${b}` } };
  };
  check('POST /api/checkin missing fields -> 400', (await req({ method: 'POST', path: '/api/checkin', ...mp() })).code === 400);

  // ---- logout invalidates session ----
  await req({ method: 'POST', path: '/api/admin/logout', headers: { Cookie: cookie } });
  check('after logout, GET /api/records -> 401', (await req({ method: 'GET', path: '/api/records', headers: { Cookie: cookie } })).code === 401);

  server.close();
  const ok = results.every(Boolean);
  console.log(ok ? '\nALL OFFLINE CHECKS PASSED  (run `npm run checkdb` to verify Supabase)' : '\nSOME CHECKS FAILED');
  process.exit(ok ? 0 : 1);
});
