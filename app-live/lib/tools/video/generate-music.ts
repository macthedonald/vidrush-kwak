import { tool } from 'ai'
import { z } from 'zod'

import { generateMusic } from '@/lib/engine/music'

const musicSchema = z.object({
  prompt: z
    .string()
    .describe(
      'Describe the music bed — mood, genre, tempo, instruments (e.g. "tense cinematic documentary underscore, low strings, slow build")'
    ),
  instrumental: z
    .boolean()
    .optional()
    .describe('Instrumental only (default true — recommended under narration)')
})

// Generate a background music bed (AI33 / Suno). The returned audioUrl plugs into
// composeRender's `music` input as a ducked bed under the voiceover.
export function createGenerateMusicTool() {
  return tool({
    description:
      'Generate a background music bed from a text prompt (via AI33/Suno). Returns an audio URL you can pass as composeRender\'s `music` input; it is ducked automatically under the voiceover. Instrumental by default.',
    inputSchema: musicSchema,
    execute: async ({ prompt, instrumental }, { abortSignal }) => {
      const workerUrl = process.env.RENDER_WORKER_URL
      if (workerUrl) {
        const res = await fetch(`${workerUrl.replace(/\/$/, '')}/music`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(process.env.RENDER_WORKER_TOKEN
              ? { authorization: `Bearer ${process.env.RENDER_WORKER_TOKEN}` }
              : {})
          },
          body: JSON.stringify({ prompt, instrumental }),
          signal: abortSignal
        })
        if (!res.ok) {
          const msg = await res.text().catch(() => '')
          throw new Error(`music worker ${res.status}: ${msg.slice(0, 300)}`)
        }
        const out = await res.json()
        return {
          state: 'complete' as const,
          audioUrl: out.audioUrl as string,
          title: (out.title as string) || 'Music bed',
          durationSec: out.durationSec as number | undefined
        }
      }
      // Dev fallback: call AI33 directly (long Suno poll — prefer the worker in prod).
      const music = await generateMusic(prompt, { instrumental, abortSignal })
      return {
        state: 'complete' as const,
        audioUrl: music.audioUrl,
        title: music.title,
        durationSec: music.durationSec
      }
    }
  })
}
