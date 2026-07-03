import { useState, useEffect, useRef } from "react";
import {
  claude, parseJson, SYS_SCRIPT, SYS_STORYBOARD, SYS_SEO, STYLE_WRAP, VOICES,
  geminiImage, geminiTTS, concatPcm, pcmToWav, pcmToMp3, pexelsPhotos, urlToDataURL,
  makeZip, fmtTime, estDuration, renderVideo, loadImage, pickMime,
} from "./pipeline";

const STEPS = ["📝 Script", "🎬 Storyboard", "🖼️ Visuals", "🎙️ Voiceover", "🎞️ Render", "📦 SEO Package"];
const STYLES = [
  { id: "cinematic", n: "Cinematic AI", d: "Photoreal AI frames, Ken Burns, crossfades", ic: "🎥" },
  { id: "realasset", n: "Real Assets", d: "Documentary stills + Pexels b-roll sourcing", ic: "📷" },
  { id: "doodle", n: "Stickman Doodle", d: "Hand-drawn frames, hard cuts, no zoom", ic: "✏️" },
];

export default function Studio({ niche, ctx, clKey, gemKey, pexKey, back }) {
  const storeKey = `vr7-studio-${niche.id}-${ctx.histId || ctx.topic}`;
  const [step, setStep] = useState(0);
  const [style, setStyle] = useState("cinematic");
  const [dur, setDur] = useState("8");
  const [voice, setVoice] = useState("Charon");
  const [script, setScript] = useState("");
  const [scenes, setScenes] = useState([]); // {section,narration,visual,broll,overlay,img,credit,pcm,rate,imgErr,ttsErr}
  const [busy, setBusy] = useState("");
  const [st, setSt] = useState("");
  const [auto, setAuto] = useState(false);
  const [res, setRes] = useState("1280");
  const [subs, setSubs] = useState(true);
  const [renderProg, setRenderProg] = useState(-1);
  const [video, setVideo] = useState(null); // {url, ext, duration}
  const [seo, setSeo] = useState(null);
  const [pexPick, setPexPick] = useState(null); // {sceneIdx, results, query}
  const cancelRef = useRef(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storeKey) || "null");
      if (saved) {
        setScript(saved.script || ""); setStyle(saved.style || "cinematic"); setDur(saved.dur || "8"); setVoice(saved.voice || "Charon");
        setSeo(saved.seo || null);
        if (saved.scenes?.length) setScenes(saved.scenes.map(s => ({ ...s, img: null, pcm: null })));
      }
    } catch {}
  }, []);
  const persist = (patch = {}) => {
    try {
      const cur = { script, style, dur, voice, seo, scenes: scenes.map(({ img, pcm, imgErr, ttsErr, ...rest }) => rest), ...patch };
      if (patch.scenes) cur.scenes = patch.scenes.map(({ img, pcm, imgErr, ttsErr, ...rest }) => rest);
      localStorage.setItem(storeKey, JSON.stringify(cur));
    } catch {}
  };

  const setScene = (i, patch) => setScenes(prev => prev.map((s, j) => j === i ? { ...s, ...patch } : s));

  // ---- Stage 1: Script ----
  const genScript = async () => {
    if (!clKey) { setSt("⚠️ Set Anthropic API key on the Home page"); return ""; }
    setBusy("script"); setSt("📝 Writing full narration script...");
    try {
      const words = Math.round(+dur * 140);
      const guide = ctx.prompt ? `\n\nUse this creative brief as your guide for angle, facts and structure:\n${ctx.prompt.slice(0, 6000)}` : "";
      const r = await claude(SYS_SCRIPT, `Topic: ${ctx.topic}\nNiche: ${niche.name}${niche.desc ? ` — ${niche.desc}` : ""}\nVideo length: ${dur} minutes → target ≈${words} words.${guide}`, clKey, { maxTokens: 16000 });
      const clean = r.trim();
      setScript(clean); persist({ script: clean });
      setSt(`✅ Script ready (${clean.split(/\s+/).length} words ≈ ${fmtTime(clean.split(/\s+/).length / 2.6)})`);
      setBusy(""); return clean;
    } catch (e) { setSt("⚠️ " + e.message); setBusy(""); return ""; }
  };

  // ---- Stage 2: Storyboard ----
  const genStoryboard = async (scriptText) => {
    const src = scriptText || script;
    if (!src) { setSt("⚠️ Generate the script first"); return []; }
    setBusy("storyboard"); setSt("🎬 Breaking script into scenes...");
    try {
      const raw = await claude(SYS_STORYBOARD, `NICHE: ${niche.name}\nVISUAL STYLE: ${style}\n\nSCRIPT:\n${src}`, clKey, { maxTokens: 16000 });
      const arr = parseJson(raw).map(s => ({ section: s.section || "", narration: s.narration || "", visual: s.visual || "", broll: s.broll || [], overlay: s.overlay || "", img: null, credit: null, pcm: null, rate: 24000 }));
      setScenes(arr); persist({ scenes: arr });
      setSt(`✅ ${arr.length} scenes · est. runtime ${fmtTime(arr.reduce((t, s) => t + estDuration(s.narration), 0))}`);
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
      setScene(i, { img: url, imgLoading: false, credit: null });
    } catch (e) { setScene(i, { imgErr: e.message, imgLoading: false }); }
  };
  const genAllImages = async (list) => {
    const arr = list || scenes;
    setBusy("images");
    for (let i = 0; i < arr.length; i += 3) {
      if (cancelRef.current) break;
      setSt(`🖼️ Generating frames ${i + 1}-${Math.min(i + 3, arr.length)} of ${arr.length}...`);
      await Promise.all([0, 1, 2].map(k => i + k < arr.length ? genImage(i + k, arr) : null));
    }
    setSt("✅ Frames generated"); setBusy("");
  };
  const openPexels = async (i) => {
    if (!pexKey) { setSt("⚠️ Add a Pexels API key on the Home page for real-asset sourcing"); return; }
    const q = scenes[i].broll?.[0] || scenes[i].visual.slice(0, 40);
    setSt(`📷 Searching Pexels: "${q}"...`);
    try { setPexPick({ sceneIdx: i, query: q, results: await pexelsPhotos(q, pexKey, 8) }); setSt(""); }
    catch (e) { setSt("⚠️ " + e.message); }
  };
  const pickPexel = async (photo) => {
    const i = pexPick.sceneIdx;
    setPexPick(null); setScene(i, { imgLoading: true });
    try {
      const dataUrl = await urlToDataURL(photo.src);
      setScene(i, { img: dataUrl, imgLoading: false, credit: { photographer: photo.photographer, url: photo.url, source: "Pexels" } });
    } catch (e) { setScene(i, { imgErr: e.message, imgLoading: false }); }
  };

  // ---- Stage 4: Voiceover ----
  const ttsScene = async (i, list) => {
    const s = (list || scenes)[i];
    setScene(i, { ttsErr: null, ttsLoading: true });
    try {
      const { pcm, rate } = await geminiTTS(s.narration, voice, gemKey);
      setScene(i, { pcm, rate, ttsLoading: false });
      return { pcm, rate };
    } catch (e) { setScene(i, { ttsErr: e.message, ttsLoading: false }); return null; }
  };
  const ttsAll = async (list) => {
    if (!gemKey) { setSt("⚠️ Set Gemini API key"); return; }
    const arr = list || scenes;
    setBusy("tts");
    for (let i = 0; i < arr.length; i++) {
      if (cancelRef.current) break;
      setSt(`🎙️ Voicing scene ${i + 1}/${arr.length} (${voice})...`);
      await ttsScene(i, arr);
    }
    setSt("✅ Voiceover complete"); setBusy("");
  };
  const playScene = (s) => {
    const url = URL.createObjectURL(pcmToWav(s.pcm, s.rate));
    const a = new Audio(url); a.onended = () => URL.revokeObjectURL(url); a.play();
  };
  const voicedScenes = scenes.filter(s => s.pcm);
  const totalAudio = scenes.reduce((t, s) => t + (s.pcm ? s.pcm.length / s.rate : 0), 0);
  const dlVoiceover = (kind) => {
    if (!voicedScenes.length) return;
    const rate = voicedScenes[0].rate;
    const gapSamples = new Int16Array(Math.round(rate * 0.35));
    const parts = [];
    voicedScenes.forEach((s, i) => { parts.push(s.pcm); if (i < voicedScenes.length - 1) parts.push(gapSamples); });
    const pcm = concatPcm(parts);
    const blob = kind === "mp3" ? pcmToMp3(pcm, rate) : pcmToWav(pcm, rate);
    dlBlob(blob, `voiceover_${slug(ctx.topic)}.${kind}`);
  };

  // ---- Stage 5: Render ----
  const doRender = async () => {
    if (!scenes.length) { setSt("⚠️ Build the storyboard first"); return; }
    setBusy("render"); setRenderProg(0); setVideo(null);
    setSt("🎞️ Rendering in real time — keep this tab focused...");
    try {
      const prepared = [];
      for (const s of scenes) prepared.push({ ...s, imgEl: s.img ? await loadImage(s.img) : null });
      const w = +res, h = res === "1920" ? 1080 : 720;
      const out = await renderVideo({ scenes: prepared, style, width: w, height: h, subtitles: subs, onProgress: p => setRenderProg(p) });
      setVideo({ url: URL.createObjectURL(out.blob), ext: out.ext, duration: out.duration, size: out.blob.size });
      setSt(`✅ Video rendered — ${fmtTime(out.duration)} · ${(out.blob.size / 1048576).toFixed(1)} MB (${out.ext.toUpperCase()})`);
    } catch (e) { setSt("⚠️ " + e.message); }
    setRenderProg(-1); setBusy("");
  };

  // ---- Stage 6: SEO Package ----
  const genSeo = async () => {
    setBusy("seo"); setSt("📦 Building SEO package...");
    try {
      const raw = await claude(SYS_SEO, `Topic: "${ctx.topic}"\nNiche: ${niche.name}\nScript summary (first 800 chars):\n${script.slice(0, 800)}`, clKey);
      const pkg = parseJson(raw);
      setSeo(pkg); persist({ seo: pkg });
      setSt("✅ SEO package ready");
    } catch (e) { setSt("⚠️ " + e.message); }
    setBusy("");
  };
  const chapters = () => {
    let t = 0; const out = []; let last = "";
    scenes.forEach(s => {
      const d = s.pcm ? s.pcm.length / s.rate : estDuration(s.narration);
      if (s.section && s.section !== last) { out.push(`${fmtTime(t)} ${s.section}`); last = s.section; }
      t += d + 0.35;
    });
    return out;
  };
  const credits = () => scenes.filter(s => s.credit).map(s => `Photo by ${s.credit.photographer} on ${s.credit.source}: ${s.credit.url}`);
  const dlPackage = () => {
    const ch = chapters(), cr = credits();
    const seoTxt = seo ? [
      "=== TITLES ===", ...(seo.titles || []),
      "\n=== DESCRIPTION ===", seo.description || "",
      "\n=== CHAPTERS (paste into description) ===", ...ch,
      "\n=== TAGS ===", (seo.tags || []).join(", "),
      "\n=== PINNED COMMENT ===", seo.pinnedComment || "",
      ...(cr.length ? ["\n=== ATTRIBUTION / CREDITS (paste into description) ===", ...cr] : []),
    ].join("\n") : "Run Generate SEO first.";
    const files = [
      { name: "script.txt", data: script || "" },
      { name: "storyboard.json", data: JSON.stringify(scenes.map(({ img, pcm, ...r }) => r), null, 2) },
      { name: "seo_package.txt", data: seoTxt },
    ];
    dlBlob(makeZip(files), `${slug(ctx.topic)}_seo_package.zip`);
  };

  // ---- Autopilot (youtube-video-factory: one prompt → ready-to-render video) ----
  const autopilot = async () => {
    cancelRef.current = false; setAuto(true);
    let s = script;
    if (!s) { setStep(0); s = await genScript(); }
    if (!s || cancelRef.current) { setAuto(false); return; }
    setStep(1);
    const arr = scenes.length ? scenes : await genStoryboard(s);
    if (!arr.length || cancelRef.current) { setAuto(false); return; }
    setStep(2); await genAllImages(arr);
    if (cancelRef.current) { setAuto(false); return; }
    setStep(3); await ttsAll(arr);
    if (!cancelRef.current) { setStep(4); setSt("✅ Autopilot done — review, then hit Render"); }
    if (!seo && clKey) genSeo();
    setAuto(false);
  };

  const imgReady = scenes.filter(s => s.img).length;
  const disabled = !!busy || auto;

  return (<div className="yt-page vs-studio">
    <div className="yt-breadcrumb">
      <button className="yt-btn-o" onClick={back}>← Generator</button>
      <h1 className="yt-page-title">Storyboard Studio</h1>
      <span className="vs-topic-pill">{ctx.topic}</span>
    </div>

    <div className="vs-toolbar">
      <div className="vs-styles">{STYLES.map(x => <button key={x.id} className={`vs-style ${style === x.id ? "active" : ""}`} onClick={() => setStyle(x.id)} disabled={disabled}>
        <span className="vs-style-ic">{x.ic}</span><span className="vs-style-n">{x.n}</span><span className="vs-style-d">{x.d}</span>
      </button>)}</div>
      <div className="vs-toolbar-r">
        <div><label className="yt-label">Length</label><select className="yt-sel" value={dur} onChange={e => setDur(e.target.value)} disabled={disabled}><option value="1">~1 min short</option><option value="3">~3 min</option><option value="5">~5 min</option><option value="8">6–8 min</option><option value="12">10–12 min</option><option value="15">13–15 min</option></select></div>
        <div><label className="yt-label">Voice</label><select className="yt-sel" value={voice} onChange={e => setVoice(e.target.value)} disabled={disabled}>{VOICES.map(v => <option key={v}>{v}</option>)}</select></div>
        {!auto ? <button className="vs-btn-auto" onClick={autopilot} disabled={!!busy}>⚡ Autopilot</button>
          : <button className="vs-btn-auto vs-btn-cancel" onClick={() => { cancelRef.current = true; }}>⏹ Stop</button>}
      </div>
    </div>

    <div className="vs-steps">{STEPS.map((s, i) => {
      const done = [!!script, scenes.length > 0, imgReady > 0 && imgReady === scenes.length, voicedScenes.length > 0 && voicedScenes.length === scenes.length, !!video, !!seo][i];
      return <button key={i} className={`vs-step ${step === i ? "active" : ""} ${done ? "done" : ""}`} onClick={() => setStep(i)}>
        <span className="vs-step-num">{done ? "✓" : i + 1}</span>{s}
      </button>;
    })}</div>

    {st && <p className={`yt-st ${st[0] === "⚠" ? "err" : st[0] === "✅" ? "ok" : ""}`}>{st}</p>}

    {/* STEP 1 — SCRIPT */}
    {step === 0 && <div className="yt-card">
      <div className="yt-card-h"><span className="yt-card-ht">📝 Full Narration Script</span>
        <button className={`yt-btn ${busy === "script" ? "yt-btn-ld" : ""}`} onClick={genScript} disabled={disabled}>{busy === "script" ? "⏳ Writing..." : script ? "🔄 Rewrite" : "⚡ Write Script"}</button>
      </div>
      {ctx.prompt && <p className="yt-hint">Using your generated creative brief as the guide ({ctx.prompt.length.toLocaleString()} chars).</p>}
      <textarea className="yt-input vs-script-area" rows="18" value={script} onChange={e => setScript(e.target.value)} onBlur={() => persist()} placeholder="Hit ⚡ Write Script — or paste your own narration here. Mark sections with [SECTION: Name] lines."/>
      {script && <div className="vs-row-between"><span className="yt-hint">{script.split(/\s+/).filter(Boolean).length} words ≈ {fmtTime(script.split(/\s+/).filter(Boolean).length / 2.6)} runtime</span>
        <button className="yt-btn" onClick={() => { genStoryboard(); setStep(1); }} disabled={disabled}>Storyboard it →</button></div>}
    </div>}

    {/* STEP 2 — STORYBOARD */}
    {step === 1 && <div className="yt-card">
      <div className="yt-card-h"><span className="yt-card-ht">🎬 Storyboard — {scenes.length} scenes</span>
        <button className={`yt-btn ${busy === "storyboard" ? "yt-btn-ld" : ""}`} onClick={() => genStoryboard()} disabled={disabled || !script}>{busy === "storyboard" ? "⏳ Directing..." : scenes.length ? "🔄 Re-storyboard" : "⚡ Build Storyboard"}</button>
      </div>
      {!script && <p className="yt-hint">Write the script first (step 1).</p>}
      {scenes.map((s, i) => <div key={i} className="vs-scene">
        <div className="vs-scene-head"><span className="vs-scene-num">#{i + 1}</span><span className="vs-scene-sec">{s.section}</span><span className="vs-scene-dur">~{fmtTime(s.pcm ? s.pcm.length / s.rate : estDuration(s.narration))}</span>
          <button className="yt-x" onClick={() => { const n = scenes.filter((_, j) => j !== i); setScenes(n); persist({ scenes: n }); }}>✕</button></div>
        <label className="yt-label">Narration</label>
        <textarea className="yt-input vs-scene-area" rows="2" value={s.narration} onChange={e => setScene(i, { narration: e.target.value, pcm: null })} onBlur={() => persist()}/>
        <label className="yt-label">Visual prompt</label>
        <textarea className="yt-input vs-scene-area" rows="2" value={s.visual} onChange={e => setScene(i, { visual: e.target.value, img: null })} onBlur={() => persist()}/>
        <div className="vs-scene-meta">
          {s.broll?.length > 0 && <span className="vs-broll">🎞 B-roll: {s.broll.map((b, k) => <a key={k} href={`https://www.pexels.com/search/videos/${encodeURIComponent(b)}/`} target="_blank" rel="noreferrer">{b}</a>)}</span>}
          {s.overlay && <span className="vs-overlay-tag">🔤 {s.overlay}</span>}
        </div>
      </div>)}
      {scenes.length > 0 && <button className="yt-btn" onClick={() => setStep(2)} style={{ marginTop: 10 }}>Generate visuals →</button>}
    </div>}

    {/* STEP 3 — VISUALS */}
    {step === 2 && <div className="yt-card">
      <div className="yt-card-h"><span className="yt-card-ht">🖼️ Visuals — {imgReady}/{scenes.length} frames</span>
        <button className={`yt-btn ${busy === "images" ? "yt-btn-ld" : ""}`} onClick={() => genAllImages()} disabled={disabled || !scenes.length || !gemKey}>{busy === "images" ? "⏳ Generating..." : "⚡ Generate All Frames"}</button>
      </div>
      {!gemKey && <p className="yt-hint">⚠️ Add a Gemini API key on the Home page to generate frames.</p>}
      {style === "realasset" && <p className="yt-hint">📷 Real-asset mode: use “Pexels” on each scene to source a real photo (auto-credited in your SEO package), or generate a documentary-style AI frame.</p>}
      <div className="vs-frames">{scenes.map((s, i) => <div key={i} className="vs-frame">
        <div className="vs-frame-img">
          {s.imgLoading && <div className="yt-thumb-loader"><div className="yt-spin"/></div>}
          {!s.imgLoading && s.img && <img src={s.img} alt="" onClick={() => window.open(s.img)}/>}
          {!s.imgLoading && !s.img && <div className="vs-frame-empty">{s.imgErr ? `❌ ${s.imgErr}` : "No frame yet"}</div>}
          <span className="vs-frame-num">#{i + 1}</span>
          {s.credit && <span className="vs-frame-credit">📷 {s.credit.photographer}</span>}
        </div>
        <p className="vs-frame-cap">{s.visual.slice(0, 90)}{s.visual.length > 90 ? "…" : ""}</p>
        <div className="vs-frame-btns">
          <button className="yt-btn-remake" onClick={() => genImage(i)} disabled={s.imgLoading}>{s.img ? "🔄 Regen" : "⚡ Generate"}</button>
          {pexKey && <button className="yt-btn-remake" onClick={() => openPexels(i)} disabled={s.imgLoading}>📷 Pexels</button>}
        </div>
      </div>)}</div>
      {pexPick && <div className="vs-pex-modal" onClick={() => setPexPick(null)}><div className="vs-pex-box" onClick={e => e.stopPropagation()}>
        <div className="vs-row-between"><span className="yt-card-ht">📷 Pexels: “{pexPick.query}” → scene #{pexPick.sceneIdx + 1}</span><button className="yt-x" onClick={() => setPexPick(null)}>✕</button></div>
        <div className="vs-pex-grid">{pexPick.results.map((p, k) => <img key={k} src={p.thumb} alt={p.photographer} title={`by ${p.photographer}`} onClick={() => pickPexel(p)}/>)}</div>
        {!pexPick.results.length && <p className="yt-hint">No results — edit the b-roll keywords and retry.</p>}
      </div></div>}
      {imgReady > 0 && <button className="yt-btn" onClick={() => setStep(3)} style={{ marginTop: 12 }}>Voice it →</button>}
    </div>}

    {/* STEP 4 — VOICEOVER */}
    {step === 3 && <div className="yt-card">
      <div className="yt-card-h"><span className="yt-card-ht">🎙️ Voiceover — {voicedScenes.length}/{scenes.length} scenes · {fmtTime(totalAudio)}</span>
        <button className={`yt-btn ${busy === "tts" ? "yt-btn-ld" : ""}`} onClick={() => ttsAll()} disabled={disabled || !scenes.length || !gemKey}>{busy === "tts" ? "⏳ Voicing..." : "⚡ Voice All Scenes"}</button>
      </div>
      <p className="yt-hint">Gemini TTS · voice “{voice}” (change in the toolbar). Beat-synced: each scene's exact audio length drives the edit.</p>
      <div className="vs-vo-list">{scenes.map((s, i) => <div key={i} className="vs-vo-row">
        <span className="vs-scene-num">#{i + 1}</span>
        <span className="vs-vo-text">{s.narration.slice(0, 90)}{s.narration.length > 90 ? "…" : ""}</span>
        <span className="vs-vo-dur">{s.pcm ? fmtTime(s.pcm.length / s.rate) : s.ttsLoading ? "⏳" : s.ttsErr ? "❌" : "—"}</span>
        {s.pcm && <button className="yt-btn-remake" onClick={() => playScene(s)}>▶</button>}
        <button className="yt-btn-remake" onClick={() => ttsScene(i)} disabled={s.ttsLoading}>🔄</button>
      </div>)}</div>
      {voicedScenes.length > 0 && <div className="yt-btn-row" style={{ marginTop: 14 }}>
        <button className="yt-btn" onClick={() => dlVoiceover("mp3")}>⬇ Download MP3</button>
        <button className="yt-btn-o" onClick={() => dlVoiceover("wav")}>⬇ WAV</button>
        <button className="yt-btn" onClick={() => setStep(4)}>Render video →</button>
      </div>}
    </div>}

    {/* STEP 5 — RENDER */}
    {step === 4 && <div className="yt-card">
      <div className="yt-card-ht">🎞️ Render Final Video</div>
      <p className="yt-hint">Renders in-browser in real time (a {fmtTime(totalAudio || scenes.reduce((t, s) => t + estDuration(s.narration), 0))} video takes about that long). Ken Burns + crossfades{style === "doodle" ? " are OFF (doodle = hard cuts)" : ""}, karaoke subtitles {subs ? "ON" : "OFF"}. Keep the tab focused while rendering. {pickMime().includes("mp4") ? "Output: MP4." : "This browser records WebM (YouTube accepts it); Chrome outputs MP4."}</p>
      <div className="vs-render-ctrl">
        <div><label className="yt-label">Resolution</label><select className="yt-sel" value={res} onChange={e => setRes(e.target.value)} disabled={busy === "render"}><option value="1280">720p (faster)</option><option value="1920">1080p</option></select></div>
        <label className="yt-thumb-check" style={{ marginTop: 20 }}><input type="checkbox" checked={subs} onChange={e => setSubs(e.target.checked)}/><span>💬 Karaoke subtitles</span></label>
        <button className={`yt-btn-big ${busy === "render" ? "yt-btn-big-ld" : ""}`} style={{ flex: 1 }} onClick={doRender} disabled={disabled || !scenes.length}>{busy === "render" ? "⏳ Rendering..." : "🎬 Render Video"}</button>
      </div>
      {voicedScenes.length < scenes.length && scenes.length > 0 && <p className="yt-hint" style={{ marginTop: 8 }}>⚠️ {scenes.length - voicedScenes.length} scene(s) have no voiceover — they'll render silent with estimated timing.</p>}
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
        <button className={`yt-btn ${busy === "seo" ? "yt-btn-ld" : ""}`} onClick={genSeo} disabled={disabled || !clKey}>{busy === "seo" ? "⏳ Building..." : seo ? "🔄 Regenerate" : "⚡ Generate SEO"}</button>
      </div>
      {seo && <>
        <div className="yt-opt-section"><div className="yt-opt-h"><span className="yt-opt-label">📌 Titles</span></div>
          {(seo.titles || []).map((t, i) => <div key={i} className="yt-opt-title" onClick={() => navigator.clipboard.writeText(t)}><span className="yt-opt-num">{i + 1}</span><span>{t}</span></div>)}</div>
        <div className="yt-opt-section"><div className="yt-opt-h"><span className="yt-opt-label">📝 Description</span><button className="yt-btn-cp-sm" onClick={() => navigator.clipboard.writeText(seo.description || "")}>📋</button></div>
          <pre className="yt-pre yt-pre-sm">{seo.description}</pre></div>
        <div className="yt-opt-section"><div className="yt-opt-h"><span className="yt-opt-label">⏱ Chapters</span><button className="yt-btn-cp-sm" onClick={() => navigator.clipboard.writeText(chapters().join("\n"))}>📋</button></div>
          <pre className="yt-pre yt-pre-sm">{chapters().join("\n") || "Storyboard needed for chapters."}</pre></div>
        <div className="yt-opt-section"><div className="yt-opt-h"><span className="yt-opt-label">🏷️ Tags</span><button className="yt-btn-cp-sm" onClick={() => navigator.clipboard.writeText((seo.tags || []).join(", "))}>📋</button></div>
          <div className="yt-opt-tags">{(seo.tags || []).map((t, i) => <span key={i} className="yt-opt-tag" onClick={() => navigator.clipboard.writeText(t)}>{t}</span>)}</div></div>
        {seo.pinnedComment && <div className="yt-opt-section"><div className="yt-opt-h"><span className="yt-opt-label">📍 Pinned Comment</span></div><pre className="yt-pre yt-pre-sm">{seo.pinnedComment}</pre></div>}
        {credits().length > 0 && <div className="yt-opt-section"><div className="yt-opt-h"><span className="yt-opt-label">🙏 Attribution (auto-collected)</span></div><pre className="yt-pre yt-pre-sm">{credits().join("\n")}</pre></div>}
      </>}
      <div className="yt-btn-row" style={{ marginTop: 14 }}>
        <button className="yt-btn" onClick={dlPackage} disabled={!script && !scenes.length}>⬇ Download Package (.zip)</button>
        {voicedScenes.length > 0 && <button className="yt-btn-o" onClick={() => dlVoiceover("mp3")}>⬇ Voiceover MP3</button>}
        {video && <a className="yt-btn-o" href={video.url} download={`${slug(ctx.topic)}.${video.ext}`}>⬇ Video</a>}
      </div>
    </div>}

    <style>{STUDIO_CSS}</style>
  </div>);
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
.vs-style{display:flex;flex-direction:column;align-items:start;gap:2px;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius2);padding:10px 14px;cursor:pointer;font-family:var(--font);color:var(--text2);transition:all .2s;max-width:200px;text-align:left}
.vs-style:hover{border-color:var(--border2)}
.vs-style.active{border-color:var(--red);background:var(--red-bg);color:var(--text)}
.vs-style-ic{font-size:18px}.vs-style-n{font-size:13px;font-weight:700;color:var(--text)}.vs-style-d{font-size:10px;color:var(--text3);line-height:1.3}
.vs-toolbar-r{display:flex;gap:12px;align-items:end}
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
.vs-frames{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;margin-top:14px}
.vs-frame{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius2);overflow:hidden}
.vs-frame-img{position:relative;aspect-ratio:16/9;background:var(--bg)}
.vs-frame-img img{width:100%;height:100%;object-fit:cover;cursor:zoom-in;display:block}
.vs-frame-empty{display:flex;align-items:center;justify-content:center;height:100%;font-size:11px;color:var(--text3);padding:10px;text-align:center}
.vs-frame-num{position:absolute;top:6px;left:6px;background:rgba(0,0,0,.7);color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:5px}
.vs-frame-credit{position:absolute;bottom:6px;left:6px;background:rgba(0,0,0,.7);color:#fff;font-size:9px;padding:2px 7px;border-radius:5px}
.vs-frame-cap{font-size:11px;color:var(--text3);padding:8px 10px 4px;line-height:1.4}
.vs-frame-btns{display:flex;gap:6px;padding:6px 10px 10px}
.vs-pex-modal{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px}
.vs-pex-box{background:var(--bg2);border:1px solid var(--border2);border-radius:var(--radius);padding:20px;max-width:760px;width:100%;max-height:80vh;overflow-y:auto}
.vs-pex-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-top:14px}
.vs-pex-grid img{width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:8px;cursor:pointer;border:2px solid transparent;transition:all .15s}
.vs-pex-grid img:hover{border-color:var(--red);transform:scale(1.02)}
.vs-vo-list{display:flex;flex-direction:column;gap:6px;margin-top:12px}
.vs-vo-row{display:flex;align-items:center;gap:10px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius3);padding:8px 12px}
.vs-vo-text{flex:1;font-size:12px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vs-vo-dur{font-size:11px;font-family:var(--mono);color:var(--text3);min-width:38px;text-align:right}
.vs-render-ctrl{display:flex;gap:16px;align-items:end;margin-top:14px;flex-wrap:wrap}
.vs-progress{position:relative;height:26px;background:var(--surface2);border:1px solid var(--border);border-radius:13px;margin-top:16px;overflow:hidden}
.vs-progress-fill{height:100%;background:linear-gradient(90deg,var(--red),#ff7a3c);transition:width .3s;border-radius:13px}
.vs-progress-t{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff}
.vs-video-out{margin-top:18px}
.vs-video-player{width:100%;border-radius:var(--radius2);border:1px solid var(--border2);background:#000}
`;
