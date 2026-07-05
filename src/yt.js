// YouTube helpers. Analysis no longer needs a download — Gemini reads YouTube URLs directly.
// When an actual file IS needed, the local server engine (/api/yt, powered by yt-dlp) does it.

export function ytId(input) {
  const s = (input || "").trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtube\.com\/(?:watch\?[^#]*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

// Download a YouTube video to a File via the local yt-dlp server engine (dev/preview only).
export async function fetchYouTubeVideo(input, { onStatus } = {}) {
  const id = ytId(input);
  if (!id) throw new Error("That doesn't look like a YouTube link or video id");
  if (onStatus) onStatus("Downloading via yt-dlp…");
  const r = await fetch(`/api/yt?id=${id}`);
  if (!r.ok) {
    let detail = "";
    try { const d = await r.json(); detail = (d.hint ? d.hint + " " : "") + (d.attempts || []).slice(0, 2).join(" · "); } catch {}
    throw new Error(detail || `download failed (HTTP ${r.status})`);
  }
  const total = +r.headers.get("content-length") || 0;
  const reader = r.body.getReader();
  const chunks = []; let recv = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); recv += value.length;
    if (onStatus) onStatus(`Downloading — ${(recv / 1048576).toFixed(1)}MB${total ? ` of ${(total / 1048576).toFixed(1)}MB` : ""}`);
  }
  if (recv < 50 * 1024) throw new Error("download came back empty");
  return { file: new File([new Blob(chunks, { type: "video/mp4" })], `${id}.mp4`, { type: "video/mp4" }), title: id, via: "yt-dlp" };
}
