import { Store, LockedError, explain, uid, deepMerge } from './store.js';
import * as S from './stats.js';
import * as C from './charts.js';
import { CFG } from './config.js';

const store = new Store();
window.tally = store; // handy from the browser console

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

// ---------------------------------------------------------------- constants
const PALETTES = {
  classic: { name: 'Classic', bad: '#c8553d', mid: '#d9a441', good: '#4b9b6e' },
  calm: { name: 'Calm', bad: '#b0607a', mid: '#cdb07a', good: '#4a8f8c' },
  vivid: { name: 'Vivid', bad: '#e0413a', mid: '#f2b32b', good: '#2fa865' },
  colorblind: { name: 'Colour-blind safe', bad: '#d9711c', mid: '#b8b2a7', good: '#2f78c4' },
};
const DEFAULT_PREFS = {
  theme: 'auto', colorMode: 'semantic', palette: { bad: PALETTES.classic.bad, mid: PALETTES.classic.mid, good: PALETTES.classic.good },
  weekStart: 1, sections: { timeline: true, heatmap: true, when: true, gaps: true, recent: true },
  logDetails: true, // + opens a sheet with date and comment; false = log instantly
};
const SECTIONS = [
  { id: 'timeline', name: 'Over time', desc: 'Bars per day, week or month with a rolling average' },
  { id: 'heatmap', name: 'Calendar heatmap', desc: 'Every day of the year, coloured by frequency' },
  { id: 'when', name: 'When it happens', desc: 'Weekday × hour pattern, by weekday, by hour' },
  { id: 'gaps', name: 'Time between entries', desc: 'How long you go between occurrences' },
  { id: 'recent', name: 'Recent entries', desc: 'The latest entries for the habit' },
];
const SWATCHES = ['#c8553d', '#d9822b', '#d9a441', '#8a9a3a', '#4b9b6e', '#3f8f9a', '#3f6fb5', '#6a5bb5', '#a35b9a', '#7a746b'];
const EMOJIS = ['🚬', '💨', '📱', '🍺', '🍷', '🍬', '🍔', '☕', '🎮', '📺', '💸', '🛒', '😤', '🌙', '🛌', '💧', '🏃', '🏋️', '🚶', '📖', '🧘', '🥗', '🍎', '😴', '✍️', '🎸', '🧹', '💊', '🙏', '🌿', '⭐'];
const SUGGEST = [
  { name: 'Smoking', emoji: '🚬', kind: 'bad' },
  { name: 'Vaping', emoji: '💨', kind: 'bad' },
  { name: 'Doomscrolling', emoji: '📱', kind: 'bad' },
  { name: 'Alcohol', emoji: '🍺', kind: 'bad' },
  { name: 'Junk food', emoji: '🍔', kind: 'bad' },
  { name: 'Sugar', emoji: '🍬', kind: 'bad' },
  { name: 'Impulse buying', emoji: '🛒', kind: 'bad' },
  { name: 'Losing temper', emoji: '😤', kind: 'bad' },
  { name: 'Staying up late', emoji: '🌙', kind: 'bad' },
  { name: 'Water', emoji: '💧', kind: 'good', goal: { type: 'min', count: 8, period: 'day' } },
  { name: 'Exercise', emoji: '🏃', kind: 'good', goal: { type: 'min', count: 3, period: 'week' } },
  { name: 'Walk', emoji: '🚶', kind: 'good' },
  { name: 'Reading', emoji: '📖', kind: 'good' },
  { name: 'Meditation', emoji: '🧘', kind: 'good' },
  { name: 'Healthy meal', emoji: '🥗', kind: 'good' },
  { name: 'Early night', emoji: '😴', kind: 'good' },
  { name: 'Journaling', emoji: '✍️', kind: 'good' },
  { name: 'Coffee', emoji: '☕', kind: 'neutral' },
  { name: 'Medication', emoji: '💊', kind: 'neutral' },
];
// Suggestions not yet added, as chips. act: what tapping one does.
function suggestionChips(act, picked = new Set()) {
  const have = new Set(store.view.habits.map(h => h.name.toLowerCase()));
  const group = kinds => SUGGEST.map((s, i) => [s, i])
    .filter(([s]) => kinds.includes(s.kind) && !have.has(s.name.toLowerCase()))
    .map(([s, i]) => `<button type="button" class="chip ${picked.has(i) ? 'on' : ''}" data-act="${act}" data-v="${i}" aria-pressed="${picked.has(i)}">${s.emoji} ${esc(s.name)}</button>`).join('');
  const less = group(['bad']);
  const more = group(['good', 'neutral']);
  return `${less ? `<h4>Do less</h4><div class="chips wrap">${less}</div>` : ''}${more ? `<h4>Do more, or just count</h4><div class="chips wrap">${more}</div>` : ''}`;
}
const KIND = {
  bad: { tag: 'Break', long: 'Bad habit · less is better' },
  good: { tag: 'Build', long: 'Good habit · more is better' },
  neutral: { tag: 'Track', long: 'Just tracking' },
};
const TABS = [
  { id: 'log', name: 'Today', icon: 'log' },
  { id: 'dash', name: 'Dashboard', icon: 'dash' },
  { id: 'cal', name: 'Calendar', icon: 'cal' },
  { id: 'hist', name: 'History', icon: 'hist' },
  { id: 'set', name: 'Settings', icon: 'set' },
];

const svgI = d => `<svg viewBox="0 0 24 24" class="i" aria-hidden="true">${d}</svg>`;
const ICON = {
  log: svgI('<circle cx="12" cy="12" r="8.5"/><path d="M12 8.5v7M8.5 12h7"/>'),
  dash: svgI('<path d="M5 19.5v-6M10 19.5V5M15 19.5v-9M20 19.5v-3.5M3 19.5h18"/>'),
  cal: svgI('<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'),
  hist: svgI('<path d="M5 7h14M5 12h14M5 17h9"/>'),
  set: svgI('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),
  plus: svgI('<path d="M12 5v14M5 12h14"/>'),
  more: svgI('<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>'),
  left: svgI('<path d="M14.5 6 8.5 12l6 6"/>'),
  right: svgI('<path d="m9.5 6 6 6-6 6"/>'),
  up: svgI('<path d="m6 14.5 6-6 6 6"/>'),
  down: svgI('<path d="m6 9.5 6 6 6-6"/>'),
  edit: svgI('<path d="M5 19h3.5L19 8.5 15.5 5 5 15.5V19Z"/>'),
  eye: svgI('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>'),
  lock: svgI('<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>'),
  close: svgI('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  archive: svgI('<rect x="3.5" y="4.5" width="17" height="4.5" rx="1.2"/><path d="M5 9v9.5c0 .8.7 1.5 1.5 1.5h11c.8 0 1.5-.7 1.5-1.5V9M10 13h4"/>'),
  trash: svgI('<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5M14 11v5"/>'),
  hide: svgI('<path d="M3 3l18 18M10.6 6.1c.5-.1.9-.1 1.4-.1 6 0 9.5 6 9.5 6s-1 1.8-3 3.6M6.5 7.5C4 9.2 2.5 12 2.5 12S6 18 12 18c1.4 0 2.7-.3 3.8-.9"/>'),
  order: svgI('<path d="M8 4v16M4.5 7.5 8 4l3.5 3.5M16 20V4M12.5 16.5 16 20l3.5-3.5"/>'),
};
const LOGO = `<svg viewBox="0 0 64 64" class="logo" aria-hidden="true"><rect width="64" height="64" rx="16" fill="currentColor"/><g stroke="var(--logo-ink)" stroke-width="3.6" stroke-linecap="round"><path d="M20 18v28M27.5 18v28M35 18v28M42.5 18v28"/><path d="M14.5 39.5 49 23.5"/></g></svg>`;

// ---------------------------------------------------------------- formatting
const nf1 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const fmt = x => (x == null || !Number.isFinite(x) ? '—' : Math.abs(x) >= 100 ? nf0.format(x) : nf1.format(x));
const fmtInt = x => nf0.format(x);
const pct = x => (x == null || !Number.isFinite(x) ? '—' : `${Math.round(x * 100)}%`);
const H12 = !!new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12;
const hourLabel = h => (H12 ? `${h % 12 || 12}${h < 12 ? 'a' : 'p'}` : String(h).padStart(2, '0'));
const hourLong = h => { const d = new Date(2024, 0, 1, h); return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); };
const hourRange = h => `${hourLong(h)}–${hourLong((h + 1) % 24)}`;
const dayName = i => new Date(2024, 0, 7 + i).toLocaleDateString(undefined, { weekday: 'short' });
const dayLong = i => new Date(2024, 0, 7 + i).toLocaleDateString(undefined, { weekday: 'long' });
const monthName = d => d.toLocaleDateString(undefined, { month: 'short' });
const fmtShort = d => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const fmtDay = d => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = d => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtDateTime = d => `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${fmtTime(d)}`;
function dur(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ${h % 24}h`;
  if (d < 60) return `${d}d`;
  if (d < 365) return `${Math.round(d / 30.44)} mo`;
  return `${nf1.format(d / 365.25)} y`;
}
const goalText = g => (g && g.type ? `${g.type === 'max' ? 'at most' : 'at least'} ${fmt(g.count)} per ${g.period}` : '');
const streakLabel = h => (h.kind === 'bad' ? (h.goal?.type === 'max' && (h.goal.period === 'week' || h.goal.count > 0) ? 'Within limit' : 'Clean streak') : h.kind === 'good' ? 'Streak' : 'Active streak');

// ---------------------------------------------------------------- derived data (memoised per data version)
let memo = { view: null };
function M() {
  if (memo.view !== store.view) memo = { view: store.view, daily: new Map(), ref: new Map(), prefs: null };
  return memo;
}
const prefs = () => (store.view ? (M().prefs ||= deepMerge(DEFAULT_PREFS, store.view.config.prefs || {})) : DEFAULT_PREFS);
const evsOf = h => store.view.byHabit.get(h.id) || [];
const dailyOf = h => { const m = M(); if (!m.daily.has(h.id)) m.daily.set(h.id, S.dailyMap(evsOf(h))); return m.daily.get(h.id); };
const refOf = h => { const m = M(); if (!m.ref.has(h.id)) m.ref.set(h.id, S.refDaily(h, dailyOf(h))); return m.ref.get(h.id); };

// ---------------------------------------------------------------- colour
const hexRgb = hex => { const n = parseInt(String(hex).slice(1), 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgbHex = c => `#${c.map(x => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
const lerp = (a, b, t) => { const A = hexRgb(a); const B = hexRgb(b); return rgbHex(A.map((x, i) => x + (B[i] - x) * t)); };
const rgba = (hex, a) => { const [r, g, b] = hexRgb(hex); return `rgba(${r},${g},${b},${Math.round(a * 100) / 100})`; };
function scale(score) {
  const p = prefs().palette;
  return score < 0.5 ? lerp(p.bad, p.mid, score * 2) : lerp(p.mid, p.good, (score - 0.5) * 2);
}
const isSemantic = h => h.kind !== 'neutral' && prefs().colorMode === 'semantic';
// Background colour for a count: bad habits go green → red as they get frequent, good habits the reverse.
function fillFor(h, count, ref) {
  const t = Math.min(count / ref, 1);
  if (!isSemantic(h)) return count > 0 ? rgba(h.color, 0.3 + 0.7 * t) : null;
  return rgba(scale(h.kind === 'bad' ? 1 - t : t), count === 0 ? 0.3 : 0.55 + 0.45 * t);
}
function solidFor(h, count, ref) {
  if (!isSemantic(h)) return null;
  const t = Math.min(count / ref, 1);
  return scale(h.kind === 'bad' ? 1 - t : t);
}
function changeHTML(h, ch) {
  if (ch == null) return '<span class="chg muted">—</span>';
  if (ch === Infinity) return '<span class="chg">new</span>';
  const p = Math.round(ch * 100);
  if (p === 0) return '<span class="chg muted">±0%</span>';
  const up = p > 0;
  let style = '';
  if (h.kind !== 'neutral') {
    const better = h.kind === 'bad' ? !up : up;
    style = ` style="color:${better ? prefs().palette.good : prefs().palette.bad}"`;
  }
  return `<span class="chg"${style}>${up ? '▲' : '▼'} ${Math.abs(p)}%</span>`;
}

// ---------------------------------------------------------------- UI state
const UI_KEY = 'tally-ui';
function readJSON(k) { try { return JSON.parse(localStorage.getItem(k) || 'null') || {}; } catch { return {}; } }
const ui = Object.assign({ dash: 'all', range: '30d', gran: 'auto', heat: '12m', cal: 'all', calMonth: null, hist: 'all' }, readJSON(UI_KEY));
ui.q = '';
ui.histLimit = 150;
ui.picks = new Set(); // suggestions ticked on the welcome screen
function saveUI() {
  const { dash, range, gran, heat, cal, calMonth, hist } = ui;
  try { localStorage.setItem(UI_KEY, JSON.stringify({ dash, range, gran, heat, cal, calMonth, hist })); } catch { /* private mode */ }
}
// Routes: #log, #dash, #dash/<habit id>, #cal/<id>, #hist/<id>, #set
const PARAM = { dash: 'dash', cal: 'cal', hist: 'hist' };
function route() {
  const [t, p] = location.hash.slice(1).split('/');
  ui.tab = TABS.some(x => x.id === t) ? t : 'log';
  if (p && PARAM[ui.tab]) {
    ui[PARAM[ui.tab]] = decodeURIComponent(p);
    if (ui.tab === 'hist') ui.histLimit = 150;
    saveUI();
  }
}
// Keep the address in step with the selected habit without adding history entries.
function setParam(value) {
  try { history.replaceState(null, '', `#${ui.tab}${value && value !== 'all' ? `/${encodeURIComponent(value)}` : ''}`); } catch { /* ignore */ }
}
route();

let entered = false;
let bumpId = null;
let secUntil = 0;
const secOpen = () => Date.now() < secUntil;
let installPrompt = null;

// ---------------------------------------------------------------- rendering helpers
let charts = [];
function chart(build, cls = '') {
  const id = `c${charts.length}`;
  charts.push({ id, build });
  return `<div class="chart ${cls}" id="${id}"></div>`;
}
function mountCharts() {
  for (const c of charts) {
    const el = document.getElementById(c.id);
    if (!el) continue;
    const out = c.build(el.clientWidth);
    if (typeof out === 'string') el.innerHTML = out;
    else { el.innerHTML = out.svg; if (out.scrollEnd) el.scrollLeft = el.scrollWidth; }
  }
}
const pageHead = (title, sub = '', right = '') => `<div class="page-head"><div>${sub ? `<p class="eyebrow">${sub}</p>` : ''}<h1>${title}</h1></div>${right}</div>`;
const card = (title, right, body, cls = '') => `<section class="card ${cls}"><div class="card-head"><h3>${title}</h3>${right || ''}</div>${body}</section>`;
const stat = (label, value, sub) => `<div class="stat"><span class="stat-label">${label}</span><span class="stat-value">${value}</span>${sub ? `<span class="stat-sub">${sub}</span>` : ''}</div>`;
const seg = (act, cur, opts, cls = 'sm') => `<div class="seg ${cls}" role="group">${opts.map(([v, l]) => `<button type="button" data-act="${act}" data-v="${v}" class="${String(cur) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
const chip = (act, id, label, on, color) => `<button type="button" class="chip ${on ? 'on' : ''}" data-act="${act}" data-v="${id}"${color ? ` style="--hc:${color}"` : ''}>${color ? '<i class="dot"></i>' : ''}${esc(label)}</button>`;
const habitChips = (act, cur, habits) => `<div class="chips">${chip(act, 'all', 'All habits', cur === 'all')}${habits.map(h => chip(act, h.id, `${h.emoji ? `${h.emoji} ` : ''}${h.name}`, cur === h.id, h.color)).join('')}</div>`;
const toggle = (kind, key, name, on, desc = '') => `<label class="switch-row"><span><b>${name}</b>${desc ? `<small>${desc}</small>` : ''}</span><input type="checkbox" class="switch" data-change="${kind}" data-k="${key}" ${on ? 'checked' : ''}></label>`;
const emptyBox = (title, text) => `<div class="empty"><h2>${title}</h2><p class="muted">${text}</p></div>`;
const emptyChart = (text = 'Nothing logged in this period.') => `<p class="muted empty-chart">${text}</p>`;
const habitName = h => (h ? `${h.emoji ? `${esc(h.emoji)} ` : ''}${esc(h.name)}` : 'Deleted habit');

function render() {
  if (!store.view || !entered) return;
  charts = [];
  const a = document.activeElement;
  const focus = a && a.id && $('#view').contains(a) ? { id: a.id, s: a.selectionStart, e: a.selectionEnd } : null;
  const fn = { log: renderLog, dash: renderDash, cal: renderCal, hist: renderHist, set: renderSettings }[ui.tab] || renderLog;
  $('#view').innerHTML = fn();
  mountCharts();
  if (focus) {
    const el = document.getElementById(focus.id);
    if (el) { el.focus(); try { el.setSelectionRange(focus.s, focus.e); } catch { /* not a text input */ } }
  }
  $$('[data-tab]').forEach(x => x.classList.toggle('on', x.dataset.tab === ui.tab));
  if (bumpId) { $(`.tile[data-h="${bumpId}"] .num`)?.classList.add('bump'); bumpId = null; }
}
let rafPending = false;
function renderSoon() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; render(); });
}

