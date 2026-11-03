// Date helpers (local time) and per-habit statistics.
export const DAY = 86400000;
const pad = n => String(n).padStart(2, '0');

export const dayKey = d => {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
};
export const parseDay = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
export const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const daysInMonth = d => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
export const addMonths = (d, n) => {
  const x = new Date(d);
  const day = x.getDate();
  x.setDate(1);
  x.setMonth(x.getMonth() + n);
  x.setDate(Math.min(day, daysInMonth(x)));
  return x;
};
export const startOfWeek = (d, ws = 1) => { const x = startOfDay(d); return addDays(x, -((x.getDay() - ws + 7) % 7)); };
export const startOfMonth = d => { const x = startOfDay(d); x.setDate(1); return x; };
export const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / DAY);
export function* eachDay(start, end) { for (let d = startOfDay(start); d < end; d = addDays(d, 1)) yield d; }

export const qty = e => e.q || 1;

export function dailyMap(evs) {
  const m = new Map();
  for (const e of evs) { const k = dayKey(new Date(e.t)); m.set(k, (m.get(k) || 0) + qty(e)); }
  return m;
}

export function habitStart(h, evs) {
  let t = h.createdAt ? Date.parse(h.createdAt) : Date.now();
  if (evs.length) t = Math.min(t, Date.parse(evs[0].t));
  return startOfDay(t);
}

export function sumRange(daily, start, end) {
  let s = 0;
  for (const d of eachDay(start, end)) s += daily.get(dayKey(d)) || 0;
  return s;
}

export const RANGES = [
  { id: '7d', label: '7D', name: 'Last 7 days', days: 7 },
  { id: '30d', label: '30D', name: 'Last 30 days', days: 30 },
  { id: '90d', label: '90D', name: 'Last 90 days', days: 90 },
  { id: '6m', label: '6M', name: 'Last 6 months', months: 6 },
  { id: '1y', label: '1Y', name: 'Last 12 months', months: 12 },
  { id: 'all', label: 'All', name: 'All time' },
];

export function rangeBounds(id, now, earliest) {
  const r = RANGES.find(x => x.id === id) || RANGES[1];
  const end = addDays(startOfDay(now), 1);
  let start;
  if (r.days) start = addDays(end, -r.days);
  else if (r.months) start = addMonths(end, -r.months);
  else start = earliest && earliest < end ? startOfDay(earliest) : addDays(end, -30);
  return { start, end, id: r.id, name: r.name };
}

export function autoGran(range) {
  const d = daysBetween(range.start, range.end);
  return d <= 62 ? 'day' : d <= 240 ? 'week' : 'month';
}

export function buckets(daily, start, end, gran, weekStart = 1) {
  const out = [];
  let cur = gran === 'day' ? startOfDay(start) : gran === 'week' ? startOfWeek(start, weekStart) : startOfMonth(start);
  while (cur < end) {
    const next = gran === 'day' ? addDays(cur, 1) : gran === 'week' ? addDays(cur, 7) : addMonths(startOfMonth(cur), 1);
    let value = 0;
    let days = 0;
    for (const d of eachDay(cur < start ? start : cur, next < end ? next : end)) { value += daily.get(dayKey(d)) || 0; days++; }
    const full = daysBetween(cur, next);
    out.push({ start: cur, end: next, value, days, full, partial: days < full });
    cur = next;
  }
  return out;
}

export function rolling(values, w) {
  return values.map((_, i) => {
    if (i < w - 1) return null;
    let s = 0;
    for (let j = i - w + 1; j <= i; j++) s += values[j];
    return s / w;
  });
}

export function goalDaily(h) {
  const g = h.goal;
  if (!g || g.count == null || !g.type) return null;
  return g.period === 'week' ? g.count / 7 : g.count;
}

// What counts as "a lot" in one day for this habit: the goal if there is one,
// otherwise the 90th percentile of the days it happened.
export function refDaily(h, daily) {
  const g = goalDaily(h);
  if (g != null) return Math.max(1, g);
  const vals = [...daily.values()].filter(v => v > 0).sort((a, b) => a - b);
  if (!vals.length) return 1;
  return Math.max(1, vals[Math.floor((vals.length - 1) * 0.9)]);
}

export function successFn(h) {
  const g = h.goal;
  if (h.kind === 'good') {
    const need = g && g.type === 'min' && g.period === 'day' ? Math.max(1, g.count) : 1;
    return c => c >= need;
  }
  if (h.kind === 'bad') {
    const lim = g && g.type === 'max' && g.period === 'day' ? g.count : 0;
    return c => c <= lim;
  }
  return c => c > 0;
}

