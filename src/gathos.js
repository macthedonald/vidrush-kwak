// Gathos API (https://gathos.com/api/v1) — all image and video generation runs here.
// Async job model: submit → poll → retrieve. Images return base64; video returns a time-limited URL.
import { pfetch } from "./net.js";
const BASE = "https://gathos.com/api/v1";

const hdrs = key => ({ Authorization: `Bearer ${key}` });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function gjson(r) {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const retry = d.retry_after_seconds ? ` Retry after ${d.retry_after_seconds}s.` : "";
    const err = new Error(`Gathos ${r.status}: ${d.error || "request failed"}.${retry}`);
    err.retryAfter = d.retry_after_seconds;
    err.status = r.status;
    throw err;
  }
  return d;
}

// Image size must be 512-2048 and divisible by 16.
export const IMG_SIZE = { "16:9": { width: 1280, height: 720 }, "9:16": { width: 720, height: 1280 }, "1:1": { width: 1024, height: 1024 } };
// Video size must be divisible by 32.
export const VID_SIZE = { "16:9": { width: 1280, height: 736 }, "9:16": { width: 736, height: 1280 } };

// LTX frame counts satisfy (n-1) % 8 === 0, clamped to 9..513.
export const snapLtxFrames = (rawFrames) => {
  const clamped = Math.max(9, Math.min(513, Math.round(rawFrames)));
  return Math.max(9, Math.min(513, Math.round((clamped - 1) / 8) * 8 + 1));
};

// Generate one image → data URL. Retries once on 429 using the server's suggested delay.
export async function gathosImage(prompt, key, { aspect = "16:9", enhance = false, onStatus } = {}) {
  const { width, height } = IMG_SIZE[aspect] || IMG_SIZE["16:9"];
  const submit = async () => gjson(await pfetch(`${BASE}/image-generation`, {
    method: "POST",
    headers: { ...hdrs(key), "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: prompt.slice(0, 2000), width, height, use_prompt_enhancer: enhance, steps: 8 }),
  }));
  let job;
  try { job = await submit(); }
  catch (e) {
    if (e.status === 429 && e.retryAfter) { await sleep((e.retryAfter + 1) * 1000); job = await submit(); }
    else throw e;
  }
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const d = await gjson(await pfetch(`${BASE}/image-generation/jobs/${job.job_id}`, { headers: hdrs(key) }));
    if (onStatus && d.eta_seconds != null) onStatus(`~${Math.round(d.eta_seconds)}s`);
    if (d.status === "completed") return `data:${d.result.content_type || "image/png"};base64,${d.result.image_base64}`;
    if (d.status === "failed") throw new Error(d.error || "Gathos image job failed");
  }
  throw new Error("Gathos image job timed out");
}

async function dataUrlToBlob(dataUrl) {
  const r = await fetch(dataUrl);
  return r.blob();
}

// Generate one short video clip → Blob. mode t2av (text) or ti2av (animate an existing frame).
// generate_audio is always false: the voiceover/music mix owns the audio track.
export async function gathosVideo(prompt, key, { aspect = "16:9", durationSec = 4, fps = 24, style = null, imageDataUrl = null, onStatus, isCancelled } = {}) {
  const { width, height } = VID_SIZE[aspect] || VID_SIZE["16:9"];
  const num_frames = snapLtxFrames(durationSec * fps);
  let resp;
  if (imageDataUrl) {
    const fd = new FormData();
    fd.append("mode", "ti2av");
    fd.append("image", await dataUrlToBlob(imageDataUrl), "frame.png");
    fd.append("prompt", prompt.slice(0, 2000));
    fd.append("width", String(width)); fd.append("height", String(height));
    fd.append("num_frames", String(num_frames)); fd.append("fps", String(fps));
    if (style) fd.append("style", style);
    fd.append("generate_audio", "false");
    fd.append("prevent_text", "true");
    resp = await pfetch(`${BASE}/video-generation`, { method: "POST", headers: hdrs(key), body: fd });
  } else {
    resp = await pfetch(`${BASE}/video-generation`, {
      method: "POST",
      headers: { ...hdrs(key), "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt.slice(0, 2000), mode: "t2av", width, height, num_frames, fps, style: style || null, generate_audio: false, prevent_text: true }),
    });
  }
  let job;
  try { job = await gjson(resp); }
  catch (e) {
    if ((e.status === 429 || e.status === 503) && e.retryAfter) {
      await sleep((e.retryAfter + 2) * 1000);
      return gathosVideo(prompt, key, { aspect, durationSec, fps, style, imageDataUrl, onStatus, isCancelled });
    }
    throw e;
  }
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    if (isCancelled?.()) throw new Error("Cancelled");
    await sleep(7000);
    const d = await gjson(await pfetch(`${BASE}/video-generation/jobs/${job.job_id}`, { headers: hdrs(key) }));
    if (onStatus) onStatus(d.status);
    if (d.status === "done" && d.video_url) {
      const vr = await pfetch(d.video_url);
      if (!vr.ok) throw new Error(`Gathos video download ${vr.status}`);
      return vr.blob();
    }
    if (d.status === "failed") throw new Error(d.error || "Gathos video job failed");
  }
  throw new Error("Gathos video job timed out");
}

// Map the Studio's visual styles onto Gathos video style presets.
export const GATHOS_STYLE = { cinematic: "Cinematic", realasset: "Cinematic", doodle: "Stickman" };

export async function gathosVideoStyles(key) {
  const d = await gjson(await pfetch(`${BASE}/video-generation/styles`, { headers: hdrs(key) }));
  return d.styles || [];
}