// ---------------------------------------------------------------- Today
function renderLog() {
  const v = store.view;
  const now = new Date();
  const list = v.habits.filter(h => !h.archived && h.showOnToday !== false);
  const hidden = v.habits.filter(h => !h.archived && h.showOnToday === false).length;
  let html = `<section class="page">${pageHead('Today', esc(now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })), `<button class="btn ghost" data-act="habit-new">${ICON.plus}<span>New habit</span></button>`)}`;
  if (!v.habits.length) return `${html}${welcome()}</section>`;
  html += `<div class="tiles">${list.map((h, i) => tile(h, i, now)).join('')}</div>`;
  if (!list.length) html += emptyBox('Nothing on Today', 'All habits are hidden from Today. Show them again in Settings → Habits.');
  if (hidden) html += `<p class="muted small center">${hidden} habit${hidden > 1 ? 's' : ''} hidden from Today · <a href="#set">manage</a></p>`;
  return `${html}</section>`;
}

// Only shown while there are no habits: tick as many suggestions as you like, then add them in one go.
function welcome() {
  const n = ui.picks.size;
  return `<div class="empty welcome"><h2>What do you want to keep track of?</h2>
    <p class="muted">Tick as many as you like. You can rename them, add goals or create your own anytime.</p>
    ${suggestionChips('pick', ui.picks)}
    <div class="btn-row center"><button class="btn primary" data-act="add-picked" ${n ? '' : 'disabled'}>${ICON.plus}<span>${n ? `Add ${n} habit${n > 1 ? 's' : ''}` : 'Add habits'}</span></button>
    <button class="btn" data-act="habit-new">Create your own</button></div></div>`;
}

function tile(h, i, now) {
  const evs = evsOf(h);
  const daily = dailyOf(h);
  const ref = refOf(h);
  const today = S.startOfDay(now);
  const c = daily.get(S.dayKey(now)) || 0;
  const hs = S.habitStart(h, evs);
  const last = evs.length ? new Date(evs[evs.length - 1].t) : null;
  const st = S.streaks(h, daily, hs, now, prefs().weekStart);
  const span = Math.min(30, Math.max(1, S.daysBetween(hs, today) + 1));
  const avg = S.sumRange(daily, S.addDays(today, -span + 1), S.addDays(today, 1)) / span;
  let line1;
  if (!last) line1 = 'Nothing logged yet';
  else if (h.kind === 'bad') line1 = `Clean for <b>${dur(now - last)}</b>`;
  else if (st.current > 0) line1 = `<b>${st.current}</b>-${st.unit === 'w' ? 'week' : 'day'} streak`;
  else line1 = `Last <b>${dur(now - last)}</b> ago`;
  const line2 = `avg ${fmt(avg)}/day · ${span}d`;

  let goal = '';
  if (h.goal?.type) {
    const g = h.goal;
    const val = g.period === 'week' ? S.sumRange(daily, S.startOfWeek(now, prefs().weekStart), S.addDays(today, 1)) : c;
    const ratio = g.count ? val / g.count : val > 0 ? 1 : 0;
    const ok = g.type === 'max' ? val <= g.count : val >= g.count;
    const color = g.type === 'max' ? (ok ? (ratio >= 0.75 ? prefs().palette.mid : prefs().palette.good) : prefs().palette.bad) : (ok ? prefs().palette.good : 'var(--text-2)');
    goal = `<div class="goal"><div class="goal-track"><div class="goal-fill" style="width:${Math.min(100, ratio * 100)}%;background:${color}"></div></div><span>${fmt(val)} / ${fmt(g.count)} ${g.type === 'max' ? 'max' : 'goal'} ${g.period === 'day' ? 'today' : 'this week'}</span></div>`;
  }
  const days = [...Array(14)].map((_, k) => S.addDays(today, k - 13));
  const vals = days.map(d => (d < hs ? 0 : daily.get(S.dayKey(d)) || 0));
  const sp = C.spark({ values: vals, width: 140, height: 26, fill: (v, k) => (days[k] < hs ? 'var(--line)' : fillFor(h, v, ref) || 'var(--line)') });
  // A good habit at 0 isn't a failure yet — the day isn't over — so keep it neutral.
  const numColor = h.kind === 'good' && c === 0 ? null : solidFor(h, c, ref);
  return `<article class="tile" data-h="${h.id}" style="--hc:${h.color}">
    <header class="tile-head"><span class="tile-emoji">${esc(h.emoji || '•')}</span><span class="tile-name">${esc(h.name)}</span><span class="kind-tag" title="${KIND[h.kind].long}">${KIND[h.kind].tag}</span><button class="icon-btn" data-act="habit-menu" data-h="${h.id}" aria-label="Manage ${esc(h.name)}">${ICON.more}</button></header>
    <a class="tile-body" href="#dash/${encodeURIComponent(h.id)}" aria-label="${esc(h.name)} dashboard: ${fmt(c)} today">
      <div class="tile-count"><span class="num"${numColor ? ` style="color:${numColor}"` : ''}>${fmt(c)}</span><span class="unit">today</span><span class="tile-go" title="Open dashboard">${ICON.dash}</span></div>
      <p class="tile-sub">${line1}</p>
      <p class="tile-sub faint">${line2}</p>
      ${goal}
      <div class="tile-spark">${sp}</div>
    </a>
    <footer class="tile-actions">
      <button class="btn-minus" data-act="dec" data-h="${h.id}" ${c ? '' : 'disabled'} aria-label="Remove one ${esc(h.name)} from today">−</button>
      <button class="btn-plus" data-act="inc" data-h="${h.id}" aria-label="Log ${esc(h.name)}">${ICON.plus}${i < 9 ? `<kbd>${i + 1}</kbd>` : ''}</button>
    </footer>
  </article>`;
}

