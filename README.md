# VidRush

A self-hosted YouTube content studio that runs entirely in your browser — from niche discovery and video ideation to a rendered video, voiceover MP3, background music, and a full SEO package. No backend: API keys live in localStorage (set them on the Settings page) and every call goes straight from the browser to the provider.

Clean, quiet interface: light theme, left-sidebar navigation (Home / Niche finder / Settings / your niches with nested topics), code-split pages, an error boundary around every route, and subtle motion.

## The pipeline

**Niche finder**
- Add niche keywords by hand, or type a broad topic and let AI suggest 8 sub-niches.
- Built for long-form first, with a Shorts filter: real durations are parsed from the API and Shorts (≤3 min) are excluded from long-form analysis (or exclusively targeted in Shorts mode). Each keyword is scored 0–100 on live YouTube data (last 30/90/180 days, region-selectable): **Demand** (log-scaled average views), **Opportunity** (small channels winning + outlier count), **Velocity** (views/day), minus **Competition** (share of 1M+ sub channels), plus engagement.
- Shows outlier videos (views ≫ channel subs) and **breakout channels**.
- **Save niche** or **Research this niche →** — saving auto-seeds the breakout channels as competitors, and Research picks up from there: scan → topics → brief → Studio. One unbroken flow from "does this niche work?" to a finished video.

**Learn from a video (vision)**
- Paste a **YouTube link** — **Gemini watches it directly** (no download) and reverse-engineers the structure — hook technique, phase order (real footage → commentary over b-roll → graphics), cut pacing, visual mix, narration devices. Or drop a video file (Gemini File API for large clips). When an actual download IS needed, `npm run dev`/`preview` include a **yt-dlp** server engine (`/api/yt`, via the `youtube-dl-exec` binary) — no browser CORS to fight.
- Saved as a **template**: pick it in the Studio toolbar and the script, storyboard pacing, and per-shot source types follow it — shots in "real footage" phases are auto-sourced from stock providers instead of generated.

**Self-learning memory**
- Every meaningful action is logged per niche: script and narration edits (before/after), redone frames, voice/style/template choices, rendered videos, shipped SEO.
- After renders and SEO packages, a background reflection distills the log into a compact preferences note that is injected into every future brief, script, storyboard, and SEO prompt — the app gets sharper with every video. Review, edit, or wipe the memory in Settings.

**Research**
1. Create a niche, add competitor channels, scan their uploads via the YouTube Data API.
2. Outlier ranking (views vs channel average) + AI topic suggestions from real competitor data.
3. **Since your last scan** — every rescan shows new uploads and the biggest view-gainers among tracked competitors.
4. **Keyword ideas** — live YouTube autocomplete around your seed keyword; click any to open it in the Studio.
5. **Title scorer** — scores a working title against the patterns of this niche's top performers, with AI-written stronger variants.

**Storyboard Studio** (from any topic, or the play icon next to a sidebar topic)
1. **Script** — writes the complete word-for-word narration (hook, curiosity loops, retention hooks, CTA), guided by the creative brief. Editable.
2. **Storyboard** — splits the script verbatim into fast **3–5 second shots** (8–14 words each), every shot with its own visual prompt, b-roll search queries, and optional overlay text. Fully editable, per-shot delete.
3. **Visuals** — one frame or clip per shot, generated on **Gathos** (images ~15s each), in one of three looks:
   - **Cinematic AI** — photoreal frames, Ken Burns motion, fast crossfades — or true **AI video clips** per shot: "AI clip" animates the frame (ti2av) or goes text-to-video (t2av) with Gathos Creator video (~1–2 min/clip, styles mapped: Cinematic / Stickman)
   - **Real Assets** — sourcing cascade: **Coverr video → Pixabay video/photo → Pexels fallback**, with a per-shot picker modal and automatic attribution. Real clips play live inside the final render.
   - **Stickman Doodle** — hand-drawn marker frames, hard cuts, no zoom
