// Voice providers: Gemini TTS (native) + ai33.pro gateway (ElevenLabs / MiniMax / Fish Audio + cloning).
// ai33.pro has no published API docs, so this client is tolerant: the base URL is user-configurable
// in Settings and responses are parsed loosely (raw audio, {audio_url}, {url}, {audio: base64}, {data}).

export const AI33_DEFAULT_BASE = "https://ai33.pro/api";

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

// ElevenLabs premade voice library (standard voice IDs) — shown even before ai33 connects.
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
].map(([id, name, desc]) => ({ provider: "elevenlabs", id, name, desc }));

// MiniMax speech-02 system voices.
export const MINIMAX_VOICES = [
  "Wise_Woman", "Friendly_Person", "Inspirational_girl", "Deep_Voice_Man", "Calm_Woman", "Casual_Guy",
  "Lively_Girl", "Patient_Man", "Young_Knight", "Determined_Man", "Lovely_Girl", "Decent_Boy",
  "Imposing_Manner", "Elegant_Man", "Abbess", "Sweet_Girl_2", "Exuberant_Girl",
].map(id => ({ provider: "minimax", id, name: id.replace(/_/g, " "), desc: "MiniMax speech-02" }));

const HDRS = key => ({ Authorization: `Bearer ${key}`, "x-api-key": key });

async function tryJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

// List voices from ai33 for a provider; merges with static catalog. Tries a few common shapes.
export async function ai33ListVoices(base, key, provider) {
  const b = (base || AI33_DEFAULT_BASE).replace(/\/$/, "");
  const paths = [`/v1/voices?provider=${provider}`, `/voices?provider=${provider}`, `/tts/voices?provider=${provider}`];
  for (const p of paths) {
    try {
      const d = await tryJson(b + p, { headers: HDRS(key) });
      const list = d.voices || d.data || (Array.isArray(d) ? d : []);
      if (list.length) return list.map(v => ({ provider, id: v.voice_id || v.id || v.model_id || v._id, name: v.name || v.title || v.voice_id || v.id, desc: v.description || v.labels?.description || v.category || provider }));
    } catch {}
  }
  throw new Error(`Could not load ${provider} voices from ai33.pro — check the API key/base URL in Settings`);
}

// TTS through ai33 for elevenlabs / minimax / fish / cloned voices. Returns raw audio ArrayBuffer.
export async function ai33TTS(base, key, { provider, voiceId, text }) {
  const b = (base || AI33_DEFAULT_BASE).replace(/\/$/, "");
  const bodies = [
    { path: "/v1/tts", body: { provider, voice_id: voiceId, text } },
    { path: "/tts", body: { provider, voice_id: voiceId, text } },
    { path: "/v1/text-to-speech", body: { provider, voice: voiceId, input: text } },
  ];
  let lastErr = "ai33 TTS failed";
  for (const { path, body } of bodies) {
    try {
      const r = await fetch(b + path, { method: "POST", headers: { ...HDRS(key), "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { lastErr = `ai33 ${r.status} on ${path}`; continue; }
      const ct = r.headers.get("content-type") || "";
      if (ct.includes("audio") || ct.includes("octet-stream")) return r.arrayBuffer();
      const d = await r.json();
      const url = d.audio_url || d.url || d.data?.audio_url || d.data?.url;
      if (url) { const ar = await fetch(url); if (ar.ok) return ar.arrayBuffer(); lastErr = `audio fetch ${ar.status}`; continue; }
      const b64 = d.audio || d.audio_base64 || d.data?.audio;
      if (b64 && typeof b64 === "string") {
        const bin = atob(b64.replace(/^data:audio\/\w+;base64,/, ""));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
      }
      lastErr = "Unrecognized ai33 TTS response shape";
    } catch (e) { lastErr = e.message; }
  }
  throw new Error(lastErr);
}

// Upload a voice sample to ai33 and create a clone. Returns {id, name}.
export async function ai33Clone(base, key, { name, file }) {
  const b = (base || AI33_DEFAULT_BASE).replace(/\/$/, "");
  const paths = ["/v1/voice-clone", "/voice-clone", "/v1/voices/clone"];
  let lastErr = "ai33 voice clone failed";
  for (const p of paths) {
    try {
      const fd = new FormData();
      fd.append("name", name);
      fd.append("file", file);
      fd.append("audio", file);
      const r = await fetch(b + p, { method: "POST", headers: HDRS(key), body: fd });
      if (!r.ok) { lastErr = `ai33 ${r.status} on ${p}`; continue; }
      const d = await r.json();
      const id = d.voice_id || d.id || d.data?.voice_id || d.data?.id;
      if (id) return { id, name: d.name || name };
      lastErr = "Clone created but no voice id in response";
    } catch (e) { lastErr = e.message; }
  }
  throw new Error(lastErr);
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