// ---------------------------------------------------------------- Dashboard
const bucketLabel = (b, gran) => (gran === 'month'
  ? (b.start.getMonth() === 0 ? String(b.start.getFullYear()) : monthName(b.start))
  : fmtShort(b.start));
const bucketName = (b, gran) => (gran === 'day' ? fmtDay(b.start)
  : gran === 'week' ? `Week of ${fmtShort(b.start)}`
    : b.start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))
  + (b.partial ? ` (${b.days} of ${b.full} days so far)` : '');
const streakText = st => `${st.current}<small> ${st.unit === 'w' ? 'wk' : 'd'}</small>`;
const streakSub = st => `longest ${st.longest} ${st.unit === 'w' ? 'weeks' : 'days'}`;
const granSeg = () => seg('gran', ui.gran, [['auto', 'Auto'], ['day', 'Day'], ['week', 'Week'], ['month', 'Month']]);

function renderDash() {
  const v = store.view;
  const now = new Date();
  const habits = v.habits.filter(h => !h.archived);
  if (!habits.length) return `<section class="page">${pageHead('Dashboard')}${emptyBox('No habits yet', 'Add one on the Today tab and its numbers appear here.')}</section>`;
  let h = ui.dash !== 'all' ? v.habitById.get(ui.dash) : null;
  if (ui.dash !== 'all' && !h) ui.dash = 'all';
  const scope = h ? [h] : habits;
  const earliest = new Date(Math.min(...scope.map(x => S.habitStart(x, evsOf(x)).getTime())));
  const range = S.rangeBounds(ui.range, now, earliest);
  const gran = ui.gran === 'auto' ? S.autoGran(range) : ui.gran;
  const sub = `${range.name} · ${fmtShort(range.start)} – ${fmtShort(S.addDays(range.end, -1))}`;
  let html = `<section class="page">${pageHead('Dashboard', esc(sub), `<button class="btn ghost sm" data-act="customize">${ICON.eye}<span>Customize</span></button>`)}`;
  html += `<div class="controls">${habitChips('dash-habit', h ? h.id : 'all', habits)}${seg('range', ui.range, S.RANGES.map(r => [r.id, r.label]), '')}</div>`;
  html += h ? dashHabit(h, range, gran, now) : dashAll(habits, range, gran, now);
  return `${html}</section>`;
}

function dashHabit(h, range, gran, now) {
  const p = prefs();
  const evs = evsOf(h);
  const daily = dailyOf(h);
  const ref = refOf(h);
  const s = S.summarize(h, evs, daily, range, now, p.weekStart);
  const cards = [];
  cards.push(stat('Total', fmtInt(s.total), `${fmtInt(s.count)} entr${s.count === 1 ? 'y' : 'ies'} · ${s.days} day${s.days === 1 ? '' : 's'}`));
  cards.push(stat('Per day', fmt(s.perDay), `${fmt(s.perWeek)} / week · ${fmt(s.perMonth)} / month`));
  cards.push(stat('vs previous period', changeHTML(h, s.change), s.pPerDay != null ? `was ${fmt(s.pPerDay)} / day` : 'not enough history yet'));
  cards.push(stat(h.kind === 'bad' ? 'Clean for' : 'Since last', s.last ? dur(now - s.last) : '—', s.last ? fmtDateTime(s.last) : 'nothing logged'));
  cards.push(stat(streakLabel(h), streakText(s.streak), streakSub(s.streak)));
  if (h.kind === 'bad') cards.push(stat('Clean days', pct(s.zero / s.days), `${s.zero} of ${s.days} days`));
  else cards.push(stat(h.kind === 'good' ? 'Days done' : 'Active days', pct(s.active / s.days), `${s.active} of ${s.days} days`));
  if (s.goal) cards.push(stat('Goal kept', pct(s.goal.pct), `${s.goal.met} of ${s.goal.n} ${h.goal.period}s · ${goalText(h.goal)}`));
  const wdAvg = s.weekday.map((x, i) => (s.weekdayDays[i] ? x / s.weekdayDays[i] : 0));
  const bw = s.total ? wdAvg.indexOf(Math.max(...wdAvg)) : -1;
  cards.push(stat('Busiest day', bw < 0 ? '—' : dayLong(bw), bw < 0 ? '' : `${fmt(wdAvg[bw])} on average`));
  const ph = s.total ? s.hour.indexOf(Math.max(...s.hour)) : -1;
  cards.push(stat('Peak hour', ph < 0 ? '—' : hourLong(ph), ph < 0 ? '' : `${pct(s.hour[ph] / s.total)} of the total`));
  cards.push(stat('Typical gap', dur(s.gapMedian), s.gapMax == null ? 'needs two entries' : `longest ${dur(s.gapMax)}`));
  if (s.best && s.best.value > 0) cards.push(stat('Most in a day', fmt(s.best.value), fmtDay(s.best.date)));

  let html = `<div class="hero" style="--hc:${h.color}"><span class="hero-emoji">${esc(h.emoji || '•')}</span><div class="grow"><h2>${esc(h.name)}</h2><p class="muted">${KIND[h.kind].long}${h.goal?.type ? ` · goal: ${goalText(h.goal)}` : ''}</p></div><button class="btn ghost sm" data-act="habit-edit" data-h="${h.id}">${ICON.edit}<span>Edit</span></button></div>`;
  html += `<div class="stats">${cards.join('')}</div>`;
  const sec = p.sections;
  if (sec.timeline !== false) html += cardTimeline(h, range, gran, daily, ref);
  if (sec.heatmap !== false) html += cardHeatmap(h, daily, ref, evs);
  if (sec.when !== false) html += cardWhen(h, s);
  if (sec.gaps !== false) html += cardGaps(h, s);
  if (sec.recent !== false) html += cardRecent(h, evs);
  return html;
}

function cardTimeline(h, range, gran, daily, ref) {
  const p = prefs();
  const bs = S.buckets(daily, range.start, range.end, gran, p.weekStart);
  const win = gran === 'day' ? 7 : gran === 'week' ? 4 : 3;
  // unfinished periods (this week so far, a range that starts mid-month) are left out of the average
  const avg = bs.length >= win * 2 ? S.rolling(bs.map(b => b.value), win).map((x, i) => (bs.slice(Math.max(0, i - win + 1), i + 1).some(b => b.partial) ? null : x)) : null;
  let goal = null;
  const g = h.goal;
  if (g?.type) {
    if (gran === 'day' && g.period === 'day') goal = g.count;
    if (gran === 'week') goal = g.period === 'week' ? g.count : g.count * 7;
  }
  const legend = [];
  legend.push(`<span><i class="lg-box" style="background:${isSemantic(h) ? `linear-gradient(90deg,${scale(h.kind === 'bad' ? 1 : 0)},${scale(h.kind === 'bad' ? 0 : 1)})` : h.color}"></i>${gran === 'day' ? 'per day' : gran === 'week' ? 'per week' : 'per month'}</span>`);
  if (avg) legend.push(`<span><i class="lg-line"></i>${{ day: '7-day', week: '4-week', month: '3-month' }[gran]} average</span>`);
  if (goal != null) legend.push('<span><i class="lg-dash"></i>goal</span>');
  if (bs.some(b => b.partial)) legend.push('<span><i class="lg-box partial-box"></i>not finished yet</span>');
  const body = bs.some(b => b.value > 0)
    ? chart(w => C.timeline({
      buckets: bs, width: w, avg, goal,
      fill: b => fillFor(h, b.value, ref * b.days) || rgba(h.color, 0.8),
      label: b => bucketLabel(b, gran),
      tip: (b, i) => `${bucketName(b, gran)}: ${fmt(b.value)}${avg && avg[i] != null ? `\naverage ${fmt(avg[i])}` : ''}`,
    })) + `<div class="legend">${legend.join('')}</div>`
    : emptyChart();
  return card('Over time', granSeg(), body);
}

function cardHeatmap(h, daily, ref, evs) {
  const p = prefs();
  const now = new Date();
  const hs = S.habitStart(h, evs);
  const tomorrow = S.addDays(S.startOfDay(now), 1);
  const years = [];
  for (let y = now.getFullYear(); y >= hs.getFullYear() && years.length < 6; y--) years.push(y);
  let start;
  let end;
  if (ui.heat !== '12m' && years.includes(+ui.heat)) { start = new Date(+ui.heat, 0, 1); end = new Date(+ui.heat + 1, 0, 1); } else { end = tomorrow; start = S.addMonths(end, -12); }
  const color = (c, d) => (d < hs || d >= tomorrow ? null : fillFor(h, c, ref));
  const tip = (c, d) => `${fmtDay(d)}: ${d < hs ? 'before tracking started' : d >= tomorrow ? '—' : fmt(c)}`;
  const steps = [0, 0.25, 0.5, 0.75, 1].map(t => fillFor(h, t * ref, ref) || 'var(--empty)');
  const legend = `<div class="legend heat-legend"><span>${h.kind === 'good' ? 'Less' : 'None'}</span>${steps.map(c => `<i class="lg-cell" style="background:${c}"></i>`).join('')}<span>${fmt(ref)}+ a day</span></div>`;
  const ctl = seg('heat', years.includes(+ui.heat) ? ui.heat : '12m', [['12m', '12 months'], ...years.map(y => [String(y), String(y)])]);
  return card('Calendar', ctl, chart(w => ({
    svg: C.heatmap({ daily, start, end, color, weekStart: p.weekStart, tip, monthName, dayName, width: w }).svg, scrollEnd: true,
  }), 'scroll-x') + legend);
}

function cardWhen(h, s) {
  if (!s.total) return card('When it happens', '', emptyChart());
  const p = prefs();
  const order = [...Array(7)].map((_, i) => (p.weekStart + i) % 7);
  const pc = chart(w => C.punch({ m: s.punch, width: w, color: h.color, weekStart: p.weekStart, dayName, hourLabel, tip: (d, hr, v) => `${dayLong(d)}, ${hourRange(hr)}: ${fmt(v)}` }));
  const wd = chart(w => C.bars({
    values: order.map(d => (s.weekdayDays[d] ? s.weekday[d] / s.weekdayDays[d] : 0)), labels: order.map(dayName), width: w,
    fill: () => rgba(h.color, 0.85), tip: (v, i) => `${dayLong(order[i])}: ${fmt(v)} on average`,
  }));
  const hr = chart(w => C.bars({
    values: s.hour, labels: s.hour.map((_, i) => hourLabel(i)), width: w,
    fill: () => rgba(h.color, 0.85), tip: (v, i) => `${hourRange(i)}: ${fmt(v)} in total`,
  }));
  return card('When it happens', '', `${pc}<div class="two"><div><h4>By weekday <small>average per day</small></h4>${wd}</div><div><h4>By hour <small>total</small></h4>${hr}</div></div>`);
}

