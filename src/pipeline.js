// VidRush Studio pipeline — script → storyboard → visuals → voiceover → render → SEO package.
// Workflows adapted from: youtube-engine (style DNA scripting), video-factory /
// real-asset-video-factory (real b-roll, Ken Burns, karaoke subs, attribution),
// stickman-doodle-factory (doodle frames, hard cuts), youtube-video-factory (autopilot).
import * as lame from "@breezystack/lamejs";
import { pfetch } from "./net.js";

const Mp3Encoder = lame.Mp3Encoder || lame.default?.Mp3Encoder;
const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODELS = ["claude-sonnet-5"];
export const GEM_IMG_MODEL = "gemini-3-pro-image-preview";
const GEM_TTS_MODEL = "gemini-2.5-flash-preview-tts";
const GEM_VIDEO_MODEL = "gemini-2.5-flash"; // native video understanding
const GEM_API = "https://generativelanguage.googleapis.com";
export const VOICES = ["Charon", "Kore", "Puck", "Fenrir", "Zephyr", "Aoede", "Orus", "Leda"];

// ---------- Claude (with retry/backoff on rate limits and overload) ----------
async function claudeCall(body, key) {
  let lastErr = "Claude call failed";
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fetch(ANTHROPIC, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify(body),
    });
    if ((r.status === 429 || r.status === 500 || r.status === 529) && attempt < 4) {
      lastErr = `Anthropic ${r.status}`;
      await new Promise(res => setTimeout(res, attempt * 4000));
      continue;
    }
    let d;
    try { d = await r.json(); }
    catch { throw new Error(`Anthropic returned an unreadable response (HTTP ${r.status}) — try again`); }
    if (d.error) throw new Error(d.error.message);
    const text = (d.content || []).map(c => c.text || "").join("");
    if (!text.trim()) throw new Error("Anthropic returned an empty response — try again");
    return text;
  }
  throw new Error(lastErr);
}

export async function claude(system, user, key, { maxTokens = 4000 } = {}) {
  let lastErr = "Claude call failed";
  for (const model of CLAUDE_MODELS) {
    try {
      return await claudeCall({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }, key);
    } catch (e) {
      lastErr = e.message;
      if (/model/i.test(lastErr) && model !== CLAUDE_MODELS[CLAUDE_MODELS.length - 1]) continue;
      throw e;
    }
  }
  throw new Error(lastErr);
}

// Vision variant: imageSource is {data, mime} base64, or a URL string (fetched → base64).
export async function claudeVision(system, userText, imageSource, key, { maxTokens = 4000 } = {}) {
  let block;
  if (typeof imageSource === "object" && imageSource.data) {
    block = { type: "image", source: { type: "base64", media_type: imageSource.mime, data: imageSource.data } };
  } else {
    try {
      const resp = await pfetch(imageSource);
      const blob = await resp.blob();
      const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); });
      block = { type: "image", source: { type: "base64", media_type: blob.type || "image/jpeg", data: b64 } };
    } catch {
      block = { type: "image", source: { type: "url", url: imageSource } };
    }
  }
  let lastErr = "Claude vision call failed";
  for (const model of CLAUDE_MODELS) {
    try {
      return await claudeCall({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: [block, { type: "text", text: userText }] }] }, key);
    } catch (e) {
      lastErr = e.message;
      if (/model/i.test(lastErr) && model !== CLAUDE_MODELS[CLAUDE_MODELS.length - 1]) continue;
      throw e;
    }
  }
  throw new Error(lastErr);
}

