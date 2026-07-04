// Voice providers: Gemini TTS (native) + AI33 API (https://api.ai33.pro).
// AI33 auth: `xi-api-key` header. Generation is async: create returns task_id,
// poll GET /v1/task/{task_id} until status "done", then fetch metadata.audio_url.
// v3 voice_ids are provider-prefixed: elevenlabs_ / minimax_ / fishaudio_ / clone_ / edge_ / kokoro_ / vbee_.

export const AI33_DEFAULT_BASE = "https://api.ai33.pro";

// All 30 Gemini prebuilt TTS voices.
export const GEMINI_VOICES = [
  ["Zephyr", "Bright"], ["Puck", "Upbeat"], ["Charon", "Informative"], ["Kore", "Firm"],
  ["Fenrir", "Excitable"], ["Leda", "Youthful"], ["Orus", "Firm"], ["Aoede", "Breezy"],
  ["Callirrhoe", "Easy-going"], ["Autonoe", "Bright"], ["Enceladus", "Breathy"], ["Iapetus", "Clear"],
  ["Umbriel", "Easy-going"], ["Algieba", "Smooth"], ["Despina", "Smooth"], ["Erinome", "Clear"],
  ["Algenib", "Gravelly"], ["Rasalgethi", "Informative"], ["Laomedeia", "Upbeat"], ["Achernar", "Soft"],
  ["Alnilam", "Firm"], ["Schedar", "Even"], ["Gacrux", "Mature"], ["Pulcherrima", "Forward"],
  ["Achird", "Friendly"], ["Zubenelgenubi", "Casual"], ["Vindemiatrix", "Gentle"], ["Sadachbia", "Lively"],
  ["Sadaltager", "Knowledgeable"], ["Sulafat", "Warm"],
].map(([id, d]) => ({ provider: "gemini", id, name: id, desc: d }));

// ElevenLabs premade voices (ids pre-prefixed for AI33 v3). The live list replaces these when loaded.
export const ELEVENLABS_VOICES = [
  ["21m00Tcm4TlvDq8ikWAM", "Rachel", "Calm narration · F"], ["9BWtsMINqrJLrRacOk9x", "Aria", "Expressive · F"],
  ["CwhRBWXzGAHq8TQ4Fs17", "Roger", "Confident · M"], ["EXAVITQu4vr4xnSDxMaL", "Sarah", "Soft news · F"],
  ["FGY2WhTYpPnrIDTdsKH5", "Laura", "Upbeat · F"], ["IKne3meq5aSn9XLyUdCD", "Charlie", "Casual Aussie · M"],
  ["JBFqnCBsd6RMkjVDRZzb", "George", "Warm British · M"], ["N2lVS1w4EtoT3dr4eOWO", "Callum", "Intense · M"],
  ["TX3LPaxmHKxFdv7VOQHJ", "Liam", "Articulate · M"], ["XB0fDUnXU5powFXDhCwa", "Charlotte", "Seductive · F"],
  ["Xb7hH8MSUJpSbSDYk0k2", "Alice", "Confident British · F"], ["XrExE9yKIg1WjnnlVkGX", "Matilda", "Friendly · F"],
  ["bIHbv24MWmeRgasZH58o", "Will", "Chill · M"], ["cgSgspJ2msm6clMCkdW9", "Jessica", "Playful · F"],
  ["cjVigY5qzO86Huf0OWal", "Eric", "Classy · M"], ["iP95p4xoKVk53GoZ742B", "Chris", "Natural · M"],
  ["nPczCjzI2devNBz1zQrb", "Brian", "Deep narrator · M"], ["onwK4e9ZLuTAKqWW03F9", "Daniel", "Authoritative British · M"],
  ["pFZP5JQG7iQjIQuC4Bku", "Lily", "Velvety British · F"], ["pqHfZKP75CvOlQylNhV4", "Bill", "Documentary · M"],
  ["pNInz6obpgDQGcFmaJgB", "Adam", "Deep American · M"], ["ErXwobaYiN019PkySvjV", "Antoni", "Well-rounded · M"],
  ["TxGEqnHWrfWFTfGW9XjX", "Josh", "Deep young · M"], ["VR6AewLTigWkYGKgVCkK", "Arnold", "Crisp strong · M"],
  ["AZnzlk1XvdvUeBnXmlld", "Domi", "Strong · F"], ["MF3mGyEYCl7XYWbV9V6O", "Elli", "Emotional · F"],
  ["yoZ06aMxZJJ28mfd3POQ", "Sam", "Raspy · M"], ["ThT5KcBeYPX3keUQqHPh", "Dorothy", "Pleasant British · F"],
  ["D38z5RcWu1voky8WS1ja", "Fin", "Sailor · M"], ["GBv7mTt0atIp3Br8iCZE", "Thomas", "Meditation · M"],
].map(([id, name, desc]) => ({ provider: "elevenlabs", id: `elevenlabs_${id}`, name, desc }));

// MiniMax system voices (ids pre-prefixed for AI33 v3).
export const MINIMAX_VOICES = [
  "Wise_Woman", "Friendly_Person", "Inspirational_girl", "Deep_Voice_Man", "Calm_Woman", "Casual_Guy",
  "Lively_Girl", "Patient_Man", "Young_Knight", "Determined_Man", "Lovely_Girl", "Decent_Boy",
  "Imposing_Manner", "Elegant_Man", "Abbess", "Sweet_Girl_2", "Exuberant_Girl",
].map(id => ({ provider: "minimax", id: `minimax_${id}`, name: id.replace(/_/g, " "), desc: "MiniMax speech" }));

