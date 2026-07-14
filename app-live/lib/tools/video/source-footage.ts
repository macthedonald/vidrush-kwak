import { tool } from 'ai'
import { z } from 'zod'

import { sourceFootage } from '@/lib/engine/sourcing'

const sourceFootageSchema = z.object({
  queries: z
    .array(z.string())
    .min(1)
    .describe(
      'One or more concrete visual search phrases for this scene, most specific first (e.g. ["Apollo 11 Saturn V launch", "1969 rocket liftoff footage"])'
    ),
  intent: z
    .string()
    .optional()
    .describe(
      'Plain-language description of what the shot must SHOW, used to vision-verify the pick (e.g. "the rocket actually lifting off the pad, no text overlays")'
    ),
  limit: z
    .number()
    .min(1)
    .max(20)
    .optional()
    .describe('How many ranked candidates to return (default 8)')
})

// Scout real footage/imagery for a scene. Pools open archives (Wikimedia, Internet
// Archive, National Archives) AND morphic's configured web search provider, ranks by
// relevance, and — when a Gemini key is present — vision-verifies that the top pick
// actually depicts the subject and is free of burned-in text/watermarks.
export function createSourceFootageTool() {
  return tool({
    description:
      'Find real b-roll footage and photos for a video scene. Pools open archives (Wikimedia Commons, Internet Archive, U.S. National Archives) together with the general web via morphic\'s search provider, ranks candidates by relevance, and vision-verifies the best pick when possible. Use after scripting/beats when you need concrete visuals for a shot.',
    inputSchema: sourceFootageSchema,
    execute: async ({ queries, intent, limit }) => {
      const result = await sourceFootage(queries, intent || queries.join('; '), {
        limit: limit ?? 8
      })
      return {
        state: 'complete' as const,
        queries,
        intent: intent || '',
        visionVerified: result.visionVerified,
        best: result.best,
        candidates: result.candidates
      }
    }
  })
}