4. **Voiceover** — voiced per script section for natural prosody, then beat-synced across the 3–5s shots by word count. Voice picker modal with **all 30 Gemini TTS voices**, plus **ElevenLabs, MiniMax, and Fish Audio voices via your AI33 account** (live-searchable) — including **voice cloning** (upload a ≤10MB sample, it's cloned on AI33 and appears under My Clones, deletable). Preview any voice before committing. Download the full voiceover as **MP3** or WAV.
5. **Render** — **WebCodecs fast encoder** (frame-accurate H.264/AAC MP4, faster than realtime, survives background tabs) with automatic fallback to the realtime canvas recorder. **16:9 or 9:16 vertical** — the format selector flows through storyboard prompts, image aspect, canvas size, and subtitle layout. Word-level **karaoke subtitles** use exact timestamps from **Groq Whisper** (transcribes every section, any voice provider), falling back to AI33 transcripts or estimation. **Background music**: upload your own track or generate an instrumental with **Suno via AI33** — looped, ducked, auto fade-out.
6. **Thumbnail** — the thumbnail lab as a Studio step: clone a reference thumbnail's style or write from scratch, refine the prompt conversationally, generate variants matching your video's format.
7. **SEO Package** — titles, description, tags, pinned comment, **auto-timestamped chapters**, and collected asset credits. Pinned to Home with one-tap copy, downloadable as a `.zip`.

A **creative brief** card sits in the Script step (optional): research-driven angle/facts/audience, and remakes of the same topic automatically avoid items used in earlier versions.

**Projects persist.** Text lives in localStorage; frames, sourced clips, voiceover audio, music, and rendered videos live in IndexedDB — reload the page and everything is still there. Settings has a one-file **export/import backup**.

**Autopilot** runs script → storyboard → all visuals → all voiceover → SEO in one click; you review and hit Render.

## API keys (Settings page)

| Key | Used for | Required |
|---|---|---|
| YouTube Data API v3 | competitor scanning, outliers | ideation only |
| Anthropic | topics, briefs, scripts, storyboards, SEO | yes |
| Gathos (images) | all frame + thumbnail generation | studio |
| Gathos (video) | AI-generated clips per shot | optional |
| Groq | Whisper word-timed subtitles | optional |
| Gemini | video analysis (Learn from video) + built-in TTS voices | optional |
| AI33 (api.ai33.pro) | ElevenLabs / MiniMax / Fish Audio voices + cloning | optional |
| Coverr | real b-roll video (primary source) | optional |
| Pixabay | real b-roll video/photo (primary source) | optional |
| Pexels | real b-roll fallback | optional |

### AI33 integration details

Base URL `https://api.ai33.pro` (configurable in Settings), auth via the `xi-api-key` header. TTS is asynchronous: the app POSTs FormData to `/v3/text-to-speech` with a provider-prefixed `voice_id` (`elevenlabs_…`, `minimax_…`, `fishaudio_…`, `clone_…`), polls `GET /v1/task/{task_id}` until `status: "done"`, then downloads `metadata.audio_url` and decodes it to PCM for the renderer. Voice lists come from `GET /v3/voices?provider=…` (Fish Audio sorted by trending, all providers searchable). Cloning POSTs `voice_name` + `audio_file` (≤10MB) to `/v3/text-to-speech/voice-clone` and uses the returned id as `clone_<voice_id>`; clones can be deleted from the modal.

## Run it

```bash
npm install
npm run dev     # local dev server
npm run build   # production build in dist/
```

## Accounts & cloud sync (Convex + Clerk)

By default the app runs **local-only** — everything in `localStorage`/IndexedDB, no sign-in, zero setup. Add two env vars to turn on **per-user accounts and cross-device sync**: your niches, topics, video templates, API keys, and the **learning memory** all live in Convex, keyed to your Clerk user, so they follow you to any device and never disappear.

Media binaries (rendered videos, generated frames) stay in the browser's IndexedDB by design; their metadata syncs.

### Setup (once)

1. **Convex** — `npm i -g convex` then, in the repo, `npx convex dev`. It logs you in, creates a deployment, deploys `convex/` (the `kv` table + functions), and writes `VITE_CONVEX_URL` into `.env.local`.
2. **Clerk** — create an app at clerk.com. In **JWT Templates**, add a template named exactly `convex`. Copy the **Publishable key** into `.env.local` as `VITE_CLERK_PUBLISHABLE_KEY`.
3. **Link them** — in the **Convex dashboard → Settings → Environment Variables**, set `CLERK_JWT_ISSUER_DOMAIN` to your Clerk **Frontend API URL** (e.g. `https://your-app.clerk.accounts.dev`). This is what `convex/auth.config.js` validates.
4. Restart `npm run dev`. You'll get a sign-in screen; after signing in, your workspace syncs.

On Vercel this is automated — see **Deploy to Vercel** below: adding a `CONVEX_DEPLOY_KEY` makes each build push `convex/` to production and inject `VITE_CONVEX_URL` for you.

**Migration:** the first time you sign in, any work already in your browser (from local-only mode) is imported into your account automatically.

## Deploy to Vercel

The app is a static Vite SPA — Vercel builds it with zero config beyond the included `vercel.json`.

1. Push the repo to GitHub (done).
2. In the Vercel dashboard: **Add New → Project → Import** this repo. Framework preset auto-detects as Vite; `vercel.json` sets the build command, output dir (`dist`), SPA rewrites, and skips the yt-dlp binary download (not needed in the static deploy). Click **Deploy**.
   - Or locally: `npx vercel` (first run prompts login), then `npx vercel --prod`.
3. Open the app, go to **Settings**, paste your API keys (stored in your browser only).

**Turning on cloud sync (Convex + Clerk) for production** — optional; without it the deploy runs fine on the localStorage fallback:

1. In the **Convex dashboard → your project → Settings → Deploy Keys**, generate a **Production** deploy key.
2. In **Vercel → Project → Settings → Environment Variables**, add:
   - `CONVEX_DEPLOY_KEY` — the production deploy key from step 1.
   - `VITE_CLERK_PUBLISHABLE_KEY` — your Clerk publishable key.
3. In the **Convex dashboard → Settings → Environment Variables**, set `CLERK_JWT_ISSUER_DOMAIN` to your Clerk Frontend API URL (what `convex/auth.config.js` validates).
4. Redeploy. The build (`scripts/vercel-build.mjs`) sees `CONVEX_DEPLOY_KEY`, runs `npx convex deploy --cmd 'npm run build'` to push `convex/` to production, and auto-injects `VITE_CONVEX_URL`. No key ⇒ it falls back to a plain `npm run build` and the app stays local-only.

**One caveat:** the `/api/yt` yt-dlp download route only runs under `npm run dev`/`npm run preview` (it's a Node middleware). On Vercel it isn't deployed — but the **Learn from a video** feature doesn't need it, because Gemini reads YouTube links directly. Everything else is fully client-side and works on Vercel as-is.

## Notes

- Chrome/Edge use the WebCodecs fast encoder (much faster than realtime); browsers without it fall back to a realtime recorder that needs the tab focused.
- Long scripts are storyboarded in section chunks, and Anthropic calls retry automatically on rate limits.
- Real-asset mode auto-collects "Photo by X on Pexels" credit lines into the SEO package for safe attribution.
