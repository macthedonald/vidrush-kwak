import { useState, useEffect, lazy, Suspense, Component } from "react";
import { SeoView } from "./seoview.jsx";
import { AI33_DEFAULT_BASE } from "./ai33";
import { useReveal, Counter } from "./anim.jsx";

// Heavy pages are code-split — the dashboard shell stays fast.
const Studio = lazy(() => import("./studio.jsx"));
const NicheFinder = lazy(() => import("./nichefinder.jsx"));

class ErrorBoundary extends Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (this.state.err) return (<div className="yt-page" style={{ padding: 40, textAlign: "center" }}>
      <h2 style={{ marginBottom: 10 }}>Something went wrong</h2>
      <p style={{ color: "#6f6e69", fontSize: 14, marginBottom: 18 }}>{String(this.state.err?.message || this.state.err)}</p>
      <button className="yt-btn" onClick={() => this.setState({ err: null })}>Try again</button>
    </div>);
    return this.props.children;
  }
}
const PageLoader = () => <div className="yt-loading" style={{ minHeight: "40vh" }}><div className="yt-spin"/></div>;

const MODEL = "claude-sonnet-4-20250514";
const YT = "https://www.googleapis.com/youtube/v3";

async function ai(system, user, key) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, system, messages: [{ role: "user", content: user }] }),
  });
  const d = await r.json(); if (d.error) throw new Error(d.error.message); return d.content?.[0]?.text || "Error";
}

async function aiVision(system, textMsg, imageSource, key) {
  // imageSource can be: { data, mime } for base64, or a URL string
  let imageBlock;
  if (typeof imageSource === 'object' && imageSource.data) {
    imageBlock = { type: "image", source: { type: "base64", media_type: imageSource.mime, data: imageSource.data } };
  } else {
    // URL — fetch and convert to base64
    try {
      const resp = await fetch(imageSource);
      const blob = await resp.blob();
      const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
      imageBlock = { type: "image", source: { type: "base64", media_type: blob.type || "image/jpeg", data: b64 } };
    } catch { 
      // fallback to URL type
      imageBlock = { type: "image", source: { type: "url", url: imageSource } };
    }
  }
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, system, messages: [{ role: "user", content: [
      imageBlock,
      { type: "text", text: textMsg }
    ]}] }),
  });
  const d = await r.json(); if (d.error) throw new Error(d.error.message); return d.content?.[0]?.text || "Error";
}

function ls(k, fb) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } }
function ss(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch(e) { if (e.name === 'QuotaExceededError') { console.warn('localStorage full, cleaning thumbs...'); cleanThumbs(k); try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } } }
function cleanThumbs(k) {
  try {
    const raw = localStorage.getItem(k); if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      const cleaned = data.map(n => ({ ...n, history: (n.history||[]).map(h => { const { thumbs, ...rest } = h; return rest; }) }));
      localStorage.setItem(k, JSON.stringify(cleaned));
    }
  } catch {}
}

async function ytApi(ep, params, key) {
  const r = await fetch(`${YT}/${ep}?${new URLSearchParams({ ...params, key })}`);
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error?.message || `YT ${r.status}`); } return r.json();
}
async function resolveChannel(input, key) {
  const c = input.trim().replace(/\/videos\/?$/, "").replace(/\/$/, "");
  if (/^UC[\w-]{22}$/.test(c)) return c;
  const m1 = c.match(/youtube\.com\/channel\/(UC[\w-]{22})/); if (m1) return m1[1];
  let h = c; const m2 = c.match(/youtube\.com\/@?([\w.-]+)/); if (m2) h = m2[1];
  if (!h.startsWith("@")) h = "@" + h;
  try { const ch = await ytApi("channels", { part: "id", forHandle: h.replace("@","") }, key); if (ch.items?.length) return ch.items[0].id; } catch {}
  const s = await ytApi("search", { part: "snippet", q: h, type: "channel", maxResults: 1 }, key);
  if (s.items?.length) return s.items[0].snippet.channelId; throw new Error("Not found: " + input);
}
async function getVideos(chId, key, onProgress) {
  const ch = await ytApi("channels", { part: "contentDetails,snippet", id: chId }, key);
  if (!ch.items?.length) throw new Error("Channel not found");
  const name = ch.items[0].snippet.title;
  const plId = ch.items[0].contentDetails.relatedPlaylists.uploads;
  let allIds = [], nextPage = null;
  for (let p = 0; p < 10; p++) {
    const params = { part: "snippet", playlistId: plId, maxResults: 50 };
    if (nextPage) params.pageToken = nextPage;
    const pl = await ytApi("playlistItems", params, key);
    allIds.push(...pl.items.map(i => i.snippet.resourceId.videoId));
    if (onProgress) onProgress(allIds.length);
    nextPage = pl.nextPageToken;
    if (!nextPage) break;
  }
  if (!allIds.length) return { name, videos: [] };
  let allVids = [];
  for (let i = 0; i < allIds.length; i += 50) {
    const batch = allIds.slice(i, i + 50).join(",");
    const vids = await ytApi("videos", { part: "snippet,statistics", id: batch }, key);
    allVids.push(...vids.items);
  }
  return { name, videos: allVids.map(v => ({ id: v.id, title: v.snippet.title, date: v.snippet.publishedAt?.slice(0,10), views: +(v.statistics.viewCount||0), likes: +(v.statistics.likeCount||0), thumb: v.snippet.thumbnails?.medium?.url||"", thumbHi: v.snippet.thumbnails?.high?.url||v.snippet.thumbnails?.medium?.url||"" })) };
}
function rankVideos(vids) {
  if (!vids.length) return [];
  const avg = vids.reduce((s, v) => s + v.views, 0) / vids.length;
  return vids.map(v => ({ ...v, ratio: (v.views / Math.max(avg, 1)).toFixed(1) })).sort((a, b) => b.views - a.views);
}
function filterByDays(vids, days) {
  if (!days) return vids;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
  return vids.filter(v => v.date && new Date(v.date) >= cutoff);
}
const fmt = n => n >= 1e6 ? (n/1e6).toFixed(1)+"M" : n >= 1e3 ? (n/1e3).toFixed(0)+"K" : String(n);

const SYS_T = `YouTube strategist. Analyze REAL competitor data. 10 NEW English topics. Return ONLY JSON: [{"title":"...","angle":"...","why":"...","inspired_by":"..."}]`;
const SYS_P = m => `You are VidRush — an elite YouTube script prompt engineer. Write a prompt in English.

⚠️ CRITICAL LENGTH RULE: Your response MUST be between 5,000 and 9,000 characters. COUNT your characters. If you exceed 9,000 chars — STOP and trim. This is a HARD LIMIT.

Structure using 4 pillars:
🎥 **What the Video Is About** — 2-3 sentences explaining the topic, narrative arc, core tension
🗣️ **Style of Talking** — Narration tone, pacing, transitions, hooks
🎯 **Who This Video Is For** — Audience demographics, what they search for
📌 **Key Facts Covered** — Talking points with specific facts, numbers, names. Each point: 2-3 bullets max. For 15-min = ~8 points. For 30-min = ~15 points.

Rules: Visual keywords only (no stage directions). ~0.5 talking points per minute. End with Style + Tone line. Keep it CONCISE — quality over quantity.${m==="manual"?" Also add: 📋 Follow-Up Q&A (5 short Q&A) + 🎬 Reference Video Notes":""}`;
const SYS_TH = `You are a YouTube thumbnail prompt specialist. Generate 3 highly detailed thumbnail prompts for AI image generation (Midjourney/DALL-E/Ideogram style).

Each prompt must be:
- ONE dense paragraph, 80-120 words
- Start with composition/camera angle
- Include specific subject description with emotions/actions
- Color palette and lighting details
- End with "hyperrealistic cinematic photography, no text, no graphics, 16:9 aspect ratio"

After the 3 prompts, add:
📝 **Text Overlay Ideas** — 3 clickbait text overlay suggestions with font style, color, and placement recommendations for Canva/Photoshop.
🎨 **Color Scheme** — dominant and accent colors that work for this topic.`;
const SYS_OPT_TITLES = `YouTube title optimizer. Return ONLY a JSON array of 5 title strings. Clickbait but honest, under 70 chars, power words, curiosity gaps. English only. Example: ["Title 1","Title 2","Title 3","Title 4","Title 5"]`;
const SYS_OPT_DESC = `YouTube description writer. Write 3 DIFFERENT YouTube description variants. Each 100-150 words MAX. Structure each:
- Line 1-2: Strong hook with main keywords (this shows in search preview!)
- Line 3-4: Brief what the video covers
- Line 5: CTA — "Subscribe for more [niche] content!"
- Last line: 5-8 relevant #hashtags

Separate each variant with "---" on its own line. Each variant should have a DIFFERENT tone: 1) Curiosity/mystery 2) Educational/authority 3) Shocking/clickbait. NO timestamps. Keep scannable and keyword-rich. English only. Return ONLY the 3 descriptions separated by ---.`;
const SYS_OPT_TAGS = `YouTube tag generator. Return ONLY a JSON array of 15-20 tags. Mix broad and long-tail keywords. English only. Example: ["tag1","tag2","tag3"]`;
const SYS_THREF = `Thumbnail analyst. Analyze this YouTube thumbnail image. Describe in detail:
1. COMPOSITION — layout, framing, focal points, rule of thirds usage
2. COLORS — dominant palette, contrast, saturation levels
3. TEXT — any overlay text style, font weight, positioning, effects (stroke, shadow, glow)
4. SUBJECT — what's depicted, scale, emotion, action
5. STYLE — photorealistic vs illustrated, lighting, mood
6. CLICKBAIT ELEMENTS — arrows, circles, emoji, reactions, before/after

Then write 3 NEW thumbnail prompts for the given topic that replicate this exact visual style. Each prompt: 1 paragraph, "hyperrealistic cinematic", end "no text, 16:9".`;

const P = { HOME: 0, NICHE: 1, GEN: 2, STUDIO: 3, FINDER: 4, SETTINGS: 5 };

