// Fetch a YouTube video into the browser as a File — no backend.
// Why this exists: googlevideo.com serves streams WITHOUT CORS headers, so a web page
// cannot read them directly. Community gateways (Piped / Invidious) proxy the streams
// WITH CORS. Individual instances come and go, so we discover live instances from the
// official directories at runtime and cascade through them until one delivers.

// Known-open cobalt API instances (community list fluctuates; the live tracker below is authoritative).
const COBALT_SEEDS = [
  "https://cobalt-api.kwiatekmiki.com",
  "https://capi.oak.li",
  "https://cobalt-api.ayo.tf",
  "https://api.dl.ixhby.dev",
  "https://dl.khyernet.xyz",
  "https://cobalt.api.timelessnesses.me",
];

const PIPED_SEEDS = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.reallyaweso.me",
  "https://pipedapi.ducks.party",
  "https://api.piped.private.coffee",
  "https://pipedapi.leptons.xyz",
];
const INVID_SEEDS = [
  "https://inv.nadeko.net",
  "https://yewtu.be",
  "https://invidious.nerdvpn.de",
  "https://iv.ggtyler.dev",
  "https://invidious.f5.si",
  "https://inv.tux.pizza",
];

export function ytId(input) {
  const s = (input || "").trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

async function jget(url, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function jpost(url, body, ms = 14000, headers = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, {
      method: "POST", signal: ctl.signal,
      headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data: d };
  } finally { clearTimeout(t); }
}

// cobalt (the engine behind cobalt.tools): the most reliable community route in 2026.
// alwaysProxy forces the media through the instance's tunnel, which serves CORS — so the
// browser can actually read the bytes. Auth-gated instances are skipped automatically.
async function tryCobalt(api, videoUrl, onStatus, apiKey) {
  const base = api.replace(/\/+$/, "");
  const host = base.replace(/^https?:\/\//, "");
  if (onStatus) onStatus(`Trying ${host}…`);
  const { data: d } = await jpost(`${base}/`, {
    url: videoUrl, videoQuality: "360", youtubeVideoCodec: "h264",
    filenameStyle: "basic", alwaysProxy: true,
  }, 16000, apiKey ? { Authorization: `Api-Key ${apiKey}` } : {});
  if (d.status === "error") throw new Error(d.error?.code || "cobalt error");
  const streamUrl = d.url || d.picker?.find(p => p.type === "video")?.url || d.picker?.[0]?.url;
  if (!streamUrl) throw new Error(`no stream (status ${d.status || "unknown"})`);
  const blob = await download(streamUrl, onStatus, host);
  const title = (d.filename || "").replace(/\.[^.]+$/, "") || null;
  return { blob, title, via: host };
}

async function discoverCobalt() {
  let list = [...COBALT_SEEDS];
  try {
    const d = await jget("https://instances.cobalt.best/instances.json", 6000);
    const live = (d || [])
      .filter(e => e.api && e.api_online !== false && e.protocol !== "http" && e.services?.youtube !== false)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .map(e => `https://${e.api}`);
    if (live.length) list = [...new Set([...live, ...COBALT_SEEDS])];
  } catch {}
  return list.slice(0, 10);
}

const shuffle = a => a.map(x => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map(p => p[1]);

// Live instance discovery from the official directories, with hardcoded seeds as fallback.
async function discoverInstances() {
  let piped = [...PIPED_SEEDS], invid = [...INVID_SEEDS];
  try {
    const list = await jget("https://piped-instances.kavin.rocks/", 6000);
    const live = (list || []).map(x => x.api_url).filter(Boolean);
    if (live.length) piped = [...new Set([...live, ...PIPED_SEEDS])];
  } catch {}
  try {
    const list = await jget("https://api.invidious.io/instances.json?sort_by=type,health", 6000);
    const live = (list || [])
      .filter(([, m]) => m?.type === "https" && m?.api !== false && m?.cors !== false)
      .map(([name]) => `https://${name}`);
    if (live.length) invid = [...new Set([...live, ...INVID_SEEDS])];
  } catch {}
  return { piped: shuffle(piped).slice(0, 8), invid: shuffle(invid).slice(0, 8) };
}

async function download(url, onStatus, label, maxBytes = 450 * 1024 * 1024) {
  const ctl = new AbortController();
  const idle = () => setTimeout(() => ctl.abort(), 30000);
  let timer = idle();
  const r = await fetch(url, { signal: ctl.signal });
  if (!r.ok) throw new Error(`stream HTTP ${r.status}`);
  const total = +r.headers.get("content-length") || 0;
  const reader = r.body.getReader();
  const chunks = [];
  let recv = 0;
  while (true) {
    const { done, value } = await reader.read();
    clearTimeout(timer);
    if (done) break;
    timer = idle();
    chunks.push(value); recv += value.length;
    if (recv > maxBytes) { ctl.abort(); throw new Error("Video is too large — use a shorter one (≤ ~20 min) or drop the file manually"); }
    if (onStatus) onStatus(`Downloading via ${label} — ${(recv / 1048576).toFixed(1)}MB${total ? ` of ${(total / 1048576).toFixed(1)}MB` : ""}`);
  }
  clearTimeout(timer);
  if (recv < 100 * 1024) throw new Error("stream came back empty");
  return new Blob(chunks, { type: "video/mp4" });
}

// The local server engine (Vite middleware / preview server) — no CORS in Node, so the
// same gateways the browser can't read work fine here. This is the primary route when
// running `npm run dev` or `npm run preview`.
async function trySelfHosted(id, onStatus) {
  if (onStatus) onStatus("Pulling through the local server engine…");
  const r = await fetch(`/api/yt?id=${id}`);
  if (!r.ok) {
    let detail = "";
    try { const d = await r.json(); detail = (d.attempts || []).slice(0, 3).join(" · "); } catch {}
    throw new Error(detail ? `server engine: ${detail}` : `server engine HTTP ${r.status}`);
  }
  const ct = r.headers.get("content-type") || "";
  if (!ct.includes("video") && !ct.includes("octet-stream")) throw new Error("server engine returned no video");
  const title = decodeURIComponent(r.headers.get("x-yt-title") || "") || null;
  // stream with progress
  const total = +r.headers.get("content-length") || 0;
  const reader = r.body.getReader();
  const chunks = []; let recv = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); recv += value.length;
    if (onStatus) onStatus(`Downloading — ${(recv / 1048576).toFixed(1)}MB${total ? ` of ${(total / 1048576).toFixed(1)}MB` : ""}`);
  }
  if (recv < 100 * 1024) throw new Error("server engine stream was empty");
  return { blob: new Blob(chunks, { type: "video/mp4" }), title };
}

export async function fetchYouTubeVideo(input, { onStatus, gateway } = {}) {
  const id = ytId(input);
  if (!id) throw new Error("That doesn't look like a YouTube link or video id");
  const watchUrl = `https://www.youtube.com/watch?v=${id}`;
  const errors = [];

  // 0a. Local server engine (works in dev/preview; absent on pure-static hosting).
  try {
    const { blob, title } = await trySelfHosted(id, onStatus);
    const nm = (title || id).replace(/[^\w ]+/g, "").slice(0, 60) || id;
    return { file: new File([blob], `${nm}.mp4`, { type: "video/mp4" }), title: title || id, duration: 0, via: "local server" };
  } catch (e) {
    // Only note it if it wasn't a plain "route not present" 404 (static hosting)
    if (!/HTTP 404/.test(e.message)) errors.push(e.message.slice(0, 90));
  }

  // 0. The user's own gateway (a personal cobalt instance) — most reliable when set.
  //    Settings accepts "https://host" or "https://host YOUR_API_KEY".
  if (gateway?.trim()) {
    const [gwUrl, gwKey] = gateway.trim().split(/\s+/);
    try {
      const { blob, title, via } = await tryCobalt(gwUrl, watchUrl, onStatus, gwKey);
      return { file: new File([blob], `${(title || id).replace(/[^\w ]+/g, "").slice(0, 60) || id}.mp4`, { type: "video/mp4" }), title: title || id, duration: 0, via };
    } catch (e) { errors.push(`your gateway: ${e.message.slice(0, 80)}`); }
  }

  // 1. cobalt community instances (live-ranked tracker + seeds)
  if (onStatus) onStatus("Finding a live gateway…");
  const cobalt = await discoverCobalt();
  for (const api of cobalt) {
    try {
      const { blob, title, via } = await tryCobalt(api, watchUrl, onStatus);
      return { file: new File([blob], `${(title || id).replace(/[^\w ]+/g, "").slice(0, 60) || id}.mp4`, { type: "video/mp4" }), title: title || id, duration: 0, via };
    } catch (e) { errors.push(`${api.replace(/^https?:\/\//, "")}: ${e.message.slice(0, 60)}`); }
  }

  // 2. Piped / Invidious (legacy fallback — most public instances no longer serve streams)
  const { piped, invid } = await discoverInstances();

  for (const api of piped) {
    const host = api.replace(/^https?:\/\//, "");
    try {
      if (onStatus) onStatus(`Trying ${host}…`);
      const d = await jget(`${api}/streams/${id}`, 9000);
      const prog = (d.videoStreams || [])
        .filter(s => s.videoOnly === false && /mp4|MPEG/i.test(s.mimeType || s.format || ""))
        .sort((a, b) => (parseInt(a.quality) || 9999) - (parseInt(b.quality) || 9999));
      const pick = prog.find(s => (parseInt(s.quality) || 0) >= 270) || prog[0];
      if (!pick?.url) throw new Error("no progressive stream");
      const blob = await download(pick.url, onStatus, host);
      return { file: new File([blob], `${(d.title || id).replace(/[^\w ]+/g, "").slice(0, 60) || id}.mp4`, { type: "video/mp4" }), title: d.title || id, duration: d.duration || 0, via: host };
    } catch (e) { errors.push(`${host}: ${e.message.slice(0, 60)}`); }
  }

  for (const base of invid) {
    const host = base.replace(/^https?:\/\//, "");
    try {
      if (onStatus) onStatus(`Trying ${host}…`);
      const d = await jget(`${base}/api/v1/videos/${id}?local=true&fields=title,lengthSeconds,formatStreams`, 9000);
      const fs = (d.formatStreams || []).sort((a, b) => (parseInt(a.resolution) || 9999) - (parseInt(b.resolution) || 9999));
      const pick = fs.find(s => (parseInt(s.resolution) || 0) >= 270) || fs[0];
      if (!pick?.url) throw new Error("no progressive stream");
      const url = new URL(pick.url, base).href; // local=true keeps it on this host (CORS ok)
      const blob = await download(url, onStatus, host);
      return { file: new File([blob], `${(d.title || id).replace(/[^\w ]+/g, "").slice(0, 60) || id}.mp4`, { type: "video/mp4" }), title: d.title || id, duration: d.lengthSeconds || 0, via: host };
    } catch (e) { errors.push(`${host}: ${e.message.slice(0, 60)}`); }
  }

  console.warn("YouTube gateways failed:", errors);
  throw new Error(`Couldn't pull this video through any gateway (${errors.length} tried). Quickest fixes: open cobalt.tools in a new tab, paste the link, download the file and drop it here — or set your own cobalt gateway in Settings for a permanently reliable route. (Details logged to the browser console.)`);
}
