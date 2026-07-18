const $ = (s) => document.querySelector(s);
const token = decodeURIComponent(location.pathname.split('/view/')[1] || '').replace(/\/+$/, '');

let chart = null, drawerChart = null, lastMonthlySig = null, filtersLoaded = false;
let lastData = null, viewPracticeDomain = '__all';
const collapsedDomains = new Set(); // folded domains in the practice list
const collapsedTopics = new Set(); // folded topics (keyed by domain|topic)
const dash = { batch: '', department: '', campus: '', q: '', risk: false, page: 1, pageSize: 100, total: 0 };

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
window.__onTheme = () => { lcChartTheme(); recolorChart(chart); recolorChart(drawerChart); };

const api = (path) => fetch('/api' + path).then(async (r) => {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
});
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

// progress helpers (same logic as admin)
function gain(cur, base) {
  if (base == null || cur == null) return '';
  const d = cur - base;
  if (d > 0) return ` <span class="delta">+${d}</span>`;
  if (d < 0) return ` <span class="delta down">${d}</span>`;
  return '';
}
function rankDelta(s) {
  if (s.baseline_ranking == null || s.ranking == null) return '';
  const d = s.baseline_ranking - s.ranking;
  if (d > 0) return ` <span class="delta">▲${Math.abs(d).toLocaleString()}</span>`;
  if (d < 0) return ` <span class="delta down">▼${Math.abs(d).toLocaleString()}</span>`;
  return '';
}

async function load(opts = {}) {
  let d;
  try {
    const params = {
      batch: dash.batch, department: dash.department, campus: dash.campus, q: dash.q,
      risk: dash.risk ? '1' : '',
      page: String(dash.page), pageSize: String(dash.pageSize),
    };
    if (opts.chart === false) params.light = '1'; // auto-refresh: skip monthly/filter queries
    const qs = new URLSearchParams(params);
    d = await api(`/view/${encodeURIComponent(token)}?${qs}`);
  } catch (e) {
    $('#content').style.display = 'none';
    const err = $('#error');
    err.style.display = 'block';
    err.innerHTML = `<h2 style="margin:0 0 6px">Link not available</h2><p class="hint" style="margin:0">${esc(e.message)}</p>`;
    return;
  }
  render(d, opts);
}

function render(d, opts) {
  lastData = d;
  document.title = `${d.college.name} — Progress`;
  $('#collegeName').textContent = d.college.name;
  $('#error').style.display = 'none';
  $('#content').style.display = 'block';
  dash.total = d.total;

  const filtered = dash.batch || dash.department || dash.campus || dash.q;
  $('#cards').innerHTML = `
    <div class="card"><div class="v">${d.totals.students}</div><div class="l">${filtered ? 'Students (filtered)' : 'Students'}</div></div>
    <div class="card"><div class="v">${d.totals.total}</div><div class="l">Total solved</div></div>
    <div class="card easy"><div class="v">${d.totals.easy}</div><div class="l">Easy</div></div>
    <div class="card medium"><div class="v">${d.totals.medium}</div><div class="l">Medium</div></div>
    <div class="card hard"><div class="v">${d.totals.hard}</div><div class="l">Hard</div></div>
    <div class="card"><div class="v">${d.practiceTotal}</div><div class="l">Practice problems</div></div>`;

  const sig = JSON.stringify(d.monthly);
  if (opts.chart !== false && sig !== lastMonthlySig) {
    if (chart) chart.destroy();
    chart = new Chart($('#monthly'), {
      type: 'bar',
      data: { labels: d.monthly.map((m) => m.ym), datasets: [{ data: d.monthly.map((m) => m.submissions), backgroundColor: '#ffa116' }] },
      options: { plugins: { legend: { display: false } }, scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true } } },
    });
    lastMonthlySig = sig;
  }

  if (!filtersLoaded && d.filters) { populateFilters(d.filters); filtersLoaded = true; }
  renderStudents(d.students);
  renderPager();
  renderPractice(d);
}