function cardGaps(h, s) {
  if (!s.gaps.length) return card('Time between entries', '', emptyChart('Needs at least two entries in this period.'));
  const hist = S.gapHistogram(s.gaps);
  const n = hist.length - 1;
  const fill = (v, i) => (isSemantic(h) ? scale(h.kind === 'bad' ? i / n : 1 - i / n) : rgba(h.color, 0.85));
  return card('Time between entries', '', `<div class="mini-stats">
      <div><b>${dur(s.gapAvg)}</b><span>average</span></div><div><b>${dur(s.gapMedian)}</b><span>median</span></div>
      <div><b>${dur(s.gapMax)}</b><span>longest</span></div>${s.last ? `<div><b>${dur(Date.now() - s.last)}</b><span>right now</span></div>` : ''}</div>
    ${chart(w => C.bars({ values: hist.map(b => b.value), labels: hist.map(b => b.label), width: w, height: 150, fill, tip: (v, i) => `${hist[i].label} apart: ${v} time${v === 1 ? '' : 's'}` }))}`);
}

function cardRecent(h, evs) {
  const recent = evs.slice(-8).reverse();
  return card('Recent entries', `<a class="btn ghost sm" href="#hist/${encodeURIComponent(h.id)}">All</a>`, recent.length ? `<div class="evlist">${recent.map(e => evRow(e, true)).join('')}</div>` : emptyChart('Nothing logged yet.'));
}

function dashAll(habits, range, gran, now) {
  const p = prefs();
  const bs0 = S.buckets(new Map(), range.start, range.end, gran, p.weekStart);
  const series = [];
  const cards = habits.map(h => {
    const evs = evsOf(h);
    const daily = dailyOf(h);
    const ref = refOf(h);
    const s = S.summarize(h, evs, daily, range, now, p.weekStart);
    const bs = S.buckets(daily, range.start, range.end, gran, p.weekStart);
    series.push({ name: h.name, color: h.color, values: bs.map(b => b.value) });
    const since = s.last ? (h.kind === 'bad' ? `clean for ${dur(now - s.last)}` : `last ${dur(now - s.last)} ago`) : 'nothing logged yet';
    return `<button class="ov" data-act="dash-habit" data-v="${h.id}" style="--hc:${h.color}">
      <span class="ov-head"><span class="ov-emoji">${esc(h.emoji || '•')}</span><b>${esc(h.name)}</b><span class="kind-tag">${KIND[h.kind].tag}</span></span>
      <span class="ov-main"><span class="ov-num">${fmtInt(s.total)}</span><span class="muted">${fmt(s.perDay)}/day</span>${changeHTML(h, s.change)}</span>
      <span class="ov-spark">${C.spark({ values: bs.map(b => b.value), width: 220, height: 34, fill: (v, i) => fillFor(h, v, ref * bs[i].days) || 'var(--line)', partial: i => bs[i].partial })}</span>
      <span class="ov-foot">${since} · ${streakLabel(h).toLowerCase()} ${s.streak.current} ${s.streak.unit === 'w' ? 'wk' : 'd'}</span>
    </button>`;
  });
  let html = `<div class="ov-grid">${cards.join('')}</div>`;
  html += card('Compare', granSeg(), chart(w => C.lines({
    series, n: bs0.length, width: w, partial: [bs0[0]?.partial, bs0[bs0.length - 1]?.partial],
    label: i => bucketLabel(bs0[i], gran),
    tip: i => `${bucketName(bs0[i], gran)}\n${series.map(x => `${x.name}: ${fmt(x.values[i])}`).join('\n')}`,
  })) + `<div class="legend">${series.map(x => `<span><i class="lg-dot" style="background:${x.color}"></i>${esc(x.name)}</span>`).join('')}</div>`);
  return html;
}

// ---------------------------------------------------------------- Calendar
function renderCal() {
  const v = store.view;
  const p = prefs();
  const now = new Date();
  const habits = v.habits.filter(h => !h.archived);
  let h = ui.cal !== 'all' ? v.habitById.get(ui.cal) : null;
  if (ui.cal !== 'all' && !h) ui.cal = 'all';
  const m0 = ui.calMonth ? S.parseDay(`${ui.calMonth}-01`) : S.startOfMonth(now);
  const mEnd = S.addMonths(m0, 1);
  const gridStart = S.startOfWeek(m0, p.weekStart);
  const weeks = Math.ceil(S.daysBetween(gridStart, mEnd) / 7);
  const todayK = S.dayKey(now);
  const tomorrow = S.addDays(S.startOfDay(now), 1);
  const isCurrent = S.dayKey(m0) === S.dayKey(S.startOfMonth(now));

  let html = `<section class="page">${pageHead('Calendar')}`;
  if (!habits.length) return `${html}${emptyBox('No habits yet', 'Add one on the Today tab first.')}</section>`;
  html += `<div class="controls">${habitChips('cal-habit', h ? h.id : 'all', habits)}</div>`;
  html += `<div class="cal-nav"><button class="icon-btn lg" data-act="cal-prev" aria-label="Previous month">${ICON.left}</button><h2>${esc(m0.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</h2><button class="icon-btn lg" data-act="cal-next" aria-label="Next month">${ICON.right}</button>${isCurrent ? '' : '<button class="btn ghost sm" data-act="cal-today">This month</button>'}</div>`;
  html += `<div class="cal">${[...Array(7)].map((_, i) => `<div class="cal-wd">${dayName((p.weekStart + i) % 7)}</div>`).join('')}`;
  const hs = h ? S.habitStart(h, evsOf(h)) : null;
  for (let i = 0; i < weeks * 7; i++) {
    const d = S.addDays(gridStart, i);
    const k = S.dayKey(d);
    const inMonth = d >= m0 && d < mEnd;
    const cls = ['day', inMonth ? '' : 'out', k === todayK ? 'today' : '', d >= tomorrow ? 'future' : ''].join(' ');
    let inner = `<span class="dn">${d.getDate()}</span>`;
    let style = '';
    if (h) {
      const c = dailyOf(h).get(k) || 0;
      if (d >= hs && d < tomorrow) { const f = fillFor(h, c, refOf(h)); if (f) style = ` style="background:${f}"`; }
      if (c) inner += `<span class="dc">${fmt(c)}</span>`;
    } else {
      const hits = habits.map(x => [x, dailyOf(x).get(k) || 0]).filter(([, c]) => c > 0);
      inner += `<span class="pills">${hits.slice(0, 3).map(([x, c]) => `<span class="pill" style="--hc:${x.color}">${esc(x.emoji || '•')}<b>${fmt(c)}</b></span>`).join('')}${hits.length > 3 ? `<span class="pill more">+${hits.length - 3}</span>` : ''}</span>`;
    }
    html += `<button class="${cls}" data-act="cal-day" data-v="${k}"${style}>${inner}</button>`;
  }
  html += '</div>';
  html += h ? monthSummary(h, m0, mEnd, now) : monthTable(habits, m0, mEnd, now);
  return `${html}</section>`;
}

function monthBounds(m0, mEnd, now) {
  const tomorrow = S.addDays(S.startOfDay(now), 1);
  const end = mEnd < tomorrow ? mEnd : tomorrow;
  const prev0 = S.addMonths(m0, -1);
  return { end, prev0, days: Math.max(0, S.daysBetween(m0, end)), prevDays: S.daysBetween(prev0, m0) };
}

function monthSummary(h, m0, mEnd, now) {
  const daily = dailyOf(h);
  const b = monthBounds(m0, mEnd, now);
  if (b.days <= 0) return '';
  const total = S.sumRange(daily, m0, b.end);
  const prev = S.sumRange(daily, b.prev0, m0);
  const rate = total / b.days;
  const prate = prev / b.prevDays;
  let zero = 0;
  let best = 0;
  for (const d of S.eachDay(m0, b.end)) { const c = daily.get(S.dayKey(d)) || 0; if (!c) zero++; best = Math.max(best, c); }
  const ch = prate ? (rate - prate) / prate : rate ? Infinity : 0;
  return `<div class="stats">${stat('This month', fmtInt(total), `${fmt(rate)} / day`)}${stat('Last month', fmtInt(prev), `${fmt(prate)} / day`)}${stat('Change per day', changeHTML(h, ch), 'compared to last month')}${stat(h.kind === 'bad' ? 'Clean days' : 'Days without', fmtInt(zero), `of ${b.days} days`)}${stat('Most in a day', fmt(best), '')}</div>`;
}

function monthTable(habits, m0, mEnd, now) {
  const b = monthBounds(m0, mEnd, now);
  if (b.days <= 0) return '';
  const rows = habits.map(h => {
    const daily = dailyOf(h);
    const total = S.sumRange(daily, m0, b.end);
    const prev = S.sumRange(daily, b.prev0, m0);
    const rate = total / b.days;
    const prate = prev / b.prevDays;
    const ch = prate ? (rate - prate) / prate : rate ? Infinity : 0;
    return `<tr><td><button class="link" data-act="cal-habit" data-v="${h.id}">${habitName(h)}</button></td><td class="r">${fmtInt(total)}</td><td class="r muted">${fmt(rate)}</td><td class="r">${fmtInt(prev)}</td><td class="r">${changeHTML(h, ch)}</td></tr>`;
  }).join('');
  return card('This month', '', `<div class="table-wrap"><table class="tbl"><thead><tr><th>Habit</th><th class="r">Total</th><th class="r">/ day</th><th class="r">Last month</th><th class="r">Change</th></tr></thead><tbody>${rows}</tbody></table></div>`);
}

function openDay(k) {
  const v = store.view;
  const d = S.parseDay(k);
  const evs = v.events.filter(e => S.dayKey(new Date(e.t)) === k).reverse();
  const habits = v.habits.filter(h => !h.archived);
  const isToday = k === S.dayKey(new Date());
  const isFuture = d > new Date();
  const defaultH = ui.cal !== 'all' ? ui.cal : habits[0]?.id;
  const time = isToday ? fmtHM(new Date()) : '12:00';
  const totals = habits.map(h => [h, evs.filter(e => e.h === h.id).reduce((a, e) => a + S.qty(e), 0)]).filter(([, c]) => c);
  openSheet(fmtDay(d), `
    ${totals.length ? `<div class="chips wrap">${totals.map(([h, c]) => `<span class="chip static" style="--hc:${h.color}"><i class="dot"></i>${habitName(h)} · ${fmt(c)}</span>`).join('')}</div>` : ''}
    ${evs.length ? `<div class="evlist">${evs.map(e => evRow(e)).join('')}</div>` : '<p class="muted">Nothing logged on this day.</p>'}
    ${!isFuture && habits.length ? `<form id="dayForm" class="form" data-day="${k}"><h4>Add an entry on this day</h4>
      <div class="grid3"><label class="field"><span>Habit</span><select name="h">${habits.map(h => `<option value="${h.id}" ${h.id === defaultH ? 'selected' : ''}>${esc(`${h.emoji ? `${h.emoji} ` : ''}${h.name}`)}</option>`).join('')}</select></label>
      <label class="field"><span>Time</span><input type="time" name="time" value="${time}" required></label>
      <label class="field"><span>How many</span><input type="number" name="q" value="1" min="0.1" step="any" inputmode="decimal" required></label></div>
      <label class="field"><span>Comment <small>optional</small></span><input name="n" maxlength="300" autocomplete="off"></label>
      <button class="btn primary block" type="submit">Add entry</button></form>` : ''}`);
}
const fmtHM = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// ---------------------------------------------------------------- History
function evRow(e, compact = false) {
  const h = store.view.habitById.get(e.h);
  const d = new Date(e.t);
  return `<button class="ev" data-act="ev-edit" data-v="${e.id}">
    <span class="ev-time">${compact ? fmtDateTime(d) : fmtTime(d)}</span>
    <span class="ev-dot" style="background:${h?.color || '#888'}"></span>
    <span class="ev-main"><span class="ev-name">${habitName(h)}</span>${e.n ? `<span class="ev-note">${esc(e.n)}</span>` : ''}</span>
    ${S.qty(e) !== 1 ? `<span class="ev-q">×${fmt(S.qty(e))}</span>` : ''}${ICON.right}</button>`;
}

