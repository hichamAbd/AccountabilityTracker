// Tiny IndexedDB key-value store (device cache only; GitHub is the source of truth).
const DB = 'tally';
const STORE = 'kv';
const mem = new Map();
let dbp = null;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbp;
}

function run(mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export async function get(k) {
  try { return await run('readonly', s => s.get(k)); } catch { return mem.get(k); }
}
export async function set(k, v) {
  mem.set(k, v);
  try { await run('readwrite', s => s.put(v, k)); } catch { /* memory only */ }
}
export async function del(k) {
  mem.delete(k);
  try { await run('readwrite', s => s.delete(k)); } catch { /* ignore */ }
}
export async function clear() {
  mem.clear();
  try { await run('readwrite', s => s.clear()); } catch { /* ignore */ }
}
