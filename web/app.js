'use strict';

// ============ storage + state ============
const KEY = { auth: 'ys.auth', cache: 'ys.cache', cat: 'ys.cat', hideInstall: 'ys.hideInstall', notes: 'ys.notes' };
const ls = {
  get(k, fallback = null) { try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

let auth = ls.get(KEY.auth);            // { token, expires } — one login per device per 30 days
if (auth && auth.expires < Date.now()) { auth = null; ls.del(KEY.auth); }
let devices = null;
let data = ls.get(KEY.cache);           // { active, sessions, config, vapidPublicKey }
let skew = 0;                            // server clock - device clock
const selCat = ls.get(KEY.cat, {});      // courseId -> { category, label }
const pendingNotes = ls.get(KEY.notes, {}); // courseId -> note typed before starting
const ui = { statsMode: 'week', statsOffset: 0, statsCourse: null, historyLimit: 60 };

const now = () => Date.now() + skew;
const REMIND_CHOICES = [30, 45, 60, 90, 120, 150, 180, 210, 240, 300, 360, 480];
// Older configs have no reminder setting: default to on at 2.5 hours (matches the server).
const reminderCfg = () => ({ enabled: data?.config?.reminder?.enabled !== false, minutes: data?.config?.reminder?.minutes ?? 150 });
function fmtMinutes(m) {
  if (m < 60) return `${m} min`;
  const h = m / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1).replace(/\.0$/, '')} hour${h === 1 ? '' : 's'}`;
}
// Preset color schemes. `base` drives the app chrome (CSS [data-base]); class colors are assigned
// by class order, with a separate dark-mode palette.
const PRESETS = {
  blossom: {
    name: 'Blossom',
    light: ['#f07c94', '#f4a261', '#b48ce0', '#6cc4b0', '#f2c14e', '#7aa8e8', '#e58fc6', '#a3a380'],
    dark: ['#ff8fa6', '#ffb27a', '#c6a2f2', '#7fd6c1', '#ffd36b', '#8fb8ff', '#f3a2d6', '#bcbc96'],
  },
  seaside: {
    name: 'Seaside',
    light: ['#ef8a7a', '#4f9ee8', '#43b99a', '#8b84e0', '#f5b84f', '#3cc0d0', '#e57fb0', '#93a5b5'],
    dark: ['#ff9d8e', '#6fb4ff', '#5ed1b1', '#a39cf5', '#ffc96b', '#5fd5e3', '#f497c3', '#aabbca'],
  },
  matcha: {
    name: 'Matcha',
    light: ['#e5868d', '#7fa7d6', '#7fb069', '#c49bd1', '#e2b65c', '#5fb3a4', '#d98fb0', '#a8977a'],
    dark: ['#f29aa1', '#96bcea', '#97c882', '#d5b0e2', '#f0c977', '#76c9ba', '#eba5c4', '#bfae91'],
  },
};
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
const CATS = [['class', 'Class'], ['study', 'Study'], ['read', 'Read']];
const DOWS = ['Su', 'M', 'T', 'W', 'Th', 'F', 'Sa'];

// ============ helpers ============
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}
function fmtHM(ms) {
  const m = Math.round(ms / 60e3);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}
const fmtHrs = (ms) => `${(ms / 3600e3).toFixed(1)} hrs`;
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDate = (ts, o = { weekday: 'long', month: 'short', day: 'numeric' }) => new Date(ts).toLocaleDateString([], o);
const dateKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const timeKey = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
function addDays(ts, n) { const d = new Date(ts); d.setDate(d.getDate() + n); return d.getTime(); }
const uid = () => 'c' + Math.random().toString(36).slice(2, 8);
const clone = (o) => JSON.parse(JSON.stringify(o));

function activeScheme() {
  const id = data?.config?.theme ?? 'blossom';
  if (PRESETS[id]) return { id, base: id, preset: PRESETS[id] };
  const t = data?.config?.themes?.find((x) => x.id === id);
  return t ? { id, base: t.base, custom: t } : { id: 'blossom', base: 'blossom', preset: PRESETS.blossom };
}
function colorFor(courseId, index, scheme = activeScheme()) {
  if (scheme.custom?.colors?.[courseId]) return scheme.custom.colors[courseId];
  const pal = PRESETS[scheme.base][darkMQ.matches ? 'dark' : 'light'];
  return pal[index % pal.length];
}
function applyTheme() {
  document.documentElement.dataset.base = activeScheme().base;
  const bg = getComputedStyle(document.body).backgroundColor;
  document.querySelectorAll('meta[name=theme-color]').forEach((m) => m.setAttribute('content', bg));
}
const courses = () => (data?.config?.courses ?? []).map((c, i) => ({ ...c, color: colorFor(c.id, i) }));
const course = (id) => courses().find((c) => c.id === id) ?? { id, short: 'Unknown', name: 'Unknown class', color: '#999999' };
const catName = (s) => (s.category === 'other' ? (s.label || 'Other') : (CATS.find(([k]) => k === s.category)?.[1] ?? s.category));
const catVerb = (s) => ({ class: 'In class', study: 'Studying', read: 'Reading' }[s.category] ?? (s.label || 'Other'));

function allSessions() {
  const list = data?.sessions ?? [];
  return data?.active ? [...list, { ...data.active, id: 'active', end: now() }] : list;
}
const overlap = (s, from, to) => Math.max(0, Math.min(s.end, to) - Math.max(s.start, from));
function sumMs(from, to, pred = () => true) {
  return allSessions().reduce((t, s) => (pred(s) ? t + overlap(s, from, to) : t), 0);
}
const todayMs = (courseId) => { const d = startOfDay(now()); return sumMs(d, addDays(d, 1), (s) => s.course === courseId); };

function currentSemester() {
  const sems = [...(data?.config?.semesters ?? [])].sort((a, b) => a.start.localeCompare(b.start));
  const today = dateKey(now());
  return sems.find((s) => s.start <= today && today <= s.end)
    ?? sems.find((s) => s.start > today)
    ?? sems[sems.length - 1];
}
function meetingsToday(courseId) {
  const sem = currentSemester();
  const today = dateKey(now());
  if (!sem || today < sem.start || today > sem.end || sem.noClass?.includes(today)) return [];
  const dow = DOWS[new Date().getDay()];
  return (sem.schedule ?? []).filter((m) => m.course === courseId && m.days.includes(dow));
}
const hm12 = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${pad(m)}${h < 12 ? 'a' : 'p'}`; };

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// ============ API ============
async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && path !== '/login') {
    auth = null; ls.del(KEY.auth);
    render();
    throw new Error('Please sign in again');
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Error ${res.status}`);
  if (json.sessions) setData(json);
  return json;
}
function setData(json) {
  skew = json.now ? json.now - Date.now() : skew;
  data = { active: json.active, sessions: json.sessions, config: json.config, vapidPublicKey: json.vapidPublicKey };
  ls.set(KEY.cache, data);
}
// Optimistic update: apply locally, render, then sync. Roll back on failure.
async function mutate(localChange, method, path, body, okMsg) {
  const before = clone(data);
  localChange?.();
  render();
  try {
    await api(method, path, body);
    render();
    if (okMsg) toast(okMsg);
  } catch (e) {
    data = before;
    render();
    toast(e.message === 'Failed to fetch' ? 'No connection — try again' : e.message);
  }
}
async function refresh() {
  if (!auth) return;
  try { await api('GET', '/state'); render(); } catch (e) { if (data) toast('Offline — showing saved data'); }
}

// ============ actions ============
function selectedFor(courseId) {
  if (data.active?.course === courseId) return { category: data.active.category, label: data.active.label };
  return selCat[courseId] ?? { category: 'study' };
}
function setCategory(courseId, category, label) {
  selCat[courseId] = { category, label };
  ls.set(KEY.cat, selCat);
  if (data.active?.course === courseId) {
    mutate(() => { Object.assign(data.active, { category, label }); }, 'POST', '/active', { category, label: label ?? null });
  } else render();
}
function start(courseId) {
  const sel = selectedFor(courseId);
  const prev = data.active;
  const note = pendingNotes[courseId] || undefined;
  delete pendingNotes[courseId]; ls.set(KEY.notes, pendingNotes);
  const msg = prev && prev.course !== courseId ? `Paused ${course(prev.course).short}` : null;
  mutate(() => { data.active = { course: courseId, category: sel.category, label: sel.label, start: now(), note }; },
    'POST', '/start', { course: courseId, category: sel.category, label: sel.label, note }, msg);
}
function pause() {
  const a = data.active;
  if (!a) return;
  const noteEl = $('#note');
  const note = noteEl ? noteEl.value : a.note;
  mutate(() => {
    if (now() - a.start >= 15e3) data.sessions.push({ id: 'tmp', ...a, note, end: now() });
    data.active = null;
  }, 'POST', '/pause', { note }, `Logged ${fmtHM(now() - a.start)} · ${course(a.course).short} ${catName(a)}`);
}
function saveConfig(cfg, msg = 'Saved') {
  return mutate(() => { data.config = cfg; }, 'PUT', '/config', cfg, msg);
}

// ============ views ============
const ICON = {
  gear: '<svg viewBox="0 0 24 24"><path d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.4-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3.3h-4l-.4 2.7a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.4 2.5-1a7.4 7.4 0 0 0 1.7 1l.3 2.7h4l.4-2.7a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.4zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15.4 4.6 8 12l7.4 7.4-1.4 1.4L5.2 12 14 3.2z"/></svg>',
  chev: '<svg viewBox="0 0 24 24"><path d="m9 5.6 6.4 6.4L9 18.4 7.6 17l5-5-5-5z"/></svg>',
  left: '<svg viewBox="0 0 24 24"><path d="M15.4 4.6 8 12l7.4 7.4-1.4 1.4L5.2 12 14 3.2z"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="m8.6 4.6 7.4 7.4-7.4 7.4 1.4 1.4 8.8-8.8L10 3.2z"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 4h4.5v16H6zm7.5 0H18v16h-4.5z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7z"/></svg>',
};

function chipsHtml(courseId) {
  const sel = selectedFor(courseId);
  const otherLabel = sel.category === 'other' ? (sel.label || 'Other') : 'Other ▾';
  return `<div class="chips" role="group" aria-label="Activity">
    ${CATS.map(([k, label]) => `<button class="chip" data-act="cat" data-course="${esc(courseId)}" data-cat="${k}" aria-pressed="${sel.category === k}">${label}</button>`).join('')}
    <button class="chip" data-act="other" data-course="${esc(courseId)}" aria-pressed="${sel.category === 'other'}">${esc(otherLabel)}</button>
  </div>`;
}
function goBtn(courseId) {
  const running = data.active?.course === courseId;
  return running
    ? `<button class="go pause" data-act="pause">${ICON.pause}Pause</button>`
    : `<button class="go" data-act="start" data-course="${esc(courseId)}">${ICON.play}Start</button>`;
}

function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
function isStandalone() { return navigator.standalone || matchMedia('(display-mode: standalone)').matches; }
function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }

function homeBanner() {
  if (isIOS() && !isStandalone() && !ls.get(KEY.hideInstall)) {
    return `<div class="banner"><div><b>Add this to your Home Screen</b> for reminders and one-tap access: tap <b>Share</b> → <b>Add to Home Screen</b>.</div><button class="x" data-act="hide-install" aria-label="Dismiss">×</button></div>`;
  }
  if (reminderCfg().enabled && pushSupported() && Notification.permission === 'default' && (!isIOS() || isStandalone())) {
    return `<div class="banner"><div><b>Turn on reminders?</b> You'll get a nudge if a timer runs ${fmtMinutes(reminderCfg().minutes)} straight.</div><button class="btn small primary" data-act="enable-push">Turn on</button></div>`;
  }
  return '';
}

