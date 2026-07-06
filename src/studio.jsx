import { useState, useEffect, useRef } from "react";
import {
  claude, parseJson, SYS_BRIEF, SYS_SCRIPT, SYS_SEO, STYLE_WRAP,
  geminiTTS, groqTranscribe, concatPcm, pcmToWav, pcmToMp3,
  coverrVideos, pixabayVideos, pixabayPhotos, pexelsVideos, pexelsPhotos, sourceRealAsset, urlToDataURL,
  makeZip, fmtTime, estDuration, renderVideo, renderVideoFast, canRenderFast, loadImage, loadVideoEl, pickMime,
} from "./pipeline";
import { gathosImage, gathosVideo, GATHOS_STYLE } from "./gathos";
import { GEMINI_VOICES, ELEVENLABS_VOICES, MINIMAX_VOICES, ai33ListVoices, ai33TTS, ai33Clone, ai33DeleteClone, ai33Suno, decodeAudioBuffer, decodeToPcm24k, AI33_DEFAULT_BASE } from "./ai33";
import { SeoView } from "./seoview";
import { usePopIn } from "./anim";
import { idbSet, idbGet, idbDel, idbDelPrefix } from "./store";
import ThumbLab from "./thumblab";
import { recordEvent, lessonsNote, reflect } from "./memory";
import { cloudGet as ls, cloudSet as ss } from "./cloud.js";

const STEPS = ["Script", "Storyboard", "Visuals", "Voiceover", "Render", "Thumbnail", "SEO Package"];

// Normalize an AI-written script to clean spoken narration: strip any stray
// section tags, markdown headings/bold, label-only lines and bullet markers,
// and collapse runs of blank lines. Only touches formatting cruft, never prose.
const cleanScript = (raw) => (raw || "")
  .replace(/\[SECTION:[^\]]*\]/gi, "")                       // [SECTION: ...] tags
  .replace(/^\s{0,3}#{1,6}\s+/gm, "")                        // # markdown heading marks
  .replace(/^\s*\[[^\]\n]{0,48}\]\s*$/gm, "")                // [Hook] / [Intro] label-only lines
  .replace(/^\s*(?:\*\*|__)[^*_\n]{0,48}(?:\*\*|__)\s*:?\s*$/gm, "") // **Hook** / __Intro:__ label-only lines
  .replace(/^\s*(?:hook|intro|introduction|outro|conclusion|cta|call to action|section\s*\d*|part\s*\d*)\s*:\s*$/gim, "") // bare "Hook:" label lines
  .replace(/\*\*(.+?)\*\*/g, "$1")                           // inline **bold** → plain
  .replace(/^\s*[-*•]\s+/gm, "")                             // bullet markers
  .replace(/\n{3,}/g, "\n\n")                                // collapse excess blank lines
  .trim();
const STYLES = [
  { id: "cinematic", n: "Cinematic AI", d: "Photoreal AI frames, Ken Burns, fast cuts" },
  { id: "realasset", n: "Real Assets", d: "Coverr + Pixabay clips/photos, Pexels fallback" },
  { id: "doodle", n: "Stickman Doodle", d: "Hand-drawn frames, hard cuts, no zoom" },
];

// Length presets → the word target aims at the MIDDLE of each labeled range
// (not the top), so "10–12 min" lands ~11 min, not 12. Values match the <select>.
const DUR_META = {
  "0.7": { label: "about 40 seconds", words: 100 },
  "1":   { label: "about 1 minute", words: 150 },
  "3":   { label: "about 3 minutes", words: 420 },
  "5":   { label: "about 5 minutes", words: 700 },
  "8":   { label: "6–8 minutes", words: 980 },    // midpoint ~7 min
  "12":  { label: "10–12 minutes", words: 1540 }, // midpoint ~11 min
  "15":  { label: "13–15 minutes", words: 1960 }, // midpoint ~14 min
};
const durMeta = (d) => DUR_META[d] || { label: `about ${d} minutes`, words: Math.round(+d * 140) };

const wcount = (t) => t.split(/\s+/).filter(Boolean).length;
// Instant, deterministic split of a clean script into 3-5s shots (~8-14 words each),
// cutting at sentence then clause boundaries. Paragraphs become section groups.
// Runs in <1ms so the storyboard appears immediately; visuals are enriched after.
function fastSplitShots(script) {
  const paras = (script || "").split(/\n\s*\n+/).map(s => s.trim()).filter(Boolean);
  const shots = [];
  paras.forEach((para, pi) => {
    const section = `Part ${pi + 1}`;
    const clauses = para
      .split(/(?<=[.!?])\s+/)                                  // sentences
      .flatMap(s => wcount(s) > 14 ? s.split(/(?<=[,;:—])\s+/) : [s]) // long ones → clauses
      .map(s => s.trim()).filter(Boolean);
    let buf = "";
    const push = () => { if (buf.trim()) { shots.push({ narration: buf.trim(), section }); buf = ""; } };
    for (const cl of clauses) {
      if (wcount(cl) > 14) {                                   // still huge → hard-cut ~12 words
        push();
        const w = cl.split(/\s+/);
        for (let i = 0; i < w.length; i += 12) shots.push({ narration: w.slice(i, i + 12).join(" "), section });
        continue;
      }
      const cand = buf ? buf + " " + cl : cl;
      if (wcount(cand) <= 14) buf = cand; else { push(); buf = cl; }
      if (wcount(buf) >= 10) push();                           // aim ~10-14 words per shot
    }
    push();
  });
  return shots.length ? shots : [{ narration: (script || "").trim().slice(0, 120), section: "Part 1" }];
}

// Visual-only director prompt: given numbered narration lines, return one concrete
// frame per line IN ORDER. Small + fast, so batches stream back in near real time.
const SYS_VISUALS = `You are a storyboard visual director for fast-cut faceless YouTube videos.
For each numbered narration line you receive, imagine ONE concrete shot that illustrates that beat.
Return ONLY a JSON array with exactly one object per line, IN THE SAME ORDER, no markdown:
[{"visual":"30-50 word prompt describing ONE concrete frame: subject, setting, composition, lighting, mood. Visual keywords only, no text in image","broll":["2-4 word stock-footage query","alternative query"],"overlay":"optional on-screen text, max 4 words, or empty string","sourceType":"real or ai"}]`;

