// Tier-1 renderer spike: storyboard JSON → finished MP4, pure FFmpeg (no browser).
// Proves our whole long-form feature set server-side: Ken Burns on stills, real clips
// normalized in, crossfades, word-timed karaoke captions (ASS \k tags), voiceover + ducked
// music mix. This is the "fast path" that will render the body of every video.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ffmpeg = process.env.FFMPEG_PATH || "/usr/local/lib/python3.11/dist-packages/imageio_ffmpeg/binaries/ffmpeg-linux-x86_64-v7.0.2";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "assets");
const out = path.join(here, "out");
mkdirSync(out, { recursive: true });

const sb = JSON.parse(readFileSync(path.join(here, "storyboard.json"), "utf8"));
const { width: W, height: H, fps: FPS } = sb;
const FADE = 0.25; // crossfade length, like the app's 0.18-0.25s

// ---------- ASS karaoke subtitles (word-timed, accent on the active word) ----------
const assTime = (s) => {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000), m = Math.floor(cs % 360000 / 6000), sec = Math.floor(cs % 6000 / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
function buildAss(shots, accent = "#ffd734") {
  // ASS colors are &HBBGGRR&
  const hex = accent.replace("#", "");
  const bgr = `&H00${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`.toUpperCase();
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Karaoke,DejaVu Sans,${Math.round(H * 0.045)},&H00FFFFFF,${bgr},&H00101010,&H88000000,-1,0,0,0,100,100,0,0,1,2,1,2,40,40,${Math.round(H * 0.06)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  // One dialogue line per shot; \k durations in centiseconds per word (karaoke fill = accent).
  const lines = shots.filter(s => s.words?.length).map(s => {
    const t0 = s.words[0].start;
    const parts = s.words.map((w, i) => {
      const durCs = Math.max(1, Math.round((w.end - w.start) * 100));
      const gap = i === 0 ? 0 : Math.max(0, Math.round((w.start - s.words[i - 1].end) * 100));
      return (gap ? `{\\k${gap}}` : "") + `{\\k${durCs}}${w.word} `;
    }).join("");
    return `Dialogue: 0,${assTime(t0)},${assTime(s.words[s.words.length - 1].end + 0.15)},Karaoke,,0,0,0,,${parts.trim()}`;
  });
  return header + lines.join("\n") + "\n";
}
const assPath = path.join(out, "subs.ass");
writeFileSync(assPath, buildAss(sb.shots, sb.brand?.accent));

// ---------- filtergraph: per-shot normalize (Ken Burns for stills), xfade chain, subs ----------
const inputs = [];
const filters = [];
sb.shots.forEach((s, i) => {
  const dur = s.duration + (i < sb.shots.length - 1 ? FADE : 0); // headroom for the crossfade
  const frames = Math.ceil(dur * FPS);
  if (s.kind === "photo") {
    inputs.push("-loop", "1", "-t", dur.toFixed(3), "-i", path.join(assets, s.asset));
    const zoomIn = i % 2 === 0; // alternate in/out like the app
    const z = zoomIn ? `1+0.09*on/${frames}` : `1.09-0.09*on/${frames}`;
    filters.push(
      `[${i}:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},` +
      `zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},` +
      `settb=AVTB,setsar=1,format=yuv420p[v${i}]`);
  } else {
    inputs.push("-stream_loop", "-1", "-t", dur.toFixed(3), "-i", path.join(assets, s.asset));
    filters.push(
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},` +
      `trim=duration=${dur.toFixed(3)},settb=AVTB,setsar=1,format=yuv420p[v${i}]`);
  }
});
// xfade chain. Inputs carry a FADE-length padding tail, so each fade occupies
// boundary..boundary+FADE and the merged timeline stays exactly Σ durations —
// offsets are therefore the plain cumulative shot durations (no fade subtraction),
// which keeps video locked to the voiceover timeline with zero drift.
let label = "v0";
let offset = 0;
for (let i = 1; i < sb.shots.length; i++) {
  offset += sb.shots[i - 1].duration;
  const next = i === sb.shots.length - 1 ? "vx" : `x${i}`;
  filters.push(`[${label}][v${i}]xfade=transition=fade:duration=${FADE}:offset=${offset.toFixed(3)}[${next}]`);
  label = next;
}
if (sb.shots.length === 1) { filters.push(`[v0]null[vx]`); }
// subtitles burn-in (escape the path for the filter arg)
const assEsc = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");
filters.push(`[vx]ass='${assEsc}'[vfinal]`);

// audio: voiceover + ducked music, faded out at the end
const total = sb.shots[sb.shots.length - 1].start + sb.shots[sb.shots.length - 1].duration;
const vIdx = sb.shots.length, mIdx = sb.shots.length + 1;
inputs.push("-i", path.join(assets, "voice.wav"));
inputs.push("-stream_loop", "-1", "-t", (total + 1).toFixed(3), "-i", path.join(assets, "music.wav"));
filters.push(`[${vIdx}:a]aresample=48000,pan=stereo|c0=c0|c1=c0,atrim=duration=${total.toFixed(3)}[va]`);
filters.push(`[${mIdx}:a]aresample=48000,pan=stereo|c0=c0|c1=c0,volume=0.12,afade=t=out:st=${(total - 2).toFixed(3)}:d=2,atrim=duration=${total.toFixed(3)}[ma]`);
filters.push(`[va][ma]amix=inputs=2:duration=first:normalize=0[afinal]`);

const args = [
  "-y", "-hide_banner", "-loglevel", "error", "-stats",
  ...inputs,
  "-filter_complex", filters.join(";"),
  "-map", "[vfinal]", "-map", "[afinal]",
  "-t", total.toFixed(3),
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "160k",
  "-movflags", "+faststart",
  path.join(out, "body.mp4"),
];
console.log("rendering body.mp4 …");
const t0 = Date.now();
execFileSync(ffmpeg, args, { stdio: ["ignore", "inherit", "inherit"] });
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s → spike/out/body.mp4 (${total.toFixed(1)}s of video)`);
