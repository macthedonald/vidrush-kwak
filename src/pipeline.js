// VidRush Studio pipeline — script → storyboard → visuals → voiceover → render → SEO package.
// Workflows adapted from: youtube-engine (style DNA scripting), video-factory /
// real-asset-video-factory (real b-roll, Ken Burns, karaoke subs, attribution),
// stickman-doodle-factory (doodle frames, hard cuts), youtube-video-factory (autopilot).
import * as lame from "@breezystack/lamejs";

const Mp3Encoder = lame.Mp3Encoder || lame.default?.Mp3Encoder;
const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODELS = ["claude-sonnet-5", "claude-sonnet-4-20250514"];
export const GEM_IMG_MODEL = "gemini-3-pro-image-preview";
const GEM_TTS_MODEL = "gemini-2.5-flash-preview-tts";
export const VOICES = ["Charon", "Kore", "Puck", "Fenrir", "Zephyr", "Aoede", "Orus", "Leda"];

// ---------- Claude ----------
export async function claude(system, user, key, { maxTokens = 4000 } = {}) {
  let lastErr = "Claude call failed";
  for (const model of CLAUDE_MODELS) {
    const r = await fetch(ANTHROPIC, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
    });
    const d = await r.json();
    if (d.error) {
      lastErr = d.error.message;
      if (/model/i.test(lastErr) && model !== CLAUDE_MODELS[CLAUDE_MODELS.length - 1]) continue;
      throw new Error(lastErr);
    }
    return d.content?.[0]?.text || "";
  }
  throw new Error(lastErr);
}

export function parseJson(raw) {
  const t = raw.replace(/```json|```/g, "").trim();
  const a = t.indexOf("["), b = t.lastIndexOf("]");
  if (a !== -1 && b > a) return JSON.parse(t.slice(a, b + 1));
  const c = t.indexOf("{"), d = t.lastIndexOf("}");
  if (c !== -1 && d > c) return JSON.parse(t.slice(c, d + 1));
  return JSON.parse(t);
}

// ---------- Prompts ----------
export const SYS_SCRIPT = `You are VidRush Studio — an elite faceless-YouTube scriptwriter with style DNA cloned from the top channels in the given niche.
Write the COMPLETE word-for-word narration script, ready to be read aloud by a voiceover artist.
Rules:
- Open with a 10-15 second HOOK that creates an open curiosity loop.
- Plant a retention hook ("but that's not even the strangest part...") roughly every 60 seconds.
- Conversational, confident tone. Short punchy sentences mixed with longer ones. Second person where natural.
- Specific facts, numbers, names — no filler, no fluff, no "in this video we will".
- Close with a payoff + a one-line subscribe CTA.
Format: PLAIN narration text only. Mark each section with a line: [SECTION: Section Name]
No markdown, no stage directions, no camera notes, no timestamps.`;

export const SYS_STORYBOARD = `You are a storyboard director for faceless YouTube videos. Convert the narration script into a shot-by-shot storyboard.
Split the ENTIRE script IN ORDER into scenes of 2-4 sentences each (~15-25 seconds of narration per scene). Do not skip, shorten, or paraphrase any narration — copy it verbatim.
Return ONLY a JSON array, no markdown:
[{"section":"section name","narration":"exact sentences from the script","visual":"a 40-70 word prompt describing ONE concrete 16:9 frame that illustrates this beat: subject, setting, composition, lighting, mood. Visual keywords only, no text in image","broll":["2-4 word stock-footage search query","alternative query"],"overlay":"optional on-screen text, max 4 words, or empty string"}]`;

export const SYS_SEO = `You are a YouTube SEO strategist. For the given topic and niche return ONLY JSON (no markdown):
{"titles":["5 clickbait-but-honest titles under 70 chars"],
"description":"120-160 word description: hook line with main keywords first, what the video covers, subscribe CTA, then 6-8 #hashtags on the last line",
"tags":["15-20 tags mixing broad and long-tail"],
"pinnedComment":"a 1-2 sentence engagement-bait pinned comment ending with a question"}`;

