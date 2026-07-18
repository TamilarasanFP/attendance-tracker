const $ = (s) => document.querySelector(s);
const api = (path, opts) => fetch('/api' + path, opts).then(async (r) => {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
});

// Session lives only in memory + sessionStorage so a refresh keeps you logged in.
let session = { collegeId: null, code: null, studentId: null, collegeName: '', name: '' };
let myChart = null;
let dashAnimated = false; // entrance + count-up run once per session, not on each refresh
let studentDomain = '__all'; // selected domain tab in the practice list
let lastPractice = []; // cached practice list so domain tab clicks can re-render
let lastDomainOrder = [], lastTopicOrder = []; // cached saved order
const collapsedDomains = new Set(); // folded domains in the practice list
const collapsedTopics = new Set(); // folded topics (keyed by domain|topic)

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
window.__onTheme = () => { lcChartTheme(); recolorChart(myChart); };

function saveSession() { try { sessionStorage.setItem('lc_student', JSON.stringify(session)); } catch {} }
function loadSession() { try { return JSON.parse(sessionStorage.getItem('lc_student') || 'null'); } catch { return null; } }

// ---- Login ------------------------------------------------------------------
async function initLogin() {
  const colleges = await api('/colleges');
  const sel = $('#loginCollege');
  sel.innerHTML = colleges.length
    ? colleges.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')
    : '<option value="">No colleges available yet</option>';
}

$('#loginBtn').addEventListener('click', async () => {
  const collegeId = Number($('#loginCollege').value);
  const code = $('#loginCode').value.trim();
  const email = $('#loginEmail').value.trim();
  if (!collegeId || !code || !email)
    return setMsg('#loginMsg', 'Choose your college and enter the access code and your email.', 'err');
  try {
    const r = await api('/student/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collegeId, code, email }),
    });
    session.collegeId = collegeId;
    session.code = code;
    session.collegeName = r.college.name;
    session.studentId = r.student.id;
    session.name = r.student.name;
    saveSession();
    enterApp();
  } catch (e) { setMsg('#loginMsg', e.message, 'err'); }
});

$('#toggleRegister').addEventListener('click', (e) => {
  e.preventDefault();
  const w = $('#registerWrap');
  const show = w.style.display === 'none';
  w.style.display = show ? 'block' : 'none';
  if (show) loadRegisterOptions();
});

// Populate the Batch / Department dropdowns from the selected college's existing values.
function fillRegSel(sel, opts) {
  const el = $(sel);
  const cur = el.value;
  el.innerHTML = '<option value="">— select —</option>' +
    (opts || []).map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  if ((opts || []).includes(cur)) el.value = cur;
}
async function loadRegisterOptions() {
  const collegeId = Number($('#loginCollege').value);
  if (!collegeId) return;
  try {
    const o = await api(`/colleges/${collegeId}/options`);
    fillRegSel('#regBatch', o.batches);
    fillRegSel('#regDept', o.departments);
  } catch { /* ignore */ }
}
$('#loginCollege').addEventListener('change', () => {
  if ($('#registerWrap').style.display !== 'none') loadRegisterOptions();
});

$('#registerBtn').addEventListener('click', async () => {
  const collegeId = Number($('#loginCollege').value);
  const code = $('#loginCode').value.trim();
  const collegeName = $('#loginCollege').selectedOptions[0]?.textContent || '';
  const name = $('#regName').value.trim();
  const email = $('#regEmail').value.trim();
  const section = $('#regBatch').value;
  const department = $('#regDept').value;
  const profile = $('#regProfile').value.trim();
  if (!collegeId || !code) return setMsg('#loginMsg', 'Pick your college and enter the access code above first.', 'err');
  if (!name || !profile) return setMsg('#loginMsg', 'Enter your name and LeetCode profile.', 'err');
  setMsg('#loginMsg', 'Adding you and loading your stats…', '');
  try {
    const r = await api('/student/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collegeId, code, name, email, section, department, profile }),
    });
    session.collegeId = collegeId;
    session.code = code;
    session.collegeName = collegeName;
    session.studentId = r.student.id;
    session.name = r.student.name;
    saveSession();
    enterApp();
  } catch (e) { setMsg('#loginMsg', e.message, 'err'); }
});

$('#logoutBtn').addEventListener('click', () => {
  sessionStorage.removeItem('lc_student');
  location.reload();
});

