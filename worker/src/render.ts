// VENDORED from app-live/lib/engine/render.ts — regenerate with: npm run sync:engine. Do not edit here.
// VidRush engine — tier-1 FFmpeg renderer, ported server-side from the proven spike.
// Storyboard (+ resolved assets + voiceover) → finished MP4. Ken Burns on stills, real
// clips normalized in, drift-free xfade crossfades, word-timed karaoke captions (ASS \k),
// and a ducked voiceover+music mix. Assets that are remote URLs are downloaded first;
// assets that are missing or fail to download fall back to a clean solid-accent card
// (no text — the studio's "no card clutter" rule) so a render never hard-fails.
import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

const FADE = 0.25 // crossfade length, matching the studio's 0.18–0.25s

export interface RenderShot {
  narration?: string
  kind: 'photo' | 'video'
  /** Local path or http(s) URL of the resolved asset for this shot. */
  src?: string
  start: number
  duration: number
  words?: { word: string; start: number; end: number }[]
}

export interface RenderInput {
  width: number
  height: number
  fps: number
  brand?: { channel?: string; accent?: string }
  shots: RenderShot[]
  /** Local path or URL of the voiceover track (wav/mp3). Optional. */
  voice?: string
  /** Local path or URL of a background music bed. Optional. */
  music?: string
}

export interface RenderResult {
  outPath: string
  totalSeconds: number
  shots: number
  hadVoice: boolean
  hadMusic: boolean
  fallbacks: number
}

function ffmpegBin(): string {
  return process.env.FFMPEG_PATH || 'ffmpeg'
}

const assTime = (s: number) => {
  const cs = Math.max(0, Math.round(s * 100))
  const h = Math.floor(cs / 360000)
  const m = Math.floor((cs % 360000) / 6000)
  const sec = Math.floor((cs % 6000) / 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}

function buildAss(input: RenderInput, accent = '#ffd734'): string {
  const { width: W, height: H, shots } = input
  const hex = accent.replace('#', '')
  const bgr = `&H00${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}`.toUpperCase()
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
`
  const lines = shots
    .filter(s => s.words?.length)
    .map(s => {
      const words = s.words!
      const t0 = words[0].start
      const parts = words
        .map((w, i) => {
          const durCs = Math.max(1, Math.round((w.end - w.start) * 100))
          const gap =
            i === 0 ? 0 : Math.max(0, Math.round((w.start - words[i - 1].end) * 100))
          return (gap ? `{\\k${gap}}` : '') + `{\\k${durCs}}${w.word} `
        })
        .join('')
      return `Dialogue: 0,${assTime(t0)},${assTime(words[words.length - 1].end + 0.15)},Karaoke,,0,0,0,,${parts.trim()}`
    })
  return header + lines.join('\n') + '\n'
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'VidRushLive/1.0 (+render)' }
  })
  if (!res.ok || !res.body) throw new Error(`download ${res.status}`)
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest))
}

// Resolve each shot's asset to a local file, downloading URLs and substituting a clean
// solid-accent card when the asset is absent or unfetchable. Cards are stills.
async function materializeAssets(
  input: RenderInput,
  workDir: string
): Promise<{ localShots: (RenderShot & { asset: string })[]; fallbacks: number }> {
  const accent = input.brand?.accent || '#101018'
  let fallbacks = 0
  const localShots = await Promise.all(
    input.shots.map(async (s, i) => {
      const isUrl = !!s.src && /^https?:\/\//i.test(s.src)
      if (s.src) {
        try {
          if (isUrl) {
            const ext =
              (s.src.split('?')[0].match(/\.(mp4|webm|ogv|mov|m4v|jpg|jpeg|png|gif|webp)$/i)?.[1] ||
                (s.kind === 'video' ? 'mp4' : 'jpg')).toLowerCase()
            const dest = path.join(workDir, `asset${i}.${ext}`)
            await download(s.src, dest)
            return { ...s, asset: dest }
          }
          return { ...s, asset: s.src }
        } catch {
          /* fall through to card */
        }
      }
      // Clean fallback card: a solid accent frame, rendered as a still.
      fallbacks++
      const card = path.join(workDir, `card${i}.png`)
      await execFileP(ffmpegBin(), [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=c=${accent.replace('#', '0x')}:s=${input.width}x${input.height}`,
        '-frames:v',
        '1',
        card
      ])
      return { ...s, kind: 'photo' as const, asset: card }
    })
  )
  return { localShots, fallbacks }
}

