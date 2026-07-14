import { tool } from 'ai'
import { z } from 'zod'

import { cutScriptIntoBeats } from '@/lib/engine/beats'
import { kvGetJSON } from '@/lib/engine/kv'
import type { VoiceoverHandle } from './generate-voiceover'

const cutBeatsSchema = z.object({
  script: z
    .string()
    .describe('The clean narration script to segment (the output of writeScript)'),
  topic: z.string().optional().describe('Working title / topic, for context'),
  format: z
    .enum(['16:9', '9:16', '1:1'])
    .optional()
    .describe('Aspect ratio (default 16:9 for long-form, 9:16 for shorts)'),
  channel: z.string().optional().describe('Channel name for the brand card'),
  accent: z
    .string()
    .optional()
    .describe('Brand accent color as #rrggbb for the karaoke caption fill'),
  voiceoverId: z
    .string()
    .optional()
    .describe(
      'Voiceover handle from generateVoiceover — when provided, shots lock to the real spoken word timings instead of estimates'
    )
})

// Segment a narration script into a timed storyboard of shots, each with a footage
// search query and intent. This is the bridge between writeScript and sourceFootage:
// run cutBeats on the script, then sourceFootage on each shot's visualQuery/visualIntent.
export function createCutBeatsTool(model: string) {
  return tool({
    description:
      'Segment a finished narration script into an ordered storyboard of shots. Each shot carries its verbatim narration, a still/clip hint, a concrete footage search query, an intent describing what it must show, and estimated word-level caption timings. Run this after writeScript; then source footage for each shot with the sourceFootage tool.',
    inputSchema: cutBeatsSchema,
    execute: async (input, { abortSignal }) => {
      let voiceWords
      if (input.voiceoverId) {
        const handle = await kvGetJSON<VoiceoverHandle>(
          `voiceover:${input.voiceoverId}`
        )
        voiceWords = handle?.words
      }
      const storyboard = await cutScriptIntoBeats(
        model,
        { ...input, voiceWords },
        abortSignal
      )
      return { state: 'complete' as const, ...storyboard }
    }
  })
}
