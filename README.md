# 🎮 StreamPilot — *game once, post everywhere*

StreamPilot is a personal **cross-platform autopilot** for gaming creators. You record your
gameplay, drop it in, and it:

1. **Analyzes** the video (resolution, codecs, loudness, action moments)
2. **Auto-fixes** it for broadcast/web — H.264 faststart, loudness-normalized to -14 LUFS
3. **Cuts vertical clips** (1080×1920) from the best moments for TikTok/Shorts
4. **Publishes** the long video to **YouTube** (OAuth, resumable upload) from one button
5. **Runs your live chat** on **YouTube Live + TikTok Live** simultaneously — greeting fans,
   answering FAQs, and reacting to `!clip` — all automatic, with a manual override.
6. **Clips your live stream into Shorts/TikToks mid-game** — record a live source (YouTube Live,
   HLS, or your **PS5 via remote play — no capture card**) into a rolling buffer, then hit one
   button to turn the last 10–60 seconds into a titled, vertical clip.

> Built free-tier-first: **FFmpeg** (open source), **YouTube Data API** (free 10k quota/day),
> **TikTokLive** (community live-chat reader), and optional **Supabase** for cloud auth/storage.

---

## Quick start

```bash
# 1. Install deps (bundles a static FFmpeg/FFprobe via npm — no system install needed)
npm install

# 2. Run it
npm start
# → open http://localhost:8787
```

Everything works **locally out of the box** (data lives in `./data/`). No keys required for
upload → analyze → fix → clip. You only need keys for the *publishing* and *live chat* parts.

---

## Feature walk-through

### 1. Library
Drop a gameplay video (MP4/MKV/MOV/WebM, large files fine). It uploads, then **Analyze** probes
it and lists issues (e.g. *"Audio is -21.9 LUFS — will be normalized to -14 LUFS"*) plus
detected **action moments** (scene-change detection).

### 2. Fix & master
One click re-encodes to a platform-safe format: H.264 (yuv420p + MOOV faststart for instant
streaming), caps height (never upscales), and loudness-normalizes audio to broadcast standard.

### 3. Auto-clips
Cuts up to 3 vertical 9:16 clips from the detected action moments — ready to drop into TikTok,
YouTube Shorts, or Reels.

### 4. Publish
- **YouTube**: connect your Google channel once (Settings → Publish → *Connect*). Then set a
  title/tags/privacy and click **Publish**.
- **TikTok**: TikTok's official posting API is application-only (apply via TikTok for
  Developers). Until then, the app cuts & names your clips and sets you up so the moment you're
  approved it's one click. *(Roadmap below covers auto-upload via your phone.)*

### 5. Live Autopilot
Start it with a **YouTube video/live ID** and/or a **TikTok @username**. It:
- attaches to YouTube live chat (via Data API) and polls in real time
- listens to TikTok live chat (via TikTokLive connector)
- runs every message through the brain: greetings, "what game?", GG/win, schedule, donation,
  socials, `!clip`, plus your custom FAQs (Settings)
- replies on both platforms; you can also send manual replies as the bot

### 6. Live Clips (Shorts/TikTok mid-stream) ✂️
The **Live Clips** tab records a live source into a rolling ~30s buffer and lets you cut the
moment *as it happens* — no waiting for the VOD, no re-encoding of the whole stream.

- **Pick a source:** a stream URL / YouTube live id, your **PS5**, or **TikTok from your phone**.
- While you play, hit **"✂️ Cut the last moment"** → choose how far back (5–30s) and a title →
  it renders a **vertical 9:16 clip** straight into your Library, ready to publish.

**Clipping your TikTok phone live 📱:** go live in the TikTok app on your phone (as normal),
then in Live Clips pick **"TikTok — stream from your phone"**, paste your `@username`, hit
**🔍 Check if live** (shows title + viewers), then **Start recording**. StreamPilot resolves your
live stream URL (HLS/FLV) via the same connector that powers the chat and records it into the
clip buffer — so you can cut TikTok clips while streaming from your phone.

**Clipping straight off the PS5 (no capture card):**
1. On your PS5: *Settings → System → Remote Play → Enable Remote Play* (note the Account-ID on
   the *Link Device* screen).
2. Install the open-source remote-play client **chiaki-ng** (`apt install chiaki` may be
   chiaki original; the -ng fork supports PS5 pairing best): https://sr.ht/~thestr4ng3r/chiaki/