// Weekly goals are judged per week (e.g. "exercise at least 3 times a week").
function weekStreaks(h, daily, hs, now, weekStart) {
  const g = h.goal;
  const ok = v => (g.type === 'min' ? v >= g.count : v <= g.count);
  const cur = startOfWeek(now, weekStart);
  const weeks = [];
  for (let w = startOfWeek(hs, weekStart); w <= cur; w = addDays(w, 7)) weeks.push(sumRange(daily, w, addDays(w, 7)));
  let longest = 0;
  let run = 0;
  weeks.forEach((v, i) => {
    const inProgress = i === weeks.length - 1;
    if (ok(v)) { run++; longest = Math.max(longest, run); } else if (!(inProgress && g.type === 'min')) run = 0;
  });
  let i = weeks.length - 1;
  if (i >= 0 && !ok(weeks[i])) { if (g.type === 'max') return { current: 0, longest, unit: 'w' }; i--; }
  let current = 0;
  while (i >= 0 && ok(weeks[i])) { current++; i--; }
  return { current, longest, unit: 'w' };
}

export function streaks(h, daily, hs, now, weekStart = 1) {
  if (h.goal?.type && h.goal.period === 'week' && h.kind !== 'neutral') return weekStreaks(h, daily, hs, now, weekStart);
  const ok = successFn(h);
  const today = startOfDay(now);
  let longest = 0;
  let run = 0;
  for (const d of eachDay(hs, addDays(today, 1))) {
    if (ok(daily.get(dayKey(d)) || 0)) { run++; if (run > longest) longest = run; } else run = 0;
  }
  let current = 0;
  let d = today;
  if (!ok(daily.get(dayKey(d)) || 0)) {
    if (h.kind === 'bad') return { current: 0, longest, unit: 'd' };
    d = addDays(d, -1); // a good habit still has today to happen
  }
  while (d >= hs && ok(daily.get(dayKey(d)) || 0)) { current++; d = addDays(d, -1); }
  return { current, longest, unit: 'd' };
}

const median = a => {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function summarize(h, evs, daily, range, now, weekStart = 1) {
  const hs = habitStart(h, evs);
  const start = range.start > hs ? range.start : hs;
  const end = range.end;
  const days = Math.max(1, daysBetween(start, end));
  const total = sumRange(daily, start, end);

  const len = range.end - range.start;
  const pStartRaw = new Date(range.start - len);
  const pStart = pStartRaw > hs ? pStartRaw : hs;
  const pEnd = range.start;
  const pDays = pEnd > pStart ? daysBetween(pStart, pEnd) : 0;
  const pTotal = pDays ? sumRange(daily, pStart, pEnd) : 0;
  const perDay = total / days;
  const pPerDay = pDays ? pTotal / pDays : null;
  let change = null;
  if (pPerDay != null) change = pPerDay ? (perDay - pPerDay) / pPerDay : (perDay > 0 ? Infinity : 0);

  const inRange = evs.filter(e => { const t = Date.parse(e.t); return t >= start && t < end; });
  const weekday = Array(7).fill(0);
  const hour = Array(24).fill(0);
  const punch = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const e of inRange) {
    const d = new Date(e.t);
    const q = qty(e);
    weekday[d.getDay()] += q;
    hour[d.getHours()] += q;
    punch[d.getDay()][d.getHours()] += q;
  }
  const weekdayDays = Array(7).fill(0);
  let active = 0;
  let best = null;
  for (const d of eachDay(start, end)) {
    const v = daily.get(dayKey(d)) || 0;
    weekdayDays[d.getDay()]++;
    if (v > 0) active++;
    if (!best || v > best.value) best = { date: d, value: v };
  }
  const times = inRange.map(e => Date.parse(e.t));
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  const last = evs.length ? new Date(evs[evs.length - 1].t) : null;

  let goal = null;
  if (h.goal && h.goal.type && h.goal.count != null) {
    const g = h.goal;
    const bs = buckets(daily, start, end, g.period === 'week' ? 'week' : 'day', weekStart);
    const nowT = now.getTime();
    let met = 0;
    let n = 0;
    for (const b of bs) {
      const complete = b.end <= nowT;
      if (g.type === 'min' && !complete) continue; // can still be reached
      if (g.type === 'max' && b.days < (g.period === 'week' ? 1 : 1)) continue;
      n++;
      if (g.type === 'max' ? b.value <= g.count : b.value >= g.count) met++;
    }
    goal = { met, n, pct: n ? met / n : null };
  }

  return {
    hs, start, end, days, total, perDay, perWeek: perDay * 7, perMonth: perDay * 30.44,
    pTotal, pDays, pPerDay, change,
    count: inRange.length, weekday, weekdayDays, hour, punch, active, zero: days - active, best,
    gaps, gapMedian: median(gaps), gapMax: gaps.length ? Math.max(...gaps) : null,
    gapAvg: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
    last, streak: streaks(h, daily, hs, now, weekStart), goal,
  };
}

export const GAP_BUCKETS = [
  { max: 3600e3, label: '<1h' },
  { max: 3 * 3600e3, label: '1–3h' },
  { max: 6 * 3600e3, label: '3–6h' },
  { max: 12 * 3600e3, label: '6–12h' },
  { max: DAY, label: '12–24h' },
  { max: 2 * DAY, label: '1–2d' },
  { max: 7 * DAY, label: '2–7d' },
  { max: Infinity, label: '>1w' },
];
export function gapHistogram(gaps) {
  const out = GAP_BUCKETS.map(b => ({ ...b, value: 0 }));
  for (const g of gaps) out.find(b => g < b.max).value++;
  return out;
}
