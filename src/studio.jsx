import { useState, useEffect, useRef } from "react";
import {
  claude, parseJson, SYS_SCRIPT, SYS_STORYBOARD, SYS_SEO, STYLE_WRAP,
  geminiImage, geminiTTS, concatPcm, pcmToWav, pcmToMp3,
  coverrVideos, pixabayVideos, pixabayPhotos, pexelsVideos, pexelsPhotos, sourceRealAsset, urlToBlobUrl, urlToDataURL,
  makeZip, fmtTime, estDuration, renderVideo, loadImage, loadVideoEl, pickMime,
} from "./pipeline";
import { GEMINI_VOICES, ELEVENLABS_VOICES, MINIMAX_VOICES, ai33ListVoices, ai33TTS, ai33Clone, ai33DeleteClone, ai33Suno, decodeAudioBuffer, decodeToPcm24k, AI33_DEFAULT_BASE } from "./ai33";
import { SeoView } from "./seoview";
import { usePopIn } from "./anim";

const STEPS = ["📝 Script", "🎬 Storyboard", "🖼️ Visuals", "🎙️ Voiceover", "🎞️ Render", "📦 SEO Package"];
const STYLES = [
  { id: "cinematic", n: "Cinematic AI", d: "Photoreal AI frames, Ken Burns, fast cuts", ic: "🎥" },
  { id: "realasset", n: "Real Assets", d: "Coverr + Pixabay clips/photos, Pexels fallback", ic: "📷" },
  { id: "doodle", n: "Stickman Doodle", d: "Hand-drawn frames, hard cuts, no zoom", ic: "✏️" },
];
const ls = (k, fb) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } };
const ss = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

