import { useState, useRef } from "react";
import { claudeVisionMulti, groqTranscribeSegments, extractAudioWav16k, parseJson, fmtTime } from "./pipeline";

// Learn from a video: detect shots frame-by-frame, extract keyframes, transcribe the audio,
// and have Claude reverse-engineer the video's structure into a reusable template (Video DNA)
// that the Studio replicates — hook style, phase order (real footage vs b-roll vs graphics),
// cut pacing, narration devices.

const ls = (k, fb) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } };
const ss = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

const SYS_DNA = `You are a video structure analyst. You receive keyframes from a YouTube video in chronological order (one per detected shot, with timestamps) plus its transcript. Reverse-engineer HOW this video works so another video on a different topic can replicate the exact structure.
Look frame by frame: which shots are REAL footage (archival, news, phone clips, interviews), which are stock b-roll, which are AI/graphics/text cards, when narration starts relative to the visuals, how the hook works, how the pacing changes across the video.
Return ONLY JSON:
{
 "summary": "2-3 sentences on how this video works",
 "hook": {"seconds": 12, "technique": "what happens before/at the start of narration"},
 "phases": [{"name":"cold open","startPct":0,"endPct":8,"visual":"real archival footage of the subject","audio":"natural sound, no narration yet","notes":"..."}],
 "pacing": {"avgShotSeconds": 3.2, "notes": "how cut speed changes across the video"},
 "visualMix": {"realFootagePct": 40, "brollPct": 35, "graphicsPct": 25},
 "narration": {"tone": "...", "devices": ["open loops","direct address"], "notes": "..."},
 "overlays": "on-screen text usage", "subtitles": "caption style if any", "music": "music/sfx usage",
 "replicationRules": ["Open with 8-12s of real footage of the actual subject before any narration", "..."]
}
Phases must cover 0-100% in order. Be concrete and prescriptive — these rules drive an automated video builder.`;

function seekTo(v, t) {
  return new Promise(res => {
    const done = () => { v.removeEventListener("seeked", done); res(); };
    v.addEventListener("seeked", done);
    v.currentTime = t;
    setTimeout(done, 1500);
  });
}

async function detectShots(v, onProgress) {
  const dur = Math.min(v.duration || 0, 1200);
  const step = dur > 600 ? 1 : 0.5;
  const c = document.createElement("canvas"); c.width = 64; c.height = 36;
  const g = c.getContext("2d", { willReadFrequently: true });
  let prev = null;
  const bounds = [0];
  for (let t = 0; t < dur; t += step) {
    await seekTo(v, t);
    g.drawImage(v, 0, 0, 64, 36);
    const d = g.getImageData(0, 0, 64, 36).data;
    if (prev) {
      let diff = 0;
      for (let i = 0; i < d.length; i += 16) diff += Math.abs(d[i] - prev[i]) + Math.abs(d[i + 1] - prev[i + 1]) + Math.abs(d[i + 2] - prev[i + 2]);
      if (diff / (d.length / 16) > 55) bounds.push(t);
    }
    prev = d.slice(0);
    if (onProgress) onProgress(t / dur);
  }
  const shots = [];
  for (let i = 0; i < bounds.length; i++) shots.push({ start: bounds[i], end: bounds[i + 1] ?? dur });
  return shots.filter(s => s.end - s.start >= 0.4);
}

async function grabKeyframes(v, shots, max = 36) {
  const picked = shots.length <= max ? shots : Array.from({ length: max }, (_, i) => shots[Math.floor(i * shots.length / max)]);
  const c = document.createElement("canvas");
  const scale = 360 / v.videoWidth;
  c.width = 360; c.height = Math.round(v.videoHeight * scale);
  const g = c.getContext("2d");
  const frames = [];
  for (const s of picked) {
    await seekTo(v, s.start + Math.min(0.5, (s.end - s.start) / 2));
    g.drawImage(v, 0, 0, c.width, c.height);
    frames.push({ t: s.start, dur: s.end - s.start, img: c.toDataURL("image/jpeg", 0.55) });
  }
  return frames;
}

