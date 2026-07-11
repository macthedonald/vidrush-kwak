// Synchronous key/value store that the whole app reads through. Backed by localStorage
// (instant, offline) and — when the user is signed into Convex — mirrored per-user into
// Convex so niches, settings, templates and the learning memory are sticky across devices.
//
// The app calls cloudGet/cloudSet/cloudRemove exactly where it used to call ls/ss. When
// Convex isn't configured (no env / signed out) it degrades to plain localStorage, so the
// app keeps working with zero setup.
import { makeFunctionReference } from "convex/server";

export const CONVEX_URL = import.meta.env.VITE_CONVEX_URL || "";
export const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || "";
export const cloudEnabled = !!(CONVEX_URL && CLERK_KEY);

// Convex function references by name (avoids the generated api, so the client builds
// without running `npx convex dev` first).
export const fn = {
  list: makeFunctionReference("kv:list"),
  set: makeFunctionReference("kv:set"),
  setMany: makeFunctionReference("kv:setMany"),
  remove: makeFunctionReference("kv:remove"),
  mediaUploadUrl: makeFunctionReference("media:uploadUrl"),
  mediaSet: makeFunctionReference("media:set"),
  mediaList: makeFunctionReference("media:list"),
  mediaRemove: makeFunctionReference("media:remove"),
};

// In-memory cache = source of truth for synchronous reads. Seeded from localStorage,
// then overwritten by Convex on sign-in.
const cache = new Map();
let backend = null; // { set(key,value), remove(key) } wired to Convex mutations when online

// localStorage passthrough (also the offline cache).
function lsGet(key) {
  try { const v = localStorage.getItem(key); return v == null ? undefined : JSON.parse(v); } catch { return undefined; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch (e) { if (e?.name === "QuotaExceededError") cleanThumbs(key); try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
}
function lsRemove(key) { try { localStorage.removeItem(key); } catch {} }

// Legacy safety valve: drop base64 thumbs from niche history if storage is full.
function cleanThumbs(key) {
  try {
    const raw = localStorage.getItem(key); if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      localStorage.setItem(key, JSON.stringify(data.map(n => ({ ...n, history: (n.history || []).map(h => { const { thumbs, ...rest } = h; return rest; }) }))));
    }
  } catch {}
}

export function cloudGet(key, fallback) {
  if (cache.has(key)) return cache.get(key);
  const v = lsGet(key);
  return v === undefined ? fallback : v;
}

export function cloudSet(key, value) {
  cache.set(key, value);
  lsSet(key, value);          // instant local mirror
  backend?.set(key, value);   // debounced push to Convex when signed in
}

export function cloudRemove(key) {
  cache.delete(key);
  lsRemove(key);
  backend?.remove(key);
}

// Called by CloudGate once the Convex query has loaded the user's rows.
export function hydrateFromCloud(rows) {
  for (const { key, value } of rows) { cache.set(key, value); lsSet(key, value); }
}

// Wire the Convex mutations (debounced per key) so cloudSet/Remove reach the server.
export function attachBackend(setMutation, removeMutation) {
  const timers = new Map();
  backend = {
    set(key, value) {
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(() => { setMutation({ key, value }).catch(() => {}); }, 600));
    },
    remove(key) {
      clearTimeout(timers.get(key));
      removeMutation({ key }).catch(() => {});
    },
  };
}
export function detachBackend() { backend = null; }

// ---------- Cross-device media (Convex file storage) ----------
// The heavy binaries (frames, clips, renders) can't live in the kv rows, so they go to Convex
// file storage. mediaUrls maps a media key → a served URL, hydrated on sign-in; mediaBackend
// uploads new blobs. All best-effort: any failure just falls back to local IndexedDB.
const mediaUrls = new Map();
const mediaKeys = new Set(); // every media key we know about (hydrated or uploaded this session)
let mediaBackend = null;

export function hydrateMediaFromCloud(rows) {
  for (const { key, url } of rows) { mediaUrls.set(key, url); mediaKeys.add(key); }
}
export function cloudMediaUrl(key) { return mediaUrls.get(key); }
export function cloudMediaEnabled() { return !!mediaBackend; }

export function attachMediaBackend(uploadUrlMutation, setMutation, removeMutation) {
  const queue = [];
  let running = 0;
  const pump = () => {
    while (running < 2 && queue.length) {
      const job = queue.shift(); running++;
      job().catch(() => {}).finally(() => { running--; pump(); });
    }
  };
  mediaBackend = {
    put(key, blob) {
      mediaKeys.add(key);
      queue.push(async () => {
        const postUrl = await uploadUrlMutation({});
        const res = await fetch(postUrl, { method: "POST", headers: { "Content-Type": blob.type || "application/octet-stream" }, body: blob });
        if (!res.ok) throw new Error("upload " + res.status);
        const { storageId } = await res.json();
        await setMutation({ key, storageId });
      });
      pump();
    },
    remove(key) { removeMutation({ key }).catch(() => {}); mediaUrls.delete(key); mediaKeys.delete(key); },
  };
}
// Delete every stored media file whose key starts with `prefix` (e.g. a topic's frames on delete /
// re-storyboard) so old cloud files don't linger. No-op offline.
export function cloudRemoveMediaPrefix(prefix) {
  if (!mediaBackend) return;
  for (const key of [...mediaKeys]) if (key.startsWith(prefix)) mediaBackend.remove(key);
}
export function detachMediaBackend() { mediaBackend = null; }

// Upload a blob (or data URL) for a media key so it's available on other devices. No-op offline.
export async function cloudPutMedia(key, data) {
  if (!mediaBackend) return;
  try {
    const blob = typeof data === "string" ? await (await fetch(data)).blob() : data;
    if (blob && blob.size) mediaBackend.put(key, blob);
  } catch {}
}
export function cloudRemoveMedia(key) { mediaBackend?.remove(key); }

// Which localStorage keys belong to the app (for first-login migration into the account).
export function appLocalKeys() {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && /^vr\d/.test(k)) keys.push(k);
    }
  } catch {}
  return keys;
}
