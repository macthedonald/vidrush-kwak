// Local YouTube download engine — a Vite middleware running in the dev/preview server's
// Node process, so there's no browser CORS to fight. Uses yt-dlp (the youtube-dl-exec
// package bundles the binary on `npm install`), which is far more reliable than the
// public gateway mirrors. Route: GET /api/yt?id=<videoId> → streams an MP4 same-origin.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWin = process.platform === "win32";

// Candidate yt-dlp invocations, tried in order.
function candidates() {
  const bundled = path.resolve(__dirname, "..", "node_modules", "youtube-dl-exec", "bin", isWin ? "yt-dlp.exe" : "yt-dlp");
  const list = [];
  if (existsSync(bundled)) list.push({ cmd: bundled, pre: [] });
  if (process.env.YT_DLP_PATH) list.unshift({ cmd: process.env.YT_DLP_PATH, pre: [] });
  list.push({ cmd: isWin ? "yt-dlp.exe" : "yt-dlp", pre: [] });   // on PATH
  list.push({ cmd: "python3", pre: ["-m", "yt_dlp"] });           // pip install yt-dlp
  list.push({ cmd: "python", pre: ["-m", "yt_dlp"] });
  return list;
}

// progressive mp4 ≤720p (single stream — no ffmpeg merge needed to pipe to stdout)
const FORMAT = "b[ext=mp4][vcodec!=none][acodec!=none][height<=720]/b[ext=mp4][height<=720]/b[ext=mp4]/b";

function tryOne({ cmd, pre }, id, res) {
  return new Promise((resolve, reject) => {
    const url = `https://www.youtube.com/watch?v=${id}`;
    const args = [...pre, "-f", FORMAT, "--no-playlist", "--no-warnings", "-o", "-", url];
    let child;
    try { child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { return reject(new Error(`${cmd}: ${e.message}`)); }

    let started = false, stderr = "";
    const failStart = new Error("spawn failed");
    child.on("error", e => { if (!started) reject(new Error(`${cmd}: ${e.message}`)); });
    child.stderr.on("data", d => { stderr += d.toString().slice(0, 500); });

    child.stdout.once("data", (chunk) => {
      // first bytes arrived → commit to streaming this attempt
      started = true;
      res.statusCode = 200;
      res.setHeader("content-type", "video/mp4");
      res.write(chunk);
      child.stdout.pipe(res);
      resolve(true);
    });

    child.on("close", (code) => {
      if (!started) reject(new Error(`${cmd} exit ${code}: ${stderr.trim().split("\n").pop() || "no output"}`));
      else res.end();
    });
    void failStart;
  });
}

async function handle(req, res, next) {
  let u;
  try { u = new URL(req.url, "http://localhost"); } catch { return next(); }
  if (u.pathname !== "/api/yt") return next();
  const id = u.searchParams.get("id") || "";
  if (!/^[\w-]{11}$/.test(id)) { res.statusCode = 400; res.end(JSON.stringify({ error: "bad video id" })); return; }

  const errors = [];
  for (const c of candidates()) {
    try { await tryOne(c, id, res); return; }
    catch (e) { errors.push(e.message.slice(0, 140)); }
  }
  // Fallback (and parity with production): a cobalt instance, if configured.
  if (process.env.COBALT_API_URL) {
    try { await tryCobalt(id, res); return; }
    catch (e) { errors.push("cobalt: " + e.message.slice(0, 140)); }
  }
  res.statusCode = 502;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    error: "yt-dlp unavailable or failed",
    hint: "Run `npm install` (fetches the yt-dlp binary), install yt-dlp on your PATH, or set COBALT_API_URL.",
    attempts: errors,
  }));
}

// Stream a video through a configured cobalt instance (same engine used in production api/yt.js).
async function tryCobalt(id, res) {
  const base = process.env.COBALT_API_URL.replace(/\/$/, "");
  const api = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...(process.env.COBALT_API_KEY ? { Authorization: `Api-Key ${process.env.COBALT_API_KEY}` } : {}) },
    body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${id}`, videoQuality: "480", youtubeVideoCodec: "h264", filenameStyle: "basic", downloadMode: "auto" }),
  });
  const data = await api.json().catch(() => ({}));
  const mediaUrl = ((data.status === "tunnel" || data.status === "redirect") && data.url)
    || (data.status === "picker" && (data.picker.find(p => p.type === "video") || data.picker[0])?.url);
  if (!mediaUrl) throw new Error(data.error?.code || data.status || "no media url");
  const media = await fetch(mediaUrl);
  if (!media.ok) throw new Error(`media ${media.status}`);
  res.statusCode = 200;
  res.setHeader("content-type", "video/mp4");
  const { Readable } = await import("node:stream");
  Readable.fromWeb(media.body).pipe(res);
}

export default function ytProxy() {
  return {
    name: "yt-proxy",
    configureServer(server) { server.middlewares.use(handle); },
    configurePreview(server) { server.middlewares.use(handle); },
  };
}
