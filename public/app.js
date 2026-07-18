const $ = (sel) => document.querySelector(sel);
const adminToken = () => { try { return localStorage.getItem('lc_admin_token') || ''; } catch { return ''; } };
const api = (path, opts = {}) => {
  const t = adminToken();
  const headers = Object.assign({}, opts.headers || {}, t ? { 'x-admin-token': t } : {});
  return fetch('/api' + path, { ...opts, headers }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && /admin/i.test(data.error || '')) { showAdminLogin(); throw new Error(data.error); }
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  });
};

let state = {
  collegeId: null, students: [], monthlyChart: null, practiceCollegeId: null,
  practiceDomain: '__all', // selected domain tab in the Practice section
  // dashboard pagination + filters
  dash: { batch: '', department: '', campus: '', q: '', sort: '', dir: '', risk: false, page: 1, pageSize: 100, total: 0 },
  filtersFor: null, // college id the filter dropdowns were populated for
};

// Charts read tick/grid colors from the active theme's CSS variables.
function lcChartColors() {
  const cs = getComputedStyle(document.documentElement);
  return {
    tick: cs.getPropertyValue('--muted').trim() || '#8b92a5',
    grid: cs.getPropertyValue('--border').trim() || 'rgba(128,134,149,.2)',
  };
}
function lcChartTheme() {
  if (!window.Chart) return;
  const { tick, grid } = lcChartColors();
  Chart.defaults.color = tick;
  Chart.defaults.borderColor = grid;
}
// Re-apply colors to an already-built chart (Chart.js bakes defaults at creation).
function recolorChart(c) {
  if (!c || !c.options || !c.options.scales) return;
  const { tick, grid } = lcChartColors();
  for (const ax of Object.values(c.options.scales)) {
    ax.ticks = Object.assign(ax.ticks || {}, { color: tick });
    if (!ax.grid || ax.grid.display !== false) ax.grid = Object.assign(ax.grid || {}, { color: grid });
  }
  c.update('none');
}
lcChartTheme();
window.__onTheme = () => { lcChartTheme(); recolorChart(state.monthlyChart); };

// ---- Tabs -------------------------------------------------------------------
document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $('#tab-' + t.dataset.tab).classList.add('active');
    if (t.dataset.tab === 'practice') populatePracticeColleges().then(loadPractice);
    if (t.dataset.tab === 'colleges') loadCollegesTab();
  });
});

