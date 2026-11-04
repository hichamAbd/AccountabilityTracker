// A year of realistic, deterministic test data (5 habits, ~6,600 entries).
function seed() {
  const day = 864e5;
  const now = Date.now();
  const start = now - 400 * day;
  const created = new Date(start).toISOString();
  const habits = [
    { id: 'smk', name: 'Smoking', emoji: '🚬', kind: 'bad', color: '#c8553d', goal: { type: 'max', count: 5, period: 'day' }, showOnToday: true, createdAt: created, order: 0 },
    { id: 'scr', name: 'Doomscrolling', emoji: '📱', kind: 'bad', color: '#6a5bb5', goal: null, showOnToday: true, createdAt: created, order: 1 },
    { id: 'wat', name: 'Water', emoji: '💧', kind: 'good', color: '#3f8f9a', goal: { type: 'min', count: 8, period: 'day' }, showOnToday: true, createdAt: created, order: 2 },
    { id: 'exe', name: 'Exercise', emoji: '🏃', kind: 'good', color: '#4b9b6e', goal: { type: 'min', count: 3, period: 'week' }, showOnToday: true, createdAt: created, order: 3 },
    { id: 'cof', name: 'Coffee', emoji: '☕', kind: 'neutral', color: '#7a746b', goal: null, showOnToday: true, createdAt: created, order: 4 },
  ];
  let seedN = 7;
  const rnd = () => { seedN = (seedN * 16807) % 2147483647; return (seedN - 1) / 2147483646; };
  const pois = l => { let L = Math.exp(-l), k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; };
  const events = [];
  let id = 0;
  const at = (d, h) => { const x = new Date(d); x.setHours(Math.floor(h), Math.floor((h % 1) * 60), Math.floor(rnd() * 60), 0); return x; };
  for (let t = start; t <= now; t += day) {
    const d = new Date(t);
    const prog = (t - start) / (now - start);
    const wknd = d.getDay() === 0 || d.getDay() === 6;
    const today = now - t < day;
    // smoking: 8/day → 2.5/day, worse on weekends, a 9-day clean streak a month ago
    const clean = now - t < 40 * day && now - t > 31 * day;
    let n = clean ? 0 : pois((8 - 5.5 * prog) * (wknd ? 1.25 : 1));
    for (let i = 0; i < n; i++) {
      const slot = rnd();
      const h = slot < 0.3 ? 8 + rnd() * 2 : slot < 0.55 ? 13 + rnd() * 1.5 : 18 + rnd() * 4.5;
      events.push({ id: `e${id++}`, h: 'smk', t: at(d, h) });
    }
    n = pois(wknd ? 3 : 1.8);
    for (let i = 0; i < n; i++) events.push({ id: `e${id++}`, h: 'scr', t: at(d, rnd() < 0.7 ? 22 + rnd() * 1.9 : 12 + rnd() * 2) });
    n = Math.max(0, Math.round(4 + 4 * prog + (rnd() - 0.5) * 4));
    for (let i = 0; i < n; i++) events.push({ id: `e${id++}`, h: 'wat', t: at(d, 8 + rnd() * 13) });
    if (rnd() < 0.3 + 0.25 * prog) events.push({ id: `e${id++}`, h: 'exe', t: at(d, wknd ? 9 + rnd() * 2 : 6.5 + rnd()), n: rnd() < 0.2 ? 'Run by the river' : undefined });
    n = 1 + pois(1.3);
    for (let i = 0; i < n; i++) events.push({ id: `e${id++}`, h: 'cof', t: at(d, 7 + rnd() * 8), q: rnd() < 0.1 ? 2 : undefined });
    if (today) break;
  }
  const out = events.filter(e => e.t.getTime() < now).map(e => {
    const x = { id: e.id, h: e.h, t: e.t.toISOString() };
    if (e.q) x.q = e.q;
    if (e.n) x.n = e.n;
    return x;
  });
  return { habits, events: out };
}
module.exports = { seed };
