// Generate synthetic test assets for the render spike — text-free frames, one motion clip,
// a "voiceover" sweep and a quiet music bed. In production these come from the real pipeline
// (Gathos frames, sourced clips, TTS PCM); this only exercises the render mechanics.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ffmpeg = process.env.FFMPEG_PATH || "/usr/local/lib/python3.11/dist-packages/imageio_ffmpeg/binaries/ffmpeg-linux-x86_64-v7.0.2";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "assets");
mkdirSync(assets, { recursive: true });

const run = (args) => execFileSync(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: ["ignore", "inherit", "inherit"] });

// Three distinct text-free gradient frames (oversized for Ken Burns headroom).
const grads = [
  "gradients=s=1920x1080:c0=#1a2a6c:c1=#b21f1f:c2=#fdbb2d:nb_colors=3:seed=7",
  "gradients=s=1920x1080:c0=#0f2027:c1=#203a43:c2=#2c5364:nb_colors=3:seed=21",
  "gradients=s=1920x1080:c0=#42275a:c1=#734b6d:nb_colors=2:seed=42",
];
grads.forEach((g, i) => run(["-f", "lavfi", "-i", g, "-frames:v", "1", path.join(assets, `frame${i + 1}.png`)]));

// One real motion clip (mandelbrot zoom — organic, text-free), 4s 1280x720@30 h264.
run(["-f", "lavfi", "-i", "mandelbrot=s=1280x720:rate=30", "-t", "4",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(assets, "clip1.mp4")]);

// "Voiceover": a gentle sine sweep, 15s mono 24k. "Music": quiet low drone, 20s.
run(["-f", "lavfi", "-i", "sine=frequency=440:beep_factor=4:duration=15:sample_rate=24000", path.join(assets, "voice.wav")]);
run(["-f", "lavfi", "-i", "sine=frequency=110:duration=20:sample_rate=44100", path.join(assets, "music.wav")]);

console.log("assets ready in", assets);