// ---- Colleges tab -----------------------------------------------------------
function modeSelect(cls, val) {
  const v = val || 'on';
  return `<select class="filter-sel ${cls}">
    <option value="on"${v === 'on' ? ' selected' : ''}>On</option>
    <option value="off"${v === 'off' ? ' selected' : ''}>Off</option>
    <option value="scheduled"${v === 'scheduled' ? ' selected' : ''}>Scheduled</option>
  </select>`;
}
// Per-college auto-sync + auto-refresh controls (rendered as a row beneath each college).
function csetRow(c) {
  const sMode = c.sync_mode || 'on', rMode = c.refresh_mode || 'on';
  const win = (cls, from, to, show) => `<span class="${cls} ar-sched" style="display:${show ? 'inline-flex' : 'none'}">
      <input type="time" class="${cls}-from ar-time" value="${from || ''}" /> <span class="hint">–</span>
      <input type="time" class="${cls}-to ar-time" value="${to || ''}" /></span>`;
  return `<tr class="cset-row" data-id="${c.id}"><td colspan="6">
    <div class="cset">
      <span class="cset-grp"><span class="hint">🛰 Auto-sync</span> ${modeSelect('cset-sync-mode', sMode)} ${win('cset-sync', c.sync_from, c.sync_to, sMode === 'scheduled')}</span>
      <span class="cset-grp"><span class="hint">🔄 Auto-refresh</span> ${modeSelect('cset-ref-mode', rMode)} ${win('cset-ref', c.refresh_from, c.refresh_to, rMode === 'scheduled')}</span>
      <span class="cset-saved hint" style="color:var(--green);opacity:0">saved ✓</span>
    </div></td></tr>`;
}
async function loadCollegesTab() {
  $('#studentLink').textContent = location.origin + '/student';
  $('#studentLink').href = '/student';
  const colleges = await api('/colleges');
  const tbody = $('#collegeTable').querySelector('tbody');
  if (!colleges.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No colleges yet. Add one above.</td></tr>';
    return;
  }
  tbody.innerHTML = colleges.map((c) => `
    <tr>
      <td>${esc(c.name)}</td>
      <td>${c.student_count}</td>
      <td>${c.has_code ? '<span class="check">✓ set</span>' : '<span class="cross">none — can’t log in</span>'}</td>
      <td>
        <input class="search code-input" data-id="${c.id}" style="width:150px" placeholder="${c.has_code ? 'type to replace' : 'set a code'}" />
        <button class="btn btn-sm btn-primary set-code" data-id="${c.id}">Save</button>
      </td>
      <td>
        <button class="btn btn-sm btn-ghost gen-link" data-id="${c.id}">Get link</button>
        <span class="link-out" data-id="${c.id}"></span>
      </td>
      <td><button class="btn btn-sm btn-danger del-college" data-id="${c.id}" data-name="${esc(c.name)}" data-count="${c.student_count}">Delete</button></td>
    </tr>${csetRow(c)}`).join('');

  // Per-college auto-sync / auto-refresh settings — save on any change.
  tbody.querySelectorAll('.cset-row').forEach((row) => {
    const id = row.dataset.id;
    const save = async () => {
      const syncMode = row.querySelector('.cset-sync-mode').value;
      const refMode = row.querySelector('.cset-ref-mode').value;
      row.querySelector('.cset-sync').style.display = syncMode === 'scheduled' ? 'inline-flex' : 'none';
      row.querySelector('.cset-ref').style.display = refMode === 'scheduled' ? 'inline-flex' : 'none';
      const body = {
        sync_mode: syncMode,
        sync_from: row.querySelector('.cset-sync-from').value,
        sync_to: row.querySelector('.cset-sync-to').value,
        refresh_mode: refMode,
        refresh_from: row.querySelector('.cset-ref-from').value,
        refresh_to: row.querySelector('.cset-ref-to').value,
      };
      try {
        await api(`/colleges/${id}/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (state.collegesById && state.collegesById[id]) Object.assign(state.collegesById[id], body); // live-update the refresh gate
        const s = row.querySelector('.cset-saved'); if (s) { s.style.opacity = '1'; setTimeout(() => { s.style.opacity = '0'; }, 1500); }
      } catch (e) { alert('Could not save settings: ' + e.message); }
    };
    row.querySelectorAll('select, input[type=time]').forEach((el) => el.addEventListener('change', save));
  });

  tbody.querySelectorAll('.del-college').forEach((b) => b.addEventListener('click', async () => {
    const name = b.dataset.name, n = b.dataset.count;
    if (!confirm(`Delete "${name}" and ALL of its ${n} student(s), practice problems, and progress?\n\nThis cannot be undone.`)) return;
    try {
      await api(`/colleges/${b.dataset.id}`, { method: 'DELETE' });
      if (state.collegeId == b.dataset.id) state.collegeId = null;
      if (state.practiceCollegeId == b.dataset.id) state.practiceCollegeId = null;
      loadCollegesTab();
      loadColleges();
    } catch (e) { alert(e.message); }
  }));
  tbody.querySelectorAll('.gen-link').forEach((b) => b.addEventListener('click', async () => {
    try {
      const r = await api(`/colleges/${b.dataset.id}/view-link`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      const url = location.origin + r.path;
      const out = tbody.querySelector(`.link-out[data-id="${b.dataset.id}"]`);
      out.innerHTML = `<input class="search" readonly value="${url}" style="width:230px;margin-left:6px" onclick="this.select()" />
        <button class="btn btn-sm copy-link">Copy</button>
        <button class="btn btn-sm btn-ghost regen-link" data-id="${b.dataset.id}" title="Make a new link and invalidate the old one">↻</button>`;
      out.querySelector('.copy-link').addEventListener('click', () => {
        navigator.clipboard?.writeText(url); out.querySelector('.copy-link').textContent = 'Copied';
      });
      out.querySelector('.regen-link').addEventListener('click', async (e) => {
        if (!confirm('Generate a new link? The current one will stop working.')) return;
        const rr = await api(`/colleges/${b.dataset.id}/view-link`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ regenerate: true }),
        });
        out.querySelector('input').value = location.origin + rr.path;
        out.querySelector('.copy-link').textContent = 'Copy';
      });
    } catch (e) { alert(e.message); }
  }));
  tbody.querySelectorAll('.set-code').forEach((b) => b.addEventListener('click', async () => {
    const inp = tbody.querySelector(`.code-input[data-id="${b.dataset.id}"]`);
    const code = inp.value.trim();
    if (!code) return alert('Enter a code to set.');
    try {
      await api(`/colleges/${b.dataset.id}/access-code`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
      });
      loadCollegesTab();
    } catch (e) { alert(e.message); }
  }));
}

// Master on/off for auto-sync / auto-refresh across ALL colleges.
async function applyBulkMode(body, label) {
  if (!confirm(`Set ${label} for EVERY college?`)) return false;
  try {
    await api('/colleges/bulk-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await loadColleges();       // refresh the cached settings (browser refresh gating)
    await loadCollegesTab();    // redraw the per-college rows
    return true;
  } catch (e) { alert(e.message); return false; }
}
$('#allSyncMode')?.addEventListener('change', async (e) => {
  const v = e.target.value; e.target.value = '';
  if (v) await applyBulkMode({ sync_mode: v }, `auto-sync ${v.toUpperCase()}`);
});
$('#allRefreshMode')?.addEventListener('change', async (e) => {
  const v = e.target.value; e.target.value = '';
  if (v) await applyBulkMode({ refresh_mode: v }, `auto-refresh ${v.toUpperCase()}`);
});

$('#addCollegeBtn').addEventListener('click', async () => {
  const name = $('#newCollegeName').value.trim();
  const code = $('#newCollegeCode').value.trim();
  if (!name) return setMsg('#addCollegeMsg', 'Enter a college name.', 'err');
  if (!code) return setMsg('#addCollegeMsg', 'Set an access code so students can log in.', 'err');
  try {
    const r = await api('/colleges', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, code }),
    });
    setMsg('#addCollegeMsg', `Added "${r.name}" with an access code. Now upload its roster in the Upload tab.`, 'ok');
    $('#newCollegeName').value = '';
    $('#newCollegeCode').value = '';
    loadCollegesTab();
    loadColleges();
  } catch (e) { setMsg('#addCollegeMsg', e.message, 'err'); }
});

// ---- College picker ---------------------------------------------------------
async function loadColleges() {
  const colleges = await api('/colleges');
  // Cache per-college settings so the browser auto-refresh can follow them.
  state.collegesById = Object.fromEntries(colleges.map((c) => [c.id, c]));

  // Keep the Upload tab's college dropdown in sync with existing colleges.
  const up = $('#uploadCollege');
  const prevUp = up.value;
  const opts = colleges.length
    ? colleges.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('')
    : '<option value="">No colleges yet — add one in the Colleges tab</option>';
  up.innerHTML = opts;
  if (colleges.some((c) => c.name === prevUp)) up.value = prevUp;
  // Mirror the same college list into the single-student form.
  const ssc = $('#singleStudentCollege');
  if (ssc) { const prev = ssc.value; ssc.innerHTML = opts; if (colleges.some((c) => c.name === prev)) ssc.value = prev; }
  if (typeof loadSSOptions === 'function') loadSSOptions(); // prefetch dropdown values for the single-student form

  const sel = $('#collegeSelect');
  sel.innerHTML = '';
  if (!colleges.length) {
    sel.innerHTML = '<option value="">No colleges yet — upload a roster</option>';
    renderEmptyDashboard();
    return;
  }
  for (const c of colleges) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = `${c.name} (${c.student_count})`;
    sel.appendChild(o);
  }
  const prevCollege = state.collegeId;
  state.collegeId = state.collegeId && colleges.some((c) => c.id == state.collegeId)
    ? state.collegeId : colleges[0].id;
  if (state.collegeId !== prevCollege) resetDash(); // switched/auto-picked a different college
  sel.value = state.collegeId;
  loadDashboard();
  loadAccessCode();
}
$('#collegeSelect').addEventListener('change', (e) => {
  state.collegeId = Number(e.target.value);
  resetDash();
  loadDashboard();
  loadAccessCode();
});

async function loadAccessCode() {
  if (!state.collegeId) return;
  try {
    const c = await api(`/colleges/${state.collegeId}`);
    $('#accessCode').value = '';
    $('#accessCode').placeholder = c.has_code ? '•••••• (set — type to replace)' : 'e.g. ABC-2026';
    setMsg('#accessMsg', c.has_code ? 'Code is set.' : 'No code yet — students can’t log in.', c.has_code ? 'ok' : '');
  } catch {}
}
$('#saveCodeBtn').addEventListener('click', async () => {
  if (!state.collegeId) return;
  const code = $('#accessCode').value.trim();
  try {
    const r = await api(`/colleges/${state.collegeId}/access-code`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
    });
    setMsg('#accessMsg', r.has_code ? 'Saved.' : 'Cleared — students can’t log in.', r.has_code ? 'ok' : 'err');
    $('#accessCode').value = '';
    $('#accessCode').placeholder = r.has_code ? '•••••• (set — type to replace)' : 'e.g. ABC-2026';
  } catch (e) { setMsg('#accessMsg', e.message, 'err'); }
});

// ---- Dashboard --------------------------------------------------------------
function renderEmptyDashboard() {
  $('#summaryCards').innerHTML = '';
  $('#studentTable').querySelector('tbody').innerHTML =
    '<tr><td colspan="8" class="empty">No data yet. Go to the Upload tab to add a student roster.</td></tr>';
  if ($('#pageInfo')) $('#pageInfo').textContent = '';
}

let dashAbort = null;
async function loadDashboard(opts = {}) {
  if (!state.collegeId) return renderEmptyDashboard();
  const dq = state.dash;
  const params = {
    batch: dq.batch, department: dq.department, campus: dq.campus, q: dq.q,
    sort: dq.sort || '', dir: dq.dir || '', risk: dq.risk ? '1' : '',
    page: String(dq.page), pageSize: String(dq.pageSize),
  };
  if (opts.chart === false) params.light = '1'; // auto-refresh: skip monthly/filter queries
  const qs = new URLSearchParams(params);
  dashAbort?.abort();
  const ctrl = new AbortController();
  dashAbort = ctrl;
  let d;
  try {
    d = await api(`/colleges/${state.collegeId}/dashboard?${qs}`, { signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError' || /abort/i.test(e.message || '')) return; // superseded by a newer load
    throw e;
  }
  state.students = d.students;
  state.dash.total = d.total;

  const label = (dq.batch || dq.department || dq.campus || dq.q) ? 'Students (filtered)' : 'Students';
  $('#summaryCards').innerHTML = `
    <div class="card"><div class="v">${d.totals.students}</div><div class="l">${label}</div></div>
    <div class="card"><div class="v">${d.totals.total}</div><div class="l">Total solved</div></div>
    <div class="card easy"><div class="v">${d.totals.easy}</div><div class="l">Easy</div></div>
    <div class="card medium"><div class="v">${d.totals.medium}</div><div class="l">Medium</div></div>
    <div class="card hard"><div class="v">${d.totals.hard}</div><div class="l">Hard</div></div>
    <div class="card"><div class="v">${d.practiceTotal}</div><div class="l">Practice problems</div></div>`;

  if (state.filtersFor !== state.collegeId && d.filters) { populateFilters(d.filters); state.filtersFor = state.collegeId; }
  renderStudents(d.students);
  renderPager();
  if (opts.chart !== false) loadMonthly(); // chart loads on its own, never blocks the table
}

// The monthly chart is fetched separately (cached server-side) so it loads
// immediately and stays accurate without holding up the students table.
let monthlyAbort = null;
async function loadMonthly() {
  if (!state.collegeId) return;
  const status = $('#monthlyStatus');
  if (status && !state.monthlyChart) status.textContent = 'Loading…';
  const dq = state.dash;
  const qs = new URLSearchParams({ batch: dq.batch, department: dq.department, campus: dq.campus });
  monthlyAbort?.abort();
  const ctrl = new AbortController();
  monthlyAbort = ctrl;
  let d;
  try {
    d = await api(`/colleges/${state.collegeId}/monthly?${qs}`, { signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError' || /abort/i.test(e.message || '')) return; // superseded
    if (status) status.textContent = 'Couldn’t load the chart. If you just updated the app, restart the server.';
    return;
  }
  const monthly = d.monthly || [];
  if (status) status.textContent = monthly.length ? '' : 'No submission activity yet.';
  renderMonthlyChart(monthly);
}

function resetDash() {
  state.dash = { batch: '', department: '', campus: '', q: '', sort: '', dir: '', risk: false, page: 1, pageSize: 100, total: 0 };
  state.filtersFor = null;
  state.studentsSig = null; // force a repaint for the new college
  state.monthlySig = null;
  if (state.monthlyChart) { state.monthlyChart.destroy(); state.monthlyChart = null; } // drop old college's chart
  const ss = $('#studentSearch'); if (ss) ss.value = '';
  // Instant feedback: drop the old college's rows and show a loading state so the
  // switch feels immediate instead of showing stale data until the fetch returns.
  $('#summaryCards').innerHTML = '';
  const tb = $('#studentTable').querySelector('tbody');
  if (tb) tb.innerHTML = '<tr><td colspan="8" class="empty">Loading…</td></tr>';
  if ($('#pageInfo')) $('#pageInfo').textContent = '';
}

function fillSel(sel, allLabel, opts, cur) {
  const el = $(sel);
  el.innerHTML = `<option value="">${allLabel}</option>` + opts.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  el.value = opts.includes(cur) ? cur : '';
}
function populateFilters(f) {
  // drop any active filter that no longer exists for this college
  if (!f.campuses.includes(state.dash.campus)) state.dash.campus = '';
  if (!f.departments.includes(state.dash.department)) state.dash.department = '';
  if (!f.batches.includes(state.dash.batch)) state.dash.batch = '';
  fillSel('#filterCampus', 'All campuses', f.campuses, state.dash.campus);
  fillSel('#filterDept', 'All departments', f.departments, state.dash.department);
  fillSel('#filterBatch', 'All batches', f.batches, state.dash.batch);
}
function renderPager() {
  const { page, pageSize, total } = state.dash;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  $('#pageInfo').textContent = `${from}–${to} of ${total}`;
  $('#prevPage').disabled = page <= 1;
  $('#nextPage').disabled = page >= pages;
}

$('#filterBatch').addEventListener('change', (e) => { state.dash.batch = e.target.value; state.dash.page = 1; loadDashboard(); });
$('#filterDept').addEventListener('change', (e) => { state.dash.department = e.target.value; state.dash.page = 1; loadDashboard(); });
$('#filterCampus').addEventListener('change', (e) => { state.dash.campus = e.target.value; state.dash.page = 1; loadDashboard(); });

// At-risk filter toggle
$('#riskToggle').addEventListener('click', () => {
  state.dash.risk = !state.dash.risk;
  state.dash.page = 1;
  $('#riskToggle').classList.toggle('btn-primary', state.dash.risk);
  $('#riskToggle').classList.toggle('btn-ghost', !state.dash.risk);
  loadDashboard();
});

// Sortable column headers
document.querySelectorAll('#studentTable th.sortable').forEach((th) => th.addEventListener('click', () => {
  const key = th.dataset.sort;
  if (state.dash.sort === key) {
    state.dash.dir = state.dash.dir === 'asc' ? 'desc' : 'asc';
  } else {
    state.dash.sort = key;
    state.dash.dir = key === 'rank' ? 'asc' : 'desc'; // rank: lower is better
  }
  state.dash.page = 1;
  state.studentsSig = null; // force repaint
  loadDashboard();
  markSortHeaders();
}));
function markSortHeaders() {
  document.querySelectorAll('#studentTable th.sortable').forEach((th) => {
    const active = th.dataset.sort === state.dash.sort;
    th.dataset.arrow = active ? (state.dash.dir === 'asc' ? '▲' : '▼') : '';
    th.classList.toggle('sorted', active);
  });
}

// Export the current (filtered/sorted) view to Excel. Uses fetch+blob because
// the endpoint is admin-gated and a plain link can't send the auth header.
$('#exportBtn').addEventListener('click', async () => {
  if (!state.collegeId) return;
  const dq = state.dash;
  const qs = new URLSearchParams({
    batch: dq.batch, department: dq.department, campus: dq.campus, q: dq.q,
    sort: dq.sort || '', dir: dq.dir || '', risk: dq.risk ? '1' : '',
  });
  const btn = $('#exportBtn'); const orig = btn.textContent; btn.textContent = '⏳ Exporting…'; btn.disabled = true;
  try {
    const res = await fetch(`/api/colleges/${state.collegeId}/export?${qs}`, {
      headers: adminToken() ? { 'x-admin-token': adminToken() } : {},
    });
    if (!res.ok) throw new Error('Export failed (' + res.status + ')');
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const name = (cd.match(/filename="([^"]+)"/) || [])[1] || 'students.xlsx';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
    a.remove(); URL.revokeObjectURL(url);
  } catch (e) { alert(e.message); }
  btn.textContent = orig; btn.disabled = false;
});
$('#prevPage').addEventListener('click', () => { if (state.dash.page > 1) { state.dash.page--; loadDashboard(); } });
$('#nextPage').addEventListener('click', () => {
  const pages = Math.max(1, Math.ceil(state.dash.total / state.dash.pageSize));
  if (state.dash.page < pages) { state.dash.page++; loadDashboard(); }
});

function avInitial(name) { return (name || '?').trim().charAt(0).toUpperCase(); }
function avColor(name) {
  let h = 0;
  for (const c of String(name || '')) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h}, 58%, 50%)`;
}
function rankCell(r) {
  if (r === 1) return '<span class="medal">🥇</span>';
  if (r === 2) return '<span class="medal">🥈</span>';
  if (r === 3) return '<span class="medal">🥉</span>';
  return `<span class="rank-num">${r}</span>`;
}
function difficultyCell(s) {
  const e = s.solved_easy || 0, m = s.solved_medium || 0, h = s.solved_hard || 0, sum = e + m + h || 1;
  return `<div class="dbar">
      <span style="width:${(e / sum) * 100}%;background:var(--easy)"></span>
      <span style="width:${(m / sum) * 100}%;background:var(--medium)"></span>
      <span style="width:${(h / sum) * 100}%;background:var(--hard)"></span>
    </div>
    <div class="dcounts"><span style="color:var(--easy)">${e}</span> · <span style="color:var(--medium)">${m}</span> · <span style="color:var(--hard)">${h}</span></div>`;
}
function practiceCell(s) {
  const tot = s.practiceTotal || 0, done = s.practiceCompleted || 0;
  const pct = tot ? Math.round((done / tot) * 100) : 0;
  return `<div class="pp"><span class="bar"><span style="width:${pct}%"></span></span><span class="hint">${done}/${tot}</span></div>`;
}

function renderStudents(students) {
  const rows = students; // filtering/search now handled server-side
  const tbody = $('#studentTable').querySelector('tbody');
  // Skip the DOM rebuild when nothing changed (avoids flicker on the 2s refresh).
  const sig = JSON.stringify(rows.map((s) => [s.id, s.classRank, s.name, s.username, s.section, s.department,
    s.ranking, s.baseline_ranking, s.solved_easy, s.solved_medium, s.solved_hard, s.solved_total,
    s.baseline_easy, s.baseline_medium, s.baseline_hard, s.baseline_total, s.practiceCompleted, s.practiceTotal,
    s.sync_status, s.sync_error, s.last_synced_at, s.at_risk]));
  if (sig === state.studentsSig) return;
  state.studentsSig = sig;
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">No students match.</td></tr>';
    updateBulkBar();
    return;
  }
  tbody.innerHTML = rows.map((s) => `
    <tr data-id="${s.id}">
      <td><input type="checkbox" class="row-sel" data-id="${s.id}"${selectedStudents.has(s.id) ? ' checked' : ''} /></td>
      <td>${rankCell(s.classRank)}</td>
      <td>
        <div class="s-cell">
          <div class="s-av" style="background:${avColor(s.name)}">${esc(avInitial(s.name))}</div>
          <div>
            <div class="s-name">${esc(s.name)}${s.at_risk ? ' <span class="risk-badge" title="Inactive: no new problems solved since tracking began">⚠ inactive</span>' : ''}</div>
            <div class="s-user">@${esc(s.username)}</div>
            ${(s.section || s.department) ? `<div class="s-tags">${s.section ? `<span class="tag">${esc(s.section)}</span>` : ''}${s.department ? `<span class="tag">${esc(s.department)}</span>` : ''}</div>` : ''}
          </div>
        </div>
      </td>
      <td>${s.found ? (s.ranking ? '#' + s.ranking.toLocaleString() : '—') : '<span class="cross">private</span>'}${rankDelta(s)}</td>
      <td>${difficultyCell(s)}</td>
      <td><span class="tot">${s.solved_total}</span>${gain(s.solved_total, s.baseline_total)}</td>
      <td>${practiceCell(s)}</td>
      <td><span class="dot ${s.sync_status}"></span>${fmtAgo(s.last_synced_at)}${s.sync_status === 'error' ? ` <span class="cross" title="${esc(s.sync_error || 'sync failed')}">⚠</span>` : ''}</td>
      <td><button class="btn btn-sm btn-ghost sync-one" data-id="${s.id}">⟳</button></td>
    </tr>`).join('');

  tbody.querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.sync-one') || e.target.closest('.row-sel')) return;
      openStudent(tr.dataset.id);
    });
  });
  tbody.querySelectorAll('.sync-one').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      b.textContent = '…';
      try { await api(`/students/${b.dataset.id}/sync`, { method: 'POST' }); }
      catch (err) { alert(err.message); }
      loadDashboard();
    });
  });
  tbody.querySelectorAll('.row-sel').forEach((cb) => cb.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = Number(cb.dataset.id);
    cb.checked ? selectedStudents.add(id) : selectedStudents.delete(id);
    updateBulkBar();
  }));
  updateBulkBar();
}

