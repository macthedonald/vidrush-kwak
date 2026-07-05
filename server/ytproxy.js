// Local YouTube fetch engine — a Vite middleware, so it runs inside the dev/preview
// server's Node process. CORS is a browser-only restriction: gateways that are alive
// but CORS-locked (most of them, per real-world testing) work fine from here.
// Route: GET /api/yt?id=<videoId> → streams the MP4 back same-origin.
import { Readable } from "node:stream";

// Optional: set YT_COBALT to your own cobalt instance(s), comma-separated, to guarantee
// a working route. "https://host" or "https://host|API_KEY" for auth-gated instances.
const EXTRA = (process.env.YT_COBALT || "").split(",").map(s => s.trim()).filter(Boolean);
const COBALT = [
  ...EXTRA,
  "https://cobalt-api.kwiatekmiki.com",
  "https://cobalt-api.ayo.tf",
  "https://co.eepy.today",
  "https://downloadapi.stuff.solutions",
  "https://cap.kikkia.dev",
  "https://cobalt.canine.tools",
];
const PIPED = [
  "https://api.piped.private.coffee",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.reallyaweso.me",
  "https://pipedapi.kavin.rocks",
];
const INVID = [
  "https://inv.nadeko.net",
  "https://yewtu.be",
  "https://invidious.f5.si",
];

const host = u => u.replace(/^https?:\/\//, "");

async function fetchT(url, opts = {}, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

async function openStream(url, ms = 20000) {
  const r = await fetchT(url, {}, ms);
  if (!r.ok) throw new Error(`stream HTTP ${r.status}`);
  if (!r.body) throw new Error("empty stream body");
  return r;
}

function pipe(streamResp, res, title) {
  res.statusCode = 200;
  res.setHeader("content-type", "video/mp4");
  res.setHeader("x-yt-title", encodeURIComponent((title || "").slice(0, 180)));
  const len = streamResp.headers.get("content-length");
  if (len) res.setHeader("content-length", len);
  Readable.fromWeb(streamResp.body).pipe(res);
}

async function handle(req, res, next) {
  let u;
  try { u = new URL(req.url, "http://localhost"); } catch { return next(); }
  if (u.pathname !== "/api/yt") return next();
  const id = u.searchParams.get("id") || "";
  if (!/^[\w-]{11}$/.test(id)) { res.statusCode = 400; res.end(JSON.stringify({ error: "bad video id" })); return; }
  const watchUrl = `https://www.youtube.com/watch?v=${id}`;
  const errors = [];

  for (const entry of COBALT) {
    const [api, key] = entry.split("|");
    try {
      const r = await fetchT(`${api}/`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", ...(key ? { Authorization: `Api-Key ${key}` } : {}) },
        body: JSON.stringify({ url: watchUrl, videoQuality: "360", youtubeVideoCodec: "h264", filenameStyle: "basic", alwaysProxy: true }),
      });
      const d = await r.json();
      if (d.status === "error") throw new Error(d.error?.code || `cobalt ${r.status}`);
      const su = d.url || d.picker?.find(p => p.type === "video")?.url || d.picker?.[0]?.url;
      if (!su) throw new Error(`no stream (${d.status})`);
      return pipe(await openStream(su), res, (d.filename || "").replace(/\.[^.]+$/, ""));
    } catch (e) { errors.push(`${host(api)}: ${e.message.slice(0, 90)}`); }
  }

  for (const api of PIPED) {
    try {
      const r = await fetchT(`${api}/streams/${id}`, {}, 10000);
      const d = await r.json();
      if (d.error || d.message) throw new Error((d.error || d.message).slice(0, 60));
      const prog = (d.videoStreams || [])
        .filter(s => s.videoOnly === false && /mp4|MPEG/i.test(s.mimeType || s.format || ""))
        .sort((a, b) => (parseInt(a.quality) || 9999) - (parseInt(b.quality) || 9999));
      const pick = prog.find(s => (parseInt(s.quality) || 0) >= 270) || prog[0];
      if (!pick?.url) throw new Error("no progressive stream");
      return pipe(await openStream(pick.url), res, d.title);
    } catch (e) { errors.push(`${host(api)}: ${e.message.slice(0, 90)}`); }
  }

  for (const base of INVID) {
    try {
      const r = await fetchT(`${base}/api/v1/videos/${id}?local=true&fields=title,formatStreams`, {}, 10000);
      const d = await r.json();
      const fs = (d.formatStreams || []).sort((a, b) => (parseInt(a.resolution) || 9999) - (parseInt(b.resolution) || 9999));
      const pick = fs.find(s => (parseInt(s.resolution) || 0) >= 270) || fs[0];
      if (!pick?.url) throw new Error("no progressive stream");
      return pipe(await openStream(new URL(pick.url, base).href), res, d.title);
    } catch (e) { errors.push(`${host(base)}: ${e.message.slice(0, 90)}`); }
  }

  res.statusCode = 502;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: "exhausted", attempts: errors }));
}

export default function ytProxy() {
  return {
    name: "yt-proxy",
    configureServer(server) { server.middlewares.use(handle); },
    configurePreview(server) { server.middlewares.use(handle); },
  };
}
