import { useState } from "react";

// Shared SEO display — used by the Studio package step and the Dashboard SEO board.
export function SeoView({ seo, compact }) {
  const [cp, setCp] = useState("");
  const copy = (t, l) => { navigator.clipboard.writeText(t); setCp(l); setTimeout(() => setCp(""), 1500); };
  return (<>
    <div className="yt-opt-section"><div className="yt-opt-h"><span className="yt-opt-label">Titles</span><button className="yt-btn-cp-sm" onClick={() => copy((seo.titles || []).join("\n"), "ts")}>{cp === "ts" ? "✅" : "Copy"}</button></div>
      {(seo.titles || []).map((t, i) => <div key={i} className="yt-opt-title" onClick={() => copy(t, "t" + i)}><span className="yt-opt-num">{i + 1}</span><span>{t}</span>{cp === "t" + i && <span className="yt-opt-copied">✅</span>}</div>)}</div>
    <div className="yt-opt-section"><div className="yt-opt-h"><span className="yt-opt-label">Description</span><button className="yt-btn-cp-sm" onClick={() => copy(seo.description || "", "d")}>{cp === "d" ? "✅" : "Copy"}</button></div>
      <pre className="yt-pre yt-pre-sm">{seo.description}</pre></div>
    {(seo.chapters || []).length > 0 && <div className="yt-opt-section"><div className="yt-opt-h"><span className="yt-opt-label">Chapters</span><button className="yt-btn-cp-sm" onClick={() => copy(seo.chapters.join("\n"), "c")}>{cp === "c" ? "✅" : "Copy"}</button></div>
      <pre className="yt-pre yt-pre-sm">{seo.chapters.join("\n")}</pre></div>}
    <div className="yt-opt-section"><div className="yt-opt-h"><span className="yt-opt-label">Tags</span><button className="yt-btn-cp-sm" onClick={() => copy((seo.tags || []).join(", "), "g")}>{cp === "g" ? "✅" : "Copy"}</button></div>
      <div className="yt-opt-tags">{(seo.tags || []).map((t, i) => <span key={i} className="yt-opt-tag" onClick={() => copy(t, "g" + i)}>{t}</span>)}</div></div>
    {seo.pinnedComment && <div className="yt-opt-section"><div className="yt-opt-h"><span className="yt-opt-label">Pinned Comment</span><button className="yt-btn-cp-sm" onClick={() => copy(seo.pinnedComment, "p")}>{cp === "p" ? "✅" : "Copy"}</button></div><pre className="yt-pre yt-pre-sm">{seo.pinnedComment}</pre></div>}
    {(seo.credits || []).length > 0 && !compact && <div className="yt-opt-section"><div className="yt-opt-h"><span className="yt-opt-label">Attribution</span><button className="yt-btn-cp-sm" onClick={() => copy(seo.credits.join("\n"), "cr")}>{cp === "cr" ? "✅" : "Copy"}</button></div><pre className="yt-pre yt-pre-sm">{seo.credits.join("\n")}</pre></div>}
  </>);
}