function viewHome() {
  const sem = currentSemester();
  const list = courses().filter((c) => !c.archived);
  return `
  <header class="top">
    <span></span>
    <h1>Study Tracker<span class="sub">${esc(fmtDate(now()))}${sem ? ` · ${esc(sem.name)}` : ''}</span></h1>
    <a class="icon-btn" href="#settings" aria-label="Settings">${ICON.gear}</a>
  </header>
  ${homeBanner()}
  <section class="cards">
    ${list.map((c) => {
      const running = data.active?.course === c.id;
      const meets = meetingsToday(c.id).map((m) => `${hm12(m.start)}–${hm12(m.end)}`).join(', ');
      return `<article class="card ${running ? 'running' : ''}" style="--c:${esc(c.color)}">
        <button class="card-head" data-act="open" data-course="${esc(c.id)}" aria-label="Open ${esc(c.short)} timer">
          <h2>${running ? '<span class="live-dot"></span>' : ''}${esc(c.short)}</h2>
          <span class="chev">${meets ? `Class ${meets}` : ''}${ICON.chev}</span>
        </button>
        ${chipsHtml(c.id)}
        <div class="card-foot">
          <div class="clock num">${running
            ? `<span data-tick="session">${fmtClock(now() - data.active.start)}</span><small>this session · <span data-tick="today" data-course="${esc(c.id)}">${fmtHM(todayMs(c.id))}</span> today</small>`
            : `<span data-tick="today-clock" data-course="${esc(c.id)}">${fmtClock(todayMs(c.id))}</span><small>today</small>`}</div>
          ${goBtn(c.id)}
        </div>
      </article>`;
    }).join('')}
    <button class="card add" data-act="edit-course">+ Add a class or activity</button>
  </section>`;
}

