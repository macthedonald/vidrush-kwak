// VidRush engine — background music via AI33's Suno endpoint (same gateway as voiceover).
// Task-based like TTS: POST /v1s/task/music-generation (simple mode) → poll /v1/task/{id}
// until done → metadata.audio_url. The resulting track plugs straight into composeRender's
// `music` input as a ducked bed under the narration. Shared with the render worker.

export const AI33_DEFAULT_BASE = 'https://api.ai33.pro'

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

export interface MusicResult {
  audioUrl: string
  title: string
  durationSec?: number
}

// Generate a background music bed from a text prompt (instrumental by default).
export async function generateMusic(
  prompt: string,
  opts: {
    apiKey?: string
    baseUrl?: string
    instrumental?: boolean
    abortSignal?: AbortSignal
  } = {}
): Promise<MusicResult> {
  const apiKey = opts.apiKey || process.env.AI33_API_KEY || ''
  if (!apiKey) throw new Error('AI33_API_KEY is not set')
  const clean = (prompt || '').trim()
  if (!clean) throw new Error('no music prompt')
  const base = trimBase(opts.baseUrl || process.env.AI33_BASE_URL)

  const created = await jfetch(`${base}/v1s/task/music-generation`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      create_mode: 'simple',
      gpt_description_prompt: clean.slice(0, 500),
      make_instrumental: opts.instrumental !== false
    }),
    signal: opts.abortSignal
  })
  if (!created?.success || !created?.task_id) {
    throw new Error(created?.error_message || 'AI33 Suno: no task_id returned')
  }

  // Suno is slower than TTS — poll longer.
  const t0 = Date.now()
  const timeoutMs = 600000
  let meta: any = {}
  while (Date.now() - t0 < timeoutMs) {
    if (opts.abortSignal?.aborted) throw new Error('aborted')
    const d = await jfetch(`${base}/v1/task/${created.task_id}`, {
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      signal: opts.abortSignal
    })
    if (d.status === 'done') {
      meta = d.metadata || {}
      break
    }
    if (d.status === 'error' || d.status === 'failed' || d.error_message) {
      throw new Error(d.error_message || 'AI33 Suno task failed')
    }
    await sleep(6000)
  }
  const audioUrl =
    meta.audio_url || meta.all_audio_urls?.[0] || meta.suno_result?.clips?.[0]?.audio_url
  if (!audioUrl) throw new Error('Suno finished but no audio_url in task metadata')
  const title = meta.title || meta.suno_result?.clips?.[0]?.title || 'Suno track'
  const durationSec = Number(
    meta.duration || meta.suno_result?.clips?.[0]?.duration || 0
  )
  return { audioUrl, title, durationSec: durationSec || undefined }
}