// Repair a truncated JSON fragment: trim from the end to the last point where the
// structure is balanced (not mid-string, brackets matched), then close open brackets.
// Handles truncated arrays AND nested objects. Returns undefined if unrepairable.
function repairJson(body) {
  for (let end = body.length; end > 1; end--) {
    const head = body.slice(0, end).replace(/[,:\s]+$/, "");
    if (!head) continue;
    let inStr = false, esc = false, ok = true;
    const stack = [];
    for (let i = 0; i < head.length; i++) {
      const c = head[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") stack.push("}");
      else if (c === "[") stack.push("]");
      else if (c === "}" || c === "]") { if (!stack.length) { ok = false; break; } stack.pop(); }
    }
    if (!ok || inStr) continue; // mid-string or unbalanced close — keep trimming
    try { return JSON.parse(head + stack.reverse().join("")); } catch {}
  }
  return undefined;
}

// Tolerant JSON extraction: strips fences/preamble, then repairs truncation instead of
// throwing "Unexpected end of JSON input".
export function parseJson(raw) {
  const t = (raw || "").replace(/```json|```/g, "").trim();
  if (!t) throw new Error("The AI returned an empty response — please try again");
  const a = t.indexOf("["), c = t.indexOf("{");
  const startsArray = a !== -1 && (c === -1 || a < c);
  const start = startsArray ? a : c;
  let body = start >= 0 ? t.slice(start) : t;
  const lastClose = startsArray ? body.lastIndexOf("]") : body.lastIndexOf("}");
  const whole = lastClose > 0 ? body.slice(0, lastClose + 1) : body;
  try { return JSON.parse(whole); } catch {}
  const repaired = repairJson(body);
  if (repaired !== undefined) return repaired;
  throw new Error("Couldn't read the AI's JSON response — hit the button again");
}

// ---------- Prompts ----------
export const SYS_BRIEF = `You are VidRush — an elite YouTube script prompt engineer. Write a creative brief in English.

CRITICAL LENGTH RULE: Your response MUST be between 5,000 and 9,000 characters. This is a HARD LIMIT.

Structure using 4 pillars:
**What the Video Is About** — 2-3 sentences explaining the topic, narrative arc, core tension
**Style of Talking** — Narration tone, pacing, transitions, hooks
**Who This Video Is For** — Audience demographics, what they search for
**Key Facts Covered** — Talking points with specific facts, numbers, names. Each point: 2-3 bullets max. For 15-min = ~8 points. For 30-min = ~15 points.

Rules: Visual keywords only (no stage directions). ~0.5 talking points per minute. End with Style + Tone line. Keep it CONCISE — quality over quantity.`;

export const SYS_SCRIPT = `You are VidRush Studio — an elite faceless-YouTube scriptwriter with style DNA cloned from the top channels in the given niche.
Write the COMPLETE, word-for-word narration script, ready to be read aloud by a voiceover artist.
Rules:
- Open with a 10-15 second HOOK that creates an open curiosity loop.
- Plant a retention hook ("but that's not even the strangest part...") roughly every 60 seconds.
- Conversational, confident tone. Short punchy sentences mixed with longer ones. Second person where natural.
- Specific facts, numbers, names — no filler, no fluff, no "in this video we will".
- Close with a payoff + a one-line subscribe CTA.
Output ONLY the clean spoken narration — exactly the words the voice artist reads, nothing else.
Break it into natural paragraphs, one blank line between beats, so it reads as a full clean script.
Do NOT include: section headers or labels, [SECTION] tags, "Hook:" / "Intro:" / "Outro:" prefixes, timestamps, speaker names, camera or stage directions, markdown, asterisks, bold, headings, or bullet points.`;

export const SYS_STORYBOARD = `You are a storyboard director for fast-cut faceless YouTube videos. Convert the narration script into a shot-by-shot storyboard.
Split the ENTIRE script IN ORDER into SHORT shots of 3-5 seconds each — that is 8-14 words of narration per shot, cutting at natural clause boundaries. Do not skip, shorten, or paraphrase any narration — copy it verbatim across the shots.
Return ONLY a JSON array, no markdown:
[{"section":"section name (keep the same value for consecutive shots of the same script section)","narration":"the exact 8-14 words from the script for this shot","visual":"a 30-50 word prompt describing ONE concrete 16:9 frame that illustrates this beat: subject, setting, composition, lighting, mood. Visual keywords only, no text in image","broll":["2-4 word stock-footage search query","alternative query"],"overlay":"optional on-screen text, max 4 words, or empty string"}]`;

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

