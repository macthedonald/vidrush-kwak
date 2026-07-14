// VidRush render worker — an HTTP front for the tier-1 ffmpeg renderer.
// POST /render  { input: RenderInput, key?: string }
//   → renders the storyboard to an MP4, uploads it to object storage, returns the URL.
//   → if storage isn't configured, streams the MP4 back inline.
// Deployed to Fly.io (Dockerfile installs ffmpeg). Vercel's composeRender tool calls this
// instead of shelling out to ffmpeg itself, keeping heavy renders off serverless.
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { generateMusic } from './music.ts'
import { renderStoryboard, type RenderInput } from './render.ts'
import { storageConfigured, uploadFile } from './storage.ts'
import { generateVoiceover } from './voice.ts'

const app = new Hono()

const AUTH_TOKEN = process.env.RENDER_WORKER_TOKEN || ''

// Simple bearer-token gate so the endpoints aren't open to the world.
const requireAuth = async (c: any, next: any) => {
  if (AUTH_TOKEN) {
    const auth = c.req.header('authorization') || ''
    if (auth !== `Bearer ${AUTH_TOKEN}`) {
      return c.json({ error: 'unauthorized' }, 401)
    }
  }
  await next()
}
app.use('/render', requireAuth)
app.use('/voiceover', requireAuth)
app.use('/music', requireAuth)

app.get('/health', c => c.json({ ok: true, ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg' }))

// TTS: text → mp3 (uploaded to storage) + real word timings.
app.post('/voiceover', async c => {
  let body: { text?: string; voiceId?: string; key?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400)
  }
  if (!body?.text?.trim()) return c.json({ error: 'text is required' }, 400)
  try {
    const vo = await generateVoiceover(body.text, { voiceId: body.voiceId })
    // AI33 hosts the audio. If we have durable storage, mirror it there so the URL
    // outlives the AI33 task; otherwise hand back AI33's URL directly.
    if (storageConfigured()) {
      const { mkdir } = await import('node:fs/promises')
      const dir = path.join(os.tmpdir(), `vo-${Date.now()}`)
      await mkdir(dir, { recursive: true })
      const file = path.join(dir, 'voice.mp3')
      const audioRes = await fetch(vo.audioUrl)
      if (!audioRes.ok) throw new Error(`AI33 audio fetch ${audioRes.status}`)
      await writeFile(file, Buffer.from(await audioRes.arrayBuffer()))
      const key =
        body.key?.replace(/^\/+/, '') ||
        `voiceovers/${new Date().toISOString().slice(0, 10)}/${path.basename(dir)}.mp3`
      const url = await uploadFile(file, key, 'audio/mpeg')
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      return c.json({ audioUrl: url, words: vo.words, durationSec: vo.durationSec, voiceId: vo.voiceId })
    }
    return c.json({
      audioUrl: vo.audioUrl,
      words: vo.words,
      durationSec: vo.durationSec,
      voiceId: vo.voiceId
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'voiceover failed'
    return c.json({ error: message }, 500)
  }
})

// Background music via AI33/Suno → audio (mirrored to storage) for the ducked bed.
app.post('/music', async c => {
  let body: { prompt?: string; instrumental?: boolean; key?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400)
  }
  if (!body?.prompt?.trim()) return c.json({ error: 'prompt is required' }, 400)
  try {
    const music = await generateMusic(body.prompt, { instrumental: body.instrumental })
    if (storageConfigured()) {
      const { mkdir } = await import('node:fs/promises')
      const dir = path.join(os.tmpdir(), `music-${Date.now()}`)
      await mkdir(dir, { recursive: true })
      const file = path.join(dir, 'music.mp3')
      const audioRes = await fetch(music.audioUrl)
      if (!audioRes.ok) throw new Error(`Suno audio fetch ${audioRes.status}`)
      await writeFile(file, Buffer.from(await audioRes.arrayBuffer()))
      const key =
        body.key?.replace(/^\/+/, '') ||
        `music/${new Date().toISOString().slice(0, 10)}/${path.basename(dir)}.mp3`
      const url = await uploadFile(file, key, 'audio/mpeg')
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      return c.json({ audioUrl: url, title: music.title, durationSec: music.durationSec })
    }
    return c.json({ audioUrl: music.audioUrl, title: music.title, durationSec: music.durationSec })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'music failed'
    return c.json({ error: message }, 500)
  }
})

app.post('/render', async c => {
  let payload: { input?: RenderInput; key?: string }
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400)
  }
  const input = payload?.input
  if (!input || !Array.isArray(input.shots) || !input.shots.length) {
    return c.json({ error: 'input.shots is required' }, 400)
  }

  const workDir = path.join(os.tmpdir(), `render-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const outPath = path.join(workDir, 'output.mp4')
  try {
    const result = await renderStoryboard(input, { outPath, workDir })

    if (storageConfigured()) {
      const key =
        payload.key?.replace(/^\/+/, '') ||
        `renders/${new Date().toISOString().slice(0, 10)}/${path.basename(workDir)}.mp4`
      const url = await uploadFile(result.outPath, key)
      await rm(workDir, { recursive: true, force: true })
      return c.json({
        url,
        totalSeconds: result.totalSeconds,
        shots: result.shots,
        hadVoice: result.hadVoice,
        hadMusic: result.hadMusic,
        fallbacks: result.fallbacks
      })
    }

    // No storage configured → stream the file back, then clean up.
    const { readFile } = await import('node:fs/promises')
    const buf = await readFile(result.outPath)
    await rm(workDir, { recursive: true, force: true })
    return new Response(new Uint8Array(buf), {
      headers: {
        'content-type': 'video/mp4',
        'x-total-seconds': String(result.totalSeconds),
        'x-shots': String(result.shots),
        'x-fallbacks': String(result.fallbacks)
      }
    })
  } catch (err) {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
    const message = err instanceof Error ? err.message : 'render failed'
    return c.json({ error: message }, 500)
  }
})

const port = Number(process.env.PORT || 8080)
serve({ fetch: app.fetch, port }, info => {
  console.log(`[render-worker] listening on :${info.port}`)
})
