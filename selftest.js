// In-process smoke test (no lingering server, no network). Covers the full
// flow: public check-in, capture-time + skew handling, image storage, admin
// authentication (login/cookie/gating), worked-time, and cleanup.
// Run: node selftest.js
const http = require('http');
const { app, workedLabel, ADMIN_PASSWORD } = require('./server.js');

// tiny valid 1x1 JPEG
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////' +
  '////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBAB' +
  'AAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

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

function multipart(fields, file) {
  const b = '----t' + Date.now() + Math.random().toString(36).slice(2);
  const parts = [];
  for (const [k, v] of Object.entries(fields))
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file)
    parts.push(
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="photo"; filename="c.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      file.buf, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${b}--\r\n`));
  return { body: Buffer.concat(parts), headers: { 'Content-Type': `multipart/form-data; boundary=${b}` } };
}

function json(obj) {
  return { body: Buffer.from(JSON.stringify(obj)), headers: { 'Content-Type': 'application/json' } };
}

const results = [];
function check(label, cond) { results.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); }

const server = app.listen(0, async () => {
  const req = opts => new Promise(res => request(server, opts, (code, buf, headers) => res({ code, buf, headers })));
  let cookie = null;
  const withCookie = (opts) => ({ ...opts, headers: { ...(opts.headers || {}), Cookie: cookie || '' } });

  // ---- AUTH ----
  check('GET /admin/login -> 200 (public)', (await req({ method: 'GET', path: '/admin/login' })).code === 200);
  check('GET /admin without session -> 302 redirect', (await req({ method: 'GET', path: '/admin' })).code === 302);
  check('GET /api/records without session -> 401', (await req({ method: 'GET', path: '/api/records' })).code === 401);
  check('POST /api/admin/login wrong pw -> 401',
    (await req({ method: 'POST', path: '/api/admin/login', ...json({ password: 'nope' }) })).code === 401);

  const login = await req({ method: 'POST', path: '/api/admin/login', ...json({ password: ADMIN_PASSWORD }) });
  check('POST /api/admin/login correct pw -> 200', login.code === 200);
  const setCookie = (login.headers['set-cookie'] || [])[0] || '';
  cookie = setCookie.split(';')[0]; // admin_session=...
  check('  login sets admin_session cookie', /^admin_session=.+/.test(cookie));
  check('GET /admin with session -> 200', (await req(withCookie({ method: 'GET', path: '/admin' }))).code === 200);

  // clean slate (authenticated)
  await req(withCookie({ method: 'DELETE', path: '/api/records' }));

  // ---- PUBLIC CHECK-IN ----
  check('GET / serves check-in page', (await req({ method: 'GET', path: '/' })).code === 200);
  check('POST /api/checkin missing fields -> 400',
    (await req({ method: 'POST', path: '/api/checkin', ...multipart({ name: '', empId: '' }) })).code === 400);

  const now = new Date().toISOString();
  const r = await req({ method: 'POST', path: '/api/checkin',
    ...multipart({ name: 'Priya', empId: 'EMP1', type: 'start', captureTime: now }, { buf: JPEG }) });
  check('POST /api/checkin valid (no auth needed) -> 200', r.code === 200);
  const rec = JSON.parse(r.buf.toString());
  check('  response has date & time', !!rec.date && !!rec.time);

  const skew = new Date(Date.now() - 60 * 60000).toISOString();
  check('POST /api/checkin skewed clock -> 422',
    (await req({ method: 'POST', path: '/api/checkin',
      ...multipart({ name: 'X', empId: 'E2', type: 'start', captureTime: skew }, { buf: JPEG }) })).code === 422);

  // ---- ADMIN DATA (authenticated) ----
  const rows = JSON.parse((await req(withCookie({ method: 'GET', path: '/api/records' }))).buf.toString());
  const row = rows.find(x => x.empId === 'EMP1');
  check('GET /api/records returns the record', !!row && !!row.start);
  check('  row exposes a worked field', row && ('worked' in row));
  const photoName = row && row.start && row.start.photo;
  check('  record references a stored photo', !!photoName);

  const ph = await req(withCookie({ method: 'GET', path: '/api/photo/' + photoName }));
  check('GET /api/photo (authed) -> 200 with bytes', ph.code === 200 && ph.buf.length > 0);
  check('GET /api/photo without session -> 401',
    (await req({ method: 'GET', path: '/api/photo/' + photoName })).code === 401);
  check('GET /api/photo/../server.js blocked -> 404',
    (await req(withCookie({ method: 'GET', path: '/api/photo/..%2f..%2fserver.js' }))).code === 404);

  // ---- workedLabel unit checks ----
  const mk = iso => ({ capturedAt: iso });
  const s = mk('2026-07-15T09:00:00.000Z');
  check('workedLabel 8h30m', workedLabel(s, mk('2026-07-15T17:30:00.000Z')) === '8h 30m');
  check('workedLabel 45m', workedLabel(s, mk('2026-07-15T09:45:00.000Z')) === '45m');
  check('workedLabel missing end -> empty', workedLabel(s, null) === '');
  check('workedLabel end<=start -> empty', workedLabel(mk('2026-07-15T17:00:00.000Z'), s) === '');

  // ---- ROSTER + AUTO-FILL + PER-DATE MAPPING ----
  // add via form
  let e1 = await req(withCookie({ method: 'POST', path: '/api/employees', ...json({ name: 'Priya Kumar', empId: 'EMP1' }) }));
  check('POST /api/employees add -> 200', e1.code === 200);
  // bulk import (one new, one header line skipped)
  const bulk = await req(withCookie({ method: 'POST', path: '/api/employees/bulk',
    ...json({ text: 'Name,ID\nArun Raj, EMP9\n' }) }));
  const bd = JSON.parse(bulk.buf.toString());
  check('POST /api/employees/bulk adds 1, skips header', bd.added === 1 && bd.skipped === 1);
  // public lookup returns roster name
  const lk = JSON.parse((await req({ method: 'GET', path: '/api/lookup/EMP1' })).buf.toString());
  check('GET /api/lookup/EMP1 -> roster name (public)', lk.name === 'Priya Kumar');
  const lk2 = JSON.parse((await req({ method: 'GET', path: '/api/lookup/NOPE' })).buf.toString());
  check('GET /api/lookup unknown -> null', lk2.name === null);
  // per-date view: EMP1 present today, EMP9 absent
  const today = rec.date;
  const day = JSON.parse((await req(withCookie({ method: 'GET', path: '/api/day/' + today }))).buf.toString());
  const p1 = day.find(x => x.empId === 'EMP1');
  const p9 = day.find(x => x.empId === 'EMP9');
  check('day view: EMP1 present (has start)', p1 && p1.status !== 'absent' && p1.inRoster);
  check('day view: EMP9 absent', p9 && p9.status === 'absent');
  // remove employee
  check('DELETE /api/employees/EMP9 -> 200',
    (await req(withCookie({ method: 'DELETE', path: '/api/employees/EMP9' }))).code === 200);

  // ---- logout invalidates session ----
  await req(withCookie({ method: 'POST', path: '/api/admin/logout' }));
  check('after logout, GET /api/records -> 401',
    (await req(withCookie({ method: 'GET', path: '/api/records' }))).code === 401);

  // cleanup (log back in)
  const relog = await req({ method: 'POST', path: '/api/admin/login', ...json({ password: ADMIN_PASSWORD }) });
  cookie = ((relog.headers['set-cookie'] || [])[0] || '').split(';')[0];
  check('DELETE /api/records (authed) -> 200', (await req(withCookie({ method: 'DELETE', path: '/api/records' }))).code === 200);

  server.close();
  const ok = results.every(Boolean);
  console.log(ok ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
  process.exit(ok ? 0 : 1);
});
