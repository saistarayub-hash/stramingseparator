// Resolve a YouTube live video id → its HLS manifest URL.
// No official API required. On networks that can reach YouTube, the manifest
// is embedded in the player response (or watch page ytInitialPlayerResponse).
// Try order: youtubei player API → watch page scrape → embedded web player.

'use strict';

const INNERTUBE_API = 'https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const INNERTUBE_CTX = () => JSON.stringify({
  context: { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00' } },
  videoId: null,
  contentCheckOk: true,
  racyCheckOk: true,
});

async function httpGet(url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      ...headers,
    },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

function extractHls(body) {
  const re = /"hlsManifestUrl"\s*:\s*"(https:[^"]+)"/;
  const m = body.match(re);
  return m ? m[1].replace(/\\u0026/g, '&') : null;
}

async function tryPlayer(videoId) {
  const ctx = JSON.parse(INNERTUBE_CTX());
  ctx.videoId = videoId;
  const res = await fetch(INNERTUBE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify(ctx),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const body = await res.text();
  return extractHls(body);
}

async function tryWatchPage(videoId) {
  const html = await httpGet(`https://www.youtube.com/watch?v=${videoId}`);
  const hls = extractHls(html);
  if (hls) return hls;
  const inner = html.match(/ytInitialPlayerResponse\s*=\s*(\{.*?\});/s);
  if (inner) {
    try { return extractHls(JSON.stringify(JSON.parse(inner[1].replace(/&#\d+;/g, '')))); } catch {}
  }
  return null;
}

async function tryEmbed(videoId) {
  const html = await httpGet(`https://www.youtube.com/embed/${videoId}`);
  const hls = html.match(/"hlsManifestUrl":"(https:[^"]+)"/);
  return hls ? hls[1] : null;
}

async function fetchYouTubeLiveHls(videoId) {
  const id = String(videoId || '').trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('Not a valid YouTube video id: ' + id);
  const tries = [tryPlayer, tryWatchPage, tryEmbed];
  for (const fn of tries) {
    try {
      const hls = await fn(id);
      if (hls) return hls;
    } catch {
      // keep trying other methods
    }
  }
  return null;
}

module.exports = { fetchYouTubeLiveHls };