export default function Vision({ clKey, groqKey }) {
  const [templates, setTemplates] = useState(() => ls("vr8-templates", []));
  const [file, setFile] = useState(null);
  const [phase, setPhase] = useState("");     // shots | frames | audio | dna | done
  const [prog, setProg] = useState(0);
  const [frames, setFrames] = useState([]);
  const [dna, setDna] = useState(null);
  const [meta, setMeta] = useState(null);     // {duration, shots, avgShot}
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const videoRef = useRef(null);
  const running = phase && phase !== "done";

  const saveTemplates = t => { setTemplates(t); ss("vr8-templates", t); };

  const analyze = async (f) => {
    if (!clKey) { setErr("Add your Anthropic key in Settings first — Claude does the visual analysis."); return; }
    setErr(""); setDna(null); setFrames([]); setMeta(null); setFile(f);
    const url = URL.createObjectURL(f);
    const v = videoRef.current;
    v.src = url; v.muted = true;
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error("Could not open this video file")); }).catch(e => { setErr(e.message); });
    if (!isFinite(v.duration)) {
      // WebM files from screen/canvas recorders report Infinity until forced to resolve
      await new Promise(res => { v.ondurationchange = () => isFinite(v.duration) && res(); v.currentTime = 1e7; setTimeout(res, 3000); });
      v.currentTime = 0;
    }
    if (!v.duration || !isFinite(v.duration)) { setErr("Could not read this video's duration — try re-encoding it as MP4"); return; }
    try {
      setPhase("shots"); setProg(0);
      const shots = await detectShots(v, setProg);
      const avgShot = shots.reduce((s, x) => s + (x.end - x.start), 0) / Math.max(shots.length, 1);
      setMeta({ duration: v.duration, shots: shots.length, avgShot });

      setPhase("frames");
      const kf = await grabKeyframes(v, shots);
      setFrames(kf);

      let transcript = "(no transcript — analyze visuals only)";
      if (groqKey) {
        setPhase("audio");
        try {
          const { wav, truncated } = await extractAudioWav16k(f);
          const tr = await groqTranscribeSegments(wav, groqKey);
          transcript = tr.segments.map(s => `[${fmtTime(s.start)}] ${s.text.trim()}`).join("\n").slice(0, 9000) + (truncated ? "\n(transcript truncated)" : "");
        } catch (e) { transcript = `(transcription failed: ${e.message} — analyze visuals only)`; }
      }

      setPhase("dna");
      const shotList = kf.map((s, i) => `Image ${i + 1}: shot at ${fmtTime(s.t)}, length ${s.dur.toFixed(1)}s`).join("\n");
      const raw = await claudeVisionMulti(SYS_DNA,
        `Video length: ${fmtTime(v.duration)} · ${shots.length} detected shots · average shot ${avgShot.toFixed(1)}s.\nThe ${kf.length} images are chronological keyframes:\n${shotList}\n\nTRANSCRIPT:\n${transcript}\n\nReturn ONLY the JSON.`,
        kf.map(s => s.img), clKey);
      const parsed = parseJson(raw);
      setDna(parsed);
      setName(f.name.replace(/\.[^.]+$/, "").slice(0, 40));
      setPhase("done");
    } catch (e) { setErr(e.message); setPhase(""); }
  };

  const saveTemplate = () => {
    if (!dna || !name.trim()) return;
    const t = { id: Date.now(), name: name.trim(), date: new Date().toISOString().slice(0, 10), duration: meta.duration, shots: meta.shots, avgShot: meta.avgShot, thumb: frames[0]?.img || "", dna };
    saveTemplates([t, ...templates]);
    setDna(null); setFile(null); setPhase(""); setFrames([]);
  };

  return (<div className="yt-page">
    <h1 className="yt-page-title">Learn from a video</h1>
    <p className="yt-sub">Drop a video that works — the app studies it frame by frame (shot pacing, when real footage plays vs b-roll, how the hook lands) and saves the structure as a template the Studio can replicate on any topic.</p>

    <video ref={videoRef} style={{ display: "none" }} playsInline/>

    <div className="yt-card">
      {!running && !dna && <label className="vn-drop">
        <input type="file" accept="video/*" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) analyze(f); e.target.value = ""; }}/>
        <span className="vn-drop-t">Drop a video file here</span>
        <span className="vn-drop-d">mp4 / webm / mov · analysis runs entirely in your browser · YouTube videos: download the file first{groqKey ? "" : " · add a Groq key in Settings to include the transcript"}</span>
      </label>}

      {running && <div className="vn-run">
        <div className="yt-ld-box"><div className="yt-spin"/>
          <p>{phase === "shots" ? `Detecting cuts frame by frame… ${Math.round(prog * 100)}%` : phase === "frames" ? "Extracting keyframes…" : phase === "audio" ? "Transcribing the audio…" : "Claude is studying the structure…"}</p>
        </div>
        {frames.length > 0 && <div className="vn-strip">{frames.slice(0, 14).map((s, i) => <img key={i} src={s.img} alt=""/>)}</div>}
      </div>}
      {err && <>
        <p className="yt-st err">⚠ {err}</p>
        {frames.length > 0 && !dna && <>
          {meta && <p className="yt-hint">Frame analysis itself succeeded — {meta.shots} shots detected ({meta.avgShot.toFixed(1)}s average). The failure was at the AI step; fix the key/connection and drop the file again.</p>}
          <div className="vn-strip">{frames.slice(0, 14).map((s, i) => <img key={i} src={s.img} alt="" title={fmtTime(s.t)}/>)}</div>
        </>}
      </>}

      {dna && <div className="vn-result">
        {meta && <div className="yt-info-bar" style={{ marginTop: 0 }}>
          <div className="yt-info-item"><span className="yt-info-num">{fmtTime(meta.duration)}</span>length</div>
          <div className="yt-info-item"><span className="yt-info-num">{meta.shots}</span>shots</div>
          <div className="yt-info-item"><span className="yt-info-num">{meta.avgShot.toFixed(1)}s</span>avg shot</div>
          {dna.visualMix && <div className="yt-info-item"><span className="yt-info-num">{dna.visualMix.realFootagePct ?? "–"}%</span>real footage</div>}
        </div>}
        <div className="vn-strip">{frames.slice(0, 14).map((s, i) => <img key={i} src={s.img} alt="" title={fmtTime(s.t)}/>)}</div>
        <p className="vn-summary">{dna.summary}</p>
        {dna.hook && <p className="yt-hint"><b>Hook ({dna.hook.seconds}s):</b> {dna.hook.technique}</p>}
        {(dna.phases || []).length > 0 && <div className="vn-phases">{dna.phases.map((p, i) => <div key={i} className="vn-phase">
          <span className="vn-phase-pct">{p.startPct}–{p.endPct}%</span>
          <div><div className="vn-phase-n">{p.name}</div><div className="vn-phase-d">{p.visual}{p.audio ? ` · ${p.audio}` : ""}</div></div>
        </div>)}</div>}
        {(dna.replicationRules || []).length > 0 && <div className="yt-opt-section" style={{ marginTop: 14 }}>
          <div className="yt-opt-label" style={{ marginBottom: 6 }}>Replication rules</div>
          {dna.replicationRules.map((r, i) => <p key={i} className="vn-rule">· {r}</p>)}
        </div>}
        <div className="yt-input-row" style={{ marginTop: 16 }}>
          <input className="yt-input" placeholder="Template name" value={name} onChange={e => setName(e.target.value)}/>
          <button className="yt-btn" onClick={saveTemplate} disabled={!name.trim()}>Save template</button>
          <button className="yt-btn-o" onClick={() => { setDna(null); setPhase(""); setFrames([]); }}>Discard</button>
        </div>
      </div>}
    </div>

    {templates.length > 0 && <>
      <div className="yt-sec-h" style={{ marginTop: 30 }}><h2>Saved templates</h2></div>
      <div className="vn-tpls">{templates.map(t => <div key={t.id} className="vn-tpl">
        {t.thumb && <img src={t.thumb} alt=""/>}
        <div className="vn-tpl-b">
          <div className="vn-tpl-n">{t.name}</div>
          <div className="vn-tpl-m">{fmtTime(t.duration)} · {t.shots} shots · {t.avgShot.toFixed(1)}s avg · {t.date}</div>
          <p className="vn-tpl-s">{t.dna.summary}</p>
          <button className="yt-x" style={{ position: "absolute", top: 8, right: 8 }} onClick={() => { if (confirm("Delete this template?")) saveTemplates(templates.filter(x => x.id !== t.id)); }}>✕</button>
        </div>
      </div>)}</div>
      <p className="yt-hint" style={{ marginTop: 10 }}>Pick a template from the Studio toolbar — the script, storyboard pacing, and shot types (real footage vs generated) will follow its structure.</p>
    </>}
    <style>{VN_CSS}</style>
  </div>);
}

