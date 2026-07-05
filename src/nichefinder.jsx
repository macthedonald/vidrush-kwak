import { useState, useRef, useEffect } from "react";
import { claude, parseJson } from "./pipeline";
import { useReveal, animateScore } from "./anim";

// Advanced Niche Finder — VidIQ-style opportunity analysis on live YouTube data.
// For each keyword: recent top videos → channel stats → demand / opportunity /
// competition / engagement metrics → 0-100 niche score + breakout channels + outliers.
// Saved niches carry their breakout channels straight into the Research tool.

const YT = "https://www.googleapis.com/youtube/v3";
async function ytApi(ep, params, key) {
  const r = await fetch(`${YT}/${ep}?${new URLSearchParams({ ...params, key })}`);
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error?.message || `YT ${r.status}`); }
  return r.json();
}
const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(0) + "K" : String(Math.round(n));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const titleCase = s => s.replace(/\b\w/g, c => c.toUpperCase());

const SYS_SUBNICHES = `You are a YouTube niche strategist. Given a broad topic, return ONLY a JSON array of 8 specific, faceless-channel-friendly sub-niche search keywords (2-4 words each, English). Favor niches with strong search demand and story potential. Example: ["ancient rome mysteries","medieval castle secrets"]`;
const SYS_VERDICT = `You are a YouTube niche analyst. For each niche you receive metrics for, write a 1-2 sentence sharp verdict (monetization potential, content angle, who wins here). Return ONLY JSON: {"<keyword>":"verdict", ...}`;

// ISO8601 duration (PT#H#M#S) → seconds
function isoSec(d) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || "");
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}
const SHORTS_MAX = 183; // Shorts run up to 3 minutes

// format: "long" (default — Shorts excluded) | "shorts"
async function analyzeKeyword(kw, ytKey, { days = 90, region = "US", format = "long" } = {}) {
  const publishedAfter = new Date(Date.now() - days * 864e5).toISOString();
  const params = { part: "snippet", q: kw, type: "video", order: "viewCount", publishedAfter, maxResults: 25, regionCode: region, relevanceLanguage: "en" };
  if (format === "shorts") params.videoDuration = "short"; // bias the search; exact cut happens on real durations below
  const s = await ytApi("search", params, ytKey);
  const ids = (s.items || []).map(i => i.id.videoId).filter(Boolean);
  if (!ids.length) throw new Error("No recent videos found for this keyword");
  const vdAll = await ytApi("videos", { part: "snippet,statistics,contentDetails", id: ids.join(",") }, ytKey);
  const vd = { items: vdAll.items.filter(v => {
    const sec = isoSec(v.contentDetails?.duration);
    return format === "shorts" ? sec > 0 && sec <= SHORTS_MAX : sec > SHORTS_MAX;
  }) };
  if (!vd.items.length) throw new Error(format === "shorts" ? "No Shorts found for this keyword — try long-form" : "Only Shorts rank for this keyword — try the Shorts filter");
  const chIds = [...new Set(vd.items.map(v => v.snippet.channelId))];
  const cd = await ytApi("channels", { part: "snippet,statistics", id: chIds.join(",") }, ytKey);
  const chans = {};
  cd.items.forEach(c => { chans[c.id] = { id: c.id, name: c.snippet.title, thumb: c.snippet.thumbnails?.default?.url, subs: +(c.statistics.subscriberCount || 0), videoCount: +(c.statistics.videoCount || 0), totalViews: +(c.statistics.viewCount || 0), created: c.snippet.publishedAt }; });

  const vids = vd.items.map(v => {
    const views = +(v.statistics.viewCount || 0);
    const likes = +(v.statistics.likeCount || 0);
    const ageDays = Math.max(1, (Date.now() - new Date(v.snippet.publishedAt)) / 864e5);
    const ch = chans[v.snippet.channelId] || { subs: 0 };
    return { id: v.id, title: v.snippet.title, thumb: v.snippet.thumbnails?.medium?.url, channel: ch.name, channelId: v.snippet.channelId, views, likes, ageDays, vpd: views / ageDays, multiple: views / Math.max(ch.subs, 100), subs: ch.subs };
  }).sort((a, b) => b.views - a.views);

  const avgViews = vids.reduce((s2, v) => s2 + v.views, 0) / vids.length;
  const medViews = vids[Math.floor(vids.length / 2)].views;
  const avgVpd = vids.reduce((s2, v) => s2 + v.vpd, 0) / vids.length;
  const engagement = vids.reduce((s2, v) => s2 + (v.views ? v.likes / v.views : 0), 0) / vids.length;
  const chList = Object.values(chans);
  const smallWinners = chList.filter(c => c.subs < 100000 && vids.some(v => v.channelId === c.id && v.views > 100000));
  const bigShare = vids.filter(v => v.subs > 1_000_000).length / vids.length;
  const outliers = vids.filter(v => v.multiple > 5).slice(0, 8);
  const breakout = chList
    .map(c => ({ ...c, best: Math.max(0, ...vids.filter(v => v.channelId === c.id).map(v => v.views)), ratio: Math.max(0, ...vids.filter(v => v.channelId === c.id).map(v => v.multiple)) }))
    .sort((a, b) => b.ratio - a.ratio).slice(0, 6);

  // 0-100 score: demand (log-scaled views) + small-channel opportunity + velocity − big-channel saturation
  const demand = clamp(Math.log10(Math.max(avgViews, 1)) / 6.5 * 100, 0, 100);
  const opportunity = clamp((smallWinners.length / Math.max(chList.length, 1)) * 250 + outliers.length * 5, 0, 100);
  const velocity = clamp(Math.log10(Math.max(avgVpd, 1)) / 5 * 100, 0, 100);
  const competition = clamp(bigShare * 100, 0, 100);
  const score = Math.round(clamp(demand * 0.35 + opportunity * 0.3 + velocity * 0.25 - competition * 0.15 + engagement * 300, 1, 99));

  return { kw, format, score, demand: Math.round(demand), opportunity: Math.round(opportunity), velocity: Math.round(velocity), competition: Math.round(competition), engagement, avgViews, medViews, avgVpd, channels: chList.length, smallWinners: smallWinners.length, outliers, breakout, vids: vids.slice(0, 6) };
}

