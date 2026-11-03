// Hand-drawn SVG charts sized to their container (no libraries, works offline).
import { addDays, startOfWeek, daysBetween, dayKey } from './stats.js';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r1 = n => Math.round(n * 10) / 10;

export function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
const tick = v => (v >= 1000 ? `${r1(v / 1000)}k` : String(r1(v)));

function frame(W, H, cls = '') {
  return `<svg class="ch ${cls}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img">`;
}

function yGrid(s, { L, R, W, y, top }) {
  for (const f of [0, 0.5, 1]) {
    const yy = r1(y(top * f));
    s.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/>`);
    s.push(`<text class="ax" x="${L - 6}" y="${yy + 3.5}" text-anchor="end">${tick(top * f)}</text>`);
  }
}

// Bars over time, with an optional rolling-average line and goal line.
export function timeline({ buckets, width, height = 200, fill, avg, goal, label, tip }) {
  const W = Math.max(240, Math.floor(width));
  const H = height;
  const L = 30, R = 8, T = 12, B = 24;
  const iw = W - L - R, ih = H - T - B;
  const vals = buckets.map(b => b.value);
  const top = niceMax(Math.max(1, ...vals, ...(avg || []).filter(Number.isFinite), goal || 0));
  const y = v => T + ih - (v / top) * ih;
  const n = buckets.length || 1;
  const bw = iw / n;
  const gap = bw > 14 ? Math.min(6, bw * 0.28) : bw > 5 ? 1.2 : 0.4;
  const s = [frame(W, H)];
  yGrid(s, { L, R, W, y, top });
  buckets.forEach((b, i) => {
    if (!(b.value > 0)) return;
    const h = Math.max(2, (ih * b.value) / top);
    const w = Math.max(0.6, bw - gap);
    s.push(`<rect x="${r1(L + i * bw + gap / 2)}" y="${r1(T + ih - h)}" width="${r1(w)}" height="${r1(h)}" rx="${r1(Math.min(3, w / 2.5))}" fill="${fill(b)}"${b.partial ? ' class="partial"' : ''}/>`);
  });
  if (goal) s.push(`<line class="goal" x1="${L}" x2="${W - R}" y1="${r1(y(goal))}" y2="${r1(y(goal))}"/>`);
  if (avg) {
    let d = '';
    avg.forEach((v, i) => { if (v != null) d += `${d ? 'L' : 'M'}${r1(L + i * bw + bw / 2)},${r1(y(v))}`; });
    if (d) s.push(`<path class="avg" d="${d}"/>`);
  }
  const maxLabels = Math.max(2, Math.floor(iw / 62));
  const step = Math.ceil(n / maxLabels);
  buckets.forEach((b, i) => {
    if (i % step) return;
    s.push(`<text class="ax" x="${r1(L + i * bw + bw / 2)}" y="${H - 7}" text-anchor="middle">${esc(label(b, i))}</text>`);
  });
  buckets.forEach((b, i) => {
    s.push(`<rect class="hit" x="${r1(L + i * bw)}" y="${T}" width="${r1(bw)}" height="${ih}" data-tip="${esc(tip(b, i))}"/>`);
  });
  s.push('</svg>');
  return s.join('');
}

// GitHub-style calendar: one column per week. Returns its natural width (container scrolls).
export function heatmap({ daily, start, end, color, weekStart = 1, tip, monthName, dayName, width = 0, gap = 3 }) {
  const first = startOfWeek(start, weekStart);
  const weeks = Math.max(1, Math.ceil(daysBetween(first, end) / 7));
  const L = 30, T = 18;
  const cell = Math.max(10, Math.min(18, Math.floor((width - L) / weeks - gap)));
  const step = cell + gap;
  const W = L + weeks * step;
  const H = T + 7 * step;
  const s = [frame(W, H, 'heat')];
  const labels = [];
  for (let w = 0; w < weeks; w++) {
    for (let i = 0; i < 7; i++) {
      const d = addDays(first, w * 7 + i);
      if (d < start || d >= end) continue;
      if (d.getDate() === 1) labels.push({ w, d });
      const c = daily.get(dayKey(d)) || 0;
      const f = color(c, d);
      s.push(`<rect x="${L + w * step}" y="${T + i * step}" width="${cell}" height="${cell}" rx="2.5" ${f ? `fill="${f}"` : 'class="empty"'} data-tip="${esc(tip(c, d))}"/>`);
    }
  }
  if (!labels.length || labels[0].w > 2) labels.unshift({ w: 0, d: start });
  for (const l of labels) s.push(`<text class="ax" x="${L + l.w * step}" y="${T - 6}">${esc(monthName(l.d))}</text>`);
  for (const i of [1, 3, 5]) s.push(`<text class="ax" x="${L - 6}" y="${T + i * step + cell - 2}" text-anchor="end">${esc(dayName((weekStart + i) % 7))}</text>`);
  s.push('</svg>');
  return { svg: s.join(''), width: W };
}

// Weekday × hour "punch card": circle area = how often it happens then.
export function punch({ m, width, color, weekStart = 1, tip, dayName, hourLabel }) {
  const W = Math.max(280, Math.floor(width));
  const L = 36, R = 6, T = 6, B = 20;
  const cw = (W - L - R) / 24;
  const ch = Math.min(28, Math.max(16, cw * 1.15));
  const H = T + 7 * ch + B;
  const max = Math.max(1, ...m.flat());
  const s = [frame(W, H)];
  for (let r = 0; r < 7; r++) {
    const day = (weekStart + r) % 7;
    const cy = T + r * ch + ch / 2;
    s.push(`<text class="ax" x="${L - 8}" y="${r1(cy + 3.5)}" text-anchor="end">${esc(dayName(day))}</text>`);
    for (let h = 0; h < 24; h++) {
      const v = m[day][h];
      const cx = L + h * cw + cw / 2;
      const rmax = Math.min(cw, ch) / 2 - 1;
      if (v) s.push(`<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r1(Math.max(1.8, rmax * Math.sqrt(v / max)))}" fill="${color}" fill-opacity="${r1(0.35 + 0.65 * (v / max))}"/>`);
      else s.push(`<circle class="zero" cx="${r1(cx)}" cy="${r1(cy)}" r="1"/>`);
      s.push(`<rect class="hit" x="${r1(L + h * cw)}" y="${r1(T + r * ch)}" width="${r1(cw)}" height="${r1(ch)}" data-tip="${esc(tip(day, h, v))}"/>`);
    }
  }
  const every = cw < 13 ? 6 : 3;
  for (let h = 0; h < 24; h += every) s.push(`<text class="ax" x="${r1(L + h * cw + cw / 2)}" y="${H - 5}" text-anchor="middle">${esc(hourLabel(h))}</text>`);
  s.push('</svg>');
  return s.join('');
}

