# VidRush render worker

The tier-1 ffmpeg renderer behind an HTTP endpoint, deployed to **Fly.io**. Vercel's
`composeRender` tool calls this instead of shelling out to ffmpeg itself — Vercel's
serverless functions have no ffmpeg binary and tight time/size limits, so every heavy
render second happens here.

The render engine (`src/render.ts`) is **vendored** from `app-live/lib/engine/render.ts`
so the worker builds standalone. It is byte-identical; regenerate after any engine change:

```bash
npm run sync:engine
```

## Endpoints

- `GET /health` → `{ ok: true }`
- `POST /render` (Bearer `RENDER_WORKER_TOKEN` if set)
  ```json
  { "input": { "width": 1280, "height": 720, "fps": 30,
               "brand": { "accent": "#ff2d55" },
               "shots": [ { "kind": "photo", "src": "https://…", "start": 0,
                           "duration": 3.2, "words": [ { "word": "Ever", "start": 0.05, "end": 0.32 } ] } ],
               "voice": "https://…/voice.mp3", "music": "https://…/music.mp3" },
    "key": "renders/abc.mp4" }
  ```
  Returns `{ url, totalSeconds, shots, hadVoice, hadMusic, fallbacks }` when storage is
  configured, otherwise streams the MP4 back inline.
- `POST /voiceover` (Bearer `RENDER_WORKER_TOKEN` if set)
  ```json
  { "text": "the narration script", "voiceId": "elevenlabs_21m00Tcm4TlvDq8ikWAM" }
  ```
  Runs AI33 TTS and returns `{ audioUrl, words: [{ word, start, end }], durationSec, voiceId }`.
  With storage configured the mp3 is mirrored to your bucket; otherwise AI33's URL is returned.

## Environment

| Var | Purpose |
|-----|---------|
| `RENDER_WORKER_TOKEN` | Bearer token required on `/render` and `/voiceover` (set the same value in the Vercel app). |
| `AI33_API_KEY` | AI33 (api.ai33.pro) key for `/voiceover` TTS — ElevenLabs / MiniMax / Fish / cloned voices. |
| `AI33_VOICE_ID` | Optional default voice, provider-prefixed (e.g. `elevenlabs_21m00Tcm4TlvDq8ikWAM`). |
| `AI33_BASE_URL` | Optional; defaults to `https://api.ai33.pro`. |
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Object storage credentials (Cloudflare R2 / AWS S3 / Supabase S3). |
| `R2_ACCOUNT_ID` **or** `S3_ENDPOINT` | R2 account id (endpoint auto-derived) or an explicit S3 endpoint. |
| `S3_REGION` | Defaults to `auto` (correct for R2). |
| `S3_PUBLIC_BASE_URL` | Public base URL for uploaded objects, e.g. your R2 public bucket / CDN domain. |
| `FFMPEG_PATH` | Optional; defaults to `ffmpeg` on `PATH` (installed in the image). |

If no `S3_*` bucket is set, `/render` streams the MP4 back inline and `/voiceover`
returns AI33's hosted audio URL directly (no durable mirror) — handy for a first smoke
test before wiring storage.

`/voiceover` runs voiceover here (rather than on Vercel) so long TTS polls don't hit
serverless timeouts, and can be pointed at from the app via `RENDER_WORKER_URL`.

## Deploy

> **Fly app names are globally unique** across all of Fly — if `vidrush-render` is taken,
> pick your own name and use it everywhere below (and set the `FLY_APP` repo variable for CI).

```bash
# one-time — create the app (choose a unique NAME)
fly apps create vidrush-render        # or: fly launch --no-deploy --copy-config --name vidrush-render

# secrets (RENDER_WORKER_TOKEN is any string you invent — e.g. `openssl rand -hex 32`)
fly secrets set --app vidrush-render \
  RENDER_WORKER_TOKEN=… AI33_API_KEY=… \
  S3_BUCKET=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… \
  R2_ACCOUNT_ID=… S3_PUBLIC_BASE_URL=https://cdn.example.com

# ship it
fly deploy --app vidrush-render
```

**Deploying via GitHub Actions instead** (`.github/workflows/deploy-worker.yml`): add a
repo secret `FLY_API_TOKEN` from **`fly tokens create org`** (an *org* token — a per-app
*deploy* token cannot create the app), optionally a repo variable `FLY_APP` if your name
isn't `vidrush-render`, then run the workflow. Set the Fly *secrets* above once via the
CLI/dashboard regardless (CI deploys the image; it doesn't set your app secrets).

### The two Vercel vars

- **`RENDER_WORKER_URL`** — your worker's URL after it deploys: `https://<app-name>.fly.dev`
  (e.g. `https://vidrush-render.fly.dev`). You get this *from* the successful Fly deploy.
- **`RENDER_WORKER_TOKEN`** — the same secret string you set on the worker above. It just
  gates the endpoints so only your app can call them.

Set both in the Vercel app; `composeRender` / `generateVoiceover` / `generateMusic` will
then POST to the worker and return the resulting media URLs.

## Local dev

```bash
npm install
npm run sync:engine
npm run dev            # http://localhost:8080
```