const VN_CSS = `
.vn-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:60px 20px;border:1px dashed var(--border2);border-radius:var(--radius2);cursor:pointer;background:var(--surface);text-align:center}
.vn-drop:hover{border-color:var(--text3)}
.vn-drop-t{font-size:15px;font-weight:600}
.vn-drop-d{font-size:12.5px;color:var(--text3);max-width:520px;line-height:1.5}
.vn-run{padding:10px 0}
.vn-strip{display:flex;gap:6px;overflow-x:auto;padding:10px 0}
.vn-strip img{height:64px;border-radius:6px;border:1px solid var(--border);flex-shrink:0}
.vn-summary{font-size:14px;line-height:1.6;margin:12px 0;color:var(--text)}
.vn-phases{display:flex;flex-direction:column;gap:6px;margin-top:12px}
.vn-phase{display:flex;gap:12px;align-items:baseline;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius3);padding:8px 12px}
.vn-phase-pct{font-family:var(--mono);font-size:11px;color:var(--text3);min-width:64px}
.vn-phase-n{font-size:13px;font-weight:600}
.vn-phase-d{font-size:12px;color:var(--text2)}
.vn-rule{font-size:12.5px;color:var(--text2);line-height:1.6}
.vn-tpls{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.vn-tpl{position:relative;display:flex;gap:0;flex-direction:column;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius2);overflow:hidden}
.vn-tpl img{width:100%;aspect-ratio:16/9;object-fit:cover}
.vn-tpl-b{padding:12px 14px}
.vn-tpl-n{font-size:14px;font-weight:600}
.vn-tpl-m{font-size:11px;color:var(--text3);margin:2px 0 6px}
.vn-tpl-s{font-size:12px;color:var(--text2);line-height:1.5;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
`;