// ---- Tabs -------------------------------------------------------------------
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  $('#tab-' + t.dataset.tab).classList.add('active');
}));

// ---- App --------------------------------------------------------------------
async function enterApp() {
  $('#loginView').style.display = 'none';
  $('#appView').style.display = 'block';
  $('#logoutBtn').style.display = 'inline-block';
  $('#whoami').textContent = `${session.collegeName}`;
  await loadDashboard();
}

async function loadDashboard(opts = {}) {
  let d;
  try {
    d = await api(`/student/${session.studentId}/dashboard?code=${encodeURIComponent(session.code)}`);
  } catch (e) {
    // session invalid (code changed / student removed) -> back to login
    sessionStorage.removeItem('lc_student');
    return location.reload();
  }
  const me = d.me;
  $('#whoami').textContent = `${esc(me.name)} · ${session.collegeName}`;
  renderHero(me);
  renderTiles(me);
  if (opts.chart !== false) renderMyMonthly(d.monthlyActivity); // skip on auto-refresh to avoid flicker
  renderProgress(d.me, d.monthlySolvedGrowth);
  renderPractice(d.practice, d.domainOrder, d.topicOrder);

  if (!dashAnimated) { dashAnimated = true; animateEntrance(); animateNumbers(); }
}

// Bouncy staggered entrance on the dashboard wrappers (runs once).
function animateEntrance() {
  const els = [$('#heroCard'), $('#myCards'), ...document.querySelectorAll('#tab-me .stu-panel')];
  els.forEach((el, i) => {
    if (!el) return;
    el.style.animationDelay = (i * 90) + 'ms';
    el.classList.add('stu-anim');
  });
}
// Count the stat numbers up from 0 with an overshoot, once.
function animateNumbers() {
  document.querySelectorAll('#tab-me [data-count]').forEach((el) => {
    const target = Number(el.dataset.count);
    if (!isFinite(target)) return;
    const prefix = el.dataset.prefix || '';
    const dur = 850, start = performance.now();
    const frame = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2); // easeOutBack
      el.textContent = prefix + Math.max(0, Math.round(target * eased)).toLocaleString();
      if (t < 1) requestAnimationFrame(frame);
      else el.textContent = prefix + target.toLocaleString();
    };
    requestAnimationFrame(frame);
  });
}

// Auto-refresh the student view (incl. the practice list). Kept at 30s (not 10s)
// to cut bandwidth/egress — completions don't need second-level freshness. Also
// pauses when the tab isn't visible.
const STUDENT_REFRESH_MS = 30000;
setInterval(() => {
  if (!session.studentId) return;                       // not logged in
  if (document.hidden) return;                          // tab not visible
  if ($('#appView').style.display === 'none') return;   // still on login screen
  loadDashboard({ chart: false });
}, STUDENT_REFRESH_MS);