function renderHist() {
  const v = store.view;
  let html = `<section class="page">${pageHead('History')}`;
  if (!v.events.length) return `${html}${emptyBox('Nothing logged yet', 'Every entry you log shows up here, newest first. Tap one to edit or delete it.')}</section>`;
  if (ui.hist !== 'all' && !v.habitById.has(ui.hist)) ui.hist = 'all';
  html += `<div class="controls">${habitChips('hist-habit', ui.hist, v.habits)}<input id="histQ" class="search" type="search" placeholder="Search comments" value="${esc(ui.q)}" data-input="hist-q"></div>`;
  const q = ui.q.trim().toLowerCase();
  const all = v.events.filter(e => (ui.hist === 'all' || e.h === ui.hist) && (!q || (e.n || '').toLowerCase().includes(q) || (v.habitById.get(e.h)?.name || '').toLowerCase().includes(q)));
  const list = all.slice(-ui.histLimit).reverse();
  const todayK = S.dayKey(new Date());
  const yK = S.dayKey(S.addDays(new Date(), -1));
  let cur = null;
  let group = [];
  const groups = [];
  for (const e of list) {
    const k = S.dayKey(new Date(e.t));
    if (k !== cur) { if (group.length) groups.push([cur, group]); cur = k; group = []; }
    group.push(e);
  }
  if (group.length) groups.push([cur, group]);
  html += `<p class="muted small">${fmtInt(all.length)} entr${all.length === 1 ? 'y' : 'ies'}${q ? ' match' : ''}</p>`;
  for (const [k, g] of groups) {
    const label = k === todayK ? 'Today' : k === yK ? 'Yesterday' : fmtDay(S.parseDay(k));
    html += `<div class="hist-group"><h4><button class="link" data-act="cal-day" data-v="${k}">${label}</button><span class="muted">${fmt(g.reduce((a, e) => a + S.qty(e), 0))}</span></h4><div class="evlist">${g.map(e => evRow(e)).join('')}</div></div>`;
  }
  if (all.length > list.length) html += '<button class="btn block" data-act="hist-more">Show more</button>';
  return `${html}</section>`;
}

function openEvent(id) {
  const v = store.view;
  const e = v.eventById.get(id);
  if (!e) return;
  const d = new Date(e.t);
  openSheet('Edit entry', `<form id="evForm" class="form" data-id="${e.id}">
    <label class="field"><span>Habit</span><select name="h">${v.habits.map(h => `<option value="${h.id}" ${h.id === e.h ? 'selected' : ''}>${esc(`${h.emoji ? `${h.emoji} ` : ''}${h.name}`)}${h.archived ? ' (archived)' : ''}</option>`).join('')}</select></label>
    <div class="grid2"><label class="field"><span>Date</span><input type="date" name="d" value="${S.dayKey(d)}" max="${S.dayKey(new Date())}" required></label>
    <label class="field"><span>Time</span><input type="time" name="time" value="${fmtHM(d)}" required></label></div>
    <div class="field"><span>How many</span>${stepper(S.qty(e))}</div>
    <label class="field"><span>Comment</span><input name="n" value="${esc(e.n || '')}" maxlength="300" autocomplete="off"></label>
    <p class="form-error"></p>
    <div class="form-actions"><button type="button" class="btn danger ghost" data-act="ev-delete" data-v="${e.id}">Delete</button><span class="grow"></span><button class="btn primary" type="submit">Save</button></div>
  </form>`);
}

// ---------------------------------------------------------------- Log sheet (the + button)
const stepper = (value = 1) => `<div class="stepper"><button type="button" data-act="step" data-v="-1" aria-label="One less">−</button><input type="number" name="q" value="${value}" min="0.1" step="any" inputmode="decimal" required aria-label="How many"><button type="button" data-act="step" data-v="1" aria-label="One more">+</button></div>`;

// Date + time inputs → a Date in local time, or null.
function readWhen(fd) {
  const [y, m, d] = String(fd.get('d') || '').split('-').map(Number);
  const [hh, mm] = String(fd.get('time') || '').split(':').map(Number);
  if (!y || !m || !d || Number.isNaN(hh)) return null;
  return new Date(y, m - 1, d, hh, mm || 0, 0, 0);
}

function openLogSheet(id) {
  const h = store.view.habitById.get(id);
  if (!h) return;
  const now = new Date();
  const today = S.dayKey(now);
  const yesterday = S.dayKey(S.addDays(now, -1));
  const evs = evsOf(h);
  const last = evs.length ? new Date(evs[evs.length - 1].t) : null;
  const sub = [`${fmt(dailyOf(h).get(today) || 0)} today`, last ? `last ${fmtDateTime(last)}` : 'nothing logged yet', h.goal?.type ? `goal ${goalText(h.goal)}` : ''].filter(Boolean).join(' · ');
  openSheet(`${h.emoji ? `${h.emoji} ` : ''}${h.name}`, `<form id="logForm" class="form" data-h="${h.id}" data-opened="${fmtHM(now)}">
    <p class="muted small sheet-sub">${esc(sub)}</p>
    <div class="field"><span>Date</span><div class="date-row">
      <input type="date" name="d" value="${today}" max="${today}" required aria-label="Date" data-change="log-date">
      <button type="button" class="chip on" data-act="log-day" data-v="${today}">Today</button>
      <button type="button" class="chip" data-act="log-day" data-v="${yesterday}">Yesterday</button></div></div>
    <div class="grid2"><label class="field"><span>Time</span><input type="time" name="time" value="${fmtHM(now)}" required></label>
      <div class="field"><span>How many</span>${stepper(1)}</div></div>
    <label class="field"><span>Comment <small>optional</small></span><input name="n" maxlength="300" placeholder="What was going on?" autocomplete="off" enterkeyhint="done"></label>
    <p class="form-error"></p>
    <button class="btn primary block lg" type="submit" autofocus>${ICON.plus}<span>Log ${esc(h.name)}</span></button>
  </form>`);
}
function syncDayChips(form) {
  const v = form.querySelector('[name=d]').value;
  $$('[data-act=log-day]', form).forEach(c => c.classList.toggle('on', c.dataset.v === v));
}

// ---------------------------------------------------------------- Habit editor & menu
function openHabitEditor(id) {
  const v = store.view;
  const existing = id ? v.habitById.get(id) : null;
  const h = existing || { id: uid(), name: '', emoji: '', kind: 'bad', color: SWATCHES[v.habits.length % SWATCHES.length], goal: null, showOnToday: true };
  const g = h.goal || {};
  const kindOpt = (k, t, s) => `<label><input type="radio" name="kind" value="${k}" ${h.kind === k ? 'checked' : ''}><span><b>${t}</b><small>${s}</small></span></label>`;
  const sug = existing ? '' : suggestionChips('prefill');
  openSheet(existing ? 'Edit habit' : 'New habit', `<form id="habitForm" class="form" data-id="${h.id}" data-new="${existing ? '' : '1'}">
    ${sug ? `<div class="suggest-box"><p class="muted small">Start from a suggestion, or fill in your own below.</p>${sug}</div>` : ''}
    <div class="name-row"><label class="field emoji-field"><span>Icon</span><input name="emoji" value="${esc(h.emoji)}" maxlength="8" placeholder="🙂" autocomplete="off"></label>
    <label class="field grow"><span>Name</span><input name="name" value="${esc(h.name)}" required maxlength="40" placeholder="e.g. Smoking" autocomplete="off"></label></div>
    <div class="emoji-grid">${EMOJIS.map(e => `<button type="button" class="emoji-opt" data-act="pick-emoji" data-v="${e}">${e}</button>`).join('')}</div>
    <fieldset class="field"><legend>Type</legend><div class="kind-pick">${kindOpt('bad', 'Break', 'Less is better')}${kindOpt('good', 'Build', 'More is better')}${kindOpt('neutral', 'Track', 'Just count it')}</div></fieldset>
    <fieldset class="field"><legend>Colour</legend><div class="swatches">${SWATCHES.map(c => `<label class="sw"><input type="radio" name="color" value="${c}" ${c === h.color ? 'checked' : ''}><span style="background:${c}"></span></label>`).join('')}</div></fieldset>
    <fieldset class="field"><legend>Goal <small>optional</small></legend><div class="goal-row">
      <select name="gtype"><option value="">No goal</option><option value="max" ${g.type === 'max' ? 'selected' : ''}>At most</option><option value="min" ${g.type === 'min' ? 'selected' : ''}>At least</option></select>
      <input name="gcount" type="number" min="0" step="1" inputmode="numeric" value="${g.count ?? ''}" placeholder="0" aria-label="Goal count">
      <select name="gperiod"><option value="day">per day</option><option value="week" ${g.period === 'week' ? 'selected' : ''}>per week</option></select></div></fieldset>
    <label class="check"><input type="checkbox" name="showOnToday" ${h.showOnToday !== false ? 'checked' : ''}><span>Show on Today</span></label>
    ${existing ? `<label class="check"><input type="checkbox" name="archived" ${h.archived ? 'checked' : ''}><span>Archived <small>hidden everywhere, history kept</small></span></label>` : ''}
    <div class="form-actions">${existing ? `<button type="button" class="btn danger ghost" data-act="habit-delete" data-h="${h.id}">Delete…</button>` : ''}<span class="grow"></span><button class="btn primary" type="submit">${existing ? 'Save' : 'Create habit'}</button></div>
  </form>`);
}

// The ⋯ menu: everything about managing the habit itself (logging lives on the + button).
function openHabitMenu(id) {
  const v = store.view;
  const h = v.habitById.get(id);
  if (!h) return;
  const onToday = todayIds();
  const i = onToday.indexOf(h.id);
  const n = evsOf(h).length;
  const item = (act, icon, title, sub, cls = '') => `<button type="button" class="menu-item ${cls}" data-act="${act}" data-h="${h.id}">${icon}<span><b>${title}</b><small>${sub}</small></span></button>`;
  openSheet(`${h.emoji ? `${h.emoji} ` : ''}${h.name}`, `
    <p class="muted small sheet-sub">${KIND[h.kind].long}${h.goal?.type ? ` · goal ${goalText(h.goal)}` : ''} · ${fmtInt(n)} entr${n === 1 ? 'y' : 'ies'}</p>
    <div class="menu">
      ${item('habit-edit', ICON.edit, 'Edit habit', 'Name, icon, type, colour and goal')}
      ${item('goto-dash', ICON.dash, 'Dashboard', 'Numbers and charts for this habit')}
      ${item('hist-for', ICON.hist, 'All entries', 'Review, edit or delete past entries')}
      ${i >= 0 ? `<div class="menu-item static">${ICON.order}<span><b>Position on Today</b><small>${i + 1} of ${onToday.length}</small></span>
        <span class="menu-side"><button type="button" class="icon-btn" data-act="menu-move" data-v="-1" data-h="${h.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move earlier">${ICON.up}</button><button type="button" class="icon-btn" data-act="menu-move" data-v="1" data-h="${h.id}" ${i === onToday.length - 1 ? 'disabled' : ''} aria-label="Move later">${ICON.down}</button></span></div>` : ''}
      ${item('habit-hide', ICON.hide, 'Hide from Today', 'Still tracked; show it again from Settings')}
      ${item('habit-archive', ICON.archive, 'Archive', 'Hidden everywhere, history kept')}
      ${item('habit-delete', ICON.trash, 'Delete…', 'Remove the habit and all its entries', 'danger')}
    </div>`);
}
const todayIds = () => store.view.habits.filter(h => !h.archived && h.showOnToday !== false).map(h => h.id);

