import { useState } from "react";
import { geminiAnalyzeVideo, parseJson, fmtTime } from "./pipeline";
import { ytId } from "./yt";

// Learn from a video: Gemini watches the whole video (a YouTube URL directly, or an uploaded
// file) and reverse-engineers its structure into a reusable template (Video DNA) that the
// Studio replicates — hook style, phase order (real footage → commentary over b-roll →
// graphics), cut pacing, narration devices.

import { cloudGet as ls, cloudSet as ss } from "./cloud.js";

const SYS_DNA = `You are a video structure analyst. Watch the entire video and reverse-engineer HOW it works so another video on a completely different topic can replicate the exact structure and pacing.
Pay attention to: which segments use REAL footage (archival, news, phone clips, interviews, real locations of the actual subject), which use stock b-roll, which use AI/graphics/text cards; exactly when narration starts relative to the visuals; how the opening hook works; how cut speed changes across the video; on-screen text, captions, and music.
Return ONLY JSON (no markdown):
{
 "summary": "2-3 sentences on how this video works",
 "durationSeconds": 512,
 "shotCount": 140,
 "hook": {"seconds": 12, "technique": "what happens before/at the start of narration"},
 "phases": [{"name":"cold open","startPct":0,"endPct":8,"visual":"real archival footage of the subject","audio":"natural sound, no narration yet","sourceType":"real","notes":"..."}],
 "pacing": {"avgShotSeconds": 3.2, "notes": "how cut speed changes across the video"},
 "visualMix": {"realFootagePct": 40, "brollPct": 35, "graphicsPct": 25},
 "narration": {"tone": "...", "devices": ["open loops","direct address"], "notes": "..."},
 "overlays": "on-screen text usage", "subtitles": "caption style if any", "music": "music/sfx usage",
 "replicationRules": ["Open with 8-12s of real footage of the actual subject before any narration", "..."]
}
Each phase's "sourceType" is "real", "broll", or "graphics". Phases must cover 0-100% in order. Be concrete and prescriptive — these rules drive an automated video builder.`;