function viewTimer(courseId) {
  const c = course(courseId);
  const a = data.active;
  const running = a?.course === courseId;
  const sel = selectedFor(courseId);
  const R = 44, C = 2 * Math.PI * R;
  const d0 = startOfDay(now());
  const todays = allSessions().filter((s) => s.course === courseId && s.end > d0).sort((x, y) => y.start - x.start);
  return `
  <header class="top">
    <a class="back" href="#home">${ICON.back}Back</a>
    <h1>${esc(c.short)}</h1>
    <span></span>
  </header>
  <div style="--c:${esc(c.color)}">
    ${chipsHtml(courseId)}
    <div class="timer-wrap">
      <div class="ring">
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <circle class="track" cx="50" cy="50" r="${R}"/>
          <circle class="bar" cx="50" cy="50" r="${R}" stroke-dasharray="${C}" data-tick="ring" data-circ="${C}"
            stroke-dashoffset="${running ? C * (1 - Math.min(1, (now() - a.start) / (reminderCfg().minutes * 60e3))) : C}"/>
        </svg>
        <div class="inner">
          <div class="big num" ${running ? 'data-tick="session"' : ''}>${running ? fmtClock(now() - a.start) : '00:00:00'}</div>
          <div class="what">${running ? `${esc(catVerb(a))} — ${esc(c.short)}` : `Ready: ${esc(catName(sel))}`}</div>
        </div>
      </div>
    </div>
    <div class="timer-actions">${goBtn(courseId)}</div>
    <p class="today-line">Today on ${esc(c.short)}: <b class="num" data-tick="today" data-course="${esc(courseId)}">${fmtHM(todayMs(courseId))}</b></p>
    <label class="field"><span>✎ Note (optional)</span>
      <textarea id="note" class="input" rows="2" placeholder="What are you working on?" data-course="${esc(courseId)}">${esc(running ? (a.note ?? '') : (pendingNotes[courseId] ?? ''))}</textarea>
    </label>
    ${todays.length ? `<div class="panel"><h3>Today</h3>${todays.map(sessionRow).join('')}</div>` : ''}
  </div>`;
}

function sessionRow(s) {
  const c = course(s.course);
  const live = s.id === 'active';
  return `<button class="row" style="--c:${esc(c.color)}" ${live ? `data-act="open" data-course="${esc(s.course)}"` : `data-act="edit-session" data-id="${esc(s.id)}"`}>
    <span class="dot"></span>
    <span><span class="t">${esc(c.short)} – ${esc(catName(s))}</span>${s.auto ? '<span class="tag">auto</span>' : ''}${live ? '<span class="tag">running</span>' : ''}
      <span class="s" style="display:block">${fmtTime(s.start)} – ${live ? 'now' : fmtTime(s.end)}${s.note ? ` · ${esc(s.note)}` : ''}</span></span>
    <span class="h num">${fmtHrs(s.end - s.start)}</span>
  </button>`;
}

// ---------- stats ----------
function period(mode, offset) {
  const today = startOfDay(now());
  if (mode === 'day') {
    const from = addDays(today, offset);
    return { from, to: addDays(from, 1), label: fmtDate(from), unit: 'day' };
  }
  if (mode === 'week') {
    const dow = (new Date(today).getDay() + 6) % 7; // Monday = 0
    const from = addDays(today, -dow + 7 * offset);
    const to = addDays(from, 7);
    return { from, to, label: `${fmtDate(from, { month: 'short', day: 'numeric' })} – ${fmtDate(addDays(to, -1), { month: 'short', day: 'numeric' })}`, unit: 'week' };
  }
  const d = new Date(today); d.setDate(1); d.setMonth(d.getMonth() + offset);
  const from = d.getTime(); d.setMonth(d.getMonth() + 1);
  return { from, to: d.getTime(), label: fmtDate(from, { month: 'long', year: 'numeric' }), unit: 'month' };
}