export default function Studio({ niche, ctx, clKey, gemKey, gathosKey, gathosVidKey, groqKey, pexKey, pixKey, covKey, ai33Key, ai33Base, back, addH, updateH }) {
  const vidKey = gathosVidKey || gathosKey; // legacy img_live_* keys also work for video
  const storeKey = `vr7-studio-${niche.id}-${ctx.histId || ctx.topic}`;
  const mk = k => `${storeKey}:${k}`;
  const [step, setStep] = useState(0);
  const [style, setStyle] = useState("cinematic");
  const [format, setFormat] = useState("16:9"); // 16:9 long-form | 9:16 Shorts
  const [dur, setDur] = useState("5");
  const [voiceSel, setVoiceSel] = useState(() => ls("vr7-voice", { provider: "gemini", id: "Charon", name: "Charon" }));
  const [voiceModal, setVoiceModal] = useState(false);
  const [brief, setBrief] = useState(ctx.prompt || "");
  const [briefOpen, setBriefOpen] = useState(false);
  const [script, setScript] = useState("");
  const [scenes, setScenes] = useState([]); // {section,narration,visual,broll,overlay,img,video:{blobUrl,thumb},credit,imgErr,imgLoading}
  const [audioSegs, setAudioSegs] = useState([]); // parallel to sections: {pcm,rate,words,loading,err}
  const [busy, setBusy] = useState("");
  const [st, setSt] = useState("");
  const [auto, setAuto] = useState(false);
  const [res, setRes] = useState("720");
  const [subs, setSubs] = useState(true);
  const [fastOk, setFastOk] = useState(null);
  const [renderProg, setRenderProg] = useState(-1);
  const [video, setVideo] = useState(null);
  const [seo, setSeo] = useState(null);
  const [srcPick, setSrcPick] = useState(null);
  const [music, setMusic] = useState(null); // {name, buffer: AudioBuffer, url, ab}
  const [musicVol, setMusicVol] = useState(0.12);
  const [musicPrompt, setMusicPrompt] = useState("");
  const [musicProg, setMusicProg] = useState(-1);
  const [thumbState, setThumbState] = useState({});
  const [tplId, setTplId] = useState(null);
  const templates = ls("vr8-templates", []);
  const tpl = templates.find(t => t.id === tplId) || null;
  const focusRef = useRef("");
  const panelRef = usePopIn([step]);
  const cancelRef = useRef(false);
  const boardGenRef = useRef(0); // bumped each storyboard build so stale enrichment is ignored
  const vertical = format === "9:16";
  const assetKeys = { coverr: covKey, pixabay: pixKey, pexels: pexKey };

  // hydrate: text from localStorage, heavy media from IndexedDB
  useEffect(() => {
    let live = true;
    (async () => {
      const saved = ls(storeKey, null);
      let baseScenes = [];
      if (saved) {
        if (!live) return;
        setScript(saved.script || ""); setStyle(saved.style || "cinematic"); setDur(saved.dur || "5");
        setFormat(saved.format || "16:9"); setSeo(saved.seo || null);
        if (saved.tplId) setTplId(saved.tplId);
        if (saved.brief) setBrief(saved.brief);
        if (saved.thumbState) setThumbState(t => ({ ...saved.thumbState, ...t }));
        baseScenes = (saved.scenes || []).map(s => ({ ...s, img: null, video: null }));
      }
      if (baseScenes.length) {
        const hydrated = await Promise.all(baseScenes.map(async (s, i) => {
          const img = await idbGet(mk(`img:${i}`));
          const vid = await idbGet(mk(`vid:${i}`));
          return { ...s, img: img || null, video: vid?.blob ? { blobUrl: URL.createObjectURL(vid.blob), thumb: vid.thumb } : null, credit: s.credit || vid?.credit || null };
        }));
        if (!live) return;
        setScenes(hydrated);
        const segs = [];
        for (let si = 0; ; si++) {
          const seg = await idbGet(mk(`seg:${si}`));
          if (!seg) break;
          segs[si] = { pcm: seg.pcm, rate: seg.rate, words: seg.words || null };
        }
        if (segs.length && live) setAudioSegs(segs);
      }
      const m = await idbGet(mk("music"));
      if (m?.ab && live) {
        try {
          const buffer = await decodeAudioBuffer(m.ab.slice(0));
          setMusic({ name: m.name, buffer, url: URL.createObjectURL(new Blob([m.ab], { type: "audio/mpeg" })), ab: m.ab });
        } catch {}
      }
      const v = await idbGet(mk("video"));
      if (v?.blob && live) setVideo({ url: URL.createObjectURL(v.blob), ext: v.ext, duration: v.duration, size: v.blob.size });
      const th = await idbGet(mk("thumbs"));
      if (th && live) setThumbState(t => ({ ...t, thumbs: th }));
      canRenderFast(1280, 720).then(c => live && setFastOk(!!c));
    })();
    return () => { live = false; };
  }, []);

  const persist = (patch = {}) => {
    const strip = arr => arr.map(({ img, video, imgErr, imgLoading, ...rest }) => rest);
    const { thumbs, ...thumbLite } = thumbState;
    const cur = { script, style, dur, format, seo, brief, tplId, thumbState: thumbLite, scenes: strip(scenes), ...patch };
    if (patch.scenes) cur.scenes = strip(patch.scenes);
    ss(storeKey, cur);
  };
  const clearSegsIdb = () => { for (let si = 0; si < 40; si++) idbDel(mk(`seg:${si}`)); };
  const pickVoice = v => { setVoiceSel(v); ss("vr7-voice", v); setVoiceModal(false); setAudioSegs([]); clearSegsIdb(); recordEvent(niche.id, "voice_selected", { voice: v.name, provider: v.provider }); };

  // Sections = consecutive scenes sharing a section name; voiced per section for prosody,
  // then timing distributed across the 3-5s shots (word timestamps when the provider returns them).
  const computeSections = (list) => {
    const secs = [];
    list.forEach((s, i) => {
      const last = secs[secs.length - 1];
      if (last && last.name === (s.section || last.name)) last.idxs.push(i);
      else secs.push({ name: s.section || `Part ${secs.length + 1}`, idxs: [i] });
    });
    return secs;
  };
  const sections = computeSections(scenes);
  const sectionOfScene = i => sections.findIndex(sec => sec.idxs.includes(i));
  const setSeg = (si, val) => setAudioSegs(prev => { const n = [...prev]; n[si] = val; return n; });
  const setScene = (i, patch) => {
    setScenes(prev => prev.map((s, j) => j === i ? { ...s, ...patch } : s));
    if ("narration" in patch) { const si = sectionOfScene(i); if (si >= 0) { setSeg(si, null); idbDel(mk(`seg:${si}`)); } }
    if ("img" in patch && !patch.img) idbDel(mk(`img:${i}`));
  };

  const buildTimeline = (sceneList, segList) => {
    const list = sceneList || scenes;
    const segsArr = segList || audioSegs;
    let t = 0; const shots = []; const segsOut = [];
    computeSections(list).forEach((sec, si) => {
      const seg = segsArr[si];
      const inScenes = sec.idxs.map(i => ({ ...list[i], sceneIdx: i }));
      const wcs = inScenes.map(s => Math.max(1, (s.narration || "").split(/\s+/).filter(Boolean).length));
      const totW = wcs.reduce((a, b) => a + b, 0);
      const segDur = seg?.pcm ? seg.pcm.length / seg.rate : inScenes.reduce((x, s) => x + estDuration(s.narration), 0);
      const secStart = t;
      if (seg?.pcm) segsOut.push({ pcm: seg.pcm, rate: seg.rate, start: t });
      // Whisper's word count can differ slightly from the narration text — slice proportionally.
      let cumBefore = 0;
      inScenes.forEach((s, k) => {
        const d = segDur * wcs[k] / totW;
        let wordTimes = null;
        if (seg?.words?.length) {
          const W = seg.words.length;
          const a = Math.round(W * cumBefore / totW);
          const b = Math.round(W * (cumBefore + wcs[k]) / totW);
          const slice = seg.words.slice(a, Math.max(b, a + 1));
          if (slice.length) wordTimes = slice.map(w => ({ start: secStart + w.start, end: secStart + w.end }));
        }
        cumBefore += wcs[k];
        shots.push({ ...s, section: sec.name, start: t, duration: d, wordTimes });
        t += d;
      });
      t += 0.25;
    });
    return { shots, audioSegs: segsOut, total: t };
  };
  const totalRuntime = () => buildTimeline().total;

  // Structure template (from "Learn from a video") + learned preferences
  const tplScriptNote = () => tpl ? `\n\nSTRUCTURE TEMPLATE — replicate this proven video structure exactly:\n${JSON.stringify({ summary: tpl.dna.summary, hook: tpl.dna.hook, phases: tpl.dna.phases, narration: tpl.dna.narration, rules: tpl.dna.replicationRules })}` : "";
  const tplBoardNote = () => tpl ? `\nSTRUCTURE TEMPLATE — the storyboard must follow this analyzed video structure:\n- Target average shot length: ${tpl.dna.pacing?.avgShotSeconds || tpl.avgShot?.toFixed(1)}s (${tpl.dna.pacing?.notes || ""})\n- Phases in order (map onto the script proportionally): ${JSON.stringify(tpl.dna.phases)}\n- Rules: ${(tpl.dna.replicationRules || []).join(" | ")}\nFor EVERY shot add a "sourceType" field: "real" when the current phase calls for real/archival/documentary footage of the actual subject, otherwise "ai".` : "";

  // ---- Creative brief (research-driven; versions avoid repeating used items) ----
  const getUsedItems = () => (niche.history || []).filter(h => h.topic.toLowerCase() === ctx.topic.toLowerCase() && h.usedItems?.length).flatMap(h => h.usedItems);
  const genBrief = async () => {
    if (!clKey) { setSt("⚠ Set Anthropic API key in Settings"); return; }
    setBusy("brief"); setSt("Writing creative brief...");
    let extra = "";
    const usedItems = getUsedItems();
    const version = ctx.version || 1;
    if (version > 1) extra = `\n\nIMPORTANT: This is VERSION ${version} of this topic. You MUST use COMPLETELY DIFFERENT specific items, examples, facts, and angles. Find obscure, lesser-known, surprising entries. Do NOT repeat the obvious choices.`;
    if (usedItems.length) extra += `\n\nALREADY USED IN PREVIOUS VERSIONS — DO NOT REPEAT ANY OF THESE:\n${usedItems.join(", ")}\n\nYou MUST pick DIFFERENT items that are NOT in this list.`;
    try {
      const r = await claude(SYS_BRIEF, `Topic: ${ctx.topic}\nNiche: ${niche.name}\nDuration: ${durMeta(dur).label}\n\nSTRICT LIMIT: Stay under 9,000 characters. Detailed but concise.${extra}${lessonsNote(niche.id)}`, clKey);
      setBrief(r); setBriefOpen(true); persist({ brief: r });
      let hid = ctx.histId;
      if (!hid && addH) { hid = addH(niche.id, ctx.topic, version, r, ""); ctx.histId = hid; }
      else if (hid && updateH) updateH(niche.id, hid, { prompt: r });
      claude(`Extract the main items/subjects/entries from this brief. Return ONLY a JSON array of short names, e.g. ["Aloe Vera","Lavender"].`, r, clKey)
        .then(raw => { try { const items = parseJson(raw); if (items.length && hid && updateH) updateH(niche.id, hid, { usedItems: items }); } catch {} })
        .catch(() => {});
      setSt("✅ Brief ready — it now guides the script");
    } catch (e) { setSt("⚠ " + e.message); }
    setBusy("");
  };

  // ---- Stage 1: Script ----
  const genScript = async () => {
    if (!clKey) { setSt("⚠ Set Anthropic API key in Settings"); return ""; }
    setBusy("script"); setSt("Writing full narration script...");
    try {
      const { label: durLabel, words } = durMeta(dur);
      const guide = brief ? `\n\nUse this creative brief (built from competitor research) as your guide for angle, facts and structure:\n${brief.slice(0, 6000)}` : "";
      const fmtNote = vertical ? "\nFORMAT: This is a vertical YouTube Short — punchy, no slow build, hook in the first 2 seconds." : "";
      const r = await claude(SYS_SCRIPT, `Topic: ${ctx.topic}\nNiche: ${niche.name}${niche.desc ? ` — ${niche.desc}` : ""}\nTarget length: ${durLabel} → aim for ≈${words} words, landing comfortably in the MIDDLE of that range. Do NOT exceed the upper bound.${fmtNote}${guide}${tplScriptNote()}${lessonsNote(niche.id)}`, clKey, { maxTokens: 16000 });
      const clean = cleanScript(r);
      setScript(clean); persist({ script: clean });
      recordEvent(niche.id, "script_generated", { topic: ctx.topic, words: clean.split(/\s+/).length, template: tpl?.name || null, format });
      setSt(`✅ Script ready (${clean.split(/\s+/).length} words ≈ ${fmtTime(clean.split(/\s+/).length / 2.6)})`);
      setBusy(""); return clean;
    } catch (e) { setSt("⚠ " + e.message); setBusy(""); return ""; }
  };

  // ---- Stage 2: Storyboard ----
  // Split instantly (deterministic, <1ms) so shots appear right away, then enrich the
  // visual prompts with AI in small batches that stream back into the scenes.
  const genStoryboard = async (scriptText) => {
    const src = scriptText || script;
    if (!src) { setSt("⚠ Generate the script first"); return []; }
    const gen = ++boardGenRef.current;
    cancelRef.current = false;
    const defType = style === "realasset" ? "real" : "ai";
    const base = fastSplitShots(src).map(s => ({
      section: s.section, narration: s.narration, visual: s.narration, broll: [], overlay: "",
      sourceType: defType, img: null, video: null, credit: null,
    }));
    setScenes(base); setAudioSegs([]); persist({ scenes: base });
    idbDelPrefix(mk("img:")); idbDelPrefix(mk("vid:")); clearSegsIdb(); idbDel(mk("video"));
    recordEvent(niche.id, "storyboard_built", { shots: base.length, template: tpl?.name || null });
    setSt(`✂ Split into ${base.length} shots · est. ${fmtTime(base.reduce((t, s) => t + estDuration(s.narration), 0))} — enriching visuals…`);
    // Enrich in the background: batches stream richer prompts into the scenes as they land.
    // Await it so callers that chain (Autopilot) receive the fully-enriched shots; the UI
    // buttons don't await, so they still show the split instantly.
    return await enrichVisuals(base, gen);
  };

  // Fill each shot's visual/broll/overlay via AI, batched and streamed into the scenes.
  // Returns the fully-enriched array (defaults kept for any batch that fails).
  const enrichVisuals = async (shots, gen) => {
    const fmtNote = vertical ? "\nFORMAT: vertical 9:16 Shorts — every visual prompt must describe a VERTICAL frame (portrait composition, subject centered)." : "";
    const result = shots.map(s => ({ ...s }));
    const B = 10;
    const batches = [];
    for (let i = 0; i < shots.length; i += B) batches.push([i, shots.slice(i, i + B)]);
    let done = 0;
    setBusy("storyboard");
    const runBatch = async ([offset, group]) => {
      const numbered = group.map((s, j) => `${j + 1}. ${s.narration}`).join("\n");
      try {
        const raw = await claude(SYS_VISUALS, `NICHE: ${niche.name}\nVISUAL STYLE: ${style}${fmtNote}${tplBoardNote()}\n\nNARRATION LINES:\n${numbered}`, clKey, { maxTokens: 4000 });
        const vis = parseJson(raw);
        group.forEach((_, j) => {
          const v = vis[j]; const idx = offset + j;
          if (v && result[idx]) result[idx] = { ...result[idx], visual: v.visual || result[idx].visual, broll: v.broll || [], overlay: v.overlay || "", sourceType: v.sourceType === "real" ? "real" : (style === "realasset" ? "real" : "ai") };
        });
        if (boardGenRef.current !== gen) return; // a newer build started — drop stale UI updates
        setScenes(prev => {
          const n = [...prev];
          group.forEach((_, j) => { const idx = offset + j; if (n[idx] && result[idx]) n[idx] = result[idx]; });
          persist({ scenes: n });
          return n;
        });
      } catch { /* keep the instant narration-based defaults for this batch */ }
      done += group.length;
      if (boardGenRef.current === gen) setSt(`Enriching visuals… ${Math.min(done, shots.length)}/${shots.length} shots`);
    };
    // up to 3 batches in flight at once — fast without hammering rate limits
    for (let i = 0; i < batches.length; i += 3) {
      if (cancelRef.current || boardGenRef.current !== gen) break;
      await Promise.all(batches.slice(i, i + 3).map(runBatch));
    }
    if (boardGenRef.current === gen) {
      setBusy("");
      setSt(`✅ ${shots.length} shots ready · est. runtime ${fmtTime(shots.reduce((t, s) => t + estDuration(s.narration), 0))}`);
    }
    return result;
  };

  // ---- Stage 3: Visuals (Gathos) ----
  const genImage = async (i, list) => {
    const s = (list || scenes)[i];
    if (!gathosKey) { setScene(i, { imgErr: "No Gathos key" }); return; }
    setScene(i, { imgErr: null, imgLoading: true });
    try {
      const url = await gathosImage(STYLE_WRAP[style](s.visual), gathosKey, { aspect: format });
      setScene(i, { img: url, video: null, imgLoading: false, credit: null });
      idbSet(mk(`img:${i}`), url); idbDel(mk(`vid:${i}`));
    } catch (e) { setScene(i, { imgErr: e.message, imgLoading: false }); }
  };
  // AI-generated video clip for one shot: animates the existing frame (ti2av) or goes text-to-video.
  const genClip = async (i, list) => {
    const s = (list || scenes)[i];
    if (!vidKey) { setScene(i, { imgErr: "No Gathos video key" }); return; }
    setScene(i, { imgErr: null, imgLoading: true });
    try {
      const dur = Math.max(3, Math.min(8, estDuration(s.narration)));
      const prompt = s.img
        ? `Animate this frame with subtle natural motion and a slow cinematic camera move: ${s.visual}`
        : `${STYLE_WRAP[style](s.visual)} Slow cinematic camera movement, natural motion.`;
      const blob = await gathosVideo(prompt, vidKey, {
        aspect: format, durationSec: dur, style: GATHOS_STYLE[style] || null,
        imageDataUrl: s.img || null,
        onStatus: st2 => setSt(`Shot #${i + 1} clip: ${st2}...`),
        isCancelled: () => cancelRef.current,
      });
      setScene(i, { video: { blobUrl: URL.createObjectURL(blob), thumb: s.img || null }, imgLoading: false });
      idbSet(mk(`vid:${i}`), { blob, thumb: s.img || null, credit: null });
      recordEvent(niche.id, "clip_generated", { shot: i, hadFrame: !!s.img });
      setSt(`✅ Shot #${i + 1} clip ready`);
    } catch (e) { setScene(i, { imgErr: e.message, imgLoading: false }); }
  };
  const genAllClips = async () => {
    if (!vidKey) { setSt("⚠ Add a Gathos key in Settings"); return; }
    const targets = scenes.map((s, i) => i).filter(i => !scenes[i].video);
    if (!targets.length) { setSt("All shots already have clips"); return; }
    if (!confirm(`Generate AI clips for ${targets.length} shot(s)? Each clip takes ~1-2 minutes on Gathos (2 run at a time).`)) return;
    cancelRef.current = false; setBusy("clips");
    for (let b = 0; b < targets.length; b += 2) {
      if (cancelRef.current) break;
      setSt(`Generating clips ${b + 1}-${Math.min(b + 2, targets.length)} of ${targets.length}...`);
      await Promise.all(targets.slice(b, b + 2).map(i => genClip(i)));
    }
    setSt(cancelRef.current ? "Clip generation stopped" : "✅ Clips ready"); setBusy("");
  };
  const sourceScene = async (i, list) => {
    const s = (list || scenes)[i];
    const q = s.broll?.[0] || s.visual.slice(0, 40);
    setScene(i, { imgErr: null, imgLoading: true });
    try {
      const asset = await sourceRealAsset(q, assetKeys);
      if (!asset) { setScene(i, { imgErr: "No asset found", imgLoading: false }); return; }
      await applyAsset(i, asset);
    } catch (e) { setScene(i, { imgErr: e.message, imgLoading: false }); }
  };
  const applyAsset = async (i, asset) => {
    setScene(i, { imgLoading: true, imgErr: null });
    try {
      const credit = { text: asset.credit, url: asset.url, source: asset.source };
      if (asset.kind === "video") {
        const resp = await fetch(asset.src);
        if (!resp.ok) throw new Error(`Asset fetch ${resp.status}`);
        const blob = await resp.blob();
        setScene(i, { video: { blobUrl: URL.createObjectURL(blob), thumb: asset.thumb }, img: null, credit, imgLoading: false });
        idbSet(mk(`vid:${i}`), { blob, thumb: asset.thumb, credit }); idbDel(mk(`img:${i}`));
      } else {
        const dataUrl = await urlToDataURL(asset.src);
        setScene(i, { img: dataUrl, video: null, credit, imgLoading: false });
        idbSet(mk(`img:${i}`), dataUrl); idbDel(mk(`vid:${i}`));
      }
    } catch (e) { setScene(i, { imgErr: e.message, imgLoading: false }); }
  };
  const genAllVisuals = async (list) => {
    const arr = list || scenes;
    setBusy("images");
    for (let i = 0; i < arr.length; i += 3) {
      if (cancelRef.current) break;
      setSt(`${style === "realasset" ? "Sourcing" : "Generating"} shots ${i + 1}-${Math.min(i + 3, arr.length)} of ${arr.length}...`);
      await Promise.all([0, 1, 2].map(k => {
        if (i + k >= arr.length) return null;
        const wantReal = style === "realasset" || (arr[i + k].sourceType === "real" && (covKey || pixKey || pexKey));
        return wantReal ? sourceScene(i + k, arr) : genImage(i + k, arr);
      }));
    }
    setSt("✅ Visuals ready"); setBusy("");
  };
  const openSourcePicker = async (i, tab) => {
    const q = scenes[i].broll?.[0] || scenes[i].visual.slice(0, 40);
    const t = tab || (covKey ? "coverr" : pixKey ? "pixabay" : "pexels");
    setSrcPick({ sceneIdx: i, query: q, tab: t, results: [], loading: true });
    await loadSourceResults(i, q, t);
  };
  const loadSourceResults = async (i, q, tab) => {
    setSrcPick(p => ({ ...p, sceneIdx: i, query: q, tab, loading: true, results: [] }));
    try {
      let results = [];
      if (tab === "coverr") results = covKey ? await coverrVideos(q, covKey, 8) : [];
      else if (tab === "pixabay") results = pixKey ? [...await pixabayVideos(q, pixKey, 4), ...await pixabayPhotos(q, pixKey, 4)] : [];
      else results = pexKey ? [...await pexelsVideos(q, pexKey, 4), ...await pexelsPhotos(q, pexKey, 4)] : [];
      setSrcPick(p => p && { ...p, results, loading: false });
    } catch (e) { setSrcPick(p => p && { ...p, results: [], loading: false, err: e.message }); }
  };

  // ---- Stage 4: Voiceover (per section; Groq Whisper supplies word timestamps for any voice) ----
  const speak = async (text) => {
    let pcm, rate, words = null;
    if (voiceSel.provider === "gemini") {
      if (!gemKey) throw new Error("Set Gemini API key for Gemini voices");
      ({ pcm, rate } = await geminiTTS(text, voiceSel.id, gemKey));
    } else {
      if (!ai33Key) throw new Error("Set AI33 API key for ElevenLabs / MiniMax / Fish / cloned voices");
      const res2 = await ai33TTS(ai33Base || AI33_DEFAULT_BASE, ai33Key, { voiceId: voiceSel.id, text, transcript: !groqKey });
      ({ pcm, rate } = await decodeToPcm24k(res2.arrayBuffer));
      words = res2.words;
    }
    if (groqKey) {
      try { words = await groqTranscribe(pcmToWav(pcm, rate), groqKey) || words; }
      catch (e) { console.warn("Groq transcription failed:", e.message); }
    }
    return { pcm, rate, words };
  };
  const ttsSection = async (si, list) => {
    const arr = list || scenes;
    const secs = computeSections(arr);
    const text = secs[si].idxs.map(i => arr[i].narration).join(" ");
    setSeg(si, { loading: true });
    try {
      const seg = await speak(text);
      setSeg(si, seg);
      idbSet(mk(`seg:${si}`), { pcm: seg.pcm, rate: seg.rate, words: seg.words });
      return seg;
    } catch (e) { setSeg(si, { err: e.message }); return null; }
  };
  const ttsAll = async (list) => {
    const arr = list || scenes;
    const secs = computeSections(arr);
    const out = [];
    setBusy("tts");
    for (let si = 0; si < secs.length; si++) {
      if (cancelRef.current) break;
      if (audioSegs[si]?.pcm) { out[si] = audioSegs[si]; continue; }
      setSt(`Voicing section ${si + 1}/${secs.length} — "${secs[si].name}" (${voiceSel.name})...`);
      out[si] = await ttsSection(si, arr);
    }
    setSt("✅ Voiceover complete"); setBusy("");
    return out;
  };
  const playSeg = (seg) => {
    const url = URL.createObjectURL(pcmToWav(seg.pcm, seg.rate));
    const a = new Audio(url); a.onended = () => URL.revokeObjectURL(url); a.play();
  };
  const voicedCount = audioSegs.filter(s => s?.pcm).length;
  const totalAudio = audioSegs.reduce((t, s) => t + (s?.pcm ? s.pcm.length / s.rate : 0), 0);
  const dlVoiceover = (kind) => {
    const segs = audioSegs.filter(s => s?.pcm);
    if (!segs.length) return;
    const rate = segs[0].rate;
    const gapS = new Int16Array(Math.round(rate * 0.25));
    const parts = [];
    segs.forEach((s, i) => { parts.push(s.pcm); if (i < segs.length - 1) parts.push(gapS); });
    const pcm = concatPcm(parts);
    dlBlob(kind === "mp3" ? pcmToMp3(pcm, rate) : pcmToWav(pcm, rate), `voiceover_${slug(ctx.topic)}.${kind}`);
  };

  // ---- Background music: custom upload or Suno via AI33 ----
  const onMusicUpload = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    e.target.value = "";
    try {
      const ab = await file.arrayBuffer();
      const buffer = await decodeAudioBuffer(ab.slice(0));
      setMusic({ name: file.name, buffer, url: URL.createObjectURL(file), ab });
      idbSet(mk("music"), { name: file.name, ab });
      setSt(`✅ Music loaded: ${file.name} (${fmtTime(buffer.duration)})`);
    } catch (err) { setSt("⚠ Could not decode that audio file: " + err.message); }
  };
  const genMusic = async () => {
    if (!ai33Key) { setSt("⚠ Add your AI33 API key in Settings to generate music with Suno"); return; }
    const prompt = musicPrompt.trim() || `Instrumental background underscore for a ${niche.name} YouTube video about ${ctx.topic}. Cinematic, subtle, no vocals.`;
    setMusicProg(0); setBusy("music"); setSt("Suno composing (1–3 min)...");
    try {
      const { arrayBuffer, title } = await ai33Suno(ai33Base || AI33_DEFAULT_BASE, ai33Key, { prompt, instrumental: true, onProgress: p => setMusicProg(p) });
      const buffer = await decodeAudioBuffer(arrayBuffer.slice(0));
      setMusic({ name: title, buffer, url: URL.createObjectURL(new Blob([arrayBuffer], { type: "audio/mpeg" })), ab: arrayBuffer });
      idbSet(mk("music"), { name: title, ab: arrayBuffer });
      setSt(`✅ Suno track ready: ${title} (${fmtTime(buffer.duration)})`);
    } catch (err) { setSt("⚠ " + err.message); }
    setMusicProg(-1); setBusy("");
  };
  const musicPreviewRef = useRef(null);
  const previewMusic = () => {
    if (musicPreviewRef.current) { musicPreviewRef.current.pause(); musicPreviewRef.current = null; return; }
    const a = new Audio(music.url); a.volume = 0.6; a.play();
    musicPreviewRef.current = a;
    a.onended = () => { musicPreviewRef.current = null; };
  };
  const removeMusic = () => { setMusic(null); idbDel(mk("music")); };

  // ---- Stage 5: Render ----
  const renderCancel = useRef(false);
  const doRender = async () => {
    if (!scenes.length) { setSt("⚠ Build the storyboard first"); return; }
    setBusy("render"); setRenderProg(0); setVideo(null); renderCancel.current = false;
    try {
      const { shots, audioSegs: segsOut, total } = buildTimeline();
      const prepared = [];
      for (const s of shots) prepared.push({
        ...s,
        imgEl: s.img ? await loadImage(s.img).catch(() => null) : null,
        vidEl: s.video?.blobUrl ? await loadVideoEl(s.video.blobUrl).catch(() => null) : null,
      });
      const w = vertical ? (res === "1080" ? 1080 : 720) : (res === "1080" ? 1920 : 1280);
      const h = vertical ? (res === "1080" ? 1920 : 1280) : (res === "1080" ? 1080 : 720);
      const common = { shots: prepared, audioSegs: segsOut, total, music: music ? { buffer: music.buffer, volume: musicVol } : null, style, width: w, height: h, subtitles: subs, onProgress: p => setRenderProg(p) };
      let out;
      if (fastOk) {
        setSt("Rendering (fast encoder)...");
        try { out = await renderVideoFast({ ...common, isCancelled: () => renderCancel.current }); }
        catch (e) {
          if (renderCancel.current) throw e;
          setSt("Fast encoder failed (" + e.message + ") — falling back to realtime. Keep this tab focused.");
          out = await renderVideo(common);
        }
      } else {
        setSt("Rendering in real time — keep this tab focused...");
        out = await renderVideo(common);
      }
      setVideo({ url: URL.createObjectURL(out.blob), ext: out.ext, duration: out.duration, size: out.blob.size });
      idbSet(mk("video"), { blob: out.blob, ext: out.ext, duration: out.duration });
      recordEvent(niche.id, "video_rendered", { topic: ctx.topic, style, format, res, duration: Math.round(out.duration), music: !!music, template: tpl?.name || null });
      reflect(niche.id, clKey);
      setSt(`✅ Video rendered — ${fmtTime(out.duration)} · ${(out.blob.size / 1048576).toFixed(1)} MB (${out.ext.toUpperCase()})`);
    } catch (e) { setSt(renderCancel.current ? "Render cancelled" : "⚠ " + e.message); }
    setRenderProg(-1); setBusy("");
  };

  // ---- Stage 7: SEO Package (also saved to the Dashboard) ----
  const chapters = (list, segList) => {
    const { shots } = buildTimeline(list, segList);
    const out = []; let last = "";
    shots.forEach(s => { if (s.section && s.section !== last) { out.push(`${fmtTime(s.start)} ${s.section}`); last = s.section; } });
    return out;
  };
  const credits = (list) => {
    const seen = new Set();
    return (list || scenes).filter(s => s.credit?.text && !seen.has(s.credit.text) && seen.add(s.credit.text)).map(s => `${s.credit.text}: ${s.credit.url}`);
  };
  const genSeo = async (scriptText, sceneList, segList) => {
    const scr = scriptText || script;
    setBusy("seo"); setSt("Building SEO package...");
    try {
      const raw = await claude(SYS_SEO, `Topic: "${ctx.topic}"\nNiche: ${niche.name}\nFormat: ${vertical ? "YouTube Short" : "long-form video"}\nScript summary (first 800 chars):\n${scr.slice(0, 800)}`, clKey);
      const pkg = { ...parseJson(raw), chapters: vertical ? [] : chapters(sceneList, segList), credits: credits(sceneList) };
      setSeo(pkg); persist({ seo: pkg });
      let hid = ctx.histId;
      if (!hid && addH) { hid = addH(niche.id, ctx.topic, ctx.version || 1, brief || "", ""); ctx.histId = hid; }
      if (hid && updateH) updateH(niche.id, hid, { seo: pkg });
      recordEvent(niche.id, "seo_generated", { topic: ctx.topic, title: pkg.titles?.[0] });
      reflect(niche.id, clKey);
      setSt("✅ SEO package ready — also pinned to Home");
    } catch (e) { setSt("⚠ " + e.message); }
    setBusy("");
  };
  const dlPackage = () => {
    const seoTxt = seo ? [
      "=== TITLES ===", ...(seo.titles || []),
      "\n=== DESCRIPTION ===", seo.description || "",
      ...((seo.chapters || []).length ? ["\n=== CHAPTERS (paste into description) ===", ...seo.chapters] : []),
      "\n=== TAGS ===", (seo.tags || []).join(", "),
      "\n=== PINNED COMMENT ===", seo.pinnedComment || "",
      ...((seo.credits || []).length ? ["\n=== ATTRIBUTION / CREDITS (paste into description) ===", ...seo.credits] : []),
    ].join("\n") : "Run Generate SEO first.";
    dlBlob(makeZip([
      { name: "script.txt", data: script || "" },
      { name: "storyboard.json", data: JSON.stringify(scenes.map(({ img, video, ...r }) => r), null, 2) },
      { name: "seo_package.txt", data: seoTxt },
    ]), `${slug(ctx.topic)}_seo_package.zip`);
  };

  // ---- Autopilot ----
  const autopilot = async () => {
    cancelRef.current = false; setAuto(true);
    let s = script;
    if (!s) { setStep(0); s = await genScript(); }
    if (!s || cancelRef.current) { setAuto(false); return; }
    setStep(1);
    const arr = scenes.length ? scenes : await genStoryboard(s);
    if (!arr.length || cancelRef.current) { setAuto(false); return; }
    setStep(2); await genAllVisuals(arr);
    if (cancelRef.current) { setAuto(false); return; }
    setStep(3); const segs = await ttsAll(arr);
    if (!cancelRef.current) { setStep(4); setSt("✅ Autopilot done — review, then hit Render"); }
    if (!seo && clKey) genSeo(s, arr, segs);
    setAuto(false);
  };

  const mediaReady = scenes.filter(s => s.img || s.video).length;
  const disabled = !!busy || auto;

  return (<div className="yt-page vs-studio">
    <div className="yt-breadcrumb">
      <button className="yt-btn-o" onClick={back}>← {niche.name}</button>
      <h1 className="yt-page-title">Studio</h1>
      <span className="vs-topic-pill">{ctx.topic}{(ctx.version || 1) > 1 ? ` · v${ctx.version}` : ""}</span>
    </div>

    <div className="vs-toolbar">
      <div className="vs-styles">{STYLES.map(x => <button key={x.id} className={`vs-style ${style === x.id ? "active" : ""}`} onClick={() => { setStyle(x.id); persist({ style: x.id }); }} disabled={disabled}>
        <span className="vs-style-n">{x.n}</span><span className="vs-style-d">{x.d}</span>
      </button>)}</div>
      <div className="vs-toolbar-r">
        {templates.length > 0 && <div><label className="yt-label">Template</label>
          <select className="yt-sel" value={tplId || ""} onChange={e => { const v = e.target.value ? +e.target.value : null; setTplId(v); persist({ tplId: v }); if (v) recordEvent(niche.id, "template_used", { template: templates.find(t => t.id === v)?.name }); }} disabled={disabled}>
            <option value="">No template</option>
            {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select></div>}
        <div><label className="yt-label">Format</label><select className="yt-sel" value={format} onChange={e => { setFormat(e.target.value); persist({ format: e.target.value }); }} disabled={disabled}><option value="16:9">16:9 long-form</option><option value="9:16">9:16 Short</option></select></div>
        <div><label className="yt-label">Length</label><select className="yt-sel" value={dur} onChange={e => setDur(e.target.value)} disabled={disabled}><option value="0.7">~40 sec</option><option value="1">~1 min</option><option value="3">~3 min</option><option value="5">~5 min</option><option value="8">6–8 min</option><option value="12">10–12 min</option><option value="15">13–15 min</option></select></div>
        <div><label className="yt-label">Voice</label>
          <button className="vs-voice-btn" onClick={() => setVoiceModal(true)} disabled={disabled}>
            {voiceSel.name}<span className="vs-voice-prov">{voiceSel.provider}</span>
          </button>
        </div>
        {!auto ? <button className="vs-btn-auto" onClick={autopilot} disabled={!!busy}>Autopilot</button>
          : <button className="vs-btn-auto vs-btn-cancel" onClick={() => { cancelRef.current = true; }}>Stop</button>}
      </div>
    </div>

    <div className="vs-steps">{STEPS.map((s, i) => {
      const done = [!!script, scenes.length > 0, mediaReady > 0 && mediaReady === scenes.length, voicedCount > 0 && voicedCount === sections.length, !!video, (thumbState.thumbs || []).some(t => t?.url), !!seo][i];
      return <button key={i} className={`vs-step ${step === i ? "active" : ""} ${done ? "done" : ""}`} onClick={() => setStep(i)}>
        <span className="vs-step-num">{done ? "✓" : i + 1}</span>{s}
      </button>;
    })}</div>

    {st && <p className={`yt-st ${st[0] === "⚠" ? "err" : st[0] === "✅" ? "ok" : ""}`}>{st}</p>}

    <div ref={panelRef}>
    {/* STEP 1 — SCRIPT (with research brief) */}
    {step === 0 && <>
      <div className="yt-card">
        <div className="yt-card-h" onClick={() => setBriefOpen(!briefOpen)}>
          <span className="yt-card-ht">Creative brief {brief ? "· ready" : "· optional"}</span>
          <div className="yt-btn-row">
            <button className={`yt-btn-o ${busy === "brief" ? "yt-btn-ld" : ""}`} onClick={e => { e.stopPropagation(); genBrief(); }} disabled={disabled}>{busy === "brief" ? "Writing…" : brief ? "Rewrite brief" : "Write brief"}</button>
            <span className="yt-chev">{briefOpen ? "▲" : "▼"}</span>
          </div>
        </div>
        {!brief && !briefOpen && <p className="yt-hint" style={{ marginBottom: 0 }}>A research-driven brief (angle, facts, audience) that guides the script. Versions of the same topic automatically avoid items already used.</p>}
        {briefOpen && <div className="yt-card-b">
          {getUsedItems().length > 0 && <p className="yt-hint">Already used in earlier versions ({getUsedItems().length}): {getUsedItems().join(", ")}</p>}
          <textarea className="yt-input vs-script-area" rows="10" value={brief} onChange={e => setBrief(e.target.value)} onBlur={() => persist()} placeholder="Write or generate the brief here."/>
        </div>}
      </div>
      <div className="yt-card">
        <div className="yt-card-h"><span className="yt-card-ht">Full narration script</span>
          <button className={`yt-btn ${busy === "script" ? "yt-btn-ld" : ""}`} onClick={genScript} disabled={disabled}>{busy === "script" ? "Writing…" : script ? "Rewrite" : "Write script"}</button>
        </div>
        {brief && <p className="yt-hint">The brief above guides this script.</p>}
        <textarea className="yt-input vs-script-area vs-script-read" rows="16" value={script} onChange={e => setScript(e.target.value)} onFocus={e => { focusRef.current = e.target.value; }} onBlur={e => { persist(); if (focusRef.current && focusRef.current !== e.target.value) recordEvent(niche.id, "script_edited", { before: focusRef.current.slice(0, 220), after: e.target.value.slice(0, 220) }); }} placeholder="Hit Write script — or paste your own narration. Clean spoken text, paragraphs between beats."/>
        {script && <div className="vs-row-between"><span className="yt-hint">{script.split(/\s+/).filter(Boolean).length} words ≈ {fmtTime(script.split(/\s+/).filter(Boolean).length / 2.6)} runtime</span>
          <button className="yt-btn" onClick={() => { genStoryboard(); setStep(1); }} disabled={disabled}>Storyboard it →</button></div>}
      </div>
    </>}

    {/* STEP 2 — STORYBOARD */}
    {step === 1 && <div className="yt-card">
      <div className="yt-card-h"><span className="yt-card-ht">Storyboard — {scenes.length} shots · 3-5s each · {fmtTime(totalRuntime())}</span>
        <button className={`yt-btn ${busy === "storyboard" ? "yt-btn-ld" : ""}`} onClick={() => genStoryboard()} disabled={disabled || !script}>{busy === "storyboard" ? "Directing…" : scenes.length ? "Re-storyboard" : "Build storyboard"}</button>
      </div>
      {!script && <p className="yt-hint">Write the script first (step 1).</p>}
      {scenes.map((s, i) => <div key={i} className="vs-scene">
        <div className="vs-scene-head"><span className="vs-scene-num">#{i + 1}</span><span className="vs-scene-sec">{s.section}</span><span className="vs-scene-dur">~{fmtTime(estDuration(s.narration))}</span>
          <button className="yt-x" onClick={() => { const n = scenes.filter((_, j) => j !== i); setScenes(n); setAudioSegs([]); clearSegsIdb(); idbDelPrefix(mk("img:")); idbDelPrefix(mk("vid:")); persist({ scenes: n }); }}>✕</button></div>
        <label className="yt-label">Narration (8-14 words)</label>
        <textarea className="yt-input vs-scene-area" rows="1" value={s.narration} onChange={e => setScene(i, { narration: e.target.value })} onFocus={e => { focusRef.current = e.target.value; }} onBlur={e => { persist(); if (focusRef.current && focusRef.current !== e.target.value) recordEvent(niche.id, "narration_edited", { before: focusRef.current, after: e.target.value }); }}/>
        <label className="yt-label">Visual prompt</label>
        <textarea className="yt-input vs-scene-area" rows="2" value={s.visual} onChange={e => setScene(i, { visual: e.target.value, img: null })} onBlur={() => persist()}/>
        <div className="vs-scene-meta">
          {s.broll?.length > 0 && <span className="vs-broll">B-roll: {s.broll.map((b, k) => <a key={k} href={`https://pixabay.com/videos/search/${encodeURIComponent(b)}/`} target="_blank" rel="noreferrer">{b}</a>)}</span>}
          {s.sourceType === "real" && <span className="vs-real-tag">real footage</span>}
          {s.overlay && <span className="vs-overlay-tag">{s.overlay}</span>}
        </div>
      </div>)}
      {scenes.length > 0 && <button className="yt-btn" onClick={() => setStep(2)} style={{ marginTop: 10 }}>Add visuals →</button>}
    </div>}

    {/* STEP 3 — VISUALS */}
    {step === 2 && <div className="yt-card">
      <div className="yt-card-h"><span className="yt-card-ht">Visuals — {mediaReady}/{scenes.length} shots{vertical ? " · vertical" : ""}</span>
        <div className="yt-btn-row">
          {vidKey && style !== "realasset" && <button className={`yt-btn-o ${busy === "clips" ? "yt-btn-ld" : ""}`} onClick={busy === "clips" ? () => { cancelRef.current = true; } : genAllClips} disabled={busy && busy !== "clips" || !scenes.length}>{busy === "clips" ? "Stop clips" : "Animate all (AI clips)"}</button>}
          <button className={`yt-btn ${busy === "images" ? "yt-btn-ld" : ""}`} onClick={() => genAllVisuals()} disabled={disabled || !scenes.length}>{busy === "images" ? "Working…" : style === "realasset" ? "Auto-source all" : "Generate all frames"}</button>
        </div>
      </div>
      {style === "realasset"
        ? <p className="yt-hint">Sourcing order: <b>Coverr</b> video → <b>Pixabay</b> video/photo → <b>Pexels</b> fallback. {!covKey && !pixKey && !pexKey ? "⚠ Add at least one of those keys in Settings." : ""} Real clips play inside the final render; credits are collected into your SEO package.</p>
        : !gathosKey ? <p className="yt-hint">⚠ Add a Gathos API key in Settings to generate frames and clips.</p>
        : <p className="yt-hint">Frames render on Gathos (~15s each). "AI clip" animates a shot into real motion (~1-2 min each) — generate the frame first for the best result, or go straight to clip.</p>}
      <div className="vs-frames">{scenes.map((s, i) => <div key={i} className="vs-frame">
        <div className={`vs-frame-img ${vertical ? "vert" : ""}`}>
          {s.imgLoading && <div className="yt-thumb-loader"><div className="yt-spin"/></div>}
          {!s.imgLoading && s.video && <video src={s.video.blobUrl} muted loop playsInline onMouseOver={e => e.target.play()} onMouseOut={e => e.target.pause()} poster={s.video.thumb}/>}
          {!s.imgLoading && !s.video && s.img && <img src={s.img} alt="" onClick={() => window.open(s.img)}/>}
          {!s.imgLoading && !s.img && !s.video && <div className="vs-frame-empty">{s.imgErr ? s.imgErr : "No media yet"}</div>}
          <span className="vs-frame-num">#{i + 1}</span>
          {s.video && <span className="vs-frame-kind">clip</span>}
          {s.credit && <span className="vs-frame-credit">{s.credit.source}</span>}
        </div>
        <p className="vs-frame-cap">{s.visual.slice(0, 80)}{s.visual.length > 80 ? "…" : ""}</p>
        <div className="vs-frame-btns">
          {style === "realasset" && <button className="yt-btn-remake" onClick={() => sourceScene(i)} disabled={s.imgLoading}>Auto</button>}
          {(covKey || pixKey || pexKey) && <button className="yt-btn-remake" onClick={() => openSourcePicker(i)} disabled={s.imgLoading}>Pick</button>}
          <button className="yt-btn-remake" onClick={() => genImage(i)} disabled={s.imgLoading}>{s.img ? "Redo frame" : "AI frame"}</button>
          {vidKey && <button className="yt-btn-remake" onClick={() => genClip(i)} disabled={s.imgLoading} title={s.img ? "Animate this frame into a clip" : "Text-to-video clip"}>{s.video ? "Redo clip" : "AI clip"}</button>}
        </div>
      </div>)}</div>
      {srcPick && <div className="vs-pex-modal" onClick={() => setSrcPick(null)}><div className="vs-pex-box" onClick={e => e.stopPropagation()}>
        <div className="vs-row-between"><span className="yt-card-ht">Source shot #{srcPick.sceneIdx + 1}</span><button className="yt-x" onClick={() => setSrcPick(null)}>✕</button></div>
        <div className="vs-src-tabs">
          {covKey && <button className={`vs-src-tab ${srcPick.tab === "coverr" ? "active" : ""}`} onClick={() => loadSourceResults(srcPick.sceneIdx, srcPick.query, "coverr")}>Coverr</button>}
          {pixKey && <button className={`vs-src-tab ${srcPick.tab === "pixabay" ? "active" : ""}`} onClick={() => loadSourceResults(srcPick.sceneIdx, srcPick.query, "pixabay")}>Pixabay</button>}
          {pexKey && <button className={`vs-src-tab ${srcPick.tab === "pexels" ? "active" : ""}`} onClick={() => loadSourceResults(srcPick.sceneIdx, srcPick.query, "pexels")}>Pexels</button>}
          <input className="yt-input" style={{ maxWidth: 220 }} value={srcPick.query} onChange={e => setSrcPick(p => ({ ...p, query: e.target.value }))} onKeyDown={e => e.key === "Enter" && loadSourceResults(srcPick.sceneIdx, srcPick.query, srcPick.tab)}/>
          <button className="yt-btn" onClick={() => loadSourceResults(srcPick.sceneIdx, srcPick.query, srcPick.tab)}>Search</button>
        </div>
        {srcPick.loading && <div className="yt-ld-box"><div className="yt-spin"/></div>}
        {srcPick.err && <p className="yt-st err">⚠ {srcPick.err}</p>}
        <div className="vs-pex-grid">{srcPick.results.map((r, k) => <div key={k} className="vs-src-item" onClick={() => { applyAsset(srcPick.sceneIdx, r); setSrcPick(null); }}>
          <img src={r.thumb} alt=""/><span className="vs-src-kind">{r.kind === "video" ? "clip" : "photo"} · {r.source}</span>
        </div>)}</div>
        {!srcPick.loading && !srcPick.results.length && !srcPick.err && <p className="yt-hint">No results — try different keywords.</p>}
      </div></div>}
      {mediaReady > 0 && <button className="yt-btn" onClick={() => setStep(3)} style={{ marginTop: 12 }}>Voice it →</button>}
    </div>}

    {/* STEP 4 — VOICEOVER */}
    {step === 3 && <div className="yt-card">
      <div className="yt-card-h"><span className="yt-card-ht">Voiceover — {voicedCount}/{sections.length} sections · {fmtTime(totalAudio)}</span>
        <div className="yt-btn-row">
          <button className="yt-btn-o" onClick={() => setVoiceModal(true)} disabled={disabled}>{voiceSel.name} ({voiceSel.provider})</button>
          <button className={`yt-btn ${busy === "tts" ? "yt-btn-ld" : ""}`} onClick={() => ttsAll()} disabled={disabled || !scenes.length}>{busy === "tts" ? "Voicing…" : "Voice all sections"}</button>
        </div>
      </div>
      <p className="yt-hint">Voiced per script section for natural prosody, then beat-synced across the shots. {groqKey ? "Groq Whisper transcribes every section — subtitles use exact word timing." : voiceSel.provider !== "gemini" ? "AI33 voices return word timestamps when available. Add a Groq key in Settings for exact timing on every voice." : "Add a Groq key in Settings for exact word-timed subtitles."}</p>
      <div className="vs-vo-list">{sections.map((sec, si) => { const seg = audioSegs[si]; return <div key={si} className="vs-vo-row">
        <span className="vs-scene-num">§{si + 1}</span>
        <span className="vs-vo-text"><b>{sec.name}</b> · {sec.idxs.length} shots — {scenes[sec.idxs[0]]?.narration.slice(0, 60)}…</span>
        <span className="vs-vo-dur">{seg?.pcm ? fmtTime(seg.pcm.length / seg.rate) : seg?.loading ? "…" : seg?.err ? "failed" : "—"}</span>
        {seg?.words && <span className="vs-vo-words" title="Word-accurate subtitle timing">word-timed</span>}
        {seg?.pcm && <button className="yt-btn-remake" onClick={() => playSeg(seg)}>▶</button>}
        <button className="yt-btn-remake" onClick={() => ttsSection(si)} disabled={seg?.loading}>Redo</button>
      </div>; })}</div>
      {audioSegs.some(s => s?.err) && <p className="yt-st err">⚠ {audioSegs.find(s => s?.err)?.err}</p>}
      {voicedCount > 0 && <div className="yt-btn-row" style={{ marginTop: 14 }}>
        <button className="yt-btn" onClick={() => dlVoiceover("mp3")}>Download MP3</button>
        <button className="yt-btn-o" onClick={() => dlVoiceover("wav")}>WAV</button>
        <button className="yt-btn" onClick={() => setStep(4)}>Render video →</button>
      </div>}
    </div>}

    {/* STEP 5 — RENDER */}
    {step === 4 && <div className="yt-card">
      <div className="yt-card-ht">Render final video {vertical ? "(9:16 Short)" : ""}</div>
      <div className="vs-music">
        <div className="vs-music-head">Background music <span className="yt-hint" style={{margin:0}}>ducked under the voiceover, auto fade-out</span></div>
        {music ? <div className="vs-music-row">
          <span className="vs-music-name">{music.name} · {fmtTime(music.buffer.duration)}{music.buffer.duration < totalRuntime() ? " (loops)" : ""}</span>
          <button className="yt-btn-remake" onClick={previewMusic}>▶ / ⏸</button>
          <label className="vs-music-vol">Vol {Math.round(musicVol * 100)}%
            <input type="range" min="0" max="50" value={Math.round(musicVol * 100)} onChange={e => setMusicVol(+e.target.value / 100)}/>
          </label>
          <button className="yt-x" onClick={removeMusic}>✕</button>
        </div> : <div className="vs-music-add">
          <label className="yt-btn-o" style={{ cursor: "pointer" }}>
            <input type="file" accept="audio/*" style={{ display: "none" }} onChange={onMusicUpload}/>
            Upload your music
          </label>
          <input className="yt-input" placeholder="…or describe a track for Suno (e.g. tense cinematic documentary underscore, no vocals)" value={musicPrompt} onChange={e => setMusicPrompt(e.target.value)}/>
          <button className={`yt-btn ${busy === "music" ? "yt-btn-ld" : ""}`} onClick={genMusic} disabled={busy === "music" || !ai33Key} title={!ai33Key ? "Needs AI33 API key" : ""}>{busy === "music" ? (musicProg > 0 ? musicProg + "%" : "Composing…") : "Generate with Suno"}</button>
        </div>}
      </div>
      <p className="yt-hint">{fastOk === false ? "This browser lacks WebCodecs — rendering runs in real time; keep the tab focused. " : fastOk ? "Fast encoder available — renders faster than realtime and survives background tabs. " : ""}{style === "doodle" ? "Hard cuts (doodle rule), " : "Fast cuts with Ken Burns on stills, real clips play live, "}karaoke subtitles {subs ? "on" : "off"}. Estimated runtime {fmtTime(totalRuntime())}.</p>
      <div className="vs-render-ctrl">
        <div><label className="yt-label">Resolution</label><select className="yt-sel" value={res} onChange={e => setRes(e.target.value)} disabled={busy === "render"}><option value="720">{vertical ? "720×1280" : "1280×720"} (faster)</option><option value="1080">{vertical ? "1080×1920" : "1920×1080"}</option></select></div>
        <label className="yt-thumb-check" style={{ marginTop: 20 }}><input type="checkbox" checked={subs} onChange={e => setSubs(e.target.checked)}/><span>Karaoke subtitles</span></label>
        {busy !== "render"
          ? <button className="yt-btn-big" style={{ flex: 1 }} onClick={doRender} disabled={disabled || !scenes.length}>Render video</button>
          : <button className="yt-btn-big yt-btn-big-ld" style={{ flex: 1 }} onClick={() => { renderCancel.current = true; }}>Cancel render</button>}
      </div>
      {voicedCount < sections.length && scenes.length > 0 && <p className="yt-hint" style={{ marginTop: 8 }}>⚠ {sections.length - voicedCount} section(s) not voiced — they'll render silent with estimated timing.</p>}
      {renderProg >= 0 && <div className="vs-progress"><div className="vs-progress-fill" style={{ width: `${Math.round(renderProg * 100)}%` }}/><span className="vs-progress-t">{Math.round(renderProg * 100)}%</span></div>}
      {video && <div className="vs-video-out">
        <video src={video.url} controls className={`vs-video-player ${vertical ? "vert" : ""}`}/>
        <div className="yt-btn-row" style={{ marginTop: 12 }}>
          <a className="yt-btn" href={video.url} download={`${slug(ctx.topic)}.${video.ext}`}>Download {video.ext.toUpperCase()} ({(video.size / 1048576).toFixed(1)} MB)</a>
          <button className="yt-btn-o" onClick={() => setStep(5)}>Thumbnail →</button>
        </div>
      </div>}
    </div>}

    {/* STEP 6 — THUMBNAIL */}
    {step === 5 && <>
      <ThumbLab topic={ctx.topic} niche={niche} clKey={clKey} gathosKey={gathosKey} refThumb={ctx.refThumb} format={format}
        state={thumbState}
        setState={s => { setThumbState(prev => { const next = { ...prev, ...s }; const { thumbs, ...lite } = next; persist({ thumbState: lite }); if (s.thumbs) idbSet(mk("thumbs"), s.thumbs); return next; }); }}/>
      <button className="yt-btn" onClick={() => setStep(6)}>SEO package →</button>
    </>}

    {/* STEP 7 — SEO PACKAGE */}
    {step === 6 && <div className="yt-card">
      <div className="yt-card-h"><span className="yt-card-ht">SEO package</span>
        <button className={`yt-btn ${busy === "seo" ? "yt-btn-ld" : ""}`} onClick={() => genSeo()} disabled={disabled || !clKey}>{busy === "seo" ? "Building…" : seo ? "Regenerate" : "Generate SEO"}</button>
      </div>
      <p className="yt-hint">Generated packages are pinned to Home so you can copy them anytime.</p>
      {seo && <SeoView seo={seo}/>}
      <div className="yt-btn-row" style={{ marginTop: 14 }}>
        <button className="yt-btn" onClick={dlPackage} disabled={!script && !scenes.length}>Download package (.zip)</button>
        {voicedCount > 0 && <button className="yt-btn-o" onClick={() => dlVoiceover("mp3")}>Voiceover MP3</button>}
        {video && <a className="yt-btn-o" href={video.url} download={`${slug(ctx.topic)}.${video.ext}`}>Video</a>}
      </div>
    </div>}
    </div>
    {voiceModal && <VoiceModal voiceSel={voiceSel} pick={pickVoice} close={() => setVoiceModal(false)} gemKey={gemKey} ai33Key={ai33Key} ai33Base={ai33Base}/>}
    <style>{STUDIO_CSS}</style>
  </div>);
}

// ---- Voice selection modal: Gemini + AI33 (ElevenLabs / MiniMax / Fish) + cloning ----
function VoiceModal({ voiceSel, pick, close, gemKey, ai33Key, ai33Base }) {
  const [tab, setTab] = useState(["gemini", "elevenlabs", "minimax", "fishaudio", "clone"].includes(voiceSel.provider) ? (voiceSel.provider === "clone" ? "clones" : voiceSel.provider) : "gemini");
  const [live, setLive] = useState({});
  const [loading, setLoading] = useState("");
  const [err, setErr] = useState("");
  const [preview, setPreview] = useState("");
  const [search, setSearch] = useState("");
  const [clones, setClones] = useState(() => ls("vr7-clones", []));
  const [cloneName, setCloneName] = useState("");
  const [cloneFile, setCloneFile] = useState(null);
  const [cloning, setCloning] = useState(false);
  const b = ai33Base || AI33_DEFAULT_BASE;

  const TABS = [["gemini", "Gemini"], ["elevenlabs", "ElevenLabs"], ["minimax", "MiniMax"], ["fishaudio", "Fish Audio"], ["clones", "My Clones"]];
  const localFilter = list => search ? list.filter(v => (v.name + " " + v.desc).toLowerCase().includes(search.toLowerCase())) : list;
  const lists = {
    gemini: localFilter(GEMINI_VOICES),
    elevenlabs: live.elevenlabs || localFilter(ELEVENLABS_VOICES),
    minimax: live.minimax || localFilter(MINIMAX_VOICES),
    fishaudio: live.fishaudio || [],
    clones: live.clone || clones.map(c => ({ provider: "clone", id: c.id, name: c.name, desc: "Your cloned voice (AI33)" })),
  };
  const loadLive = async (t) => {
    if (!ai33Key) { setErr("Add your AI33 API key in Settings to load live voice lists"); return; }
    const prov = t === "clones" ? "clone" : t;
    setLoading(t); setErr("");
    try { const voices = await ai33ListVoices(b, ai33Key, prov, { search }); setLive(prev => ({ ...prev, [prov]: voices })); }
    catch (e) { setErr(e.message); }
    setLoading("");
  };
  const doPreview = async (v) => {
    setErr("");
    if (v.preview) { new Audio(v.preview).play().catch(() => setErr("Preview audio failed to play")); return; }
    setPreview(v.id);
    try {
      const text = "This is how I sound narrating your next video.";
      let pcm, rate;
      if (v.provider === "gemini") {
        if (!gemKey) throw new Error("Gemini key needed for preview");
        ({ pcm, rate } = await geminiTTS(text, v.id, gemKey));
      } else {
        if (!ai33Key) throw new Error("AI33 key needed for preview");
        const { arrayBuffer } = await ai33TTS(b, ai33Key, { voiceId: v.id, text });
        ({ pcm, rate } = await decodeToPcm24k(arrayBuffer));
      }
      const url = URL.createObjectURL(pcmToWav(pcm, rate));
      const a = new Audio(url); a.onended = () => URL.revokeObjectURL(url); a.play();
    } catch (e) { setErr(e.message); }
    setPreview("");
  };
  const doClone = async () => {
    if (!ai33Key) { setErr("Add your AI33 API key in Settings to clone voices"); return; }
    if (!cloneFile || !cloneName.trim()) { setErr("Pick an audio file (≤10MB) and a name for your clone"); return; }
    setCloning(true); setErr("");
    try {
      const v = await ai33Clone(b, ai33Key, { name: cloneName.trim(), file: cloneFile });
      const next = [...clones, { id: v.id, name: v.name }];
      setClones(next); ss("vr7-clones", next);
      setCloneName(""); setCloneFile(null);
      loadLive("clones");
    } catch (e) { setErr(e.message); }
    setCloning(false);
  };
  const doDeleteClone = async (v) => {
    if (!confirm(`Delete cloned voice "${v.name}" from your AI33 account?`)) return;
    setErr("");
    try {
      await ai33DeleteClone(b, ai33Key, v.id);
      const next = clones.filter(c => c.id !== v.id);
      setClones(next); ss("vr7-clones", next);
      setLive(prev => ({ ...prev, clone: (prev.clone || []).filter(c => c.id !== v.id) }));
    } catch (e) { setErr(e.message); }
  };

  return (<div className="vs-pex-modal" onClick={close}><div className="vs-pex-box vs-voice-box" onClick={e => e.stopPropagation()}>
    <div className="vs-row-between"><span className="yt-card-ht">Choose a voice</span><button className="yt-x" onClick={close}>✕</button></div>
    <div className="vs-src-tabs">{TABS.map(([id, n]) => <button key={id} className={`vs-src-tab ${tab === id ? "active" : ""}`} onClick={() => { setTab(id); setErr(""); }}>{n}</button>)}</div>
    <div className="vs-src-tabs" style={{ marginTop: 8 }}>
      <input className="yt-input" style={{ maxWidth: 260 }} placeholder="Search voices…" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === "Enter" && tab !== "gemini" && loadLive(tab)}/>
      {tab !== "gemini" && <button className="yt-btn-o" onClick={() => loadLive(tab)} disabled={loading === tab}>{loading === tab ? "Loading…" : "Load from AI33"}</button>}
    </div>
    {tab !== "gemini" && !ai33Key && <p className="yt-hint">⚠ These voices run through your AI33 account (api.ai33.pro) — add the API key in Settings.{tab === "elevenlabs" || tab === "minimax" ? " Built-in catalog shown below." : ""}</p>}
    {tab === "fishaudio" && !lists.fishaudio.length && <p className="yt-hint">Fish Audio voices load live from AI33 (sorted by trending) — hit "Load from AI33".</p>}
    {err && <p className="yt-st err">⚠ {err}</p>}
    <div className="vs-voice-grid">{lists[tab].map(v => <div key={v.provider + v.id} className={`vs-voice-card ${voiceSel.id === v.id ? "active" : ""}`}>
      <div className="vs-voice-n">{v.name}</div>
      <div className="vs-voice-d">{v.desc}</div>
      <div className="vs-frame-btns">
        <button className="yt-btn-remake" onClick={() => doPreview(v)} disabled={preview === v.id}>{preview === v.id ? "…" : "▶ Preview"}</button>
        <button className="yt-btn-use-sm" onClick={() => pick({ provider: v.provider, id: v.id, name: v.name })}>Use</button>
        {tab === "clones" && <button className="yt-btn-remake" onClick={() => doDeleteClone(v)}>Delete</button>}
      </div>
    </div>)}</div>
    {tab === "clones" && <div className="vs-clone-box">
      <div className="yt-card-ht" style={{ marginBottom: 8 }}>Clone a new voice</div>
      <p className="yt-hint">Upload 30s–3min of clean speech (mp3/wav, max 10MB). The sample is sent to your AI33 account, cloned there, and the new voice appears above ready to use.</p>
      <div className="yt-input-row" style={{ marginTop: 8 }}>
        <input className="yt-input" placeholder="Voice name, e.g. My Narrator" value={cloneName} onChange={e => setCloneName(e.target.value)}/>
        <label className="yt-btn-o" style={{ cursor: "pointer" }}>
          <input type="file" accept="audio/*" style={{ display: "none" }} onChange={e => setCloneFile(e.target.files?.[0] || null)}/>
          {cloneFile ? cloneFile.name.slice(0, 24) : "Pick audio file"}
        </label>
        <button className={`yt-btn ${cloning ? "yt-btn-ld" : ""}`} onClick={doClone} disabled={cloning}>{cloning ? "Cloning…" : "Clone voice"}</button>
      </div>
    </div>}
  </div></div>);
}

function dlBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
const slug = s => s.toLowerCase().replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "video";

const STUDIO_CSS = `
.vs-topic-pill{font-size:13px;font-weight:600;color:var(--text);background:var(--surface2);border:1px solid var(--border);padding:6px 14px;border-radius:20px;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vs-toolbar{display:flex;gap:16px;align-items:end;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap}
.vs-styles{display:flex;gap:10px;flex-wrap:wrap}
.vs-style{display:flex;flex-direction:column;align-items:start;gap:2px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius2);padding:10px 14px;cursor:pointer;font-family:var(--font);color:var(--text2);transition:all .15s;max-width:210px;text-align:left}
.vs-style:hover{border-color:var(--border2)}
.vs-style.active{border-color:var(--text);background:var(--surface)}
.vs-style-n{font-size:13px;font-weight:700;color:var(--text)}.vs-style-d{font-size:10px;color:var(--text3);line-height:1.3}
.vs-toolbar-r{display:flex;gap:12px;align-items:end;flex-wrap:wrap}
.vs-voice-btn{display:flex;align-items:center;gap:8px;background:var(--bg);border:1px solid var(--border2);border-radius:var(--radius3);padding:8px 14px;color:var(--text);font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font);white-space:nowrap;transition:all .15s}
.vs-voice-btn:hover{background:var(--surface)}
.vs-voice-prov{font-size:9px;text-transform:uppercase;letter-spacing:.5px;background:var(--surface2);padding:2px 7px;border-radius:6px;color:var(--text2)}
.vs-btn-auto{background:var(--text);border:1px solid var(--text);border-radius:var(--radius2);padding:11px 22px;color:var(--bg);font-size:14px;font-weight:700;cursor:pointer;font-family:var(--font);transition:opacity .15s;white-space:nowrap}
.vs-btn-auto:hover{opacity:.85}
.vs-btn-auto:disabled{opacity:.4}
.vs-btn-cancel{background:var(--text2);border-color:var(--text2)}
.vs-steps{display:flex;gap:6px;margin-bottom:18px;flex-wrap:wrap}
.vs-step{display:flex;align-items:center;gap:8px;background:var(--bg);border:1px solid var(--border);border-radius:20px;padding:7px 15px;color:var(--text2);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font);transition:all .15s}
.vs-step:hover{border-color:var(--border2);color:var(--text)}
.vs-step.active{border-color:var(--text);background:var(--surface);color:var(--text)}
.vs-step.done .vs-step-num{background:var(--green);color:#fff}
.vs-step-num{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:var(--surface2);font-size:10px;font-weight:700}
.vs-script-area{font-family:var(--mono);font-size:13px;line-height:1.6;resize:vertical;margin-top:10px}
.vs-script-read{font-family:inherit;font-size:15px;line-height:1.75;white-space:pre-wrap}
.vs-row-between{display:flex;justify-content:space-between;align-items:center;margin-top:10px;gap:10px;flex-wrap:wrap}
.vs-scene{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius2);padding:14px;margin-top:12px}
.vs-scene-head{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.vs-scene-num{background:var(--text);color:var(--bg);font-size:10px;font-weight:700;padding:3px 8px;border-radius:6px;flex-shrink:0}
.vs-scene-sec{font-size:12px;font-weight:600;color:var(--text2);flex:1}
.vs-scene-dur{font-size:11px;color:var(--text3);font-family:var(--mono)}
.vs-scene-area{font-size:13px;resize:vertical;margin-bottom:8px;background:var(--bg)}
.vs-scene-meta{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--text3)}
.vs-broll a{color:var(--blue);margin-left:6px;text-decoration:none}
.vs-broll a:hover{text-decoration:underline}
.vs-overlay-tag{color:var(--text2)}\n.vs-real-tag{font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;background:var(--blue-bg);color:var(--blue);padding:2px 7px;border-radius:8px}
.vs-frames{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin-top:14px}
.vs-frame{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius2);overflow:hidden}
.vs-frame-img{position:relative;aspect-ratio:16/9;background:var(--surface)}
.vs-frame-img.vert{aspect-ratio:9/16;max-height:280px}
.vs-frame-img img,.vs-frame-img video{width:100%;height:100%;object-fit:cover;cursor:zoom-in;display:block}
.vs-frame-empty{display:flex;align-items:center;justify-content:center;height:100%;font-size:11px;color:var(--text3);padding:10px;text-align:center}
.vs-frame-num{position:absolute;top:6px;left:6px;background:rgba(28,28,26,.8);color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:5px}
.vs-frame-kind{position:absolute;top:6px;right:6px;background:rgba(28,28,26,.8);color:#fff;font-size:9px;padding:2px 7px;border-radius:5px}
.vs-frame-credit{position:absolute;bottom:6px;left:6px;background:rgba(28,28,26,.8);color:#fff;font-size:9px;padding:2px 7px;border-radius:5px}
.vs-frame-cap{font-size:11px;color:var(--text3);padding:8px 10px 4px;line-height:1.4}
.vs-frame-btns{display:flex;gap:6px;padding:6px 10px 10px;flex-wrap:wrap}
.vs-pex-modal{position:fixed;inset:0;background:rgba(28,28,26,.35);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px}
.vs-pex-box{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow);padding:20px;max-width:800px;width:100%;max-height:82vh;overflow-y:auto}
.vs-voice-box{max-width:860px}
.vs-src-tabs{display:flex;gap:8px;align-items:center;margin-top:14px;flex-wrap:wrap}
.vs-src-tab{background:var(--bg);border:1px solid var(--border2);border-radius:20px;padding:6px 15px;color:var(--text2);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font);transition:all .15s}
.vs-src-tab.active{border-color:var(--text);background:var(--surface);color:var(--text)}
.vs-pex-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-top:14px}
.vs-src-item{position:relative;cursor:pointer;border:2px solid transparent;border-radius:8px;overflow:hidden;transition:all .15s}
.vs-src-item:hover{border-color:var(--blue)}
.vs-src-item img{width:100%;aspect-ratio:16/10;object-fit:cover;display:block}
.vs-src-kind{position:absolute;bottom:4px;left:4px;background:rgba(28,28,26,.8);color:#fff;font-size:9px;padding:2px 7px;border-radius:5px}
.vs-voice-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;margin-top:14px}
.vs-voice-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius2);padding:12px}
.vs-voice-card.active{border-color:var(--blue);background:var(--blue-bg)}
.vs-voice-n{font-size:13px;font-weight:700;color:var(--text)}
.vs-voice-d{font-size:10px;color:var(--text3);margin:3px 0 8px;line-height:1.3}
.vs-clone-box{margin-top:18px;padding:16px;background:var(--surface);border:1px dashed var(--border2);border-radius:var(--radius2)}
.vs-vo-list{display:flex;flex-direction:column;gap:6px;margin-top:12px}
.vs-vo-row{display:flex;align-items:center;gap:10px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius3);padding:8px 12px}
.vs-vo-text{flex:1;font-size:12px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.vs-vo-dur{font-size:11px;font-family:var(--mono);color:var(--text3);min-width:38px;text-align:right}
.vs-vo-words{font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;background:var(--green-bg);color:var(--green);padding:2px 7px;border-radius:8px}
.vs-music{margin-top:14px;padding:14px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius2)}
.vs-music-head{font-size:13px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}
.vs-music-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.vs-music-name{font-size:12px;color:var(--text2);font-weight:600}
.vs-music-vol{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text3);font-weight:600}
.vs-music-vol input{accent-color:var(--blue);width:120px}
.vs-music-add{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.vs-music-add .yt-input{flex:1;min-width:220px}
.vs-render-ctrl{display:flex;gap:16px;align-items:end;margin-top:14px;flex-wrap:wrap}
.vs-progress{position:relative;height:26px;background:var(--surface2);border:1px solid var(--border);border-radius:13px;margin-top:16px;overflow:hidden}
.vs-progress-fill{height:100%;background:var(--blue);transition:width .3s;border-radius:13px}
.vs-progress-t{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--text)}
.vs-video-out{margin-top:18px}
.vs-video-player{width:100%;border-radius:var(--radius2);border:1px solid var(--border2);background:#000}
.vs-video-player.vert{max-width:380px;display:block;margin:0 auto}
`;