export default function Vision({ gemKey }) {
  const [templates, setTemplates] = useState(() => ls("vr8-templates", []));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [dna, setDna] = useState(null);
  const [thumb, setThumb] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [ytUrl, setYtUrl] = useState("");

  const saveTemplates = t => { setTemplates(t); ss("vr8-templates", t); };

  const run = async (source, displayName, previewThumb) => {
    if (!gemKey) { setErr("Add your Gemini API key in Settings — Gemini watches and analyzes the video."); return; }
    setErr(""); setDna(null); setThumb(previewThumb || ""); setBusy(true); setStatus("Starting…");
    try {
      const raw = await geminiAnalyzeVideo(source, SYS_DNA, "Analyze this video's structure and return ONLY the JSON described.", gemKey, { onStatus: setStatus });
      const parsed = parseJson(raw);
      setDna(parsed);
      setName((displayName || "Template").slice(0, 40));
    } catch (e) { setErr(e.message); }
    setBusy(false); setStatus("");
  };

  const fromYouTube = () => {
    const id = ytId(ytUrl);
    if (!id) { setErr("Paste a full YouTube link (watch, shorts, or youtu.be)"); return; }
    run({ youtubeUrl: `https://www.youtube.com/watch?v=${id}` }, "", `https://img.youtube.com/vi/${id}/hqdefault.jpg`);
  };
  const fromFile = async (f) => {
    if (f.size > 200 * 1024 * 1024) { setErr("That file is over 200MB — trim it or use a shorter clip."); return; }
    const thumbUrl = await grabPoster(f).catch(() => "");
    run({ file: f }, f.name.replace(/\.[^.]+$/, ""), thumbUrl);
  };

  const saveTemplate = () => {
    if (!dna || !name.trim()) return;
    const t = {
      id: Date.now(), name: name.trim(), date: new Date().toISOString().slice(0, 10),
      duration: dna.durationSeconds || 0, shots: dna.shotCount || 0,
      avgShot: dna.pacing?.avgShotSeconds || 0, thumb, dna,
    };
    saveTemplates([t, ...templates]);
    setDna(null); setThumb(""); setName(""); setYtUrl("");
  };

  const mix = dna?.visualMix;
  return (<div className="yt-page">
    <h1 className="yt-page-title">Learn from a video</h1>
    <p className="yt-sub">Give Gemini a video that works — it watches the whole thing and reverse-engineers the structure (hook, when real footage plays vs b-roll, cut pacing, narration devices) into a template the Studio replicates on any topic.</p>

    <div className="yt-card">
      {!busy && !dna && <>
        <div className="yt-input-row">
          <input className="yt-input" placeholder="Paste a YouTube link — https://youtube.com/watch?v=…" value={ytUrl} onChange={e => setYtUrl(e.target.value)} onKeyDown={e => e.key === "Enter" && fromYouTube()}/>
          <button className="yt-btn" onClick={fromYouTube} disabled={!ytUrl.trim()}>Analyze</button>
        </div>
        <p className="yt-hint">Gemini reads the YouTube link directly — no download needed. Or drop a file below (up to 200MB; larger clips upload to Gemini first).</p>
        <label className="vn-drop" style={{ marginTop: 10 }}>
          <input type="file" accept="video/*" style={{ display: "none" }} onChange={e => { const f = e.target.files?.[0]; if (f) fromFile(f); e.target.value = ""; }}/>
          <span className="vn-drop-t">…or drop a video file here</span>
          <span className="vn-drop-d">mp4 / webm / mov</span>
        </label>
      </>}

      {busy && <div className="yt-ld-box"><div className="yt-spin"/><p>{status || "Working…"}</p></div>}
      {err && <p className="yt-st err">⚠ {err}</p>}

      {dna && <div className="vn-result">
        {thumb && <img src={thumb} alt="" className="vn-hero"/>}
        <div className="yt-info-bar" style={{ marginTop: 14 }}>
          {dna.durationSeconds ? <div className="yt-info-item"><span className="yt-info-num">{fmtTime(dna.durationSeconds)}</span>length</div> : null}
          {dna.shotCount ? <div className="yt-info-item"><span className="yt-info-num">{dna.shotCount}</span>shots</div> : null}
          {dna.pacing?.avgShotSeconds ? <div className="yt-info-item"><span className="yt-info-num">{Number(dna.pacing.avgShotSeconds).toFixed(1)}s</span>avg shot</div> : null}
          {mix?.realFootagePct != null && <div className="yt-info-item"><span className="yt-info-num">{mix.realFootagePct}%</span>real footage</div>}
        </div>
        {mix && <div className="vn-mix"><span className="vn-mix-seg" style={{ flex: mix.realFootagePct || 0, background: "var(--blue)" }} title={`Real footage ${mix.realFootagePct}%`}/><span className="vn-mix-seg" style={{ flex: mix.brollPct || 0, background: "var(--green)" }} title={`B-roll ${mix.brollPct}%`}/><span className="vn-mix-seg" style={{ flex: mix.graphicsPct || 0, background: "var(--amber)" }} title={`Graphics ${mix.graphicsPct}%`}/></div>}
        <p className="vn-summary">{dna.summary}</p>
        {dna.hook && <p className="yt-hint"><b>Hook ({dna.hook.seconds}s):</b> {dna.hook.technique}</p>}
        {(dna.phases || []).length > 0 && <div className="vn-phases">{dna.phases.map((p, i) => <div key={i} className="vn-phase">
          <span className="vn-phase-pct">{p.startPct}–{p.endPct}%</span>
          <div style={{ flex: 1 }}><div className="vn-phase-n">{p.name}{p.sourceType && <span className={`vn-src vn-src-${p.sourceType}`}>{p.sourceType}</span>}</div><div className="vn-phase-d">{p.visual}{p.audio ? ` · ${p.audio}` : ""}</div></div>
        </div>)}</div>}
        {(dna.replicationRules || []).length > 0 && <div className="yt-opt-section" style={{ marginTop: 14 }}>
          <div className="yt-opt-label" style={{ marginBottom: 6 }}>Replication rules</div>
          {dna.replicationRules.map((r, i) => <p key={i} className="vn-rule">· {r}</p>)}
        </div>}
        <div className="yt-input-row" style={{ marginTop: 16 }}>
          <input className="yt-input" placeholder="Template name" value={name} onChange={e => setName(e.target.value)}/>
          <button className="yt-btn" onClick={saveTemplate} disabled={!name.trim()}>Save template</button>
          <button className="yt-btn-o" onClick={() => { setDna(null); setThumb(""); }}>Discard</button>
        </div>
      </div>}
    </div>

    {templates.length > 0 && <>
      <div className="yt-sec-h" style={{ marginTop: 30 }}><h2>Saved templates</h2></div>
      <div className="vn-tpls">{templates.map(t => <div key={t.id} className="vn-tpl">
        {t.thumb && <img src={t.thumb} alt=""/>}
        <div className="vn-tpl-b">
          <div className="vn-tpl-n">{t.name}</div>
          <div className="vn-tpl-m">{t.duration ? fmtTime(t.duration) + " · " : ""}{t.shots ? t.shots + " shots · " : ""}{t.avgShot ? Number(t.avgShot).toFixed(1) + "s avg · " : ""}{t.date}</div>
          <p className="vn-tpl-s">{t.dna.summary}</p>
          <button className="yt-x" style={{ position: "absolute", top: 8, right: 8 }} onClick={() => { if (confirm("Delete this template?")) saveTemplates(templates.filter(x => x.id !== t.id)); }}>✕</button>
        </div>
      </div>)}</div>
      <p className="yt-hint" style={{ marginTop: 10 }}>Pick a template from the Studio toolbar — the script, storyboard pacing, and shot types (real footage vs generated) will follow its structure.</p>
    </>}
    <style>{VN_CSS}</style>
  </div>);
}

