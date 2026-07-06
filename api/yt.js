// Production YouTube download engine (Vercel Node serverless function).
// YouTube blocks direct downloads from datacenter IPs (like Vercel's), so a bundled yt-dlp
// isn't reliable here. Instead we call a cobalt instance server-side — the current best-maintained
// extractor — and stream the resulting MP4 back same-origin. Configure it with env vars:
//   COBALT_API_URL  – your cobalt instance base URL (self-host via Docker, or a trusted instance)
//   COBALT_API_KEY  – optional, if the instance requires `Api-Key` auth
// Dev/preview keep using the local yt-dlp middleware (server/ytproxy.js); this only runs on Vercel.
import { Readable } from "node:stream";

export default async function handler(req, res) {
  const id = new URL(req.url, "http://x").searchParams.get("id") || "";
  const send = (code, obj) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };
  if (!/^[\w-]{11}$/.test(id)) return send(400, { error: "bad video id" });

  const base = (process.env.COBALT_API_URL || "").replace(/\/$/, "");
  if (!base) return send(501, {
    error: "no_extractor",
    hint: "YouTube downloads on the live site need a cobalt extractor. Set COBALT_API_URL (and COBALT_API_KEY if required) in your Vercel project env — see the README.",
  });

  try {
    const api = await fetch(base, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(process.env.COBALT_API_KEY ? { Authorization: `Api-Key ${process.env.COBALT_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        url: `https://www.youtube.com/watch?v=${id}`,
        videoQuality: "480",            // small file — b-roll clips don't need 1080p
        youtubeVideoCodec: "h264",      // browser-playable
        filenameStyle: "basic",
        downloadMode: "auto",
      }),
    });
    const data = await api.json().catch(() => ({}));
    let mediaUrl = null;
    if ((data.status === "tunnel" || data.status === "redirect") && data.url) mediaUrl = data.url;
    else if (data.status === "picker" && Array.isArray(data.picker)) mediaUrl = (data.picker.find(p => p.type === "video") || data.picker[0])?.url;
    if (!mediaUrl) return send(502, { error: data.error?.code || data.status || "extractor_failed", hint: "The cobalt instance couldn't return this video." });

    const media = await fetch(mediaUrl);
    if (!media.ok || !media.body) return send(502, { error: `media ${media.status}` });
    res.statusCode = 200;
    res.setHeader("content-type", "video/mp4");
    res.setHeader("content-disposition", `inline; filename="${id}.mp4"`);
    Readable.fromWeb(media.body).pipe(res);
  } catch (e) {
    send(502, { error: "extractor request failed: " + e.message });
  }
}
