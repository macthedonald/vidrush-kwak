import { tool } from 'ai'
import { z } from 'zod'

import { writeVideoScript } from '@/lib/engine/script'

const writeScriptSchema = z.object({
  topic: z.string().describe('The video topic / working title'),
  niche: z
    .string()
    .optional()
    .describe('The channel niche this video belongs to (e.g. "Ancient Rome mysteries")'),
  minutes: z
    .number()
    .min(0.5)
    .max(20)
    .optional()
    .describe('Target video length in minutes (default 5)'),
  language: z
    .string()
    .optional()
    .describe('Narration language (default English)'),
  tone: z
    .string()
    .optional()
    .describe(
      'Optional style directive, e.g. "countdown listicle", "documentary narration", "motivational"'
    ),
  researchNotes: z
    .string()
    .optional()
    .describe(
      'Key facts/angles gathered with the search and fetch tools — ALWAYS research the topic first and pass the distilled findings here so the script is grounded in real facts'
    )
})

// Full narration script + creative brief for a faceless YouTube video.
export function createWriteScriptTool(model: string) {
  return tool({
    description:
      'Write a complete, word-for-word faceless-YouTube narration script (plus the creative brief that guides it). Research the topic with search/fetch FIRST and pass the findings in researchNotes. Returns clean spoken narration in natural paragraphs — no markdown, no stage directions.',
    inputSchema: writeScriptSchema,
    execute: async (input, { abortSignal }) => {
      const result = await writeVideoScript(model, input, abortSignal)
      return { state: 'complete' as const, ...result }
    }
  })
}