function fillSel(sel, allLabel, opts, cur) {
  const el = $(sel);
  el.innerHTML = `<option value="">${allLabel}</option>` + opts.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  el.value = opts.includes(cur) ? cur : '';
}
function populateFilters(f) {
  if (!f.campuses.includes(dash.campus)) dash.campus = '';
  if (!f.departments.includes(dash.department)) dash.department = '';
  if (!f.batches.includes(dash.batch)) dash.batch = '';
  fillSel('#filterCampus', 'All campuses', f.campuses, dash.campus);
  fillSel('#filterDept', 'All departments', f.departments, dash.department);
  fillSel('#filterBatch', 'All batches', f.batches, dash.batch);
}
function renderPager() {
  const { page, pageSize, total } = dash;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  $('#pageInfo').textContent = `${total === 0 ? 0 : (page - 1) * pageSize + 1}–${Math.min(total, page * pageSize)} of ${total}`;
  $('#prevPage').disabled = page <= 1;
  $('#nextPage').disabled = page >= pages;
}

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
  const sig = JSON.stringify(students.map((s) => [s.id, s.classRank, s.name, s.username, s.section,
    s.department, s.found, s.ranking, s.baseline_ranking, s.solved_easy, s.solved_medium, s.solved_hard,
    s.solved_total, s.baseline_total, s.practiceCompleted, s.practiceTotal, s.at_risk]));
  if (sig === renderStudents._sig) return; // skip rebuild when unchanged
  renderStudents._sig = sig;
  const tbody = $('#studentTable').querySelector('tbody');
  if (!students.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No students match.</td></tr>';
    return;
  }
  tbody.innerHTML = students.map((s) => `
    <tr data-id="${s.id}" style="cursor:pointer">
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
    </tr>`).join('');
  tbody.querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openStudent(tr.dataset.id)));
}

