// VENDORED from app-live/lib/engine/voice.ts — regenerate with: npm run sync:engine. Do not edit here.
// VidRush engine — voiceover (TTS) via AI33 (https://api.ai33.pro), the same gateway the
// studio used. AI33 fronts ElevenLabs / MiniMax / Fish / cloned voices under one key.
// It is task-based: POST /v3/text-to-speech (multipart) returns a task_id; poll
// GET /v1/task/{id} until "done", then the audio lives at metadata.audio_url. With
// with_transcript=true the metadata also carries word-level timings, which drive the
// storyboard (shot durations = real speech) and the karaoke captions. Voice ids are
// provider-prefixed (e.g. "elevenlabs_21m00Tcm4TlvDq8ikWAM", "minimax_…", "clone_…").
// Shared with the render worker (vendored) so voiceover can run wherever it's convenient.

export interface VoiceWord {
  word: string
  start: number
  end: number
}

export interface VoiceResult {
  /** AI33-hosted URL of the generated audio (mp3). */
  audioUrl: string
  words: VoiceWord[]
  durationSec: number
  voiceId: string
}

export const AI33_DEFAULT_BASE = 'https://api.ai33.pro'
// Default = ElevenLabs "Rachel" through AI33 (provider-prefixed id).
const DEFAULT_VOICE_ID = 'elevenlabs_21m00Tcm4TlvDq8ikWAM'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const trimBase = (b?: string) => (b || AI33_DEFAULT_BASE).replace(/\/$/, '')

async function jfetch(url: string, opts: RequestInit): Promise<any> {
  const r = await fetch(url, opts)
  let d: any = null
  try {
    d = await r.json()
  } catch {
    /* non-JSON */
  }
  if (!r.ok) {
    throw new Error(d?.error_message || d?.message || d?.error || `AI33 HTTP ${r.status}`)
  }
  return d
}

// Poll a task until it completes; returns the task metadata.
async function pollTask(
  base: string,
  key: string,
  taskId: string,
  { intervalMs = 2500, timeoutMs = 300000, abortSignal }: { intervalMs?: number; timeoutMs?: number; abortSignal?: AbortSignal } = {}
): Promise<any> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (abortSignal?.aborted) throw new Error('aborted')
    const d = await jfetch(`${base}/v1/task/${taskId}`, {
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      signal: abortSignal
    })
    if (d.status === 'done') return d.metadata || {}
    if (d.status === 'error' || d.status === 'failed' || d.error_message) {
      throw new Error(d.error_message || 'AI33 task failed')
    }
    await sleep(intervalMs)
  }
  throw new Error('AI33 task timed out')
}

// Tolerant word-timestamp extraction from a completed TTS task's metadata (ms → s).
export function parseTranscriptWords(meta: any): VoiceWord[] {
  const cand =
    meta?.words ||
    meta?.transcript?.words ||
    meta?.transcript_json?.words ||
    (Array.isArray(meta?.transcript) ? meta.transcript : null) ||
    meta?.subtitles ||
    meta?.alignment?.words ||
    null
  if (!Array.isArray(cand) || !cand.length) return []
  const norm = cand.map((w: any): VoiceWord | null => {
    const word = w.word ?? w.text ?? w.w
    let start = w.start ?? w.start_time ?? w.startTime ?? w.s
    let end = w.end ?? w.end_time ?? w.endTime ?? w.e
    if (word == null || start == null || end == null) return null
    if (end > 1000) {
      start /= 1000
      end /= 1000
    }
    return { word: String(word), start: +start, end: +end }
  })
  return norm.every(Boolean) ? (norm as VoiceWord[]) : []
}

// Group character-level alignment into word timings (kept for providers that return
// per-character rather than per-word alignment). A word runs from its first non-space
// character's start to its last one's end; runs are delimited by whitespace.
export function groupCharsIntoWords(
  characters: string[],
  starts: number[],
  ends: number[]
): VoiceWord[] {
  const words: VoiceWord[] = []
  let buf = ''
  let wStart = 0
  let wEnd = 0
  let open = false
  const flush = () => {
    if (open && buf.trim()) words.push({ word: buf, start: wStart, end: wEnd })
    buf = ''
    open = false
  }
  for (let i = 0; i < characters.length; i++) {
    const ch = characters[i]
    if (/\s/.test(ch)) {
      flush()
      continue
    }
    if (!open) {
      wStart = starts[i] ?? wEnd
      open = true
    }
    buf += ch
    wEnd = ends[i] ?? wStart
  }
  flush()
  return words
}