function viewStats() {
  const p = period(ui.statsMode, ui.statsOffset);
  const prev = period(ui.statsMode, ui.statsOffset - 1);
  const total = sumMs(p.from, p.to);
  // For the in-progress period, compare against the same elapsed portion of the previous one.
  const cut = Math.min(p.to, now());
  const prevTotal = sumMs(prev.from, prev.from + (cut - p.from));
  const delta = prevTotal > 0 ? Math.round((total - prevTotal) / prevTotal * 100) : null;
  const used = [...new Set(allSessions().filter((s) => overlap(s, p.from, p.to) > 0).map((s) => s.course))];
  const ordered = [...courses().filter((c) => used.includes(c.id)), ...used.filter((id) => !courses().some((c) => c.id === id)).map(course)];
  const byCourse = ordered.map((c) => ({ c, ms: sumMs(p.from, p.to, (s) => s.course === c.id) })).sort((x, y) => y.ms - x.ms);
  const maxC = Math.max(1, ...byCourse.map((x) => x.ms));

  let chart = '';
  if (p.unit !== 'day') {
    const days = [];
    for (let t = p.from; t < p.to; t = addDays(t, 1)) days.push(t);
    const cols = days.map((t) => ({ t, parts: ordered.map((c) => ({ c, ms: sumMs(t, addDays(t, 1), (s) => s.course === c.id) })) }));
    const maxD = Math.max(1, ...cols.map((col) => col.parts.reduce((a, x) => a + x.ms, 0)));
    const showVals = p.unit === 'week';
    chart = `<div class="bars" role="img" aria-label="Hours per day">
      ${cols.map(({ t, parts }, i) => {
        const dayTotal = parts.reduce((a, x) => a + x.ms, 0);
        const lbl = p.unit === 'week' ? fmtDate(t, { weekday: 'short' }) : ([0, 7, 14, 21, 28].includes(i) ? new Date(t).getDate() : '');
        return `<div class="col">
          ${showVals && dayTotal >= 180e3 ? `<span class="v num">${(dayTotal / 3600e3).toFixed(1)}</span>` : ''}
          <div class="stack" style="height:${dayTotal >= 180e3 ? (dayTotal / maxD) * 130 : 0}px">${parts.filter((x) => x.ms).map((x) => `<i style="--c:${esc(x.c.color)};height:${(x.ms / dayTotal) * 100}%"></i>`).join('')}</div>
          <span class="lbl">${lbl}</span></div>`;
      }).join('')}</div>
      <div class="legend">${ordered.map((c) => `<span style="--c:${esc(c.color)}"><i class="dot"></i>${esc(c.short)}</span>`).join('')}</div>`;
  }

  return `
  <header class="top"><span></span><h1>Stats</h1><a class="icon-btn" href="#settings" aria-label="Settings">${ICON.gear}</a></header>
  <div class="seg" role="group">${['day', 'week', 'month'].map((m) => `<button data-act="stats-mode" data-mode="${m}" aria-pressed="${ui.statsMode === m}">${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}</div>
  <div class="period">
    <button class="icon-btn" data-act="stats-shift" data-d="-1" aria-label="Previous">${ICON.left}</button>
    <span>${esc(p.label)}</span>
    <button class="icon-btn" data-act="stats-shift" data-d="1" aria-label="Next" ${ui.statsOffset >= 0 ? 'disabled style="opacity:.3"' : ''}>${ICON.right}</button>
  </div>
  <section class="panel">
    <h3>Total hours</h3>
    <p class="total num">${(total / 3600e3).toFixed(1)} <small>hrs</small></p>
    ${delta !== null ? `<span class="delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '↑' : '↓'} ${Math.abs(delta)}% vs. ${ui.statsOffset === 0 ? 'same point ' : ''}last ${p.unit}</span>` : ''}
    ${total ? chart : '<p class="empty">Nothing logged yet.</p>'}
  </section>
  ${byCourse.length ? `<section class="panel"><h3>Hours by class</h3>
    ${byCourse.map(({ c, ms }) => `<button class="hbar" style="--c:${esc(c.color)}" data-act="stats-course" data-course="${esc(c.id)}">
      <span>${esc(c.short)}</span><span class="track"><span class="fill" style="display:block;width:${(ms / maxC) * 100}%"></span></span><span class="h num">${fmtHrs(ms)}</span>
    </button>`).join('')}
    <p class="s" style="color:var(--muted);font-size:13px;margin:8px 0 0">Tap a class for its breakdown.</p>
  </section>` : ''}
  ${ui.statsCourse ? breakdownHtml(course(ui.statsCourse), p) : ''}`;
}

function breakdownHtml(c, p) {
  const groups = new Map();
  for (const s of allSessions()) {
    if (s.course !== c.id) continue;
    const ms = overlap(s, p.from, p.to);
    if (ms) groups.set(catName(s), (groups.get(catName(s)) ?? 0) + ms);
  }
  const rows = [...groups].sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((a, [, ms]) => a + ms, 0);
  if (!total) return '';
  const shade = (i) => `color-mix(in srgb, ${c.color} ${100 - i * 22}%, white)`;
  let acc = 0;
  const stops = rows.map(([, ms], i) => { const a0 = acc; acc += ms / total * 360; return `${shade(i)} ${a0}deg ${acc}deg`; }).join(',');
  return `<section class="panel" id="breakdown">
    <h3 style="display:flex;justify-content:space-between">${esc(c.short)} breakdown<button class="tag" data-act="stats-course" data-course="">close</button></h3>
    <div class="breakdown">
      <div>${rows.map(([name, ms], i) => `<div class="bd-row"><span class="dot" style="--c:${shade(i)}"></span><span>${esc(name)}</span><span class="num">${fmtHrs(ms)}</span><span class="p num">${Math.round(ms / total * 100)}%</span></div>`).join('')}
        <div class="bd-row total-row"><span></span><span>Total</span><span class="num">${fmtHrs(total)}</span><span class="p">100%</span></div></div>
      <div class="pie" style="background:conic-gradient(${stops})" role="img" aria-label="Share by activity"></div>
    </div>
  </section>`;
}

// ---------- history ----------
function viewHistory() {
  const list = allSessions().slice().sort((a, b) => b.start - a.start);
  const shown = list.slice(0, ui.historyLimit);
  let html = '', lastDay = '';
  for (const s of shown) {
    const k = dateKey(s.start);
    if (k !== lastDay) {
      if (lastDay) html += '</div>';
      const dayTotal = sumMs(startOfDay(s.start), addDays(startOfDay(s.start), 1));
      html += `<div class="day-head"><span>${esc(fmtDate(s.start, { weekday: 'short', month: 'short', day: 'numeric' }))}</span><span class="num">${fmtHrs(dayTotal)}</span></div><div class="panel" style="padding:2px 16px">`;
      lastDay = k;
    }
    html += sessionRow(s);
  }
  if (lastDay) html += '</div>';
  return `
  <header class="top"><span></span><h1>History</h1><button class="icon-btn" data-act="edit-session" aria-label="Add a session">${ICON.plus}</button></header>
  ${html || '<p class="empty">No sessions yet. Tap Start on a class to log one.</p>'}
  ${list.length > shown.length ? '<div class="btns"><button class="btn" data-act="more">Show more</button></div>' : ''}
  <p style="color:var(--muted);font-size:13px;text-align:center;margin-top:16px">Tap any session to edit or delete it. Skipped a class? Delete its "auto" entry.</p>`;
}

// ---------- settings ----------
function viewSettings() {
  const cfg = data.config;
  const active = cfg.courses.filter((c) => !c.archived);
  const archived = cfg.courses.filter((c) => c.archived);
  const sem = currentSemester();
  const sched = (id) => (sem?.schedule ?? []).filter((m) => m.course === id).map((m) => `${m.days.join('')} ${hm12(m.start)}–${hm12(m.end)}`).join(', ');
  const perm = pushSupported() ? Notification.permission : 'unsupported';
  return `
  <header class="top"><a class="back" href="#home">${ICON.back}Back</a><h1>Settings</h1><span></span></header>
  <section class="panel"><h3>Color scheme</h3>
    <div class="schemes">${schemeList().map((sc) => `<button class="scheme" data-act="pick-theme" data-id="${esc(sc.id)}" aria-pressed="${sc.id === activeScheme().id}" data-base="${esc(sc.base)}">
      <span class="sw">${schemeColors(sc).slice(0, 5).map((c) => `<i style="--c:${esc(c)}"></i>`).join('')}</span>
      <span class="nm">${esc(sc.name)}</span>${sc.custom ? `<span class="ed" data-act="edit-theme" data-id="${esc(sc.id)}">Edit</span>` : ''}
    </button>`).join('')}</div>
    <div class="btns"><button class="btn" data-act="edit-theme">+ Create custom scheme</button></div>
    <p style="margin:8px 0 0;color:var(--muted);font-size:13px">Each scheme has a light and dark version that follows your phone's setting.</p>
  </section>
  <section class="panel"><h3>Classes &amp; activities</h3>
    ${active.map((c) => `<button class="row" style="--c:${esc(c.color)}" data-act="edit-course" data-course="${esc(c.id)}">
      <span class="dot"></span><span><span class="t">${esc(c.name)}</span><span class="s" style="display:block">${esc([c.code, sched(c.id)].filter(Boolean).join(' · ') || 'No class times')}</span></span>${ICON.chev.replace('<svg', '<svg width="18" fill="currentColor"')}
    </button>`).join('')}
    <div class="btns"><button class="btn" data-act="edit-course">+ Add class or activity</button></div>
    ${archived.length ? `<details style="margin-top:10px"><summary style="color:var(--muted);font-size:14px">Hidden (${archived.length})</summary>
      ${archived.map((c) => `<button class="row" style="--c:${esc(c.color)}" data-act="edit-course" data-course="${esc(c.id)}"><span class="dot"></span><span class="t">${esc(c.name)}</span><span></span></button>`).join('')}</details>` : ''}
  </section>
  <section class="panel"><h3>Semesters</h3>
    ${[...cfg.semesters].sort((a, b) => b.start.localeCompare(a.start)).map((s) => `<button class="row" data-act="edit-sem" data-id="${esc(s.id)}" style="--c:var(--line)">
      <span class="dot"></span><span><span class="t">${esc(s.name)}</span>${s.id === sem?.id ? '<span class="tag">current</span>' : ''}<span class="s" style="display:block">${esc(s.start)} → ${esc(s.end)} · ${s.schedule.length} class time${s.schedule.length === 1 ? '' : 's'}</span></span><span></span>
    </button>`).join('')}
    <div class="btns"><button class="btn" data-act="edit-sem">+ Add semester</button></div>
  </section>
  <section class="panel"><h3>"Other" activity options</h3>
    <div class="pill-list">${cfg.activities.map((a, i) => `<span class="pill">${esc(a)}<button data-act="del-activity" data-i="${i}" aria-label="Remove ${esc(a)}">×</button></span>`).join('')}</div>
    <form class="inline-add" data-form="add-activity"><input class="input" name="a" placeholder="e.g. Study group" maxlength="40"><button class="btn">Add</button></form>
  </section>
  <section class="panel"><h3>Reminders</h3>
    <label class="switch-row"><span><span class="t">Long-timer reminder</span>
      <span class="s">One notification if a stopwatch runs without a pause</span></span>
      <input type="checkbox" role="switch" class="switch" data-act="reminder-toggle" ${reminderCfg().enabled ? 'checked' : ''}></label>
    ${reminderCfg().enabled ? `<label class="field" style="margin-top:12px"><span>Remind me after</span>
      <select class="input" data-reminder-minutes>${[...new Set([...REMIND_CHOICES, reminderCfg().minutes])].sort((a, b) => a - b)
        .map((m) => `<option value="${m}" ${m === reminderCfg().minutes ? 'selected' : ''}>${fmtMinutes(m)}</option>`).join('')}</select></label>
    <p style="margin:0 0 10px;color:var(--muted);font-size:13px">Applies on all your devices. It can arrive up to 5 minutes after this time.</p>
    ${perm === 'unsupported' || (isIOS() && !isStandalone())
      ? '<p style="margin:0;font-size:14px">On iPhone, first add this app to your Home Screen (Share → Add to Home Screen), then open it from there and turn reminders on.</p>'
      : perm === 'granted'
        ? '<div class="btns"><button class="btn" data-act="enable-push">Re-register this device</button><button class="btn" data-act="test-push">Send a test notification</button></div>'
        : perm === 'denied'
          ? '<p style="margin:0;font-size:14px">Notifications are blocked. Turn them on in your phone\'s Settings → Notifications → Study.</p>'
          : '<div class="btns"><button class="btn primary" data-act="enable-push">Allow notifications on this device</button></div>'}` : ''}
  </section>
  <section class="panel"><h3>Signed-in devices</h3>
    <p style="margin:0 0 6px;color:var(--muted);font-size:13px">Each device stays signed in for 30 days.</p>
    ${devices ? devices.map((d) => `<div class="row" style="--c:${d.current ? 'var(--go)' : 'var(--line)'}">
      <span class="dot"></span><span><span class="t">${esc(d.device)}</span>${d.current ? '<span class="tag">this device</span>' : ''}
      <span class="s" style="display:block">Last used ${esc(fmtDate(d.lastSeen, { month: 'short', day: 'numeric' }))} · until ${esc(fmtDate(d.expires, { month: 'short', day: 'numeric' }))}</span></span>
      ${d.current ? '<span></span>' : `<button class="btn small" data-act="remove-device" data-id="${esc(d.id)}">Remove</button>`}
    </div>`).join('') : '<p class="s" style="color:var(--muted)">Loading…</p>'}
  </section>
  <div class="btns"><button class="btn danger" data-act="logout">Sign out on this device</button></div>`;
}
let devicesLoading = false;
function loadDevices() {
  if (devicesLoading) return;
  devicesLoading = true;
  api('GET', '/devices').then((r) => { devices = r.devices; if (route().name === 'settings') render(); })
    .catch(() => {}).finally(() => { devicesLoading = false; });
}

function deviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (/Mac/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
    : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Device';
  const br = /CriOS|Chrome/.test(ua) && !/Edg/.test(ua) ? 'Chrome' : /Edg/.test(ua) ? 'Edge' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : 'Safari';
  return `${os} · ${isStandalone() ? 'Home Screen app' : br}`;
}

function viewLogin() {
  return `<form class="login" data-form="login">
    <h1>Study Tracker</h1>
    <p>Sign in once — this device stays signed in for 30 days.</p>
    <input class="input" name="password" type="password" autocomplete="current-password" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Password" required>
    <button class="btn primary">Continue</button>
  </form>`;
}

// ============ sheets ============
function openSheet(html, onMount) {
  const root = $('#sheet-root');
  root.innerHTML = `<div class="scrim" data-act="close-sheet"><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div></div>`;
  onMount?.(root.querySelector('.sheet'));
}
const closeSheet = () => { $('#sheet-root').innerHTML = ''; };

function otherSheet(courseId) {
  const acts = data.config.activities;
  openSheet(`<h2>What are you doing?</h2>
    <div class="opt-list">${acts.map((a) => `<button class="chip" data-act="pick-other" data-course="${esc(courseId)}" data-label="${esc(a)}">${esc(a)}</button>`).join('')}</div>
    <form class="inline-add" data-form="custom-other" data-course="${esc(courseId)}">
      <input class="input" name="label" placeholder="Or type something…" maxlength="40" autocomplete="off">
      <button class="btn primary">Use</button>
    </form>`);
}

function sessionSheet(id) {
  const s = id ? data.sessions.find((x) => x.id === id) : null;
  const base = s ?? { course: courses().find((c) => !c.archived)?.id, category: 'study', start: now() - 3600e3, end: now() };
  const opts = courses().filter((c) => !c.archived || c.id === base.course);
  if (!opts.some((c) => c.id === base.course)) opts.push(course(base.course));
  const catVal = base.category === 'other' ? `other:${base.label ?? ''}` : base.category;
  const otherOpts = [...new Set([...data.config.activities, ...(base.category === 'other' && base.label ? [base.label] : [])])];
  openSheet(`<h2>${s ? 'Edit session' : 'Add session'}</h2>
    <form data-form="session" data-id="${esc(id ?? '')}">
      <label class="field"><span>Class</span><select class="input" name="course">${opts.map((c) => `<option value="${esc(c.id)}" ${c.id === base.course ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Activity</span><select class="input" name="cat">
        ${CATS.map(([k, l]) => `<option value="${k}" ${catVal === k ? 'selected' : ''}>${l}</option>`).join('')}
        ${otherOpts.map((a) => `<option value="other:${esc(a)}" ${catVal === `other:${a}` ? 'selected' : ''}>${esc(a)}</option>`).join('')}
        <option value="other:">Other…</option>
      </select></label>
      <label class="field" data-custom ${catVal === 'other:' ? '' : 'hidden'}><span>Describe it</span><input class="input" name="label" maxlength="40" value=""></label>
      <label class="field"><span>Date</span><input class="input" type="date" name="date" value="${dateKey(base.start)}" required></label>
      <div class="two">
        <label class="field"><span>Start</span><input class="input" type="time" name="start" value="${timeKey(base.start)}" required></label>
        <label class="field"><span>End</span><input class="input" type="time" name="end" value="${timeKey(base.end)}" required></label>
      </div>
      <label class="field"><span>Note</span><textarea class="input" name="note" rows="2" maxlength="500">${esc(base.note ?? '')}</textarea></label>
      <div class="btns">
        <button class="btn primary">Save</button>
        ${s ? `<button type="button" class="btn danger" data-act="delete-session" data-id="${esc(id)}">Delete session</button>` : ''}
        <button type="button" class="btn" data-act="close-sheet">Cancel</button>
      </div>
    </form>`, (el) => {
    el.querySelector('[name=cat]').addEventListener('change', (e) => { el.querySelector('[data-custom]').hidden = e.target.value !== 'other:'; });
  });
}

function meetingHtml(m, i, withCourse) {
  return `<div class="meeting" data-i="${i}">
    ${withCourse ? `<label class="field"><span>Class</span><select class="input" data-m="course">${courses().map((c) => `<option value="${esc(c.id)}" ${c.id === m.course ? 'selected' : ''}>${esc(c.short)}</option>`).join('')}</select></label>` : ''}
    <div class="days" style="margin-bottom:10px">${DOWS.map((d) => `<button type="button" class="chip" data-act="toggle-day" data-day="${d}" aria-pressed="${m.days.includes(d)}">${d}</button>`).join('')}</div>
    <div class="two">
      <label class="field"><span>Starts</span><input class="input" type="time" data-m="start" value="${esc(m.start)}"></label>
      <label class="field"><span>Ends</span><input class="input" type="time" data-m="end" value="${esc(m.end)}"></label>
    </div>
    <button type="button" class="btn danger small" data-act="del-meeting">Remove these times</button>
  </div>`;
}
// Read meeting editors back into objects.
function readMeetings(el, fixedCourse) {
  return [...el.querySelectorAll('.meeting')].map((m) => ({
    id: m.dataset.id || uid(),
    course: fixedCourse ?? m.querySelector('[data-m=course]').value,
    days: [...m.querySelectorAll('[data-day][aria-pressed=true]')].map((b) => b.dataset.day),
    start: m.querySelector('[data-m=start]').value,
    end: m.querySelector('[data-m=end]').value,
  }));
}
function wireMeetings(el, withCourse, fixedCourse) {
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'toggle-day') { b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') !== 'true'); e.stopPropagation(); }
    if (b.dataset.act === 'del-meeting') { b.closest('.meeting').remove(); e.stopPropagation(); }
    if (b.dataset.act === 'add-meeting') {
      const wrap = el.querySelector('[data-meetings]');
      wrap.insertAdjacentHTML('beforeend', meetingHtml({ course: fixedCourse ?? courses()[0]?.id, days: [], start: '09:00', end: '10:00' }, wrap.children.length, withCourse));
      e.stopPropagation();
    }
  });
}

