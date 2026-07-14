// Smoke test: drive the ported render engine (lib/engine/render.ts) with the spike's
// proven storyboard + assets and confirm it produces a playable MP4 with audio.
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { renderStoryboard, type RenderShot } from '../lib/engine/render'

const spike = path.resolve(process.cwd(), '../spike')
const sb = JSON.parse(readFileSync(path.join(spike, 'storyboard.json'), 'utf8'))
const assets = path.join(spike, 'assets')

const shots: RenderShot[] = sb.shots.map((s: any) => ({
  narration: s.narration,
  kind: s.kind,
  src: path.join(assets, s.asset),
  start: s.start,
  duration: s.duration,
  words: s.words
}))

const outPath = path.resolve(process.cwd(), 'scripts/smoke-out.mp4')

const res = await renderStoryboard(
  {
    width: sb.width,
    height: sb.height,
    fps: sb.fps,
    brand: sb.brand,
    shots,
    voice: path.join(assets, 'voice.wav'),
    music: path.join(assets, 'music.wav')
  },
  { outPath }
)

console.log('RENDER RESULT:', JSON.stringify(res, null, 2))