function renderPractice(d) {
  const sig = JSON.stringify([d.studentCount, d.domainOrder, d.topicOrder, viewPracticeDomain,
    [...collapsedDomains], [...collapsedTopics], d.practice.map((p) => [p.id, p.title, p.difficulty, p.topic, p.domain, p.completedCount, p.video_url, p.due_date])]);
  if (sig === renderPractice._sig) return; // skip rebuild when unchanged
  renderPractice._sig = sig;
  renderViewDist(d);
  const tbody = $('#practiceTable').querySelector('tbody');
  const tabsEl = $('#practiceDomainTabs');
  if (!d.practice.length) {
    tabsEl.innerHTML = '';
    tbody.innerHTML = '<tr><td colspan="4" class="empty">No practice problems assigned.</td></tr>';
    return;
  }
  const dom = (p) => (p.domain && p.domain.trim()) || 'Uncategorized';
  const top = (p) => (p.topic && p.topic.trim()) || 'Uncategorized';
  const mkCmp = (arr) => {
    const idx = new Map((arr || []).map((n, i) => [n, i]));
    return (a, b) => {
      if (a === 'Uncategorized') return 1;
      if (b === 'Uncategorized') return -1;
      const ia = idx.has(a) ? idx.get(a) : 1e9, ib = idx.has(b) ? idx.get(b) : 1e9;
      return ia - ib || a.localeCompare(b);
    };
  };
  const domCmp = mkCmp(d.domainOrder), topCmp = mkCmp(d.topicOrder);
  const row = (p) => {
    const pct = d.studentCount ? Math.round((p.completedCount / d.studentCount) * 100) : 0;
    return `<tr>
      <td><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>${p.video_url ? ` <button class="vid-link" data-video="${esc(p.video_url)}" title="YouTube video">▶ video</button>` : ''}${p.due_date ? ` <span class="due-pill${p.due_date < new Date().toISOString().slice(0,10) ? ' overdue' : ''}">⏰ ${esc(p.due_date)}</span>` : ''}</td>
      <td>${p.difficulty ? `<span class="pill ${(p.difficulty || '').toLowerCase()}">${esc(p.difficulty)}</span>` : '—'}</td>
      <td class="prog-cell" data-pid="${p.id}" data-title="${esc(p.title)}" style="cursor:pointer" title="Click to see who completed / didn't">${p.completedCount}/${d.studentCount}</td>
      <td class="prog-cell" data-pid="${p.id}" data-title="${esc(p.title)}" style="cursor:pointer" title="Click to see who completed / didn't"><span class="progress"><span style="width:${pct}%"></span></span> ${pct}%</td></tr>`;
  };
  const topicRows = (probs) => {
    const groups = {};
    for (const p of probs) (groups[top(p)] ||= []).push(p);
    return Object.keys(groups).sort(topCmp).map((t) => {
      const g = groups[t];
      const key = dom(g[0]) + '|' + t;
      const collapsed = collapsedTopics.has(key);
      const head = `<tr class="topic-foldrow" data-topic="${esc(key)}"><td colspan="4" style="background:var(--panel-2);font-weight:600;padding-left:18px;cursor:pointer">${collapsed ? '▸' : '▾'} ${esc(t)} <span style="color:var(--muted);font-weight:400">· ${g.length}</span></td></tr>`;
      return head + (collapsed ? '' : g.map(row).join(''));
    }).join('');
  };
  const wireTopicFold = () => tbody.querySelectorAll('.topic-foldrow').forEach((r) => r.addEventListener('click', () => {
    const k = r.dataset.topic;
    collapsedTopics.has(k) ? collapsedTopics.delete(k) : collapsedTopics.add(k);
    if (lastData) renderPractice(lastData);
  }));
  const wireProgCells = () => tbody.querySelectorAll('.prog-cell').forEach((c) => c.addEventListener('click', () =>
    showProblemCompletion(Number(c.dataset.pid), c.dataset.title)));
  const domGroups = {};
  for (const p of d.practice) (domGroups[dom(p)] ||= []).push(p);
  const domNames = Object.keys(domGroups).sort(domCmp);

  // No domains assigned -> plain topic grouping, no tabs.
  if (domNames.length === 1 && domNames[0] === 'Uncategorized') {
    tabsEl.innerHTML = '';
    tbody.innerHTML = topicRows(d.practice);
    wireTopicFold();
    wireProgCells();
    return;
  }

  // Domain tabs (All + one per domain).
  if (viewPracticeDomain !== '__all' && !domNames.includes(viewPracticeDomain)) viewPracticeDomain = '__all';
  const sel = viewPracticeDomain;
  tabsEl.innerHTML =
    `<button class="dom-tab ${sel === '__all' ? 'active' : ''}" data-dom="__all">All</button>` +
    domNames.map((dn) => `<button class="dom-tab ${sel === dn ? 'active' : ''}" data-dom="${esc(dn)}">${esc(dn)}</button>`).join('');
  tabsEl.querySelectorAll('.dom-tab').forEach((b) => b.addEventListener('click', () => {
    viewPracticeDomain = b.dataset.dom;
    if (lastData) renderPractice(lastData);
  }));

  tbody.innerHTML = sel === '__all'
    ? domNames.map((dn) => {
        const collapsed = collapsedDomains.has(dn);
        const head = `<tr class="dom-foldrow" data-dom="${esc(dn)}"><td colspan="4" style="background:var(--accent);color:#1a1300;font-weight:700;cursor:pointer">${collapsed ? '▸' : '▾'} ${esc(dn)} <span style="font-weight:400">· ${domGroups[dn].length}</span></td></tr>`;
        return head + (collapsed ? '' : topicRows(domGroups[dn]));
      }).join('')
    : topicRows(domGroups[sel]);

  tbody.querySelectorAll('.dom-foldrow').forEach((r) => r.addEventListener('click', () => {
    const dn = r.dataset.dom;
    collapsedDomains.has(dn) ? collapsedDomains.delete(dn) : collapsedDomains.add(dn);
    if (lastData) renderPractice(lastData);
  }));
  wireTopicFold();
  wireProgCells();
}