function courseSheet(id) {
  const c = id ? course(id) : { id: uid(), name: '', short: '', code: '' };
  const sem = currentSemester();
  const meetings = (sem?.schedule ?? []).filter((m) => m.course === c.id);
  openSheet(`<h2>${id ? 'Edit' : 'New'} class or activity</h2>
    <form data-form="course" data-id="${esc(c.id)}" data-new="${id ? '' : '1'}">
      <label class="field"><span>Name</span><input class="input" name="name" value="${esc(c.name)}" placeholder="e.g. Evidence, Moot Court, Bar prep" required maxlength="80"></label>
      <div class="two">
        <label class="field"><span>Short name (on card)</span><input class="input" name="short" value="${esc(c.short)}" maxlength="20" placeholder="Optional"></label>
        <label class="field"><span>Course code</span><input class="input" name="code" value="${esc(c.code ?? '')}" maxlength="20" placeholder="Optional"></label>
      </div>
      <p style="margin:-4px 0 14px;color:var(--muted);font-size:13px">Colors come from your color scheme — change them in Settings → Color scheme.</p>
      ${sem ? `<div class="field"><span>Class times — ${esc(sem.name)} (logged automatically)</span>
        <div data-meetings>${meetings.map((m, i) => meetingHtml(m, i, false).replace('class="meeting"', `class="meeting" data-id="${esc(m.id)}"`)).join('')}</div>
        <button type="button" class="btn small" data-act="add-meeting">+ Add class times</button></div>` : ''}
      <div class="btns">
        <button class="btn primary">Save</button>
        ${id ? `<button type="button" class="btn" data-act="archive-course" data-course="${esc(c.id)}">${c.archived ? 'Show on home screen' : 'Hide from home screen'}</button>` : ''}
        <button type="button" class="btn" data-act="close-sheet">Cancel</button>
      </div>
    </form>`, (el) => {
    wireMeetings(el, false, c.id);
  });
}