// Generate a voiceover for `text` via AI33, returning the hosted audio URL and real word
// timings. voiceId must be provider-prefixed; defaults to ElevenLabs "Rachel".
export async function generateVoiceover(
  text: string,
  opts: {
    apiKey?: string
    baseUrl?: string
    voiceId?: string
    speed?: number
    abortSignal?: AbortSignal
  } = {}
): Promise<VoiceResult> {
  const apiKey = opts.apiKey || process.env.AI33_API_KEY || ''
  if (!apiKey) throw new Error('AI33_API_KEY is not set')
  const clean = (text || '').trim()
  if (!clean) throw new Error('no text to voice')
  const base = trimBase(opts.baseUrl || process.env.AI33_BASE_URL)
  const voiceId = opts.voiceId || process.env.AI33_VOICE_ID || DEFAULT_VOICE_ID
  const speed = opts.speed ?? 1

  const fd = new FormData()
  fd.append('text', clean)
  fd.append('voice_id', voiceId)
  fd.append('speed', String(speed))
  fd.append('with_transcript', 'true')

  const created = await jfetch(`${base}/v3/text-to-speech`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: fd,
    signal: opts.abortSignal
  })
  if (!created?.success || !created?.task_id) {
    throw new Error(created?.error_message || 'AI33 TTS: no task_id returned')
  }

  const meta = await pollTask(base, apiKey, created.task_id, {
    abortSignal: opts.abortSignal
  })
  const audioUrl = meta.audio_url || meta.url || meta.output_url
  if (!audioUrl) throw new Error('AI33 TTS finished but no audio_url in task metadata')

  const words = parseTranscriptWords(meta)
  const durationSec = words.length
    ? +words[words.length - 1].end.toFixed(2)
    : Number(meta.duration || meta.audio_duration || 0)

  return { audioUrl, words, durationSec, voiceId }
}

export type VoiceProvider =
  | 'elevenlabs'
  | 'minimax'
  | 'fishaudio'
  | 'clone'
  | 'edge'
  | 'kokoro'
  | 'vbee'

export interface VoiceOption {
  provider: string
  id: string
  name: string
  desc: string
  preview?: string
}

// List AI33 voices for a provider. Returned voice_ids are already provider-prefixed and
// ready to pass straight to generateVoiceover.
export async function listVoices(
  provider: VoiceProvider,
  opts: {
    apiKey?: string
    baseUrl?: string
    search?: string
    page?: number
    pageSize?: number
  } = {}
): Promise<VoiceOption[]> {
  const apiKey = opts.apiKey || process.env.AI33_API_KEY || ''
  if (!apiKey) throw new Error('AI33_API_KEY is not set')
  const base = trimBase(opts.baseUrl || process.env.AI33_BASE_URL)
  const params = new URLSearchParams({
    provider,
    page: String(opts.page || 1),
    page_size: String(opts.pageSize || 60)
  })
  if (opts.search) params.set('search', opts.search)
  if (provider === 'fishaudio' && !opts.search) params.set('sort', 'trending')
  const d = await jfetch(`${base}/v3/voices?${params}`, {
    headers: { 'xi-api-key': apiKey }
  })
  const list: any[] = d.data || []
  return list
    .map((v: any): VoiceOption => ({
      provider,
      id: v.voice_id || v.id,
      name: v.name || v.voice_name || v.title || v.voice_id || v.id,
      desc:
        [v.gender, v.language || v.locale, v.age, v.accent, v.description || v.use_case]
          .filter(Boolean)
          .join(' · ') || provider,
      preview: v.preview_url || v.preview_audio_url || v.sample_url || v.audio_url || undefined
    }))
    .filter(v => v.id)
}

// Clone a voice from an audio sample URL. Returns the provider-prefixed clone id.
export async function cloneVoice(
  name: string,
  audioUrl: string,
  opts: { apiKey?: string; baseUrl?: string } = {}
): Promise<{ id: string; name: string }> {
  const apiKey = opts.apiKey || process.env.AI33_API_KEY || ''
  if (!apiKey) throw new Error('AI33_API_KEY is not set')
  if (!name?.trim()) throw new Error('clone name is required')
  if (!audioUrl) throw new Error('a sample audio URL is required')
  const base = trimBase(opts.baseUrl || process.env.AI33_BASE_URL)
  const sample = await fetch(audioUrl)
  if (!sample.ok) throw new Error(`sample fetch ${sample.status}`)
  const blob = await sample.blob()
  if (blob.size > 10 * 1024 * 1024) throw new Error('sample too large — AI33 clone limit is 10MB')
  const fd = new FormData()
  fd.append('voice_name', name.trim())
  fd.append('audio_file', blob, 'sample.mp3')
  const d = await jfetch(`${base}/v3/text-to-speech/voice-clone`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: fd
  })
  const vid = d?.data?.voice_id || d?.voice_id
  if (!vid) throw new Error(d?.error_message || 'AI33 clone: no voice_id returned')
  return { id: String(vid).startsWith('clone_') ? String(vid) : `clone_${vid}`, name: name.trim() }
}

// Remaining AI33 credits.
export async function getCredits(
  opts: { apiKey?: string; baseUrl?: string } = {}
): Promise<number | any> {
  const apiKey = opts.apiKey || process.env.AI33_API_KEY || ''
  if (!apiKey) throw new Error('AI33_API_KEY is not set')
  const base = trimBase(opts.baseUrl || process.env.AI33_BASE_URL)
  const d = await jfetch(`${base}/v1/credits`, {
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' }
  })
  return d?.credits ?? d?.data?.credits ?? d
}
