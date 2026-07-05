// Tiny IndexedDB key-value store for heavy media (frames, audio, clips, renders).
// localStorage keeps the text; this keeps the bytes, so projects survive reloads.
const DB_NAME = "vidrush-media";
const STORE = "kv";
let dbP = null;

function db() {
  if (!dbP) dbP = new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return dbP;
}
function tx(mode, fn) {
  return db().then(d => new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const out = fn(store);
    t.oncomplete = () => res(out?.result !== undefined ? out.result : undefined);
    t.onerror = () => rej(t.error);
  })).catch(e => { console.warn("idb:", e); return undefined; });
}

export const idbSet = (key, val) => tx("readwrite", s => s.put(val, key));
export const idbGet = (key) => db().then(d => new Promise((res) => {
  const req = d.transaction(STORE).objectStore(STORE).get(key);
  req.onsuccess = () => res(req.result);
  req.onerror = () => res(undefined);
})).catch(() => undefined);
export const idbDel = (key) => tx("readwrite", s => s.delete(key));
export const idbDelPrefix = (prefix) => db().then(d => new Promise((res) => {
  const range = IDBKeyRange.bound(prefix, prefix + "￿");
  const t = d.transaction(STORE, "readwrite");
  t.objectStore(STORE).delete(range);
  t.oncomplete = () => res();
  t.onerror = () => res();
})).catch(() => undefined);
export const idbKeys = (prefix) => db().then(d => new Promise((res) => {
  const range = IDBKeyRange.bound(prefix, prefix + "￿");
  const req = d.transaction(STORE).objectStore(STORE).getAllKeys(range);
  req.onsuccess = () => res(req.result || []);
  req.onerror = () => res([]);
})).catch(() => []);
