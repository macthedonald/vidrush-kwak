import { tool } from 'ai'
import { z } from 'zod'

import { cloneVoice } from '@/lib/engine/voice'

const cloneVoiceSchema = z.object({
  name: z.string().describe('A name for the cloned voice'),
  audioUrl: z
    .string()
    .describe('URL of a clean voice sample to clone from (mp3/wav, under 10MB)')
})

// Clone a voice from a sample URL via AI33. Returns a provider-prefixed clone id that
// can be used as the voiceId in generateVoiceover.
export function createCloneVoiceTool() {
  return tool({
    description:
      'Clone a narration voice from a sample audio URL (via AI33). Returns a voice id (clone_…) you can pass to generateVoiceover to narrate in that voice. The sample must be a clean recording under 10MB.',
    inputSchema: cloneVoiceSchema,
    execute: async ({ name, audioUrl }) => {
      const cloned = await cloneVoice(name, audioUrl)
      return {
        state: 'complete' as const,
        voiceId: cloned.id,
        name: cloned.name
      }
    }
  })
}