function semesterSheet(id) {
  const cfg = data.config;
  const s = id ? cfg.semesters.find((x) => x.id === id) : { id: uid(), name: '', start: '', end: '', noClass: [], schedule: [] };
  openSheet(`<h2>${id ? 'Edit' : 'New'} semester</h2>
    <form data-form="sem" data-id="${esc(s.id)}">
      <label class="field"><span>Name</span><input class="input" name="name" value="${esc(s.name)}" placeholder="e.g. Winter 2027" required maxlength="40"></label>
      <div class="two">
        <label class="field"><span>First day of class</span><input class="input" type="date" name="start" value="${esc(s.start)}" required></label>
        <label class="field"><span>Last day of class</span><input class="input" type="date" name="end" value="${esc(s.end)}" required></label>
      </div>
      <div class="field"><span>No-class days (holidays)</span>
        <div class="pill-list" data-noclass>${s.noClass.map((d) => `<span class="pill" data-d="${esc(d)}">${esc(d)}<button type="button" data-act="del-pill">×</button></span>`).join('')}</div>
        <div class="inline-add"><input class="input" type="date" data-newday><button type="button" class="btn small" data-act="add-noclass">Add</button></div>
      </div>
      <div class="field"><span>Class times (logged automatically)</span>
        <div data-meetings>${s.schedule.map((m, i) => meetingHtml(m, i, true).replace('class="meeting"', `class="meeting" data-id="${esc(m.id)}"`)).join('')}</div>
        <button type="button" class="btn small" data-act="add-meeting">+ Add class times</button>
      </div>
      <div class="btns">
        <button class="btn primary">Save</button>
        ${id ? `<button type="button" class="btn danger" data-act="delete-sem" data-id="${esc(s.id)}">Delete semester</button>` : ''}
        <button type="button" class="btn" data-act="close-sheet">Cancel</button>
      </div>
    </form>`, (el) => {
    wireMeetings(el, true);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.act === 'del-pill') { b.closest('.pill').remove(); e.stopPropagation(); }
      if (b.dataset.act === 'add-noclass') {
        const inp = el.querySelector('[data-newday]');
        if (inp.value) el.querySelector('[data-noclass]').insertAdjacentHTML('beforeend', `<span class="pill" data-d="${esc(inp.value)}">${esc(inp.value)}<button type="button" data-act="del-pill">×</button></span>`);
        inp.value = '';
        e.stopPropagation();
      }
    });
  });
}

function schemeList() {
  return [
    ...Object.entries(PRESETS).map(([id, p]) => ({ id, base: id, name: p.name, preset: p })),
    ...(data.config.themes ?? []).map((t) => ({ id: t.id, base: t.base, name: t.name, custom: t })),
  ];
}
function schemeColors(sc) {
  return (data.config.courses ?? []).filter((c) => !c.archived).map((c) => colorFor(c.id, data.config.courses.indexOf(c), sc));
}

