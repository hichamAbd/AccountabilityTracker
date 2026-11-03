// AES-256-GCM encryption with a key derived from the password (PBKDF2-SHA256).
const enc = new TextEncoder();
const dec = new TextDecoder();

export const KDF_ITER = 400000;

export function toB64(bytes) {
  const b = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(str) {
  const bin = atob(String(str).replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const utf8FromB64 = s => dec.decode(fromB64(s));

export const randomSalt = () => toB64(crypto.getRandomValues(new Uint8Array(16)));

export async function deriveKey(password, saltB64, iterations = KDF_ITER) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(saltB64), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false, // not extractable: the raw key can never be read back out of the browser
    ['encrypt', 'decrypt'],
  );
}

export async function encryptJSON(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value)));
  return { v: 1, iv: toB64(iv), ct: toB64(ct) };
}

export async function decryptJSON(key, box) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.ct));
  return JSON.parse(dec.decode(pt));
}

// Same id git gives a file, so we know what GitHub already has without downloading it again.
export async function gitBlobSha(text) {
  const body = enc.encode(text);
  const head = enc.encode(`blob ${body.length}\0`);
  const all = new Uint8Array(head.length + body.length);
  all.set(head);
  all.set(body, head.length);
  const h = await crypto.subtle.digest('SHA-1', all);
  return Array.from(new Uint8Array(h), b => b.toString(16).padStart(2, '0')).join('');
}
