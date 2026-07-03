import { useState, useEffect } from "react";
import Studio from "./studio.jsx";

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

const P = { HOME: 0, NICHE: 1, GEN: 2, STUDIO: 3 };

export default function App() {
  const [pg, setPg] = useState(P.HOME);
  const [niches, setNiches] = useState([]);
  const [ytKey, setYtKey] = useState("");
  const [clKey, setClKey] = useState("");
  const [gemKey, setGemKey] = useState("");
  const [pexKey, setPexKey] = useState("");
  const [niche, setNiche] = useState(null);
  const [studioCtx, setStudioCtx] = useState(null);
  const [ok, setOk] = useState(false);
  const [sb, setSb] = useState(true);

  useEffect(() => { cleanThumbs("vr6-niches"); setNiches(ls("vr6-niches", ls("vr5-niches",[]))); setYtKey(ls("vr6-yt", ls("vr5-yt",""))); setClKey(ls("vr6-cl", ls("vr5-cl",""))); setGemKey(ls("vr6-gem","")); setPexKey(ls("vr7-pex","")); setOk(true); }, []);
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

  return (<div className="yt-app">
    <header className="yt-topbar">
      <div className="yt-topbar-l">
        <button className="yt-hamburger" onClick={()=>setSb(!sb)}>
          <svg width="24" height="24" viewBox="0 0 24 24"><path fill="currentColor" d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
        </button>
        <div className="yt-logo" onClick={()=>setPg(P.HOME)}>
          <svg width="30" height="22" viewBox="0 0 90 65"><path fill="#FF0000" d="M88.1 17.3c-1-3.9-4-7-7.8-8C73.3 7.5 45 7.5 45 7.5s-28.3 0-35.3 1.8c-3.8 1-6.8 4.1-7.8 8C0 24.4 0 39.2 0 39.2s0 14.8 1.9 21.9c1 3.9 4 6.9 7.8 7.9 7 1.8 35.3 1.8 35.3 1.8s28.3 0 35.3-1.8c3.8-1 6.8-4 7.8-7.9 1.9-7.1 1.9-21.9 1.9-21.9s0-14.8-1.9-21.9z"/><path fill="#FFF" d="M36 52V28l23.5 12z"/></svg>
          <span>VidRush</span><span className="yt-ver-badge">v7 Studio</span>
        </div>
      </div>
      <div className="yt-topbar-r">{niche && pg!==P.HOME && <span className="yt-niche-pill">{niche.name}</span>}</div>
    </header>
    <div className="yt-layout">
      {sb && <aside className="yt-sidebar">
        <div className="yt-sb-section">
          <div className="yt-sb-title">Used Topics {hist.length > 0 && <span className="yt-sb-badge">{hist.length}</span>}</div>
          {hist.length === 0 ? <p className="yt-sb-empty">{niche ? "No topics in this niche yet" : "Select a niche first"}</p> :
            <div className="yt-sb-list">{hist.map(h => <div key={h.id} className="yt-sb-item yt-sb-clickable">
              <div className="yt-sb-item-top">
                <div className="yt-sb-item-content" onClick={()=>h.prompt&&openSaved(h)}>
                  <div className="yt-sb-item-t"><span className="yt-sb-version">V{h.version}</span>{h.topic}</div>
                  <div className="yt-sb-item-m">{h.date}{h.prompt ? " · 📝" : ""}{h.usedItems?.length ? ` · 🧬${h.usedItems.length}` : ""}</div>
                </div>
                <button className="yt-sb-remake" onClick={(e)=>{e.stopPropagation();remakeTopic(h);}} title="Remake with new items">🔄</button>
                <button className="yt-sb-del" onClick={(e)=>{e.stopPropagation();if(confirm("Delete this topic?"))deleteH(niche.id,h.id);}} title="Delete topic">✕</button>
              </div>
            </div>)}</div>}
        </div>
      </aside>}
      <main className={`yt-main ${sb?'':'yt-main-full'}`}>
        {pg===P.HOME && <Home niches={niches} ytKey={ytKey} clKey={clKey} gemKey={gemKey} pexKey={pexKey} sn={sn} setYtKey={k=>{setYtKey(k);ss("vr6-yt",k);}} setClKey={k=>{setClKey(k);ss("vr6-cl",k);}} setGemKey={k=>{setGemKey(k);ss("vr6-gem",k);}} setPexKey={k=>{setPexKey(k);ss("vr7-pex",k);}} go={n=>{openNiche(n);setPg(P.NICHE);}} />}
        {pg===P.NICHE && niche && <NichePg niche={niches.find(x=>x.id===niche.id)||niche} niches={niches} ytKey={ytKey} clKey={clKey} sn={sn} back={()=>{setNiche(null);setPg(P.HOME);}} gen={(t,v,refThumb)=>{const fresh=ls("vr6-niches",[]).find(x=>x.id===niche.id)||niche;setNiche({...fresh,topic:t,topicVersion:v||1,refThumb:refThumb||""});setPg(P.GEN);}} />}
        {pg===P.GEN && niche && <GenPg niche={niche} topic={niche.topic} version={niche.topicVersion||1} clKey={clKey} gemKey={gemKey} addH={addH} updateH={updateH} back={()=>setPg(P.NICHE)} goStudio={ctx=>{setStudioCtx(ctx);setPg(P.STUDIO);}} savedPrompt={niche.savedPrompt} savedThumb={niche.savedThumb} savedHistId={niche.savedHistId} refThumb={niche.refThumb} savedThumbs={niche.savedThumbs} savedOptTitles={niche.savedOptTitles} savedOptDesc={niche.savedOptDesc} savedOptTags={niche.savedOptTags} savedThPrompt={niche.savedThPrompt} />}
        {pg===P.STUDIO && niche && studioCtx && <Studio niche={niche} ctx={studioCtx} clKey={clKey} gemKey={gemKey} pexKey={pexKey} back={()=>setPg(P.GEN)} />}
      </main>
    </div>
    <style>{CSS}</style>
  </div>);
}

