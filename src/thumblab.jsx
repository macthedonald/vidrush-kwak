import { useState } from "react";
import { claude, claudeVision } from "./pipeline";
import { gathosImage } from "./gathos";

// Thumbnail lab — reference-cloning or from-scratch prompt → Gathos renders.
// Lives inside the Studio as its own step; ported from the old Generator page.
export default function ThumbLab({ topic, niche, clKey, gathosKey, refThumb, format = "16:9", state, setState }) {
  const [thMode, setThMode] = useState(state.thMode || null); // null | "reference" | "scratch"
  const [thRefImg, setThRefImg] = useState(refThumb || "");
  const [thRefB64, setThRefB64] = useState(null);
  const [thPrompt, setThPrompt] = useState(state.thPrompt || "");
  const [thRefine, setThRefine] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [refining, setRefining] = useState(false);
  const [count, setCount] = useState("2");
  const [withText, setWithText] = useState(true);
  const [results, setResults] = useState(state.thumbs || []);
  const [loading, setLoading] = useState([]);
  const [cp, setCp] = useState("");
  const vertical = format === "9:16";

  const save = (patch) => setState({ thMode, thPrompt, thumbs: results, ...patch });
  const pickMode = (m) => { setThMode(m); save({ thMode: m }); };
  const setPromptSaved = (p) => { setThPrompt(p); save({ thPrompt: p }); };

  const onRefUpload = (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const full = ev.target.result;
      setThRefImg(full);
      setThRefB64({ data: full.split(",")[1], mime: file.type || "image/jpeg" });
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const SYS_NANA = `Write a prompt to generate an image that looks as close as possible to the reference photo.
Describe EXACTLY what you see: every object/person (what, where, size, color), camera angle and framing, lighting (direction, intensity, temperature, shadows), exact color tones and contrast, textures and materials, background/foreground depth, mood.
Write ONE dense paragraph (150-250 words). Start with "Generate a photorealistic ${vertical ? "vertical image (9:16 aspect ratio)" : "wide image (16:9 aspect ratio, 1280x720)"}."
Be extremely precise — the goal is to recreate this image. Describe what you SEE, not what you interpret. End with: "no text on the image."
After the prompt, on a NEW line write: TEXT OVERLAY: suggested overlay text with font style, color, placement.
English only. No markdown.`;

  const analyzeReference = async () => {
    if (!clKey || (!thRefB64 && !thRefImg)) return;
    setAnalyzing(true);
    try {
      const msg = "Write a prompt to generate an image maximally similar to this reference. Describe exactly what you see.";
      const result = await claudeVision(SYS_NANA, msg, thRefB64 || thRefImg, clKey);
      if (result) setPromptSaved(result.replace(/```/g, "").trim());
    } catch (e) { setPromptSaved("Error: " + e.message); }
    setAnalyzing(false);
  };

  const autoPrompt = async () => {
    setAnalyzing(true);
    try {
      const r = await claude(`You are a YouTube thumbnail prompt engineer. Write a SINGLE dense paragraph (80-150 words) prompt for an AI image generator for the given topic. Describe composition, subject, lighting, colors, mood, and end with "hyperrealistic cinematic photography, ${vertical ? "9:16" : "16:9"} aspect ratio". Make it attention-grabbing but honest. Return ONLY the prompt.`, `Topic: "${topic}"\nNiche: ${niche.name}`, clKey);
      setPromptSaved(r.replace(/```/g, "").trim());
    } catch (e) { setPromptSaved("Error: " + e.message); }
    setAnalyzing(false);
  };

  const refinePrompt = async () => {
    if (!clKey || !thRefine.trim()) return;
    setRefining(true);
    try {
      const r = await claude(`You are a thumbnail prompt editor. Apply the user's edits to the existing image prompt and return the UPDATED prompt only — one dense paragraph, same format.`, `CURRENT PROMPT:\n${thPrompt}\n\nUSER EDITS:\n${thRefine}`, clKey);
      setPromptSaved(r.replace(/```/g, "").trim());
      setThRefine("");
    } catch {}
    setRefining(false);
  };

  const generateOne = async (idx) => {
    if (!gathosKey) return;
    setLoading(prev => { const n = [...prev]; n[idx] = true; return n; });
    const textInstr = withText ? "Include bold, eye-catching text/title overlay exactly as described in the prompt." : "IMPORTANT: Do NOT add any text on the image. Purely visual.";
    const variation = idx === 0 ? "" : ` Create variation ${idx + 1} — same style, slightly different angle/composition.`;
    const promptText = `Generate a PHOTOREALISTIC YouTube ${vertical ? "Shorts cover, 9:16" : "video thumbnail, 16:9"} aspect ratio. Must look like a REAL photograph — real skin textures, real materials, real lighting, NOT AI-generated. FOLLOW THIS PROMPT EXACTLY: ${thPrompt.trim() || topic}. ${textInstr}${variation}`;
    try {
      const url = await gathosImage(promptText, gathosKey, { aspect: vertical ? "9:16" : "16:9" });
      setResults(prev => { const n = [...prev]; n[idx] = { url, prompt: promptText }; save({ thumbs: n }); return n; });
    } catch (e) {
      setResults(prev => { const n = [...prev]; n[idx] = { error: e.message }; return n; });
    }
    setLoading(prev => { const n = [...prev]; n[idx] = false; return n; });
  };
  const generateAll = () => {
    const c = parseInt(count);
    const start = results.length;
    setResults(prev => [...prev, ...Array(c).fill(null)]);
    setLoading(prev => [...prev, ...Array(c).fill(true)]);
    for (let i = 0; i < c; i++) generateOne(start + i);
  };
  const copy = (t, l) => { navigator.clipboard.writeText(t); setCp(l); setTimeout(() => setCp(""), 1500); };

  return (<div className="yt-card">
    <div className="yt-card-ht">Thumbnail</div>
    {!thMode && <div className="yt-th-choose">
      <p className="yt-th-choose-label">How do you want to create it?</p>
      <div className="yt-th-choose-grid">
        <button className="yt-th-choose-btn" onClick={() => pickMode("reference")}>
          <span className="yt-th-choose-n">From a reference</span>
          <span className="yt-th-choose-d">Upload a thumbnail you like (or use an outlier's) — the prompt is written to match its style.</span>
          {refThumb && <span className="yt-th-choose-tag">Outlier thumbnail attached</span>}
        </button>
        <button className="yt-th-choose-btn" onClick={() => pickMode("scratch")}>
          <span className="yt-th-choose-n">From scratch</span>
          <span className="yt-th-choose-d">Write your own prompt, or have one written for the topic.</span>
        </button>
      </div>
    </div>}

    {thMode === "reference" && <div className="yt-th-ref-section">
      <button className="yt-btn-o" onClick={() => { pickMode(null); setPromptSaved(""); }} style={{ marginBottom: 12 }}>← Change mode</button>
      <div className="yt-th-ref-layout">
        <div>
          <label className="yt-label">Reference image</label>
          {thRefImg ? <div className="yt-th-ref-preview">
            <img src={thRefImg} alt="" className="yt-th-ref-big"/>
            <div className="yt-th-ref-overlay">
              <label className="yt-th-ref-change"><input type="file" accept="image/*" onChange={onRefUpload} style={{ display: "none" }}/>Replace</label>
            </div>
          </div> : <label className="yt-th-ref-drop-big">
            <input type="file" accept="image/*" onChange={onRefUpload} style={{ display: "none" }}/>
            <span className="yt-th-ref-drop-t">Drop a reference here</span>
            <span className="yt-th-ref-drop-d">or click to upload</span>
          </label>}
        </div>
        <div>
          <div className="yt-th-prompt-header">
            <label className="yt-label">Image prompt</label>
            {thRefImg && !thPrompt && <button className={`yt-btn ${analyzing ? "yt-btn-ld" : ""}`} onClick={analyzeReference} disabled={analyzing}>{analyzing ? "Analyzing…" : "Analyze & write prompt"}</button>}
          </div>
          {analyzing && <div className="yt-ld-box"><div className="yt-spin"/></div>}
          <textarea className="yt-input yt-th-prompt-area" rows="8" value={thPrompt} onChange={e => setThPrompt(e.target.value)} onBlur={() => save({})} placeholder="The generated prompt appears here."/>
          {thPrompt && <ThRefine thRefine={thRefine} setThRefine={setThRefine} refining={refining} refinePrompt={refinePrompt} copy={copy} cp={cp} thPrompt={thPrompt}/>}
        </div>
      </div>
    </div>}

    {thMode === "scratch" && <div className="yt-th-ref-section">
      <button className="yt-btn-o" onClick={() => { pickMode(null); setPromptSaved(""); }} style={{ marginBottom: 12 }}>← Change mode</button>
      <div className="yt-th-scratch-layout">
        <div style={{ flex: 1 }}>
          <div className="yt-th-prompt-header">
            <label className="yt-label">Image prompt</label>
            {!thPrompt && <button className={`yt-btn ${analyzing ? "yt-btn-ld" : ""}`} onClick={autoPrompt} disabled={analyzing}>{analyzing ? "Writing…" : "Write prompt for me"}</button>}
          </div>
          <textarea className="yt-input yt-th-prompt-area" rows="6" value={thPrompt} onChange={e => setThPrompt(e.target.value)} onBlur={() => save({})} placeholder="Describe the thumbnail: subject, composition, lighting, mood…"/>
          {thPrompt && <ThRefine thRefine={thRefine} setThRefine={setThRefine} refining={refining} refinePrompt={refinePrompt} copy={copy} cp={cp} thPrompt={thPrompt}/>}
        </div>
      </div>
    </div>}

    {thMode && thPrompt && <div className="yt-th-gen-bar">
      <div className="yt-thumb-options">
        <div><label className="yt-label">Count</label><select className="yt-sel" value={count} onChange={e => setCount(e.target.value)}>{[1, 2, 3, 4].map(n => <option key={n}>{n}</option>)}</select></div>
        <label className="yt-thumb-check"><input type="checkbox" checked={withText} onChange={e => setWithText(e.target.checked)}/><span>With text overlay</span></label>
      </div>
      <button className="yt-btn-big" onClick={generateAll} disabled={!gathosKey} style={{ marginTop: 12 }}>{gathosKey ? "Generate thumbnails" : "Add a Gathos key in Settings"}</button>
    </div>}

    {results.length > 0 && <>
      <div className="yt-thumb-grid-header"><span className="yt-opt-label">Results ({results.filter(r => r?.url).length}/{results.length})</span><button className="yt-btn-cp-sm" onClick={() => { setResults([]); setLoading([]); save({ thumbs: [] }); }}>Clear all</button></div>
      <div className="yt-thumb-grid">
        {[...results].reverse().map((r, ri) => { const i = results.length - 1 - ri; return <div key={i} className="yt-thumb-item">
          {loading[i] && !r?.url && !r?.error && <div className="yt-thumb-loader"><div className="yt-spin"/></div>}
          {r?.url && <><img src={r.url} className="yt-thumb-result-img" alt="" onClick={() => window.open(r.url)}/>
            <div className="yt-thumb-actions">
              <a href={r.url} download={`thumb_${topic.replace(/\s+/g, "_")}_${i + 1}.png`} className="yt-thumb-dl">Download</a>
              <button className="yt-thumb-regen" onClick={() => copy(r.prompt || "", "tp" + i)}>{cp === "tp" + i ? "✅" : "Copy prompt"}</button>
              <button className="yt-thumb-regen" onClick={() => generateOne(i)}>{loading[i] ? "…" : "Redo"}</button>
            </div></>}
          {r?.error && <div className="yt-thumb-error">{r.error}<button className="yt-thumb-regen" onClick={() => generateOne(i)} style={{ marginTop: 8, display: "block", width: "100%" }}>Retry</button></div>}
        </div>; })}
      </div>
    </>}
  </div>);
}

function ThRefine({ thRefine, setThRefine, refining, refinePrompt, copy, cp, thPrompt }) {
  return (<>
    <div className="yt-th-prompt-actions"><button className="yt-btn-cp" onClick={() => copy(thPrompt, "thp")}>{cp === "thp" ? "✅" : "Copy prompt"}</button></div>
    <div className="yt-th-refine">
      <label className="yt-label">Refine</label>
      <div className="yt-th-refine-row">
        <textarea className="yt-input yt-th-refine-input" rows="2" value={thRefine} onChange={e => setThRefine(e.target.value)} placeholder='e.g. "add a bold yellow title, make the background darker"' onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); refinePrompt(); } }}/>
        <button className={`yt-btn-refine ${refining ? "yt-btn-ld" : ""}`} onClick={refinePrompt} disabled={refining || !thRefine.trim()}>{refining ? "…" : "Apply"}</button>
      </div>
    </div>
  </>);
}