// Multi-image vision call — used to understand a reference video's keyframes.
export async function claudeVisionMulti(system, text, imageDataUrls, key, { maxTokens = 8000 } = {}) {
  const blocks = imageDataUrls.map(u => ({
    type: "image",
    source: { type: "base64", media_type: u.slice(5, u.indexOf(";")) || "image/jpeg", data: u.split(",")[1] },
  }));
  let lastErr = "Claude vision call failed";
  for (const model of CLAUDE_MODELS) {
    try {
      return await claudeCall({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: [...blocks, { type: "text", text }] }] }, key);
    } catch (e) {
      lastErr = e.message;
      if (/model/i.test(lastErr) && model !== CLAUDE_MODELS[CLAUDE_MODELS.length - 1]) continue;
      throw e;
    }
  }
  throw new Error(lastErr);
}

// ---------- Gemini native video understanding ----------
// Uploads a video file to the Gemini File API (resumable), waits until ACTIVE, returns its uri.
async function geminiUploadFile(file, key, onStatus) {
  const start = await fetch(`${GEM_API}/upload/v1beta/files?key=${key}`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(file.size),
      "X-Goog-Upload-Header-Content-Type": file.type || "video/mp4",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: file.name || "video" } }),
  });
  if (!start.ok) throw new Error(`Gemini upload start ${start.status}`);
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini did not return an upload URL");
  if (onStatus) onStatus("Uploading video to Gemini…");
  const up = await fetch(uploadUrl, {
    method: "POST",
    headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: file,
  });
  if (!up.ok) throw new Error(`Gemini upload ${up.status}`);
  const info = await up.json();
  let name = info.file?.name;
  let uri = info.file?.uri;
  let state = info.file?.state;
  const deadline = Date.now() + 180000;
  while (state === "PROCESSING" && Date.now() < deadline) {
    if (onStatus) onStatus("Gemini is processing the video…");
    await new Promise(r => setTimeout(r, 3000));
    const s = await fetch(`${GEM_API}/v1beta/${name}?key=${key}`);
    const d = await s.json();
    state = d.state; uri = d.uri || uri;
  }
  if (state !== "ACTIVE") throw new Error(`Gemini video never became ready (state ${state})`);
  return { uri, mimeType: file.type || "video/mp4" };
}

