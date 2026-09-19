# StreamPilot — run anywhere container.
# Node runtime + ffmpeg (for fix/clip/render) + Python + pip (for faster-whisper captions).

##### Stage 1 — build (optional native bits) #####
FROM node:20-bookworm-slim AS build

##### Stage 2 — runtime #####
FROM node:20-bookworm-slim

# FFmpeg (real system ffmpeg; @ffmpeg-installer binaries also ship in node_modules)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-venv \
    python3-pip \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# faster-whisper for local, private auto-captions (small model on demand)
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir faster-whisper
ENV PYTHON=/opt/venv/bin/python3 \
    PATH="/opt/venv/bin:${PATH}"

WORKDIR /app

# Install dependencies (cached unless package*.json changes)
COPY package*.json ./
RUN npm ci --omit=dev

# Application code
COPY server ./server
COPY public ./public
COPY scripts ./scripts

# Persistent state (videos, settings) lives here; mount a volume over it.
ENV DATA_DIR=/app/data \
    PORT=8787 \
    NODE_ENV=production

RUN mkdir -p /app/data
VOLUME /app/data

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:8787/api/status || exit 1

CMD ["node", "server/index.js"]