function Home({ niches, ytKey, clKey, gemKey, pexKey, sn, setYtKey, setClKey, setGemKey, setPexKey, go }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(""); const [desc, setDesc] = useState(""); const [cover, setCover] = useState("");
  const [showK, setShowK] = useState(!ytKey||!clKey);
  const [yk, setYk] = useState(ytKey); const [ck, setCk] = useState(clKey); const [gk, setGk] = useState(gemKey); const [pk, setPk] = useState(pexKey);
  const handleCover = (e) => { const f=e.target.files[0]; if(!f) return; const r=new FileReader(); r.onload=ev=>setCover(ev.target.result); r.readAsDataURL(f); e.target.value=''; };
  const add = () => { if(!name.trim()) return; sn([...niches,{id:Date.now(),name:name.trim(),desc:desc.trim(),cover:cover||"",channels:[],history:[]}]); setName(""); setDesc(""); setCover(""); setAdding(false); };

  return (<div className="yt-page">
    <div className="yt-hero">
      <div className="yt-hero-text">
        <h1 className="yt-hero-title">Welcome to VidRush</h1>
        <p className="yt-hero-sub">Analyze competitors. Generate viral content. Dominate your niche.</p>
      </div>
      <div className="yt-hero-stats">
        <div className="yt-stat"><span className="yt-stat-num">{niches.length}</span><span className="yt-stat-label">Niches</span></div>
        <div className="yt-stat"><span className="yt-stat-num">{niches.reduce((s,n)=>s+(n.history?.length||0),0)}</span><span className="yt-stat-label">Topics</span></div>
        <div className="yt-stat"><span className="yt-stat-num">{niches.reduce((s,n)=>s+(n.channels?.length||0),0)}</span><span className="yt-stat-label">Channels</span></div>
      </div>
    </div>
    <div className="yt-card">
      <div className="yt-card-h" onClick={()=>setShowK(!showK)}><span className="yt-card-ht">🔑 API Keys {ytKey&&clKey&&gemKey?"✅":"— Setup Required"}</span><span className="yt-chev">{showK?"▲":"▼"}</span></div>
      {showK && <div className="yt-card-b"><div className="yt-grid2"><div><label className="yt-label">YouTube API Key</label><input className="yt-input" type="password" placeholder="AIza..." value={yk} onChange={e=>setYk(e.target.value)}/></div><div><label className="yt-label">Anthropic API Key</label><input className="yt-input" type="password" placeholder="sk-ant-..." value={ck} onChange={e=>setCk(e.target.value)}/></div><div><label className="yt-label">Gemini API Key (images + voiceover)</label><input className="yt-input" type="password" placeholder="AIza..." value={gk} onChange={e=>setGk(e.target.value)}/></div><div><label className="yt-label">Pexels API Key (optional — real b-roll)</label><input className="yt-input" type="password" placeholder="563492ad..." value={pk} onChange={e=>setPk(e.target.value)}/></div></div><button className="yt-btn" onClick={()=>{setYtKey(yk);setClKey(ck);setGemKey(gk);setPexKey(pk);setShowK(false);}}>Save Keys</button><p className="yt-hint">Stored locally in your browser. Never sent to our servers.</p></div>}
    </div>
    <div className="yt-sec-h"><h2>Your Niches</h2><button className="yt-btn" onClick={()=>setAdding(true)}>+ New Niche</button></div>
    {adding && <div className="yt-card yt-card-glow"><div className="yt-card-b">
      <div className="yt-niche-form">
        <div className="yt-niche-cover-upload">
          <label className="yt-cover-drop">
            <input type="file" accept="image/*" onChange={handleCover} style={{display:'none'}}/>
            {cover ? <img src={cover} className="yt-cover-preview" alt=""/> : <><span className="yt-cover-icon">🖼</span><span className="yt-cover-text">Cover</span></>}
          </label>
        </div>
        <div className="yt-niche-form-fields">
          <div><label className="yt-label">Name</label><input className="yt-input" placeholder="e.g. Biblical Health" value={name} onChange={e=>setName(e.target.value)} autoFocus/></div>
          <div><label className="yt-label">Description</label><input className="yt-input" placeholder="Short description" value={desc} onChange={e=>setDesc(e.target.value)}/></div>
        </div>
      </div>
      <div className="yt-btn-row" style={{marginTop:14}}><button className="yt-btn" onClick={add}>Create Niche</button><button className="yt-btn-o" onClick={()=>{setAdding(false);setCover("");}}>Cancel</button></div>
    </div></div>}
    {niches.length===0&&!adding ? <div className="yt-empty-state"><div className="yt-empty-icon">🎯</div><p className="yt-empty-title">No niches yet</p><p className="yt-empty-desc">Create your first niche to start analyzing competitors</p></div> :
      <div className="yt-niche-grid">{niches.map(n=><div key={n.id} className="yt-niche-card" onClick={()=>go(n)}>
        {n.cover && <div className="yt-niche-cover-wrap"><img src={n.cover} className="yt-niche-cover" alt=""/></div>}
        <div className="yt-niche-card-body">
          <div className="yt-niche-top"><h3>{n.name}</h3><button className="yt-x" onClick={e=>{e.stopPropagation();if(confirm("Delete niche?"))sn(niches.filter(x=>x.id!==n.id));}}>✕</button></div>
          {n.desc&&<p className="yt-niche-desc">{n.desc}</p>}
          <div className="yt-niche-meta"><span>📺 {n.channels?.length||0} channels</span><span>📝 {n.history?.length||0} topics</span></div>
        </div>
      </div>)}</div>}
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
    if(!ytKey){setSt("⚠️ Set YouTube API Key!");return;} if(chs.length===0){setSt("⚠️ Add channels!");return;}
    setLd(true); setSt(""); setOuts([]); setTopics([]); let allO=[];
    for(let i=0;i<chs.length;i++){ setSt(`📡 ${i+1}/${chs.length}: ${chs[i]}`); try { const id=await resolveChannel(chs[i],ytKey); const{name,videos}=await getVideos(id,ytKey,(n)=>setSt(`📡 ${i+1}/${chs.length}: ${chs[i]} (${n} videos...)`)); allO.push(...rankVideos(videos).map(v=>({...v,channel:name}))); } catch(e){ setSt(`⚠️ ${chs[i]}: ${e.message}`); await new Promise(r=>setTimeout(r,1200)); }}
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
    if(!clKey){setSt("⚠️ Set Anthropic API Key!");return;}
    if(!lastData){setSt("⚠️ Scan channels first!");return;}
    setLdRegen(true); setSt("🤖 AI analyzing...");
    try { setTopics(await genTopics(lastData)); setSt("✅ 10 topic ideas"); } catch(e){setSt("⚠️ "+e.message);}
    setLdRegen(false);
  };

  const regenerate = async () => {
    if(!lastData){setSt("⚠️ Scan channels first!");return;}
    if(!clKey){setSt("⚠️ Set Anthropic API Key!");return;}
    setLdRegen(true); setSt("🔄 Regenerating topics...");
    try { setTopics(await genTopics(lastData)); setSt("✅ 10 fresh ideas"); } catch(e){setSt("⚠️ "+e.message);}
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

    <div className="yt-card"><div className="yt-card-ht">📺 Channels</div><p className="yt-hint">YouTube URL or @handle</p><div className="yt-input-row"><input className="yt-input" placeholder="@ChannelName or URL" value={ch} onChange={e=>setCh(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addCh()}/><button className="yt-btn" onClick={addCh}>Add</button></div>{chs.length>0&&<div className="yt-chips">{chs.map((c,i)=><span key={i} className="yt-chip">{c}<button onClick={()=>rmCh(i)}>✕</button></span>)}</div>}</div>

    <div className="yt-card"><div className="yt-card-ht">🔍 Analysis</div>
      <button className={`yt-btn-big ${ld?'yt-btn-big-ld':''}`} onClick={analyze} disabled={ld||ldRegen}>{ld?"⏳ Scanning...":"🚀 Scan Channels"}</button>
      {st&&<p className={`yt-st ${st[0]==="⚠"?'err':st[0]==="✅"?'ok':''}`}>{st}</p>}
      {outs.length>0&&<><div className="yt-toggle" onClick={()=>setShowO(!showO)}><span className="yt-toggle-t">🏆 Top Videos — {daysLabel} ({outs.length})</span><span className="yt-chev">{showO?"▲":"▼"}</span></div>
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

    {allRaw.length>0&&!topics.length&&<button className={`yt-btn-big yt-btn-big-suggest ${ldRegen?'yt-btn-big-ld':''}`} onClick={suggest} disabled={ld||ldRegen} style={{marginBottom:16}}>{ldRegen?"⏳ Analyzing...":"💡 Suggest Topics"}</button>}

    {topics.length>0&&<div className="yt-card">
      <div className="yt-card-h">
        <span className="yt-card-ht">💡 Topics</span>
        <button className={`yt-btn-regen ${ldRegen?'yt-btn-ld':''}`} onClick={regenerate} disabled={ld||ldRegen}>{ldRegen?"⏳":"🔄 Regenerate"}</button>
      </div>
      <div className="yt-topics">{topics.map((t,i)=>{
      const vc=getVersionCount(t.title); const done=vc>0;
      return <div key={i} className={`yt-topic ${done?'yt-topic-done':''}`}>
        <div className="yt-topic-h"><span className="yt-topic-t">{t.title}</span>{done&&<span className="yt-badge-used">USED ×{vc}</span>}</div>
        {t.angle&&<p className="yt-topic-a">{t.angle}</p>}
        {t.why&&<p className="yt-topic-w">📈 {t.why}</p>}
        {t.inspired_by&&<p className="yt-topic-i">💡 {t.inspired_by}</p>}
        <div className="yt-topic-btns">
          {!done && <button className="yt-btn-use" onClick={()=>gen(t.title,1)}>Use Topic →</button>}
          {done && <button className="yt-btn-remake" onClick={()=>gen(t.title,vc+1)}>🔄 Remake (v{vc+1})</button>}
        </div>
      </div>;})}</div>
    </div>}

    <div className="yt-card"><div className="yt-card-ht">✏️ Custom Topic</div><div className="yt-input-row"><input className="yt-input" placeholder="Your own topic..." value={cust} onChange={e=>setCust(e.target.value)} onKeyDown={e=>e.key==="Enter"&&cust.trim()&&gen(cust.trim(),getVersionCount(cust.trim())+1)}/><button className="yt-btn" onClick={()=>cust.trim()&&gen(cust.trim(),getVersionCount(cust.trim())+1)} disabled={!cust.trim()}>Go →</button></div></div>
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
    if(!clKey){setPrompt("⚠️ Set Anthropic API Key!");return;} setLd(true); setPrompt(""); setTab("prompt");
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
    {refThumb && <div className="yt-ref-preview"><img src={refThumb} alt="Reference" className="yt-ref-img"/><span className="yt-ref-label">🎨 Reference thumbnail attached</span><button className="yt-ref-rm" onClick={()=>setRefThumb("")}>✕</button></div>}
    <div className="yt-mode-grid">
      <button className="yt-mode auto" onClick={()=>setMode("auto")}><div className="yt-mode-ic">🚀</div><div className="yt-mode-n">AUTO</div><div className="yt-mode-d">Prompt ready to paste</div><span className="yt-mode-b">SPEED</span></button>
      <button className="yt-mode manual" onClick={()=>setMode("manual")}><div className="yt-mode-ic">🎯</div><div className="yt-mode-n">MANUAL</div><div className="yt-mode-d">Prompt + Q&A + refs</div><span className="yt-mode-b yt-mode-b2">CONTROL</span></button>
    </div>
  </div>);

  return (<div className="yt-page">
    <div className="yt-breadcrumb"><button className="yt-btn-o" onClick={()=>setMode(null)}>← Mode</button><h1 className="yt-page-title">Generate</h1><span className={`yt-mtag ${mode}`}>{mode.toUpperCase()}</span>{version>1&&<span className="yt-version-big">V{version}</span>}</div>
    <div className="yt-topic-banner">{topic}{version>1&&<span className="yt-version-big">V{version} — fresh content</span>}</div>
    {getUsedItems().length > 0 && <div className="yt-used-items"><span className="yt-used-items-label">🧬 Already used ({getUsedItems().length}):</span><span className="yt-used-items-list">{getUsedItems().join(", ")}</span></div>}
    <div className="yt-gen-ctrl">
      <div><label className="yt-label">Duration</label><select className="yt-sel" value={dur} onChange={e=>setDur(e.target.value)}><option value="8">6–8 min</option><option value="12">10–12 min</option><option value="15">13–15 min</option><option value="20">18–20 min</option><option value="30">25–30 min</option></select></div>
      <div><label className="yt-label">Style</label><select className="yt-sel" value={sty} onChange={e=>setSty(e.target.value)}><option value="documentary">Documentary</option><option value="top10">Top 10</option></select></div>
      <div className="yt-gen-btns">
        <button className={`yt-btn-gen ${ld?'yt-btn-ld':''}`} onClick={go} disabled={ld}>{ld?"⏳ Generating...":"⚡ Generate Prompt"}</button>
        <button className="yt-btn-studio" onClick={()=>goStudio({topic,version,histId,prompt})} title="Full pipeline: script → storyboard → visuals → voiceover → MP4 + SEO package">🎬 Storyboard Studio →</button>
      </div>
    </div>
    {ld&&<div className="yt-ld-box"><div className="yt-spin"/><p>Building detailed prompt...</p></div>}
    {(prompt||optTitles.length>0||optDesc||thumbResults.length>0)&&<>
      <div className="yt-tabs">
        <button className={`yt-tab ${tab==="prompt"?'active':''}`} onClick={()=>setTab("prompt")}>📝 Prompt{prompt?` (${cc.toLocaleString()})`:""}</button>
        <button className={`yt-tab ${tab==="optimize"?'active':''}`} onClick={()=>setTab("optimize")}>📊 Optimize{ldO?" ⏳":optTitles.length?" ✓":""}</button>
        <button className={`yt-tab ${tab==="thumbnail"?'active':''}`} onClick={()=>setTab("thumbnail")}>🖼️ Thumbnail{thumbResults.length?` (${thumbResults.filter(r=>r?.url).length})`:""}</button>
      </div>
      <div className="yt-out-panel">
        {tab==="prompt"&&<>
          <div className="yt-out-h"><span className={`yt-cc ${cc>10000?'over':''}`}>{cc.toLocaleString()}/10,000{cc>10000?" ⚠️":" ✓"}</span><button className="yt-btn-cp" onClick={()=>copy(prompt,"prompt")}>{cp==="prompt"?"✅ Copied!":"📋 Copy"}</button></div>
          <pre className="yt-pre">{prompt}</pre>
        </>}
        {tab==="optimize"&&<>
          {ldO&&<div className="yt-ld-box"><div className="yt-spin"/><p>Generating SEO...</p></div>}
          {optTitles.length>0&&<div className="yt-opt-section">
            <div className="yt-opt-h"><span className="yt-opt-label">📌 Titles</span><button className="yt-btn-cp-sm" onClick={()=>copy(optTitles.join("\n"),"titles")}>{cp==="titles"?"✅":"📋"}</button></div>
            {optTitles.map((t,i)=><div key={i} className="yt-opt-title" onClick={()=>copy(t,"t"+i)}>
              <span className="yt-opt-num">{i+1}</span><span>{t}</span>{cp===("t"+i)&&<span className="yt-opt-copied">✅</span>}
            </div>)}
          </div>}
          {optDesc&&<div className="yt-opt-section">
            <div className="yt-opt-h"><span className="yt-opt-label">📝 Descriptions ({optDesc.split('---').filter(d=>d.trim()).length} variants)</span></div>
            {optDesc.split('---').filter(d=>d.trim()).map((d,i)=><div key={i} className="yt-opt-desc-card">
              <div className="yt-opt-desc-head"><span className="yt-opt-num">{i+1}</span><span className="yt-opt-desc-tone">{["🔮 Curiosity","📚 Educational","💥 Clickbait"][i]||`#${i+1}`}</span><button className="yt-btn-cp-sm" onClick={()=>copy(d.trim(),"desc"+i)}>{cp===("desc"+i)?"✅":"📋"}</button></div>
              <pre className="yt-pre yt-pre-sm">{d.trim()}</pre>
            </div>)}
          </div>}
          {optTags.length>0&&<div className="yt-opt-section">
            <div className="yt-opt-h"><span className="yt-opt-label">🏷️ Tags</span><button className="yt-btn-cp-sm" onClick={()=>copy(optTags.join(", "),"tags")}>{cp==="tags"?"✅":"📋"}</button></div>
            <div className="yt-opt-tags">{optTags.map((t,i)=><span key={i} className="yt-opt-tag" onClick={()=>copy(t,"tag"+i)}>{t}</span>)}</div>
          </div>}
          {!ldO&&!optTitles.length&&!optDesc&&<button className="yt-btn-big yt-btn-big-suggest" onClick={runOptimize}>📊 Generate SEO</button>}
        </>}
        {tab==="thumbnail"&&<>
          {/* Step 1: Choose mode */}
          {!thMode && <div className="yt-th-choose">
            <p className="yt-th-choose-label">How do you want to create the thumbnail?</p>
            <div className="yt-th-choose-grid">
              <button className="yt-th-choose-btn" onClick={()=>{setThMode("reference"); if(initialRefThumb && !thRefImg) setThRefImg(initialRefThumb);}}>
                <span className="yt-th-choose-ic">🖼️</span>
                <span className="yt-th-choose-n">From Reference</span>
                <span className="yt-th-choose-d">Upload a photo or use outlier thumbnail → AI writes prompt</span>
                {initialRefThumb && <span className="yt-th-choose-tag">Outlier thumbnail available</span>}
              </button>
              <button className="yt-th-choose-btn" onClick={()=>setThMode("scratch")}>
                <span className="yt-th-choose-ic">✏️</span>
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
                      <span className="yt-th-ref-drop-ic">🖼️</span>
                      <span className="yt-th-ref-drop-t">Drop reference photo here</span>
                      <span className="yt-th-ref-drop-d">or click to upload</span>
                    </label>
                  )}
                </div>
                <div className="yt-th-prompt-col">
                  <div className="yt-th-prompt-header">
                    <label className="yt-label">Nana Banana Prompt</label>
                    {thRefImg && !thPrompt && <button className={`yt-btn ${thAnalyzing?'yt-btn-ld':''}`} onClick={analyzeReference} disabled={thAnalyzing}>{thAnalyzing?"⏳ Analyzing...":"🔍 Analyze & Write Prompt"}</button>}
                  </div>
                  {thAnalyzing && <div className="yt-ld-box"><div className="yt-spin"/><p>Claude analyzing reference...</p></div>}
                  {thPrompt && <>
                    <textarea className="yt-input yt-th-prompt-area" rows="8" value={thPrompt} onChange={e=>setThPrompt(e.target.value)} placeholder="AI-generated prompt will appear here..."/>
                    <div className="yt-th-prompt-actions">
                      <button className="yt-btn-cp" onClick={()=>copy(thPrompt,"thprompt")}>{cp==="thprompt"?"✅ Copied!":"📋 Copy Prompt"}</button>
                    </div>
                    {/* Refine section */}
                    <div className="yt-th-refine">
                      <label className="yt-label">✏️ Refine Prompt</label>
                      <div className="yt-th-refine-row">
                        <textarea className="yt-input yt-th-refine-input" rows="2" value={thRefine} onChange={e=>setThRefine(e.target.value)} placeholder="e.g. Add bold yellow title 'THIS CHANGES EVERYTHING', replace fruit with vegetable, make background darker..." onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();refinePrompt();}}}/>
                        <button className={`yt-btn-refine ${thRefining?'yt-btn-ld':''}`} onClick={refinePrompt} disabled={thRefining||!thRefine.trim()}>{thRefining?"⏳":"🔄 Refine"}</button>
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
                    }} disabled={thAnalyzing}>{thAnalyzing?"⏳ Generating...":"🤖 Auto-Generate Prompt"}</button>}
                  </div>
                  {thAnalyzing && <div className="yt-ld-box"><div className="yt-spin"/><p>Writing thumbnail prompt...</p></div>}
                  <textarea className="yt-input yt-th-prompt-area" rows="6" value={thPrompt} onChange={e=>setThPrompt(e.target.value)} placeholder={`Write your Nana Banana / Midjourney prompt here...\n\nExample: Close-up of a person's shocked face looking at a glowing ancient plant, dramatic golden backlighting, deep shadows...`}/>
                  {thPrompt && <>
                    <div className="yt-th-prompt-actions">
                      <button className="yt-btn-cp" onClick={()=>copy(thPrompt,"thprompt")}>{cp==="thprompt"?"✅ Copied!":"📋 Copy Prompt"}</button>
                    </div>
                    <div className="yt-th-refine">
                      <label className="yt-label">✏️ Refine Prompt</label>
                      <div className="yt-th-refine-row">
                        <textarea className="yt-input yt-th-refine-input" rows="2" value={thRefine} onChange={e=>setThRefine(e.target.value)} placeholder="e.g. Make it more dramatic, add a person, change colors to blue..." onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();refinePrompt();}}}/>
                        <button className={`yt-btn-refine ${thRefining?'yt-btn-ld':''}`} onClick={refinePrompt} disabled={thRefining||!thRefine.trim()}>{thRefining?"⏳":"🔄 Refine"}</button>
                      </div>
                    </div>
                  </>}
                </div>
                <div className="yt-th-scratch-refs">
                  <label className="yt-label">Extra Reference Photos (optional)</label>
                  <label className="yt-thumb-drop">
                    <input type="file" accept="image/*" multiple onChange={handleRefFiles} style={{display:'none'}}/>
                    🖼 Add reference photos
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
                <label className="yt-thumb-check"><input type="checkbox" checked={thumbWithText} onChange={e=>setThumbWithText(e.target.checked)}/><span>🔤 With text</span></label>
                {thMode === "reference" && thRefImg && <label className="yt-thumb-check"><input type="checkbox" checked={thumbSendRef} onChange={e=>setThumbSendRef(e.target.checked)}/><span>🖼️ Send reference</span></label>}
              </div>
              <button className="yt-btn-big" onClick={generateAllThumbs} disabled={!gemKey} style={{marginTop:12}}>{!gemKey?"⚠️ Add Gemini Key":"🖼️ Generate Thumbnails"}</button>
            </div>
          </>}

          {/* Results grid */}
          {thumbResults.length>0&&<>
            <div className="yt-thumb-grid-header"><span className="yt-opt-label">🎨 Results ({thumbResults.filter(r=>r?.url).length}/{thumbResults.length})</span>{thumbResults.some(r=>r?.url)&&<button className="yt-btn-cp-sm" onClick={()=>{setThumbResults([]);setThumbLoading([]);}}>🗑 Clear All</button>}</div>
            <div className="yt-thumb-grid">
              {[...thumbResults].reverse().map((r,ri)=>{ const i=thumbResults.length-1-ri; return <div key={i} className="yt-thumb-item">
                {thumbLoading[i]&&!r?.url&&!r?.error&&<div className="yt-thumb-loader"><div className="yt-spin"/><p>Generating #{i+1}...</p></div>}
                {r?.url&&<><img src={r.url} className="yt-thumb-result-img" alt="" onClick={()=>window.open(r.url)}/>
                  <div className="yt-thumb-actions">
                    <a href={r.url} download={`thumb_${topic.replace(/\s+/g,'_')}_${i+1}.png`} className="yt-thumb-dl">⬇ Download</a>
                    <button className="yt-thumb-regen" onClick={()=>{navigator.clipboard.writeText(r.prompt||"");setCp("tp"+i);setTimeout(()=>setCp(""),2e3);}}>{cp===("tp"+i)?"✅ Copied":"📋 Prompt"}</button>
                    <button className="yt-thumb-regen" onClick={()=>generateThumb(i)}>{thumbLoading[i]?"⏳":"🔄 Regen"}</button>
                  </div>
                </>}
                {r?.error&&<div className="yt-thumb-error">❌ {r.error}<button className="yt-thumb-regen" onClick={()=>generateThumb(i)} style={{marginTop:8,display:'block',width:'100%'}}>🔄 Retry</button></div>}
              </div>; })}
            </div>
          </>}
        </>}
      </div>
    </>}
  </div>);
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
:root{
  --bg:rgb(11,11,15);--bg2:rgb(18,18,24);--bg3:rgb(24,24,32);--bg4:rgb(32,32,42);
  --surface:rgba(255,255,255,.04);--surface2:rgba(255,255,255,.07);--surface3:rgba(255,255,255,.1);
  --border:rgba(255,255,255,.08);--border2:rgba(255,255,255,.12);
  --text:#f0f0f5;--text2:rgba(255,255,255,.55);--text3:rgba(255,255,255,.35);
  --red:#ff3b3b;--red2:#ff5252;--red-bg:rgba(255,59,59,.12);--red-glow:rgba(255,59,59,.25);
  --blue:#4d9fff;--blue-bg:rgba(77,159,255,.12);
  --green:#34d399;--green-bg:rgba(52,211,153,.12);
  --glass:rgba(255,255,255,.03);--glass2:rgba(255,255,255,.06);
  --radius:14px;--radius2:10px;--radius3:8px;
  --shadow:0 4px 24px rgba(0,0,0,.4);--shadow2:0 2px 12px rgba(0,0,0,.3);
  --font:'DM Sans',system-ui,-apple-system,sans-serif;--mono:'JetBrains Mono',monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
::selection{background:var(--red);color:#fff}
.yt-app{min-height:100vh;background:var(--bg);color:var(--text);font-family:var(--font);-webkit-font-smoothing:antialiased}

/* TOPBAR */
.yt-topbar{height:60px;background:rgba(11,11,15,.85);backdrop-filter:blur(20px) saturate(180%);-webkit-backdrop-filter:blur(20px) saturate(180%);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;padding:0 20px;position:sticky;top:0;z-index:100}
.yt-topbar-l{display:flex;align-items:center;gap:16px}
.yt-hamburger{background:none;border:none;color:var(--text2);cursor:pointer;padding:8px;border-radius:10px;display:flex;align-items:center;transition:all .2s}
.yt-hamburger:hover{background:var(--surface2);color:var(--text)}
.yt-logo{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none}
.yt-logo span{font-size:20px;font-weight:700;letter-spacing:-.3px;background:linear-gradient(135deg,#fff 0%,rgba(255,255,255,.7) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.yt-ver-badge{font-size:9px!important;font-weight:700!important;background:var(--red);color:#fff!important;-webkit-text-fill-color:#fff!important;padding:2px 7px;border-radius:6px;margin-left:6px;letter-spacing:.5px;text-transform:uppercase}
.yt-topbar-r{display:flex;align-items:center}
.yt-niche-pill{font-size:12px;color:var(--text2);background:var(--surface2);padding:5px 14px;border-radius:20px;border:1px solid var(--border);font-weight:500}

/* LAYOUT */
.yt-layout{display:flex;min-height:calc(100vh - 60px)}
.yt-sidebar{width:280px;min-width:280px;background:var(--bg2);border-right:1px solid var(--border);padding:16px;overflow-y:auto;max-height:calc(100vh - 60px);position:sticky;top:60px}
.yt-sb-section{padding:4px 0}
.yt-sb-title{font-size:11px;font-weight:600;color:var(--text3);margin-bottom:12px;display:flex;align-items:center;gap:8px;text-transform:uppercase;letter-spacing:1px}
.yt-sb-badge{font-size:10px;background:var(--red);color:#fff;padding:2px 8px;border-radius:10px;font-weight:600}
.yt-sb-empty{font-size:13px;color:var(--text3);padding:16px 0}
.yt-sb-list{display:flex;flex-direction:column;gap:2px}
.yt-sb-item{padding:10px 12px;border-radius:var(--radius3);cursor:default;transition:all .15s;border:1px solid transparent}
.yt-sb-item:hover{background:var(--surface2);border-color:var(--border)}
.yt-sb-clickable{cursor:pointer}
.yt-sb-clickable:hover{background:var(--red-bg);border-color:rgba(255,59,59,.2)}
.yt-sb-item-top{display:flex;align-items:start;gap:6px}
.yt-sb-item-content{flex:1;min-width:0}
.yt-sb-remake{background:none;border:none;font-size:14px;cursor:pointer;padding:2px 6px;border-radius:6px;opacity:0;transition:all .15s;flex-shrink:0}
.yt-sb-item:hover .yt-sb-remake{opacity:.6}
.yt-sb-remake:hover{opacity:1!important;background:var(--surface3)}
.yt-sb-del{background:none;border:none;font-size:12px;cursor:pointer;padding:2px 6px;border-radius:6px;opacity:0;transition:all .15s;flex-shrink:0;color:var(--text3)}
.yt-sb-item:hover .yt-sb-del{opacity:.4}
.yt-sb-del:hover{opacity:1!important;background:var(--red-bg);color:var(--red)}
.yt-sb-item-t{font-size:13px;color:var(--text);line-height:1.4;font-weight:400}
.yt-sb-item-m{font-size:11px;color:var(--text3);margin-top:3px}
.yt-sb-version{display:inline-flex;background:var(--red);color:#fff;font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;margin-right:6px;vertical-align:middle;letter-spacing:.5px}
.yt-main{flex:1;padding:32px 40px;max-width:960px;margin:0 auto}
.yt-main-full{max-width:1100px}

/* ANIMATIONS */
.yt-page{animation:vFade .35s cubic-bezier(.16,1,.3,1)}
@keyframes vFade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes vSpin{to{transform:rotate(360deg)}}
@keyframes vPulse{0%,100%{opacity:.4}50%{opacity:1}}

/* TYPOGRAPHY */
.yt-page-title{font-size:24px;font-weight:700;margin-bottom:20px;letter-spacing:-.3px}
.yt-sub{font-size:14px;color:var(--text2);margin:-14px 0 20px}
.yt-breadcrumb{display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap}

/* HERO */
.yt-hero{margin-bottom:24px;padding:32px;background:linear-gradient(135deg,var(--bg3) 0%,var(--bg4) 100%);border:1px solid var(--border);border-radius:var(--radius);position:relative;overflow:hidden}
.yt-hero::before{content:'';position:absolute;top:-50%;right:-20%;width:300px;height:300px;background:radial-gradient(circle,var(--red-glow) 0%,transparent 70%);opacity:.3;pointer-events:none}
.yt-hero-text{position:relative;z-index:1}
.yt-hero-title{font-size:28px;font-weight:700;letter-spacing:-.5px;margin-bottom:8px;background:linear-gradient(135deg,#fff 0%,rgba(255,255,255,.7) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.yt-hero-sub{font-size:14px;color:var(--text2);margin-bottom:20px}
.yt-hero-stats{display:flex;gap:24px;position:relative;z-index:1}
.yt-stat{display:flex;flex-direction:column;gap:2px}
.yt-stat-num{font-size:28px;font-weight:700;color:var(--text);letter-spacing:-.5px}
.yt-stat-label{font-size:11px;font-weight:500;color:var(--text3);text-transform:uppercase;letter-spacing:.5px}

/* INFO BAR */
.yt-info-bar{display:flex;gap:20px;margin-bottom:20px;padding:14px 20px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius2);flex-wrap:wrap}
.yt-info-item{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text2);font-weight:500}
.yt-info-num{font-size:16px;font-weight:700;color:var(--text);margin-right:2px}

/* EMPTY STATE */
.yt-empty-state{text-align:center;padding:60px 20px;background:var(--surface);border:1px dashed var(--border2);border-radius:var(--radius)}
.yt-empty-icon{font-size:48px;margin-bottom:16px;opacity:.6}
.yt-empty-title{font-size:18px;font-weight:600;color:var(--text);margin-bottom:8px}
.yt-empty-desc{font-size:14px;color:var(--text3)}

/* CARD GLOW */
.yt-card-glow{border-color:var(--red);box-shadow:0 0 20px var(--red-glow)}

/* CARDS */
.yt-card{background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:16px;transition:border-color .2s}
.yt-card:hover{border-color:var(--border2)}
.yt-card-h{display:flex;justify-content:space-between;align-items:center;cursor:pointer}
.yt-card-ht{font-size:14px;font-weight:600;margin-bottom:6px;color:var(--text);letter-spacing:-.1px}
.yt-card-b{margin-top:14px}
.yt-chev{color:var(--text3);font-size:12px;transition:transform .2s}
.yt-hint{font-size:12px;color:var(--text3);margin-bottom:10px;margin-top:4px}
.yt-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
.yt-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:14px}
.yt-label{display:block;font-size:11px;color:var(--text3);margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.yt-input{width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:var(--radius3);padding:10px 14px;color:var(--text);font-size:14px;font-family:var(--font);transition:all .2s}
.yt-input:focus{outline:none;border-color:var(--red);box-shadow:0 0 0 3px var(--red-glow)}
.yt-input::placeholder{color:var(--text3)}
.yt-sel{width:100%;background:var(--bg);border:1px solid var(--border2);border-radius:var(--radius3);padding:10px 14px;color:var(--text);font-size:14px;font-family:var(--font);cursor:pointer}
.yt-input-row{display:flex;gap:10px;align-items:center}
.yt-input-row .yt-input{flex:1}

/* BUTTONS */
.yt-btn{background:var(--red);border:none;border-radius:var(--radius3);padding:9px 22px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font);white-space:nowrap;transition:all .2s;letter-spacing:.2px}
.yt-btn:hover{background:var(--red2);box-shadow:0 4px 16px var(--red-glow);transform:translateY(-1px)}
.yt-btn:active{transform:translateY(0)}
.yt-btn:disabled{opacity:.4;transform:none;box-shadow:none}
.yt-btn-o{background:transparent;border:1px solid var(--border2);border-radius:var(--radius3);padding:8px 18px;color:var(--text2);font-size:13px;font-weight:500;cursor:pointer;font-family:var(--font);white-space:nowrap;transition:all .2s}
.yt-btn-o:hover{background:var(--surface2);border-color:var(--text3);color:var(--text)}
.yt-btn-row{display:flex;gap:10px}
.yt-btn-big{width:100%;background:linear-gradient(135deg,var(--red) 0%,#cc2020 100%);border:none;border-radius:var(--radius2);padding:14px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;font-family:var(--font);transition:all .25s;letter-spacing:.2px}
.yt-btn-big:hover{box-shadow:0 6px 24px var(--red-glow);transform:translateY(-1px)}
.yt-btn-big-ld{background:var(--bg4)!important;color:var(--text3)!important;box-shadow:none!important;transform:none!important}
.yt-btn-big-suggest{background:linear-gradient(135deg,#2563eb 0%,#1d4ed8 100%);margin-top:10px}
.yt-btn-big-suggest:hover{box-shadow:0 6px 24px rgba(37,99,235,.35)}
.yt-btn-use{background:transparent;border:1px solid var(--red);border-radius:var(--radius3);padding:6px 16px;color:var(--red);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font);transition:all .2s}
.yt-btn-use:hover{background:var(--red);color:#fff;box-shadow:0 4px 12px var(--red-glow)}
.yt-btn-remake{background:var(--surface2);border:1px solid var(--border2);border-radius:var(--radius3);padding:6px 16px;color:var(--text2);font-size:12px;font-weight:500;cursor:pointer;font-family:var(--font);transition:all .2s}
.yt-btn-remake:hover{background:var(--surface3);color:var(--text)}
.yt-btn-regen{background:transparent;border:1px solid var(--red);border-radius:var(--radius3);padding:6px 18px;color:var(--red);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font);white-space:nowrap;transition:all .2s}
.yt-btn-regen:hover{background:var(--red-bg)}
.yt-topic-btns{margin-top:10px;display:flex;gap:8px}
.yt-x{background:none;border:none;color:var(--text3);font-size:16px;cursor:pointer;padding:4px 8px;border-radius:8px;transition:all .15s}
.yt-x:hover{background:var(--surface3);color:var(--red)}

/* SECTIONS */
.yt-sec-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.yt-sec-h h2{font-size:18px;font-weight:600;letter-spacing:-.2px}
.yt-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.yt-chip{display:flex;align-items:center;gap:6px;background:var(--surface2);border:1px solid var(--border);border-radius:20px;padding:6px 14px;font-size:12px;color:var(--text);font-weight:500}
.yt-chip button{background:none;border:none;color:var(--text3);cursor:pointer;font-size:13px;transition:color .15s}
.yt-chip button:hover{color:var(--red)}

/* NICHE GRID */
.yt-niche-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.yt-niche-card{background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;cursor:pointer;transition:all .25s}
.yt-niche-card:hover{border-color:var(--red);box-shadow:0 4px 20px rgba(255,59,59,.1);transform:translateY(-2px)}
.yt-niche-cover-wrap{width:100%;height:120px;overflow:hidden;position:relative}
.yt-niche-cover{width:100%;height:100%;object-fit:cover;transition:transform .3s}
.yt-niche-card:hover .yt-niche-cover{transform:scale(1.05)}
.yt-niche-card-body{padding:16px 20px}
.yt-niche-top{display:flex;justify-content:space-between;align-items:start}
.yt-niche-top h3{font-size:16px;font-weight:600;letter-spacing:-.1px}
.yt-niche-desc{font-size:13px;color:var(--text2);margin-top:6px;line-height:1.4}
.yt-niche-meta{font-size:11px;color:var(--text3);margin-top:10px;font-weight:500;display:flex;gap:14px}

/* NICHE FORM */
.yt-niche-form{display:flex;gap:16px;align-items:start}
.yt-niche-cover-upload{flex-shrink:0}
.yt-cover-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;width:100px;height:100px;border:2px dashed var(--border2);border-radius:var(--radius3);cursor:pointer;transition:all .2s;overflow:hidden}
.yt-cover-drop:hover{border-color:var(--red);background:var(--red-bg)}
.yt-cover-icon{font-size:28px;opacity:.5}
.yt-cover-text{font-size:10px;color:var(--text3);margin-top:4px;font-weight:600;text-transform:uppercase;letter-spacing:.5px}
.yt-cover-preview{width:100%;height:100%;object-fit:cover}
.yt-niche-form-fields{flex:1;display:flex;flex-direction:column;gap:10px}

/* STATUS */
.yt-st{font-size:13px;margin-top:10px;color:var(--text2);font-weight:500}
.yt-st.err{color:var(--red)}
.yt-st.ok{color:var(--green)}

/* OUTLIERS TOGGLE & FILTER */
.yt-toggle{display:flex;justify-content:space-between;align-items:center;cursor:pointer;margin-top:16px;padding:10px 0;border-top:1px solid var(--border)}
.yt-toggle-t{font-size:13px;font-weight:600;color:var(--red);letter-spacing:-.1px}
.yt-days-filter{display:flex;gap:6px;margin:10px 0 6px}
.yt-days-chip{background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:5px 16px;font-size:11px;font-weight:600;color:var(--text3);cursor:pointer;font-family:var(--font);transition:all .2s;letter-spacing:.3px}
.yt-days-chip:hover{background:var(--surface2);color:var(--text2)}
.yt-days-chip.active{background:var(--red);color:#fff;border-color:var(--red);box-shadow:0 2px 8px var(--red-glow)}

/* VIDEO GRID */
.yt-outliers{display:grid;gap:6px;margin-top:10px;max-height:400px;overflow-y:auto}
.yt-out-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin-top:14px;max-height:640px;overflow-y:auto;padding:4px}
.yt-out-card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;transition:all .25s}
.yt-out-card:hover{border-color:var(--border2);box-shadow:var(--shadow2);transform:translateY(-3px)}
.yt-out-card-img-wrap{position:relative;width:100%;aspect-ratio:16/9;background:var(--bg4);overflow:hidden}
.yt-out-card-img{width:100%;height:100%;object-fit:cover;transition:transform .3s}
.yt-out-card:hover .yt-out-card-img{transform:scale(1.04)}
.yt-out-card-ratio{position:absolute;top:8px;right:8px;background:var(--green);color:#000;font-size:10px;font-weight:700;padding:3px 8px;border-radius:8px;letter-spacing:.3px}
.yt-out-card-views{position:absolute;bottom:8px;right:8px;background:rgba(0,0,0,.8);backdrop-filter:blur(4px);color:#fff;font-size:10px;font-weight:600;padding:3px 8px;border-radius:6px}
.yt-out-card-body{padding:12px 14px}
.yt-out-card-title{font-size:13px;font-weight:500;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:6px;color:var(--text)}
.yt-out-card-ch{font-size:11px;color:var(--text3);margin-bottom:10px;font-weight:500}
.yt-out-card-btns{display:flex;gap:6px}
.yt-btn-use-sm{background:transparent;border:1px solid var(--red);border-radius:8px;padding:5px 14px;color:var(--red);font-size:11px;font-weight:600;cursor:pointer;font-family:var(--font);white-space:nowrap;transition:all .2s;letter-spacing:.2px}
.yt-btn-use-sm:hover{background:var(--red);color:#fff;box-shadow:0 4px 12px var(--red-glow)}

/* TOPICS */
.yt-topics{display:grid;gap:8px}
.yt-topic{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius2);padding:14px;transition:all .2s}
.yt-topic:hover{background:var(--surface2);border-color:var(--border2)}
.yt-topic-done{opacity:.4}
.yt-topic-h{display:flex;justify-content:space-between;align-items:start;gap:8px}
.yt-topic-t{font-size:14px;font-weight:500;line-height:1.4}
.yt-badge-used{font-size:10px;font-weight:700;background:var(--red-bg);color:var(--red);padding:3px 10px;border-radius:6px;white-space:nowrap;letter-spacing:.3px}
.yt-topic-a{font-size:13px;color:var(--text2);margin-top:6px;line-height:1.4}
.yt-topic-w{font-size:12px;color:var(--green);margin-top:4px;font-weight:500}
.yt-topic-i{font-size:12px;color:var(--text3);margin-top:3px}

/* USED ITEMS */
.yt-used-items{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius2);padding:12px 16px;margin-bottom:16px;font-size:12px;line-height:1.6}
.yt-used-items-label{color:var(--green);font-weight:600;margin-right:8px}
.yt-used-items-list{color:var(--text3)}

/* TOPIC BANNER */
.yt-topic-banner{background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:16px 20px;margin-bottom:20px;font-size:16px;font-weight:600;line-height:1.4;border-left:3px solid var(--red);display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.yt-version{font-size:11px;background:var(--red-bg);color:var(--red);padding:3px 10px;border-radius:8px;font-weight:600}
.yt-version-sm{font-size:10px;background:var(--red-bg);color:var(--red);padding:2px 8px;border-radius:8px;font-weight:600}
.yt-version-big{font-size:12px;background:var(--red);color:#fff;padding:4px 12px;border-radius:6px;font-weight:700;letter-spacing:.5px}
.yt-ref-preview{display:flex;align-items:center;gap:14px;background:var(--blue-bg);border:1px solid rgba(77,159,255,.2);border-radius:var(--radius2);padding:14px;margin-bottom:16px;position:relative}
.yt-ref-img{width:100px;height:56px;border-radius:8px;object-fit:cover}
.yt-ref-label{font-size:13px;color:var(--blue);font-weight:500;flex:1}
.yt-ref-rm{background:var(--surface2);border:1px solid var(--border);color:var(--text3);width:28px;height:28px;border-radius:8px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;transition:all .15s;flex-shrink:0}
.yt-ref-rm:hover{background:var(--red-bg);color:var(--red);border-color:rgba(255,59,59,.3)}

/* MODE SELECT */
.yt-mode-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.yt-mode{background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:36px 28px;cursor:pointer;text-align:center;transition:all .3s;color:var(--text);font-family:var(--font)}
.yt-mode:hover{transform:translateY(-4px);box-shadow:var(--shadow)}
.yt-mode.auto:hover{border-color:var(--red);box-shadow:0 8px 32px var(--red-glow)}
.yt-mode.manual:hover{border-color:var(--blue);box-shadow:0 8px 32px rgba(77,159,255,.2)}
.yt-mode-ic{font-size:40px;margin-bottom:12px}
.yt-mode-n{font-size:22px;font-weight:700;margin-bottom:8px;letter-spacing:-.2px}
.yt-mode-d{font-size:13px;color:var(--text2);margin-bottom:16px}
.yt-mode-b{display:inline-block;font-size:10px;font-weight:700;letter-spacing:1px;background:var(--red-bg);color:var(--red);padding:5px 16px;border-radius:20px;text-transform:uppercase}
.yt-mode-b2{background:var(--blue-bg);color:var(--blue)}
.yt-mtag{font-size:11px;font-weight:700;padding:4px 12px;border-radius:6px;letter-spacing:.5px}
.yt-mtag.auto{background:var(--red-bg);color:var(--red)}
.yt-mtag.manual{background:var(--blue-bg);color:var(--blue)}

/* GENERATE CONTROLS */
.yt-gen-ctrl{display:grid;grid-template-columns:1fr 1fr 2fr;gap:14px;align-items:end;margin-bottom:24px}
.yt-gen-btns{display:flex;gap:8px;flex-wrap:wrap}
.yt-btn-gen{background:linear-gradient(135deg,var(--red) 0%,#cc2020 100%);border:none;border-radius:var(--radius3);padding:11px 26px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;font-family:var(--font);flex:1;white-space:nowrap;transition:all .25s;letter-spacing:.2px}
.yt-btn-gen:hover{box-shadow:0 6px 24px var(--red-glow);transform:translateY(-1px)}
.yt-btn-studio{background:linear-gradient(135deg,#7c3aed 0%,#4f46e5 100%);border:none;border-radius:var(--radius3);padding:11px 22px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;font-family:var(--font);white-space:nowrap;transition:all .25s;letter-spacing:.2px}
.yt-btn-studio:hover{box-shadow:0 6px 24px rgba(124,58,237,.4);transform:translateY(-1px)}
.yt-btn-thb{background:var(--blue-bg);border:1px solid rgba(77,159,255,.2);border-radius:var(--radius3);padding:10px 20px;color:var(--blue);font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font);white-space:nowrap;transition:all .2s}
.yt-btn-thb:hover{background:rgba(77,159,255,.2);box-shadow:0 4px 12px rgba(77,159,255,.15)}
.yt-btn-ref{background:var(--blue-bg);border:1px solid rgba(77,159,255,.2);border-radius:var(--radius3);padding:10px 18px;color:var(--blue);font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font);white-space:nowrap;transition:all .2s}
.yt-btn-ref:hover{background:rgba(77,159,255,.2)}
.yt-btn-ld{background:var(--bg4)!important;color:var(--text3)!important;border-color:var(--border)!important;box-shadow:none!important;transform:none!important}

/* TABS */
.yt-tabs{display:flex;gap:2px}
.yt-tab{flex:1;background:var(--surface);border:1px solid var(--border);border-bottom:none;border-radius:var(--radius2) var(--radius2) 0 0;padding:12px 18px;color:var(--text3);font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font);transition:all .2s;text-align:center}
.yt-tab:hover{color:var(--text2);background:var(--surface2)}
.yt-tab.active{background:var(--bg3);color:var(--text);border-color:var(--border2)}
.yt-out-panel{background:var(--bg3);border:1px solid var(--border2);border-radius:0 0 var(--radius) var(--radius);padding:20px}
.yt-out-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.yt-cc{font-size:12px;font-family:var(--mono);color:var(--green);font-weight:500}
.yt-cc.over{color:var(--red)}
.yt-btn-cp{background:var(--red-bg);border:none;border-radius:var(--radius3);padding:7px 18px;color:var(--red);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font);transition:all .2s}
.yt-btn-cp:hover{background:rgba(255,59,59,.2)}
.yt-pre{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius3);padding:18px;color:var(--text2);font-size:12.5px;font-family:var(--mono);line-height:1.8;white-space:pre-wrap;word-break:break-word;max-height:500px;overflow:auto}

/* OPTIMIZE SECTIONS */
.yt-opt-section{margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)}
.yt-opt-section:last-child{border-bottom:none;margin-bottom:0;padding-bottom:0}
.yt-opt-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.yt-opt-label{font-size:13px;font-weight:600;color:var(--text);letter-spacing:-.1px}
.yt-btn-cp-sm{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:4px 12px;color:var(--text2);font-size:11px;font-weight:600;cursor:pointer;font-family:var(--font);transition:all .15s}
.yt-btn-cp-sm:hover{background:var(--surface3);color:var(--text)}
.yt-opt-title{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius3);margin-bottom:6px;cursor:pointer;font-size:13px;transition:all .2s;color:var(--text)}
.yt-opt-title:hover{background:var(--surface2);border-color:var(--border2)}
.yt-opt-num{width:24px;height:24px;background:var(--red);color:#fff;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0}
.yt-opt-copied{font-size:11px;margin-left:auto;color:var(--green)}
.yt-opt-tags{display:flex;flex-wrap:wrap;gap:6px}
.yt-opt-tag{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:6px 14px;font-size:12px;color:var(--text2);cursor:pointer;transition:all .2s;font-weight:500}
.yt-opt-tag:hover{background:var(--surface2);border-color:var(--border2);color:var(--text)}
.yt-pre-sm{max-height:300px}
.yt-opt-desc-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius2);padding:14px;margin-bottom:10px;transition:all .2s}
.yt-opt-desc-card:hover{border-color:var(--border2)}
.yt-opt-desc-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.yt-opt-desc-tone{font-size:12px;color:var(--text2);font-weight:500;flex:1}

/* LOADING */
.yt-loading{display:flex;align-items:center;justify-content:center;min-height:100vh;background:var(--bg)}
.yt-ld-box{text-align:center;padding:36px}
.yt-ld-box p{color:var(--text3);font-size:13px;margin-top:10px;font-weight:500}
.yt-spin{width:28px;height:28px;border:2px solid var(--border2);border-top-color:var(--red);border-radius:50%;animation:vSpin .7s linear infinite;margin:0 auto}
.yt-empty{text-align:center;padding:48px;color:var(--text3)}

/* THUMBNAIL WORKFLOW */
.yt-th-choose{padding:10px 0}
.yt-th-choose-label{font-size:14px;color:var(--text2);margin-bottom:16px;font-weight:500}
.yt-th-choose-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.yt-th-choose-btn{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);padding:28px 24px;cursor:pointer;text-align:center;transition:all .3s;color:var(--text);font-family:var(--font);display:flex;flex-direction:column;align-items:center;gap:8px}
.yt-th-choose-btn:hover{transform:translateY(-3px);border-color:var(--red);box-shadow:0 8px 32px var(--red-glow)}
.yt-th-choose-ic{font-size:36px}
.yt-th-choose-n{font-size:16px;font-weight:700;letter-spacing:-.1px}
.yt-th-choose-d{font-size:12px;color:var(--text3);line-height:1.4}
.yt-th-choose-tag{font-size:10px;font-weight:700;background:var(--green-bg);color:var(--green);padding:3px 10px;border-radius:6px;margin-top:4px}

.yt-th-ref-section{margin-bottom:16px}
.yt-th-ref-layout{display:grid;grid-template-columns:300px 1fr;gap:20px;align-items:start}
.yt-th-ref-img-col{display:flex;flex-direction:column;gap:8px}
.yt-th-ref-preview{position:relative;border-radius:var(--radius);overflow:hidden;border:2px solid var(--border2)}
.yt-th-ref-big{width:100%;aspect-ratio:16/9;object-fit:cover;display:block}
.yt-th-ref-overlay{position:absolute;bottom:0;left:0;right:0;display:flex;gap:8px;padding:10px;background:linear-gradient(transparent,rgba(0,0,0,.8));opacity:0;transition:opacity .2s}
.yt-th-ref-preview:hover .yt-th-ref-overlay{opacity:1}
.yt-th-ref-change{background:rgba(255,255,255,.15);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.2);border-radius:6px;padding:6px 14px;color:#fff;font-size:11px;font-weight:600;cursor:pointer;font-family:var(--font);transition:all .15s;text-align:center}
.yt-th-ref-change:hover{background:rgba(255,255,255,.25)}
.yt-th-ref-drop-big{display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;aspect-ratio:16/9;border:2px dashed var(--border2);border-radius:var(--radius);cursor:pointer;transition:all .2s;gap:8px}
.yt-th-ref-drop-big:hover{border-color:var(--red);background:var(--red-bg)}
.yt-th-ref-drop-ic{font-size:40px;opacity:.5}
.yt-th-ref-drop-t{font-size:13px;color:var(--text2);font-weight:600}
.yt-th-ref-drop-d{font-size:11px;color:var(--text3)}

.yt-th-prompt-col{display:flex;flex-direction:column;gap:10px}
.yt-th-prompt-header{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.yt-th-prompt-area{font-family:var(--mono);font-size:12.5px;line-height:1.7;resize:vertical;min-height:120px}
.yt-th-prompt-actions{display:flex;gap:8px}

.yt-th-refine{margin-top:12px;padding-top:12px;border-top:1px solid var(--border)}
.yt-th-refine-row{display:flex;gap:10px;align-items:start}
.yt-th-refine-input{flex:1;font-family:var(--font);font-size:13px;line-height:1.5;resize:vertical;min-height:50px}
.yt-btn-refine{background:var(--blue-bg);border:1px solid rgba(77,159,255,.2);border-radius:var(--radius3);padding:10px 20px;color:var(--blue);font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font);white-space:nowrap;transition:all .2s;align-self:start}
.yt-btn-refine:hover{background:rgba(77,159,255,.2);box-shadow:0 4px 12px rgba(77,159,255,.15)}
.yt-btn-refine:disabled{opacity:.4}

.yt-th-scratch-layout{display:grid;grid-template-columns:1fr 200px;gap:20px;align-items:start}
.yt-th-scratch-refs{display:flex;flex-direction:column;gap:8px}

.yt-th-gen-bar{margin-top:16px;padding-top:16px;border-top:1px solid var(--border)}

/* THUMBNAIL GENERATOR (kept) */
.yt-thumb-setup{margin-bottom:20px}
.yt-thumb-setup-top{display:flex;gap:16px;align-items:start}
.yt-thumb-refs-col{width:200px;flex-shrink:0;display:flex;flex-direction:column;gap:8px}
.yt-thumb-drop{display:flex;align-items:center;justify-content:center;border:2px dashed var(--border2);border-radius:var(--radius3);padding:16px 12px;text-align:center;cursor:pointer;transition:all .2s;color:var(--text3);font-size:12px;font-weight:500}
.yt-thumb-drop:hover{border-color:var(--red);background:var(--red-bg);color:var(--text2)}
.yt-thumb-ref-list{display:flex;gap:6px;flex-wrap:wrap}
.yt-thumb-ref-card{position:relative;flex-shrink:0}
.yt-thumb-ref-img{width:90px;height:51px;border-radius:6px;object-fit:cover;border:2px solid var(--border2)}
.yt-thumb-ref-badge{position:absolute;top:3px;left:3px;background:var(--red);color:#fff;font-size:8px;font-weight:700;padding:1px 5px;border-radius:3px;letter-spacing:.5px}
.yt-thumb-ref-rm{position:absolute;top:-5px;right:-5px;background:var(--red);color:#fff;border:none;border-radius:50%;width:18px;height:18px;font-size:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .15s}
.yt-thumb-ref-card:hover .yt-thumb-ref-rm{opacity:1}
.yt-thumb-ref-rm-show{opacity:.7}
.yt-thumb-ref-rm-show:hover{opacity:1}
.yt-thumb-fields{flex:1;display:flex;flex-direction:column;gap:10px}
.yt-thumb-desc-wrap{flex:1}
.yt-thumb-textarea{resize:vertical;min-height:80px;font-family:var(--font);line-height:1.5}
.yt-thumb-options{display:flex;gap:12px;align-items:end}
.yt-thumb-options>div{flex:1}
.yt-thumb-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text2);cursor:pointer;padding:10px 0;white-space:nowrap;font-weight:500}
.yt-thumb-check input{accent-color:var(--red)}
.yt-thumb-grid-header{display:flex;justify-content:space-between;align-items:center;margin:16px 0 8px;padding-top:16px;border-top:1px solid var(--border)}
.yt-thumb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px;margin-top:8px}
.yt-thumb-item{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;transition:all .25s}
.yt-thumb-item:hover{border-color:var(--border2);box-shadow:var(--shadow2)}
.yt-thumb-loader{padding:60px 20px;text-align:center}
.yt-thumb-loader p{color:var(--text3);font-size:12px;margin-top:10px;font-weight:500}
.yt-thumb-result-img{width:100%;aspect-ratio:16/9;object-fit:cover;cursor:pointer;transition:transform .3s}
.yt-thumb-result-img:hover{transform:scale(1.02)}
.yt-thumb-actions{display:flex;gap:8px;padding:10px 12px}
.yt-thumb-dl{flex:1;text-align:center;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius3);padding:7px;color:var(--text2);font-size:11px;font-weight:600;text-decoration:none;transition:all .2s;font-family:var(--font)}
.yt-thumb-dl:hover{background:var(--surface3);color:var(--text)}
.yt-thumb-regen{flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius3);padding:7px;color:var(--text2);font-size:11px;font-weight:600;cursor:pointer;transition:all .2s;font-family:var(--font)}
.yt-thumb-regen:hover{background:var(--red-bg);color:var(--red);border-color:rgba(255,59,59,.2)}
.yt-thumb-error{padding:30px;text-align:center;color:var(--red);font-size:12px;font-weight:500}

/* SCROLLBAR */
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border2);border-radius:3px}::-webkit-scrollbar-thumb:hover{background:var(--text3)}

/* RESPONSIVE */
@media(max-width:768px){.yt-sidebar{display:none}.yt-main{padding:16px 20px}.yt-grid2,.yt-gen-ctrl{grid-template-columns:1fr}.yt-gen-btns{grid-column:1/-1}.yt-mode-grid,.yt-niche-grid,.yt-th-choose-grid{grid-template-columns:1fr}.yt-out-grid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}.yt-hero-stats{gap:16px}.yt-hero-title{font-size:22px}.yt-info-bar{gap:12px}.yt-th-ref-layout,.yt-th-scratch-layout{grid-template-columns:1fr}}
`;