// Render the storyboard to an MP4. Returns the output path and timeline metadata.
export async function renderStoryboard(
  input: RenderInput,
  opts: { outPath?: string; workDir?: string } = {}
): Promise<RenderResult> {
  if (!input.shots.length) throw new Error('no shots to render')
  const { width: W, height: H, fps: FPS } = input
  const workDir =
    opts.workDir || path.join(os.tmpdir(), `vidrush-render-${Date.now()}`)
  // Always ensure the work dir exists — the caller may pass a path that isn't created yet.
  await mkdir(workDir, { recursive: true })
  const outPath = opts.outPath || path.join(workDir, 'output.mp4')

  const { localShots, fallbacks } = await materializeAssets(input, workDir)

  const assPath = path.join(workDir, 'subs.ass')
  await writeFile(assPath, buildAss(input, input.brand?.accent))

  const inputs: string[] = []
  const filters: string[] = []
  localShots.forEach((s, i) => {
    const dur = s.duration + (i < localShots.length - 1 ? FADE : 0)
    const frames = Math.ceil(dur * FPS)
    if (s.kind === 'photo') {
      inputs.push('-loop', '1', '-t', dur.toFixed(3), '-i', s.asset)
      const zoomIn = i % 2 === 0
      const z = zoomIn ? `1+0.09*on/${frames}` : `1.09-0.09*on/${frames}`
      filters.push(
        `[${i}:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},` +
          `zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},` +
          `settb=AVTB,setsar=1,format=yuv420p[v${i}]`
      )
    } else {
      inputs.push('-stream_loop', '-1', '-t', dur.toFixed(3), '-i', s.asset)
      filters.push(
        `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},` +
          `trim=duration=${dur.toFixed(3)},settb=AVTB,setsar=1,format=yuv420p[v${i}]`
      )
    }
  })

  // Drift-free xfade chain: inputs carry a FADE-length tail, offsets are cumulative
  // shot durations, so the merged timeline is exactly Σ durations (locks to the VO).
  let label = 'v0'
  let offset = 0
  for (let i = 1; i < localShots.length; i++) {
    offset += localShots[i - 1].duration
    const next = i === localShots.length - 1 ? 'vx' : `x${i}`
    filters.push(
      `[${label}][v${i}]xfade=transition=fade:duration=${FADE}:offset=${offset.toFixed(3)}[${next}]`
    )
    label = next
  }
  if (localShots.length === 1) filters.push(`[v0]null[vx]`)

  const assEsc = assPath.replace(/\\/g, '/').replace(/:/g, '\\:')
  filters.push(`[vx]ass='${assEsc}'[vfinal]`)

  const last = localShots[localShots.length - 1]
  const total = last.start + last.duration

  // Audio: build a voiceover+music mix when tracks are provided; otherwise silent.
  const hadVoice = !!input.voice
  const hadMusic = !!input.music
  let audioMapLabel = ''
  const extraAudioInputs: string[] = []
  const audioFilters: string[] = []

  const localVoice = hadVoice ? await ensureLocal(input.voice!, workDir, 'voice') : ''
  const localMusic = hadMusic ? await ensureLocal(input.music!, workDir, 'music') : ''

  if (localVoice || localMusic) {
    const mixLabels: string[] = []
    // Audio inputs are appended after the localShots.length video inputs, so their
    // ffmpeg input index is base + how many audio inputs we have added so far.
    let audioInputCount = 0
    if (localVoice) {
      const idx = localShots.length + audioInputCount++
      extraAudioInputs.push('-i', localVoice)
      audioFilters.push(
        `[${idx}:a]aresample=48000,pan=stereo|c0=c0|c1=c0,atrim=duration=${total.toFixed(3)}[va]`
      )
      mixLabels.push('[va]')
    }
    if (localMusic) {
      const idx = localShots.length + audioInputCount++
      extraAudioInputs.push('-stream_loop', '-1', '-t', (total + 1).toFixed(3), '-i', localMusic)
      const vol = localVoice ? 0.12 : 0.5
      audioFilters.push(
        `[${idx}:a]aresample=48000,pan=stereo|c0=c0|c1=c0,volume=${vol},afade=t=out:st=${Math.max(0, total - 2).toFixed(3)}:d=2,atrim=duration=${total.toFixed(3)}[ma]`
      )
      mixLabels.push('[ma]')
    }
    if (mixLabels.length === 2) {
      audioFilters.push(`${mixLabels.join('')}amix=inputs=2:duration=first:normalize=0[afinal]`)
      audioMapLabel = '[afinal]'
    } else {
      audioMapLabel = mixLabels[0] === '[va]' ? '[va]' : '[ma]'
    }
  }

  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    ...inputs,
    ...extraAudioInputs,
    '-filter_complex',
    [...filters, ...audioFilters].join(';'),
    '-map',
    '[vfinal]',
    ...(audioMapLabel ? ['-map', audioMapLabel] : []),
    '-t',
    total.toFixed(3),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    ...(audioMapLabel ? ['-c:a', 'aac', '-b:a', '160k'] : []),
    '-movflags',
    '+faststart',
    outPath
  ]

  await execFileP(ffmpegBin(), args, { maxBuffer: 1 << 26 })

  return {
    outPath,
    totalSeconds: +total.toFixed(2),
    shots: localShots.length,
    hadVoice: !!localVoice,
    hadMusic: !!localMusic,
    fallbacks
  }
}

