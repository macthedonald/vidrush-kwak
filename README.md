# VidRush

A self-hosted YouTube content studio that runs entirely in your browser — from niche discovery and video ideation to a rendered video, voiceover MP3, background music, and a full SEO package. No backend: API keys live in localStorage (set them on the Settings page) and every call goes straight from the browser to the provider.

Clean, quiet interface: light theme, left-sidebar navigation (Home / Niche finder / Settings / your niches with nested topics), code-split pages, an error boundary around every route, and subtle motion.

## The pipeline

**Niche finder**
- Add niche keywords by hand, or type a broad topic and let AI suggest 8 sub-niches.
- Built for long-form first, with a Shorts filter: real durations are parsed from the API and Shorts (≤3 min) are excluded from long-form analysis (or exclusively targeted in Shorts mode). Each keyword is scored 0–100 on live YouTube data (last 30/90/180 days, region-selectable): **Demand** (log-scaled average views), **Opportunity** (small channels winning + outlier count), **Velocity** (views/day), minus **Competition** (share of 1M+ sub channels), plus engagement.
- Shows outlier videos (views ≫ channel subs) and **breakout channels**.
- **Save niche** or **Research this niche →** — saving auto-seeds the breakout channels as competitors, and Research picks up from there: scan → topics → brief → Studio. One unbroken flow from "does this niche work?" to a finished video.

**Research (VidRush core)**
1. Create a niche, add competitor channels, scan their uploads via the YouTube Data API.
2. Outlier ranking (views vs channel average) + AI topic suggestions from real competitor data.
3. Creative brief generator (4-pillar prompt), title/description/tag optimizer, AI thumbnail lab (reference-cloning or from scratch).

**Storyboard Studio** (from any topic, or the play icon next to a sidebar topic)
1. **Script** — writes the complete word-for-word narration (hook, curiosity loops, retention hooks, CTA), guided by the creative brief built from your competitor research. Editable.
2. **Storyboard** — splits the script verbatim into fast **3–5 second shots** (8–14 words each), every shot with its own visual prompt, b-roll search queries, and optional overlay text. Fully editable, per-shot delete.
3. **Visuals** — one 16:9 frame or clip per shot, in one of three looks:
   - **Cinematic AI** — photoreal Gemini frames, Ken Burns motion, fast crossfades
   - **Real Assets** — sourcing cascade: **Coverr video → Pixabay video/photo → Pexels fallback**, with a per-shot picker modal and automatic attribution. Real clips play live inside the final render.
   - **Stickman Doodle** — hand-drawn marker frames, hard cuts, no zoom
4. **Voiceover** — voiced per script section for natural prosody, then beat-synced across the 3–5s shots by word count. Voice picker modal with **all 30 Gemini TTS voices**, plus **ElevenLabs, MiniMax, and Fish Audio voices via your AI33 account** (live-searchable) — including **voice cloning** (upload a ≤10MB sample, it's cloned on AI33 and appears under My Clones, deletable). Preview any voice before committing. Download the full voiceover as **MP3** or WAV.
5. **Render** — in-browser renderer (canvas + MediaRecorder): fast cuts, Ken Burns on stills, real clips playing, word-level **karaoke subtitles**, 720p/1080p. **Background music**: upload your own track (any audio format) or generate an instrumental with **Suno via AI33** — looped, volume-ducked under the voiceover, auto fade-out. Downloads as **MP4** (Chrome/Safari) or WebM. Renders in real time — keep the tab focused.
6. **SEO Package** — titles, description, tags, pinned comment, **auto-timestamped chapters**, and collected asset credits. Every generated package is **pinned to the Dashboard home** with one-tap copy buttons, and downloadable as a `.zip`.

**Autopilot** runs script → storyboard → all visuals → all voiceover → SEO in one click; you review and hit Render.

## API keys (Settings page)

| Key | Used for | Required |
|---|---|---|
| YouTube Data API v3 | competitor scanning, outliers | ideation only |
| Anthropic | topics, briefs, scripts, storyboards, SEO | yes |
| Gemini | scene frames, thumbnails, Gemini voices | studio |
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

## Notes

- Rendering happens in real time (a 5-minute video takes ~5 minutes). Chrome outputs MP4; other browsers fall back to WebM, which YouTube accepts.
- Storyboard text, script, and SEO data persist in localStorage per topic; generated frames and audio live in memory for the session (regenerate or re-voice after a reload).
- Real-asset mode auto-collects "Photo by X on Pexels" credit lines into the SEO package for safe attribution.