// Grab one frame from an uploaded file for the template thumbnail.
function grabPoster(file) {
  return new Promise((res, rej) => {
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.src = URL.createObjectURL(file);
    v.onloadeddata = () => { v.currentTime = Math.min(2, (v.duration || 4) / 2); };
    v.onseeked = () => {
      const c = document.createElement("canvas");
      const scale = 480 / (v.videoWidth || 480);
      c.width = 480; c.height = Math.round((v.videoHeight || 270) * scale);
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      res(c.toDataURL("image/jpeg", 0.6));
      URL.revokeObjectURL(v.src);
    };
    v.onerror = () => rej(new Error("thumb failed"));
    setTimeout(() => rej(new Error("thumb timeout")), 6000);
  });
}

const VN_CSS = `
.vn-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:60px 20px;border:1px dashed var(--border2);border-radius:var(--radius2);cursor:pointer;background:var(--surface);text-align:center}
.vn-drop:hover{border-color:var(--text3)}
.vn-drop-t{font-size:15px;font-weight:600}
.vn-drop-d{font-size:12.5px;color:var(--text3);max-width:520px;line-height:1.5}
.vn-hero{width:100%;max-width:420px;border-radius:var(--radius2);border:1px solid var(--border);display:block}
.vn-mix{display:flex;height:8px;border-radius:4px;overflow:hidden;margin:12px 0}
.vn-mix-seg{display:block}
.vn-summary{font-size:14px;line-height:1.6;margin:12px 0;color:var(--text)}
.vn-phases{display:flex;flex-direction:column;gap:6px;margin-top:12px}
.vn-phase{display:flex;gap:12px;align-items:baseline;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius3);padding:8px 12px}
.vn-phase-pct{font-family:var(--mono);font-size:11px;color:var(--text3);min-width:64px}
.vn-phase-n{font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px}
.vn-phase-d{font-size:12px;color:var(--text2)}
.vn-src{font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.4px;padding:1px 6px;border-radius:7px}
.vn-src-real{background:var(--blue-bg);color:var(--blue)}
.vn-src-broll{background:var(--green-bg);color:var(--green)}
.vn-src-graphics{background:var(--surface2);color:var(--text2)}
.vn-rule{font-size:12.5px;color:var(--text2);line-height:1.6}
.vn-tpls{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.vn-tpl{position:relative;display:flex;gap:0;flex-direction:column;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius2);overflow:hidden}
.vn-tpl img{width:100%;aspect-ratio:16/9;object-fit:cover}
.vn-tpl-b{padding:12px 14px}
.vn-tpl-n{font-size:14px;font-weight:600}
.vn-tpl-m{font-size:11px;color:var(--text3);margin:2px 0 6px}
.vn-tpl-s{font-size:12px;color:var(--text2);line-height:1.5;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
`;