async function ensureLocal(src: string, workDir: string, name: string): Promise<string> {
  if (!/^https?:\/\//i.test(src)) return src
  const ext = src.split('?')[0].match(/\.(wav|mp3|m4a|aac|ogg)$/i)?.[1] || 'mp3'
  const dest = path.join(workDir, `${name}.${ext.toLowerCase()}`)
  try {
    await download(src, dest)
    return dest
  } catch {
    return ''
  }
}

// Structural shape of a cutBeats storyboard — declared locally (not imported from
// ./beats) so this module stays fully self-contained and can be copied verbatim into
// the standalone render worker's build.
export interface StoryboardLike {
  width: number
  height: number
  fps: number
  brand?: { channel?: string; accent?: string }
  shots: {
    narration?: string
    kind: 'photo' | 'video'
    start: number
    duration: number
    words?: { word: string; start: number; end: number }[]
  }[]
}

// Convenience: render straight from a cutBeats storyboard by binding a src onto each
// shot (e.g. the vision-verified pick from sourceFootage keyed by shot index).
export async function renderFromStoryboard(
  storyboard: StoryboardLike,
  assetSrcByShot: (string | undefined)[],
  opts: { voice?: string; music?: string; outPath?: string; workDir?: string } = {}
): Promise<RenderResult> {
  const shots: RenderShot[] = storyboard.shots.map((s, i) => ({
    narration: s.narration,
    kind: s.kind,
    src: assetSrcByShot[i],
    start: s.start,
    duration: s.duration,
    words: s.words
  }))
  return renderStoryboard(
    {
      width: storyboard.width,
      height: storyboard.height,
      fps: storyboard.fps,
      brand: storyboard.brand,
      shots,
      voice: opts.voice,
      music: opts.music
    },
    { outPath: opts.outPath, workDir: opts.workDir }
  )
}