function ScoreGauge({ score }) {
  const numRef = useRef(null), barRef = useRef(null);
  useEffect(() => { animateScore(numRef.current, barRef.current, score); }, [score]);
  const tone = score >= 70 ? "hot" : score >= 45 ? "warm" : "cold";
  return (<div className={`nf-gauge ${tone}`}>
    <div className="nf-gauge-num"><span ref={numRef}>0</span><span className="nf-gauge-max">/100</span></div>
    <div className="nf-gauge-track"><div className="nf-gauge-fill" ref={barRef}/></div>
    <div className="nf-gauge-label">{score >= 70 ? "Hot niche" : score >= 45 ? "Workable" : "Saturated / weak"}</div>
  </div>);
}

export default function NicheFinder({ ytKey, clKey, niches, sn, goNiche }) {
  const [seed, setSeed] = useState("");
  const [kws, setKws] = useState([]);
  const [days, setDays] = useState(90);
  const [region, setRegion] = useState("US");
  const [format, setFormat] = useState("long"); // long-form is the default; shorts available as a filter
  const [results, setResults] = useState({}); // kw -> {status, data|err}
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [st, setSt] = useState("");
  const [verdicts, setVerdicts] = useState({});
  const cancelRef = useRef(false);
  const listRef = useReveal([busy]);

  const addKw = (k) => { const v = (k ?? seed).trim().toLowerCase(); if (v && !kws.includes(v)) setKws(prev => [...prev, v]); setSeed(""); };

  const suggest = async () => {
    if (!clKey) { setSt("⚠ Add your Anthropic key in Settings for AI suggestions"); return; }
    if (!seed.trim()) { setSt("⚠ Type a broad topic first, e.g. “history”, “finance”, “true crime”"); return; }
    setSuggesting(true); setSt("Finding sub-niches...");
    try {
      let arr;
      try { arr = parseJson(await claude(SYS_SUBNICHES, `Broad topic: ${seed.trim()}`, clKey)); }
      catch { arr = parseJson(await claude(SYS_SUBNICHES + `\nCRITICAL: respond with ONLY the raw JSON array — no prose, no markdown, no explanation.`, `Broad topic: ${seed.trim()}`, clKey)); }
      if (!Array.isArray(arr) || !arr.length) throw new Error("No suggestions came back — try a broader topic");
      setKws(prev => [...new Set([...prev, ...arr.map(a => String(a).toLowerCase())])]);
      setSt(`✅ ${arr.length} sub-niches suggested — hit Analyze`);
    } catch (e) { setSt("⚠ " + e.message); }
    setSuggesting(false);
  };

  const analyze = async () => {
    if (!ytKey) { setSt("⚠ Add your YouTube API key in Settings"); return; }
    if (!kws.length) { setSt("⚠ Add at least one keyword"); return; }
    cancelRef.current = false; setBusy(true);
    const done = {};
    for (let i = 0; i < kws.length; i++) {
      if (cancelRef.current) break;
      const kw = kws[i];
      if (results[kw]?.data?.format === format) { done[kw] = results[kw]; continue; }
      setSt(`Analyzing ${i + 1}/${kws.length}: “${kw}”...`);
      setResults(prev => ({ ...prev, [kw]: { status: "loading" } }));
      try {
        const data = await analyzeKeyword(kw, ytKey, { days, region, format });
        done[kw] = { status: "done", data };
        setResults(prev => ({ ...prev, [kw]: done[kw] }));
      } catch (e) {
        setResults(prev => ({ ...prev, [kw]: { status: "error", err: e.message } }));
      }
    }
    setSt("✅ Analysis complete");
    setBusy(false);
    // AI verdicts for everything analyzed (non-blocking)
    const withData = Object.values(done).filter(r => r.data);
    if (clKey && withData.length) {
      try {
        const summary = withData.map(r => `${r.data.kw}: score ${r.data.score}, avg views ${fmt(r.data.avgViews)}, ${r.data.smallWinners} small channels winning, competition ${r.data.competition}%`).join("\n");
        const v = parseJson(await claude(SYS_VERDICT, summary, clKey));
        setVerdicts(prev => ({ ...prev, ...v }));
      } catch {}
    }
  };

  const isSaved = kw => niches.some(n => n.name.toLowerCase() === titleCase(kw).toLowerCase());
  const saveNiche = (r, go) => {
    const name = titleCase(r.kw);
    let n = niches.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!n) {
      n = { id: Date.now(), name, desc: `Niche finder — ${r.format === "shorts" ? "Shorts" : "long-form"} · score ${r.score}/100 · avg ${fmt(r.avgViews)} views · ${r.smallWinners} small channels winning`, channels: r.breakout.slice(0, 4).map(c => c.id), history: [], finder: { score: r.score, format: r.format, date: new Date().toISOString().slice(0, 10) } };
      sn([...niches, n]);
    }
    if (go) goNiche(n);
  };

  return (<div className="yt-page">
    <div className="yt-breadcrumb"><h1 className="yt-page-title">Niche Finder</h1></div>
    <p className="yt-sub">Score niches on live YouTube data before you invest a single video — demand, small-channel opportunity, velocity, and competition. Save winners straight into Research.</p>

    <div className="yt-card">
      <div className="nf-controls">
        <input className="yt-input" placeholder="Type a niche keyword (e.g. ancient rome mysteries) or a broad topic for AI suggestions" value={seed} onChange={e => setSeed(e.target.value)} onKeyDown={e => e.key === "Enter" && addKw()}/>
        <button className="yt-btn-o" onClick={() => addKw()}>+ Add</button>
        <button className={`yt-btn-o ${suggesting ? "yt-btn-ld" : ""}`} onClick={suggest} disabled={suggesting}>{suggesting ? "…" : "AI Sub-niches"}</button>
        <select className="yt-sel" style={{ maxWidth: 130 }} value={format} onChange={e => setFormat(e.target.value)} title="Long-form is the default; switch to analyze the Shorts feed instead"><option value="long">Long-form</option><option value="shorts">Shorts</option></select>
        <select className="yt-sel" style={{ maxWidth: 130 }} value={days} onChange={e => setDays(+e.target.value)}><option value={30}>Last 30d</option><option value={90}>Last 90d</option><option value={180}>Last 180d</option></select>
        <select className="yt-sel" style={{ maxWidth: 100 }} value={region} onChange={e => setRegion(e.target.value)}>{["US", "GB", "CA", "AU", "IN", "DE", "BR", "NG"].map(r => <option key={r}>{r}</option>)}</select>
      </div>
      {kws.length > 0 && <div className="yt-chips" style={{ marginTop: 12 }}>{kws.map((k, i) => <span key={k} className="yt-chip">{k}{results[k]?.data && <b className="nf-chip-score">{results[k].data.score}</b>}<button onClick={() => setKws(kws.filter((_, j) => j !== i))}>✕</button></span>)}</div>}
      {!busy
        ? <button className="yt-btn-big" style={{ marginTop: 14 }} onClick={analyze} disabled={!kws.length}>Analyze {kws.length || ""} Niche{kws.length === 1 ? "" : "s"}</button>
        : <button className="yt-btn-big yt-btn-big-ld" style={{ marginTop: 14 }} onClick={() => { cancelRef.current = true; }}>Stop</button>}
      <p className="yt-hint" style={{ marginTop: 8 }}>Each keyword costs ~102 YouTube API quota units (search 100 + 2 lookups) out of your 10,000/day.</p>
      {st && <p className={`yt-st ${st[0] === "⚠" ? "err" : st[0] === "✅" ? "ok" : ""}`}>{st}</p>}
    </div>

    <div ref={listRef}>
    {kws.filter(k => results[k]).map(kw => {
      const r = results[kw];
      if (r.status === "loading") return <div key={kw} className="yt-card nf-card"><div className="yt-ld-box"><div className="yt-spin"/><p>Scanning “{kw}”...</p></div></div>;
      if (r.status === "error") return <div key={kw} className="yt-card nf-card"><p className="yt-st err">⚠ {kw}: {r.err}</p></div>;
      const d = r.data;
      return (<div key={kw} className="yt-card nf-card">
        <div className="nf-head">
          <div className="nf-head-l">
            <h3 className="nf-kw">{titleCase(d.kw)}<span className="nf-fmt">{d.format === "shorts" ? "Shorts" : "Long-form"}</span></h3>
            {verdicts[d.kw] && <p className="nf-verdict">{verdicts[d.kw]}</p>}
            <div className="nf-stats">
              <span><b>{fmt(d.avgViews)}</b> avg views</span>
              <span><b>{fmt(d.avgVpd)}</b> views/day</span>
              <span><b>{d.channels}</b> channels</span>
              <span><b>{d.smallWinners}</b> small winners</span>
              <span><b>{(d.engagement * 100).toFixed(1)}%</b> engagement</span>
            </div>
            <div className="nf-bars">
              {[["Demand", d.demand], ["Opportunity", d.opportunity], ["Velocity", d.velocity], ["Competition", d.competition, true]].map(([label, v, bad]) => <div key={label} className="nf-bar-row">
                <span className="nf-bar-label">{label}</span>
                <div className="nf-bar-track"><div className={`nf-bar-fill ${bad ? "bad" : ""}`} style={{ width: v + "%" }}/></div>
                <span className="nf-bar-val">{v}</span>
              </div>)}
            </div>
          </div>
          <div className="nf-head-r">
            <ScoreGauge score={d.score}/>
            <div className="yt-btn-row" style={{ flexDirection: "column", gap: 8 }}>
              <button className="yt-btn" onClick={() => saveNiche(d, true)}>Research this niche →</button>
              <button className="yt-btn-o" onClick={() => saveNiche(d, false)} disabled={isSaved(d.kw)}>{isSaved(d.kw) ? "✅ Saved" : "Save niche"}</button>
            </div>
          </div>
        </div>
        {d.outliers.length > 0 && <>
          <div className="nf-sec-t">Outliers — small channels, huge views</div>
          <div className="nf-vids">{d.outliers.slice(0, 4).map(v => <a key={v.id} className="nf-vid" href={`https://youtube.com/watch?v=${v.id}`} target="_blank" rel="noreferrer">
            <img src={v.thumb} alt=""/><span className="nf-vid-mult">{v.multiple.toFixed(0)}x subs</span>
            <div className="nf-vid-t">{v.title}</div>
            <div className="nf-vid-m">{fmt(v.views)} views · {v.channel} ({fmt(v.subs)} subs)</div>
          </a>)}</div>
        </>}
        {d.breakout.length > 0 && <>
          <div className="nf-sec-t">Breakout channels (auto-added as competitors when you save)</div>
          <div className="nf-chans">{d.breakout.map(c => <a key={c.id} className="nf-chan" href={`https://youtube.com/channel/${c.id}`} target="_blank" rel="noreferrer">
            {c.thumb && <img src={c.thumb} alt=""/>}
            <div><div className="nf-chan-n">{c.name}</div><div className="nf-chan-m">{fmt(c.subs)} subs · best video {fmt(c.best)} · {c.ratio.toFixed(0)}x</div></div>
          </a>)}</div>
        </>}
      </div>);
    })}
    </div>
    <style>{NF_CSS}</style>
  </div>);
}