function addSuggestions(indices) {
  const v = store.view;
  const have = new Set(v.habits.map(h => h.name.toLowerCase()));
  const ops = [];
  let k = v.habits.length;
  for (const i of indices) {
    const s = SUGGEST[i];
    if (!s || have.has(s.name.toLowerCase())) continue;
    have.add(s.name.toLowerCase());
    ops.push({ op: 'habit', habit: {
      id: uid(), name: s.name, emoji: s.emoji, kind: s.kind, color: SWATCHES[k % SWATCHES.length],
      goal: s.goal || null, showOnToday: true, archived: false, createdAt: new Date().toISOString(), order: k,
    } });
    k++;
  }
  if (ops.length) store.importOps(ops);
  return ops.length;
}

// ---------------------------------------------------------------- Settings
function renderSettings() {
  const v = store.view;
  const p = prefs();
  let html = `<section class="page">${pageHead('Settings')}`;
  const hs = v.habits;
  html += card('Habits', `<button class="btn ghost sm" data-act="habit-new">${ICON.plus}<span>New</span></button>`, hs.length ? `<ul class="hlist">${hs.map((h, i) => `<li class="${h.archived ? 'arch' : ''}">
      <span class="hl-emoji" style="--hc:${h.color}">${esc(h.emoji || '•')}</span>
      <span class="hl-name">${esc(h.name)}<small>${KIND[h.kind].long}${h.goal?.type ? ` · ${goalText(h.goal)}` : ''}${h.archived ? ' · archived' : h.showOnToday === false ? ' · hidden from Today' : ''}</small></span>
      <span class="hl-act"><button class="icon-btn" data-act="habit-up" data-h="${h.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">${ICON.up}</button><button class="icon-btn" data-act="habit-down" data-h="${h.id}" ${i === hs.length - 1 ? 'disabled' : ''} aria-label="Move down">${ICON.down}</button><button class="icon-btn" data-act="habit-edit" data-h="${h.id}" aria-label="Edit ${esc(h.name)}">${ICON.edit}</button></span></li>`).join('')}</ul>` : '<p class="muted">No habits yet.</p>');

  html += card('Logging', '', toggle('pref-bool', 'logDetails', 'Ask for date and comment on +', p.logDetails !== false,
    'When off, + logs instantly at the current time; the message that appears lets you add details or undo.'));

  const pal = p.palette;
  const same = x => x.bad === pal.bad && x.mid === pal.mid && x.good === pal.good;
  html += card('Appearance', '', `
    <div class="set-row"><span>Theme</span>${seg('pref-theme', p.theme, [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']])}</div>
    <div class="set-row"><span>Colours show</span>${seg('pref-cmode', p.colorMode, [['semantic', 'Good ↔ bad'], ['intensity', 'Habit colour']])}</div>
    <p class="muted small">${p.colorMode === 'semantic' ? 'Bad habits turn green when rare and red when frequent. Good habits work the other way round. “Track” habits always use their own colour.' : 'Each habit uses its own colour, stronger when it happens more.'}</p>
    <div class="palettes">${Object.entries(PALETTES).map(([k, x]) => `<button class="pal ${same(x) ? 'on' : ''}" data-act="pal-preset" data-v="${k}"><span class="pal-bar" style="background:linear-gradient(90deg,${x.bad},${x.mid},${x.good})"></span><span>${x.name}</span></button>`).join('')}</div>
    <div class="set-row"><span>Custom</span><span class="color-ins">${['bad', 'mid', 'good'].map(k => `<label><input type="color" data-change="pal" data-k="${k}" value="${pal[k]}"><span>${k === 'mid' ? 'Middle' : cap(k)}</span></label>`).join('')}</span></div>
    <div class="preview"><div><span class="small muted">Bad habit · rare → frequent</span><span class="pal-bar" style="background:linear-gradient(90deg,${pal.good},${pal.mid},${pal.bad})"></span></div>
    <div><span class="small muted">Good habit · rare → frequent</span><span class="pal-bar" style="background:linear-gradient(90deg,${pal.bad},${pal.mid},${pal.good})"></span></div></div>
    <div class="set-row"><span>Week starts on</span>${seg('pref-week', p.weekStart, [[1, 'Monday'], [0, 'Sunday'], [6, 'Saturday']])}</div>`);
  html += card('Dashboard sections', '', SECTIONS.map(s => toggle('section', s.id, s.name, p.sections[s.id] !== false, s.desc)).join(''));
  html += card('Use it like an app', '', installHTML());
  html += securityCard();
  html += `<p class="foot muted small">Data is stored encrypted (AES-256-GCM) in <a href="https://github.com/${CFG.owner}/${CFG.repo}/commits/${CFG.branch}" target="_blank" rel="noopener">${esc(CFG.owner)}/${esc(CFG.repo)} · ${esc(CFG.branch)} branch</a>.</p></section>`;
  return html;
}

function installHTML() {
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) return '<p>Tally is running as an installed app.</p>';
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const addr = esc(location.host + location.pathname.replace(/index\.html$/, ''));
  let how;
  if (installPrompt) how = '<button class="btn primary" data-act="install">Install Tally</button>';
  else if (ios) how = '<ol class="steps"><li>Open this page in <b>Safari</b>.</li><li>Tap <b>Share</b>.</li><li>Choose <b>Add to Home Screen</b>.</li></ol>';
  else how = '<ol class="steps"><li><b>Android</b>: Chrome menu ⋮ → <b>Install app</b> (or Add to Home screen).</li><li><b>Computer</b>: the install icon at the right of the address bar in Chrome or Edge.</li></ol>';
  return `<p>Put Tally on your home screen: one tap to open, full screen, and it works offline.</p>${how}<p class="muted small">Address: <b>${addr}</b></p>`;
}

function securityCard() {
  if (!secOpen()) {
    return card('Security & data', `<span class="muted">${ICON.lock}</span>`, `<form id="secUnlock" class="inline-form"><p class="muted">The token, password and data tools are behind your password.</p>
      <div class="row"><input type="password" id="secPw" name="pw" placeholder="Password" autocomplete="current-password" required><button class="btn primary" type="submit">Unlock</button></div><p class="form-error" id="secErr"></p></form>`);
  }
  const tok = store.gh?.token || '';
  const masked = tok ? `${tok.slice(0, 11)}…${tok.slice(-4)}` : '—';
  return card('Security & data', `<button class="btn ghost sm" data-act="sec-lock">${ICON.lock}<span>Lock</span></button>`, `
    <div class="set-block"><h4>GitHub token</h4><p class="mono">${esc(masked)}</p>
      <form id="tokForm" class="row"><input type="password" name="token" placeholder="Paste a new token" autocomplete="off" required><button class="btn" type="submit">Replace</button></form>
      <p class="muted small">The token needs <b>${esc(CFG.owner)}/${esc(CFG.repo)}</b> selected, with Contents set to “Read and write”. <a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noopener">Manage tokens</a></p></div>
    <div class="set-block"><h4>Password</h4><form id="pwForm" class="stack"><input type="password" name="pw" placeholder="New password" minlength="8" autocomplete="new-password" required><input type="password" name="pw2" placeholder="Repeat new password" autocomplete="new-password" required><button class="btn" type="submit">Change password</button></form>
      <p class="muted small">All data is encrypted again in one commit. Other devices will ask for the new password.</p></div>
    <div class="set-block">${toggle('device', 'requirePassword', 'Ask for the password every time', !!store.device.requirePassword, 'This device only. When off, Tally stays unlocked here so logging is one tap.')}</div>
    <div class="set-block"><h4>Your data</h4><div class="btn-row"><button class="btn" data-act="export-json">Export JSON</button><button class="btn" data-act="export-csv">Export CSV</button><button class="btn" data-act="import">Import JSON</button></div>
      <input type="file" id="importFile" accept="application/json,.json" hidden data-change="import-file"></div>
    <div class="set-block"><h4>This device</h4><div class="btn-row"><button class="btn" data-act="redownload">Re-download from GitHub</button><button class="btn danger" data-act="forget">Forget this device</button></div>
      <p class="muted small">Forgetting removes the key and the cached copy from this browser. Your data stays in GitHub.</p></div>`);
}

function openCustomize() {
  const p = prefs();
  openSheet('Customize dashboard', `<p class="muted">Choose what the habit dashboard shows. This syncs to all your devices.</p>${SECTIONS.map(s => toggle('section', s.id, s.name, p.sections[s.id] !== false, s.desc)).join('')}
    <div class="set-row"><span>Colours show</span>${seg('pref-cmode', p.colorMode, [['semantic', 'Good ↔ bad'], ['intensity', 'Habit colour']])}</div>`);
}

function openSyncInfo() {
  const s = store.status;
  const label = { ok: 'Up to date', syncing: 'Syncing…', offline: 'Offline', error: 'Problem syncing', idle: 'Starting…', locked: 'Locked' }[s.state] || s.state;
  openSheet('Sync', `<div class="kv"><span>Status</span><b>${label}</b><span>Waiting to save</span><b>${s.pending} change${s.pending === 1 ? '' : 's'}</b><span>Last sync</span><b>${s.last ? fmtDateTime(new Date(s.last)) : '—'}</b><span>Stored in</span><b><a href="https://github.com/${CFG.owner}/${CFG.repo}/commits/${CFG.branch}" target="_blank" rel="noopener">${esc(CFG.owner)}/${esc(CFG.repo)}@${esc(CFG.branch)}</a></b></div>
    ${s.error ? `<p class="form-error">${esc(s.error)}</p>` : ''}
    <p class="muted small">Every entry is saved on this device right away and committed to GitHub a second later. Without a connection, entries wait here and go up automatically when you are back online.</p>
    <button class="btn primary block" data-act="do-sync">Sync now</button>`);
}

// ---------------------------------------------------------------- sheet, toast, tooltip
function openSheet(title, body) {
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = body;
  const d = $('#sheet');
  if (!d.open) d.showModal();
  $('#sheetBody').scrollTop = 0;
}
function closeSheet() { const d = $('#sheet'); if (d.open) d.close(); }