// ---- Bulk select students ---------------------------------------------------
const selectedStudents = new Set();
function updateBulkBar() {
  const bar = $('#bulkBar'); if (!bar) return;
  const n = selectedStudents.size;
  bar.style.display = n ? 'flex' : 'none';
  if (n) $('#bulkCount').textContent = `${n} selected`;
  const all = $('#selAll');
  if (all) {
    const boxes = document.querySelectorAll('#studentTable .row-sel');
    all.checked = boxes.length > 0 && [...boxes].every((b) => b.checked);
  }
}
$('#selAll')?.addEventListener('change', (e) => {
  document.querySelectorAll('#studentTable .row-sel').forEach((cb) => {
    cb.checked = e.target.checked;
    const id = Number(cb.dataset.id);
    e.target.checked ? selectedStudents.add(id) : selectedStudents.delete(id);
  });
  updateBulkBar();
});
$('#bulkClear')?.addEventListener('click', () => {
  selectedStudents.clear();
  document.querySelectorAll('#studentTable .row-sel').forEach((cb) => { cb.checked = false; });
  updateBulkBar();
});
$('#bulkSync')?.addEventListener('click', async () => {
  const ids = [...selectedStudents];
  if (!ids.length) return;
  const btn = $('#bulkSync'); btn.disabled = true; btn.textContent = '⟳ Syncing…';
  for (const id of ids) { try { await api(`/students/${id}/sync`, { method: 'POST' }); } catch {} }
  btn.disabled = false; btn.textContent = '⟳ Sync selected';
  loadDashboard();
});
$('#bulkDelete')?.addEventListener('click', async () => {
  const ids = [...selectedStudents];
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} selected student(s)? This can’t be undone.`)) return;
  const btn = $('#bulkDelete'); btn.disabled = true; btn.textContent = '🗑 Deleting…';
  for (const id of ids) { try { await api(`/students/${id}`, { method: 'DELETE' }); } catch {} }
  selectedStudents.clear();
  btn.disabled = false; btn.textContent = '🗑 Delete selected';
  state.studentsSig = null;
  loadDashboard();
});
let searchTimer = null;
$('#studentSearch').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const v = e.target.value.trim();
  searchTimer = setTimeout(() => { state.dash.q = v; state.dash.page = 1; loadDashboard(); }, 350);
});

function renderMonthlyChart(monthly) {
  const sig = JSON.stringify(monthly);
  if (sig === state.monthlySig && state.monthlyChart) return; // unchanged — no rebuild/flicker
  state.monthlySig = sig;
  const ctx = $('#monthlyChart');
  if (state.monthlyChart) state.monthlyChart.destroy();
  state.monthlyChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: monthly.map((m) => m.ym),
      datasets: [{ label: 'Submissions', data: monthly.map((m) => m.submissions), backgroundColor: '#ffa116' }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true },
      },
    },
  });
}

// ---- Student drawer ---------------------------------------------------------
async function openStudent(id) {
  const d = await api(`/students/${id}`);
  const s = d.student;
  const growth = d.monthlySolvedGrowth;
  $('#drawerContent').innerHTML = `
    <h2 style="margin-top:0">${esc(s.name)}</h2>
    <p class="hint"><a href="${esc(s.profile_url || '#')}" target="_blank">@${esc(s.username)}</a>
      ${s.found ? '' : '· <span class="cross">profile not found / private</span>'}</p>
    ${(s.register_number || s.department || s.section || s.campus || s.year) ? `<p class="hint" style="line-height:1.7">
      ${s.register_number ? `Reg: <b>${esc(s.register_number)}</b> · ` : ''}${s.section ? `Batch: <b>${esc(s.section)}</b> · ` : ''}${s.department ? `${esc(s.department)} · ` : ''}${s.campus ? `${esc(s.campus)}` : ''}${s.year ? ` · ${esc(s.year)}` : ''}</p>` : ''}
    <div class="kv">
      <div><div class="l">Global rank</div><div class="v">${s.ranking ? '#' + s.ranking.toLocaleString() : '—'}</div></div>
      <div><div class="l">Total solved</div><div class="v">${s.solved_total}</div></div>
      <div><div class="l">Easy</div><div class="v" style="color:var(--easy)">${s.solved_easy}</div></div>
      <div><div class="l">Medium</div><div class="v" style="color:var(--medium)">${s.solved_medium}</div></div>
      <div><div class="l">Hard</div><div class="v" style="color:var(--hard)">${s.solved_hard}</div></div>
      <div><div class="l">Contest rating</div><div class="v">${s.contest_rating || '—'}</div></div>
    </div>
    ${progressBlock(s)}
    <h2>Monthly submissions</h2>
    <canvas id="drawerMonthly" height="120"></canvas>
    ${growth.length ? `<h2 style="margin-top:18px">Problems solved per month</h2>
      <table><thead><tr><th>Month</th><th>Easy</th><th>Med</th><th>Hard</th><th>Total</th></tr></thead>
      <tbody>${growth.map((g) => `<tr><td>${g.ym}</td><td>${g.easy}</td><td>${g.medium}</td><td>${g.hard}</td><td><b>${g.total}</b></td></tr>`).join('')}</tbody></table>
      <p class="hint">Computed from snapshot diffs — accumulates as the app keeps running.</p>` : ''}
    <h2 style="margin-top:18px">Practice problems <span class="hint">(you can manually mark/unmark)</span></h2>
    <table><thead><tr><th>Problem</th><th>Status</th><th></th></tr></thead><tbody>
      ${d.practice.length ? d.practice.map((p) => `<tr><td><a href="${esc(p.url)}" target="_blank">${esc(p.title)}</a>${dueLabel(p.due_date)}</td>
        <td>${p.completed ? '<span class="check">✓ solved</span>' : '<span class="cross">pending</span>'}</td>
        <td><button class="btn btn-sm ${p.completed ? 'btn-ghost' : 'btn-primary'} toggle-comp" data-pid="${p.id}" data-done="${p.completed ? 1 : 0}">${p.completed ? 'Unmark' : 'Mark done'}</button></td></tr>`).join('')
        : '<tr><td colspan="3" class="empty">No problems assigned.</td></tr>'}
    </tbody></table>
    <div style="margin-top:24px; border-top:1px solid var(--border); padding-top:16px">
      <button class="btn btn-sm btn-danger del-student" data-id="${s.id}" data-name="${esc(s.name)}">Delete this student</button>
    </div>`;

  openDrawer();
  const m = d.monthlyActivity;
  new Chart($('#drawerMonthly'), {
    type: 'line',
    data: { labels: m.map((x) => x.ym), datasets: [{ data: m.map((x) => x.submissions), borderColor: '#ffa116', backgroundColor: 'rgba(255,161,22,.15)', fill: true, tension: .3 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
  });

  $('#drawerContent').querySelectorAll('.toggle-comp').forEach((b) => b.addEventListener('click', async () => {
    const pid = b.dataset.pid, done = b.dataset.done === '1';
    b.disabled = true;
    try {
      await api(`/students/${id}/completions/${pid}`, { method: done ? 'DELETE' : 'POST' });
      state.studentsSig = null; // dashboard counts changed
      openStudent(id); // re-render the drawer with the new state
    } catch (e) { b.disabled = false; }
  }));

  const ds = $('#drawerContent').querySelector('.del-student');
  if (ds) ds.addEventListener('click', async () => {
    if (!confirm(`Delete "${ds.dataset.name}" and all their data (stats, progress, completions)? This cannot be undone.`)) return;
    try {
      await api(`/students/${ds.dataset.id}`, { method: 'DELETE' });
      closeDrawer();
      loadDashboard();
    } catch (e) { alert(e.message); }
  });

  const rb = $('#drawerContent').querySelector('.reset-baseline');
  if (rb) rb.addEventListener('click', async () => {
    if (!confirm('Reset this student’s baseline to their current stats? Progress will restart from now.')) return;
    try {
      await api(`/students/${rb.dataset.id}/reset-baseline`, { method: 'POST' });
      openStudent(rb.dataset.id); // re-render drawer with the new baseline
      loadDashboard();
    } catch (e) { alert(e.message); }
  });
}
function openDrawer() { $('#drawer').classList.add('open'); $('#drawerBackdrop').classList.add('show'); }
function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawerBackdrop').classList.remove('show'); }
$('#drawerClose').addEventListener('click', closeDrawer);
$('#drawerBackdrop').addEventListener('click', closeDrawer);

// ---- Practice tab -----------------------------------------------------------
// The Practice tab has its own college selector (state.practiceCollegeId),
// independent of the dashboard's top-bar selection.
const practiceCid = () => state.practiceCollegeId || state.collegeId;

async function populatePracticeColleges() {
  const colleges = await api('/colleges');
  const sel = $('#practiceCollege');
  const cur = practiceCid();
  sel.innerHTML = colleges.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  if (colleges.some((c) => c.id == cur)) sel.value = cur;
  state.practiceCollegeId = Number(sel.value) || null;
}
$('#practiceCollege').addEventListener('change', (e) => {
  state.practiceCollegeId = Number(e.target.value);
  // Instant feedback + force repaint for the newly selected college.
  state.practiceSig = null;
  state.practiceDomain = '__all';
  $('#completionDist').innerHTML = '';
  $('#practiceTable').querySelector('tbody').innerHTML = '<tr><td colspan="5" class="empty">Loading…</td></tr>';
  loadPractice();
});

const domName = (p) => (p.domain && p.domain.trim()) || 'Uncategorized';
const topName = (p) => (p.topic && p.topic.trim()) || 'Uncategorized';
const sortGroups = (a, b) => (a === 'Uncategorized' ? 1 : b === 'Uncategorized' ? -1 : a.localeCompare(b));
const collapsedDomains = new Set(); // domains folded in the practice list
const collapsedTopics = new Set(); // topics folded (keyed by domain|topic)

// Small deadline pill: red when the due date has passed, muted otherwise.
function dueLabel(due) {
  if (!due) return '';
  const today = new Date().toISOString().slice(0, 10);
  const overdue = due < today;
  return ` <span class="due-pill${overdue ? ' overdue' : ''}" title="Deadline">⏰ ${esc(due)}${overdue ? ' · overdue' : ''}</span>`;
}

let practiceAbort = null;
async function loadPractice() {
  const cid = practiceCid();
  if (!cid) return;
  practiceAbort?.abort();
  const ctrl = new AbortController();
  practiceAbort = ctrl;
  let d;
  try {
    d = await api(`/colleges/${cid}/practice`, { signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError' || /abort/i.test(e.message || '')) return;
    throw e;
  }
  state.lastPractice = d;
  renderPracticeData(d);
}

// Render the practice tab from cached data — used by loadPractice and by
// instant (no-fetch) domain-tab / fold clicks.
function renderPracticeData(d) {
  // Skip the rebuild when nothing relevant changed (no flicker on auto-refresh).
  const sig = JSON.stringify([
    d.studentCount, d.domains, d.topics, state.practiceDomain, [...collapsedDomains], [...collapsedTopics],
    d.problems.map((p) => [p.id, p.title, p.difficulty, p.topic, p.domain, p.completedCount, p.due_date, p.video_url]),
  ]);
  if (sig === state.practiceSig) return;
  state.practiceSig = sig;

  renderCompletionDist(d);
  state.showVideo = !!d.showVideo;
  setVideoToggleLabel();
  const tbody = $('#practiceTable').querySelector('tbody');
  if (!d.problems.length) {
    $('#domainTabs').innerHTML = '';
    tbody.innerHTML = '<tr><td colspan="5" class="empty">No practice problems assigned yet.</td></tr>';
    return;
  }
  $('#topicList').innerHTML = (d.topics || []).map((t) => `<option value="${esc(t)}">`).join('');
  $('#domainList').innerHTML = (d.domains || []).map((t) => `<option value="${esc(t)}">`).join('');

  // topic comparator honouring the saved order
  const torder = new Map((d.topics || []).map((n, i) => [n, i]));
  const tcmp = (a, b) => {
    if (a === 'Uncategorized') return 1;
    if (b === 'Uncategorized') return -1;
    const ia = torder.has(a) ? torder.get(a) : 1e9, ib = torder.has(b) ? torder.get(b) : 1e9;
    return ia - ib || a.localeCompare(b);
  };

  // domain tabs in saved order (+ Uncategorized last)
  const present = new Set(d.problems.map(domName));
  const domainSet = [...(d.domains || []).filter((n) => present.has(n))];
  if (present.has('Uncategorized')) domainSet.push('Uncategorized');
  if (state.practiceDomain && state.practiceDomain !== '__all' && !domainSet.includes(state.practiceDomain)) {
    state.practiceDomain = '__all';
  }
  const sel = state.practiceDomain || '__all';
  $('#domainTabs').innerHTML =
    `<button class="dom-tab ${sel === '__all' ? 'active' : ''}" data-dom="__all">All domains</button>` +
    domainSet.map((dn) => `<button class="dom-tab ${sel === dn ? 'active' : ''}" data-dom="${esc(dn)}">${esc(dn)}</button>`).join('');
  $('#domainTabs').querySelectorAll('.dom-tab').forEach((b) => b.addEventListener('click', () => {
    state.practiceDomain = b.dataset.dom;
    renderPracticeData(state.lastPractice); // instant, no refetch
  }));

  const rowHtml = (p) => {
    const pct = d.studentCount ? Math.round((p.completedCount / d.studentCount) * 100) : 0;
    return `<tr>
      <td><a href="${esc(p.url)}" target="_blank">${esc(p.title)}</a>${p.video_url ? ` <button class="vid-link" data-video="${esc(p.video_url)}" title="YouTube video">▶ video</button>` : ''}${dueLabel(p.due_date)}</td>
      <td>${p.difficulty ? `<span class="pill ${(p.difficulty || '').toLowerCase()}">${esc(p.difficulty)}</span>` : '—'}</td>
      <td class="prog-cell" data-pid="${p.id}" data-title="${esc(p.title)}" style="cursor:pointer" title="Click to see who completed / didn't">${p.completedCount}/${d.studentCount}</td>
      <td class="prog-cell" data-pid="${p.id}" data-title="${esc(p.title)}" style="cursor:pointer" title="Click to see who completed / didn't"><span class="progress"><span style="width:${pct}%"></span></span> ${pct}%</td>
      <td><button class="btn btn-sm btn-danger del-prob" data-id="${p.id}">Delete</button></td>
    </tr>`;
  };
  // topic sub-group within a set of problems (foldable)
  const byTopic = (probs) => {
    const groups = {};
    for (const p of probs) (groups[topName(p)] ||= []).push(p);
    return Object.keys(groups).sort(tcmp).map((t) => {
      const g = groups[t];
      const key = domName(g[0]) + '|' + t;
      const collapsed = collapsedTopics.has(key);
      const head = `<tr class="topic-foldrow" data-topic="${esc(key)}"><td colspan="5" style="background:var(--panel-2);font-weight:600;padding-left:18px;cursor:pointer">${collapsed ? '▸' : '▾'} ${esc(t)} <span style="color:var(--muted);font-weight:400">· ${g.length}</span><button class="btn btn-sm btn-danger del-topic" data-domain="${esc(domName(g[0]))}" data-topic="${esc(t)}" style="float:right;font-weight:600" title="Remove every question under this topic">🗑 Remove all</button></td></tr>`;
      return head + (collapsed ? '' : g.map(rowHtml).join(''));
    }).join('');
  };

  let html = '';
  if (sel === '__all') {
    // group by domain (foldable header), then topic
    const domGroups = {};
    for (const p of d.problems) (domGroups[domName(p)] ||= []).push(p);
    html = domainSet.map((dn) => {
      const collapsed = collapsedDomains.has(dn);
      const head = `<tr class="dom-foldrow" data-dom="${esc(dn)}"><td colspan="5" style="background:var(--accent);color:#1a1300;font-weight:700;cursor:pointer">${collapsed ? '▸' : '▾'} ${esc(dn)} <span style="font-weight:400">· ${domGroups[dn].length}</span></td></tr>`;
      return head + (collapsed ? '' : byTopic(domGroups[dn]));
    }).join('');
  } else {
    html = byTopic(d.problems.filter((p) => domName(p) === sel));
  }
  tbody.innerHTML = html;

  tbody.querySelectorAll('.dom-foldrow').forEach((r) => r.addEventListener('click', () => {
    const dn = r.dataset.dom;
    collapsedDomains.has(dn) ? collapsedDomains.delete(dn) : collapsedDomains.add(dn);
    renderPracticeData(state.lastPractice); // instant, no refetch
  }));
  tbody.querySelectorAll('.topic-foldrow').forEach((r) => r.addEventListener('click', () => {
    const k = r.dataset.topic;
    collapsedTopics.has(k) ? collapsedTopics.delete(k) : collapsedTopics.add(k);
    renderPracticeData(state.lastPractice); // instant, no refetch
  }));
  tbody.querySelectorAll('.del-topic').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation(); // don't toggle the fold
    const dn = b.dataset.domain, tp = b.dataset.topic;
    if (!confirm(`Remove ALL questions under “${tp}”? This can’t be undone.`)) return;
    b.disabled = true;
    try {
      const r = await api(`/colleges/${practiceCid()}/practice-by-topic?domain=${encodeURIComponent(dn)}&topic=${encodeURIComponent(tp)}`, { method: 'DELETE' });
      setMsg('#practiceMsg', `Removed ${r.removed} question(s) from “${tp}”.`, 'ok', 5000);
    } catch (err) { setMsg('#practiceMsg', err.message, 'err'); }
    loadPractice();
  }));
  tbody.querySelectorAll('.del-prob').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Remove this practice problem?')) return;
    await api(`/practice/${b.dataset.id}`, { method: 'DELETE' });
    loadPractice();
  }));
  tbody.querySelectorAll('.prog-cell').forEach((c) => c.addEventListener('click', () =>
    showProblemCompletion(Number(c.dataset.pid), c.dataset.title)));
}

// Who completed / didn't complete one specific problem (drawer).
async function showProblemCompletion(problemId, title) {
  const cid = practiceCid(); if (!cid) return;
  $('#drawerContent').innerHTML = '<p class="hint">Loading…</p>';
  openDrawer();
  let d;
  try { d = await api(`/colleges/${cid}/practice/${problemId}/completion`); }
  catch { $('#drawerContent').innerHTML = '<p class="empty">Could not load.</p>'; return; }
  const table = (arr) => arr.length
    ? `<table class="mini-table"><thead><tr><th>Name</th><th>Username</th><th>Reg no</th><th>Section</th></tr></thead><tbody>${
        arr.map((s) => `<tr data-id="${s.id}" style="cursor:pointer">
          <td>${esc(s.name || '')}</td><td>@${esc(s.username || '')}</td>
          <td>${esc(s.register_number || '—')}</td><td>${esc(s.section || '—')}</td></tr>`).join('')
      }</tbody></table>`
    : '<p class="empty">None.</p>';
  $('#drawerContent').innerHTML = `<h2 style="margin-top:0">${esc(title || 'Problem')}</h2>
    <h2 style="color:var(--green);margin-top:14px">✓ Completed (${d.completed.length})</h2>${table(d.completed)}
    <h2 style="color:var(--hard);margin-top:20px">✗ Not completed (${d.notCompleted.length})</h2>${table(d.notCompleted)}`;
  $('#drawerContent').querySelectorAll('tr[data-id]').forEach((tr) =>
    tr.addEventListener('click', () => openStudent(tr.dataset.id)));
}

// ---- Completion breakdown (how many students solved how many questions) -----
let distPage = 1;
const DIST_PER_PAGE = 10;
function renderCompletionDist(d) {
  const el = $('#completionDist');
  if (!el) return;
  const total = d.problems.length;
  if (!d.studentCount) {
    el.innerHTML = '<p class="hint" style="margin:0">No students in this college yet.</p>';
    return;
  }
  // One row per level 0..total (fill empty levels with 0 students) so pagination
  // spans every 10 questions, not just the levels that happen to have students.
  const distMap = new Map((d.completionDist || []).map((x) => [x.completed, x.students]));
  const dist = [];
  for (let i = 0; i <= total; i++) dist.push({ completed: i, students: distMap.get(i) || 0 });
  const pages = Math.max(1, Math.ceil(dist.length / DIST_PER_PAGE));
  distPage = Math.min(Math.max(1, distPage), pages);
  const start = (distPage - 1) * DIST_PER_PAGE;
  const pageRows = dist.slice(start, start + DIST_PER_PAGE);
  const maxStudents = Math.max(...dist.map((x) => x.students), 1);
  const rowsHtml = pageRows.map((x) => {
    const pct = Math.round((x.students / maxStudents) * 100);
    const all = total && x.completed === total ? ' <span class="dist-all">all</span>' : '';
    const label = x.completed === 0
      ? 'Solved 0 questions'
      : `Solved ${x.completed} question${x.completed > 1 ? 's' : ''}${all}`;
    const shareOfCohort = Math.round((x.students / d.studentCount) * 100);
    return `<button class="dist-row" data-count="${x.completed}" title="Click to list these students">
      <span class="dist-label">${label}</span>
      <span class="dist-bar"><span style="width:${pct}%"></span></span>
      <span class="dist-num">${x.students} <span class="hint">(${shareOfCohort}%)</span></span>
    </button>`;
  }).join('');
  const pager = pages > 1 ? `<div class="dist-pager">
      <button class="btn btn-sm btn-ghost dist-prev" ${distPage === 1 ? 'disabled' : ''}>‹ Prev</button>
      <span class="hint">${start + 1}–${Math.min(start + DIST_PER_PAGE, dist.length)} of ${dist.length}</span>
      <button class="btn btn-sm btn-ghost dist-next" ${distPage === pages ? 'disabled' : ''}>Next ›</button>
    </div>` : '';
  el.innerHTML = rowsHtml + pager;
  el.querySelectorAll('.dist-row').forEach((b) =>
    b.addEventListener('click', () => showCompleters(Number(b.dataset.count))));
  const prev = el.querySelector('.dist-prev'), next = el.querySelector('.dist-next');
  if (prev) prev.addEventListener('click', () => { distPage--; renderCompletionDist(d); });
  if (next) next.addEventListener('click', () => { distPage++; renderCompletionDist(d); });
}

async function showCompleters(count) {
  const cid = practiceCid();
  if (!cid) return;
  $('#drawerContent').innerHTML = '<p class="hint">Loading…</p>';
  openDrawer();
  let d;
  try {
    d = await api(`/colleges/${cid}/practice-completers?count=${count}`);
  } catch (e) {
    $('#drawerContent').innerHTML = '<p class="empty">Could not load that list.</p>';
    return;
  }
  const list = d.students || [];
  const head = `<h2 style="margin-top:0">${list.length} student${list.length === 1 ? '' : 's'} solved exactly ${count} question${count === 1 ? '' : 's'}</h2>`;
  const body = list.length
    ? `<table class="mini-table"><thead><tr><th>Name</th><th>Username</th><th>Reg no</th><th>Section</th><th>Dept</th></tr></thead><tbody>${
        list.map((s) => `<tr data-id="${s.id}" style="cursor:pointer">
          <td>${esc(s.name || '')}</td><td>@${esc(s.username || '')}</td>
          <td>${esc(s.register_number || '—')}</td><td>${esc(s.section || '—')}</td><td>${esc(s.department || '—')}</td>
        </tr>`).join('')
      }</tbody></table>`
    : '<p class="empty">No students in this bucket.</p>';
  $('#drawerContent').innerHTML = head + body;
  $('#drawerContent').querySelectorAll('tr[data-id]').forEach((tr) =>
    tr.addEventListener('click', () => openStudent(tr.dataset.id)));
}

// ---- Reorder domains / topics (drag & drop) --------------------------------
let sortInstances = [];
function openReorderPanel() {
  const d = state.lastPractice;
  const fill = (sel, names) => {
    $(sel).innerHTML = (names && names.length)
      ? names.map((n) => `<div class="sort-item" data-name="${esc(n)}">⠿ ${esc(n)}</div>`).join('')
      : '<div class="hint">None yet</div>';
  };
  fill('#domainOrderList', d && d.domains);
  fill('#topicOrderList', d && d.topics);
  sortInstances.forEach((s) => s.destroy());
  sortInstances = [];
  if (window.Sortable) {
    sortInstances.push(Sortable.create($('#domainOrderList'), { animation: 150, ghostClass: 'sortable-ghost', onEnd: () => saveOrder('domain', '#domainOrderList') }));
    sortInstances.push(Sortable.create($('#topicOrderList'), { animation: 150, ghostClass: 'sortable-ghost', onEnd: () => saveOrder('topic', '#topicOrderList') }));
  }
}
async function saveOrder(kind, sel) {
  const names = [...$(sel).querySelectorAll('.sort-item')].map((el) => el.dataset.name);
  if (!names.length) return;
  try {
    await api(`/colleges/${practiceCid()}/practice-order`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, names }),
    });
    loadPractice(); // refresh tabs/table in the new order
  } catch (e) { alert(e.message); }
}
$('#reorderToggle').addEventListener('click', () => {
  const p = $('#reorderPanel');
  const show = p.style.display === 'none';
  p.style.display = show ? 'block' : 'none';
  if (show) openReorderPanel();
});

// ---- Custom domain/topic dropdown (stays open until you pick or click away) -
const comboPop = document.createElement('div');
comboPop.className = 'combo-pop';
comboPop.style.display = 'none';
document.body.appendChild(comboPop);
let comboInput = null;

function renderCombo(options, filter) {
  const f = (filter || '').toLowerCase();
  // Coerce to string — some values (e.g. year "2027") may come through as numbers,
  // and number.toLowerCase() would throw and break the dropdown.
  const opts = (options || []).map((o) => String(o)).filter((o) => o.toLowerCase().includes(f));
  comboPop.innerHTML = opts.length
    ? opts.map((o) => `<div class="combo-item">${esc(o)}</div>`).join('')
    : '<div class="combo-empty">No matches — type to add a new one</div>';
}
function openCombo(input, options) {
  comboInput = input;
  const r = input.getBoundingClientRect();
  comboPop.style.left = r.left + 'px';
  comboPop.style.top = (r.bottom + 3) + 'px';
  comboPop.style.minWidth = r.width + 'px';
  renderCombo(options, input.value);
  comboPop.style.display = 'block';
}
function closeCombo() { comboPop.style.display = 'none'; comboInput = null; }

comboPop.addEventListener('mousedown', (e) => {
  const it = e.target.closest('.combo-item');
  if (it && comboInput) {
    e.preventDefault(); // stop the input from blurring/closing first
    comboInput.value = it.textContent;
    comboInput.dispatchEvent(new Event('input', { bubbles: true }));
    closeCombo();
  }
});
document.addEventListener('click', (e) => {
  if (comboInput && e.target !== comboInput && !comboPop.contains(e.target)) closeCombo();
});
window.addEventListener('resize', closeCombo);

function attachCombo(sel, getOptions) {
  const input = $(sel);
  if (!input) return;
  input.removeAttribute('list'); // replace native datalist with our dropdown
  const open = () => openCombo(input, getOptions());
  input.addEventListener('focus', open);
  input.addEventListener('click', open);
  input.addEventListener('input', () => { if (comboInput === input) renderCombo(getOptions(), input.value); });
}
const domainOpts = () => (state.lastPractice && state.lastPractice.domains) || [];
// Topics under the currently-selected domain only (all topics if no domain chosen).
function topicsForDomain(domainVal) {
  const d = (domainVal || '').trim();
  const allTopics = (state.lastPractice && state.lastPractice.topics) || [];
  if (!d) return allTopics;
  const probs = (state.lastPractice && state.lastPractice.problems) || [];
  const under = new Set();
  for (const p of probs) {
    if (((p.domain && p.domain.trim()) || '') === d && p.topic && p.topic.trim()) under.add(p.topic.trim());
  }
  return allTopics.filter((t) => under.has(t));
}
attachCombo('#singleDomain', domainOpts);
attachCombo('#singleTopic', () => topicsForDomain($('#singleDomain').value));
attachCombo('#practiceDomain', domainOpts);
attachCombo('#practiceTopic', () => topicsForDomain($('#practiceDomain').value));

// Single-student form: dept/section/year/campus dropdowns from the selected
// college's existing values (you can still type a new value).
state.ssOptions = { departments: [], batches: [], campuses: [], years: [] };
function ssCollegeId() {
  const name = $('#singleStudentCollege')?.value;
  const c = Object.values(state.collegesById || {}).find((x) => x.name === name);
  return c ? c.id : null;
}
async function loadSSOptions() {
  const id = ssCollegeId();
  if (!id) { state.ssOptions = { departments: [], batches: [], campuses: [], years: [] }; return; }
  try { state.ssOptions = await api(`/colleges/${id}/options`); } catch {}
}
attachCombo('#ssDept', () => state.ssOptions.departments || []);
attachCombo('#ssSection', () => state.ssOptions.batches || []);
attachCombo('#ssYear', () => state.ssOptions.years || []);
attachCombo('#ssCampus', () => state.ssOptions.campuses || []);
$('#singleStudentCollege')?.addEventListener('change', loadSSOptions);

// Add a single question (own link + topic + difficulty).
// Per-college "show video links to students" toggle.
function setVideoToggleLabel() {
  const b = $('#videoToggle');
  if (!b) return;
  b.textContent = state.showVideo ? '🎬 Videos: shown to students' : '🎬 Videos: hidden from students';
  b.classList.toggle('btn-primary', state.showVideo);
  b.classList.toggle('btn-ghost', !state.showVideo);
}
$('#videoToggle').addEventListener('click', async () => {
  const cid = practiceCid();
  if (!cid) return;
  const next = !state.showVideo;
  try {
    await api(`/colleges/${cid}/video-visibility`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ show: next }),
    });
    state.showVideo = next;
    setVideoToggleLabel();
  } catch (e) { /* ignore; label stays */ }
});

// Generate/show the public questions-only link (reuses the college's share token).
$('#questionsLinkBtn').addEventListener('click', async () => {
  const cid = practiceCid();
  const out = $('#questionsLinkOut');
  if (!cid) { out.innerHTML = '<span class="msg err">Pick a college first.</span>'; return; }
  try {
    const r = await api(`/colleges/${cid}/view-link`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    const url = location.origin + '/q/' + r.token;
    out.innerHTML = `<input class="search" style="flex:1;min-width:220px" readonly value="${esc(url)}" />
      <button class="btn btn-sm btn-ghost" id="qCopy">Copy</button>
      <a class="btn btn-sm btn-ghost" href="${esc(url)}" target="_blank">Open ↗</a>`;
    $('#qCopy').addEventListener('click', () => { navigator.clipboard?.writeText(url); $('#qCopy').textContent = 'Copied'; });
  } catch (e) { out.innerHTML = `<span class="msg err">${esc(e.message)}</span>`; }
});

$('#addSingleBtn').addEventListener('click', async () => {
  const link = $('#singleLink').value.trim();
  const domain = $('#singleDomain').value.trim();
  const topic = $('#singleTopic').value.trim();
  const difficulty = $('#singleDifficulty').value;
  const video = $('#singleVideo').value.trim();
  const dueDate = $('#singleDue').value;
  if (!practiceCid()) return setMsg('#singleMsg', 'Pick a college first.', 'err');
  if (!link) return setMsg('#singleMsg', 'Enter a LeetCode link or slug.', 'err');
  try {
    const r = await api(`/colleges/${practiceCid()}/practice`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ links: link, topic, domain, difficulty, video, dueDate }),
    });
    if (r.added) {
      setMsg('#singleMsg', `Added.`, 'ok', 5000);
      $('#singleLink').value = ''; $('#singleVideo').value = ''; // keep topic + difficulty for the next one
    } else {
      setMsg('#singleMsg', 'That link could not be parsed.', 'err');
    }
    loadPractice();
  } catch (e) { setMsg('#singleMsg', e.message, 'err'); }
});

$('#addPracticeBtn').addEventListener('click', async () => {
  const links = $('#practiceLinks').value;
  const videos = $('#practiceVideos').value;
  const domain = $('#practiceDomain').value.trim();
  const topic = $('#practiceTopic').value.trim();
  const difficulty = $('#practiceDifficulty').value;
  const dueDate = $('#practiceDue').value;
  if (!practiceCid()) return setMsg('#practiceMsg', 'Pick a college first.', 'err');
  if (!links.trim()) return setMsg('#practiceMsg', 'Paste at least one link.', 'err');
  try {
    const r = await api(`/colleges/${practiceCid()}/practice`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ links, videos, topic, domain, difficulty, dueDate }),
    });
    setMsg('#practiceMsg', `Added ${r.added} problem(s)${topic ? ' under “' + topic + '”' : ''}.` + (r.skipped.length ? ` Skipped ${r.skipped.length}.` : ''), 'ok', 5000);
    $('#practiceLinks').value = ''; $('#practiceVideos').value = '';
    loadPractice();
  } catch (e) { setMsg('#practiceMsg', e.message, 'err'); }
});

$('#practiceFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !practiceCid()) return;
  const fd = new FormData();
  fd.append('file', file);
  const topic = $('#practiceTopic').value.trim();
  const domain = $('#practiceDomain').value.trim();
  const difficulty = $('#practiceDifficulty').value;
  if (topic) fd.append('topic', topic); // fallbacks for rows missing these columns
  if (domain) fd.append('domain', domain);
  if (difficulty) fd.append('difficulty', difficulty);
  try {
    const r = await api(`/colleges/${practiceCid()}/practice`, { method: 'POST', body: fd });
    setMsg('#practiceMsg', `Added ${r.added} problem(s) from file.`, 'ok', 5000);
    loadPractice();
  } catch (err) { setMsg('#practiceMsg', err.message, 'err'); }
  e.target.value = '';
});

// ---- Upload tab -------------------------------------------------------------
$('#uploadBtn').addEventListener('click', async () => {
  const college = $('#uploadCollege').value.trim();
  const file = $('#rosterFile').files[0];
  if (!college) return setMsg('#uploadResult', 'Enter a college name.', 'err');
  if (!file) return setMsg('#uploadResult', 'Choose an Excel file.', 'err');
  const fd = new FormData(); fd.append('college', college); fd.append('file', file);
  setMsg('#uploadResult', 'Uploading…', '');
  try {
    const r = await api('/upload', { method: 'POST', body: fd });
    let msg = `Added/updated ${r.added} of ${r.total} students for "${r.college.name}".`;
    if (r.skipped.length) msg += `\nSkipped ${r.skipped.length} row(s): ` + r.skipped.map((s) => `row ${s.row} (${s.reason})`).join(', ');
    msg += `\nStarting LeetCode sync in the background…`;
    setMsg('#uploadResult', msg, 'ok');
    state.collegeId = r.college.id;
    resetDash();
    await api(`/colleges/${r.college.id}/sync`, { method: 'POST' });
    pollSync();
    await loadColleges();
  } catch (e) { setMsg('#uploadResult', e.message, 'err'); }
});

// Add a single student individually.
$('#addStudentBtn').addEventListener('click', async () => {
  const college = $('#singleStudentCollege').value.trim();
  const name = $('#ssName').value.trim();
  const url = $('#ssUrl').value.trim();
  if (!college) return setMsg('#addStudentMsg', 'Pick a college.', 'err');
  if (!name) return setMsg('#addStudentMsg', 'Enter the student name.', 'err');
  if (!url) return setMsg('#addStudentMsg', 'Enter the LeetCode profile.', 'err');
  const body = {
    college, name, url,
    register_number: $('#ssReg').value.trim(),
    email: $('#ssEmail').value.trim(),
    department: $('#ssDept').value.trim(),
    section: $('#ssSection').value.trim(),
    year: $('#ssYear').value.trim(),
    campus: $('#ssCampus').value.trim(),
  };
  setMsg('#addStudentMsg', 'Adding…', '');
  try {
    const r = await api('/students', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    setMsg('#addStudentMsg', `Added @${r.username}. Syncing…`, 'ok', 5000);
    // clear the per-student fields, keep college for the next add
    ['#ssName', '#ssUrl', '#ssReg', '#ssEmail'].forEach((s) => { $(s).value = ''; });
    if (r.id) { try { await api(`/students/${r.id}/sync`, { method: 'POST' }); } catch {} }
    await loadColleges();
  } catch (e) { setMsg('#addStudentMsg', e.message, 'err'); }
});

// ---- Sync button + polling --------------------------------------------------
$('#syncCollegeBtn').addEventListener('click', async () => {
  if (!state.collegeId) return;
  await api(`/colleges/${state.collegeId}/sync`, { method: 'POST' });
  pollSync();
});

let pollTimer = null;
function pollSync() {
  clearInterval(pollTimer);
  $('#syncStatus').textContent = 'syncing…';
  pollTimer = setInterval(async () => {
    const st = await api('/sync/state');
    if (st.running) {
      $('#syncStatus').textContent = 'syncing…';
    } else {
      clearInterval(pollTimer);
      $('#syncStatus').textContent = st.lastRun
        ? `synced ${st.lastRun.ok}/${st.lastRun.students}` + (st.lastRun.newCompletions ? `, +${st.lastRun.newCompletions} completions` : '')
        : '';
      loadColleges();
      if ($('#tab-practice').classList.contains('active')) loadPractice();
    }
  }, 2500);
}

// ---- helpers ----------------------------------------------------------------
function setMsg(sel, text, cls, autoMs) {
  const el = $(sel);
  el.textContent = text;
  el.className = 'msg ' + (cls || '');
  if (el._clearTimer) clearTimeout(el._clearTimer);
  if (autoMs) el._clearTimer = setTimeout(() => { el.textContent = ''; el.className = 'msg'; }, autoMs);
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---- Inline YouTube player -------------------------------------------------
function ytEmbed(url) {
  if (!url) return null;
  let id = null;
  try {
    const u = new URL(url, location.href);
    if (u.hostname.includes('youtu.be')) id = u.pathname.slice(1);
    else if (u.searchParams.get('v')) id = u.searchParams.get('v');
    else if (u.pathname.includes('/embed/')) id = u.pathname.split('/embed/')[1];
    else if (u.pathname.includes('/shorts/')) id = u.pathname.split('/shorts/')[1];
  } catch {}
  if (!id) return null;
  id = id.split(/[/?&]/)[0];
  return 'https://www.youtube.com/embed/' + encodeURIComponent(id) + '?autoplay=1&rel=0';
}
function openVideoModal(url) {
  const embed = ytEmbed(url);
  if (!embed) { window.open(url, '_blank', 'noopener'); return; }
  let m = document.getElementById('videoModal');
  if (!m) {
    m = document.createElement('div');
    m.id = 'videoModal'; m.className = 'video-modal';
    m.innerHTML = '<div class="video-modal-inner"><button class="video-modal-close" aria-label="Close">✕</button><div class="video-frame"></div></div>';
    document.body.appendChild(m);
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('.video-modal-close')) closeVideoModal(); });
  }
  m.querySelector('.video-frame').innerHTML = `<iframe src="${embed}" allow="autoplay; encrypted-media; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;
  m.classList.add('open');
}
function closeVideoModal() {
  const m = document.getElementById('videoModal');
  if (m) { m.querySelector('.video-frame').innerHTML = ''; m.classList.remove('open'); }
}
document.addEventListener('click', (e) => {
  const v = e.target.closest('[data-video]');
  if (v) { e.preventDefault(); openVideoModal(v.getAttribute('data-video')); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeVideoModal(); });

// Progress since first tracked. `gain` for solved counts (up is good),
// `rankDelta` for global rank (a smaller number is better).
function gain(current, baseline) {
  if (baseline == null || current == null) return '';
  const d = current - baseline;
  if (d > 0) return ` <span class="delta" title="since first tracked">+${d}</span>`;
  if (d < 0) return ` <span class="delta down">${d}</span>`;
  return '';
}
function rankDelta(s) {
  if (s.baseline_ranking == null || s.ranking == null) return '';
  const d = s.baseline_ranking - s.ranking; // positive => rank improved
  if (d > 0) return ` <span class="delta" title="rank improved since first tracked">▲${Math.abs(d).toLocaleString()}</span>`;
  if (d < 0) return ` <span class="delta down" title="rank dropped">▼${Math.abs(d).toLocaleString()}</span>`;
  return '';
}

// "Started at … → now" comparison shown in the student drawer.
function progressBlock(s) {
  if (s.baseline_at == null) return '';
  const row = (label, base, cur, isRank) => {
    let delta = '';
    if (base != null && cur != null) {
      if (isRank) delta = rankDelta({ baseline_ranking: base, ranking: cur });
      else delta = gain(cur, base);
    }
    const fmt = (v) => v == null ? '—' : (isRank ? '#' + Number(v).toLocaleString() : v);
    return `<tr><td>${label}</td><td>${fmt(base)}</td><td>${fmt(cur)}</td><td>${delta || '—'}</td></tr>`;
  };
  return `<h2 style="margin-top:18px">Progress since first tracked <span class="hint">(${fmtAgo(s.baseline_at)})</span>
      <button class="btn btn-sm btn-ghost reset-baseline" data-id="${s.id}" title="Re-anchor progress to current stats" style="float:right">Reset baseline</button></h2>
    <table><thead><tr><th>Metric</th><th>Started</th><th>Now</th><th>Change</th></tr></thead><tbody>
      ${row('Global rank', s.baseline_ranking, s.ranking, true)}
      ${row('Easy', s.baseline_easy, s.solved_easy)}
      ${row('Medium', s.baseline_medium, s.solved_medium)}
      ${row('Hard', s.baseline_hard, s.solved_hard)}
      ${row('Total', s.baseline_total, s.solved_total)}
    </tbody></table>`;
}
function fmtAgo(iso) {
  if (!iso) return 'never';
  const t = new Date(iso.replace(' ', 'T') + 'Z').getTime();
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

// ---- Admin login gate -------------------------------------------------------
function showAdminLogin() {
  try { localStorage.removeItem('lc_admin_token'); } catch {}
  $('#adminLogin').classList.add('show');
  $('#adminLogout').style.display = 'none';
  setTimeout(() => $('#adminUser').focus(), 50);
}
async function adminLogin() {
  const username = $('#adminUser').value.trim();
  const password = $('#adminPass').value;
  if (!username || !password) return setMsg('#adminLoginMsg', 'Enter your username and password.', 'err');
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'Login failed');
    if (d.token) { try { localStorage.setItem('lc_admin_token', d.token); } catch {} }
    $('#adminLogin').classList.remove('show');
    $('#adminPass').value = '';
    $('#adminUser').value = '';
    $('#adminLogout').style.display = 'inline-block';
    loadColleges();
  } catch (e) { setMsg('#adminLoginMsg', e.message, 'err'); }
}
$('#adminLoginBtn').addEventListener('click', adminLogin);
$('#adminUser').addEventListener('keydown', (e) => { if (e.key === 'Enter') adminLogin(); });
$('#adminPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') adminLogin(); });
$('#adminLogout').addEventListener('click', async () => {
  try { await fetch('/api/admin/logout', { method: 'POST', headers: { 'x-admin-token': adminToken() } }); } catch {}
  showAdminLogin();
});

