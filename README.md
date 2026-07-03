# VidRush v7 Studio

A self-hosted vidrush.ai-style YouTube content factory that runs entirely in your browser — from **video ideation to a rendered video download, voiceover MP3, and a full SEO package**. No backend: your API keys stay in localStorage and every call goes straight from the browser to the provider.

## The pipeline

**Ideation (existing VidRush core)**
1. Create a niche, add competitor channels, scan their uploads via the YouTube Data API.
2. Outlier ranking (views vs channel average) + AI topic suggestions from real competitor data.
3. Creative brief generator (4-pillar prompt), title/description/tag optimizer, AI thumbnail lab (reference-cloning or from scratch).

**Storyboard Studio (new — click "🎬 Storyboard Studio" on any topic)**
1. **📝 Script** — writes the complete word-for-word narration (hook, curiosity loops, retention hooks, CTA), guided by your creative brief. Editable.
2. **🎬 Storyboard** — splits the script verbatim into 15–25s scenes, each with a visual prompt, b-roll search queries, and optional on-screen overlay text. Fully editable, per-scene delete.
3. **🖼️ Visuals** — generates one 16:9 frame per scene (Gemini image), in one of three looks:
   - **Cinematic AI** — photoreal frames, Ken Burns motion, crossfades
   - **Real Assets** — documentary-style frames + one-click Pexels photo sourcing with automatic photographer attribution
   - **Stickman Doodle** — hand-drawn marker frames, hard cuts, no zoom
4. **🎙️ Voiceover** — Gemini TTS per scene (8 voices). Each scene's exact audio length drives the edit (beat-sync). Download the full voiceover as **MP3** or WAV.
5. **🎞️ Render** — in-browser renderer (canvas + MediaRecorder): Ken Burns/crossfades, top overlay titles, word-level **karaoke subtitles**, 720p/1080p. Downloads as **MP4** (Chrome/Safari) or WebM. Renders in real time — keep the tab focused.
6. **📦 SEO Package** — titles, description, 15–20 tags, pinned comment, **auto-timestamped chapters** from your storyboard sections, and collected asset credits — downloadable as a `.zip` (script + storyboard.json + seo_package.txt).

**⚡ Autopilot** runs script → storyboard → all frames → all voiceover in one click; you review and hit Render.

## API keys (Home page → API Keys)

| Key | Used for | Required |
|---|---|---|
| YouTube Data API v3 | competitor scanning, outliers | ideation only |
| Anthropic | topics, briefs, scripts, storyboards, SEO | yes |
| Gemini | scene frames, thumbnails, TTS voiceover | studio |
| Pexels | real b-roll photo sourcing | optional |

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