const hdrs = key => ({ "xi-api-key": key });
const base = b => (b || AI33_DEFAULT_BASE).replace(/\/$/, "");
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function jfetch(url, opts) {
  const r = await fetch(url, opts);
  let d = null;
  try { d = await r.json(); } catch {}
  if (!r.ok) throw new Error(d?.error_message || d?.message || d?.error || `AI33 HTTP ${r.status}`);
  return d;
}

// Poll GET /v1/task/{id} until done; returns the completed task's metadata.
export async function ai33PollTask(b, key, taskId, { intervalMs = 2500, timeoutMs = 300000, onProgress } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const d = await jfetch(`${base(b)}/v1/task/${taskId}`, { headers: { ...hdrs(key), "Content-Type": "application/json" } });
    if (d.status === "done") return d.metadata || {};
    if (d.status === "error" || d.status === "failed" || d.error_message) throw new Error(d.error_message || "AI33 task failed");
    if (onProgress && typeof d.progress === "number") onProgress(d.progress);
    await sleep(intervalMs);
  }
  throw new Error("AI33 task timed out");
}

// List voices for a provider (elevenlabs | minimax | fishaudio | clone | edge | kokoro | vbee).
// Returned voice_ids are already prefixed — use them directly in TTS.
export async function ai33ListVoices(b, key, provider, { search = "", page = 1, pageSize = 100 } = {}) {
  const params = new URLSearchParams({ provider, page: String(page), page_size: String(pageSize) });
  if (search) params.set("search", search);
  if (provider === "fishaudio" && !search) params.set("sort", "trending");
  const d = await jfetch(`${base(b)}/v3/voices?${params}`, { headers: hdrs(key) });
  const list = d.data || [];
  return list.map(v => ({
    provider,
    id: v.voice_id || v.id,
    name: v.name || v.voice_name || v.title || v.voice_id || v.id,
    desc: [v.gender, v.language || v.locale, v.age, v.accent, v.description || v.use_case].filter(Boolean).join(" · ") || provider,
    preview: v.preview_url || v.preview_audio_url || v.sample_url || v.audio_url || null,
  })).filter(v => v.id);
}

// v3 TTS: FormData create → task_id → poll → fetch audio. voiceId must be prefixed (e.g. elevenlabs_xxx, clone_xxx).
export async function ai33TTS(b, key, { voiceId, text, speed = 1, onProgress }) {
  const fd = new FormData();
  fd.append("text", text);
  fd.append("voice_id", voiceId);
  fd.append("speed", String(speed));
  const d = await jfetch(`${base(b)}/v3/text-to-speech`, { method: "POST", headers: hdrs(key), body: fd });
  if (!d?.success || !d?.task_id) throw new Error(d?.error_message || "AI33 TTS: no task_id returned");
  const meta = await ai33PollTask(b, key, d.task_id, { onProgress });
  const url = meta.audio_url || meta.url || meta.output_url;
  if (!url) throw new Error("AI33 TTS finished but no audio_url in task metadata");
  const ar = await fetch(url);
  if (!ar.ok) throw new Error(`AI33 audio fetch ${ar.status}`);
  return ar.arrayBuffer();
}

// Clone a voice: POST /v3/text-to-speech/voice-clone (voice_name + audio_file ≤10MB).
// Returns the prefixed id (clone_<voice_id>) ready for TTS.
export async function ai33Clone(b, key, { name, file }) {
  if (file.size > 10 * 1024 * 1024) throw new Error("Audio file too large — AI33 clone limit is 10MB");
  const fd = new FormData();
  fd.append("voice_name", name);
  fd.append("audio_file", file);
  const d = await jfetch(`${base(b)}/v3/text-to-speech/voice-clone`, { method: "POST", headers: hdrs(key), body: fd });
  const vid = d?.data?.voice_id || d?.voice_id;
  if (!vid) throw new Error(d?.error_message || "AI33 clone: no voice_id returned");
  return { id: String(vid).startsWith("clone_") ? String(vid) : `clone_${vid}`, name };
}

export async function ai33DeleteClone(b, key, voiceId) {
  const raw = String(voiceId).replace(/^clone_/, "");
  await jfetch(`${base(b)}/v3/text-to-speech/voice-clone/${raw}`, { method: "DELETE", headers: hdrs(key) });
  return true;
}

export async function ai33Credits(b, key) {
  const d = await jfetch(`${base(b)}/v1/credits`, { headers: { ...hdrs(key), "Content-Type": "application/json" } });
  return d?.credits ?? d?.data?.credits ?? d;
}

// Decode any compressed audio (mp3/wav/ogg) to mono 24kHz Int16 PCM so it slots into the pipeline.
export async function decodeToPcm24k(arrayBuffer) {
  const probe = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await probe.decodeAudioData(arrayBuffer.slice(0));
  probe.close().catch(() => {});
  const rate = 24000;
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const src = off.createBufferSource();
  src.buffer = decoded; src.connect(off.destination); src.start();
  const out = await off.startRendering();
  const f32 = out.getChannelData(0);
  const pcm = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
  return { pcm, rate };
}