3. One-time pair: `./scripts/ps5.sh pair <ACCOUNT_ID>` (a PIN shows on your PS5).
4. In StreamPilot → Live Clips → pick **PlayStation 5** → paste your Account-ID → Start recording.
   `scripts/ps5.sh` auto-discovers the console over your LAN, remote-plays the screen, and relays
   it to a local HLS stream we clip from.

> **YouTube Live source:** paste the live video id (it resolves the HLS manifest via
> `server/live/youtube-source.cjs`, no API key). Must run on a network that can reach YouTube.

> **Best results:** put StreamPilot (and the PS5 relay) on the same LAN as your console/PC and
> keep the recording machine wired — clipping is instant either way, but clean local playback
> gives a smoother buffer.

---

## Configuration

Copy `.env.example` to `.env` and fill in what you use:

```bash
# Optional — cloud persistence + user auth
SUPABASE_URL=
SUPABASE_ANON_KEY=

# YouTube upload + live chat (Google Cloud Console)
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REDIRECT_URI=http://localhost:8787/auth/youtube/callback

PORT=8787
SESSION_SECRET=change-me-to-a-long-random-string
```

### Connecting YouTube (5 min)
1. Go to [Google Cloud Console](https://console.cloud.google.com/) → create a project.
2. Enable **YouTube Data API v3**.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID → Web application**.
4. Add `http://localhost:8787/auth/youtube/callback` as an authorized redirect URI.
5. Put the client ID + secret in `.env`, restart, and click **Connect YouTube** in the app.

> **Note:** when testing uploads, Google requires an **audited app** for public users. For your
> *own* channel, either (a) add your Google account as a **test user** in the OAuth consent
> screen (uploads work for up to 100 test users), or (b) request verification. Quota: 10,000
> units/day ≈ several uploads + live chat at polite intervals.

### Connecting TikTok Live
TikTok live chat needs **no official key** — it reads the public chat stream. Enter your
`@username` in the Autopilot panel. (TikTok may require a CAPTCHA/session for some accounts —
the connector surfaces it transparently.)

---

## Project layout

```
server/
  index.js      Express app + REST API + SSE event stream
  ffmpeg.js     FFmpeg/FFprobe wrappers: probe, fix, loudness, highlights, clip, render
  youtube.js    YouTube OAuth + resumable uploads + live chat polling
  tiktok.js     TikTok Live connector wrapper (community lib)
  brain.js      Reply brain: intents, FAQs, templated replies
  autopilot.js  Orchestrates both platforms + brain + sending replies
  liveclip.js   Live recorder (rolling buffer) + clip/cut engine + PS5 orchestration
  live/         youtube-source.cjs — resolve a YouTube live id → HLS manifest
  store.js      Local JSON store (auto) or Supabase (when configured)
  pubsub.js     In-memory pub/sub → browser via Server-Sent Events
public/
  index.html    Dashboard shell
  app.js        Front-end controller (vanilla JS, no build step)
  style.css     Dark gamer theme
scripts/
  ps5.sh        PS5 discovery + remote-play pairing + HLS relay (chiaki-ng)
```

---

## API (quick reference)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/status` | health ✓ |
| POST | `/api/videos/upload` | upload (multipart `file`) |
| POST | `/api/videos/:id/analyze` | probe + issues + highlights |
| POST | `/api/videos/:id/fix` | fix & master (`{maxHeight}`) |
| POST | `/api/videos/:id/clips` | cut clips (`{moments:[{at,duration,vertical}]}`) |
| GET | `/api/videos/:id/file` | download processed video |
| GET | `/api/videos/:id/thumb` | JPEG thumbnail |
| POST | `/api/publish` | publish to platforms |
| GET | `/api/autopilot/status` | live status |
| POST | `/api/autopilot/start` / `stop` | run the bot |
| GET | `/api/events` | SSE stream (video/job/chat/reply/log) |

---

## Roadmap (suggestions welcome!)

- [ ] **TikTok auto-upload** once official API approval lands (or phone-pairing bridge)
- [ ] **Whisper captions** (free, open-source) — auto-transcribe & burn-in subtitles
- [ ] **GPT/Claude/Gemini brain swap** — one function in `brain.js`
- [ ] **!clip → auto-cut the last 30s live** and post to Shorts right after stream
- [ ] YouTube Shorts + Instagram Reels + X/Twitter in the publish matrix
- [ ] Uploads to **Supabase Storage** for big files + multi-device
- [ ] View-count/donations dashboard; TikTok gift shout-outs

## Legal & safety
Respect each platform's ToS. TikTok posting still needs their approval; live-chat reading uses a
community client and should stay within rate limits. Keep your OAuth tokens private (`.env` and
`./data/` are git-ignored).
