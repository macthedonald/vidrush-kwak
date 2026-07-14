// Smoke test 2: exercise the new branches — a shot with no asset (clean fallback card)
// and a render with NO audio tracks (video-only output).
import path from 'node:path'

import { renderStoryboard, type RenderShot } from '../lib/engine/render'

const shots: RenderShot[] = [
  {
    kind: 'photo',
    src: undefined, // → fallback brand card
    start: 0,
    duration: 2,
    words: [
      { word: 'Clean', start: 0.0, end: 0.8 },
      { word: 'card.', start: 0.8, end: 1.8 }
    ]
  },
  {
    kind: 'photo',
    src: undefined, // second fallback card
    start: 2,
    duration: 2,
    words: [
      { word: 'No', start: 2.0, end: 2.6 },
      { word: 'audio.', start: 2.6, end: 3.8 }
    ]
  }
]

const outPath = path.resolve(process.cwd(), 'scripts/smoke-fallback.mp4')
const res = await renderStoryboard(
  {
    width: 640,
    height: 360,
    fps: 24,
    brand: { channel: 'VidRush', accent: '#2d6cff' },
    shots
    // no voice, no music → silent
  },
  { outPath }
)
console.log('FALLBACK RESULT:', JSON.stringify(res, null, 2))