export default function App() {
  const [pg, setPg] = useState(P.HOME);
  const [niches, setNiches] = useState([]);
  const [ytKey, setYtKey] = useState("");
  const [clKey, setClKey] = useState("");
  const [gemKey, setGemKey] = useState("");
  const [pexKey, setPexKey] = useState("");
  const [pixKey, setPixKey] = useState("");
  const [covKey, setCovKey] = useState("");
  const [ai33Key, setAi33Key] = useState("");
  const [ai33Base, setAi33Base] = useState(AI33_DEFAULT_BASE);
  const [niche, setNiche] = useState(null);
  const [studioCtx, setStudioCtx] = useState(null);
  const [ok, setOk] = useState(false);
  const [sb, setSb] = useState(true);

  useEffect(() => { cleanThumbs("vr6-niches"); setNiches(ls("vr6-niches", ls("vr5-niches",[]))); setYtKey(ls("vr6-yt", ls("vr5-yt",""))); setClKey(ls("vr6-cl", ls("vr5-cl",""))); setGemKey(ls("vr6-gem","")); setPexKey(ls("vr7-pex","")); setPixKey(ls("vr7-pix","")); setCovKey(ls("vr7-cov","")); setAi33Key(ls("vr7-a33","")); const a33b=ls("vr7-a33b",AI33_DEFAULT_BASE); setAi33Base(a33b==="https://ai33.pro/api"?AI33_DEFAULT_BASE:a33b); setOk(true); }, []);
  const sn = n => { setNiches(n); ss("vr6-niches",n); };
  const openNiche = (n) => {
    // Always read fresh from localStorage to avoid stale closures
    const fresh = ls("vr6-niches", []);
    const found = fresh.find(x => x.id === n.id);
    setNiche(found || n);
  };
  const addH = (nicheId, topic, version, prompt, thumb, forceId) => {
    const hid = forceId || Date.now();
    const entry = { topic, version: version || 1, date: new Date().toISOString().slice(0,10), id: hid, prompt: prompt||"", thumb: thumb||"" };
    setNiches(prev => {
      const n = prev.map(x => {
        if (x.id !== nicheId) return x;
        return { ...x, history: [entry, ...(x.history||[])] };
      });
      ss("vr6-niches", n);
      return n;
    });
    if (niche && niche.id === nicheId) {
      setNiche(prev => ({ ...prev, history: [entry, ...(prev.history||[])] }));
    }
    return hid;
  };
  const updateH = (nicheId, histId, updates) => {
    setNiches(prev => {
      const n = prev.map(x => {
        if (x.id !== nicheId) return x;
        return { ...x, history: (x.history||[]).map(h => h.id === histId ? { ...h, ...updates } : h) };
      });
      ss("vr6-niches", n);
      return n;
    });
    if (niche && niche.id === nicheId) {
      setNiche(prev => ({ ...prev, history: (prev.history||[]).map(h => h.id === histId ? { ...h, ...updates } : h) }));
    }
  };
  const getHist = () => (niche ? (niche.history || niches.find(x=>x.id===niche.id)?.history || []) : []);

  if (!ok) return <div className="yt-loading"><div className="yt-spin"/></div>;

  const hist = getHist();

  const openSaved = (h) => {
    if (!niche) return;
    setNiche({...niche, topic: h.topic, topicVersion: h.version, savedPrompt: h.prompt||"", savedThumb: h.thumb||"", savedHistId: h.id, savedThumbs: h.thumbs||[], savedOptTitles: h.optTitles||[], savedOptDesc: h.optDesc||"", savedOptTags: h.optTags||[], savedThPrompt: h.thPrompt||"" });
    setPg(P.GEN);
  };

  const openStudioFromHist = (h) => {
    if (!niche) return;
    setNiche({...niche, topic: h.topic, topicVersion: h.version, savedPrompt: h.prompt||"", savedThumb: h.thumb||"", savedHistId: h.id, savedThumbs: h.thumbs||[], savedOptTitles: h.optTitles||[], savedOptDesc: h.optDesc||"", savedOptTags: h.optTags||[], savedThPrompt: h.thPrompt||""});
    setStudioCtx({ topic: h.topic, version: h.version, histId: h.id, prompt: h.prompt||"" });
    setPg(P.STUDIO);
  };

  const remakeTopic = (h) => {
    if (!niche) return;
    const vc = hist.filter(x => x.topic.toLowerCase() === h.topic.toLowerCase()).length;
    setNiche({...niche, topic: h.topic, topicVersion: vc + 1, refThumb: ""});
    setPg(P.GEN);
  };

  const deleteH = (nicheId, histId) => {
    setNiches(prev => {
      const n = prev.map(x => {
        if (x.id !== nicheId) return x;
        return { ...x, history: (x.history||[]).filter(h => h.id !== histId) };
      });
      ss("vr6-niches", n);
      return n;
    });
    if (niche && niche.id === nicheId) {
      setNiche(prev => ({ ...prev, history: (prev.history||[]).filter(h => h.id !== histId) }));
    }
  };

  const activeNiche = (pg===P.NICHE||pg===P.GEN||pg===P.STUDIO) ? niche : null;

  return (<div className="yt-app">
    <div className="nv-shell">
      {sb ? <aside className="nv-side">
        <div className="nv-side-top">
          <button className="nv-brand" onClick={()=>setPg(P.HOME)}><span className="nv-mark">V</span>VidRush</button>
          <button className="nv-collapse" onClick={()=>setSb(false)} title="Collapse sidebar">
            <svg width="14" height="14" viewBox="0 0 16 16"><path fill="currentColor" d="M10.7 2.3a1 1 0 0 1 0 1.4L6.4 8l4.3 4.3a1 1 0 1 1-1.4 1.4l-5-5a1 1 0 0 1 0-1.4l5-5a1 1 0 0 1 1.4 0Z"/></svg>
          </button>
        </div>
        <nav className="nv-nav">
          <button className={pg===P.HOME?"on":""} onClick={()=>setPg(P.HOME)}>Home</button>
          <button className={pg===P.FINDER?"on":""} onClick={()=>setPg(P.FINDER)}>Niche finder</button>
          <button className={pg===P.SETTINGS?"on":""} onClick={()=>setPg(P.SETTINGS)}>Settings</button>
        </nav>
        <div className="nv-sec">Niches</div>
        <div className="nv-list">
          {niches.length===0 && <p className="nv-side-empty">Nothing here yet</p>}
          {niches.map(n=><div key={n.id}>
            <button className={`nv-item ${activeNiche?.id===n.id?"on":""}`} onClick={()=>{openNiche(n);setPg(P.NICHE);}}>{n.name}</button>
            {activeNiche?.id===n.id && hist.length>0 && <div className="nv-topics">
              {hist.map(h=><div key={h.id} className="nv-topic">
                <button className="nv-topic-t" title={h.topic} onClick={()=>h.prompt?openSaved(h):remakeTopic(h)}>{h.topic}</button>
                <button className="nv-topic-b" title="Open in Studio" onClick={()=>openStudioFromHist(h)}>
                  <svg width="11" height="11" viewBox="0 0 16 16"><path fill="currentColor" d="M5.3 2.8a1 1 0 0 1 1.5-.9l7 4.2a1 1 0 0 1 0 1.8l-7 4.2a1 1 0 0 1-1.5-.9V2.8Z"/></svg>
                </button>
                <button className="nv-topic-b" title="Remake with fresh items" onClick={()=>remakeTopic(h)}>
                  <svg width="11" height="11" viewBox="0 0 16 16"><path fill="currentColor" d="M8 3a5 5 0 1 0 4.9 6h-1.6A3.5 3.5 0 1 1 8 4.5c.9 0 1.8.4 2.4 1L9 7h4V3l-1.5 1.5A5 5 0 0 0 8 3Z"/></svg>
                </button>
                <button className="nv-topic-b nv-topic-x" title="Delete" onClick={()=>{if(confirm("Delete this topic?"))deleteH(n.id,h.id);}}>
                  <svg width="11" height="11" viewBox="0 0 16 16"><path fill="currentColor" d="M4.3 4.3a1 1 0 0 1 1.4 0L8 6.6l2.3-2.3a1 1 0 1 1 1.4 1.4L9.4 8l2.3 2.3a1 1 0 1 1-1.4 1.4L8 9.4l-2.3 2.3a1 1 0 1 1-1.4-1.4L6.6 8 4.3 5.7a1 1 0 0 1 0-1.4Z"/></svg>
                </button>
              </div>)}
            </div>}
          </div>)}
        </div>
      </aside>
      : <button className="nv-expand" onClick={()=>setSb(true)} title="Open sidebar">
          <svg width="14" height="14" viewBox="0 0 16 16"><path fill="currentColor" d="M5.3 2.3a1 1 0 0 0 0 1.4L9.6 8l-4.3 4.3a1 1 0 1 0 1.4 1.4l5-5a1 1 0 0 0 0-1.4l-5-5a1 1 0 0 0-1.4 0Z"/></svg>
        </button>}
      <main className="yt-main"><ErrorBoundary><Suspense fallback={<PageLoader/>}>
        {pg===P.HOME && <Home niches={niches} sn={sn} go={n=>{openNiche(n);setPg(P.NICHE);}} goFinder={()=>setPg(P.FINDER)} goSettings={()=>setPg(P.SETTINGS)} keysReady={!!(ytKey&&clKey&&gemKey)} />}
        {pg===P.SETTINGS && <SettingsPg keys={{ytKey,clKey,gemKey,pexKey,pixKey,covKey,ai33Key,ai33Base}} setKeys={k=>{setYtKey(k.ytKey);ss("vr6-yt",k.ytKey);setClKey(k.clKey);ss("vr6-cl",k.clKey);setGemKey(k.gemKey);ss("vr6-gem",k.gemKey);setPexKey(k.pexKey);ss("vr7-pex",k.pexKey);setPixKey(k.pixKey);ss("vr7-pix",k.pixKey);setCovKey(k.covKey);ss("vr7-cov",k.covKey);setAi33Key(k.ai33Key);ss("vr7-a33",k.ai33Key);setAi33Base(k.ai33Base);ss("vr7-a33b",k.ai33Base);}} />}
        {pg===P.NICHE && niche && <NichePg niche={niches.find(x=>x.id===niche.id)||niche} niches={niches} ytKey={ytKey} clKey={clKey} sn={sn} back={()=>{setNiche(null);setPg(P.HOME);}} gen={(t,v,refThumb)=>{const fresh=ls("vr6-niches",[]).find(x=>x.id===niche.id)||niche;setNiche({...fresh,topic:t,topicVersion:v||1,refThumb:refThumb||""});setPg(P.GEN);}} />}
        {pg===P.GEN && niche && <GenPg niche={niche} topic={niche.topic} version={niche.topicVersion||1} clKey={clKey} gemKey={gemKey} addH={addH} updateH={updateH} back={()=>setPg(P.NICHE)} goStudio={ctx=>{setStudioCtx(ctx);setPg(P.STUDIO);}} savedPrompt={niche.savedPrompt} savedThumb={niche.savedThumb} savedHistId={niche.savedHistId} refThumb={niche.refThumb} savedThumbs={niche.savedThumbs} savedOptTitles={niche.savedOptTitles} savedOptDesc={niche.savedOptDesc} savedOptTags={niche.savedOptTags} savedThPrompt={niche.savedThPrompt} />}
        {pg===P.STUDIO && niche && studioCtx && <Studio niche={niche} ctx={studioCtx} clKey={clKey} gemKey={gemKey} pexKey={pexKey} pixKey={pixKey} covKey={covKey} ai33Key={ai33Key} ai33Base={ai33Base} addH={addH} updateH={updateH} back={()=>setPg(P.GEN)} />}
        {pg===P.FINDER && <NicheFinder ytKey={ytKey} clKey={clKey} niches={niches} sn={sn} goNiche={n=>{openNiche(n);setPg(P.NICHE);}} />}
      </Suspense></ErrorBoundary></main>
    </div>
    <style>{CSS}</style>
  </div>);
}

const P_LABELS = { ytKey:"YouTube Data API", clKey:"Anthropic", gemKey:"Google Gemini", ai33Key:"AI33", ai33Base:"AI33 base URL", covKey:"Coverr", pixKey:"Pixabay", pexKey:"Pexels" };

function SettingsPg({ keys, setKeys }) {
  const [k, setK] = useState(keys);
  const [saved, setSaved] = useState(false);
  const row = (field, label, desc, ph, type="password") => (
    <div className="nv-set-row" key={field}>
      <div className="nv-set-info">
        <div className="nv-set-label">{label}{type === "password" && keys[field] ? <span className="nv-set-ok">Connected</span> : null}</div>
        <div className="nv-set-desc">{desc}</div>
      </div>
      <input className="yt-input nv-set-input" type={type} placeholder={ph} value={k[field]} onChange={e=>{setK(prev=>({...prev,[field]:e.target.value}));setSaved(false);}}/>
    </div>
  );
  return (<div className="yt-page nv-narrow">
    <h1 className="yt-page-title">Settings</h1>
    <p className="yt-sub">Connect the services VidRush uses. Keys are stored in this browser only — they never touch a server of ours.</p>

    <div className="nv-set-group">
      <div className="nv-set-group-t">Core</div>
      {row("ytKey","YouTube Data API v3","Competitor scanning, outliers, and the niche finder.","AIza…")}
      {row("clKey","Anthropic","Topic research, scripts, storyboards, and SEO copy.","sk-ant-…")}
      {row("gemKey","Google Gemini","Scene frames, thumbnails, and the built-in voices.","AIza…")}
    </div>

    <div className="nv-set-group">
      <div className="nv-set-group-t">Voice & music</div>
      {row("ai33Key","AI33","ElevenLabs, MiniMax and Fish Audio voices, voice cloning, and Suno music.","xi-api-key…")}
      {row("ai33Base","AI33 base URL","Only change this if your AI33 dashboard says so.","https://api.ai33.pro","text")}
    </div>

    <div className="nv-set-group">
      <div className="nv-set-group-t">Stock footage</div>
      {row("covKey","Coverr","Primary source for real b-roll clips.","Bearer key…")}
      {row("pixKey","Pixabay","Primary source for real clips and photos.","4859…")}
      {row("pexKey","Pexels","Fallback source when the others come up empty.","563492ad…")}
    </div>

    <div className="nv-set-foot">
      <button className="yt-btn" onClick={()=>{setKeys(k);setSaved(true);}}>Save changes</button>
      {saved && <span className="nv-set-saved">Saved</span>}
    </div>
  </div>);
}