// Simple vertical bars with a label under each.
export function bars({ values, labels, width, height = 140, fill, tip }) {
  const W = Math.max(200, Math.floor(width));
  const H = height;
  const L = 26, R = 4, T = 10, B = 22;
  const iw = W - L - R, ih = H - T - B;
  const top = niceMax(Math.max(1, ...values));
  const y = v => T + ih - (v / top) * ih;
  const n = values.length;
  const bw = iw / n;
  const gap = Math.min(10, bw * 0.3);
  const s = [frame(W, H)];
  yGrid(s, { L, R, W, y, top });
  const step = Math.ceil(n / Math.max(2, Math.floor(iw / 30)));
  values.forEach((v, i) => {
    const x = L + i * bw;
    if (v > 0) {
      const h = Math.max(2, (ih * v) / top);
      s.push(`<rect x="${r1(x + gap / 2)}" y="${r1(T + ih - h)}" width="${r1(bw - gap)}" height="${r1(h)}" rx="${r1(Math.min(3, (bw - gap) / 2.5))}" fill="${fill(v, i)}"/>`);
    }
    if (i % step === 0) s.push(`<text class="ax" x="${r1(x + bw / 2)}" y="${H - 7}" text-anchor="middle">${esc(labels[i])}</text>`);
    s.push(`<rect class="hit" x="${r1(x)}" y="${T}" width="${r1(bw)}" height="${ih}" data-tip="${esc(tip(v, i))}"/>`);
  });
  s.push('</svg>');
  return s.join('');
}

// Several habits on one time axis.
// partial: [firstIsPartial, lastIsPartial] — those end segments are drawn dashed.
export function lines({ series, n, width, height = 210, label, tip, partial = [false, false] }) {
  const W = Math.max(240, Math.floor(width));
  const H = height;
  const L = 30, R = 10, T = 12, B = 24;
  const iw = W - L - R, ih = H - T - B;
  const top = niceMax(Math.max(1, ...series.flatMap(s => s.values)));
  const y = v => T + ih - (v / top) * ih;
  const x = i => L + (n <= 1 ? iw / 2 : (i * iw) / (n - 1));
  const s = [frame(W, H)];
  yGrid(s, { L, R, W, y, top });
  const a = partial[0] && n > 2 ? 1 : 0;
  const b = partial[1] && n > 2 ? n - 2 : n - 1;
  const seg = (vals, from, to) => vals.slice(from, to + 1).map((v, k) => `${k ? 'L' : 'M'}${r1(x(from + k))},${r1(y(v))}`).join('');
  for (const se of series) {
    const attrs = `fill="none" stroke="${se.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"`;
    s.push(`<path d="${seg(se.values, a, b)}" ${attrs}/>`);
    if (a) s.push(`<path d="${seg(se.values, 0, 1)}" ${attrs} stroke-dasharray="3 4" opacity=".55"/>`);
    if (b < n - 1) s.push(`<path d="${seg(se.values, n - 2, n - 1)}" ${attrs} stroke-dasharray="3 4" opacity=".55"/>`);
    s.push(`<circle cx="${r1(x(b))}" cy="${r1(y(se.values[b]))}" r="3" fill="${se.color}"/>`);
  }
  const maxLabels = Math.max(2, Math.floor(iw / 62));
  const step = Math.ceil(n / maxLabels);
  for (let i = 0; i < n; i += step) s.push(`<text class="ax" x="${r1(x(i))}" y="${H - 7}" text-anchor="middle">${esc(label(i))}</text>`);
  const cw = n > 1 ? iw / (n - 1) : iw;
  for (let i = 0; i < n; i++) s.push(`<rect class="hit" x="${r1(x(i) - cw / 2)}" y="${T}" width="${r1(cw)}" height="${ih}" data-tip="${esc(tip(i))}"/>`);
  s.push('</svg>');
  return s.join('');
}

export function spark({ values, fill, width = 140, height = 30, partial = () => false }) {
  const n = values.length;
  const max = Math.max(1, ...values);
  const bw = width / n;
  const gap = Math.min(3, bw * 0.3);
  const s = [`<svg class="spark" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none">`];
  values.forEach((v, i) => {
    const h = v > 0 ? Math.max(3, (height * v) / max) : 2;
    s.push(`<rect x="${r1(i * bw + gap / 2)}" y="${r1(height - h)}" width="${r1(bw - gap)}" height="${r1(h)}" rx="1.5" fill="${fill(v, i)}"${partial(i) ? ' opacity=".45"' : ''}/>`);
  });
  s.push('</svg>');
  return s.join('');
}
