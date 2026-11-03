// Data store: encrypted files on a git branch, synced through the GitHub API.
//
// Layout of the data branch:
//   vault.json            KDF salt, an encrypted check value and the encrypted GitHub token
//   config.json           encrypted { habits, prefs }
//   events/YYYY-MM.json   encrypted list of entries for that (UTC) month
//
// Every change is recorded as an "op" and queued on the device first (so it works offline),
// then the queue is folded into one commit. If another device committed in between, the
// queue is simply replayed on top of the newer data, so nothing is lost.
import * as idb from './idb.js';
import { CFG } from './config.js';
import { GitHub } from './github.js';
import { deriveKey, encryptJSON, decryptJSON, gitBlobSha, randomSalt, KDF_ITER } from './crypto.js';

const CHECK = 'tally-ok';
const VAULT = 'vault.json';
const CONFIG = 'config.json';
const MONTH_RE = /^events\/(\d{4}-\d{2})\.json$/;
const README = `# Tally data

This branch holds the encrypted data of the Tally app (AES-256-GCM, key derived from your password).
Don't edit these files by hand. Every entry you log is one commit here.
`;

export const monthOf = t => t.slice(0, 7);
const monthPath = m => `events/${m}.json`;
const byT = (a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0);
export const emptyConfig = () => ({ v: 1, habits: [], prefs: {} });

export class LockedError extends Error {}
class ConflictError extends Error {}

export function uid() {
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), x => (x % 36).toString(36)).join('');
}

