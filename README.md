# 🎮 StreamPilot — *game once, post everywhere*

StreamPilot is a personal **cross-platform autopilot** for gaming creators. You record your
gameplay, drop it in, and it:

1. **Analyzes** the video (resolution, codecs, loudness, action moments)
2. **Auto-fixes** it for broadcast/web — H.264 faststart, loudness-normalized to -14 LUFS
3. **Cuts vertical clips** (1080×1920) from the best moments for TikTok/Shorts
4. **Publishes** the long video to **YouTube** (OAuth, resumable upload) from one button
5. **Runs your live chat** on **YouTube + TikTok + Twitch + Kick** simultaneously (link them all
   once in **Connections**) — greeting fans, answering FAQs, and reacting to `!clip` — all
   automatic, with a manual override.
6. **Clips your live stream into Shorts/TikToks mid-game** — record a live source (YouTube Live,
   HLS, **TikTok from your phone**, or your **PS5 via remote play — no capture card**) into a
   rolling buffer, then hit one button to turn the last 10–60 seconds into a titled, vertical clip.

> **Free-tier-first + cloud-ready:** **FFmpeg** (open source), **YouTube Data API** (free 10k
> quota/day), **TikTokLive** (community connector), and **Appwrite** (free cloud tier) for
> storage + database. When Appwrite isn't connected yet, everything runs on a local JSON store —
> you can use the whole app with zero setup.

---

## Quick start

```bash
npm install
npm start
# → open http://localhost:8787
```

Everything works **locally out of the box** (data lives in `./data/`). Upload → analyze → fix →
clip needs no keys. Publishing and live chat need their platform keys (below).

---

## ☁️ Connect to Appwrite (90 seconds, free tier)

The dashboard is wired for an Appwrite backend at **https://nyc.cloud.appwrite.io/v1**.

1. Create a project at [cloud.appwrite.io](https://cloud.appwrite.io) (NYC region → your endpoint
   is `https://nyc.cloud.appwrite.io/v1`).
2. **Overview → API Keys → Create API key** → name it `StreamPilot` → give it *all* scopes
   (or at least `databases.*` and `storage.*`) → copy the key.
3. In StreamPilot: **Settings → Cloud** → paste your **Project ID** + **API key** → **Connect**.

StreamPilot then **auto-creates** everything on your project:
- Database `streampilot` with collections `videos`, `publishes`, `settings`
- Storage bucket `videos` (20 GB max file) — gameplay, fixed videos and clips are mirrored there
  automatically, so they get public URLs and survive restarts.

> **API key safety:** use a **server-side** key only (the dashboard runs on your own machine).
> `.env` overrides are available too: `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`,
> `APPWRITE_API_KEY`.

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

### 5. Connections 🔗 — link all your accounts
The **Connections** tab is your account hub. Link each platform once, and both the **Publish**
matrix and the **Live Autopilot** pick them up automatically:

| Platform | What it unlocks | Needs |
|---|---|---|
| **YouTube** | uploads + live-chat autopilot | Google OAuth (free) |
| **TikTok** | live capture + live chat | your @username (no key) |
| **Twitch** | live chat reading & auto-replies | channel name (read-only works with zero keys; add a bot token to reply) |
| **Kick** | live chat reading (real time, Pusher) | channel name (read-only) |

*Coming next:* Instagram, X/Twitter, Discord, Facebook Gaming — tell us which you want first!

### 6. Live Autopilot
Start it with any mix of a **YouTube video/live ID**, **TikTok @username**, **Twitch channel**,
and/or **Kick channel**. It:
- attaches to YouTube live chat (via Data API) and polls in real time
- listens to TikTok live chat (via TikTokLive connector)
- reads Twitch chat via tmi.js (anonymous read, or your bot for replies)
- reads Kick chat via its Pusher websocket (read-only for now)
- runs every message through the brain: greetings, "what game?", GG/win, schedule, donation,
  socials, `!clip`, plus your custom FAQs (Settings)
- replies wherever it can (YouTube + TikTok + Twitch with a bot token); you can also send
  manual replies as the bot on any platform

### 7. Live Clips (Shorts/TikTok mid-stream) ✂️
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

### 8. Auto-edit + auto-copy ✨
Every clip/VOD can now be **fully auto-produced** — no manual writing:

- **✂️ Auto-clip from chat:** with Live Autopilot running, anyone typing `!clip` (or
  `!clip 30s THAT PLAY`) in YouTube/TikTok chat triggers an automatic cut of the last moment.
- **✨ Auto-edit:** the clip is cut, **auto-captioned** (local Whisper), a title lower-third is
  burned in, and it's rendered vertical 9:16 — all automatic.