const NF_CSS = `
.nf-controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.nf-controls .yt-input{flex:1;min-width:260px}
.nf-chip-score{background:var(--green);color:#fff;font-size:10px;padding:1px 7px;border-radius:8px;margin-left:2px}
.nf-card{overflow:hidden}
.nf-head{display:flex;gap:24px;justify-content:space-between;flex-wrap:wrap}
.nf-head-l{flex:1;min-width:280px}
.nf-head-r{display:flex;flex-direction:column;gap:14px;align-items:stretch;min-width:210px}
.nf-kw{font-size:20px;font-weight:700;letter-spacing:-.3px;margin-bottom:6px;display:flex;align-items:center;gap:10px}
.nf-fmt{font-size:10.5px;font-weight:600;letter-spacing:.3px;text-transform:uppercase;background:var(--surface2);color:var(--text2);padding:3px 9px;border-radius:9px}
.nf-verdict{font-size:12.5px;color:var(--text2);line-height:1.5;margin-bottom:10px;background:var(--surface);border-left:3px solid var(--blue);padding:8px 12px;border-radius:0 8px 8px 0}
.nf-stats{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--text3);margin-bottom:14px}
.nf-stats b{color:var(--text);font-size:14px;margin-right:4px}
.nf-bars{display:flex;flex-direction:column;gap:7px;max-width:440px}
.nf-bar-row{display:flex;align-items:center;gap:10px}
.nf-bar-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text3);width:86px}
.nf-bar-track{flex:1;height:7px;background:var(--surface2);border-radius:4px;overflow:hidden}
.nf-bar-fill{height:100%;background:var(--blue);border-radius:4px;transition:width 1s cubic-bezier(.16,1,.3,1)}
.nf-bar-fill.bad{background:var(--amber)}
.nf-bar-val{font-size:11px;font-family:var(--mono);color:var(--text2);width:26px;text-align:right}
.nf-gauge{text-align:center;padding:14px 18px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius2)}
.nf-gauge-num{font-size:36px;font-weight:800;letter-spacing:-1px}
.nf-gauge.hot .nf-gauge-num{color:var(--green)}.nf-gauge.cold .nf-gauge-num{color:var(--text3)}.nf-gauge.warm .nf-gauge-num{color:var(--amber)}
.nf-gauge-max{font-size:14px;color:var(--text3);font-weight:600}
.nf-gauge-track{height:6px;background:var(--surface2);border-radius:3px;overflow:hidden;margin:8px 0 6px}
.nf-gauge-fill{height:100%;border-radius:3px;background:var(--green)}
.nf-gauge-label{font-size:11px;color:var(--text2);font-weight:600}
.nf-sec-t{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin:18px 0 10px}
.nf-vids{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
.nf-vid{position:relative;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius2);overflow:hidden;text-decoration:none;color:var(--text);transition:all .2s}
.nf-vid:hover{border-color:var(--border2);box-shadow:var(--shadow2);transform:translateY(-2px)}
.nf-vid img{width:100%;aspect-ratio:16/9;object-fit:cover;display:block}
.nf-vid-mult{position:absolute;top:6px;right:6px;background:var(--red);color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:6px}
.nf-vid-t{font-size:12px;font-weight:600;padding:8px 10px 2px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.nf-vid-m{font-size:10.5px;color:var(--text3);padding:2px 10px 10px}
.nf-chans{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}
.nf-chan{display:flex;gap:10px;align-items:center;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius2);padding:10px 12px;text-decoration:none;color:var(--text);transition:all .2s}
.nf-chan:hover{border-color:var(--blue)}
.nf-chan img{width:36px;height:36px;border-radius:50%}
.nf-chan-n{font-size:13px;font-weight:600}
.nf-chan-m{font-size:11px;color:var(--text3)}
`;