function fmtAgo(iso) {
  if (!iso) return '';
  const t = new Date(String(iso).replace(' ', 'T') + 'Z').getTime();
  if (isNaN(t)) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function renderHero(me) {
  const initial = (me.name || '?').trim().charAt(0).toUpperCase();
  const synced = me.last_synced_at ? ` · updated ${fmtAgo(me.last_synced_at)}` : '';
  const val = (v) => (v && String(v).trim()) ? esc(v) : '—';
  const parts = [
    `Reg: ${val(me.register_number)}`,
    `Dept: ${val(me.department)}`,
    `Batch: ${val(me.section)}`,
  ];
  if (me.campus) parts.push(`Campus: ${esc(me.campus)}`);
  if (me.year) parts.push(`Year: ${esc(me.year)}`);
  const details = parts.map((p) => `<span class="tag">${p}</span>`).join('');
  $('#heroCard').innerHTML = `
    <div class="stu-avatar">${esc(initial)}</div>
    <div class="stu-hero-info">
      <h2>${esc(me.name)}</h2>
      <div class="stu-hero-sub"><a href="${esc(me.profile_url || '#')}" target="_blank" style="color:inherit">@${esc(me.username)}</a> · ${esc(session.collegeName)}${synced}</div>
      <div class="stu-hero-tags">${details}</div>
    </div>
    <div class="stu-rankbadge">
      <div class="n"${me.classRank ? ` data-count="${me.classRank}" data-prefix="#"` : ''}>${me.classRank ? '#' + me.classRank : '—'}</div>
      <div class="l">of ${me.classSize} in class</div>
    </div>`;
}

function renderTiles(me) {
  const tot = me.total || 0, e = me.easy || 0, m = me.medium || 0, h = me.hard || 0;
  const pct = (x) => (tot ? (x / tot) * 100 : 0);
  $('#myCards').innerHTML = `
    <div class="stu-grid">
      <div class="stu-tile">
        <div class="stu-tile-label">Total solved</div>
        <div class="stu-total" data-count="${tot}">${tot}</div>
        <div class="stu-bar">
          <span style="width:${pct(e)}%;background:var(--easy)"></span>
          <span style="width:${pct(m)}%;background:var(--medium)"></span>
          <span style="width:${pct(h)}%;background:var(--hard)"></span>
        </div>
        <div class="stu-legend">
          <span><i style="background:var(--easy)"></i>Easy <b data-count="${e}">${e}</b></span>
          <span><i style="background:var(--medium)"></i>Medium <b data-count="${m}">${m}</b></span>
          <span><i style="background:var(--hard)"></i>Hard <b data-count="${h}">${h}</b></span>
        </div>
      </div>
      <div class="stu-tile">
        <div class="stu-tile-label">Global rank</div>
        <div class="big"${me.ranking ? ` data-count="${me.ranking}" data-prefix="#"` : ''}>${me.ranking ? '#' + me.ranking.toLocaleString() : (me.found ? '—' : 'private')}</div>
      </div>
      <div class="stu-tile">
        <div class="stu-tile-label">Contest rating</div>
        <div class="big">${me.contest_rating || '—'}</div>
      </div>
    </div>`;
}

function renderMyMonthly(m) {
  if (myChart) myChart.destroy();
  myChart = new Chart($('#myMonthly'), {
    type: 'bar',
    data: { labels: m.map((x) => x.ym), datasets: [{ data: m.map((x) => x.submissions), backgroundColor: '#ffa116', borderRadius: 6, maxBarThickness: 38 }] },
    options: { plugins: { legend: { display: false } }, scales: {
      x: { grid: { display: false } },
      y: { beginAtZero: true } } },
  });
}

function pgain(cur, base) {
  if (base == null || cur == null) return '—';
  const d = cur - base;
  if (d > 0) return `<span class="delta">+${d}</span>`;
  if (d < 0) return `<span class="delta down">${d}</span>`;
  return '—';
}
function prankChange(base, cur) {
  if (base == null || cur == null) return '—';
  const d = base - cur; // positive = improved (lower rank number is better)
  if (d > 0) return `<span class="delta">▲${Math.abs(d).toLocaleString()}</span>`;
  if (d < 0) return `<span class="delta down">▼${Math.abs(d).toLocaleString()}</span>`;
  return '—';
}
function renderProgress(me, growth) {
  if (!me.baseline_at) {
    $('#myProgress').innerHTML = '<p class="hint">Your progress will appear here after your first sync.</p>';
    return;
  }
  // color-coded metric cards with a change pill
  const card = (label, display, base, cur, color, isRank) => {
    let chg = '—', cls = 'flat';
    if (base != null && cur != null) {
      const d = isRank ? base - cur : cur - base; // rank improves when number drops
      if (d > 0) { chg = (isRank ? '▲' : '+') + Math.abs(d).toLocaleString(); cls = 'up'; }
      else if (d < 0) { chg = (isRank ? '▼' : '−') + Math.abs(d).toLocaleString(); cls = 'down'; }
    }
    return `<div class="pg-card" style="--c:${color}">
      <div class="l">${label}</div><div class="v">${display}</div><div class="chg ${cls}">${chg}</div></div>`;
  };
  const rankNow = me.ranking ? '#' + Number(me.ranking).toLocaleString() : '—';
  let html = `<div class="pg-cards">
    ${card('Total', me.total, me.baseline_total, me.total, 'var(--text)', false)}
    ${card('Easy', me.easy, me.baseline_easy, me.easy, 'var(--easy)', false)}
    ${card('Medium', me.medium, me.baseline_medium, me.medium, 'var(--medium)', false)}
    ${card('Hard', me.hard, me.baseline_hard, me.hard, 'var(--hard)', false)}
    ${card('Global rank', rankNow, me.baseline_ranking, me.ranking, 'var(--text)', true)}
  </div>
  <p class="hint" style="margin-top:12px">Change since first tracked (${esc(String(me.baseline_at).slice(0, 10))}).</p>`;

  if (growth && growth.length) {
    const max = Math.max(1, ...growth.map((g) => g.total));
    html += `<h3 style="margin:20px 0 10px;font-size:13px">Problems solved per month</h3>
      <div class="pm-legend">
        <span><i style="background:var(--easy)"></i>Easy</span>
        <span><i style="background:var(--medium)"></i>Medium</span>
        <span><i style="background:var(--hard)"></i>Hard</span>
      </div>
      ${growth.map((g) => `<div class="pm-row">
        <div class="pm-month">${esc(g.ym)}</div>
        <div class="pm-bar">
          <span style="width:${(g.easy / max) * 100}%;background:var(--easy)"></span>
          <span style="width:${(g.medium / max) * 100}%;background:var(--medium)"></span>
          <span style="width:${(g.hard / max) * 100}%;background:var(--hard)"></span>
        </div>
        <div class="pm-total">${g.total}</div>
      </div>`).join('')}`;
  }
  $('#myProgress').innerHTML = html;
}

function mkOrderCmp(orderArr) {
  const idx = new Map((orderArr || []).map((n, i) => [n, i]));
  return (a, b) => {
    if (a === 'Uncategorized') return 1;
    if (b === 'Uncategorized') return -1;
    const ia = idx.has(a) ? idx.get(a) : 1e9, ib = idx.has(b) ? idx.get(b) : 1e9;
    return ia - ib || a.localeCompare(b);
  };
}
function renderPractice(p, domainOrder, topicOrder) {
  lastPractice = p; lastDomainOrder = domainOrder || lastDomainOrder; lastTopicOrder = topicOrder || lastTopicOrder;
  // Skip the rebuild when nothing relevant changed (no flicker on the 10s refresh).
  const sig = JSON.stringify([lastDomainOrder, lastTopicOrder, studentDomain, [...collapsedDomains], [...collapsedTopics],
    p.map((x) => [x.id, x.title, x.difficulty, x.topic, x.domain, x.completed, x.video_url, x.due_date, x.completed_at])]);
  if (sig === renderPractice._sig) return;
  renderPractice._sig = sig;
  const domCmp = mkOrderCmp(lastDomainOrder), topCmp = mkOrderCmp(lastTopicOrder);
  const done = p.filter((x) => x.completed).length;
  $('#practiceSummary').textContent = p.length ? `${done} / ${p.length} solved` : '';
  const cont = $('#myPracticeList');
  const tabsEl = $('#myDomainTabs');
  if (!p.length) {
    tabsEl.innerHTML = '';
    cont.innerHTML = '<p class="empty">No practice problems assigned yet.</p>';
    return;
  }

  const dom = (x) => (x.domain && x.domain.trim()) || 'Uncategorized';
  const top = (x) => (x.topic && x.topic.trim()) || 'Uncategorized';

  // Deadline status pill for a problem (on-time / late / due / overdue).
  const stuDue = (x) => {
    if (!x.due_date) return '';
    const today = new Date().toISOString().slice(0, 10);
    if (x.completed) {
      const onTime = !x.completed_at || String(x.completed_at).slice(0, 10) <= x.due_date;
      return ` <span class="due-pill ${onTime ? 'ontime' : 'late'}">${onTime ? '✓ on time' : '⚠ late'}</span>`;
    }
    const overdue = x.due_date < today;
    return ` <span class="due-pill ${overdue ? 'overdue' : ''}">⏰ due ${esc(x.due_date)}${overdue ? ' · overdue' : ''}</span>`;
  };

  const item = (x) => `<div class="stu-prac">
    <div class="stu-badge ${x.completed ? 'done' : 'todo'}">${x.completed ? '✓' : '•'}</div>
    <div class="stu-prac-title"><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>${stuDue(x)}</div>
    ${x.difficulty ? `<span class="pill ${(x.difficulty || '').toLowerCase()}">${esc(x.difficulty)}</span>` : ''}
    ${x.video_url ? `<button class="btn btn-sm btn-ghost stu-vid" data-video="${esc(x.video_url)}" title="Watch explanation">▶ Video</button>` : ''}
    <a class="btn btn-sm ${x.completed ? 'btn-ghost' : 'btn-primary'}" href="${esc(x.url)}" target="_blank" rel="noopener">${x.completed ? 'Review' : 'Solve →'}</a>
  </div>`;

  const topicBlocks = (probs) => {
    const groups = {};
    for (const x of probs) (groups[top(x)] ||= []).push(x);
    return Object.keys(groups).sort(topCmp).map((t) => {
      const g = groups[t];
      const solved = g.filter((x) => x.completed).length;
      const pct = Math.round((solved / g.length) * 100);
      const key = dom(g[0]) + '|' + t;
      const collapsed = collapsedTopics.has(key);
      return `<div class="stu-topic-head" data-topic="${esc(key)}" style="cursor:pointer">
          <span class="name">${collapsed ? '▸' : '▾'} ${esc(t)}</span>
          <span class="stu-topic-bar"><span style="width:${pct}%"></span></span>
          <span class="hint" style="white-space:nowrap">${solved}/${g.length}</span>
        </div>${collapsed ? '' : g.map(item).join('')}`;
    }).join('');
  };

  const wireTopicFold = () => cont.querySelectorAll('.stu-topic-head[data-topic]').forEach((el) => el.addEventListener('click', () => {
    const k = el.dataset.topic;
    collapsedTopics.has(k) ? collapsedTopics.delete(k) : collapsedTopics.add(k);
    renderPractice(lastPractice, lastDomainOrder, lastTopicOrder);
  }));
  const domGroups = {};
  for (const x of p) (domGroups[dom(x)] ||= []).push(x);
  const domNames = Object.keys(domGroups).sort(domCmp);

  // No domains assigned -> just topics, no tabs.
  if (domNames.length === 1 && domNames[0] === 'Uncategorized') {
    tabsEl.innerHTML = '';
    cont.innerHTML = topicBlocks(p);
    wireTopicFold();
    return;
  }

  // Domain tabs (All + one per domain).
  if (studentDomain !== '__all' && !domNames.includes(studentDomain)) studentDomain = '__all';
  const sel = studentDomain;
  tabsEl.innerHTML =
    `<button class="dom-tab ${sel === '__all' ? 'active' : ''}" data-dom="__all">All</button>` +
    domNames.map((dn) => `<button class="dom-tab ${sel === dn ? 'active' : ''}" data-dom="${esc(dn)}">${esc(dn)}</button>`).join('');
  tabsEl.querySelectorAll('.dom-tab').forEach((b) => b.addEventListener('click', () => {
    studentDomain = b.dataset.dom;
    renderPractice(lastPractice, lastDomainOrder, lastTopicOrder);
  }));

  cont.innerHTML = sel === '__all'
    ? domNames.map((dn) => {
        const g = domGroups[dn];
        const solved = g.filter((x) => x.completed).length;
        const collapsed = collapsedDomains.has(dn);
        return `<div class="stu-domain-head" data-dom="${esc(dn)}" style="cursor:pointer">${collapsed ? '▸' : '▾'} ${esc(dn)} <span class="hint">· ${solved}/${g.length} solved</span></div>${collapsed ? '' : topicBlocks(g)}`;
      }).join('')
    : topicBlocks(domGroups[sel]);

  cont.querySelectorAll('.stu-domain-head[data-dom]').forEach((el) => el.addEventListener('click', () => {
    const dn = el.dataset.dom;
    collapsedDomains.has(dn) ? collapsedDomains.delete(dn) : collapsedDomains.add(dn);
    renderPractice(lastPractice, lastDomainOrder, lastTopicOrder);
  }));
  wireTopicFold();
}

// ---- helpers ----------------------------------------------------------------
function setMsg(sel, text, cls) { const el = $(sel); el.textContent = text; el.className = 'msg ' + (cls || ''); }
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
  if (!embed) { window.open(url, '_blank', 'noopener'); return; } // not YouTube — fall back to new tab
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
  if (m) { m.querySelector('.video-frame').innerHTML = ''; m.classList.remove('open'); } // clearing the iframe stops playback
}
document.addEventListener('click', (e) => {
  const v = e.target.closest('[data-video]');
  if (v) { e.preventDefault(); openVideoModal(v.getAttribute('data-video')); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeVideoModal(); });

// ---- boot -------------------------------------------------------------------
(async function boot() {
  await initLogin();
  const saved = loadSession();
  if (saved && saved.studentId && saved.code) {
    session = saved;
    enterApp();
  }
})();
