import { tool } from 'ai'
import { z } from 'zod'

import { kvGetJSON } from '@/lib/engine/kv'
import { renderStoryboard, type RenderInput, type RenderShot } from '@/lib/engine/render'
import type { VoiceoverHandle } from './generate-voiceover'

const shotSchema = z.object({
  kind: z.enum(['photo', 'video']),
  src: z
    .string()
    .optional()
    .describe(
      'Local path or http(s) URL of the resolved asset (the vision-verified pick from sourceFootage). Omit to render a clean brand card for this shot.'
    ),
  start: z.number().describe('Shot start time in seconds'),
  duration: z.number().describe('Shot duration in seconds'),
  narration: z.string().optional(),
  words: z
    .array(
      z.object({
        word: z.string(),
        start: z.number(),
        end: z.number()
      })
    )
    .optional()
    .describe('Word-level caption timings (from cutBeats)')
})

const composeRenderSchema = z.object({
  width: z.number().optional().describe('Frame width (default 1280)'),
  height: z.number().optional().describe('Frame height (default 720)'),
  fps: z.number().optional().describe('Frames per second (default 30)'),
  accent: z
    .string()
    .optional()
    .describe('Brand accent color #rrggbb for captions and fallback cards'),
  channel: z.string().optional(),
  shots: z
    .array(shotSchema)
    .min(1)
    .describe('The storyboard shots with resolved assets and timings'),
  voice: z
    .string()
    .optional()
    .describe('Local path or URL of the voiceover track (wav/mp3)'),
  voiceoverId: z
    .string()
    .optional()
    .describe(
      'Voiceover handle from generateVoiceover — its audio is mixed in automatically (preferred over passing voice directly)'
    ),
  music: z
    .string()
    .optional()
    .describe('Local path or URL of a background music bed')
})

// Render a storyboard (shots + assets + optional voiceover/music) into a finished MP4
// using the tier-1 FFmpeg pipeline: Ken Burns on stills, crossfades, word-timed karaoke
// captions, ducked audio. Run after cutBeats + sourceFootage have populated the shots.
export function createComposeRenderTool() {
  return tool({
    description:
      'Render a storyboard into a finished MP4. Takes the shots (with resolved footage assets and word-timed captions from cutBeats/sourceFootage) plus an optional voiceover and music bed, and produces video with Ken Burns motion, crossfades, karaoke captions and a ducked audio mix. Shots without an asset render as clean brand cards.',
    inputSchema: composeRenderSchema,
    execute: async input => {
      const shots: RenderShot[] = input.shots.map(s => ({
        kind: s.kind,
        src: s.src,
        start: s.start,
        duration: s.duration,
        narration: s.narration,
        words: s.words
      }))
      // Resolve the voiceover: an explicit `voice` URL wins; otherwise pull the audio
      // URL from the voiceover handle so the agent only threads the small id.
      let voice = input.voice
      if (!voice && input.voiceoverId) {
        const handle = await kvGetJSON<VoiceoverHandle>(
          `voiceover:${input.voiceoverId}`
        )
        voice = handle?.audioUrl
      }
      const renderInput: RenderInput = {
        width: input.width ?? 1280,
        height: input.height ?? 720,
        fps: input.fps ?? 30,
        brand: { channel: input.channel, accent: input.accent },
        shots,
        voice,
        music: input.music
      }

      // Production path: offload to the Fly.io render worker (Vercel serverless has no
      // ffmpeg). The worker renders, uploads to object storage, and returns a URL.
      const workerUrl = process.env.RENDER_WORKER_URL
      if (workerUrl) {
        const res = await fetch(`${workerUrl.replace(/\/$/, '')}/render`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(process.env.RENDER_WORKER_TOKEN
              ? { authorization: `Bearer ${process.env.RENDER_WORKER_TOKEN}` }
              : {})
          },
          body: JSON.stringify({ input: renderInput })
        })
        if (!res.ok) {
          const msg = await res.text().catch(() => '')
          throw new Error(`render worker ${res.status}: ${msg.slice(0, 300)}`)
        }
        const out = await res.json()
        return {
          state: 'complete' as const,
          videoUrl: out.url as string | undefined,
          outPath: undefined as string | undefined,
          totalSeconds: out.totalSeconds as number,
          shots: out.shots as number,
          hadVoice: !!out.hadVoice,
          hadMusic: !!out.hadMusic,
          fallbacks: (out.fallbacks as number) ?? 0
        }
      }

      // Dev/local fallback: render inline when ffmpeg is available on the host.
      const result = await renderStoryboard(renderInput)
      return {
        state: 'complete' as const,
        videoUrl: undefined as string | undefined,
        outPath: result.outPath,
        totalSeconds: result.totalSeconds,
        shots: result.shots,
        hadVoice: result.hadVoice,
        hadMusic: result.hadMusic,
        fallbacks: result.fallbacks
      }
    }
  })
}