let toastTimer = null;
let toastFns = [];
// toast('Saved') or toast('Logged', { label, fn }) or toast('Logged', [{ label, fn }, …])
function toast(msg, actions = []) {
  const list = Array.isArray(actions) ? actions : [actions];
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${list.map((a, i) => `<button data-act="toast-action" data-v="${i}">${esc(a.label)}</button>`).join('')}`;
  toastFns = list.map(a => a.fn);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), list.length ? 5000 : 2600);
}

const tipEl = () => $('#tip');
let tipTimer = null;
function showTip(el, x, y) {
  const t = tipEl();
  t.textContent = el.dataset.tip;
  t.hidden = false;
  const r = t.getBoundingClientRect();
  let left = x + 14;
  let top = y - r.height - 12;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (top < 8) top = y + 18;
  t.style.left = `${Math.max(8, left)}px`;
  t.style.top = `${top}px`;
}
document.addEventListener('pointermove', e => {
  if (e.pointerType !== 'mouse') return;
  const el = e.target.closest?.('[data-tip]');
  if (el) showTip(el, e.clientX, e.clientY); else tipEl().hidden = true;
}, { passive: true });
document.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse') return;
  const el = e.target.closest?.('[data-tip]');
  clearTimeout(tipTimer);
  if (el) { showTip(el, e.clientX, e.clientY); tipTimer = setTimeout(() => { tipEl().hidden = true; }, 2600); } else tipEl().hidden = true;
}, { passive: true });

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function confirmSheet(title, text, buttons) {
  openSheet(title, `<p>${text}</p><div class="btn-row end">${buttons.map(b => `<button class="btn ${b.cls || ''}" data-act="${b.act}" ${b.v ? `data-v="${b.v}"` : ''}>${b.label}</button>`).join('')}</div>`);
}

// ---------------------------------------------------------------- actions
// Swap a habit with its neighbour; onlyToday counts only the habits shown on Today.
function moveHabit(id, dir, onlyToday = false) {
  const all = store.view.habits.map(h => h.id);
  const pool = onlyToday ? todayIds() : all;
  const i = pool.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= pool.length) return;
  const a = all.indexOf(id);
  const b = all.indexOf(pool[j]);
  [all[a], all[b]] = [all[b], all[a]];
  store.reorder(all);
}
const habitOf = el => store.view.habitById.get(el.dataset.h || el.dataset.v);

const ACTIONS = {
  inc(el) {
    const h = habitOf(el);
    if (!h) return;
    if (prefs().logDetails !== false) { openLogSheet(h.id); return; }
    const ev = store.log(h.id);
    navigator.vibrate?.(12);
    bumpId = h.id;
    toast(`Logged ${h.name}`, [{ label: 'Details', fn: () => openEvent(ev.id) }, { label: 'Undo', fn: () => store.deleteEvent(ev) }]);
  },
  'log-day': el => {
    const f = el.closest('form');
    f.querySelector('[name=d]').value = el.dataset.v;
    syncDayChips(f);
  },
  step: el => {
    const input = el.closest('.stepper').querySelector('input');
    input.value = String(Math.max(1, (parseFloat(input.value) || 1) + Number(el.dataset.v)));
  },
  pick: el => {
    const i = +el.dataset.v;
    if (ui.picks.has(i)) ui.picks.delete(i); else ui.picks.add(i);
    render();
  },
  'add-picked': () => {
    const n = addSuggestions([...ui.picks]);
    ui.picks.clear();
    if (n) toast(`Added ${n} habit${n > 1 ? 's' : ''}`);
  },
  prefill: el => {
    const s = SUGGEST[+el.dataset.v];
    const f = $('#habitForm');
    if (!s || !f) return;
    const set = (name, value) => { const x = f.querySelector(`[name="${name}"]`); if (x) x.value = value; };
    set('name', s.name);
    set('emoji', s.emoji);
    const k = f.querySelector(`[name=kind][value="${s.kind}"]`);
    if (k) k.checked = true;
    set('gtype', s.goal?.type || '');
    set('gcount', s.goal?.count ?? '');
    set('gperiod', s.goal?.period || 'day');
    $$('[data-act=prefill]', f).forEach(c => { c.classList.toggle('on', c === el); c.setAttribute('aria-pressed', String(c === el)); });
  },
  'menu-move': el => { moveHabit(el.dataset.h, +el.dataset.v, true); openHabitMenu(el.dataset.h); },
  dec(el) {
    const h = store.view.habitById.get(el.dataset.h);
    const tk = S.dayKey(new Date());
    const ev = [...evsOf(h)].reverse().find(e => S.dayKey(new Date(e.t)) === tk);
    if (!ev) return;
    store.deleteEvent(ev);
    toast(`Removed one ${h.name}`, { label: 'Undo', fn: () => store.restore(ev) });
  },
  'habit-new': () => openHabitEditor(null),
  'habit-edit': el => openHabitEditor(el.dataset.h),
  'habit-menu': el => openHabitMenu(el.dataset.h),
  'habit-hide': el => { const h = store.view.habitById.get(el.dataset.h); store.upsertHabit({ id: h.id, showOnToday: false }); closeSheet(); toast(`${h.name} hidden from Today`, { label: 'Undo', fn: () => store.upsertHabit({ id: h.id, showOnToday: true }) }); },
  'habit-up': el => moveHabit(el.dataset.h, -1),
  'habit-down': el => moveHabit(el.dataset.h, 1),
  'habit-delete': el => {
    const h = store.view.habitById.get(el.dataset.h);
    const n = evsOf(h).length;
    confirmSheet(`Delete ${h.name}?`, `This removes the habit and its ${fmtInt(n)} entr${n === 1 ? 'y' : 'ies'}. Archiving hides it but keeps the history.`, [
      { label: 'Archive instead', act: 'habit-archive', v: h.id },
      { label: 'Delete', act: 'habit-purge', v: h.id, cls: 'danger' },
    ]);
  },
  'habit-archive': el => {
    const h = habitOf(el);
    if (!h) return;
    store.upsertHabit({ id: h.id, archived: true });
    closeSheet();
    toast(`${h.name} archived`, { label: 'Undo', fn: () => store.upsertHabit({ id: h.id, archived: false }) });
  },
  'habit-purge': el => { store.deleteHabit(el.dataset.v, true); closeSheet(); toast('Deleted'); },
  'pick-emoji': el => { const i = $('#habitForm [name=emoji]'); if (i) i.value = el.dataset.v; },
  'goto-dash': el => { closeSheet(); location.hash = `#dash/${encodeURIComponent(el.dataset.h)}`; },
  'dash-habit': el => { ui.dash = el.dataset.v; saveUI(); setParam(ui.dash); render(); scrollTo({ top: 0 }); },
  range: el => { ui.range = el.dataset.v; saveUI(); render(); },
  gran: el => { ui.gran = el.dataset.v; saveUI(); render(); },
  heat: el => { ui.heat = el.dataset.v; saveUI(); render(); },
  customize: () => openCustomize(),
  'cal-habit': el => { ui.cal = el.dataset.v; saveUI(); setParam(ui.cal); render(); },
  'cal-prev': () => { const m = ui.calMonth ? S.parseDay(`${ui.calMonth}-01`) : S.startOfMonth(new Date()); ui.calMonth = S.dayKey(S.addMonths(m, -1)).slice(0, 7); saveUI(); render(); },
  'cal-next': () => { const m = ui.calMonth ? S.parseDay(`${ui.calMonth}-01`) : S.startOfMonth(new Date()); ui.calMonth = S.dayKey(S.addMonths(m, 1)).slice(0, 7); saveUI(); render(); },
  'cal-today': () => { ui.calMonth = null; saveUI(); render(); },
  'cal-day': el => openDay(el.dataset.v),
  'hist-habit': el => { ui.hist = el.dataset.v; ui.histLimit = 150; saveUI(); setParam(ui.hist); render(); },
  'hist-for': el => { closeSheet(); location.hash = `#hist/${encodeURIComponent(el.dataset.h || el.dataset.v)}`; },
  'hist-more': () => { ui.histLimit += 300; render(); },
  'ev-edit': el => openEvent(el.dataset.v),
  'ev-delete': el => { const e = store.view.eventById.get(el.dataset.v); if (!e) return; store.deleteEvent(e); closeSheet(); toast('Entry deleted', { label: 'Undo', fn: () => store.restore(e) }); },
  'sync-now': () => openSyncInfo(),
  'do-sync': async () => { await store.sync(); openSyncInfo(); },
  'sheet-close': () => closeSheet(),
  'toast-action': el => { const f = toastFns[+el.dataset.v]; toastFns = []; $('#toast').classList.remove('show'); f?.(); },
  'pref-theme': el => store.setPrefs({ theme: el.dataset.v }),
  'pref-cmode': el => { store.setPrefs({ colorMode: el.dataset.v }); if ($('#sheet').open) setTimeout(openCustomize, 0); },
  'pref-week': el => store.setPrefs({ weekStart: +el.dataset.v }),
  'pal-preset': el => { const x = PALETTES[el.dataset.v]; store.setPrefs({ palette: { bad: x.bad, mid: x.mid, good: x.good } }); },
  install: async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice.catch(() => null); installPrompt = null; render(); },
  'sec-lock': () => { secUntil = 0; render(); },
  'export-json': () => {
    const v = store.view;
    download(`tally-${S.dayKey(new Date())}.json`, JSON.stringify({ app: 'tally', version: 1, exported: new Date().toISOString(), habits: v.config.habits, prefs: v.config.prefs, events: v.events }, null, 2), 'application/json');
  },
  'export-csv': () => {
    const v = store.view;
    const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const rows = ['date,time,habit,type,quantity,note', ...v.events.map(e => {
      const d = new Date(e.t);
      const h = v.habitById.get(e.h);
      return [S.dayKey(d), fmtHM(d), q(h?.name || 'deleted'), h?.kind || '', S.qty(e), q(e.n)].join(',');
    })];
    download(`tally-${S.dayKey(new Date())}.csv`, rows.join('\n'), 'text/csv');
  },
  import: () => $('#importFile')?.click(),
  redownload: async () => { toast('Downloading from GitHub…'); await store.redownload(); toast(store.status.error || 'Up to date'); },
  forget: () => confirmSheet('Forget this device?', 'Tally will ask for your password next time. Entries not yet synced from this device would be lost.', [
    { label: 'Cancel', act: 'sheet-close' }, { label: 'Forget', act: 'forget-yes', cls: 'danger' },
  ]),
  'forget-yes': async () => {
    await store.forgetDevice();
    try { localStorage.removeItem(UI_KEY); } catch { /* ignore */ }
    location.reload();
  },
  'reset-device': async () => { await store.forgetDevice(); location.reload(); },
  retry: () => location.reload(),
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  fn(el, e);
});

document.addEventListener('change', async e => {
  const el = e.target;
  const kind = el.dataset?.change;
  if (!kind) return;
  if (kind === 'log-date') syncDayChips(el.form);
  if (kind === 'pref-bool') store.setPrefs({ [el.dataset.k]: el.checked });
  if (kind === 'section') store.setPrefs({ sections: { [el.dataset.k]: el.checked } });
  if (kind === 'pal') store.setPrefs({ palette: { [el.dataset.k]: el.value } });
  if (kind === 'device') { await store.setDevice({ [el.dataset.k]: el.checked }); toast(el.checked ? 'Password will be asked every time' : 'Stays unlocked on this device'); }
  if (kind === 'import-file') {
    const file = el.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.habits) || !Array.isArray(data.events)) throw new Error('Not a Tally export');
      const v = store.view;
      const ops = [];
      for (const h of data.habits) if (h && h.id && h.name) ops.push({ op: 'habit', habit: h });
      let n = 0;
      for (const ev of data.events) {
        if (!ev || !ev.id || !ev.h || !ev.t || v.eventById.has(ev.id)) continue;
        ops.push({ op: 'add', ev: { id: String(ev.id), h: String(ev.h), t: new Date(ev.t).toISOString(), ...(ev.q && ev.q !== 1 ? { q: +ev.q } : {}), ...(ev.n ? { n: String(ev.n) } : {}) } });
        n++;
      }
      if (data.prefs) ops.push({ op: 'prefs', prefs: data.prefs });
      store.importOps(ops);
      toast(`Imported ${data.habits.length} habits and ${n} new entries`);
    } catch (err) {
      toast(`Import failed: ${err.message}`);
    }
    el.value = '';
  }
});

