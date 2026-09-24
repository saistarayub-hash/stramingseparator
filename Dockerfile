# StreamPilot — run-anywhere container (zero-cost tier friendly).
#
# FFmpeg/FFprobe ship as bundled static binaries via @ffmpeg-installer, so no
# system ffmpeg is needed. Python is only for optional local Whisper captions.
FROM node:20-bookworm-slim

# python + venv for faster-whisper, ca-certs + curl for the healthcheck.
# fonts-dejavu-core: drawtext (burned titles/captions) hard-fails with
# "Cannot find a valid font" on slim images — captions need an actual TTF.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    fonts-dejavu-core \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# faster-whisper for local, private auto-captions.
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir faster-whisper
ENV PYTHON=/opt/venv/bin/python3 \
    PATH="/opt/venv/bin:${PATH}"

# Pre-fetch the tiny Whisper model so the first auto-edit starts instantly
# instead of downloading mid-clip. Bigger models (SP_WHISPER_MODEL=base/small/…)
# still download on demand at runtime.
RUN /opt/venv/bin/python3 -c "from faster_whisper import WhisperModel; WhisperModel('tiny', device='cpu', compute_type='int8')"

WORKDIR /app

# Install dependencies (cached unless package*.json changes).
COPY package*.json ./
RUN npm ci --omit=dev

# Application code.
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY assets ./assets

# Persistent state (videos, clips, settings) — mount a volume here.
ENV DATA_DIR=/app/data \
    PORT=8787 \
    NODE_ENV=production

RUN mkdir -p /app/data
VOLUME /app/data

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:8787/api/status || exit 1

CMD ["node", "server/index.js"]