export const STYLE_WRAP = {
  cinematic: p => `${p}. Photorealistic cinematic photography, dramatic lighting, rich color grade, shallow depth of field, 16:9 frame. Must look like a real photograph shot by a professional — real textures, real materials, NOT AI-looking. No text, no watermark, no logos.`,
  realasset: p => `${p}. Photorealistic documentary still, natural available light, realistic skin and material textures, editorial press-photo style, 16:9 frame. Looks like genuine archival/news photography. No text, no watermark, no logos.`,
  doodle: p => `Simple hand-drawn stickman doodle illustration: ${p}. Thick black marker line art on a plain white paper background, childlike sketch, minimal props, flat, at most one red accent element, 16:9 frame. No text, no shading, no color fill.`,
};

// ---------- Gemini image ----------
export async function geminiImage(prompt, key, { aspect = "16:9", refs = [] } = {}) {
  const parts = [{ text: prompt }];
  refs.forEach(r => parts.push({ inline_data: { mime_type: r.mime, data: r.data } }));
  const body = { contents: [{ parts }], generationConfig: { responseModalities: ["IMAGE", "TEXT"], imageConfig: { aspectRatio: aspect } } };
  let resp;
  for (let attempt = 1; attempt <= 3; attempt++) {
    resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEM_IMG_MODEL}:generateContent?key=${key}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if ((resp.status === 429 || resp.status === 500 || resp.status === 503) && attempt < 3) { await new Promise(r => setTimeout(r, attempt * 2500)); continue; }
    break;
  }
  if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error?.message || `HTTP ${resp.status}`); }
  const data = await resp.json();
  for (const part of (data.candidates?.[0]?.content?.parts || [])) if (part.inlineData) return `data:image/png;base64,${part.inlineData.data}`;
  throw new Error("No image in response");
}

// ---------- Gemini TTS ----------
export async function geminiTTS(text, voice, key) {
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
  };
  let resp;
  for (let attempt = 1; attempt <= 4; attempt++) {
    resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEM_TTS_MODEL}:generateContent?key=${key}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if ((resp.status === 429 || resp.status === 500 || resp.status === 503) && attempt < 4) { await new Promise(r => setTimeout(r, attempt * 3000)); continue; }
    break;
  }
  if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error?.message || `TTS HTTP ${resp.status}`); }
  const data = await resp.json();
  const part = (data.candidates?.[0]?.content?.parts || []).find(p => p.inlineData);
  if (!part) throw new Error("No audio in response");
  const rate = +(part.inlineData.mimeType?.match(/rate=(\d+)/)?.[1] || 24000);
  const bin = atob(part.inlineData.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { pcm: new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2)), rate };
}

export function concatPcm(list) {
  const total = list.reduce((s, p) => s + p.length, 0);
  const out = new Int16Array(total);
  let o = 0;
  for (const p of list) { out.set(p, o); o += p.length; }
  return out;
}

export function pcmToWav(pcm, rate) {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); ws(8, "WAVE"); ws(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, "data"); v.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: "audio/wav" });
}

export function pcmToMp3(pcm, rate, kbps = 128) {
  const enc = new Mp3Encoder(1, rate, kbps);
  const chunks = [];
  for (let i = 0; i < pcm.length; i += 1152) {
    const d = enc.encodeBuffer(pcm.subarray(i, i + 1152));
    if (d.length) chunks.push(new Uint8Array(d));
  }
  const end = enc.flush();
  if (end.length) chunks.push(new Uint8Array(end));
  return new Blob(chunks, { type: "audio/mpeg" });
}