function themeSheet(id) {
  const existing = id ? data.config.themes.find((t) => t.id === id) : null;
  const from = existing ? { id, base: existing.base, custom: existing } : activeScheme();
  const list = data.config.courses.map((c, i) => ({ c, i })).filter(({ c }) => !c.archived);
  openSheet(`<h2>${existing ? 'Edit' : 'New'} color scheme</h2>
    <form data-form="theme" data-id="${esc(id ?? '')}">
      <label class="field"><span>Name</span><input class="input" name="name" value="${esc(existing?.name ?? '')}" placeholder="e.g. Sunset" required maxlength="30"></label>
      <div class="field"><span>Background style</span><div class="seg" role="group" style="margin:0">
        ${Object.entries(PRESETS).map(([k, p]) => `<button type="button" data-base-pick="${k}" aria-pressed="${from.base === k}">${p.name}</button>`).join('')}</div></div>
      <div class="field"><span>Class colors</span>
        ${list.map(({ c, i }) => `<label class="color-row" style="--c:${esc(colorFor(c.id, i, from))}"><span class="mini-card">${esc(c.short)}</span>
          <input type="color" name="c:${esc(c.id)}" value="${esc(colorFor(c.id, i, from))}" aria-label="${esc(c.short)} color"></label>`).join('')}
      </div>
      <div class="btns">
        <button class="btn primary">Save &amp; use</button>
        ${existing ? `<button type="button" class="btn danger" data-act="delete-theme" data-id="${esc(id)}">Delete scheme</button>` : ''}
        <button type="button" class="btn" data-act="close-sheet">Cancel</button>
      </div>
    </form>`, (el) => {
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-base-pick]'); if (!b) return;
      el.querySelectorAll('[data-base-pick]').forEach((x) => x.setAttribute('aria-pressed', x === b));
      e.stopPropagation();
    });
    el.addEventListener('input', (e) => {
      if (e.target.type === 'color') e.target.closest('.color-row').style.setProperty('--c', e.target.value);
    });
  });
}

// ============ push ============
function urlB64ToUint8(b64) {
  const s = atob((b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (ch) => ch.charCodeAt(0));
}
async function enablePush(silent = false) {
  try {
    if (!pushSupported()) throw new Error('Notifications not supported here');
    if (!silent && (await Notification.requestPermission()) !== 'granted') { toast('Notifications not allowed'); render(); return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(data.vapidPublicKey) });
    await api('POST', '/subscribe', { subscription: sub.toJSON() });
    if (!silent) toast('Reminders are on');
  } catch (e) {
    if (!silent) toast(e.message);
  }
  render();
}

// ============ router + render ============
function route() {
  const [name, arg] = location.hash.replace(/^#/, '').split('/');
  return { name: name || 'home', arg: arg && decodeURIComponent(arg) };
}
function render() {
  const app = $('#app');
  const tabbar = $('#tabbar');
  applyTheme();
  if (!auth) { app.innerHTML = viewLogin(); tabbar.hidden = true; return; }
  if (!data) { app.innerHTML = '<p class="empty">Loading…</p>'; tabbar.hidden = true; return; }
  const r = route();
  // Keep focus/caret in the note box across re-renders.
  const noteFocused = document.activeElement?.id === 'note';
  const noteVal = $('#note')?.value;
  let html;
  if (r.name === 'timer') html = viewTimer(r.arg || data.active?.course || courses()[0]?.id);
  else if (r.name === 'stats') html = viewStats();
  else if (r.name === 'history') html = viewHistory();
  else if (r.name === 'settings') { html = viewSettings(); if (!devices) loadDevices(); }
  else html = viewHome();
  app.innerHTML = html;
  if (noteFocused && $('#note')) { $('#note').value = noteVal; $('#note').focus(); }
  tabbar.hidden = false;
  tabbar.querySelectorAll('a').forEach((a) => a.setAttribute('aria-current', a.dataset.tab === (r.name === 'timer' ? 'home' : r.name) ? 'page' : 'false'));
}

function tick() {
  if (!data) return;
  const a = data.active;
  document.querySelectorAll('[data-tick]').forEach((el) => {
    const t = el.dataset.tick;
    if (t === 'session' && a) el.textContent = fmtClock(now() - a.start);
    else if (t === 'today') el.textContent = fmtHM(todayMs(el.dataset.course));
    else if (t === 'today-clock') el.textContent = fmtClock(todayMs(el.dataset.course));
    else if (t === 'ring' && a) el.setAttribute('stroke-dashoffset', el.dataset.circ * (1 - Math.min(1, (now() - a.start) / (reminderCfg().minutes * 60e3))));
  });
}

// ============ events ============
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act, course: cid, id } = el.dataset;
  if (act === 'close-sheet') { if (e.target === el) closeSheet(); return; }
  switch (act) {
    case 'cat': setCategory(cid, el.dataset.cat); break;
    case 'other': otherSheet(cid); break;
    case 'pick-other': closeSheet(); setCategory(cid, 'other', el.dataset.label); break;
    case 'start': start(cid); break;
    case 'pause': pause(); break;
    case 'open': location.hash = `#timer/${encodeURIComponent(cid)}`; break;
    case 'hide-install': ls.set(KEY.hideInstall, true); render(); break;
    case 'enable-push': enablePush(); break;
    case 'test-push': api('POST', '/test-push').then((r) => toast(r.sent ? 'Sent — check your notifications' : 'No devices registered yet')).catch((err) => toast(err.message)); break;
    case 'stats-mode': ui.statsMode = el.dataset.mode; ui.statsOffset = 0; render(); break;
    case 'stats-shift': ui.statsOffset = Math.min(0, ui.statsOffset + Number(el.dataset.d)); render(); break;
    case 'stats-course': ui.statsCourse = cid || null; render(); if (cid) $('#breakdown')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); break;
    case 'more': ui.historyLimit += 60; render(); break;
    case 'edit-session': sessionSheet(id); break;
    case 'delete-session':
      if (confirm('Delete this session?')) { closeSheet(); mutate(() => { data.sessions = data.sessions.filter((s) => s.id !== id); }, 'DELETE', `/sessions/${encodeURIComponent(id)}`, null, 'Deleted'); }
      break;
    case 'edit-course': courseSheet(cid); break;
    case 'archive-course': {
      const cfg = clone(data.config);
      const c = cfg.courses.find((x) => x.id === cid);
      c.archived = !c.archived;
      closeSheet(); saveConfig(cfg, c.archived ? 'Hidden from home' : 'Back on home');
      break;
    }
    case 'edit-sem': semesterSheet(id); break;
    case 'pick-theme': {
      if (e.target.closest('[data-act=edit-theme]')) return;
      const cfg = clone(data.config); cfg.theme = id; saveConfig(cfg, null);
      break;
    }
    case 'edit-theme': e.stopPropagation(); themeSheet(id); break;
    case 'delete-theme':
      if (confirm('Delete this color scheme?')) {
        const cfg = clone(data.config);
        cfg.themes = cfg.themes.filter((t) => t.id !== id);
        if (cfg.theme === id) cfg.theme = 'blossom';
        closeSheet(); saveConfig(cfg, 'Scheme deleted');
      }
      break;
    case 'delete-sem':
      if (confirm('Delete this semester? Logged sessions are kept.')) {
        const cfg = clone(data.config); cfg.semesters = cfg.semesters.filter((s) => s.id !== id);
        closeSheet(); saveConfig(cfg, 'Semester deleted');
      }
      break;
    case 'del-activity': { const cfg = clone(data.config); cfg.activities.splice(Number(el.dataset.i), 1); saveConfig(cfg, 'Removed'); break; }
    case 'reminder-toggle': {
      const cfg = clone(data.config);
      cfg.reminder = { ...reminderCfg(), enabled: el.checked };
      saveConfig(cfg, el.checked ? 'Reminder on' : 'Reminder off');
      break;
    }
    case 'logout':
      if (confirm('Sign out on this device?')) {
        api('POST', '/logout').catch(() => {});
        auth = null; data = null; ls.del(KEY.auth); ls.del(KEY.cache); render();
      }
      break;
    case 'remove-device':
      api('DELETE', `/devices/${id}`).then(() => { devices = devices.filter((d) => d.id !== id); render(); toast('Device signed out'); }).catch((err) => toast(err.message));
      break;
    default: return;
  }
});

