// Fetch a YouTube video into the browser as a File — no backend.
// Why this exists: googlevideo.com serves streams WITHOUT CORS headers, so a web page
// cannot read them directly. Community gateways (Piped / Invidious) proxy the streams
// WITH CORS. Individual instances come and go, so we discover live instances from the
// official directories at runtime and cascade through them until one delivers.

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

export async function fetchYouTubeVideo(input, { onStatus } = {}) {
  const id = ytId(input);
  if (!id) throw new Error("That doesn't look like a YouTube link or video id");
  if (onStatus) onStatus("Finding a live gateway…");
  const { piped, invid } = await discoverInstances();
  const errors = [];

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
  throw new Error(`Couldn't pull this video through any public gateway (${errors.length} tried — these community mirrors fluctuate). Try again in a minute, or download the file and drop it here instead.`);
}
