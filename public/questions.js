// Public questions-only page — no login, no student data. Shows the college's
// assigned practice questions grouped by domain/topic, with difficulty and
// (if enabled) an inline video player.
const $ = (s) => document.querySelector(s);
const token = decodeURIComponent(location.pathname.split('/q/')[1] || '').replace(/\/+$/, '');
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
const api = (path) => fetch('/api' + path).then(async (r) => {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
});

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

// Green topic accent — a readable darker green in light mode, lighter in dark.
function topicColor() {
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  return light ? 'hsl(145, 63%, 30%)' : 'hsl(145, 55%, 58%)';
}
// Re-render on theme toggle so the topic color updates for the new mode.
window.__onTheme = () => { if (data) render(); };

// ---- Render ----------------------------------------------------------------
let data = null, selDomain = '__all';
const collapsedDomains = new Set();
const collapsedTopics = new Set(); // keyed by domain|topic

async function load() {
  let d;
  try { d = await api('/public/practice/' + encodeURIComponent(token)); }
  catch (e) {
    $('#error').style.display = 'block';
    $('#error').innerHTML = `<h2 style="margin:0 0 6px">Link not available</h2><p class="hint" style="margin:0">${esc(e.message)}</p>`;
    return;
  }
  data = d;
  document.title = `${d.college.name} — Practice Questions`;
  $('#collegeName').textContent = d.college.name;
  $('#content').style.display = 'block';
  render();
}

function render() {
  const d = data;
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
  const problems = d.problems || [];
  if (!problems.length) {
    $('#domainTabs').innerHTML = '';
    $('#list').innerHTML = '<p class="empty">No questions assigned yet.</p>';
    return;
  }
  const domGroups = {};
  for (const p of problems) (domGroups[dom(p)] ||= []).push(p);
  const domNames = Object.keys(domGroups).sort(domCmp);
  const hasDomains = !(domNames.length === 1 && domNames[0] === 'Uncategorized');

  if (hasDomains) {
    if (selDomain !== '__all' && !domNames.includes(selDomain)) selDomain = '__all';
    $('#domainTabs').innerHTML =
      `<button class="dom-tab ${selDomain === '__all' ? 'active' : ''}" data-dom="__all">All</button>` +
      domNames.map((dn) => `<button class="dom-tab ${selDomain === dn ? 'active' : ''}" data-dom="${esc(dn)}">${esc(dn)}</button>`).join('');
    $('#domainTabs').querySelectorAll('.dom-tab').forEach((b) => b.addEventListener('click', () => { selDomain = b.dataset.dom; render(); }));
  } else {
    $('#domainTabs').innerHTML = '';
  }

  const today = new Date().toISOString().slice(0, 10);
  const item = (p) => `<div class="stu-prac">
    <div class="stu-prac-title"><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>${p.due_date ? ` <span class="due-pill${p.due_date < today ? ' overdue' : ''}">⏰ ${esc(p.due_date)}</span>` : ''}</div>
    <span class="stu-prac-actions">
      ${p.video_url ? `<button class="btn btn-sm btn-ghost stu-vid" data-video="${esc(p.video_url)}" title="Watch video">▶ Video</button>` : ''}
      <span class="stu-prac-diff">${p.difficulty ? `<span class="pill ${(p.difficulty || '').toLowerCase()}">${esc(p.difficulty)}</span>` : ''}</span>
      <a class="btn btn-sm btn-primary" href="${esc(p.url)}" target="_blank" rel="noopener">Solve →</a>
    </span>
  </div>`;
  const topicBlocks = (probs) => {
    const g = {};
    for (const p of probs) (g[top(p)] ||= []).push(p);
    return Object.keys(g).sort(topCmp).map((t) => {
      const key = dom(g[t][0]) + '|' + t;
      const collapsed = collapsedTopics.has(key);
      const col = topicColor(t);
      return `<div class="stu-topic-head" data-topic="${esc(key)}" style="cursor:pointer;border-left:4px solid ${col};padding-left:10px;background:${col.replace(')', ',.08)').replace('hsl', 'hsla')}">
          <span class="name" style="color:${col}">${collapsed ? '▸' : '▾'} ${esc(t)}</span>
          <span class="hint" style="white-space:nowrap">${g[t].length}</span></div>${collapsed ? '' : g[t].map(item).join('')}`;
    }).join('');
  };

  let html;
  if (hasDomains && selDomain === '__all') {
    html = domNames.map((dn) => {
      const collapsed = collapsedDomains.has(dn);
      return `<div class="stu-domain-head" data-dom="${esc(dn)}" style="cursor:pointer">${collapsed ? '▸' : '▾'} ${esc(dn)} <span class="hint">· ${domGroups[dn].length}</span></div>${collapsed ? '' : topicBlocks(domGroups[dn])}`;
    }).join('');
  } else if (hasDomains) {
    html = topicBlocks(domGroups[selDomain]);
  } else {
    html = topicBlocks(problems);
  }
  $('#list').innerHTML = html;

  // Fold/unfold handlers
  $('#list').querySelectorAll('.stu-domain-head[data-dom]').forEach((el) => el.addEventListener('click', () => {
    const dn = el.dataset.dom;
    collapsedDomains.has(dn) ? collapsedDomains.delete(dn) : collapsedDomains.add(dn);
    render();
  }));
  $('#list').querySelectorAll('.stu-topic-head[data-topic]').forEach((el) => el.addEventListener('click', () => {
    const k = el.dataset.topic;
    collapsedTopics.has(k) ? collapsedTopics.delete(k) : collapsedTopics.add(k);
    render();
  }));
}

load();