// Analyze a video with Gemini. source = { youtubeUrl } (Gemini fetches it — no download)
// or { file } (uploaded: inline if small, File API if large). Returns the model's text.
export async function geminiAnalyzeVideo(source, systemPrompt, userPrompt, key, { onStatus, json = true } = {}) {
  if (!key) throw new Error("Add your Gemini API key in Settings to analyze videos");
  let mediaPart;
  if (source.youtubeUrl) {
    mediaPart = { file_data: { file_uri: source.youtubeUrl } };
  } else if (source.file) {
    const f = source.file;
    if (f.size <= 18 * 1024 * 1024) {
      if (onStatus) onStatus("Encoding video for Gemini…");
      const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.onerror = rej; r.readAsDataURL(f); });
      mediaPart = { inline_data: { mime_type: f.type || "video/mp4", data: b64 } };
    } else {
      const up = await geminiUploadFile(f, key, onStatus);
      mediaPart = { file_data: { mime_type: up.mimeType, file_uri: up.uri } };
    }
  } else throw new Error("No video source provided");

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text: userPrompt }, mediaPart] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 8000, ...(json ? { responseMimeType: "application/json" } : {}) },
  };
  if (onStatus) onStatus("Gemini is watching the video…");
  let resp;
  for (let attempt = 1; attempt <= 3; attempt++) {
    resp = await fetch(`${GEM_API}/v1beta/models/${GEM_VIDEO_MODEL}:generateContent?key=${key}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if ((resp.status === 429 || resp.status === 500 || resp.status === 503) && attempt < 3) { await new Promise(r => setTimeout(r, attempt * 4000)); continue; }
    break;
  }
  const d = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(d.error?.message || `Gemini ${resp.status}`);
  const text = (d.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
  if (!text.trim()) throw new Error("Gemini returned an empty analysis — try again");
  return text;
}

// ---------- Groq Whisper: word-level timestamps for any voiceover ----------
export async function groqTranscribe(wavBlob, key) {
  const fd = new FormData();
  fd.append("file", wavBlob, "voiceover.wav");
  fd.append("model", "whisper-large-v3-turbo");
  fd.append("response_format", "verbose_json");
  fd.append("timestamp_granularities[]", "word");
  const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || `Groq ${r.status}`);
  const words = (d.words || []).map(w => ({ word: w.word, start: +w.start, end: +w.end }));
  return words.length ? words : null;
}

// Segment-level transcription (for long reference videos — much lighter than word granularity).
export async function groqTranscribeSegments(wavBlob, key) {
  const fd = new FormData();
  fd.append("file", wavBlob, "reference.wav");
  fd.append("model", "whisper-large-v3-turbo");
  fd.append("response_format", "verbose_json");
  const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || `Groq ${r.status}`);
  return { text: d.text || "", segments: (d.segments || []).map(s => ({ start: +s.start, end: +s.end, text: s.text })) };
}

// Decode a media file's audio track → mono 16kHz WAV blob (capped for API size limits).
export async function extractAudioWav16k(file, maxSeconds = 840) {
  const ab = await file.arrayBuffer();
  const probe = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await probe.decodeAudioData(ab);
  probe.close().catch(() => {});
  const rate = 16000;
  const dur = Math.min(decoded.duration, maxSeconds);
  const off = new OfflineAudioContext(1, Math.ceil(dur * rate), rate);
  const src = off.createBufferSource();
  src.buffer = decoded; src.connect(off.destination); src.start();
  const out = await off.startRendering();
  const f32 = out.getChannelData(0);
  const pcm = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
  return { wav: pcmToWav(pcm, rate), truncated: decoded.duration > maxSeconds, duration: decoded.duration };
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

// ---------- Real-asset sourcing: Coverr + Pixabay primary, Pexels fallback ----------
export async function pexelsPhotos(query, key, perPage = 6) {
  const r = await pfetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=landscape`, { headers: { Authorization: key } });
  if (!r.ok) throw new Error(`Pexels ${r.status}`);
  const d = await r.json();
  return (d.photos || []).map(p => ({ kind: "photo", src: p.src.large2x || p.src.large, thumb: p.src.medium, credit: `Photo by ${p.photographer} on Pexels`, url: p.url, source: "Pexels" }));
}
export async function pexelsVideos(query, key, perPage = 5) {
  const r = await pfetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=landscape`, { headers: { Authorization: key } });
  if (!r.ok) throw new Error(`Pexels ${r.status}`);
  const d = await r.json();
  return (d.videos || []).map(v => {
    const files = (v.video_files || []).filter(f => f.file_type === "video/mp4").sort((a, b) => (a.width || 0) - (b.width || 0));
    const pick = files.find(f => (f.width || 0) >= 960) || files[files.length - 1];
    return pick && { kind: "video", src: pick.link, thumb: v.image, credit: `Video by ${v.user?.name || "Pexels creator"} on Pexels`, url: v.url, source: "Pexels" };
  }).filter(Boolean);
}
export async function coverrVideos(query, key, pageSize = 6) {
  const r = await pfetch(`https://api.coverr.co/videos?urls=true&page_size=${pageSize}&query=${encodeURIComponent(query)}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`Coverr ${r.status}`);
  const d = await r.json();
  return (d.hits || []).map(v => ({ kind: "video", src: v.urls?.mp4_preview || v.urls?.mp4, thumb: v.thumbnail || v.poster, credit: `Video from Coverr (${v.title || v.id})`, url: `https://coverr.co/videos/${v.id}`, source: "Coverr" })).filter(v => v.src);
}
export async function pixabayVideos(query, key, perPage = 5) {
  const r = await pfetch(`https://pixabay.com/api/videos/?key=${key}&q=${encodeURIComponent(query)}&per_page=${perPage}&safesearch=true`);
  if (!r.ok) throw new Error(`Pixabay ${r.status}`);
  const d = await r.json();
  return (d.hits || []).map(v => {
    const f = v.videos?.medium?.url ? v.videos.medium : v.videos?.small;
    return f && { kind: "video", src: f.url, thumb: v.videos?.tiny?.thumbnail || `https://i.vimeocdn.com/video/${v.picture_id}_295x166.jpg`, credit: `Video by ${v.user} on Pixabay`, url: v.pageURL, source: "Pixabay" };
  }).filter(Boolean);
}
export async function pixabayPhotos(query, key, perPage = 6) {
  const r = await pfetch(`https://pixabay.com/api/?key=${key}&q=${encodeURIComponent(query)}&image_type=photo&orientation=horizontal&per_page=${perPage}&safesearch=true`);
  if (!r.ok) throw new Error(`Pixabay ${r.status}`);
  const d = await r.json();
  return (d.hits || []).map(p => ({ kind: "photo", src: p.largeImageURL, thumb: p.webformatURL, credit: `Photo by ${p.user} on Pixabay`, url: p.pageURL, source: "Pixabay" }));
}
// Cascade: Coverr video → Pixabay video → Pixabay photo → Pexels video → Pexels photo.
export async function sourceRealAsset(query, keys) {
  const tries = [
    keys.coverr && (() => coverrVideos(query, keys.coverr, 3)),
    keys.pixabay && (() => pixabayVideos(query, keys.pixabay, 3)),
    keys.pixabay && (() => pixabayPhotos(query, keys.pixabay, 3)),
    keys.pexels && (() => pexelsVideos(query, keys.pexels, 3)),
    keys.pexels && (() => pexelsPhotos(query, keys.pexels, 3)),
  ].filter(Boolean);
  for (const fn of tries) {
    try { const res = await fn(); if (res.length) return res[0]; } catch {}
  }
  return null;
}
export async function urlToBlobUrl(url) {
  const resp = await pfetch(url);
  if (!resp.ok) throw new Error(`Asset fetch ${resp.status}`);
  return URL.createObjectURL(await resp.blob());
}