document.addEventListener('submit', (e) => {
  const f = e.target.closest('[data-form]');
  if (!f) return;
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(f));
  const kind = f.dataset.form;

  if (kind === 'login') {
    const btn = f.querySelector('button'); btn.disabled = true;
    api('POST', '/login', { password: fd.password, device: deviceName() })
      .then((r) => { auth = { token: r.token, expires: r.expires }; ls.set(KEY.auth, auth); return api('GET', '/state'); })
      .then(() => { render(); setTimeout(() => pushSupported() && Notification.permission === 'granted' && enablePush(true), 500); })
      .catch((err) => { btn.disabled = false; toast(err.message === 'Failed to fetch' ? 'No connection' : err.message); });
    return;
  }
  if (kind === 'custom-other') {
    const label = fd.label.trim();
    if (!label) return;
    closeSheet();
    if (!data.config.activities.includes(label)) {
      const cfg = clone(data.config); cfg.activities.push(label);
      saveConfig(cfg, null).then(() => setCategory(f.dataset.course, 'other', label));
    } else setCategory(f.dataset.course, 'other', label);
    return;
  }
  if (kind === 'add-activity') {
    const a = fd.a.trim();
    if (!a || data.config.activities.includes(a)) return;
    const cfg = clone(data.config); cfg.activities.push(a); saveConfig(cfg, 'Added');
    return;
  }
  if (kind === 'session') {
    const start = new Date(`${fd.date}T${fd.start}`).getTime();
    let end = new Date(`${fd.date}T${fd.end}`).getTime();
    if (end <= start) end = addDays(end, 1); // crossed midnight
    const [category, ...rest] = fd.cat.split(':');
    const label = category === 'other' ? (rest.join(':') || fd.label?.trim() || 'Other') : undefined;
    const body = { course: fd.course, category, label, start, end, note: fd.note.trim() || undefined };
    const id = f.dataset.id;
    closeSheet();
    if (id) mutate(() => { Object.assign(data.sessions.find((s) => s.id === id), body); }, 'PUT', `/sessions/${encodeURIComponent(id)}`, body, 'Saved');
    else mutate(() => { data.sessions.push({ id: 'tmp', ...body }); }, 'POST', '/sessions', body, 'Added');
    return;
  }
  if (kind === 'course') {
    const cfg = clone(data.config);
    const id = f.dataset.id;
    const next = { id, name: fd.name.trim(), short: (fd.short || fd.name).trim().slice(0, 20), code: fd.code.trim() || undefined };
    const i = cfg.courses.findIndex((c) => c.id === id);
    if (i >= 0) cfg.courses[i] = { ...cfg.courses[i], ...next }; else cfg.courses.push(next);
    cfg.courses.forEach((x) => delete x.color);
    const sem = currentSemester();
    if (sem) {
      const s = cfg.semesters.find((x) => x.id === sem.id);
      s.schedule = [...s.schedule.filter((m) => m.course !== id), ...readMeetings(f, id).filter((m) => m.days.length)];
    }
    closeSheet(); saveConfig(cfg);
    return;
  }
  if (kind === 'theme') {
    const cfg = clone(data.config);
    const id = f.dataset.id || uid();
    const colors = {};
    for (const [k, v] of Object.entries(fd)) if (k.startsWith('c:')) colors[k.slice(2)] = v;
    const next = { id, name: fd.name.trim(), base: f.querySelector('[data-base-pick][aria-pressed=true]')?.dataset.basePick ?? 'blossom', colors };
    cfg.themes = [...(cfg.themes ?? []).filter((t) => t.id !== id), next];
    cfg.theme = id;
    closeSheet(); saveConfig(cfg, 'Scheme saved');
    return;
  }
  if (kind === 'sem') {
    if (fd.end < fd.start) { toast('Last day must be after first day'); return; }
    const cfg = clone(data.config);
    const next = {
      id: f.dataset.id, name: fd.name.trim(), start: fd.start, end: fd.end,
      noClass: [...f.querySelectorAll('[data-noclass] [data-d]')].map((p) => p.dataset.d).sort(),
      schedule: readMeetings(f).filter((m) => m.days.length),
    };
    const i = cfg.semesters.findIndex((s) => s.id === next.id);
    if (i >= 0) cfg.semesters[i] = next; else cfg.semesters.push(next);
    closeSheet(); saveConfig(cfg);
  }
});

document.addEventListener('change', (e) => {
  if (!e.target.matches('[data-reminder-minutes]')) return;
  const cfg = clone(data.config);
  cfg.reminder = { ...reminderCfg(), minutes: Number(e.target.value) };
  saveConfig(cfg, `Reminder at ${fmtMinutes(cfg.reminder.minutes)}`);
});

// Note box: save to the running timer (debounced), or hold it for the next start.
let noteTimer;
document.addEventListener('input', (e) => {
  if (e.target.id !== 'note') return;
  const cid = e.target.dataset.course;
  const val = e.target.value;
  if (data.active?.course === cid) {
    data.active.note = val;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => api('POST', '/active', { note: val }).catch(() => {}), 800);
  } else {
    pendingNotes[cid] = val; ls.set(KEY.notes, pendingNotes);
  }
});

darkMQ.addEventListener('change', render);
window.addEventListener('hashchange', () => { closeSheet(); if (route().name === 'settings') devices = null; render(); window.scrollTo(0, 0); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
setInterval(tick, 1000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.url) location.hash = e.data.url.split('#')[1] ?? ''; });
}

render();
refresh().then(() => { if (auth && pushSupported() && Notification.permission === 'granted') enablePush(true); });