function Home({ niches, sn, go, goFinder, goSettings, keysReady }) {
  const pageRef = useReveal([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(""); const [desc, setDesc] = useState(""); const [cover, setCover] = useState("");
  const [openSeo, setOpenSeo] = useState(null);
  const seoPkgs = niches.flatMap(n=>(n.history||[]).filter(h=>h.seo).map(h=>({nicheName:n.name,...h})));
  const handleCover = (e) => { const f=e.target.files[0]; if(!f) return; const r=new FileReader(); r.onload=ev=>setCover(ev.target.result); r.readAsDataURL(f); e.target.value=''; };
  const add = () => { if(!name.trim()) return; sn([...niches,{id:Date.now(),name:name.trim(),desc:desc.trim(),cover:cover||"",channels:[],history:[]}]); setName(""); setDesc(""); setCover(""); setAdding(false); };

  return (<div className="yt-page" ref={pageRef}>
    <h1 className="yt-page-title nv-h1">Home</h1>
    <p className="yt-sub">Everything from niche discovery to a finished, upload-ready video lives here.</p>

    {!keysReady && <div className="nv-callout">
      <div><b>Connect your services to get started.</b> VidRush needs at least YouTube, Anthropic, and Gemini keys.</div>
      <button className="yt-btn-o" onClick={goSettings}>Open settings</button>
    </div>}

    <div className="nv-stats">
      <div className="nv-stat"><span className="nv-stat-n"><Counter value={niches.length}/></span><span className="nv-stat-l">Niches</span></div>
      <div className="nv-stat"><span className="nv-stat-n"><Counter value={niches.reduce((s,n)=>s+(n.history?.length||0),0)}/></span><span className="nv-stat-l">Topics</span></div>
      <div className="nv-stat"><span className="nv-stat-n"><Counter value={niches.reduce((s,n)=>s+(n.channels?.length||0),0)}/></span><span className="nv-stat-l">Tracked channels</span></div>
      <div className="nv-stat"><span className="nv-stat-n"><Counter value={niches.reduce((s,n)=>s+(n.history||[]).filter(h=>h.seo).length,0)}/></span><span className="nv-stat-l">SEO packs</span></div>
    </div>

    <div className="yt-sec-h"><h2>Niches</h2><div className="yt-btn-row">
      <button className="yt-btn-o" onClick={goFinder}>Find a niche</button>
      <button className="yt-btn" onClick={()=>setAdding(true)}>New niche</button>
    </div></div>
    {adding && <div className="yt-card"><div className="yt-card-b" style={{marginTop:0}}>
      <div className="yt-niche-form">
        <div className="yt-niche-cover-upload">
          <label className="yt-cover-drop">
            <input type="file" accept="image/*" onChange={handleCover} style={{display:'none'}}/>
            {cover ? <img src={cover} className="yt-cover-preview" alt=""/> : <span className="yt-cover-text">Add cover</span>}
          </label>
        </div>
        <div className="yt-niche-form-fields">
          <div><label className="yt-label">Name</label><input className="yt-input" placeholder="e.g. Ancient Rome mysteries" value={name} onChange={e=>setName(e.target.value)} autoFocus/></div>
          <div><label className="yt-label">Description</label><input className="yt-input" placeholder="One line on what this channel covers" value={desc} onChange={e=>setDesc(e.target.value)}/></div>
        </div>
      </div>
      <div className="yt-btn-row" style={{marginTop:14}}><button className="yt-btn" onClick={add}>Create niche</button><button className="yt-btn-o" onClick={()=>{setAdding(false);setCover("");}}>Cancel</button></div>
    </div></div>}
    {niches.length===0&&!adding ? <div className="yt-empty-state">
        <p className="yt-empty-title">No niches yet</p>
        <p className="yt-empty-desc">Run the niche finder to scout opportunities, or create one by hand.</p>
        <button className="yt-btn" style={{marginTop:14}} onClick={goFinder}>Open niche finder</button>
      </div> :
      <div className="yt-niche-grid">{niches.map(n=><div key={n.id} className="yt-niche-card" onClick={()=>go(n)}>
        {n.cover && <div className="yt-niche-cover-wrap"><img src={n.cover} className="yt-niche-cover" alt=""/></div>}
        <div className="yt-niche-card-body">
          <div className="yt-niche-top"><h3>{n.name}</h3><button className="yt-x" onClick={e=>{e.stopPropagation();if(confirm("Delete niche?"))sn(niches.filter(x=>x.id!==n.id));}}>✕</button></div>
          {n.desc&&<p className="yt-niche-desc">{n.desc}</p>}
          <div className="yt-niche-meta"><span>{n.channels?.length||0} channels</span><span>{n.history?.length||0} topics</span></div>
        </div>
      </div>)}</div>}

    {seoPkgs.length>0&&<><div className="yt-sec-h" style={{marginTop:36}}><h2>SEO packages</h2></div>
      <div className="yt-seo-board">{seoPkgs.map(p=><div key={p.id} className="yt-card yt-seo-card">
        <div className="yt-card-h" onClick={()=>setOpenSeo(openSeo===p.id?null:p.id)}>
          <span className="yt-card-ht">{p.topic}<span className="yt-seo-niche">{p.nicheName} · {p.date}</span></span>
          <span className="yt-chev">{openSeo===p.id?"▲":"▼"}</span>
        </div>
        {openSeo===p.id&&<div className="yt-card-b"><SeoView seo={p.seo} compact/></div>}
      </div>)}</div></>}
  </div>);
}

function NichePg({ niche, niches, ytKey, clKey, sn, back, gen }) {
  const [ch, setCh] = useState(""); const [topics, setTopics] = useState([]); const [outs, setOuts] = useState([]);
  const [ld, setLd] = useState(false); const [ldRegen, setLdRegen] = useState(false);
  const [st, setSt] = useState(""); const [cust, setCust] = useState(""); const [showO, setShowO] = useState(true);
  const [lastData, setLastData] = useState("");
  const [days, setDays] = useState(0);
  const [allRaw, setAllRaw] = useState([]);
  const [scanned, setScanned] = useState(false);
  const chs = niche.channels||[]; const hist = niche.history||[];
  const usedTitles = hist.map(h=>h.topic.toLowerCase());
  const upd = u => { sn(niches.map(n=>n.id===niche.id?u:n)); niche.channels=u.channels; };
  const addCh = () => { if(!ch.trim()) return; upd({...niche,channels:[...chs,ch.trim()]}); setCh(""); };
  const rmCh = i => upd({...niche,channels:chs.filter((_,j)=>j!==i)});

  const getVersionCount = (title) => hist.filter(h => h.topic.toLowerCase() === title.toLowerCase()).length;

  const genTopics = async (data) => {
    const usedStr=usedTitles.length?`\n\nALREADY DONE:\n${usedTitles.join("\n")}`:"";
    try { const raw=await ai(SYS_T,`Niche: ${niche.name}\n${niche.desc||""}\n\nTOP:\n${data}${usedStr}\n\n10 English topics.`,clKey); return JSON.parse(raw.replace(/```json|```/g,"").trim()); } catch(e){ throw e; }
  };

  useEffect(() => { if (chs.length && ytKey && !scanned) { setScanned(true); analyze(); } }, []);

  const analyze = async () => {
    if(!ytKey){setSt("⚠ Set YouTube API Key!");return;} if(chs.length===0){setSt("⚠ Add channels!");return;}
    setLd(true); setSt(""); setOuts([]); setTopics([]); let allO=[];
    for(let i=0;i<chs.length;i++){ setSt(`${i+1}/${chs.length}: ${chs[i]}`); try { const id=await resolveChannel(chs[i],ytKey); const{name,videos}=await getVideos(id,ytKey,(n)=>setSt(`${i+1}/${chs.length}: ${chs[i]} (${n} videos...)`)); allO.push(...rankVideos(videos).map(v=>({...v,channel:name}))); } catch(e){ setSt(`⚠ ${chs[i]}: ${e.message}`); await new Promise(r=>setTimeout(r,1200)); }}
    allO.sort((a,b)=>b.views-a.views);
    setAllRaw(allO);
    const byDays = filterByDays(allO, days);
    const filtered = byDays.filter(v => !usedTitles.includes(v.title.toLowerCase()));
    setOuts(filtered.slice(0,40));
    const data=allO.slice(0,15).map(v=>`"${v.title}" — ${fmt(v.views)} (${v.ratio}x) [${v.channel}]`).join("\n");
    setLastData(data);
    if(!allO.length){setSt("No videos found.");} else {setSt(`✅ ${allO.length} videos loaded`);}
    setLd(false);
  };

  const suggest = async () => {
    if(!clKey){setSt("⚠ Set Anthropic API Key!");return;}
    if(!lastData){setSt("⚠ Scan channels first!");return;}
    setLdRegen(true); setSt("AI analyzing...");
    try { setTopics(await genTopics(lastData)); setSt("✅ 10 topic ideas"); } catch(e){setSt("⚠ "+e.message);}
    setLdRegen(false);
  };

  const regenerate = async () => {
    if(!lastData){setSt("⚠ Scan channels first!");return;}
    if(!clKey){setSt("⚠ Set Anthropic API Key!");return;}
    setLdRegen(true); setSt("Regenerating topics...");
    try { setTopics(await genTopics(lastData)); setSt("✅ 10 fresh ideas"); } catch(e){setSt("⚠ "+e.message);}
    setLdRegen(false);
  };

  const changeDays = (d) => {
    setDays(d);
    if (allRaw.length) {
      const byDays = filterByDays(allRaw, d);
      const filtered = byDays.filter(v => !usedTitles.includes(v.title.toLowerCase()));
      setOuts(filtered.slice(0,40));
    }
  };

  const daysLabel = days === 0 ? "All Time" : `Last ${days} Days`;

  return (<div className="yt-page">
    <div className="yt-breadcrumb"><button className="yt-btn-o" onClick={back}>← Dashboard</button><h1 className="yt-page-title">{niche.name}</h1></div>
    {niche.desc&&<p className="yt-sub">{niche.desc}</p>}
    {allRaw.length>0&&<div className="yt-info-bar"><div className="yt-info-item"><span className="yt-info-num">{allRaw.length}</span>videos scanned</div><div className="yt-info-item"><span className="yt-info-num">{outs.length}</span>showing</div><div className="yt-info-item"><span className="yt-info-num">{chs.length}</span>channels</div><div className="yt-info-item"><span className="yt-info-num">{hist.length}</span>topics used</div></div>}

    <div className="yt-card"><div className="yt-card-ht">Channels</div><p className="yt-hint">YouTube URL or @handle</p><div className="yt-input-row"><input className="yt-input" placeholder="@ChannelName or URL" value={ch} onChange={e=>setCh(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addCh()}/><button className="yt-btn" onClick={addCh}>Add</button></div>{chs.length>0&&<div className="yt-chips">{chs.map((c,i)=><span key={i} className="yt-chip">{c}<button onClick={()=>rmCh(i)}>✕</button></span>)}</div>}</div>

    <div className="yt-card"><div className="yt-card-ht">Analysis</div>
      <button className={`yt-btn-big ${ld?'yt-btn-big-ld':''}`} onClick={analyze} disabled={ld||ldRegen}>{ld?"Scanning...":"Scan Channels"}</button>
      {st&&<p className={`yt-st ${st[0]==="⚠"?'err':st[0]==="✅"?'ok':''}`}>{st}</p>}
      {outs.length>0&&<><div className="yt-toggle" onClick={()=>setShowO(!showO)}><span className="yt-toggle-t">Top Videos — {daysLabel} ({outs.length})</span><span className="yt-chev">{showO?"▲":"▼"}</span></div>
      {showO&&<><div className="yt-days-filter">{[30,60,90,0].map(d=><button key={d} className={`yt-days-chip ${days===d?'active':''}`} onClick={()=>changeDays(d)}>{d===0?"All":d+"d"}</button>)}</div>
      <div className="yt-out-grid">{outs.map((v,i)=><div key={i} className="yt-out-card">
        <div className="yt-out-card-img-wrap">
          {v.thumb&&<img src={v.thumbHi||v.thumb} className="yt-out-card-img" alt=""/>}
          <span className="yt-out-card-ratio">{v.ratio}x</span>
          <span className="yt-out-card-views">{fmt(v.views)}</span>
        </div>
        <div className="yt-out-card-body">
          <div className="yt-out-card-title">{v.title}</div>
          <div className="yt-out-card-ch">{v.channel}{v.date ? ` · ${v.date}` : ""}</div>
          <div className="yt-out-card-btns">
            <button className="yt-btn-use-sm" onClick={()=>gen(v.title, getVersionCount(v.title)+1, v.thumbHi||v.thumb)}>Use →</button>
          </div>
        </div>
      </div>)}</div></>}</>}
    </div>

    {allRaw.length>0&&!topics.length&&<button className={`yt-btn-big yt-btn-big-suggest ${ldRegen?'yt-btn-big-ld':''}`} onClick={suggest} disabled={ld||ldRegen} style={{marginBottom:16}}>{ldRegen?"Analyzing...":"Suggest Topics"}</button>}

    {topics.length>0&&<div className="yt-card">
      <div className="yt-card-h">
        <span className="yt-card-ht">Topics</span>
        <button className={`yt-btn-regen ${ldRegen?'yt-btn-ld':''}`} onClick={regenerate} disabled={ld||ldRegen}>{ldRegen?"…":"Regenerate"}</button>
      </div>
      <div className="yt-topics">{topics.map((t,i)=>{
      const vc=getVersionCount(t.title); const done=vc>0;
      return <div key={i} className={`yt-topic ${done?'yt-topic-done':''}`}>
        <div className="yt-topic-h"><span className="yt-topic-t">{t.title}</span>{done&&<span className="yt-badge-used">USED ×{vc}</span>}</div>
        {t.angle&&<p className="yt-topic-a">{t.angle}</p>}
        {t.why&&<p className="yt-topic-w">{t.why}</p>}
        {t.inspired_by&&<p className="yt-topic-i">{t.inspired_by}</p>}
        <div className="yt-topic-btns">
          {!done && <button className="yt-btn-use" onClick={()=>gen(t.title,1)}>Use Topic →</button>}
          {done && <button className="yt-btn-remake" onClick={()=>gen(t.title,vc+1)}>Remake (v{vc+1})</button>}
        </div>
      </div>;})}</div>
    </div>}

    <div className="yt-card"><div className="yt-card-ht">Custom Topic</div><div className="yt-input-row"><input className="yt-input" placeholder="Your own topic..." value={cust} onChange={e=>setCust(e.target.value)} onKeyDown={e=>e.key==="Enter"&&cust.trim()&&gen(cust.trim(),getVersionCount(cust.trim())+1)}/><button className="yt-btn" onClick={()=>cust.trim()&&gen(cust.trim(),getVersionCount(cust.trim())+1)} disabled={!cust.trim()}>Go →</button></div></div>
  </div>);
}

function GenPg({ niche, topic, version, clKey, gemKey, addH, updateH, back, goStudio, savedPrompt, savedThumb, savedHistId, refThumb: initialRefThumb, savedThumbs, savedOptTitles, savedOptDesc, savedOptTags, savedThPrompt }) {
  const [mode, setMode] = useState(savedPrompt ? "auto" : null);
  const [sty, setSty] = useState("documentary"); const [dur, setDur] = useState("15");
  const [prompt, setPrompt] = useState(savedPrompt || "");
  const [thumb, setThumb] = useState(savedThumb || "");
  const [optTitles, setOptTitles] = useState(savedOptTitles || []); const [optDesc, setOptDesc] = useState(savedOptDesc || ""); const [optTags, setOptTags] = useState(savedOptTags || []);
  const [ld, setLd] = useState(false); const [ldO, setLdO] = useState(false);
  const [tab, setTab] = useState(savedPrompt ? "prompt" : "prompt");
  const [cp, setCp] = useState(""); const [saved, setSaved] = useState(!!savedPrompt);
  const [histId, setHistId] = useState(savedHistId || null);
  const [refThumb, setRefThumb] = useState(initialRefThumb || "");
  // Thumbnail workflow state
  const [thMode, setThMode] = useState(null); // null | "reference" | "scratch"
  const [thRefImg, setThRefImg] = useState(initialRefThumb || ""); // reference image (URL or data URI)
  const [thRefB64, setThRefB64] = useState(null); // {data, mime} for uploaded
  const [thPrompt, setThPrompt] = useState(savedThPrompt || ""); // AI-generated or manual prompt for Nana Banana
  const [thRefine, setThRefine] = useState(""); // user refinement instructions
  const [thAnalyzing, setThAnalyzing] = useState(false);
  const [thRefining, setThRefining] = useState(false);
  const [thumbCount, setThumbCount] = useState("2");
  const [thumbWithText, setThumbWithText] = useState(true);
  const [thumbSendRef, setThumbSendRef] = useState(false);
  const [thumbResults, setThumbResults] = useState(savedThumbs || []);
  const [thumbLoading, setThumbLoading] = useState([]);
  const [userRefs, setUserRefs] = useState([]);
  const cc = prompt.length;

  // Auto-save optimize + thPrompt to history (NOT thumb images — too large for localStorage)
  useEffect(() => {
    if (!histId || !saved) return;
    if (optTitles.length > 0 || optDesc || thPrompt) {
      updateH(niche.id, histId, { optTitles, optDesc, optTags, thPrompt });
    }
  }, [optTitles, optDesc, optTags, thPrompt]);

  const handleThRefUpload = (e) => {
    const file = e.target.files?.[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const full = ev.target.result;
      const mime = file.type || 'image/jpeg';
      const b64 = full.split(',')[1];
      setThRefImg(full);
      setThRefB64({ data: b64, mime });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleRefFiles = (e) => {
    const files = Array.from(e.target.files).slice(0, 5 - userRefs.length);
    files.forEach(file => {
      if (userRefs.length >= 5) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const full = ev.target.result;
        const mime = file.type || 'image/jpeg';
        const b64 = full.split(',')[1];
        setUserRefs(prev => [...prev, { data: b64, mime, preview: full }]);
      };
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  };
  const removeRef = (idx) => setUserRefs(prev => prev.filter((_,i) => i !== idx));

  // Analyze reference image → generate Nana Banana prompt via Claude
  const analyzeReference = async () => {
    if(!clKey) return;
    setThAnalyzing(true);
    const SYS_NANA = `Write a prompt to generate an image that looks as close as possible to the reference photo.

Describe EXACTLY what you see in the image in extreme detail:
- Every object, person, element — what it is, where it is, how big, what color
- Camera angle, perspective, framing
- Lighting — direction, intensity, color temperature, shadows
- Colors — exact tones, contrast, saturation
- Textures, materials, surfaces
- Background, foreground, depth
- Mood, atmosphere

Write ONE dense paragraph (150-250 words). Start with "Generate a photorealistic wide image (16:9 aspect ratio, 1280x720)."

Be extremely precise — the goal is to recreate this image as closely as possible. Describe what you SEE, not what you interpret.

End with: "no text on the image."

After the prompt, on a NEW line write:
TEXT OVERLAY: suggest what text to overlay in Canva (content, font style, color, placement).

English only. No markdown.`;

    try {
      let result;
      const userMsg = `Write a prompt to generate an image maximally similar to this reference. Describe exactly what you see.`;
      if (thRefB64) {
        result = await aiVision(SYS_NANA, userMsg, thRefB64, clKey);
      } else if (thRefImg) {
        result = await aiVision(SYS_NANA, userMsg, thRefImg, clKey);
      }
      if (result) setThPrompt(result.replace(/```/g,"").trim());
    } catch(e) { setThPrompt("❌ Error: " + e.message); }
    setThAnalyzing(false);
  };

  // Refine existing prompt with user instructions
  const refinePrompt = async () => {
    if(!clKey || !thRefine.trim()) return;
    setThRefining(true);
    const SYS_REFINE = `You are a thumbnail prompt editor. You receive an existing Nana Banana / Midjourney prompt and user's edit instructions. Apply the edits and return the UPDATED prompt. Keep the same format — one dense paragraph, 80-150 words, ending with style instructions. Return ONLY the updated prompt text, nothing else.`;
    try {
      const result = await ai(SYS_REFINE, `CURRENT PROMPT:\n${thPrompt}\n\nUSER EDITS:\n${thRefine}`, clKey);
      setThPrompt(result.replace(/```/g,"").trim());
      setThRefine("");
    } catch(e) { /* ignore */ }
    setThRefining(false);
  };

  const runOptimize = async () => {
    if(!clKey) return; setLdO(true);
    try {
      const [tRaw, dRaw, gRaw] = await Promise.all([
        ai(SYS_OPT_TITLES, `Topic: "${topic}"\nNiche: ${niche.name}`, clKey),
        ai(SYS_OPT_DESC, `Topic: "${topic}"\nNiche: ${niche.name}\nStyle: ${sty}`, clKey),
        ai(SYS_OPT_TAGS, `Topic: "${topic}"\nNiche: ${niche.name}`, clKey),
      ]);
      try { setOptTitles(JSON.parse(tRaw.replace(/```json|```/g,"").trim())); } catch { setOptTitles([tRaw]); }
      setOptDesc(dRaw.replace(/```/g,"").trim());
      try { setOptTags(JSON.parse(gRaw.replace(/```json|```/g,"").trim())); } catch { setOptTags([gRaw]); }
    } catch(e) { setOptDesc("❌ "+e.message); }
    setLdO(false);
  };

  // Get used items from all previous versions of same topic
  const getUsedItems = () => {
    const hist = niche.history || [];
    return hist.filter(h => h.topic.toLowerCase() === topic.toLowerCase() && h.usedItems?.length).flatMap(h => h.usedItems);
  };

  const go = async () => {
    if(!clKey){setPrompt("⚠ Set Anthropic API Key!");return;} setLd(true); setPrompt(""); setTab("prompt");
    let extra = "";
    const usedItems = getUsedItems();
    if(version > 1) { extra = `\n\nIMPORTANT: This is VERSION ${version} of this topic. Previous versions already covered this topic. You MUST use COMPLETELY DIFFERENT specific items, examples, facts, and angles than would be typical. Find obscure, lesser-known, surprising entries that a hardcore fan hasn't seen before. Do NOT repeat the obvious choices.`; }
    if(usedItems.length > 0) { extra += `\n\n⛔ ALREADY USED IN PREVIOUS VERSIONS — DO NOT REPEAT ANY OF THESE:\n${usedItems.join(", ")}\n\nYou MUST pick DIFFERENT items that are NOT in this list.`; }
    try {
      const r = await ai(SYS_P(mode), `Topic: ${topic}\nNiche: ${niche.name}\nDuration: ${dur} min\nStyle: ${sty==="documentary"?"Documentary (NO numbered lists)":"Top 10 listicle"}\n\nSTRICT LIMIT: Stay under 9,000 characters total. Be detailed but concise — no filler, no repetition.${extra}`, clKey);
      setPrompt(r); setLd(false);
      let newHistId = histId;
      if(!saved){
        newHistId = addH(niche.id, topic, version, r, "");
        setHistId(newHistId); setSaved(true);
      } else if(histId) {
        updateH(niche.id, histId, { prompt: r });
      }
      // Extract items in background — don't block UI
      ai(`Extract the main items/subjects/entries from this script prompt. Return ONLY a JSON array of short names. Example: ["Aloe Vera","Lavender","Turmeric"]. No markdown, ONLY the JSON array.`, r, clKey)
        .then(raw => { try { const items = JSON.parse(raw.replace(/```json|```/g,"").trim()); if(items.length) updateH(niche.id, newHistId, { usedItems: items }); } catch {} })
        .catch(() => {});
    } catch(e){setPrompt("❌ "+e.message); setLd(false);}
    if(!optDesc) runOptimize();
  };

  const generateThumb = async (idx) => {
    if(!gemKey) return;
    setThumbLoading(prev => { const n=[...prev]; n[idx]=true; return n; });
    const textInstr = thumbWithText ? 'Include bold, eye-catching text/title overlay on the thumbnail exactly as described in the prompt.' : 'IMPORTANT: Do NOT add any text on the image. Purely visual, no text overlays.';
    const userP = thPrompt.trim() || topic;
    const variation = idx === 0 ? '' : ` Create variation ${idx+1} — same style but slightly different angle/composition.`;
    const promptText = `Generate a PHOTOREALISTIC YouTube video thumbnail, 16:9 aspect ratio. The image must look like a REAL photograph taken by a professional photographer — NOT AI-generated. Real skin textures, real materials, real lighting. FOLLOW THIS PROMPT EXACTLY: ${userP}. ${textInstr}${variation}`;
    const parts = [{ text: promptText }];
    // Attach reference image if checkbox enabled
    if (thumbSendRef && thMode === "reference") {
      if (thRefB64) {
        parts.push({ inline_data: { mime_type: thRefB64.mime, data: thRefB64.data } });
      } else if (thRefImg) {
        try {
          const resp = await fetch(thRefImg);
          const blob = await resp.blob();
          const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
          parts.push({ inline_data: { mime_type: blob.type || 'image/jpeg', data: b64 } });
        } catch {}
      }
    }
    userRefs.forEach(ref => { parts.push({ inline_data: { mime_type: ref.mime, data: ref.data } }); });
    const body = {
      contents: [{ parts }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'], imageConfig: { aspectRatio: '16:9' } }
    };
    try {
      let resp;
      for (let attempt = 1; attempt <= 3; attempt++) {
        resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${gemKey}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        if ((resp.status === 500 || resp.status === 503) && attempt < 3) { await new Promise(r=>setTimeout(r,attempt*2000)); continue; }
        break;
      }
      if (!resp.ok) { const err = await resp.json().catch(()=>({})); throw new Error(err.error?.message || `HTTP ${resp.status}`); }
      const data = await resp.json();
      let b64 = null;
      for (const part of (data.candidates?.[0]?.content?.parts || [])) { if (part.inlineData) { b64 = part.inlineData.data; break; } }
      if (!b64) throw new Error('No image in response');
      setThumbResults(prev => { const n=[...prev]; n[idx]={ url: `data:image/png;base64,${b64}`, prompt: promptText }; return n; });
    } catch(e) {
      setThumbResults(prev => { const n=[...prev]; n[idx]={ error: e.message }; return n; });
    }
    setThumbLoading(prev => { const n=[...prev]; n[idx]=false; return n; });
  };

  const [thumbGenerating, setThumbGenerating] = useState(false);

  const generateAllThumbs = () => {
    if(!gemKey) return;
    const count = parseInt(thumbCount);
    const startIdx = thumbResults.length;
    // Append new placeholders at the END
    setThumbResults(prev => [...prev, ...Array(count).fill(null)]);
    setThumbLoading(prev => [...prev, ...Array(count).fill(true)]);
    setTab("thumbnail");
    // Fire all in parallel — no blocking
    for (let i = 0; i < count; i++) {
      generateThumb(startIdx + i);
    }
  };

  const copy = (t, label) => { navigator.clipboard.writeText(t); setCp(label); setTimeout(()=>setCp(""),2e3); };

  if(!mode) return (<div className="yt-page">
    <div className="yt-breadcrumb"><button className="yt-btn-o" onClick={back}>← {niche.name}</button><h1 className="yt-page-title">Mode</h1></div>
    <div className="yt-topic-banner">{topic}{version>1&&<span className="yt-version-big">V{version}</span>}</div>
    {refThumb && <div className="yt-ref-preview"><img src={refThumb} alt="Reference" className="yt-ref-img"/><span className="yt-ref-label">Reference thumbnail attached</span><button className="yt-ref-rm" onClick={()=>setRefThumb("")}>✕</button></div>}
    <div className="yt-mode-grid">
      <button className="yt-mode auto" onClick={()=>setMode("auto")}><div className="yt-mode-ic"></div><div className="yt-mode-n">AUTO</div><div className="yt-mode-d">Prompt ready to paste</div><span className="yt-mode-b">SPEED</span></button>
      <button className="yt-mode manual" onClick={()=>setMode("manual")}><div className="yt-mode-ic"></div><div className="yt-mode-n">MANUAL</div><div className="yt-mode-d">Prompt + Q&A + refs</div><span className="yt-mode-b yt-mode-b2">CONTROL</span></button>
    </div>
  </div>);

  return (<div className="yt-page">
    <div className="yt-breadcrumb"><button className="yt-btn-o" onClick={()=>setMode(null)}>← Mode</button><h1 className="yt-page-title">Generate</h1><span className={`yt-mtag ${mode}`}>{mode.toUpperCase()}</span>{version>1&&<span className="yt-version-big">V{version}</span>}</div>
    <div className="yt-topic-banner">{topic}{version>1&&<span className="yt-version-big">V{version} — fresh content</span>}</div>
    {getUsedItems().length > 0 && <div className="yt-used-items"><span className="yt-used-items-label">Already used ({getUsedItems().length}):</span><span className="yt-used-items-list">{getUsedItems().join(", ")}</span></div>}
    <div className="yt-gen-ctrl">
      <div><label className="yt-label">Duration</label><select className="yt-sel" value={dur} onChange={e=>setDur(e.target.value)}><option value="8">6–8 min</option><option value="12">10–12 min</option><option value="15">13–15 min</option><option value="20">18–20 min</option><option value="30">25–30 min</option></select></div>
      <div><label className="yt-label">Style</label><select className="yt-sel" value={sty} onChange={e=>setSty(e.target.value)}><option value="documentary">Documentary</option><option value="top10">Top 10</option></select></div>
      <div className="yt-gen-btns">
        <button className={`yt-btn-gen ${ld?'yt-btn-ld':''}`} onClick={go} disabled={ld}>{ld?"Generating...":"Generate Prompt"}</button>
        <button className="yt-btn-studio" onClick={()=>goStudio({topic,version,histId,prompt})} title="Full pipeline: script → storyboard → visuals → voiceover → MP4 + SEO package">Storyboard Studio →</button>
      </div>
    </div>
    {ld&&<div className="yt-ld-box"><div className="yt-spin"/><p>Building detailed prompt...</p></div>}
    {(prompt||optTitles.length>0||optDesc||thumbResults.length>0)&&<>
      <div className="yt-tabs">
        <button className={`yt-tab ${tab==="prompt"?'active':''}`} onClick={()=>setTab("prompt")}>Prompt{prompt?` (${cc.toLocaleString()})`:""}</button>
        <button className={`yt-tab ${tab==="optimize"?'active':''}`} onClick={()=>setTab("optimize")}>Optimize{ldO?" …":optTitles.length?" ✓":""}</button>
        <button className={`yt-tab ${tab==="thumbnail"?'active':''}`} onClick={()=>setTab("thumbnail")}>Thumbnail{thumbResults.length?` (${thumbResults.filter(r=>r?.url).length})`:""}</button>
      </div>
      <div className="yt-out-panel">
        {tab==="prompt"&&<>
          <div className="yt-out-h"><span className={`yt-cc ${cc>10000?'over':''}`}>{cc.toLocaleString()}/10,000{cc>10000?" ⚠":" ✓"}</span><button className="yt-btn-cp" onClick={()=>copy(prompt,"prompt")}>{cp==="prompt"?"✅ Copied!":"Copy"}</button></div>
          <pre className="yt-pre">{prompt}</pre>
        </>}
        {tab==="optimize"&&<>
          {ldO&&<div className="yt-ld-box"><div className="yt-spin"/><p>Generating SEO...</p></div>}
          {optTitles.length>0&&<div className="yt-opt-section">
            <div className="yt-opt-h"><span className="yt-opt-label">Titles</span><button className="yt-btn-cp-sm" onClick={()=>copy(optTitles.join("\n"),"titles")}>{cp==="titles"?"✅":"Copy"}</button></div>
            {optTitles.map((t,i)=><div key={i} className="yt-opt-title" onClick={()=>copy(t,"t"+i)}>
              <span className="yt-opt-num">{i+1}</span><span>{t}</span>{cp===("t"+i)&&<span className="yt-opt-copied">✅</span>}
            </div>)}
          </div>}
          {optDesc&&<div className="yt-opt-section">
            <div className="yt-opt-h"><span className="yt-opt-label">Descriptions ({optDesc.split('---').filter(d=>d.trim()).length} variants)</span></div>
            {optDesc.split('---').filter(d=>d.trim()).map((d,i)=><div key={i} className="yt-opt-desc-card">
              <div className="yt-opt-desc-head"><span className="yt-opt-num">{i+1}</span><span className="yt-opt-desc-tone">{["🔮 Curiosity","📚 Educational","💥 Clickbait"][i]||`#${i+1}`}</span><button className="yt-btn-cp-sm" onClick={()=>copy(d.trim(),"desc"+i)}>{cp===("desc"+i)?"✅":"Copy"}</button></div>
              <pre className="yt-pre yt-pre-sm">{d.trim()}</pre>
            </div>)}
          </div>}
          {optTags.length>0&&<div className="yt-opt-section">
            <div className="yt-opt-h"><span className="yt-opt-label">Tags</span><button className="yt-btn-cp-sm" onClick={()=>copy(optTags.join(", "),"tags")}>{cp==="tags"?"✅":"Copy"}</button></div>
            <div className="yt-opt-tags">{optTags.map((t,i)=><span key={i} className="yt-opt-tag" onClick={()=>copy(t,"tag"+i)}>{t}</span>)}</div>
          </div>}
          {!ldO&&!optTitles.length&&!optDesc&&<button className="yt-btn-big yt-btn-big-suggest" onClick={runOptimize}>Generate SEO</button>}
        </>}
        {tab==="thumbnail"&&<>
          {/* Step 1: Choose mode */}
          {!thMode && <div className="yt-th-choose">
            <p className="yt-th-choose-label">How do you want to create the thumbnail?</p>
            <div className="yt-th-choose-grid">
              <button className="yt-th-choose-btn" onClick={()=>{setThMode("reference"); if(initialRefThumb && !thRefImg) setThRefImg(initialRefThumb);}}>
                <span className="yt-th-choose-ic"></span>
                <span className="yt-th-choose-n">From Reference</span>
                <span className="yt-th-choose-d">Upload a photo or use outlier thumbnail → AI writes prompt</span>
                {initialRefThumb && <span className="yt-th-choose-tag">Outlier thumbnail available</span>}
              </button>
              <button className="yt-th-choose-btn" onClick={()=>setThMode("scratch")}>
                <span className="yt-th-choose-ic"></span>
                <span className="yt-th-choose-n">From Scratch</span>
                <span className="yt-th-choose-d">Write your own prompt or let AI generate one for the topic</span>
              </button>
            </div>
          </div>}

          {/* Step 2: Reference mode — upload/show image + analyze */}
          {thMode === "reference" && <>
            <div className="yt-th-ref-section">
              <div className="yt-th-ref-top">
                <button className="yt-btn-o" onClick={()=>{setThMode(null);setThPrompt("");}} style={{marginBottom:12}}>← Change mode</button>
              </div>
              <div className="yt-th-ref-layout">
                <div className="yt-th-ref-img-col">
                  <label className="yt-label">Reference Image</label>
                  {thRefImg ? (
                    <div className="yt-th-ref-preview">
                      <img src={thRefImg} alt="Reference" className="yt-th-ref-big"/>
                      <div className="yt-th-ref-overlay">
                        <button className="yt-th-ref-change" onClick={()=>{setThRefImg("");setThRefB64(null);setThPrompt("");}}>Change</button>
                        <label className="yt-th-ref-change">
                          <input type="file" accept="image/*" onChange={handleThRefUpload} style={{display:'none'}}/>
                          Upload New
                        </label>
                      </div>
                    </div>
                  ) : (
                    <label className="yt-th-ref-drop-big">
                      <input type="file" accept="image/*" onChange={handleThRefUpload} style={{display:'none'}}/>
                      <span className="yt-th-ref-drop-ic"></span>
                      <span className="yt-th-ref-drop-t">Drop reference photo here</span>
                      <span className="yt-th-ref-drop-d">or click to upload</span>
                    </label>
                  )}
                </div>
                <div className="yt-th-prompt-col">
                  <div className="yt-th-prompt-header">
                    <label className="yt-label">Nana Banana Prompt</label>
                    {thRefImg && !thPrompt && <button className={`yt-btn ${thAnalyzing?'yt-btn-ld':''}`} onClick={analyzeReference} disabled={thAnalyzing}>{thAnalyzing?"Analyzing...":"Analyze & Write Prompt"}</button>}
                  </div>
                  {thAnalyzing && <div className="yt-ld-box"><div className="yt-spin"/><p>Claude analyzing reference...</p></div>}
                  {thPrompt && <>
                    <textarea className="yt-input yt-th-prompt-area" rows="8" value={thPrompt} onChange={e=>setThPrompt(e.target.value)} placeholder="AI-generated prompt will appear here..."/>
                    <div className="yt-th-prompt-actions">
                      <button className="yt-btn-cp" onClick={()=>copy(thPrompt,"thprompt")}>{cp==="thprompt"?"✅ Copied!":"Copy Prompt"}</button>
                    </div>
                    {/* Refine section */}
                    <div className="yt-th-refine">
                      <label className="yt-label">Refine Prompt</label>
                      <div className="yt-th-refine-row">
                        <textarea className="yt-input yt-th-refine-input" rows="2" value={thRefine} onChange={e=>setThRefine(e.target.value)} placeholder="e.g. Add bold yellow title 'THIS CHANGES EVERYTHING', replace fruit with vegetable, make background darker..." onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();refinePrompt();}}}/>
                        <button className={`yt-btn-refine ${thRefining?'yt-btn-ld':''}`} onClick={refinePrompt} disabled={thRefining||!thRefine.trim()}>{thRefining?"…":"Refine"}</button>
                      </div>
                    </div>
                  </>}
                </div>
              </div>
            </div>
          </>}

          {/* Step 2b: From Scratch mode */}
          {thMode === "scratch" && <>
            <div className="yt-th-ref-section">
              <div className="yt-th-ref-top">
                <button className="yt-btn-o" onClick={()=>{setThMode(null);setThPrompt("");}} style={{marginBottom:12}}>← Change mode</button>
              </div>
              <div className="yt-th-scratch-layout">
                <div className="yt-th-prompt-col" style={{flex:1}}>
                  <div className="yt-th-prompt-header">
                    <label className="yt-label">Thumbnail Prompt</label>
                    {!thPrompt && <button className={`yt-btn ${thAnalyzing?'yt-btn-ld':''}`} onClick={async()=>{
                      setThAnalyzing(true);
                      try{
                        const r = await ai(`You are a YouTube thumbnail prompt engineer. Write a SINGLE dense paragraph (80-150 words) prompt for an AI image generator (Midjourney/Nana Banana) for the given topic. The prompt must describe: composition, subject, lighting, colors, mood, and end with "hyperrealistic cinematic photography, 16:9 aspect ratio". Make it CLICKBAIT and eye-catching. Return ONLY the prompt.`, `Topic: "${topic}"\nNiche: ${niche.name}`, clKey);
                        setThPrompt(r.replace(/```/g,"").trim());
                      }catch(e){setThPrompt("❌ "+e.message);}
                      setThAnalyzing(false);
                    }} disabled={thAnalyzing}>{thAnalyzing?"Generating...":"Auto-Generate Prompt"}</button>}
                  </div>
                  {thAnalyzing && <div className="yt-ld-box"><div className="yt-spin"/><p>Writing thumbnail prompt...</p></div>}
                  <textarea className="yt-input yt-th-prompt-area" rows="6" value={thPrompt} onChange={e=>setThPrompt(e.target.value)} placeholder={`Write your Nana Banana / Midjourney prompt here...\n\nExample: Close-up of a person's shocked face looking at a glowing ancient plant, dramatic golden backlighting, deep shadows...`}/>
                  {thPrompt && <>
                    <div className="yt-th-prompt-actions">
                      <button className="yt-btn-cp" onClick={()=>copy(thPrompt,"thprompt")}>{cp==="thprompt"?"✅ Copied!":"Copy Prompt"}</button>
                    </div>
                    <div className="yt-th-refine">
                      <label className="yt-label">Refine Prompt</label>
                      <div className="yt-th-refine-row">
                        <textarea className="yt-input yt-th-refine-input" rows="2" value={thRefine} onChange={e=>setThRefine(e.target.value)} placeholder="e.g. Make it more dramatic, add a person, change colors to blue..." onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();refinePrompt();}}}/>
                        <button className={`yt-btn-refine ${thRefining?'yt-btn-ld':''}`} onClick={refinePrompt} disabled={thRefining||!thRefine.trim()}>{thRefining?"…":"Refine"}</button>
                      </div>
                    </div>
                  </>}
                </div>
                <div className="yt-th-scratch-refs">
                  <label className="yt-label">Extra Reference Photos (optional)</label>
                  <label className="yt-thumb-drop">
                    <input type="file" accept="image/*" multiple onChange={handleRefFiles} style={{display:'none'}}/>
                    Add reference photos
                  </label>
                  {userRefs.length>0 && <div className="yt-thumb-ref-list">{userRefs.map((ref,i)=><div key={i} className="yt-thumb-ref-card"><img src={ref.preview} className="yt-thumb-ref-img" alt=""/><button className="yt-thumb-ref-rm" onClick={()=>removeRef(i)}>✕</button></div>)}</div>}
                </div>
              </div>
            </div>
          </>}

          {/* Step 3: Generate section — visible in both modes when prompt exists */}
          {thMode && thPrompt && <>
            <div className="yt-th-gen-bar">
              <div className="yt-thumb-options">
                <div><label className="yt-label">Count</label><select className="yt-sel" value={thumbCount} onChange={e=>setThumbCount(e.target.value)}><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option></select></div>
                <label className="yt-thumb-check"><input type="checkbox" checked={thumbWithText} onChange={e=>setThumbWithText(e.target.checked)}/><span>With text</span></label>
                {thMode === "reference" && thRefImg && <label className="yt-thumb-check"><input type="checkbox" checked={thumbSendRef} onChange={e=>setThumbSendRef(e.target.checked)}/><span>Send reference</span></label>}
              </div>
              <button className="yt-btn-big" onClick={generateAllThumbs} disabled={!gemKey} style={{marginTop:12}}>{!gemKey?"⚠ Add Gemini Key":"Generate Thumbnails"}</button>
            </div>
          </>}

          {/* Results grid */}
          {thumbResults.length>0&&<>
            <div className="yt-thumb-grid-header"><span className="yt-opt-label">Results ({thumbResults.filter(r=>r?.url).length}/{thumbResults.length})</span>{thumbResults.some(r=>r?.url)&&<button className="yt-btn-cp-sm" onClick={()=>{setThumbResults([]);setThumbLoading([]);}}>Clear All</button>}</div>
            <div className="yt-thumb-grid">
              {[...thumbResults].reverse().map((r,ri)=>{ const i=thumbResults.length-1-ri; return <div key={i} className="yt-thumb-item">
                {thumbLoading[i]&&!r?.url&&!r?.error&&<div className="yt-thumb-loader"><div className="yt-spin"/><p>Generating #{i+1}...</p></div>}
                {r?.url&&<><img src={r.url} className="yt-thumb-result-img" alt="" onClick={()=>window.open(r.url)}/>
                  <div className="yt-thumb-actions">
                    <a href={r.url} download={`thumb_${topic.replace(/\s+/g,'_')}_${i+1}.png`} className="yt-thumb-dl">Download</a>
                    <button className="yt-thumb-regen" onClick={()=>{navigator.clipboard.writeText(r.prompt||"");setCp("tp"+i);setTimeout(()=>setCp(""),2e3);}}>{cp===("tp"+i)?"✅ Copied":"Prompt"}</button>
                    <button className="yt-thumb-regen" onClick={()=>generateThumb(i)}>{thumbLoading[i]?"…":"Regen"}</button>
                  </div>
                </>}
                {r?.error&&<div className="yt-thumb-error">❌ {r.error}<button className="yt-thumb-regen" onClick={()=>generateThumb(i)} style={{marginTop:8,display:'block',width:'100%'}}>Retry</button></div>}
              </div>; })}
            </div>
          </>}
        </>}
      </div>
    </>}
  </div>);
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
:root{
  --bg:#ffffff;--bg2:#fbfbfa;--bg3:#ffffff;--bg4:#f1f1ef;
  --surface:#f7f7f5;--surface2:#f1f1ef;--surface3:#e8e8e6;
  --border:#ebebe9;--border2:#d9d9d6;
  --text:#1c1c1a;--text2:#6f6e69;--text3:#a5a49e;
  --red:#d9534f;--red2:#c0443f;--red-bg:#fbeeed;--red-glow:rgba(217,83,79,.15);
  --blue:#2383e2;--blue2:#1a73c9;--blue-bg:#eaf2fc;
  --green:#448361;--green-bg:#eaf2ee;--amber:#b98a2d;--violet:#6940a5;
  --glass:#f7f7f5;--glass2:#f1f1ef;
  --radius:10px;--radius2:8px;--radius3:6px;
  --shadow:0 14px 40px rgba(20,20,18,.10),0 3px 8px rgba(20,20,18,.05);
  --shadow2:0 2px 8px rgba(20,20,18,.06);
  --font:'Inter',ui-sans-serif,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;
  --mono:ui-monospace,'SF Mono','Cascadia Code',Menlo,Consolas,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
::selection{background:#c4dcf5}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:#d9d9d6;border-radius:5px;border:3px solid var(--bg)}
::-webkit-scrollbar-track{background:transparent}
html{background:var(--bg)}
.yt-app{min-height:100vh;background:var(--bg);color:var(--text);font-family:var(--font);font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
button{font-family:var(--font)}

/* ---------- shell ---------- */
.nv-shell{display:flex;min-height:100vh}
.nv-side{width:248px;min-width:248px;background:var(--bg2);border-right:1px solid var(--border);padding:10px 8px 20px;position:sticky;top:0;height:100vh;overflow-y:auto;display:flex;flex-direction:column}
.nv-side-top{display:flex;align-items:center;justify-content:space-between;padding:4px 6px 10px}
.nv-brand{display:flex;align-items:center;gap:9px;background:none;border:none;font-size:14.5px;font-weight:600;color:var(--text);cursor:pointer;padding:4px 6px;border-radius:var(--radius3)}
.nv-brand:hover{background:var(--surface2)}
.nv-mark{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:5px;background:var(--text);color:var(--bg);font-size:12px;font-weight:700}
.nv-collapse,.nv-expand{background:none;border:none;color:var(--text3);cursor:pointer;padding:6px;border-radius:var(--radius3);display:flex;align-items:center}
.nv-collapse:hover,.nv-expand:hover{background:var(--surface2);color:var(--text2)}
.nv-expand{position:fixed;top:14px;left:10px;z-index:50;background:var(--bg);border:1px solid var(--border);box-shadow:var(--shadow2)}
.nv-nav{display:flex;flex-direction:column;gap:1px;margin-bottom:18px}
.nv-nav button{display:flex;align-items:center;gap:10px;background:none;border:none;text-align:left;padding:6px 10px;border-radius:var(--radius3);font-size:13.5px;font-weight:500;color:var(--text2);cursor:pointer;transition:background .12s}
.nv-nav button:hover{background:var(--surface2);color:var(--text)}
.nv-nav button.on{background:var(--surface3);color:var(--text);font-weight:600}
.nv-sec{font-size:11px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:var(--text3);padding:0 10px;margin-bottom:6px}
.nv-list{flex:1}
.nv-side-empty{font-size:12.5px;color:var(--text3);padding:2px 10px}
.nv-item{display:block;width:100%;background:none;border:none;text-align:left;padding:5px 10px;border-radius:var(--radius3);font-size:13.5px;color:var(--text2);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background .12s}
.nv-item:hover{background:var(--surface2);color:var(--text)}
.nv-item.on{background:var(--surface3);color:var(--text);font-weight:600}
.nv-topics{margin:2px 0 6px}
.nv-topic{display:flex;align-items:center;gap:2px;padding:0 4px 0 18px;border-radius:var(--radius3)}
.nv-topic:hover{background:var(--surface2)}
.nv-topic-t{flex:1;background:none;border:none;text-align:left;font-size:12.5px;color:var(--text2);cursor:pointer;padding:4px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.nv-topic-t:hover{color:var(--text)}
.nv-topic-b{background:none;border:none;color:var(--text3);cursor:pointer;padding:4px;border-radius:4px;display:none;align-items:center;flex-shrink:0}
.nv-topic:hover .nv-topic-b{display:flex}
.nv-topic-b:hover{background:var(--surface3);color:var(--text)}
.nv-topic-x:hover{color:var(--red)}
.yt-main{flex:1;padding:56px 64px 80px;max-width:1060px;margin:0 auto;width:100%;min-width:0}
.nv-narrow{max-width:720px}

/* ---------- typography & page ---------- */
.yt-page{animation:nvIn .18s ease-out}
@keyframes nvIn{from{opacity:0}to{opacity:1}}
@keyframes vSpin{to{transform:rotate(360deg)}}
.yt-page-title{font-size:32px;font-weight:700;letter-spacing:-.02em;margin-bottom:6px}
.yt-sub{font-size:15px;color:var(--text2);margin:0 0 28px;max-width:620px}
.yt-breadcrumb{display:flex;align-items:center;gap:12px;margin-bottom:8px;flex-wrap:wrap}
.yt-breadcrumb .yt-page-title{margin-bottom:0;font-size:26px}
.yt-sec-h{display:flex;justify-content:space-between;align-items:center;margin:8px 0 14px}
.yt-sec-h h2{font-size:17px;font-weight:600;letter-spacing:-.01em}
.yt-loading{display:flex;align-items:center;justify-content:center;min-height:100vh}
.yt-spin{width:22px;height:22px;border:2px solid var(--border2);border-top-color:var(--text2);border-radius:50%;animation:vSpin .7s linear infinite}

/* ---------- callout & stats ---------- */
.nv-callout{display:flex;align-items:center;justify-content:space-between;gap:16px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius2);padding:14px 18px;font-size:14px;color:var(--text2);margin-bottom:24px;flex-wrap:wrap}
.nv-callout b{color:var(--text);font-weight:600}
.nv-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:36px}
.nv-stat{border:1px solid var(--border);border-radius:var(--radius2);padding:16px 18px;background:var(--bg)}
.nv-stat-n{display:block;font-size:26px;font-weight:700;letter-spacing:-.02em}
.nv-stat-l{font-size:12.5px;color:var(--text2)}

/* ---------- settings ---------- */
.nv-h1{margin-top:4px}
.nv-set-group{border:1px solid var(--border);border-radius:var(--radius2);margin-bottom:20px;overflow:hidden}
.nv-set-group-t{font-size:12px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:var(--text3);padding:12px 18px;background:var(--bg2);border-bottom:1px solid var(--border)}
.nv-set-row{display:flex;align-items:center;gap:24px;padding:14px 18px}
.nv-set-row + .nv-set-row{border-top:1px solid var(--border)}
.nv-set-info{flex:1;min-width:0}
.nv-set-label{font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px}
.nv-set-ok{font-size:11px;font-weight:600;color:var(--green);background:var(--green-bg);padding:2px 8px;border-radius:10px}
.nv-set-desc{font-size:12.5px;color:var(--text2);margin-top:2px}
.nv-set-input{max-width:280px}
.nv-set-foot{display:flex;align-items:center;gap:12px}
.nv-set-saved{font-size:13px;color:var(--green);font-weight:600}

/* ---------- cards ---------- */
.yt-card{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius2);padding:20px;margin-bottom:16px;transition:border-color .15s}
.yt-card:hover{border-color:var(--border2)}
.yt-card-glow{border-color:var(--border2)}
.yt-card-h{display:flex;justify-content:space-between;align-items:center;cursor:pointer;gap:12px}
.yt-card-ht{font-size:14.5px;font-weight:600;color:var(--text)}
.yt-card-b{margin-top:14px}
.yt-chev{color:var(--text3);font-size:10px}
.yt-hint{font-size:12.5px;color:var(--text2);margin:6px 0 10px;line-height:1.55}
.yt-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
.yt-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:14px}

/* ---------- forms ---------- */
.yt-label{display:block;font-size:12px;color:var(--text2);margin-bottom:5px;font-weight:500}
.yt-input{width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:var(--radius3);padding:7px 12px;color:var(--text);font-size:14px;font-family:var(--font);transition:border-color .15s,box-shadow .15s}
.yt-input:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px rgba(35,131,226,.15)}
.yt-input::placeholder{color:var(--text3)}
.yt-sel{width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:var(--radius3);padding:7px 10px;color:var(--text);font-size:13.5px;font-family:var(--font);cursor:pointer}
.yt-input-row{display:flex;gap:10px;align-items:center}
.yt-input-row .yt-input{flex:1}

/* ---------- buttons ---------- */
.yt-btn{background:var(--blue);border:1px solid var(--blue);border-radius:var(--radius3);padding:7px 16px;color:#fff;font-size:13.5px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background .15s}
.yt-btn:hover{background:var(--blue2);border-color:var(--blue2)}
.yt-btn:disabled{opacity:.45;cursor:default}
.yt-btn-o{background:var(--bg);border:1px solid var(--border2);border-radius:var(--radius3);padding:7px 14px;color:var(--text);font-size:13.5px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background .15s}
.yt-btn-o:hover{background:var(--surface)}
.yt-btn-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.yt-btn-big{width:100%;background:var(--blue);border:1px solid var(--blue);border-radius:var(--radius3);padding:11px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;transition:background .15s}
.yt-btn-big:hover{background:var(--blue2)}
.yt-btn-big:disabled{opacity:.45}
.yt-btn-big-ld{background:var(--surface2)!important;border-color:var(--border)!important;color:var(--text2)!important}
.yt-btn-big-suggest{background:var(--text);border-color:var(--text)}
.yt-btn-big-suggest:hover{background:#000}
.yt-btn-use{background:var(--bg);border:1px solid var(--border2);border-radius:var(--radius3);padding:5px 13px;color:var(--text);font-size:12.5px;font-weight:500;cursor:pointer;transition:all .15s}
.yt-btn-use:hover{border-color:var(--blue);color:var(--blue)}
.yt-btn-use-sm{background:var(--bg);border:1px solid var(--border2);border-radius:var(--radius3);padding:4px 11px;color:var(--text);font-size:12px;font-weight:500;cursor:pointer}
.yt-btn-use-sm:hover{border-color:var(--blue);color:var(--blue)}
.yt-btn-remake{background:var(--bg);border:1px solid var(--border2);border-radius:var(--radius3);padding:4px 11px;color:var(--text2);font-size:12px;font-weight:500;cursor:pointer;transition:all .15s}
.yt-btn-remake:hover{background:var(--surface);color:var(--text)}
.yt-btn-regen{background:none;border:1px solid var(--border2);border-radius:var(--radius3);padding:5px 13px;color:var(--text2);font-size:12.5px;font-weight:500;cursor:pointer}
.yt-btn-regen:hover{background:var(--surface);color:var(--text)}
.yt-btn-gen{background:var(--blue);border:1px solid var(--blue);border-radius:var(--radius3);padding:9px 20px;color:#fff;font-size:13.5px;font-weight:600;cursor:pointer;flex:1;white-space:nowrap}
.yt-btn-gen:hover{background:var(--blue2)}
.yt-btn-studio{background:var(--text);border:1px solid var(--text);border-radius:var(--radius3);padding:9px 18px;color:var(--bg);font-size:13.5px;font-weight:600;cursor:pointer;white-space:nowrap;transition:opacity .15s}
.yt-btn-studio:hover{opacity:.85}
.yt-btn-ld{opacity:.55;pointer-events:none}
.yt-btn-cp{background:var(--bg);border:1px solid var(--border2);border-radius:var(--radius3);padding:6px 14px;color:var(--text);font-size:12.5px;font-weight:500;cursor:pointer}
.yt-btn-cp:hover{background:var(--surface)}
.yt-btn-cp-sm{background:none;border:1px solid var(--border);border-radius:5px;padding:3px 10px;color:var(--text2);font-size:11.5px;font-weight:500;cursor:pointer}
.yt-btn-cp-sm:hover{background:var(--surface);color:var(--text)}
.yt-x{background:none;border:none;color:var(--text3);font-size:14px;cursor:pointer;padding:3px 7px;border-radius:5px}
.yt-x:hover{background:var(--surface2);color:var(--red)}
.yt-topic-btns{margin-top:10px;display:flex;gap:8px}

/* ---------- chips / niche grid ---------- */
.yt-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.yt-chip{display:flex;align-items:center;gap:6px;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:4px 12px;font-size:12.5px;color:var(--text)}
.yt-chip button{background:none;border:none;color:var(--text3);cursor:pointer;font-size:12px}
.yt-chip button:hover{color:var(--red)}
.yt-niche-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.yt-niche-card{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius2);overflow:hidden;cursor:pointer;transition:border-color .15s,box-shadow .15s}
.yt-niche-card:hover{border-color:var(--border2);box-shadow:var(--shadow2)}
.yt-niche-cover-wrap{width:100%;height:110px;overflow:hidden}
.yt-niche-cover{width:100%;height:100%;object-fit:cover}
.yt-niche-card-body{padding:14px 16px}
.yt-niche-top{display:flex;justify-content:space-between;align-items:start}
.yt-niche-top h3{font-size:15px;font-weight:600}
.yt-niche-desc{font-size:13px;color:var(--text2);margin-top:4px;line-height:1.45}
.yt-niche-meta{font-size:12px;color:var(--text3);margin-top:10px;display:flex;gap:14px}
.yt-niche-form{display:flex;gap:16px;align-items:start}
.yt-niche-cover-upload{flex-shrink:0}
.yt-cover-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;width:96px;height:76px;border:1px dashed var(--border2);border-radius:var(--radius3);cursor:pointer;overflow:hidden;background:var(--surface)}
.yt-cover-drop:hover{border-color:var(--text3)}
.yt-cover-preview{width:100%;height:100%;object-fit:cover}
.yt-cover-text{font-size:11.5px;color:var(--text3)}
.yt-niche-form-fields{flex:1;display:flex;flex-direction:column;gap:10px}

/* ---------- info / empty ---------- */
.yt-info-bar{display:flex;gap:22px;margin-bottom:20px;padding:12px 18px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius2);flex-wrap:wrap}
.yt-info-item{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text2)}
.yt-info-num{font-size:15px;font-weight:700;color:var(--text);margin-right:2px}
.yt-empty-state{text-align:center;padding:52px 20px;border:1px dashed var(--border2);border-radius:var(--radius2)}
.yt-empty-icon{display:none}
.yt-empty-title{font-size:16px;font-weight:600;margin-bottom:6px}
.yt-empty-desc{font-size:13.5px;color:var(--text2)}

/* ---------- research page ---------- */
.yt-days-filter{display:flex;gap:6px;margin:12px 0}
.yt-days-chip{background:var(--bg);border:1px solid var(--border2);border-radius:14px;padding:4px 13px;font-size:12px;font-weight:500;color:var(--text2);cursor:pointer}
.yt-days-chip:hover{background:var(--surface)}
.yt-days-chip.active{background:var(--text);border-color:var(--text);color:var(--bg)}
.yt-out-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-top:10px}
.yt-out-card{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius2);overflow:hidden;transition:border-color .15s,box-shadow .15s}
.yt-out-card:hover{border-color:var(--border2);box-shadow:var(--shadow2)}
.yt-out-card-img-wrap{position:relative;aspect-ratio:16/9;background:var(--surface)}
.yt-out-card-img{width:100%;height:100%;object-fit:cover;display:block}
.yt-out-card-ratio{position:absolute;top:6px;left:6px;background:rgba(28,28,26,.85);color:#fff;font-size:10.5px;font-weight:600;padding:2px 7px;border-radius:4px}
.yt-out-card-views{position:absolute;bottom:6px;right:6px;background:rgba(28,28,26,.85);color:#fff;font-size:10.5px;font-weight:600;padding:2px 7px;border-radius:4px}
.yt-out-card-body{padding:10px 12px}
.yt-out-card-title{font-size:12.5px;font-weight:600;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.yt-out-card-ch{font-size:11px;color:var(--text3);margin-top:4px}
.yt-out-card-btns{margin-top:8px}
.yt-btn-use-sm{width:100%}
.yt-toggle{display:flex;justify-content:space-between;align-items:center;cursor:pointer;padding:10px 0 2px}
.yt-toggle-t{font-size:13.5px;font-weight:600}
.yt-topics{display:flex;flex-direction:column;gap:10px;margin-top:12px}
.yt-topic{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius2);padding:14px 16px}
.yt-topic-done{opacity:.65}
.yt-topic-h{display:flex;justify-content:space-between;gap:10px;align-items:start}
.yt-topic-t{font-size:14px;font-weight:600;line-height:1.45}
.yt-badge-used{font-size:10px;font-weight:600;background:var(--surface2);color:var(--text2);padding:2px 8px;border-radius:9px;white-space:nowrap}
.yt-topic-a{font-size:13px;color:var(--text2);margin-top:5px;line-height:1.5}
.yt-topic-w,.yt-topic-i{font-size:12px;color:var(--text3);margin-top:4px}
.yt-st{font-size:13px;margin-top:10px;color:var(--text2);padding:8px 12px;border-radius:var(--radius3);background:var(--surface)}
.yt-st.err{background:var(--red-bg);color:var(--red2)}
.yt-st.ok{background:var(--green-bg);color:var(--green)}
.yt-ld-box{display:flex;flex-direction:column;align-items:center;gap:10px;padding:26px;color:var(--text2);font-size:13px}

/* ---------- generator ---------- */
.yt-topic-banner{font-size:19px;font-weight:700;letter-spacing:-.01em;padding:14px 18px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius2);margin-bottom:18px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.yt-version-big{font-size:10.5px;font-weight:600;background:var(--surface3);color:var(--text2);padding:3px 9px;border-radius:9px}
.yt-mtag{font-size:10.5px;font-weight:600;padding:3px 10px;border-radius:9px;background:var(--surface2);color:var(--text2);text-transform:uppercase;letter-spacing:.4px}
.yt-mode-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:20px}
.yt-mode{display:flex;flex-direction:column;align-items:flex-start;gap:6px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius2);padding:22px;cursor:pointer;text-align:left;transition:border-color .15s,box-shadow .15s}
.yt-mode:hover{border-color:var(--border2);box-shadow:var(--shadow2)}
.yt-mode-ic{display:none}
.yt-mode-n{font-size:16px;font-weight:700}
.yt-mode-d{font-size:13px;color:var(--text2)}
.yt-mode-b{font-size:10px;font-weight:600;letter-spacing:.5px;background:var(--blue-bg);color:var(--blue);padding:3px 9px;border-radius:9px;margin-top:4px}
.yt-mode-b2{background:var(--surface2);color:var(--text2)}
.yt-used-items{font-size:12.5px;color:var(--text2);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius3);padding:10px 14px;margin-bottom:16px;line-height:1.6}
.yt-used-items-label{font-weight:600;color:var(--text);margin-right:6px}
.yt-gen-ctrl{display:grid;grid-template-columns:1fr 1fr 2fr;gap:14px;align-items:end;margin-bottom:22px}
.yt-gen-btns{display:flex;gap:8px;flex-wrap:wrap}
.yt-tabs{display:flex;gap:2px;border-bottom:1px solid var(--border);margin-bottom:0}
.yt-tab{background:none;border:none;border-bottom:2px solid transparent;padding:9px 16px;color:var(--text2);font-size:13.5px;font-weight:500;cursor:pointer;margin-bottom:-1px}
.yt-tab:hover{color:var(--text)}
.yt-tab.active{color:var(--text);border-bottom-color:var(--text);font-weight:600}
.yt-out-panel{padding:20px 2px}
.yt-out-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.yt-cc{font-size:12px;font-family:var(--mono);color:var(--text2)}
.yt-cc.over{color:var(--red)}
.yt-pre{white-space:pre-wrap;font-family:var(--mono);font-size:13px;line-height:1.65;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius2);padding:18px;color:var(--text);max-height:520px;overflow-y:auto}
.yt-pre-sm{font-size:12.5px;padding:14px;max-height:300px}
.yt-opt-section{margin-bottom:22px}
.yt-opt-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.yt-opt-label{font-size:12px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:var(--text3)}
.yt-opt-title{display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius3);font-size:13.5px;cursor:pointer;margin-bottom:6px;transition:background .12s}
.yt-opt-title:hover{background:var(--surface)}
.yt-opt-num{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;border-radius:5px;background:var(--surface2);color:var(--text2);font-size:11px;font-weight:600}
.yt-opt-copied{margin-left:auto;font-size:12px}
.yt-opt-desc-card{margin-bottom:12px}
.yt-opt-desc-head{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.yt-opt-desc-tone{font-size:12px;color:var(--text2);font-weight:500}
.yt-opt-tags{display:flex;flex-wrap:wrap;gap:6px}
.yt-opt-tag{font-size:12px;background:var(--surface);border:1px solid var(--border);padding:4px 11px;border-radius:12px;cursor:pointer;color:var(--text2)}
.yt-opt-tag:hover{border-color:var(--border2);color:var(--text)}

/* ---------- thumbnails ---------- */
.yt-ref-preview{display:flex;align-items:center;gap:12px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius2);padding:10px 14px;margin-bottom:16px}
.yt-ref-img{width:96px;border-radius:6px}
.yt-ref-label{font-size:12.5px;color:var(--text2);flex:1}
.yt-ref-rm{background:none;border:none;color:var(--text3);cursor:pointer;font-size:13px}
.yt-th-choose{padding:8px 0}
.yt-th-choose-label{font-size:14px;font-weight:600;margin-bottom:14px}
.yt-th-choose-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.yt-th-choose-btn{display:flex;flex-direction:column;align-items:flex-start;gap:6px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius2);padding:20px;cursor:pointer;text-align:left;transition:border-color .15s,box-shadow .15s}
.yt-th-choose-btn:hover{border-color:var(--border2);box-shadow:var(--shadow2)}
.yt-th-choose-ic{display:none}
.yt-th-choose-n{font-size:14.5px;font-weight:600}
.yt-th-choose-d{font-size:12.5px;color:var(--text2);line-height:1.5}
.yt-th-choose-tag{font-size:10.5px;font-weight:600;background:var(--blue-bg);color:var(--blue);padding:3px 9px;border-radius:9px}
.yt-th-ref-section{margin-top:6px}
.yt-th-ref-layout{display:grid;grid-template-columns:340px 1fr;gap:20px}
.yt-th-scratch-layout{display:grid;grid-template-columns:1fr 260px;gap:20px}
.yt-th-ref-preview{position:relative;border-radius:var(--radius2);overflow:hidden;border:1px solid var(--border)}
.yt-th-ref-big{width:100%;display:block}
.yt-th-ref-overlay{position:absolute;bottom:8px;right:8px;display:flex;gap:6px}
.yt-th-ref-change{background:rgba(28,28,26,.8);border:none;border-radius:6px;padding:5px 12px;color:#fff;font-size:11.5px;cursor:pointer}
.yt-th-ref-drop-big{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;aspect-ratio:16/9;border:1px dashed var(--border2);border-radius:var(--radius2);cursor:pointer;background:var(--surface)}
.yt-th-ref-drop-big:hover{border-color:var(--text3)}
.yt-th-ref-drop-ic{display:none}
.yt-th-ref-drop-t{font-size:13.5px;font-weight:600}
.yt-th-ref-drop-d{font-size:12px;color:var(--text3)}
.yt-th-prompt-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:10px;flex-wrap:wrap}
.yt-th-prompt-area{font-family:var(--mono);font-size:12.5px;line-height:1.6;resize:vertical}
.yt-th-prompt-actions{margin-top:8px}
.yt-th-refine{margin-top:14px}
.yt-th-refine-row{display:flex;gap:8px;align-items:stretch}
.yt-th-refine-input{flex:1;font-size:13px;resize:vertical}
.yt-btn-refine{background:var(--bg);border:1px solid var(--border2);border-radius:var(--radius3);padding:6px 14px;color:var(--text);font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap}
.yt-btn-refine:hover{background:var(--surface)}
.yt-th-scratch-refs{display:flex;flex-direction:column;gap:8px}
.yt-thumb-drop{display:flex;align-items:center;justify-content:center;border:1px dashed var(--border2);border-radius:var(--radius3);padding:14px;font-size:12.5px;color:var(--text2);cursor:pointer;background:var(--surface)}
.yt-thumb-drop:hover{border-color:var(--text3)}
.yt-thumb-ref-list{display:flex;flex-wrap:wrap;gap:8px}
.yt-thumb-ref-card{position:relative;width:86px}
.yt-thumb-ref-img{width:100%;border-radius:6px;border:1px solid var(--border)}
.yt-thumb-ref-rm{position:absolute;top:-6px;right:-6px;background:var(--text);color:var(--bg);border:none;border-radius:50%;width:18px;height:18px;font-size:10px;cursor:pointer}
.yt-th-gen-bar{margin-top:16px;padding:14px 16px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius2)}
.yt-thumb-options{display:flex;gap:18px;align-items:end;flex-wrap:wrap}
.yt-thumb-check{display:flex;align-items:center;gap:7px;font-size:13px;color:var(--text2);cursor:pointer}
.yt-thumb-check input{accent-color:var(--blue)}
.yt-thumb-grid-header{display:flex;justify-content:space-between;align-items:center;margin:18px 0 10px}
.yt-thumb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
.yt-thumb-item{border:1px solid var(--border);border-radius:var(--radius2);overflow:hidden;background:var(--bg)}
.yt-thumb-loader{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;aspect-ratio:16/9;color:var(--text3);font-size:12px;background:var(--surface)}
.yt-thumb-result-img{width:100%;display:block;cursor:zoom-in}
.yt-thumb-actions{display:flex;gap:6px;padding:10px;flex-wrap:wrap}
.yt-thumb-dl{background:var(--blue);border:none;border-radius:var(--radius3);padding:5px 12px;color:#fff;font-size:12px;font-weight:500;cursor:pointer;text-decoration:none}
.yt-thumb-dl:hover{background:var(--blue2)}
.yt-thumb-regen{background:var(--bg);border:1px solid var(--border2);border-radius:var(--radius3);padding:5px 11px;color:var(--text2);font-size:12px;cursor:pointer}
.yt-thumb-regen:hover{background:var(--surface);color:var(--text)}
.yt-thumb-error{padding:16px;font-size:12.5px;color:var(--red2);background:var(--red-bg)}

/* ---------- seo board ---------- */
.yt-seo-board{display:flex;flex-direction:column}
.yt-seo-card{padding:14px 18px}
.yt-seo-niche{font-size:12px;font-weight:400;color:var(--text3);margin-left:10px}

@media(max-width:900px){
  .nv-side{position:fixed;z-index:60;box-shadow:var(--shadow)}
  .yt-main{padding:56px 22px 60px}
  .nv-stats{grid-template-columns:repeat(2,1fr)}
  .yt-grid2,.yt-gen-ctrl,.yt-mode-grid,.yt-th-choose-grid,.yt-th-ref-layout,.yt-th-scratch-layout{grid-template-columns:1fr}
  .yt-gen-btns{grid-column:1/-1}
  .nv-set-row{flex-direction:column;align-items:stretch;gap:8px}
  .nv-set-input{max-width:none}
}
`;