(async function boot() {
  let authRequired = false;
  try { authRequired = (await fetch('/api/admin/status').then((r) => r.json())).authRequired; } catch {}
  // Show which DB is actually live (Supabase vs local SQLite).
  try {
    const m = await fetch('/api/meta').then((r) => r.json());
    const el = $('#dbDriver');
    if (el) { el.textContent = 'DB: ' + m.driver; el.classList.add(m.driverKey === 'supabase' ? 'ok' : 'warn'); }
  } catch {}
  if (authRequired && !adminToken()) { showAdminLogin(); return; }
  if (authRequired) $('#adminLogout').style.display = 'inline-block';
  loadColleges();
})();

// ---- Per-college auto-refresh gating ---------------------------------------
// The browser auto-refresh follows the *selected college's* refresh setting
// (configured in the Colleges tab, evaluated against the browser's local time).
function windowActiveNow(from, to) {
  if (!from || !to) return true;
  const cur = new Date().toTimeString().slice(0, 5);
  return from <= to ? (cur >= from && cur < to) : (cur >= from || cur < to);
}
function refreshActiveFor(collegeId) {
  const c = state.collegesById && state.collegesById[collegeId];
  if (!c) return true; // unknown -> default to refreshing
  const mode = c.refresh_mode || 'on';
  if (mode === 'off') return false;
  if (mode === 'scheduled') return windowActiveNow(c.refresh_from, c.refresh_to);
  return true;
}

// Auto-refresh the admin view every 2s so scheduler/extension updates show up
// without a manual reload. This only re-reads the database (no LeetCode calls).
setInterval(() => {
  if (document.hidden) return;                              // tab not visible
  if ($('#adminLogin').classList.contains('show')) return;  // not logged in
  if ($('#drawer').classList.contains('open')) return;      // don't disrupt an open student drawer
  const active = document.querySelector('.tab.active')?.dataset.tab;
  if (active === 'dashboard') { if (refreshActiveFor(state.collegeId)) loadDashboard({ chart: false }); }
  else if (active === 'practice') { if (refreshActiveFor(practiceCid())) loadPractice(); }
}, 2000);

// Refresh the monthly chart on a slower cadence (it's cached server-side, and
// the data only changes on sync). Keeps it accurate without blocking anything.
setInterval(() => {
  if (document.hidden) return;
  if ($('#adminLogin').classList.contains('show')) return;
  if (document.querySelector('.tab.active')?.dataset.tab !== 'dashboard') return;
  if (!refreshActiveFor(state.collegeId)) return;
  loadMonthly();
}, 20000);