export async function urlToDataURL(url) {
  const resp = await pfetch(url);
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
// Paint one frame of the timeline at time `now` — shared by both renderers.
function paintFrame(g, timeline, now, W, H, style, subtitles) {
  const cur = now < 0 ? timeline[0] : (timeline.filter(s => now >= s.start).pop() || timeline[timeline.length - 1]);
  if (!cur) return null;
  const p = Math.min(1, Math.max(0, (now - cur.start) / cur.duration));
  drawScene(g, cur, p, W, H, style);
  if (style !== "doodle") {
    const next = timeline[cur.idx + 1];
    const fadeDur = 0.18;
    const fadeStart = cur.start + cur.duration - fadeDur;
    if (next && now > fadeStart) {
      g.globalAlpha = Math.min(1, (now - fadeStart) / fadeDur);
      drawScene(g, next, 0, W, H, style);
      g.globalAlpha = 1;
    }
  }
  if (subtitles && now <= cur.start + cur.duration) drawSubs(g, cur, p, now, W, H, style === "doodle");
  return cur;
}

// Offline audio mix: voiceover segments + ducked music → stereo 48k AudioBuffer.
export async function buildAudioMix({ audioSegs = [], music = null, total, sampleRate = 48000 }) {
  const len = Math.max(1, Math.ceil(total * sampleRate));
  const off = new OfflineAudioContext(2, len, sampleRate);
  for (const seg of audioSegs) {
    if (!seg.pcm?.length) continue;
    const buf = off.createBuffer(1, seg.pcm.length, seg.rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < seg.pcm.length; i++) ch[i] = seg.pcm[i] / 32768;
    const src = off.createBufferSource();
    src.buffer = buf; src.connect(off.destination); src.start(seg.start);
  }
  if (music?.buffer) {
    const src = off.createBufferSource();
    src.buffer = music.buffer; src.loop = true;
    const gain = off.createGain();
    const vol = music.volume ?? 0.12;
    gain.gain.setValueAtTime(0, 0);
    gain.gain.linearRampToValueAtTime(vol, 1);
    gain.gain.setValueAtTime(vol, Math.max(1, total - 2));
    gain.gain.linearRampToValueAtTime(0, total);
    src.connect(gain); gain.connect(off.destination);
    src.start(0); src.stop(total);
  }
  return off.startRendering();
}

export function pickMime() {
  const cands = ['video/mp4;codecs="avc1.42E01E,mp4a.40.2"', "video/mp4", 'video/webm;codecs="vp9,opus"', "video/webm"];
  for (const m of cands) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return "";
}

function drawCoverM(g, media, W, H, scale, px, py) {
  const iw = media.w, ih = media.h;
  const s = Math.max(W / iw, H / ih) * scale;
  const dw = iw * s, dh = ih * s;
  g.drawImage(media.el, (W - dw) / 2 + px * (dw - W) / 2, (H - dh) / 2 + py * (dh - H) / 2, dw, dh);
}

function drawSubs(g, scene, p, now, W, H, doodle) {
  const words = scene.words;
  if (!words.length) return;
  // word-accurate timing when the TTS provider returned timestamps; estimated otherwise
  let idx;
  if (scene.wordTimes?.length) {
    idx = scene.wordTimes.findIndex(w => now < w.end);
    if (idx === -1) idx = scene.wordTimes.length - 1;
  } else {
    idx = Math.min(words.length - 1, Math.floor(p * words.length));
  }
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
  const media = s.vidEl && s.vidEl.readyState >= 2 ? { el: s.vidEl, w: s.vidEl.videoWidth, h: s.vidEl.videoHeight } : s.imgEl ? { el: s.imgEl, w: s.imgEl.width, h: s.imgEl.height } : null;
  if (media && media.w) {
    if (doodle || s.vidEl) drawCoverM(g, media, W, H, 1, 0, 0); // hard frames for doodle; real clips play as-is
    else {
      const zoomIn = s.idx % 2 === 0;
      const scale = zoomIn ? 1 + 0.09 * p : 1.09 - 0.09 * p;
      const px = (s.idx % 4 < 2 ? -1 : 1) * (p - 0.5) * 0.3;
      drawCoverM(g, media, W, H, scale, px, 0);
    }
    if (!doodle) {
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

// shots: [{idx, start, duration, imgEl?, vidEl?, narration, overlay, section}] with precomputed timing.
// audioSegs: [{pcm, rate, start}] — section-level voiceover segments.
// music: optional {buffer: AudioBuffer, volume: 0..1} — looped under the voiceover, faded out at the end.
export function renderVideo({ shots, audioSegs = [], total, music = null, style = "cinematic", width = 1280, height = 720, fps = 30, subtitles = true, onProgress }) {
  return new Promise(async (resolve, reject) => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const g = canvas.getContext("2d");
      const timeline = shots.map((s, idx) => ({ ...s, idx, words: (s.narration || "").split(/\s+/).filter(Boolean) }));
      total = (total || (timeline.length ? timeline[timeline.length - 1].start + timeline[timeline.length - 1].duration : 0)) + 0.4;
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
      // schedule section audio
      const lead = 0.25;
      const t0 = audioCtx.currentTime + lead;
      // background music: looped, ducked under the voiceover, 2s fade-out at the end
      if (music?.buffer) {
        const mSrc = audioCtx.createBufferSource();
        mSrc.buffer = music.buffer; mSrc.loop = true;
        const gain = audioCtx.createGain();
        const vol = music.volume ?? 0.12;
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(vol, t0 + 1);
        gain.gain.setValueAtTime(vol, t0 + Math.max(1, total - 2));
        gain.gain.linearRampToValueAtTime(0, t0 + total);
        mSrc.connect(gain); gain.connect(dest);
        mSrc.start(t0); mSrc.stop(t0 + total);
      }
      for (const seg of audioSegs) {
        if (!seg.pcm?.length) continue;
        const buf = audioCtx.createBuffer(1, seg.pcm.length, seg.rate);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < seg.pcm.length; i++) ch[i] = seg.pcm[i] / 32768;
        const src = audioCtx.createBufferSource();
        src.buffer = buf; src.connect(dest); src.start(t0 + seg.start);
      }
      rec.start(500);
      const startClock = performance.now() + lead * 1000;
      let stopped = false, playingIdx = -1;
      const loop = () => {
        if (stopped) return;
        const now = (performance.now() - startClock) / 1000;
        const cur = paintFrame(g, timeline, now, width, height, style, subtitles);
        if (cur && cur.vidEl && playingIdx !== cur.idx) {
          if (playingIdx >= 0 && timeline[playingIdx]?.vidEl) timeline[playingIdx].vidEl.pause();
          try { cur.vidEl.currentTime = 0; cur.vidEl.play().catch(() => {}); } catch {}
          playingIdx = cur.idx;
        }
        if (onProgress) onProgress(Math.min(1, Math.max(0, now / total)));
        if (now >= total) { stopped = true; timeline.forEach(s => s.vidEl && s.vidEl.pause()); setTimeout(() => rec.stop(), 300); return; }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    } catch (e) { reject(e); }
  });
}

// ---------- WebCodecs fast renderer: frame-accurate, faster than realtime, background-safe ----------
export async function canRenderFast(width, height) {
  if (!("VideoEncoder" in window) || !("AudioEncoder" in window)) return null;
  const codecs = ["avc1.640028", "avc1.4d0028", "avc1.42002a", "avc1.42001f"];
  for (const codec of codecs) {
    try {
      const v = await VideoEncoder.isConfigSupported({ codec, width, height, framerate: 30 });
      if (!v.supported) continue;
      const a = await AudioEncoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
      if (a.supported) return codec;
    } catch {}
  }
  return null;
}

function seekVideo(v, t) {
  return new Promise(res => {
    const target = v.duration ? t % v.duration : 0;
    if (Math.abs(v.currentTime - target) < 0.001) return res();
    const done = () => { v.removeEventListener("seeked", done); res(); };
    v.addEventListener("seeked", done);
    v.currentTime = target;
    setTimeout(done, 500); // seek watchdog
  });
}

export async function renderVideoFast({ shots, audioSegs = [], total, music = null, style = "cinematic", width = 1280, height = 720, fps = 30, subtitles = true, onProgress, isCancelled }) {
  const { Muxer, ArrayBufferTarget } = await import("mp4-muxer");
  const codec = await canRenderFast(width, height);
  if (!codec) throw new Error("WebCodecs H.264/AAC not supported in this browser");
  const timeline = shots.map((s, idx) => ({ ...s, idx, words: (s.narration || "").split(/\s+/).filter(Boolean) }));
  total = (total || (timeline.length ? timeline[timeline.length - 1].start + timeline[timeline.length - 1].duration : 0)) + 0.4;

  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const g = canvas.getContext("2d");

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width, height },
    audio: { codec: "aac", numberOfChannels: 2, sampleRate: 48000 },
    fastStart: "in-memory",
  });
  let encErr = null;
  const vEnc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => { encErr = e; } });
  vEnc.configure({ codec, width, height, framerate: fps, bitrate: width >= 1080 && height >= 1080 ? 12_000_000 : height > width ? 8_000_000 : width >= 1920 ? 12_000_000 : 7_000_000 });
  const aEnc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => { encErr = e; } });
  aEnc.configure({ codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });

  // audio first (fast)
  const mix = await buildAudioMix({ audioSegs, music, total, sampleRate: 48000 });
  const chunkFrames = 48000; // 1s per AudioData
  const ch0 = mix.getChannelData(0), ch1 = mix.numberOfChannels > 1 ? mix.getChannelData(1) : ch0;
  for (let off = 0; off < mix.length; off += chunkFrames) {
    const n = Math.min(chunkFrames, mix.length - off);
    const data = new Float32Array(n * 2);
    data.set(ch0.subarray(off, off + n), 0);
    data.set(ch1.subarray(off, off + n), n);
    aEnc.encode(new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(off / 48000 * 1e6), data }));
  }

  // video frames
  const totalFrames = Math.ceil(total * fps);
  for (let f = 0; f < totalFrames; f++) {
    if (isCancelled?.()) { try { vEnc.close(); aEnc.close(); } catch {} throw new Error("Render cancelled"); }
    if (encErr) throw encErr;
    const now = f / fps;
    const cur = now < 0 ? timeline[0] : (timeline.filter(s => now >= s.start).pop() || timeline[timeline.length - 1]);
    if (cur?.vidEl) await seekVideo(cur.vidEl, now - cur.start);
    paintFrame(g, timeline, now, width, height, style, subtitles);
    const frame = new VideoFrame(canvas, { timestamp: Math.round(now * 1e6), duration: Math.round(1e6 / fps) });
    vEnc.encode(frame, { keyFrame: f % (fps * 5) === 0 });
    frame.close();
    while (vEnc.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 5));
    if (onProgress && f % 3 === 0) { onProgress(f / totalFrames); await new Promise(r => setTimeout(r, 0)); }
  }
  await vEnc.flush(); await aEnc.flush();
  if (encErr) throw encErr;
  muxer.finalize();
  const { buffer } = muxer.target;
  return { blob: new Blob([buffer], { type: "video/mp4" }), ext: "mp4", duration: total };
}