// Who completed / didn't complete one problem (read-only drawer).
async function showProblemCompletion(problemId, title) {
  $('#drawerContent').innerHTML = '<p class="hint">Loading…</p>';
  $('#drawer').classList.add('open');
  $('#drawerBackdrop').classList.add('show');
  let d;
  try { d = await api(`/view/${encodeURIComponent(token)}/practice/${problemId}/completion`); }
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

// ---- read-only student drawer ----------------------------------------------
async function openStudent(id) {
  let d;
  try { d = await api(`/view/${encodeURIComponent(token)}/student/${id}`); }
  catch (e) { return; }
  const s = d.student;
  const growth = d.monthlySolvedGrowth;
  $('#drawerContent').innerHTML = `
    <h2 style="margin-top:0">${esc(s.name)}</h2>
    <p class="hint"><a href="${esc(s.profile_url || '#')}" target="_blank">@${esc(s.username)}</a>
      ${s.found ? '' : '· <span class="cross">profile not found / private</span>'}</p>
    ${(s.register_number || s.section || s.department || s.campus || s.year) ? `<p class="hint" style="line-height:1.7">
      ${s.register_number ? `Reg: <b>${esc(s.register_number)}</b> · ` : ''}${s.section ? `Batch: <b>${esc(s.section)}</b> · ` : ''}${s.department ? `${esc(s.department)} · ` : ''}${s.campus ? esc(s.campus) : ''}${s.year ? ` · ${esc(s.year)}` : ''}</p>` : ''}
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
      <tbody>${growth.map((g) => `<tr><td>${g.ym}</td><td>${g.easy}</td><td>${g.medium}</td><td>${g.hard}</td><td><b>${g.total}</b></td></tr>`).join('')}</tbody></table>` : ''}
    <h2 style="margin-top:18px">Practice problems</h2>
    <table><thead><tr><th>Problem</th><th>Status</th></tr></thead><tbody>
      ${d.practice.length ? d.practice.map((p) => `<tr><td><a href="${esc(p.url)}" target="_blank">${esc(p.title)}</a></td>
        <td>${p.completed ? '<span class="check">✓ solved</span>' : '<span class="cross">pending</span>'}</td></tr>`).join('')
        : '<tr><td colspan="2" class="empty">No problems assigned.</td></tr>'}
    </tbody></table>`;

  $('#drawer').classList.add('open');
  $('#drawerBackdrop').classList.add('show');
  const m = d.monthlyActivity;
  if (drawerChart) drawerChart.destroy();
  drawerChart = new Chart($('#drawerMonthly'), {
    type: 'line',
    data: { labels: m.map((x) => x.ym), datasets: [{ data: m.map((x) => x.submissions), borderColor: '#ffa116', backgroundColor: 'rgba(255,161,22,.15)', fill: true, tension: .3 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
  });
}
function progressBlock(s) {
  if (s.baseline_at == null) return '';
  const r = (label, base, cur, isRank) => {
    let delta = '—';
    if (base != null && cur != null) delta = (isRank ? rankDelta({ baseline_ranking: base, ranking: cur }) : gain(cur, base)) || '—';
    const fmt = (v) => v == null ? '—' : (isRank ? '#' + Number(v).toLocaleString() : v);
    return `<tr><td>${label}</td><td>${fmt(base)}</td><td>${fmt(cur)}</td><td>${delta}</td></tr>`;
  };
  return `<h2 style="margin-top:18px">Progress since first tracked <span class="hint">(${esc(String(s.baseline_at).slice(0, 10))})</span></h2>
    <table><thead><tr><th>Metric</th><th>Started</th><th>Now</th><th>Change</th></tr></thead><tbody>
      ${r('Global rank', s.baseline_ranking, s.ranking, true)}
      ${r('Easy', s.baseline_easy, s.solved_easy)}
      ${r('Medium', s.baseline_medium, s.solved_medium)}
      ${r('Hard', s.baseline_hard, s.solved_hard)}
      ${r('Total', s.baseline_total, s.solved_total)}
    </tbody></table>`;
}
// ---- Completion breakdown (read-only, paginated 10/page) -------------------
let viewDistPage = 1;
const VIEW_DIST_PER_PAGE = 10;
function renderViewDist(d) {
  const el = $('#completionDist');
  if (!el) return;
  const total = (d.practice || []).length;
  if (!d.studentCount) {
    el.innerHTML = '<p class="hint" style="margin:0">No students yet.</p>';
    return;
  }
  // One row per level 0..total so pagination spans every 10 questions.
  const distMap = new Map((d.completionDist || []).map((x) => [x.completed, x.students]));
  const dist = [];
  for (let i = 0; i <= total; i++) dist.push({ completed: i, students: distMap.get(i) || 0 });
  const pages = Math.max(1, Math.ceil(dist.length / VIEW_DIST_PER_PAGE));
  viewDistPage = Math.min(Math.max(1, viewDistPage), pages);
  const start = (viewDistPage - 1) * VIEW_DIST_PER_PAGE;
  const pageRows = dist.slice(start, start + VIEW_DIST_PER_PAGE);
  const maxStudents = Math.max(...dist.map((x) => x.students), 1);
  const rowsHtml = pageRows.map((x) => {
    const pct = Math.round((x.students / maxStudents) * 100);
    const all = total && x.completed === total ? ' <span class="dist-all">all</span>' : '';
    const label = x.completed === 0
      ? 'Solved 0 questions'
      : `Solved ${x.completed} question${x.completed > 1 ? 's' : ''}${all}`;
    const share = Math.round((x.students / d.studentCount) * 100);
    return `<button class="dist-row" data-count="${x.completed}" title="Click to list these students">
      <span class="dist-label">${label}</span>
      <span class="dist-bar"><span style="width:${pct}%"></span></span>
      <span class="dist-num">${x.students} <span class="hint">(${share}%)</span></span>
    </button>`;
  }).join('');
  const pager = pages > 1 ? `<div class="dist-pager">
      <button class="btn btn-sm btn-ghost dist-prev" ${viewDistPage === 1 ? 'disabled' : ''}>‹ Prev</button>
      <span class="hint">${start + 1}–${Math.min(start + VIEW_DIST_PER_PAGE, dist.length)} of ${dist.length}</span>
      <button class="btn btn-sm btn-ghost dist-next" ${viewDistPage === pages ? 'disabled' : ''}>Next ›</button>
    </div>` : '';
  el.innerHTML = rowsHtml + pager;
  el.querySelectorAll('.dist-row').forEach((b) =>
    b.addEventListener('click', () => showViewCompleters(Number(b.dataset.count))));
  const prev = el.querySelector('.dist-prev'), next = el.querySelector('.dist-next');
  if (prev) prev.addEventListener('click', () => { viewDistPage--; renderViewDist(d); });
  if (next) next.addEventListener('click', () => { viewDistPage++; renderViewDist(d); });
}

async function showViewCompleters(count) {
  $('#drawerContent').innerHTML = '<p class="hint">Loading…</p>';
  $('#drawer').classList.add('open');
  $('#drawerBackdrop').classList.add('show');
  let d;
  try {
    d = await api(`/view/${encodeURIComponent(token)}/practice-completers?count=${count}`);
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

function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawerBackdrop').classList.remove('show'); }
$('#drawerClose').addEventListener('click', closeDrawer);
$('#drawerBackdrop').addEventListener('click', closeDrawer);

// ---- filters / pager / search ----------------------------------------------
$('#riskToggle').addEventListener('click', () => {
  dash.risk = !dash.risk;
  dash.page = 1;
  $('#riskToggle').classList.toggle('btn-primary', dash.risk);
  $('#riskToggle').classList.toggle('btn-ghost', !dash.risk);
  renderStudents._sig = null; // force repaint
  load();
});
$('#filterBatch').addEventListener('change', (e) => { dash.batch = e.target.value; dash.page = 1; load(); });
$('#filterDept').addEventListener('change', (e) => { dash.department = e.target.value; dash.page = 1; load(); });
$('#filterCampus').addEventListener('change', (e) => { dash.campus = e.target.value; dash.page = 1; load(); });
$('#prevPage').addEventListener('click', () => { if (dash.page > 1) { dash.page--; load(); } });
$('#nextPage').addEventListener('click', () => {
  const pages = Math.max(1, Math.ceil(dash.total / dash.pageSize));
  if (dash.page < pages) { dash.page++; load(); }
});
let searchTimer = null;
$('#studentSearch').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const v = e.target.value.trim();
  searchTimer = setTimeout(() => { dash.q = v; dash.page = 1; load(); }, 350);
});

// Dashboard / Practice tab switching.
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  $('#tab-' + t.dataset.tab).classList.add('active');
}));

load();
// Read-only shared link auto-refresh — 30s (was 5s) to cut bandwidth/egress.
setInterval(() => {
  if (document.hidden) return;
  if ($('#drawer').classList.contains('open')) return; // don't disrupt an open drawer
  load({ chart: false });
}, 30000);