const isObj = o => o && typeof o === 'object' && !Array.isArray(o);
export function deepMerge(a, b) {
  const out = { ...(a || {}) };
  for (const k of Object.keys(b || {})) out[k] = isObj(out[k]) && isObj(b[k]) ? deepMerge(out[k], b[k]) : b[k];
  return out;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// ---- ops ---------------------------------------------------------------
function addEvent(s, ev, touched) {
  const m = monthOf(ev.t);
  let arr = s.months.get(m);
  if (!arr) { arr = []; s.months.set(m, arr); }
  if (arr.some(e => e.id === ev.id)) return;
  arr.push(ev);
  arr.sort(byT);
  touched.add(monthPath(m));
}

function removeEvent(s, id, t, touched) {
  const tryMonth = m => {
    const arr = s.months.get(m);
    const i = arr ? arr.findIndex(e => e.id === id) : -1;
    if (i < 0) return false;
    arr.splice(i, 1);
    touched.add(monthPath(m));
    return true;
  };
  if (t && tryMonth(monthOf(t))) return;
  for (const m of s.months.keys()) if (tryMonth(m)) return;
}

export function applyOp(s, op, touched) {
  switch (op.op) {
    case 'add': addEvent(s, op.ev, touched); break;
    case 'del': removeEvent(s, op.id, op.t, touched); break;
    case 'edit': removeEvent(s, op.ev.id, op.prevT, touched); addEvent(s, op.ev, touched); break;
    case 'habit': {
      const hs = s.config.habits;
      const i = hs.findIndex(h => h.id === op.habit.id);
      if (i >= 0) hs[i] = { ...hs[i], ...op.habit }; else hs.push({ ...op.habit });
      touched.add(CONFIG);
      break;
    }
    case 'habitDel': {
      s.config.habits = s.config.habits.filter(h => h.id !== op.id);
      touched.add(CONFIG);
      if (op.purge) {
        for (const [m, arr] of s.months) {
          const kept = arr.filter(e => e.h !== op.id);
          if (kept.length !== arr.length) { s.months.set(m, kept); touched.add(monthPath(m)); }
        }
      }
      break;
    }
    case 'order':
      op.ids.forEach((id, i) => { const h = s.config.habits.find(x => x.id === id); if (h) h.order = i; });
      touched.add(CONFIG);
      break;
    case 'prefs':
      s.config.prefs = deepMerge(s.config.prefs, op.prefs);
      touched.add(CONFIG);
      break;
    default: break;
  }
}

export function explain(e) {
  if (!e) return '';
  const repo = `${CFG.owner}/${CFG.repo}`;
  if (e.status === 0) return 'You seem to be offline. Entries are kept on this device and sync automatically when you are back online.';
  if (e.status === 401) return 'GitHub rejected the token (it may have expired or been revoked). Open Settings → Security & data and replace it.';
  if (e.status === 403 && /rate limit/i.test(e.message)) return 'GitHub rate limit reached. It will retry automatically in a few minutes.';
  if (e.status === 403) return `The token can't write to ${repo}. On GitHub, edit the token: select this repository and set Contents to "Read and write".`;
  if (e.status === 404) return `Can't find ${repo} with this token. Check the repository exists and is selected on the token.`;
  return e.message || String(e);
}

// ---- store -------------------------------------------------------------
export class Store extends EventTarget {
  constructor() {
    super();
    this.key = null;
    this.vault = null;
    this.vaultSha = null;
    this.gh = null;
    this.remote = { head: null, tree: null, files: {} };
    this.pending = [];
    this.view = null;
    this.device = {};
    this.status = { state: 'idle', pending: 0, error: null, last: null };
    this.syncing = false;
    this.again = false;
    this.timer = null;
    this.retryMs = 5000;
    this.started = false;
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  setStatus(patch) {
    this.status = { ...this.status, ...patch, pending: this.pending.length };
    this.emit('status', this.status);
  }

  // Returns 'ready' | 'locked' | 'setup' | 'error'
  async boot() {
    this.device = (await idb.get('device')) || {};
    const key = await idb.get('key');
    const vault = await idb.get('vault');
    if (key && vault) {
      try {
        await this.useKey(key, vault);
        this.vaultSha = (await idb.get('cache'))?.vaultSha || null;
        await this.loadCache();
        this.recompute();
        this.startSync();
        return 'ready';
      } catch (e) {
        console.warn('Stored key no longer valid', e);
        await idb.del('key');
      }
    }
    try {
      const r = await new GitHub(CFG.owner, CFG.repo, null).publicFile(VAULT, CFG.branch);
      if (!r) return 'setup';
      this.vault = JSON.parse(r.text);
      this.vaultSha = r.sha;
      return 'locked';
    } catch (e) {
      if (vault) { this.vault = vault; return 'locked'; }
      this.bootError = e;
      return 'error';
    }
  }

  async useKey(key, vault) {
    const ok = await decryptJSON(key, vault.check).then(v => v === CHECK, () => false);
    if (!ok) throw new LockedError('Wrong password');
    const token = await decryptJSON(key, vault.token);
    this.key = key;
    this.vault = vault;
    this.gh = new GitHub(CFG.owner, CFG.repo, token);
  }

  async checkPassword(password) {
    const v = this.vault;
    const key = await deriveKey(password, v.kdf.salt, v.kdf.iter);
    return decryptJSON(key, v.check).then(x => x === CHECK, () => false);
  }

  async unlock(password) {
    const v = this.vault;
    const key = await deriveKey(password, v.kdf.salt, v.kdf.iter);
    await this.useKey(key, v);
    if (!this.device.requirePassword) await idb.set('key', key);
    await idb.set('vault', v);
    await this.loadCache();
    this.recompute();
    try { await this.sync(); } catch { /* status already reflects it */ }
    this.startSync();
  }

  async setup(token, password) {
    const gh = new GitHub(CFG.owner, CFG.repo, token);
    await gh.getRepo();
    const head = await gh.headSha(CFG.branch);
    let baseTree;
    if (head) {
      baseTree = (await gh.commit(head)).tree.sha;
      const t = await gh.tree(baseTree);
      if (t.tree.some(e => e.path === VAULT)) throw new Error('This repository already has a Tally vault. Reload the page and unlock it with your password.');
    }
    const salt = randomSalt();
    const key = await deriveKey(password, salt, KDF_ITER);
    const vault = {
      v: 1, app: 'tally',
      kdf: { name: 'PBKDF2-SHA256', iter: KDF_ITER, salt },
      check: await encryptJSON(key, CHECK),
      token: await encryptJSON(key, token),
      created: new Date().toISOString(),
    };
    const vtext = JSON.stringify(vault, null, 2);
    const cfgText = JSON.stringify(await encryptJSON(key, emptyConfig()));
    const blob = (path, content) => ({ path, mode: '100644', type: 'blob', content });
    const tree = await gh.createTree([blob(VAULT, vtext), blob(CONFIG, cfgText), blob('README.md', README)], baseTree);
    const commit = await gh.createCommit('Initialize Tally vault', tree.sha, head ? [head] : []);
    if (head) await gh.updateRef(CFG.branch, commit.sha); else await gh.createRef(CFG.branch, commit.sha);

    this.gh = gh;
    this.key = key;
    this.vault = vault;
    this.vaultSha = await gitBlobSha(vtext);
    this.remote = {
      head: commit.sha, tree: tree.sha,
      files: { [CONFIG]: { sha: await gitBlobSha(cfgText), box: JSON.parse(cfgText), data: emptyConfig() } },
    };
    this.device = {};
    await idb.set('device', this.device);
    await idb.set('key', key);
    await idb.set('vault', vault);
    await this.saveCache();
    this.recompute();
    this.startSync();
  }

  // ---- local cache ----
  async loadCache() {
    const c = await idb.get('cache');
    if (c && c.files) {
      try {
        const files = {};
        await Promise.all(Object.entries(c.files).map(async ([p, f]) => {
          files[p] = { sha: f.sha, box: f.box, data: await decryptJSON(this.key, f.box) };
        }));
        this.remote = { head: c.head, tree: c.tree, files };
        if (c.vaultSha) this.vaultSha = c.vaultSha;
      } catch {
        this.remote = { head: null, tree: null, files: {} };
      }
    }
    if (!this.pending.length) {
      const p = await idb.get('pending');
      if (p) { try { this.pending = await decryptJSON(this.key, p); } catch { /* other key */ } }
    }
  }

  async saveCache() {
    const files = {};
    for (const [p, f] of Object.entries(this.remote.files)) files[p] = { sha: f.sha, box: f.box };
    await idb.set('cache', { head: this.remote.head, tree: this.remote.tree, vaultSha: this.vaultSha, files });
  }

  async savePending() {
    if (!this.key) return;
    await idb.set('pending', await encryptJSON(this.key, this.pending));
  }

  cloneRemote() {
    const cfg = this.remote.files[CONFIG]?.data;
    const months = new Map();
    for (const [p, f] of Object.entries(this.remote.files)) {
      const m = p.match(MONTH_RE);
      if (m) months.set(m[1], f.data.slice());
    }
    return { config: cfg ? structuredClone(cfg) : emptyConfig(), months };
  }

  recompute() {
    const s = this.cloneRemote();
    const scratch = new Set();
    for (const op of this.pending) applyOp(s, op, scratch);
    const habits = s.config.habits.slice().sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || String(a.createdAt).localeCompare(String(b.createdAt)));
    const events = [];
    for (const arr of s.months.values()) events.push(...arr);
    events.sort(byT);
    const byHabit = new Map(habits.map(h => [h.id, []]));
    const eventById = new Map();
    for (const e of events) {
      eventById.set(e.id, e);
      if (!byHabit.has(e.h)) byHabit.set(e.h, []);
      byHabit.get(e.h).push(e);
    }
    this.view = {
      config: s.config, habits, habitById: new Map(habits.map(h => [h.id, h])), events, byHabit, eventById,
    };
    this.emit('change', this.view);
  }

  // ---- mutations ----
  async push(...ops) {
    this.pending.push(...ops);
    this.recompute();
    this.setStatus({});
    await this.savePending();
    this.syncSoon();
  }

  log(h, { t, q = 1, n } = {}) {
    const ev = { id: uid(), h, t: t || new Date().toISOString() };
    if (q && q !== 1) ev.q = q;
    if (n) ev.n = n;
    this.push({ op: 'add', ev });
    return ev;
  }
  restore(ev) { return this.push({ op: 'add', ev }); }
  deleteEvent(ev) { return this.push({ op: 'del', id: ev.id, t: ev.t }); }
  editEvent(ev, prevT) { return this.push({ op: 'edit', ev, prevT }); }
  upsertHabit(habit) { return this.push({ op: 'habit', habit }); }
  deleteHabit(id, purge = true) { return this.push({ op: 'habitDel', id, purge }); }
  reorder(ids) { return this.push({ op: 'order', ids }); }
  setPrefs(prefs) { return this.push({ op: 'prefs', prefs }); }
  importOps(ops) { return this.push(...ops); }

  async setDevice(patch) {
    this.device = { ...this.device, ...patch };
    await idb.set('device', this.device);
    if (patch.requirePassword === true) await idb.del('key');
    if (patch.requirePassword === false && this.key) await idb.set('key', this.key);
  }

  // ---- sync ----
  startSync() {
    if (this.started) { this.sync(); return; }
    this.started = true;
    this.sync();
    setInterval(() => { if (document.visibilityState === 'visible') this.sync(); }, 120000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.sync(); });
    window.addEventListener('online', () => this.sync());
  }

  syncSoon(ms = 1200) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sync(), ms);
  }

  async pull() {
    const head = await this.gh.headSha(CFG.branch);
    if (!head) throw new Error(`The "${CFG.branch}" branch is missing in ${CFG.owner}/${CFG.repo}.`);
    if (head === this.remote.head) return false;
    const commit = await this.gh.commit(head);
    const tree = await this.gh.tree(commit.tree.sha);
    const blobs = tree.tree.filter(e => e.type === 'blob');

    const v = blobs.find(e => e.path === VAULT);
    if (v && v.sha !== this.vaultSha) {
      const vault = JSON.parse(await this.gh.blob(v.sha));
      const ok = await decryptJSON(this.key, vault.check).then(x => x === CHECK, () => false);
      if (!ok) {
        await this.lock('The password was changed on another device. Enter the new password.', vault, v.sha);
        throw new LockedError('locked');
      }
      this.gh.token = await decryptJSON(this.key, vault.token);
      this.vault = vault;
      this.vaultSha = v.sha;
      await idb.set('vault', vault);
    }

    const files = {};
    await pool(blobs.filter(e => e.path === CONFIG || MONTH_RE.test(e.path)), 6, async e => {
      const old = this.remote.files[e.path];
      if (old && old.sha === e.sha) { files[e.path] = old; return; }
      const box = JSON.parse(await this.gh.blob(e.sha));
      files[e.path] = { sha: e.sha, box, data: await decryptJSON(this.key, box) };
    });
    this.remote = { head, tree: commit.tree.sha, files };
    await this.saveCache();
    return true;
  }

  async commitData(files, message, extra = {}, key = this.key) {
    const entries = [];
    const next = {};
    for (const [path, data] of Object.entries(files)) {
      if (data === null) {
        if (this.remote.files[path]) entries.push({ path, mode: '100644', type: 'blob', sha: null });
        next[path] = null;
        continue;
      }
      const box = await encryptJSON(key, data);
      const text = JSON.stringify(box);
      entries.push({ path, mode: '100644', type: 'blob', content: text });
      next[path] = { sha: await gitBlobSha(text), box, data };
    }
    for (const [path, text] of Object.entries(extra)) entries.push({ path, mode: '100644', type: 'blob', content: text });
    if (!entries.length) return;
    const tree = await this.gh.createTree(entries, this.remote.tree);
    const commit = await this.gh.createCommit(message, tree.sha, this.remote.head ? [this.remote.head] : []);
    try {
      await this.gh.updateRef(CFG.branch, commit.sha);
    } catch (e) {
      if (e.status === 422 || e.status === 409) throw new ConflictError('conflict');
      throw e;
    }
    this.remote.head = commit.sha;
    this.remote.tree = tree.sha;
    for (const [p, f] of Object.entries(next)) { if (f) this.remote.files[p] = f; else delete this.remote.files[p]; }
    await this.saveCache();
  }

  async sync() {
    if (!this.gh || !this.key) return;
    if (this.syncing) { this.again = true; return; }
    this.syncing = true;
    clearTimeout(this.timer);
    this.setStatus({ state: 'syncing' });
    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        this.again = false;
        if (await this.pull()) this.recompute();
        if (!this.pending.length) { if (this.again) continue; break; }
        const ops = this.pending.slice();
        const s = this.cloneRemote();
        const touched = new Set();
        ops.forEach(op => applyOp(s, op, touched));
        const files = {};
        for (const p of touched) {
          if (p === CONFIG) files[p] = s.config;
          else { const arr = s.months.get(p.match(MONTH_RE)[1]) || []; files[p] = arr.length ? arr : null; }
        }
        try {
          await this.commitData(files, 'Tally sync');
        } catch (e) {
          if (e instanceof ConflictError) continue;
          throw e;
        }
        this.pending = this.pending.slice(ops.length);
        await this.savePending();
        this.recompute();
        if (!this.pending.length && !this.again) break;
      }
      this.retryMs = 5000;
      this.setStatus({ state: 'ok', error: null, last: Date.now() });
    } catch (e) {
      if (e instanceof LockedError) {
        this.setStatus({ state: 'locked' });
      } else {
        console.warn('Sync failed', e);
        const offline = e.status === 0 || navigator.onLine === false;
        this.setStatus({ state: offline ? 'offline' : 'error', error: explain(e), status: e.status });
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.sync(), this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, 300000);
      }
    } finally {
      this.syncing = false;
    }
  }

  async idle() { while (this.syncing) await new Promise(r => setTimeout(r, 80)); }

  async exclusive(fn) {
    await this.idle();
    this.syncing = true;
    try { return await fn(); } finally { this.syncing = false; }
  }

  async lock(message, vault, vaultSha) {
    this.key = null;
    await idb.del('key');
    await idb.del('cache');
    if (vault) { this.vault = vault; this.vaultSha = vaultSha; await idb.set('vault', vault); }
    this.remote = { head: null, tree: null, files: {} };
    this.emit('locked', { message });
  }

  async changePassword(newPassword) {
    await this.idle();
    await this.sync();
    if (this.pending.length) throw new Error('Could not sync with GitHub first. Check your connection and try again.');
    await this.exclusive(async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        await this.pull();
        const salt = randomSalt();
        const key = await deriveKey(newPassword, salt, KDF_ITER);
        const vault = {
          ...this.vault,
          kdf: { name: 'PBKDF2-SHA256', iter: KDF_ITER, salt },
          check: await encryptJSON(key, CHECK),
          token: await encryptJSON(key, this.gh.token),
          updated: new Date().toISOString(),
        };
        const vtext = JSON.stringify(vault, null, 2);
        const files = {};
        for (const [p, f] of Object.entries(this.remote.files)) files[p] = f.data;
        try {
          await this.commitData(files, 'Tally: re-encrypt with new password', { [VAULT]: vtext }, key);
        } catch (e) {
          if (e instanceof ConflictError) continue;
          throw e;
        }
        this.key = key;
        this.vault = vault;
        this.vaultSha = await gitBlobSha(vtext);
        if (!this.device.requirePassword) await idb.set('key', key);
        await idb.set('vault', vault);
        await this.saveCache();
        await this.savePending();
        return;
      }
      throw new Error('Another device kept changing the data. Try again.');
    });
  }

  async replaceToken(token) {
    const test = new GitHub(CFG.owner, CFG.repo, token);
    const head = await test.headSha(CFG.branch);
    if (!head) throw new Error(`The new token can't see the "${CFG.branch}" branch of ${CFG.owner}/${CFG.repo}.`);
    await this.idle();
    await this.exclusive(async () => {
      const old = this.gh.token;
      this.gh.token = token;
      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          await this.pull();
          const vault = { ...this.vault, token: await encryptJSON(this.key, token), updated: new Date().toISOString() };
          const vtext = JSON.stringify(vault, null, 2);
          try {
            await this.commitData({}, 'Tally: update token', { [VAULT]: vtext });
          } catch (e) {
            if (e instanceof ConflictError) continue;
            throw e;
          }
          this.vault = vault;
          this.vaultSha = await gitBlobSha(vtext);
          await idb.set('vault', vault);
          await this.saveCache();
          return;
        }
        throw new Error('Could not save the token, try again.');
      } catch (e) {
        this.gh.token = old;
        throw e;
      }
    });
    this.sync();
  }

  async redownload() {
    await this.idle();
    this.remote = { head: null, tree: null, files: {} };
    this.vaultSha = null;
    await idb.del('cache');
    await this.sync();
    this.recompute();
  }

  async forgetDevice() {
    await idb.clear();
  }
}