// Split a script into chunks of at most `maxWords` words for chunked storyboarding,
// cutting on natural boundaries: paragraphs first, then sentences for oversized ones.
// Works on clean prose; any legacy [SECTION: X] markers are treated as paragraph breaks.
const wc = s => s.split(/\s+/).filter(Boolean).length;
export function chunkScript(script, maxWords = 1500) {
  const units = script
    .replace(/\[SECTION:[^\]]*\]/gi, "\n\n")
    .split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean);
  // Break any paragraph that alone exceeds maxWords down to sentence groups.
  const pieces = [];
  for (const u of units) {
    if (wc(u) <= maxWords) { pieces.push(u); continue; }
    const sentences = u.match(/[^.!?]+[.!?]+(?:["'”’)\]]*)?\s*|\S[^.!?]*$/g) || [u];
    let buf = "", n = 0;
    for (const s of sentences) {
      const w = wc(s);
      if (n && n + w > maxWords) { pieces.push(buf.trim()); buf = s; n = w; }
      else { buf += s; n += w; }
    }
    if (buf.trim()) pieces.push(buf.trim());
  }
  // Pack paragraph pieces into chunks of at most maxWords.
  const chunks = [];
  let buf = "", n = 0;
  for (const p of pieces.length ? pieces : [script]) {
    const w = wc(p);
    if (n && n + w > maxWords) { chunks.push(buf); buf = p; n = w; }
    else { buf += (buf ? "\n\n" : "") + p; n += w; }
  }
  if (buf.trim()) chunks.push(buf);
  return chunks;
}

export function loadVideoEl(blobUrl) {
  return new Promise((res, rej) => {
    const v = document.createElement("video");
    v.muted = true; v.loop = true; v.playsInline = true; v.preload = "auto";
    v.onloadeddata = () => res(v);
    v.onerror = () => rej(new Error("Video failed to load"));
    v.src = blobUrl;
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
