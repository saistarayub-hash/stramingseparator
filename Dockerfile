# StreamPilot — run-anywhere container (zero-cost tier friendly).
#
# FFmpeg/FFprobe ship as bundled static binaries via @ffmpeg-installer, so no
# system ffmpeg is needed. Python is only for optional local Whisper captions.
FROM node:20-bookworm-slim

# python + venv for faster-whisper, ca-certs + curl for the healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# faster-whisper for local, private auto-captions (model downloads on first use).
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir faster-whisper
ENV PYTHON=/opt/venv/bin/python3 \
    PATH="/opt/venv/bin:${PATH}"

WORKDIR /app

# Install dependencies (cached unless package*.json changes).
COPY package*.json ./
RUN npm ci --omit=dev

# Application code.
COPY server ./server
COPY public ./public
COPY scripts ./scripts

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