- **📝 Auto-copy:** every clip/VOD gets a **title, description and hashtags** auto-written from
  your game + stream context (extend it in Settings). Publishing auto-fills them when you don't
  type your own.

#### Auto-captions setup (free + private, runs on your machine)
```bash
python3 -m venv .venv && source .venv/bin/activate
pip install faster-whisper
# then in Settings or .env:  SP_WHISPER_MODEL=small   (tiny|base|small|medium|large-v3)
```
First transcription downloads the model once (~500 MB for `small`) to `~/.cache`, then it's
cached. No data leaves your machine. If Whisper isn't installed, StreamPilot still works —
captions are simply skipped and the clip is cut without them.

---

## 🚀 Run it almost anywhere

StreamPilot is a single Node service, so it runs anywhere Node runs. Here's the fast path.

### Docker (any machine with Docker)
```bash
cp .env.example .env      # then fill in your YOUTUBE_* keys (optional)
docker compose up --build
# → open http://localhost:8787
```
Videos + settings live in the `streampilot-data` volume, so they survive restarts.

### Render (one-click cloud deploy)
1. Push this repo to GitHub.
2. [render.com](https://render.com) → **New + → Blueprint** → pick your repo.
3. `render.yaml` spins up the web service on the **Docker runtime** with a 10 GB persistent disk
   at `/app/data`, plus health checks. Add your `YOUTUBE_*` env vars (and optionally
   `APPWRITE_*`) in the Render dashboard.
4. Set `APP_URL` to `https://<your-app>.onrender.com` and add that URL's OAuth redirect
   (`https://<your-app>.onrender.com/auth/youtube/callback`) in Google Cloud Console.

> **Fly.io / Railway / any VPS:** it's just `node server/index.js` — set `PORT`, `DATA_DIR`
> (persistent disk), and `APP_URL`. A `Dockerfile` is included for containers.

---

## Configuration

Copy `.env.example` to `.env` and fill in what you use:

```bash
# Optional — cloud persistence + database (Appwrite)
APPWRITE_ENDPOINT=https://nyc.cloud.appwrite.io/v1
APPWRITE_PROJECT_ID=
APPWRITE_API_KEY=

# YouTube upload + live chat (Google Cloud Console)
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REDIRECT_URI=http://localhost:8787/auth/youtube/callback

# Twitch chat (optional — read works with no keys)
TWITCH_CHANNEL=
TWITCH_BOT_USER=
TWITCH_BOT_OAUTH=

# Kick chat (read-only, no key)
KICK_CHANNEL=

PORT=8787
SESSION_SECRET=change-me-to-a-long-random-string
APP_URL=http://localhost:8787
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
  twitch.js     Twitch chat connector (tmi.js — anonymous read + bot replies)
  kick.js       Kick chat connector (dependency-free Pusher websocket, read-only)
  connections.js Connection hub: aggregates all platforms for UI + autopilot
  brain.js      Reply brain: intents, FAQs, templated replies
  autopilot.js  Orchestrates all platforms + brain + sending replies
  liveclip.js   Live recorder (rolling buffer) + clip/cut engine + PS5 orchestration
  live/         youtube-source.cjs — resolve a YouTube live id → HLS manifest
  store.js      Storage facade: Appwrite cloud (auto) or local JSON fallback
  appwrite.js   Appwrite SDK wrapper + schema bootstrap + file mirroring
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
| GET | `/api/connections` | account hub status (YouTube/TikTok/Twitch/Kick) |
| POST | `/api/connections/twitch` / `kick` | save Twitch/Kick config |
| POST | `/api/connections/chat/test` | live chat connect test |
| GET | `/api/autopilot/status` | live status |
| POST | `/api/autopilot/start` / `stop` | run the bot (youtube + tiktok + twitch + kick) |
| POST | `/api/autopilot/say` | manual bot reply (`{platform, text}`) |
| GET | `/api/events` | SSE stream (video/job/chat/reply/log) |

---

## Roadmap (suggestions welcome!)

- [ ] **TikTok auto-upload** once official API approval lands (or phone-pairing bridge)
- [ ] **Whisper captions** (free, open-source) — auto-transcribe & burn-in subtitles
- [ ] **GPT/Claude/Gemini brain swap** — one function in `brain.js`
- [ ] **!clip → auto-cut the last 30s live** and post to Shorts right after stream
- [ ] YouTube Shorts + Instagram Reels + X/Twitter in the publish matrix
- [x] **Appwrite cloud** storage + database (auto-mirrors videos/clips) ✨
- [ ] View-count/donations dashboard; TikTok gift shout-outs

## Legal & safety
Respect each platform's ToS. TikTok posting still needs their approval; live-chat reading uses a
community client and should stay within rate limits. Keep your OAuth tokens private (`.env` and
`./data/` are git-ignored).
