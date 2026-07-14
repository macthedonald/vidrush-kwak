import { tool } from 'ai'
import { z } from 'zod'

import { listVoices } from '@/lib/engine/voice'

const listVoicesSchema = z.object({
  provider: z
    .enum(['elevenlabs', 'minimax', 'fishaudio', 'clone', 'edge', 'kokoro', 'vbee'])
    .describe('Which AI33 voice catalog to browse (default elevenlabs)')
    .optional(),
  search: z.string().optional().describe('Filter voices by name/keyword'),
  pageSize: z.number().min(1).max(100).optional().describe('How many voices (default 40)')
})

// Browse AI33 voices so the user can pick one; the returned voice ids are provider-
// prefixed and pass straight to generateVoiceover.
export function createListVoicesTool() {
  return tool({
    description:
      'List available AI33 voices for a provider (ElevenLabs, MiniMax, Fish Audio, cloned, Edge, Kokoro, Vbee). Use this to help the user choose a narration voice; pass the chosen voice id to generateVoiceover.',
    inputSchema: listVoicesSchema,
    execute: async ({ provider, search, pageSize }) => {
      const voices = await listVoices(provider || 'elevenlabs', {
        search,
        pageSize: pageSize ?? 40
      })
      return {
        state: 'complete' as const,
        provider: provider || 'elevenlabs',
        count: voices.length,
        voices
      }
    }
  })
}