document.addEventListener('input', e => {
  if (e.target.dataset?.input === 'hist-q') { ui.q = e.target.value; ui.histLimit = 150; render(); }
});

// ---------------------------------------------------------------- forms
const FORMS = {
  async setupForm(f, fd) {
    const err = $('.form-error', f);
    err.textContent = '';
    const token = String(fd.get('token')).trim();
    const pw = String(fd.get('pw'));
    if (pw !== fd.get('pw2')) { err.textContent = 'The two passwords don’t match.'; return; }
    if (pw.length < 8) { err.textContent = 'Use at least 8 characters.'; return; }
    busy(f, 'Encrypting and creating your vault…');
    try { await store.setup(token, pw); enterApp(); } catch (e) { err.textContent = explain(e); } finally { busy(f, null); }
  },
  async unlockForm(f, fd) {
    const err = $('.form-error', f);
    err.textContent = '';
    busy(f, 'Unlocking…');
    try { await store.unlock(String(fd.get('pw'))); enterApp(); } catch (e) { err.textContent = e instanceof LockedError ? 'Wrong password.' : explain(e); } finally { busy(f, null); }
  },
  async secUnlock(f, fd) {
    const ok = await store.checkPassword(String(fd.get('pw')));
    if (!ok) { $('#secErr').textContent = 'Wrong password.'; return; }
    secUntil = Date.now() + 5 * 60000;
    render();
  },
  async tokForm(f, fd) {
    try { await store.replaceToken(String(fd.get('token')).trim()); toast('Token replaced'); render(); } catch (e) { toast(explain(e)); }
  },
  async pwForm(f, fd) {
    const pw = String(fd.get('pw'));
    if (pw !== fd.get('pw2')) { toast('The two passwords don’t match'); return; }
    toast('Re-encrypting everything…');
    try { await store.changePassword(pw); toast('Password changed'); f.reset(); } catch (e) { toast(explain(e)); }
  },
  habitForm(f, fd) {
    const name = String(fd.get('name')).trim();
    if (!name) return;
    const gtype = fd.get('gtype');
    const gcount = fd.get('gcount');
    const goal = gtype && gcount !== '' ? { type: gtype, count: Math.max(gtype === 'min' ? 1 : 0, +gcount), period: fd.get('gperiod') } : null;
    const isNew = f.dataset.new === '1';
    const habit = {
      id: f.dataset.id, name, emoji: String(fd.get('emoji') || '').trim(), kind: fd.get('kind') || 'bad',
      color: fd.get('color') || SWATCHES[0], goal, showOnToday: fd.get('showOnToday') === 'on', archived: fd.get('archived') === 'on',
    };
    if (isNew) { habit.createdAt = new Date().toISOString(); habit.order = store.view.habits.length; }
    store.upsertHabit(habit);
    closeSheet();
    toast(isNew ? `Added ${name}` : 'Saved');
  },
  logForm(f, fd) {
    const h = store.view.habitById.get(f.dataset.h);
    if (!h) return;
    const err = $('.form-error', f);
    const now = new Date();
    let t = readWhen(fd);
    if (!t) { err.textContent = 'Pick a date and a time.'; return; }
    // Date and time left as they were: use the exact moment of tapping "Log".
    if (fd.get('d') === S.dayKey(now) && fd.get('time') === f.dataset.opened) t = now;
    if (t - now > 60000) { err.textContent = 'That’s in the future. Pick an earlier time.'; return; }
    const ev = store.log(h.id, { t: t.toISOString(), q: +fd.get('q') || 1, n: String(fd.get('n') || '').trim() });
    closeSheet();
    navigator.vibrate?.(12);
    const today = S.dayKey(t) === S.dayKey(now);
    if (today) bumpId = h.id;
    toast(`Logged ${h.name}${today ? '' : ` on ${fmtShort(t)}`}`, { label: 'Undo', fn: () => store.deleteEvent(ev) });
  },
  dayForm(f, fd) {
    const [hh, mm] = String(fd.get('time')).split(':').map(Number);
    const d = S.parseDay(f.dataset.day);
    d.setHours(hh, mm, 0, 0);
    const h = store.view.habitById.get(fd.get('h'));
    store.log(h.id, { t: d.toISOString(), q: +fd.get('q') || 1, n: String(fd.get('n') || '').trim() });
    toast(`Added ${h.name}`);
    openDay(f.dataset.day);
  },
  evForm(f, fd) {
    const e = store.view.eventById.get(f.dataset.id);
    if (!e) return;
    const orig = new Date(e.t);
    let t = readWhen(fd);
    if (!t) { $('.form-error', f).textContent = 'Pick a date and a time.'; return; }
    if (fd.get('d') === S.dayKey(orig) && fd.get('time') === fmtHM(orig)) t = orig; // keep the seconds
    if (t - Date.now() > 60000) { $('.form-error', f).textContent = 'That’s in the future. Pick an earlier time.'; return; }
    const ev = { id: e.id, h: String(fd.get('h')), t: t.toISOString() };
    const q = +fd.get('q');
    if (q && q !== 1) ev.q = q;
    const n = String(fd.get('n') || '').trim();
    if (n) ev.n = n;
    store.editEvent(ev, e.t);
    closeSheet();
    toast('Entry updated');
  },
};
function busy(f, text) {
  const b = $('[type=submit]', f);
  const s = $('.busy', f);
  if (b) b.disabled = !!text;
  if (s) s.textContent = text || '';
}
document.addEventListener('submit', async e => {
  const f = e.target;
  const fn = FORMS[f.id];
  if (!fn) return;
  e.preventDefault();
  await fn(f, new FormData(f));
});

// ---------------------------------------------------------------- gate (setup / unlock)
function showGate(kind, message = '') {
  entered = false;
  closeSheet();
  $('#app').hidden = true;
  const g = $('#gate');
  g.hidden = false;
  const repo = `${esc(CFG.owner)}/${esc(CFG.repo)}`;
  if (kind === 'setup') {
    g.innerHTML = `<div class="gate-card">${LOGO}<h1>Welcome to Tally</h1>
      <p class="muted">A private log of your habits. Everything is encrypted with your password, then saved as commits in <b>${repo}</b>. Nothing runs on a server.</p>
      <form id="setupForm" class="form">
        <label class="field"><span>GitHub token</span><input name="token" type="password" required autocomplete="off" placeholder="github_pat_…"></label>
        <details class="hint"><summary>How do I get a token?</summary><ol>
          <li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">new fine-grained token</a>.</li>
          <li>Repository access → <b>Only select repositories</b> → <b>${repo}</b>.</li>
          <li>Permissions → Repository → <b>Contents: Read and write</b>.</li>
          <li>Generate, copy and paste it here. It is stored only encrypted.</li></ol></details>
        <label class="field"><span>Choose a password</span><input name="pw" type="password" required minlength="8" autocomplete="new-password"></label>
        <label class="field"><span>Repeat it</span><input name="pw2" type="password" required autocomplete="new-password"></label>
        <p class="note">This password encrypts all your data. It can’t be reset: forget it and the data can’t be read. A few random words make a strong one that is easy to remember.</p>
        <button class="btn primary block" type="submit">Create my encrypted vault</button>
        <p class="busy muted small"></p><p class="form-error"></p>
      </form></div>`;
  } else if (kind === 'error') {
    g.innerHTML = `<div class="gate-card">${LOGO}<h1>Can’t reach GitHub</h1><p class="muted">${esc(message || 'Check your connection and try again.')}</p><button class="btn primary block" data-act="retry">Try again</button></div>`;
  } else {
    g.innerHTML = `<div class="gate-card">${LOGO}<h1>Welcome back</h1>
      ${message ? `<p class="note">${esc(message)}</p>` : '<p class="muted">Enter your password to open Tally on this device.</p>'}
      <form id="unlockForm" class="form"><label class="field"><span>Password</span><input name="pw" type="password" required autocomplete="current-password" autofocus></label>
      <button class="btn primary block" type="submit">Unlock</button><p class="busy muted small"></p><p class="form-error"></p></form>
      <p class="muted small center">Data: ${repo} · <button class="link" data-act="reset-device">reset this device</button></p></div>`;
  }
  setTimeout(() => g.querySelector('input')?.focus(), 50);
}

function enterApp() {
  entered = true;
  const g = $('#gate');
  g.hidden = true;
  g.innerHTML = '';
  $('#app').hidden = false;
  applyTheme();
  render();
  updateSyncPill();
}

// ---------------------------------------------------------------- chrome
function applyTheme() {
  const p = prefs();
  const root = document.documentElement;
  if (p.theme === 'auto') delete root.dataset.theme; else root.dataset.theme = p.theme;
  try { localStorage.setItem('tally-theme', JSON.stringify(p.theme)); } catch { /* ignore */ }
  root.style.setProperty('--good', p.palette.good);
  root.style.setProperty('--mid', p.palette.mid);
  root.style.setProperty('--bad', p.palette.bad);
}

function updateSyncPill() {
  const s = store.status;
  const el = $('#syncPill');
  let state = 'ok';
  let txt = 'Synced';
  if (s.state === 'syncing') { state = 'busy'; txt = s.pending ? 'Saving…' : 'Syncing…'; } else if (s.state === 'offline') { state = 'warn'; txt = s.pending ? `${s.pending} waiting · offline` : 'Offline'; } else if (s.state === 'error') { state = 'err'; txt = 'Sync issue'; } else if (s.pending) { state = 'busy'; txt = `${s.pending} to save`; } else if (s.state === 'idle') { state = 'busy'; txt = 'Loading'; }
  el.dataset.state = state;
  $('.txt', el).textContent = txt;
  el.title = s.error || (s.last ? `Last synced ${fmtTime(new Date(s.last))}` : '');
}

function buildNav() {
  const html = TABS.map(t => `<a href="#${t.id}" data-tab="${t.id}">${ICON[t.icon]}<span>${t.name}</span></a>`).join('');
  $('.tabs-top').innerHTML = html;
  $('.tabs-bottom').innerHTML = html;
}

window.addEventListener('hashchange', () => { route(); closeSheet(); render(); scrollTo({ top: 0 }); });
let resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(mountCharts, 150); });
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; if (ui.tab === 'set') renderSoon(); });
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });
document.addEventListener('keydown', e => {
  if (!entered || $('#sheet').open || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
  if (ui.tab === 'log' && /^[1-9]$/.test(e.key)) {
    const btn = $$('.btn-plus')[+e.key - 1];
    if (btn) { e.preventDefault(); ACTIONS.inc(btn); }
  }
});
// keep "clean for 2h 14m" fresh
setInterval(() => {
  if (entered && ui.tab === 'log' && !$('#sheet').open && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) render();
}, 30000);

store.addEventListener('change', () => { applyTheme(); renderSoon(); });
store.addEventListener('status', updateSyncPill);
store.addEventListener('locked', e => showGate('unlock', e.detail?.message));

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  // When a new version is deployed, the new service worker takes over and the page reloads
  // itself — right away if nothing is being edited, otherwise after you tap "Reload".
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    const busyNow = $('#sheet').open || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (!busyNow) { reloading = true; location.reload(); return; }
    toast('Tally was updated', { label: 'Reload', fn: () => location.reload() });
  });
  navigator.serviceWorker.register('sw.js').catch(() => { /* optional */ });
}

// ---------------------------------------------------------------- boot
(async function boot() {
  buildNav();
  applyTheme();
  const state = await store.boot();
  if (state === 'ready') enterApp();
  else showGate(state, state === 'error' ? explain(store.bootError) : '');
}());