// ---------- Pexels (real-asset sourcing) ----------
export async function pexelsPhotos(query, key, perPage = 6) {
  const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=landscape`, { headers: { Authorization: key } });
  if (!r.ok) throw new Error(`Pexels ${r.status}`);
  const d = await r.json();
  return (d.photos || []).map(p => ({ src: p.src.large2x || p.src.large, thumb: p.src.medium, photographer: p.photographer, url: p.url }));
}

export async function urlToDataURL(url) {
  const resp = await fetch(url);
  const blob = await resp.blob();
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
}

// ---------- ZIP writer (store method, no deps) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function makeZip(files) { // [{name, data: string|Uint8Array}]
  const enc = new TextEncoder();
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const name = enc.encode(f.name);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, 0, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    locals.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, 0, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    centrals.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = centrals.reduce((s, u) => s + u.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...locals, ...centrals, new Uint8Array(end.buffer)], { type: "application/zip" });
}

export const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
export const estDuration = narration => Math.max(2.5, narration.split(/\s+/).filter(Boolean).length / 2.6);

// ---------- Renderer: canvas + MediaRecorder → MP4/WebM ----------
export function pickMime() {
  const cands = ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', "video/mp4", 'video/webm;codecs="vp9,opus"', "video/webm"];
  for (const m of cands) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return "";
}

function drawCover(g, img, W, H, scale, px, py) {
  const iw = img.width, ih = img.height;
  const s = Math.max(W / iw, H / ih) * scale;
  const dw = iw * s, dh = ih * s;
  g.drawImage(img, (W - dw) / 2 + px * (dw - W) / 2, (H - dh) / 2 + py * (dh - H) / 2, dw, dh);
}

function drawSubs(g, scene, p, W, H, doodle) {
  const words = scene.words;
  if (!words.length) return;
  const idx = Math.min(words.length - 1, Math.floor(p * words.length));
  const per = 7, gStart = Math.floor(idx / per) * per;
  const group = words.slice(gStart, gStart + per);
  g.font = `700 ${Math.round(H * 0.045)}px 'DM Sans', sans-serif`;
  g.textBaseline = "middle";
  const widths = group.map(w => g.measureText(w + " ").width);
  const totalW = widths.reduce((a, b) => a + b, 0);
  let x = (W - totalW) / 2;
  const y = H - H * 0.09;
  const padY = H * 0.035;
  g.fillStyle = doodle ? "rgba(255,255,255,.88)" : "rgba(0,0,0,.55)";
  const padX = W * 0.015;
  roundRect(g, x - padX, y - padY, totalW + padX * 2, padY * 2, 10); g.fill();
  group.forEach((w, i) => {
    const active = gStart + i === idx;
    g.fillStyle = doodle ? (active ? "#e02020" : "#111") : (active ? "#ffd734" : "#fff");
    g.fillText(w, x, y);
    x += widths[i];
  });
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

function drawScene(g, s, p, W, H, style) {
  const doodle = style === "doodle";
  g.fillStyle = doodle ? "#fdfdfa" : "#000";
  g.fillRect(0, 0, W, H);
  if (s.imgEl) {
    if (doodle) drawCover(g, s.imgEl, W, H, 1, 0, 0); // hard frames, no motion (stickman-doodle rule)
    else {
      const zoomIn = s.idx % 2 === 0;
      const scale = zoomIn ? 1 + 0.09 * p : 1.09 - 0.09 * p;
      const px = (s.idx % 4 < 2 ? -1 : 1) * (p - 0.5) * 0.3;
      drawCover(g, s.imgEl, W, H, scale, px, 0);
      const grad = g.createLinearGradient(0, H * 0.7, 0, H);
      grad.addColorStop(0, "rgba(0,0,0,0)"); grad.addColorStop(1, "rgba(0,0,0,.45)");
      g.fillStyle = grad; g.fillRect(0, H * 0.7, W, H * 0.3);
    }
  } else {
    const grad = g.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, "#1a1a26"); grad.addColorStop(1, "#3a1020");
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    g.fillStyle = "rgba(255,255,255,.85)";
    g.font = `700 ${Math.round(H * 0.05)}px 'DM Sans', sans-serif`;
    g.textAlign = "center"; g.fillText(s.section || "", W / 2, H / 2); g.textAlign = "left";
  }
  if (s.overlay) {
    g.font = `800 ${Math.round(H * 0.062)}px 'DM Sans', sans-serif`;
    const tw = g.measureText(s.overlay).width;
    g.lineWidth = H * 0.012; g.strokeStyle = "rgba(0,0,0,.85)"; g.lineJoin = "round";
    g.strokeText(s.overlay, (W - tw) / 2, H * 0.14);
    g.fillStyle = "#fff"; g.fillText(s.overlay, (W - tw) / 2, H * 0.14);
  }
}

export function renderVideo({ scenes, style = "cinematic", width = 1280, height = 720, fps = 30, subtitles = true, gap = 0.35, onProgress }) {
  return new Promise(async (resolve, reject) => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const g = canvas.getContext("2d");
      // timeline
      let t = 0;
      const timeline = scenes.map((s, idx) => {
        const duration = s.pcm ? s.pcm.length / s.rate : estDuration(s.narration);
        const entry = { ...s, idx, start: t, duration, words: (s.narration || "").split(/\s+/).filter(Boolean) };
        t += duration + gap;
        return entry;
      });
      const total = t + 0.4;
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const dest = audioCtx.createMediaStreamDestination();
      const mime = pickMime();
      if (!mime) throw new Error("MediaRecorder not supported in this browser");
      const stream = canvas.captureStream(fps);
      dest.stream.getAudioTracks().forEach(tr => stream.addTrack(tr));
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: width >= 1920 ? 12_000_000 : 7_000_000 });
      const chunks = [];
      rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        audioCtx.close().catch(() => {});
        resolve({ blob: new Blob(chunks, { type: mime.split(";")[0] }), ext: mime.includes("mp4") ? "mp4" : "webm", duration: total });
      };
      rec.onerror = e => reject(e.error || new Error("Recorder error"));
      // schedule audio
      const lead = 0.25;
      const t0 = audioCtx.currentTime + lead;
      for (const s of timeline) {
        if (!s.pcm) continue;
        const buf = audioCtx.createBuffer(1, s.pcm.length, s.rate);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < s.pcm.length; i++) ch[i] = s.pcm[i] / 32768;
        const src = audioCtx.createBufferSource();
        src.buffer = buf; src.connect(dest); src.start(t0 + s.start);
      }
      rec.start(500);
      const startClock = performance.now() + lead * 1000;
      let stopped = false;
      const loop = () => {
        if (stopped) return;
        const now = (performance.now() - startClock) / 1000;
        const cur = now < 0 ? timeline[0] : (timeline.filter(s => now >= s.start && now < s.start + s.duration + gap).pop() || timeline[timeline.length - 1]);
        if (cur) {
          const p = Math.min(1, Math.max(0, (now - cur.start) / cur.duration));
          drawScene(g, cur, p, width, height, style);
          // crossfade into next scene during the gap (cinematic/realasset only)
          if (style !== "doodle") {
            const next = timeline[cur.idx + 1];
            const fadeStart = cur.start + cur.duration + gap - 0.35;
            if (next && now > fadeStart) {
              g.globalAlpha = Math.min(1, (now - fadeStart) / 0.35);
              drawScene(g, next, 0, width, height, style);
              g.globalAlpha = 1;
            }
          }
          if (subtitles && now <= cur.start + cur.duration) drawSubs(g, cur, p, width, height, style === "doodle");
        }
        if (onProgress) onProgress(Math.min(1, Math.max(0, now / total)));
        if (now >= total) { stopped = true; setTimeout(() => rec.stop(), 300); return; }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    } catch (e) { reject(e); }
  });
}

export function loadImage(dataUrl) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("Image failed to load"));
    img.src = dataUrl;
  });
}