export default function Studio({ niche, ctx, clKey, gemKey, pexKey, pixKey, covKey, ai33Key, ai33Base, back, addH, updateH }) {
  const storeKey = `vr7-studio-${niche.id}-${ctx.histId || ctx.topic}`;
  const [step, setStep] = useState(0);
  const [style, setStyle] = useState("cinematic");
  const [dur, setDur] = useState("5");
  const [voiceSel, setVoiceSel] = useState(() => ls("vr7-voice", { provider: "gemini", id: "Charon", name: "Charon" }));
  const [voiceModal, setVoiceModal] = useState(false);
  const [script, setScript] = useState("");
  const [scenes, setScenes] = useState([]); // {section,narration,visual,broll,overlay,img,video:{blobUrl,thumb},credit,imgErr,imgLoading}
  const [audioSegs, setAudioSegs] = useState([]); // parallel to sections: {pcm,rate,loading,err}
  const [busy, setBusy] = useState("");
  const [st, setSt] = useState("");
  const [auto, setAuto] = useState(false);
  const [res, setRes] = useState("1280");
  const [subs, setSubs] = useState(true);
  const [renderProg, setRenderProg] = useState(-1);
  const [video, setVideo] = useState(null);
  const [seo, setSeo] = useState(null);
  const [srcPick, setSrcPick] = useState(null); // {sceneIdx, query, tab, results, loading}
  const [music, setMusic] = useState(null); // {name, buffer: AudioBuffer, url}
  const [musicVol, setMusicVol] = useState(0.12);
  const [musicPrompt, setMusicPrompt] = useState("");
  const [musicProg, setMusicProg] = useState(-1);
  const panelRef = usePopIn([step]);
  const cancelRef = useRef(false);
  const assetKeys = { coverr: covKey, pixabay: pixKey, pexels: pexKey };

  useEffect(() => {
    const saved = ls(storeKey, null);
    if (saved) {
      setScript(saved.script || ""); setStyle(saved.style || "cinematic"); setDur(saved.dur || "5"); setSeo(saved.seo || null);
      if (saved.scenes?.length) setScenes(saved.scenes.map(s => ({ ...s, img: null, video: null, credit: null })));
    }
  }, []);
  const persist = (patch = {}) => {
    const cur = { script, style, dur, seo, scenes: scenes.map(({ img, video, credit, imgErr, imgLoading, ...rest }) => rest), ...patch };
    if (patch.scenes) cur.scenes = patch.scenes.map(({ img, video, credit, imgErr, imgLoading, ...rest }) => rest);
    ss(storeKey, cur);
  };
  const pickVoice = v => { setVoiceSel(v); ss("vr7-voice", v); setVoiceModal(false); setAudioSegs([]); };

  // Sections = consecutive scenes sharing a section name. Voiceover is generated per section
  // (natural prosody), then timing is distributed across the 3-5s shots by word count.
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
    if ("narration" in patch) { const si = sectionOfScene(i); if (si >= 0) setSeg(si, null); }
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
      if (seg?.pcm) segsOut.push({ pcm: seg.pcm, rate: seg.rate, start: t });
      inScenes.forEach((s, k) => { const d = segDur * wcs[k] / totW; shots.push({ ...s, section: sec.name, start: t, duration: d }); t += d; });
      t += 0.25;
    });
    return { shots, audioSegs: segsOut, total: t };
  };
  const totalRuntime = () => buildTimeline().total;

  // ---- Stage 1: Script ----
  const genScript = async () => {
    if (!clKey) { setSt("⚠️ Set Anthropic API key in Settings"); return ""; }
    setBusy("script"); setSt("📝 Writing full narration script...");
    try {
      const words = Math.round(+dur * 140);
      const guide = ctx.prompt ? `\n\nUse this creative brief (built from your competitor research) as your guide for angle, facts and structure:\n${ctx.prompt.slice(0, 6000)}` : "";
      const r = await claude(SYS_SCRIPT, `Topic: ${ctx.topic}\nNiche: ${niche.name}${niche.desc ? ` — ${niche.desc}` : ""}\nVideo length: ${dur} minutes → target ≈${words} words.${guide}`, clKey, { maxTokens: 16000 });
      const clean = r.trim();
      setScript(clean); persist({ script: clean });
      setSt(`✅ Script ready (${clean.split(/\s+/).length} words ≈ ${fmtTime(clean.split(/\s+/).length / 2.6)})`);
      setBusy(""); return clean;
    } catch (e) { setSt("⚠️ " + e.message); setBusy(""); return ""; }
  };

  // ---- Stage 2: Storyboard (3-5s shots) ----
  const genStoryboard = async (scriptText) => {
    const src = scriptText || script;
    if (!src) { setSt("⚠️ Generate the script first"); return []; }
    setBusy("storyboard"); setSt("🎬 Cutting script into 3-5s shots...");
    try {
      const raw = await claude(SYS_STORYBOARD, `NICHE: ${niche.name}\nVISUAL STYLE: ${style}\n\nSCRIPT:\n${src}`, clKey, { maxTokens: 32000 });
      const arr = parseJson(raw).map(s => ({ section: s.section || "", narration: s.narration || "", visual: s.visual || "", broll: s.broll || [], overlay: s.overlay || "", img: null, video: null, credit: null }));
      setScenes(arr); setAudioSegs([]); persist({ scenes: arr });
      setSt(`✅ ${arr.length} shots (3-5s each) · est. runtime ${fmtTime(arr.reduce((t, s) => t + estDuration(s.narration), 0))}`);
      setBusy(""); return arr;
    } catch (e) { setSt("⚠️ " + e.message); setBusy(""); return []; }
  };

  // ---- Stage 3: Visuals ----
  const genImage = async (i, list) => {
    const s = (list || scenes)[i];
    if (!gemKey) { setScene(i, { imgErr: "No Gemini key" }); return; }
    setScene(i, { imgErr: null, imgLoading: true });
    try {
      const url = await geminiImage(STYLE_WRAP[style](s.visual), gemKey);
      setScene(i, { img: url, video: null, imgLoading: false, credit: null });
    } catch (e) { setScene(i, { imgErr: e.message, imgLoading: false }); }
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
        const blobUrl = await urlToBlobUrl(asset.src);
        setScene(i, { video: { blobUrl, thumb: asset.thumb }, img: null, credit, imgLoading: false });
      } else {
        const dataUrl = await urlToDataURL(asset.src);
        setScene(i, { img: dataUrl, video: null, credit, imgLoading: false });
      }
    } catch (e) { setScene(i, { imgErr: e.message, imgLoading: false }); }
  };
  const genAllVisuals = async (list) => {
    const arr = list || scenes;
    setBusy("images");
    for (let i = 0; i < arr.length; i += 3) {
      if (cancelRef.current) break;
      setSt(`${style === "realasset" ? "📷 Sourcing" : "🖼️ Generating"} shots ${i + 1}-${Math.min(i + 3, arr.length)} of ${arr.length}...`);
      await Promise.all([0, 1, 2].map(k => {
        if (i + k >= arr.length) return null;
        return style === "realasset" ? sourceScene(i + k, arr) : genImage(i + k, arr);
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

  // ---- Stage 4: Voiceover (per section, any provider) ----
  const speak = async (text) => {
    if (voiceSel.provider === "gemini") {
      if (!gemKey) throw new Error("Set Gemini API key for Gemini voices");
      return geminiTTS(text, voiceSel.id, gemKey);
    }
    if (!ai33Key) throw new Error("Set AI33 API key for ElevenLabs / MiniMax / Fish / cloned voices");
    // voiceSel.id is already provider-prefixed (elevenlabs_ / minimax_ / fishaudio_ / clone_)
    const buf = await ai33TTS(ai33Base || AI33_DEFAULT_BASE, ai33Key, { voiceId: voiceSel.id, text });
    return decodeToPcm24k(buf);
  };
  const ttsSection = async (si, list) => {
    const arr = list || scenes;
    const secs = computeSections(arr);
    const text = secs[si].idxs.map(i => arr[i].narration).join(" ");
    setSeg(si, { loading: true });
    try { const { pcm, rate } = await speak(text); setSeg(si, { pcm, rate }); return { pcm, rate }; }
    catch (e) { setSeg(si, { err: e.message }); return null; }
  };
  const ttsAll = async (list) => {
    const arr = list || scenes;
    const secs = computeSections(arr);
    const out = [];
    setBusy("tts");
    for (let si = 0; si < secs.length; si++) {
      if (cancelRef.current) break;
      if (audioSegs[si]?.pcm) { out[si] = audioSegs[si]; continue; }
      setSt(`🎙️ Voicing section ${si + 1}/${secs.length} — "${secs[si].name}" (${voiceSel.name})...`);
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
      const buffer = await decodeAudioBuffer(ab);
      setMusic({ name: file.name, buffer, url: URL.createObjectURL(file) });
      setSt(`✅ Music loaded: ${file.name} (${fmtTime(buffer.duration)})`);
    } catch (err) { setSt("⚠️ Could not decode that audio file: " + err.message); }
  };
  const genMusic = async () => {
    if (!ai33Key) { setSt("⚠️ Add your AI33 API key in Settings to generate music with Suno"); return; }
    const prompt = musicPrompt.trim() || `Instrumental background underscore for a ${niche.name} YouTube video about ${ctx.topic}. Cinematic, subtle, no vocals.`;
    setMusicProg(0); setBusy("music"); setSt("🎼 Suno composing (1–3 min)...");
    try {
      const { arrayBuffer, title } = await ai33Suno(ai33Base || AI33_DEFAULT_BASE, ai33Key, { prompt, instrumental: true, onProgress: p => setMusicProg(p) });
      const buffer = await decodeAudioBuffer(arrayBuffer.slice(0));
      setMusic({ name: title, buffer, url: URL.createObjectURL(new Blob([arrayBuffer], { type: "audio/mpeg" })) });
      setSt(`✅ Suno track ready: ${title} (${fmtTime(buffer.duration)})`);
    } catch (err) { setSt("⚠️ " + err.message); }
    setMusicProg(-1); setBusy("");
  };
  const musicPreviewRef = useRef(null);
  const previewMusic = () => {
    if (musicPreviewRef.current) { musicPreviewRef.current.pause(); musicPreviewRef.current = null; return; }
    const a = new Audio(music.url); a.volume = 0.6; a.play();
    musicPreviewRef.current = a;
    a.onended = () => { musicPreviewRef.current = null; };
  };

  // ---- Stage 5: Render ----
  const doRender = async () => {
    if (!scenes.length) { setSt("⚠️ Build the storyboard first"); return; }
    setBusy("render"); setRenderProg(0); setVideo(null);
    setSt("🎞️ Rendering in real time — keep this tab focused...");
    try {
      const { shots, audioSegs: segsOut, total } = buildTimeline();
      const prepared = [];
      for (const s of shots) prepared.push({
        ...s,
        imgEl: s.img ? await loadImage(s.img).catch(() => null) : null,
        vidEl: s.video?.blobUrl ? await loadVideoEl(s.video.blobUrl).catch(() => null) : null,
      });
      const w = +res, h = res === "1920" ? 1080 : 720;
      const out = await renderVideo({ shots: prepared, audioSegs: segsOut, total, music: music ? { buffer: music.buffer, volume: musicVol } : null, style, width: w, height: h, subtitles: subs, onProgress: p => setRenderProg(p) });
      setVideo({ url: URL.createObjectURL(out.blob), ext: out.ext, duration: out.duration, size: out.blob.size });
      setSt(`✅ Video rendered — ${fmtTime(out.duration)} · ${(out.blob.size / 1048576).toFixed(1)} MB (${out.ext.toUpperCase()})`);
    } catch (e) { setSt("⚠️ " + e.message); }
    setRenderProg(-1); setBusy("");
  };

  // ---- Stage 6: SEO Package (also saved to the Dashboard) ----
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
    setBusy("seo"); setSt("📦 Building SEO package...");
    try {
      const raw = await claude(SYS_SEO, `Topic: "${ctx.topic}"\nNiche: ${niche.name}\nScript summary (first 800 chars):\n${scr.slice(0, 800)}`, clKey);
      const pkg = { ...parseJson(raw), chapters: chapters(sceneList, segList), credits: credits(sceneList) };
      setSeo(pkg); persist({ seo: pkg });
      // Publish to the Dashboard SEO board
      let hid = ctx.histId;
      if (!hid && addH) { hid = addH(niche.id, ctx.topic, ctx.version || 1, ctx.prompt || "", ""); ctx.histId = hid; }
      if (hid && updateH) updateH(niche.id, hid, { seo: pkg });
      setSt("✅ SEO package ready — also pinned to your Dashboard");
    } catch (e) { setSt("⚠️ " + e.message); }
    setBusy("");
  };
  const dlPackage = () => {
    const seoTxt = seo ? [
      "=== TITLES ===", ...(seo.titles || []),
      "\n=== DESCRIPTION ===", seo.description || "",
      "\n=== CHAPTERS (paste into description) ===", ...(seo.chapters || []),
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
      <button className="yt-btn-o" onClick={back}>← Research</button>
      <h1 className="yt-page-title">Storyboard Studio</h1>
      <span className="vs-topic-pill">{ctx.topic}</span>
    </div>

    <div className="vs-toolbar">
      <div className="vs-styles">{STYLES.map(x => <button key={x.id} className={`vs-style ${style === x.id ? "active" : ""}`} onClick={() => setStyle(x.id)} disabled={disabled}>
        <span className="vs-style-ic">{x.ic}</span><span className="vs-style-n">{x.n}</span><span className="vs-style-d">{x.d}</span>
      </button>)}</div>
      <div className="vs-toolbar-r">
        <div><label className="yt-label">Length</label><select className="yt-sel" value={dur} onChange={e => setDur(e.target.value)} disabled={disabled}><option value="1">~1 min short</option><option value="3">~3 min</option><option value="5">~5 min</option><option value="8">6–8 min</option><option value="12">10–12 min</option><option value="15">13–15 min</option></select></div>
        <div><label className="yt-label">Voice</label>
          <button className="vs-voice-btn" onClick={() => setVoiceModal(true)} disabled={disabled}>
            🎙️ {voiceSel.name}<span className="vs-voice-prov">{voiceSel.provider}</span>
          </button>
        </div>
        {!auto ? <button className="vs-btn-auto" onClick={autopilot} disabled={!!busy}>⚡ Autopilot</button>
          : <button className="vs-btn-auto vs-btn-cancel" onClick={() => { cancelRef.current = true; }}>⏹ Stop</button>}
      </div>
    </div>

    <div className="vs-steps">{STEPS.map((s, i) => {
      const done = [!!script, scenes.length > 0, mediaReady > 0 && mediaReady === scenes.length, voicedCount > 0 && voicedCount === sections.length, !!video, !!seo][i];
      return <button key={i} className={`vs-step ${step === i ? "active" : ""} ${done ? "done" : ""}`} onClick={() => setStep(i)}>
        <span className="vs-step-num">{done ? "✓" : i + 1}</span>{s}
      </button>;
    })}</div>

    {st && <p className={`yt-st ${st[0] === "⚠" ? "err" : st[0] === "✅" ? "ok" : ""}`}>{st}</p>}

    <div ref={panelRef}>
    {/* STEP 1 — SCRIPT */}
    {step === 0 && <div className="yt-card">
      <div className="yt-card-h"><span className="yt-card-ht">📝 Full Narration Script</span>
        <button className={`yt-btn ${busy === "script" ? "yt-btn-ld" : ""}`} onClick={genScript} disabled={disabled}>{busy === "script" ? "⏳ Writing..." : script ? "🔄 Rewrite" : "⚡ Write Script"}</button>
      </div>
      {ctx.prompt ? <p className="yt-hint">✅ Connected to your research: the creative brief from the Generator ({ctx.prompt.length.toLocaleString()} chars) guides this script.</p>
        : <p className="yt-hint">Tip: generate a creative brief in the Generator first — your competitor research will then guide this script.</p>}
      <textarea className="yt-input vs-script-area" rows="18" value={script} onChange={e => setScript(e.target.value)} onBlur={() => persist()} placeholder="Hit ⚡ Write Script — or paste your own narration here. Mark sections with [SECTION: Name] lines."/>
      {script && <div className="vs-row-between"><span className="yt-hint">{script.split(/\s+/).filter(Boolean).length} words ≈ {fmtTime(script.split(/\s+/).filter(Boolean).length / 2.6)} runtime</span>
        <button className="yt-btn" onClick={() => { genStoryboard(); setStep(1); }} disabled={disabled}>Storyboard it →</button></div>}
    </div>}

    {/* STEP 2 — STORYBOARD */}
    {step === 1 && <div className="yt-card">
      <div className="yt-card-h"><span className="yt-card-ht">🎬 Storyboard — {scenes.length} shots · 3-5s each · {fmtTime(totalRuntime())}</span>
        <button className={`yt-btn ${busy === "storyboard" ? "yt-btn-ld" : ""}`} onClick={() => genStoryboard()} disabled={disabled || !script}>{busy === "storyboard" ? "⏳ Directing..." : scenes.length ? "🔄 Re-storyboard" : "⚡ Build Storyboard"}</button>
      </div>
      {!script && <p className="yt-hint">Write the script first (step 1).</p>}
      {scenes.map((s, i) => <div key={i} className="vs-scene">
        <div className="vs-scene-head"><span className="vs-scene-num">#{i + 1}</span><span className="vs-scene-sec">{s.section}</span><span className="vs-scene-dur">~{fmtTime(estDuration(s.narration))}</span>
          <button className="yt-x" onClick={() => { const n = scenes.filter((_, j) => j !== i); setScenes(n); setAudioSegs([]); persist({ scenes: n }); }}>✕</button></div>
        <label className="yt-label">Narration (8-14 words)</label>
        <textarea className="yt-input vs-scene-area" rows="1" value={s.narration} onChange={e => setScene(i, { narration: e.target.value })} onBlur={() => persist()}/>
        <label className="yt-label">Visual prompt</label>
        <textarea className="yt-input vs-scene-area" rows="2" value={s.visual} onChange={e => setScene(i, { visual: e.target.value, img: null })} onBlur={() => persist()}/>
        <div className="vs-scene-meta">
          {s.broll?.length > 0 && <span className="vs-broll">🎞 B-roll: {s.broll.map((b, k) => <a key={k} href={`https://pixabay.com/videos/search/${encodeURIComponent(b)}/`} target="_blank" rel="noreferrer">{b}</a>)}</span>}
          {s.overlay && <span className="vs-overlay-tag">🔤 {s.overlay}</span>}
        </div>
      </div>)}
      {scenes.length > 0 && <button className="yt-btn" onClick={() => setStep(2)} style={{ marginTop: 10 }}>Add visuals →</button>}
    </div>}

    {/* STEP 3 — VISUALS */}
    {step === 2 && <div className="yt-card">
      <div className="yt-card-h"><span className="yt-card-ht">🖼️ Visuals — {mediaReady}/{scenes.length} shots</span>
        <button className={`yt-btn ${busy === "images" ? "yt-btn-ld" : ""}`} onClick={() => genAllVisuals()} disabled={disabled || !scenes.length}>{busy === "images" ? "⏳ Working..." : style === "realasset" ? "⚡ Auto-Source All" : "⚡ Generate All Frames"}</button>
      </div>
      {style === "realasset"
        ? <p className="yt-hint">📷 Sourcing order: <b>Coverr</b> video → <b>Pixabay</b> video/photo → <b>Pexels</b> fallback. {!covKey && !pixKey && !pexKey ? "⚠️ Add at least one of those keys in Settings." : ""} Real clips play inside the final render; credits are auto-collected into your SEO package.</p>
        : !gemKey ? <p className="yt-hint">⚠️ Add a Gemini API key in Settings to generate frames.</p> : null}
      <div className="vs-frames">{scenes.map((s, i) => <div key={i} className="vs-frame">
        <div className="vs-frame-img">
          {s.imgLoading && <div className="yt-thumb-loader"><div className="yt-spin"/></div>}
          {!s.imgLoading && s.video && <video src={s.video.blobUrl} muted loop playsInline onMouseOver={e => e.target.play()} onMouseOut={e => e.target.pause()} poster={s.video.thumb}/>}
          {!s.imgLoading && !s.video && s.img && <img src={s.img} alt="" onClick={() => window.open(s.img)}/>}
          {!s.imgLoading && !s.img && !s.video && <div className="vs-frame-empty">{s.imgErr ? `❌ ${s.imgErr}` : "No media yet"}</div>}
          <span className="vs-frame-num">#{i + 1}</span>
          {s.video && <span className="vs-frame-kind">🎬 clip</span>}
          {s.credit && <span className="vs-frame-credit">{s.credit.source}</span>}
        </div>
        <p className="vs-frame-cap">{s.visual.slice(0, 80)}{s.visual.length > 80 ? "…" : ""}</p>
        <div className="vs-frame-btns">
          {style === "realasset" && <button className="yt-btn-remake" onClick={() => sourceScene(i)} disabled={s.imgLoading}>📷 Auto</button>}
          {(covKey || pixKey || pexKey) && <button className="yt-btn-remake" onClick={() => openSourcePicker(i)} disabled={s.imgLoading}>🔎 Pick</button>}
          <button className="yt-btn-remake" onClick={() => genImage(i)} disabled={s.imgLoading}>{style === "realasset" ? "🖼 AI" : s.img ? "🔄 Regen" : "⚡ Generate"}</button>
        </div>
      </div>)}</div>
      {srcPick && <div className="vs-pex-modal" onClick={() => setSrcPick(null)}><div className="vs-pex-box" onClick={e => e.stopPropagation()}>
        <div className="vs-row-between"><span className="yt-card-ht">🔎 Source shot #{srcPick.sceneIdx + 1}</span><button className="yt-x" onClick={() => setSrcPick(null)}>✕</button></div>
        <div className="vs-src-tabs">
          {covKey && <button className={`vs-src-tab ${srcPick.tab === "coverr" ? "active" : ""}`} onClick={() => loadSourceResults(srcPick.sceneIdx, srcPick.query, "coverr")}>Coverr</button>}
          {pixKey && <button className={`vs-src-tab ${srcPick.tab === "pixabay" ? "active" : ""}`} onClick={() => loadSourceResults(srcPick.sceneIdx, srcPick.query, "pixabay")}>Pixabay</button>}
          {pexKey && <button className={`vs-src-tab ${srcPick.tab === "pexels" ? "active" : ""}`} onClick={() => loadSourceResults(srcPick.sceneIdx, srcPick.query, "pexels")}>Pexels</button>}
          <input className="yt-input" style={{ maxWidth: 220 }} value={srcPick.query} onChange={e => setSrcPick(p => ({ ...p, query: e.target.value }))} onKeyDown={e => e.key === "Enter" && loadSourceResults(srcPick.sceneIdx, srcPick.query, srcPick.tab)}/>
          <button className="yt-btn" onClick={() => loadSourceResults(srcPick.sceneIdx, srcPick.query, srcPick.tab)}>Search</button>
        </div>
        {srcPick.loading && <div className="yt-ld-box"><div className="yt-spin"/></div>}
        {srcPick.err && <p className="yt-st err">⚠️ {srcPick.err}</p>}
        <div className="vs-pex-grid">{srcPick.results.map((r, k) => <div key={k} className="vs-src-item" onClick={() => { applyAsset(srcPick.sceneIdx, r); setSrcPick(null); }}>
          <img src={r.thumb} alt=""/><span className="vs-src-kind">{r.kind === "video" ? "🎬" : "🖼"} {r.source}</span>
        </div>)}</div>
        {!srcPick.loading && !srcPick.results.length && !srcPick.err && <p className="yt-hint">No results — try different keywords.</p>}
      </div></div>}
      {mediaReady > 0 && <button className="yt-btn" onClick={() => setStep(3)} style={{ marginTop: 12 }}>Voice it →</button>}
    </div>}

    {/* STEP 4 — VOICEOVER */}
    {step === 3 && <div className="yt-card">
      <div className="yt-card-h"><span className="yt-card-ht">🎙️ Voiceover — {voicedCount}/{sections.length} sections · {fmtTime(totalAudio)}</span>
        <div className="yt-btn-row">
          <button className="yt-btn-o" onClick={() => setVoiceModal(true)} disabled={disabled}>🎙️ {voiceSel.name} ({voiceSel.provider})</button>
          <button className={`yt-btn ${busy === "tts" ? "yt-btn-ld" : ""}`} onClick={() => ttsAll()} disabled={disabled || !scenes.length}>{busy === "tts" ? "⏳ Voicing..." : "⚡ Voice All Sections"}</button>
        </div>
      </div>
      <p className="yt-hint">Voiced per script section for natural prosody, then beat-synced across your 3-5s shots by word count.</p>
      <div className="vs-vo-list">{sections.map((sec, si) => { const seg = audioSegs[si]; return <div key={si} className="vs-vo-row">
        <span className="vs-scene-num">§{si + 1}</span>
        <span className="vs-vo-text"><b>{sec.name}</b> · {sec.idxs.length} shots — {scenes[sec.idxs[0]]?.narration.slice(0, 60)}…</span>
        <span className="vs-vo-dur">{seg?.pcm ? fmtTime(seg.pcm.length / seg.rate) : seg?.loading ? "⏳" : seg?.err ? "❌" : "—"}</span>
        {seg?.pcm && <button className="yt-btn-remake" onClick={() => playSeg(seg)}>▶</button>}
        <button className="yt-btn-remake" onClick={() => ttsSection(si)} disabled={seg?.loading}>🔄</button>
      </div>; })}</div>
      {audioSegs.some(s => s?.err) && <p className="yt-st err">⚠️ {audioSegs.find(s => s?.err)?.err}</p>}
      {voicedCount > 0 && <div className="yt-btn-row" style={{ marginTop: 14 }}>
        <button className="yt-btn" onClick={() => dlVoiceover("mp3")}>⬇ Download MP3</button>
        <button className="yt-btn-o" onClick={() => dlVoiceover("wav")}>⬇ WAV</button>
        <button className="yt-btn" onClick={() => setStep(4)}>Render video →</button>
      </div>}
    </div>}

    {/* STEP 5 — RENDER */}
    {step === 4 && <div className="yt-card">
      <div className="yt-card-ht">🎞️ Render Final Video</div>
      <div className="vs-music">
        <div className="vs-music-head">🎵 Background Music <span className="yt-hint" style={{margin:0}}>ducked under the voiceover, auto fade-out</span></div>
        {music ? <div className="vs-music-row">
          <span className="vs-music-name">🎵 {music.name} · {fmtTime(music.buffer.duration)}{music.buffer.duration < totalRuntime() ? " (loops)" : ""}</span>
          <button className="yt-btn-remake" onClick={previewMusic}>▶ / ⏸</button>
          <label className="vs-music-vol">Vol {Math.round(musicVol * 100)}%
            <input type="range" min="0" max="50" value={Math.round(musicVol * 100)} onChange={e => setMusicVol(+e.target.value / 100)}/>
          </label>
          <button className="yt-x" onClick={() => setMusic(null)}>✕</button>
        </div> : <div className="vs-music-add">
          <label className="yt-btn-o" style={{ cursor: "pointer" }}>
            <input type="file" accept="audio/*" style={{ display: "none" }} onChange={onMusicUpload}/>
            ⬆ Upload your music
          </label>
          <input className="yt-input" placeholder="…or describe a track for Suno (e.g. tense cinematic documentary underscore, no vocals)" value={musicPrompt} onChange={e => setMusicPrompt(e.target.value)}/>
          <button className={`yt-btn ${busy === "music" ? "yt-btn-ld" : ""}`} onClick={genMusic} disabled={busy === "music" || !ai33Key} title={!ai33Key ? "Needs AI33 API key" : ""}>{busy === "music" ? `⏳ ${musicProg > 0 ? musicProg + "%" : "Composing..."}` : "🎼 Generate (Suno)"}</button>
        </div>}
      </div>
      <p className="yt-hint">Renders in-browser in real time (≈{fmtTime(totalRuntime())}). Fast 3-5s cuts, {style === "doodle" ? "hard cuts (doodle rule)" : "Ken Burns on stills, real clips play live"}, karaoke subtitles {subs ? "ON" : "OFF"}. Keep the tab focused. {pickMime().includes("mp4") ? "Output: MP4." : "This browser records WebM (YouTube accepts it); Chrome outputs MP4."}</p>
      <div className="vs-render-ctrl">
        <div><label className="yt-label">Resolution</label><select className="yt-sel" value={res} onChange={e => setRes(e.target.value)} disabled={busy === "render"}><option value="1280">720p (faster)</option><option value="1920">1080p</option></select></div>
        <label className="yt-thumb-check" style={{ marginTop: 20 }}><input type="checkbox" checked={subs} onChange={e => setSubs(e.target.checked)}/><span>💬 Karaoke subtitles</span></label>
        <button className={`yt-btn-big ${busy === "render" ? "yt-btn-big-ld" : ""}`} style={{ flex: 1 }} onClick={doRender} disabled={disabled || !scenes.length}>{busy === "render" ? "⏳ Rendering..." : "🎬 Render Video"}</button>
      </div>
      {voicedCount < sections.length && scenes.length > 0 && <p className="yt-hint" style={{ marginTop: 8 }}>⚠️ {sections.length - voicedCount} section(s) not voiced — they'll render silent with estimated timing.</p>}
      {renderProg >= 0 && <div className="vs-progress"><div className="vs-progress-fill" style={{ width: `${Math.round(renderProg * 100)}%` }}/><span className="vs-progress-t">{Math.round(renderProg * 100)}%</span></div>}
      {video && <div className="vs-video-out">
        <video src={video.url} controls className="vs-video-player"/>
        <div className="yt-btn-row" style={{ marginTop: 12 }}>
          <a className="yt-btn" href={video.url} download={`${slug(ctx.topic)}.${video.ext}`}>⬇ Download {video.ext.toUpperCase()} ({(video.size / 1048576).toFixed(1)} MB)</a>
          <button className="yt-btn-o" onClick={() => setStep(5)}>SEO package →</button>
        </div>
      </div>}
    </div>}

    {/* STEP 6 — SEO PACKAGE */}
    {step === 5 && <div className="yt-card">
      <div className="yt-card-h"><span className="yt-card-ht">📦 SEO Package</span>
        <button className={`yt-btn ${busy === "seo" ? "yt-btn-ld" : ""}`} onClick={() => genSeo()} disabled={disabled || !clKey}>{busy === "seo" ? "⏳ Building..." : seo ? "🔄 Regenerate" : "⚡ Generate SEO"}</button>
      </div>
      <p className="yt-hint">Generated packages are pinned to your Dashboard home so you can copy them anytime.</p>
      {seo && <SeoView seo={seo}/>}
      <div className="yt-btn-row" style={{ marginTop: 14 }}>
        <button className="yt-btn" onClick={dlPackage} disabled={!script && !scenes.length}>⬇ Download Package (.zip)</button>
        {voicedCount > 0 && <button className="yt-btn-o" onClick={() => dlVoiceover("mp3")}>⬇ Voiceover MP3</button>}
        {video && <a className="yt-btn-o" href={video.url} download={`${slug(ctx.topic)}.${video.ext}`}>⬇ Video</a>}
      </div>
    </div>}

    </div>
    {voiceModal && <VoiceModal voiceSel={voiceSel} pick={pickVoice} close={() => setVoiceModal(false)} gemKey={gemKey} ai33Key={ai33Key} ai33Base={ai33Base}/>}
    <style>{STUDIO_CSS}</style>
  </div>);
}

// ---- Voice selection modal: Gemini + ai33.pro (ElevenLabs / MiniMax / Fish) + cloning ----
function VoiceModal({ voiceSel, pick, close, gemKey, ai33Key, ai33Base }) {
  const [tab, setTab] = useState(["gemini", "elevenlabs", "minimax", "fishaudio", "clone"].includes(voiceSel.provider) ? (voiceSel.provider === "clone" ? "clones" : voiceSel.provider) : "gemini");
  const [live, setLive] = useState({}); // provider → voices[]
  const [loading, setLoading] = useState("");
  const [err, setErr] = useState("");
  const [preview, setPreview] = useState("");
  const [search, setSearch] = useState("");
  const [clones, setClones] = useState(() => ls("vr7-clones", []));
  const [cloneName, setCloneName] = useState("");
  const [cloneFile, setCloneFile] = useState(null);
  const [cloning, setCloning] = useState(false);
  const b = ai33Base || AI33_DEFAULT_BASE;

  const TABS = [["gemini", "Gemini"], ["elevenlabs", "ElevenLabs"], ["minimax", "MiniMax"], ["fishaudio", "Fish Audio"], ["clones", "🧬 My Clones"]];
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
        const buf = await ai33TTS(b, ai33Key, { voiceId: v.id, text });
        ({ pcm, rate } = await decodeToPcm24k(buf));
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
    <div className="vs-row-between"><span className="yt-card-ht">🎙️ Choose a Voice</span><button className="yt-x" onClick={close}>✕</button></div>
    <div className="vs-src-tabs">{TABS.map(([id, n]) => <button key={id} className={`vs-src-tab ${tab === id ? "active" : ""}`} onClick={() => { setTab(id); setErr(""); }}>{n}</button>)}</div>
    <div className="vs-src-tabs" style={{ marginTop: 8 }}>
      <input className="yt-input" style={{ maxWidth: 260 }} placeholder="Search voices..." value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === "Enter" && tab !== "gemini" && loadLive(tab)}/>
      {tab !== "gemini" && <button className="yt-btn-o" onClick={() => loadLive(tab)} disabled={loading === tab}>{loading === tab ? "⏳ Loading..." : "🔄 Load from AI33"}</button>}
    </div>
    {tab !== "gemini" && !ai33Key && <p className="yt-hint">⚠️ These voices run through your AI33 account (api.ai33.pro) — add the API key in Settings.{tab === "elevenlabs" || tab === "minimax" ? " Built-in catalog shown below." : ""}</p>}
    {tab === "fishaudio" && !lists.fishaudio.length && <p className="yt-hint">Fish Audio voices load live from AI33 (sorted by trending) — hit "🔄 Load from AI33".</p>}
    {err && <p className="yt-st err">⚠️ {err}</p>}
    <div className="vs-voice-grid">{lists[tab].map(v => <div key={v.provider + v.id} className={`vs-voice-card ${voiceSel.id === v.id ? "active" : ""}`}>
      <div className="vs-voice-n">{v.name}</div>
      <div className="vs-voice-d">{v.desc}</div>
      <div className="vs-frame-btns">
        <button className="yt-btn-remake" onClick={() => doPreview(v)} disabled={preview === v.id}>{preview === v.id ? "⏳" : "▶ Preview"}</button>
        <button className="yt-btn-use-sm" onClick={() => pick({ provider: v.provider, id: v.id, name: v.name })}>Use</button>
        {tab === "clones" && <button className="yt-btn-remake" onClick={() => doDeleteClone(v)}>🗑</button>}
      </div>
    </div>)}</div>
    {tab === "clones" && <div className="vs-clone-box">
      <div className="yt-card-ht" style={{ marginBottom: 8 }}>🧬 Clone a new voice (uploads to AI33)</div>
      <p className="yt-hint">Upload 30s–3min of clean speech (mp3/wav, max 10MB). The sample is sent to your AI33 account, cloned there, and the new voice appears above ready to use.</p>
      <div className="yt-input-row" style={{ marginTop: 8 }}>
        <input className="yt-input" placeholder="Voice name, e.g. My Narrator" value={cloneName} onChange={e => setCloneName(e.target.value)}/>
        <label className="yt-btn-o" style={{ cursor: "pointer" }}>
          <input type="file" accept="audio/*" style={{ display: "none" }} onChange={e => setCloneFile(e.target.files?.[0] || null)}/>
          {cloneFile ? `🎵 ${cloneFile.name.slice(0, 24)}` : "🎵 Pick audio file"}
        </label>
        <button className={`yt-btn ${cloning ? "yt-btn-ld" : ""}`} onClick={doClone} disabled={cloning}>{cloning ? "⏳ Cloning..." : "🧬 Clone Voice"}</button>
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
.vs-style{display:flex;flex-direction:column;align-items:start;gap:2px;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius2);padding:10px 14px;cursor:pointer;font-family:var(--font);color:var(--text2);transition:all .2s;max-width:210px;text-align:left}
.vs-style:hover{border-color:var(--border2)}
.vs-style.active{border-color:var(--red);background:var(--red-bg);color:var(--text)}
.vs-style-ic{font-size:18px}.vs-style-n{font-size:13px;font-weight:700;color:var(--text)}.vs-style-d{font-size:10px;color:var(--text3);line-height:1.3}
.vs-toolbar-r{display:flex;gap:12px;align-items:end}
.vs-voice-btn{display:flex;align-items:center;gap:8px;background:var(--bg);border:1px solid var(--border2);border-radius:var(--radius3);padding:10px 14px;color:var(--text);font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font);white-space:nowrap;transition:all .2s}
.vs-voice-btn:hover{border-color:var(--red)}
.vs-voice-prov{font-size:9px;text-transform:uppercase;letter-spacing:.5px;background:var(--surface3);padding:2px 7px;border-radius:6px;color:var(--text2)}
.vs-btn-auto{background:linear-gradient(135deg,#7c3aed 0%,#4f46e5 100%);border:none;border-radius:var(--radius2);padding:12px 22px;color:#fff;font-size:14px;font-weight:700;cursor:pointer;font-family:var(--font);transition:all .25s;white-space:nowrap}
.vs-btn-auto:hover{box-shadow:0 6px 24px rgba(124,58,237,.4);transform:translateY(-1px)}
.vs-btn-auto:disabled{opacity:.4;transform:none;box-shadow:none}
.vs-btn-cancel{background:var(--bg4)}
.vs-steps{display:flex;gap:6px;margin-bottom:18px;flex-wrap:wrap}
.vs-step{display:flex;align-items:center;gap:8px;background:var(--bg3);border:1px solid var(--border);border-radius:20px;padding:8px 16px;color:var(--text2);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font);transition:all .2s}
.vs-step:hover{border-color:var(--border2);color:var(--text)}
.vs-step.active{border-color:var(--red);background:var(--red-bg);color:var(--text)}
.vs-step.done .vs-step-num{background:var(--green);color:#04150d}
.vs-step-num{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:var(--surface3);font-size:10px;font-weight:700}
.vs-script-area{font-family:var(--mono);font-size:13px;line-height:1.6;resize:vertical;margin-top:10px}
.vs-row-between{display:flex;justify-content:space-between;align-items:center;margin-top:10px;gap:10px;flex-wrap:wrap}
.vs-scene{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius2);padding:14px;margin-top:12px}
.vs-scene-head{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.vs-scene-num{background:var(--red);color:#fff;font-size:10px;font-weight:700;padding:3px 8px;border-radius:6px;flex-shrink:0}
.vs-scene-sec{font-size:12px;font-weight:600;color:var(--text2);flex:1}
.vs-scene-dur{font-size:11px;color:var(--text3);font-family:var(--mono)}
.vs-scene-area{font-size:13px;resize:vertical;margin-bottom:8px}
.vs-scene-meta{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--text3)}
.vs-broll a{color:var(--blue);margin-left:6px;text-decoration:none}
.vs-broll a:hover{text-decoration:underline}
.vs-overlay-tag{color:var(--text2)}
.vs-frames{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin-top:14px}
.vs-frame{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius2);overflow:hidden}
.vs-frame-img{position:relative;aspect-ratio:16/9;background:var(--bg)}
.vs-frame-img img,.vs-frame-img video{width:100%;height:100%;object-fit:cover;cursor:zoom-in;display:block}
.vs-frame-empty{display:flex;align-items:center;justify-content:center;height:100%;font-size:11px;color:var(--text3);padding:10px;text-align:center}
.vs-frame-num{position:absolute;top:6px;left:6px;background:rgba(0,0,0,.7);color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:5px}
.vs-frame-kind{position:absolute;top:6px;right:6px;background:rgba(0,0,0,.7);color:#fff;font-size:9px;padding:2px 7px;border-radius:5px}
.vs-frame-credit{position:absolute;bottom:6px;left:6px;background:rgba(0,0,0,.7);color:#fff;font-size:9px;padding:2px 7px;border-radius:5px}
.vs-frame-cap{font-size:11px;color:var(--text3);padding:8px 10px 4px;line-height:1.4}
.vs-frame-btns{display:flex;gap:6px;padding:6px 10px 10px;flex-wrap:wrap}
.vs-pex-modal{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px}
.vs-pex-box{background:var(--bg2);border:1px solid var(--border2);border-radius:var(--radius);padding:20px;max-width:800px;width:100%;max-height:82vh;overflow-y:auto}
.vs-voice-box{max-width:860px}
.vs-src-tabs{display:flex;gap:8px;align-items:center;margin-top:14px;flex-wrap:wrap}
.vs-src-tab{background:var(--bg3);border:1px solid var(--border);border-radius:20px;padding:7px 16px;color:var(--text2);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font);transition:all .2s}
.vs-src-tab.active{border-color:var(--red);background:var(--red-bg);color:var(--text)}
.vs-pex-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-top:14px}
.vs-src-item{position:relative;cursor:pointer;border:2px solid transparent;border-radius:8px;overflow:hidden;transition:all .15s}
.vs-src-item:hover{border-color:var(--red);transform:scale(1.02)}
.vs-src-item img{width:100%;aspect-ratio:16/10;object-fit:cover;display:block}
.vs-src-kind{position:absolute;bottom:4px;left:4px;background:rgba(0,0,0,.75);color:#fff;font-size:9px;padding:2px 7px;border-radius:5px}
.vs-voice-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px;margin-top:14px}
.vs-voice-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius2);padding:12px}
.vs-voice-card.active{border-color:var(--red);background:var(--red-bg)}
.vs-voice-n{font-size:13px;font-weight:700;color:var(--text)}
.vs-voice-d{font-size:10px;color:var(--text3);margin:3px 0 8px;line-height:1.3}
.vs-clone-box{margin-top:18px;padding:16px;background:var(--surface);border:1px dashed var(--border2);border-radius:var(--radius2)}
.vs-vo-list{display:flex;flex-direction:column;gap:6px;margin-top:12px}
.vs-vo-row{display:flex;align-items:center;gap:10px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius3);padding:8px 12px}
.vs-vo-text{flex:1;font-size:12px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vs-vo-dur{font-size:11px;font-family:var(--mono);color:var(--text3);min-width:38px;text-align:right}
.vs-music{margin-top:14px;padding:14px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius2)}
.vs-music-head{font-size:13px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}
.vs-music-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.vs-music-name{font-size:12px;color:var(--text2);font-weight:600}
.vs-music-vol{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text3);font-weight:600}
.vs-music-vol input{accent-color:var(--red);width:120px}
.vs-music-add{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.vs-music-add .yt-input{flex:1;min-width:220px}
.vs-render-ctrl{display:flex;gap:16px;align-items:end;margin-top:14px;flex-wrap:wrap}
.vs-progress{position:relative;height:26px;background:var(--surface2);border:1px solid var(--border);border-radius:13px;margin-top:16px;overflow:hidden}
.vs-progress-fill{height:100%;background:linear-gradient(90deg,var(--red),#ff7a3c);transition:width .3s;border-radius:13px}
.vs-progress-t{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff}
.vs-video-out{margin-top:18px}
.vs-video-player{width:100%;border-radius:var(--radius2);border:1px solid var(--border2);background:#000}
`;
