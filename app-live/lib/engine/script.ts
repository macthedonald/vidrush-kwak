// VidRush engine — script generation, ported server-side from the proven studio pipeline.
// The brief → script flow, plain-text discipline (no markdown in narration), duration
// targeting at the middle of the requested range, and multilingual output all carry over.
import { generateText } from 'ai'

import { getModel } from '@/lib/utils/registry'

export const SYS_BRIEF = `You are VidRush — an elite YouTube script strategist. Write a creative brief in English as clean, PLAIN TEXT.
Absolutely NO markdown: no asterisks, no bold, no "#" headings, no bullet characters, no backticks.

Length: between 2,000 and 6,000 characters.

Write four sections in this order. Introduce each with its name on its own line ending in a colon (plain words, e.g. "What the video is about:"), then the content in normal sentences beneath it:
What the video is about — 2-3 sentences: the topic, the narrative arc, the core tension.
Style of talking — narration tone, pacing, transitions, and the hooks to use.
Who this video is for — the audience and what they search for.
Key facts covered — the specific talking points in order, with real facts, numbers and names (about 0.5 points per minute of runtime).

Write it so a scriptwriter can read it top to bottom and write the whole script from it. No stage directions, no camera notes, no markdown.`

export const SYS_SCRIPT = `You are VidRush Studio — an elite faceless-YouTube scriptwriter with style DNA cloned from the top channels in the given niche.
Write the COMPLETE, word-for-word narration script, ready to be read aloud by a voiceover artist.
Rules:
- Open with a 10-15 second HOOK that creates an open curiosity loop.
- Plant a retention hook ("but that's not even the strangest part...") roughly every 60 seconds.
- Conversational, confident tone. Short punchy sentences mixed with longer ones. Second person where natural.
- Specific facts, numbers, names — no filler, no fluff, no "in this video we will".
- Close with a payoff + a one-line subscribe CTA.
Output ONLY the clean spoken narration — exactly the words the voice artist reads, nothing else.
Break it into natural paragraphs, one blank line between beats, so it reads as a full clean script.
Do NOT include: section headers or labels, [SECTION] tags, "Hook:" / "Intro:" / "Outro:" prefixes, timestamps, speaker names, camera or stage directions, markdown, asterisks, bold, headings, or bullet points.`

// Length presets aim at the MIDDLE of each labeled range so "10-12 min" lands ~11, not 12.
const DUR_META: Record<string, { label: string; words: number }> = {
  '0.7': { label: 'about 40 seconds', words: 100 },
  '1': { label: 'about 1 minute', words: 150 },
  '3': { label: 'about 3 minutes', words: 420 },
  '5': { label: 'about 5 minutes', words: 700 },
  '8': { label: '6-8 minutes', words: 980 },
  '12': { label: '10-12 minutes', words: 1540 },
  '15': { label: '13-15 minutes', words: 1960 }
}
export function durMeta(minutes: number): { label: string; words: number } {
  const keys = Object.keys(DUR_META).map(Number)
  const nearest = keys.reduce(
    (a, b) => (Math.abs(b - minutes) < Math.abs(a - minutes) ? b : a),
    keys[0]
  )
  return Math.abs(nearest - minutes) <= 1.5
    ? DUR_META[String(nearest)]
    : { label: `about ${minutes} minutes`, words: Math.round(minutes * 140) }
}

// Strip any markdown/section cruft the model sneaks in — narration must be pure spoken text.
export const cleanScript = (raw: string): string =>
  (raw || '')
    .replace(/\[SECTION:[^\]]*\]/gi, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*\[[^\]\n]{0,48}\]\s*$/gm, '')
    .replace(/^\s*(?:\*\*|__)[^*_\n]{0,48}(?:\*\*|__)\s*:?\s*$/gm, '')
    .replace(
      /^\s*(?:hook|intro|introduction|outro|conclusion|cta|call to action|section\s*\d*|part\s*\d*)\s*:\s*$/gim,
      ''
    )
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

export const cleanBrief = (raw: string): string =>
  (raw || '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^\s*[-*•]\s+/gm, '• ')
    .replace(/`+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

export interface WriteScriptInput {
  topic: string
  niche?: string
  minutes?: number
  language?: string
  tone?: string
  researchNotes?: string
}

export interface WriteScriptResult {
  brief: string
  script: string
  words: number
  estMinutes: number
  language: string
}

// Brief first (research-grounded when notes are supplied), then the full narration script.
export async function writeVideoScript(
  model: string,
  input: WriteScriptInput,
  abortSignal?: AbortSignal
): Promise<WriteScriptResult> {
  const minutes = input.minutes ?? 5
  const { label, words } = durMeta(minutes)
  const language = input.language || 'English'
  const langNote =
    language !== 'English'
      ? `\n\nLANGUAGE: Write EVERYTHING in ${language}. Every word of narration must be natural, fluent, native-sounding ${language} — not a stiff translation. Numbers, names and places stay accurate.`
      : ''
  const toneNote = input.tone ? `\n\nFORMAT / STYLE: ${input.tone}` : ''
  const research = input.researchNotes
    ? `\n\nRESEARCH FINDINGS (ground the brief in these real facts):\n${input.researchNotes.slice(0, 8000)}`
    : ''

  const briefRes = await generateText({
    model: getModel(model),
    system: SYS_BRIEF,
    prompt: `Topic: ${input.topic}\nNiche: ${input.niche || 'general'}\nDuration: ${label}${toneNote}${research}`,
    abortSignal
  })
  const brief = cleanBrief(briefRes.text)

  const scriptRes = await generateText({
    model: getModel(model),
    system: SYS_SCRIPT,
    prompt: `Topic: ${input.topic}\nNiche: ${input.niche || 'general'}\nTarget length: ${label} → aim for ≈${words} words, landing comfortably in the MIDDLE of that range. Do NOT exceed the upper bound.${toneNote}${langNote}\n\nUse this creative brief as your guide for angle, facts and structure — follow its sections and cover its key facts:\n${brief.slice(0, 8000)}`,
    abortSignal
  })
  const script = cleanScript(scriptRes.text)
  const wordCount = script.split(/\s+/).filter(Boolean).length

  return {
    brief,
    script,
    words: wordCount,
    estMinutes: Math.round((wordCount / 140) * 10) / 10,
    language
  }
}
