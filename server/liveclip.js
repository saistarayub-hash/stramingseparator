// Live clip engine.
//
// Ways to grab live moments → Shorts/TikTok clips:
//   1. RECORDER — FFmpeg ingests any live stream URL (YouTube Live, HLS from
//      a PS5/remote-play relay, OBS, RTMP…), keeps a keyframe-aligned rolling
//      segment buffer, and can clip + cut the last N seconds without re-encode.
//   2. PS5   —   scripts/ps5.sh on the same LAN as the console discovers it,
//      performs the remote-play handshake, and relays the screen to a local
//      HLS endpoint which we record and clip. See that script for setup.
//   3. YOUTUBE LIVE — the anchor's own live video id resolves to an HLS
//      manifest via the bundled youtube-source helper.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

import { uid, videos } from './store.js';
import { renderClip, probe } from './ffmpeg.js';
import { emit } from './pubsub.js';
import { generateCaptions, captionsForWindow } from './captions.js';
import { generateCopy } from './copybrain.js';

const require = createRequire(import.meta.url);
const { fetchYouTubeLiveHls } = require('./live/youtube-source.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
export const CLIP_DIR = path.join(DATA_DIR, 'clips');

const SEGMENT_SECONDS = 2; // slice size for the rolling buffer
const KEEP_SEGMENTS = 80;  // rolling window: ~160s of buffer (max 60s clip from up to 60s ago)

// ------------------------------------------------------------------ helpers
const ffbin = () => require('@ffmpeg-installer/ffmpeg').path;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const segNum = (f) => parseInt((String(f).match(/(\d+)\.ts$/) || [])[1] || '0', 10);
const listTs = (dir) => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.ts')).sort((a, b) => segNum(a) - segNum(b));
  } catch { return []; }
};

/** Real per-segment durations (cached). Segments cut at keyframes, so they are
 *  rarely exactly SEGMENT_SECONDS long — plain `index * 2` math drifts badly. */
const durCache = new Map();
async function segDuration(file) {
  if (durCache.has(file)) return durCache.get(file);
  let d = SEGMENT_SECONDS;
  try { d = (await probe(file)).duration || SEGMENT_SECONDS; } catch { /* assume nominal */ }
  durCache.set(file, d);
  return d;
}

/** Drop the oldest segments once the buffer outgrows the rolling window. */
function pruneSegments(dir) {
  try {
    const files = listTs(dir);
    if (files.length <= KEEP_SEGMENTS) return;
    for (const f of files.slice(0, files.length - KEEP_SEGMENTS)) {
      const p = path.join(dir, f);
      durCache.delete(p);
      try { rmSync(p); } catch { /* racing the writer — fine */ }
    }
  } catch { /* keep recording whatever happens to cleanup */ }
}

function hasWriteableFile(dir) {
  try {
    const files = listTs(dir);
    return files.length > 0 && files.some((f) => statSync(path.join(dir, f)).size > 4096);
  } catch { return false; }
}

function runSpawn(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('ffmpeg (copy) failed: ' + err.split('\n').slice(-8).join(' ')));
    });
  });
}

// ------------------------------------------------------------------ state
let current = null;

export function status() {
  if (!current) return null;
  return {
    id: current.id,
    source: current.source,
    running: current.running,
    createdAt: current.createdAt,
    lastDone: current.lastDone,
    processed: current.processed || 0,
    haveWriteable: current.haveWriteable || false,
    error: current.error || null,
  };
}

function emitStatus() {
  emit('liveclip', { type: 'status', ...(status() || { running: false }) });
}

// ------------------------------------------------------------------ recorder
/**
 * Start recording a live source URL into a rolling segment buffer.
 * @param {string} sourceUrl any URL FFmpeg can open: m3u8, rtmp://, http://…,
 *                 or a YouTube videoid/watch/live URL.
 */
export async function startRecorder(sourceUrl) {
  stopRecorder();
  const url = String(sourceUrl || '').trim();
  if (!url) throw new Error('No source URL given.');

  const sourceType = detectSourceType(url);
  const resolvedUrl = await resolveInputUrl(url);

  const id = `live-${Date.now().toString(36)}`;
  const dir = path.join(CLIP_DIR, id);
  mkdirSync(dir, { recursive: true });

  const rec = {
    id, source: sourceType, url: resolvedUrl, dir,
    proc: null, createdAt: Date.now(), lastDone: 0, running: true,
    processed: 0, haveWriteable: false, error: null,
  };
  current = rec;

  const args = [
    '-hide_banner', '-loglevel', 'info',
    '-i', resolvedUrl,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'copy',                   // no re-encode; cut at keyframes
    '-c:a', 'copy',
    '-f', 'segment',
    '-segment_time', String(SEGMENT_SECONDS),
    '-reset_timestamps', '1',
    '-sc_threshold', '0',
    path.join(dir, 'clip%03d.ts'),
  ];

  rec.proc = spawn(ffbin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let logBuffer = '';
  let lastEmitTs = 0;
  const handleLine = (line) => {
    const time = line.match(/time=([0-9:.]+)/);
    if (time) {
      rec.lastDone = parseTs(time[1]);
      rec.running = true;
      const now = Date.now();
      if (now - lastEmitTs > 3000) { lastEmitTs = now; emitStatus(); }
    }
    const opening = line.match(/Opening '([^']+\.ts)'/);
    if (opening) {
      rec.haveWriteable = true;
      pruneSegments(dir);
    }
  };

  const attach = (stream) => {
    stream.on('data', (d) => {
      logBuffer += d.toString();
      const lines = logBuffer.split('\n');
      logBuffer = lines.pop();
      for (const line of lines) if (line.trim()) handleLine(line);
    });
  };
  attach(rec.proc.stdout);
  attach(rec.proc.stderr);

  rec.proc.on('error', (e) => { rec.error = e.message; rec.running = false; emitStatus(); });
  rec.proc.on('close', (code) => {
    rec.running = false;
    rec.haveWriteable = hasWriteableFile(dir);
    rec.error = code === 0 ? null : 'Recorder stopped (source may have ended).';
    emitStatus();
  });

  // watchdog: if -c copy stalls on malformed TS, we still see files appearing
  rec.watchTimer = setInterval(() => {
    if (!current || current.id !== id) return;
    rec.haveWriteable = hasWriteableFile(dir);
    emitStatus();
  }, 4000);

  await new Promise((r) => setTimeout(r, 2500));
  rec.haveWriteable = hasWriteableFile(dir);
  emitStatus();
  return status();
}

async function resolveInputUrl(url) {
  const trimmed = String(url || '').trim();
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);

  // 1. TikTok profile / @username / profile URL → live stream URL (phone source).
  //    (Only for inputs with no scheme at all, or an http(s) tiktok.com link.)
  if ((!hasScheme && !/^[A-Za-z0-9_-]{11}$/.test(trimmed)) || /tiktok\.com/i.test(trimmed)) {
    const { fetchLiveInfo } = await import('./tiktok.js');
    const info = await fetchLiveInfo(trimmed);
    if (!info.isLive) throw new Error(`@${info.uniqueId} is not live right now. (Or make the stream public — private/sub-only streams can't be recorded.)`);
    const best = info.streamUrls[0] || null;
    if (!best) throw new Error('TikTok is live, but no capturable stream URL was returned. Try again in a minute.');
    return best;
  }

  // 2. YouTube live id / watch / live URL
  if (/youtube\.com|youtu\.be/i.test(trimmed) || /^[A-Za-z0-9_-]{11}$/.test(trimmed)) {
    const idPart = (trimmed.match(/(?:v=|live\/|youtu\.be\/|\/shorts\/)([A-Za-z0-9_-]{11})/) || trimmed.match(/^([A-Za-z0-9_-]{11})$/) || [null, trimmed])[1];
    try {
      const hls = await fetchYouTubeLiveHls(idPart);
      if (hls) return hls;
      throw new Error('No live HLS found (is it live & public?).');
    } catch (e) {
      throw new Error('Could not resolve YouTube live: ' + (e.message || e));
    }
  }

  // 3. Anything else FFmpeg can open directly (m3u8, rtmp://, http ts, file…)
  return trimmed;
}

function parseTs(s) {
  if (!s) return 0;
  const p = s.split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : 0;
}

/** Classify a source string for the UI: 'tiktok' | 'youtube' | 'ps5' | 'url'. */
export function detectSourceType(input) {
  const s = String(input || '').trim();
  if (s.startsWith('@')) return 'tiktok';
  if (/tiktok\.com/i.test(s)) return 'tiktok';
  if (/youtube\.com|youtu\.be/i.test(s) || /^[A-Za-z0-9_-]{11}$/.test(s)) return 'youtube';
  if (/^http:\/\/localhost/i.test(s) && /ps5/i.test(s)) return 'ps5';
  return 'url';
}

/**
 * Resolve a human input (@user / TikTok link / YouTube id / URL) into
 * metadata + a capture-ready source URL, without starting a recording.
 * Drives the Live Clips "check source" button.
 */
export async function inspectSource(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('Enter a source first.');
  const type = detectSourceType(s);
  const resolved = await resolveInputUrl(s);
  let detail = null;
  if (type === 'tiktok') {
    const { fetchLiveInfo } = await import('./tiktok.js');
    const info = await fetchLiveInfo(s);
    detail = {
      title: info.title,
      viewers: info.viewerCount,
      isLive: info.isLive,
      size: info.streamSize,
    };
  }
  return { type, resolvedUrl: resolved, detail };
}

export function stopRecorder() {
  if (!current) return;
  if (current.watchTimer) clearInterval(current.watchTimer);
  if (current.proc) { try { current.proc.kill('SIGKILL'); } catch {} }
  current = null;
  emitStatus();
}

// ------------------------------------------------------------------ live clip
async function ensureBufferReady() {
  const guard = Date.now();
  while (!current?.haveWriteable && Date.now() - guard < 30000) {
    await new Promise((r) => setTimeout(r, 500));
    if (current) current.haveWriteable = hasWriteableFile(current.dir);
  }
  if (!current?.haveWriteable) throw new Error('Buffer is still empty. Check the source is actually live.');
}

/**
 * Cut a moment from the live buffer.
 * @param {object} o { offset=25, duration=20, title, label, captions=[], vertical=true }
 * offset = seconds before the live edge the moment started.
 */
export async function cutLiveClip(o = {}) {
  if (!current) throw new Error('No live recording active.');
  await ensureBufferReady();

  const { offset = 25, duration = 20, title = null, label = null, captions = [], vertical = true } = o;
  const end = clamp(current.lastDone - 2, 2, current.lastDone); // margin from live edge
  const start = Math.max(0, end - Number(offset));
  const dur = clamp(Number(duration) || 20, 2, 60);

  // 1) join rolling segments into one continuous window, trimmed to start..end
  const windowPath = path.join(current.dir, 'window.ts');
  await buildWindow(current.dir, windowPath, start, end);

  // 2) render to a platform-ready vertical MP4 (title/captions optional)
  const clipId = uid();
  const outPath = path.join(CLIP_DIR, `${clipId}.mp4`);
  await renderClip(windowPath, outPath, { start: 0, duration: dur, vertical, title, captions }, (p) =>
    emit('liveclip', { type: 'render', clipId, ...p }));

  const p = await probe(outPath);
  const vodName = (label || title || 'Live clip');
  const vod = await videos.set(clipId, {
    name: vodName,
    diskPath: outPath,
    fixedPath: outPath,
    stage: 'clipped',
    source: 'live',
    liveOffset: start,
    liveDuration: dur,
    info: { duration: p.duration, width: p.width, height: p.height, hasAudio: p.hasAudio, loudness: null },
    clips: [], highlights: [], issues: [{ type: 'ok', text: 'Cut from live stream.' }],
    createdAt: new Date().toISOString(),
  });

  current.processed = (current.processed || 0) + 1;
  emit('liveclip', { type: 'cut', videoId: clipId, name: vodName, duration: p.duration, offset, liveOffset: start });
  emitStatus();
  try { rmSync(windowPath); } catch {}
  return vod;
}

/** Trim the rolling segments down to [start..end] and concat into outPath. */
async function buildWindow(dir, outPath, start, end) {
  const files = listTs(dir);
  if (!files.length) throw new Error('Buffered data is empty — is the source actually streaming?');

  // Real timeline from actual segment durations (see segDuration) — segments
  // are cut at keyframes so their lengths vary; time math must match content.
  const timeline = [];
  let t = 0;
  for (const f of files) {
    const d = await segDuration(path.join(dir, f));
    timeline.push({ f, start: t, end: t + d });
    t += d;
  }

  const chosen = timeline.filter((s) => s.end > start && s.start < end);
  if (!chosen.length) chosen.push(timeline[timeline.length - 1]);

  const firstTrim = Math.max(0, start - chosen[0].start);
  const keepLen = (end - start);

  // concat demuxer (stream copy) — list file drives ffmpeg
  const listPath = path.join(dir, 'concat-list.txt');
  const listLines = chosen.map((s) => `file '${path.join(dir, s.f)}'`).join('\n');
  writeFileSync(listPath, listLines);

  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath];
  if (firstTrim > 0) args.push('-ss', firstTrim.toFixed(3));
  args.push('-t', Math.max(1, keepLen).toFixed(3), '-c', 'copy', '-f', 'mpegts', '-y', outPath);
  await runSpawn(ffbin(), args);
  try { rmSync(listPath); } catch {}
}

// ------------------------------------------------------------------ auto-edit
/** Guard so we never run two auto-builds at once. */
let autoBuilding = false;

/**
 * Auto-edit a moment: cut the last `offset` seconds, transcribe (local Whisper),
 * burn captions + title, and generate title/description/hashtags.
 * @returns the saved video record with copy + captions attached.
 */
export async function autoBuildClip({
  offset = 25, duration = 20, title = null, label = null, vertical = true,
  captions = true, model = null,
} = {}) {
  if (!current) throw new Error('No live recording active.');
  if (autoBuilding) throw new Error('An auto-edit is already running — one moment.');
  autoBuilding = true;
  try {
    await ensureBufferReady();

    const end = clamp(current.lastDone - 2, 2, current.lastDone);
    const start = Math.max(0, end - Number(offset));
    const dur = clamp(Number(duration) || 20, 2, 60);

    // 1) window from the rolling buffer
    const windowPath = path.join(current.dir, 'window.ts');
    await buildWindow(current.dir, windowPath, start, end);
    emit('liveclip', { type: 'auto', step: 'cut', offset, duration: dur });

    // 2) transcribe (free, local) — if audio exists and captions wanted
    let captionList = [];
    let transcriptionError = null;
    if (captions) {
      emit('liveclip', { type: 'auto', step: 'transcribe' });
      try {
        const tr = await generateCaptions(windowPath, { model });
        if (tr.error) throw new Error(tr.error);
        captionList = captionsForWindow(tr.captions, 0, dur);
        emit('liveclip', { type: 'auto', step: 'captions', count: captionList.length });
      } catch (e) {
        transcriptionError = e.message;
        emit('log', { level: 'warn', msg: 'Auto-captions unavailable: ' + e.message });
      }
    }

    // 3) render with title + captions burned in
    emit('liveclip', { type: 'auto', step: 'render' });
    const clipId = uid();
    const outPath = path.join(CLIP_DIR, `${clipId}.mp4`);
    await renderClip(windowPath, outPath, { start: 0, duration: dur, vertical, title, captions: captionList }, (p) =>
      emit('liveclip', { type: 'render', clipId, ...p }));

    const p = await probe(outPath);

    // 4) generate the marketing copy
    const copy = await generateCopy({ kind: 'clip', customTitle: title || undefined, titleSeed: label || title || undefined, extra: 'Auto-captioned & cut by StreamPilot ✂️' });

    const vodName = (label || title || 'Auto clip');
    const vod = await videos.set(clipId, {
      name: vodName,
      diskPath: outPath,
      fixedPath: outPath,
      stage: 'clipped',
      source: 'auto',
      liveOffset: start,
      liveDuration: dur,
      info: { duration: p.duration, width: p.width, height: p.height, hasAudio: p.hasAudio, loudness: null },
      clips: [], highlights: [],
      issues: [
        { type: 'ok', text: 'Cut automatically from live stream.' },
        ...(captionList.length ? [{ type: 'ok', text: `${captionList.length} captions burned in.` }] : []),
        ...(transcriptionError ? [{ type: 'warn', text: 'Captions skipped: ' + transcriptionError }] : []),
      ],
      copy,
      captions: captionList,
      createdAt: new Date().toISOString(),
    });

    // 5) mirror to cloud (when Appwrite is active) — via store
    try {
      const { mirrorToCloud } = await import('./store.js');
      const m = await mirrorToCloud({ videoId: clipId, filePath: outPath, name: vodName + '.mp4' });
      if (m) vod.viewUrl = m.viewUrl;
    } catch { /* cloud optional */ }

    current.processed = (current.processed || 0) + 1;
    emit('liveclip', {
      type: 'auto', step: 'done', videoId: clipId, name: vodName,
      offset, duration: p.duration, copy, captions: captionList.length,
      ...(transcriptionError ? { warn: 'Captions skipped: ' + transcriptionError } : {}),
    });
    emitStatus();
    try { rmSync(windowPath); } catch {}
    return vod;
  } finally {
    autoBuilding = false;
  }
}

/** Chat-triggered builds: accepts the user's message, returns true if handled. */
export function handleAutoClipChat(message) {
  const text = String(message?.text || '').toLowerCase();
  if (text.startsWith('!clip') || text === 'clip that' || text === 'clip it') {
    // optional duration/label: "!clip 30s WAS THAT A HACK"
    const durMatch = text.match(/(\d{2})s/);
    const duration = durMatch ? clamp(parseInt(durMatch[1], 10), 5, 60) : 25;
    const labelMatch = text.match(/!clip\s+\d*s?\s+(.+)/);
    const label = labelMatch ? labelMatch[1].trim().slice(0, 40) : null;
    const offset = duration + 5;

    autoBuildClip({ offset, duration, title: label }).then((vod) => {
      emit('autoclip', { from: message?.author, videoId: vod.id, name: vod.name, copy: vod.copy });
    }).catch((e) => {
      emit('log', { level: 'error', msg: 'Auto-clip failed: ' + e.message });
      emit('autoclip', { from: message?.author, error: e.message });
    });
    return { clipped: true, requestedBy: message?.author };
  }
  return { clipped: false };
}

/**
 * PS5 companion: launch capture + relay, returning an HLS URL for the recorder.
 * Requires the setup in scripts/ps5.sh.
 */
export async function startPs5({ accountId, pin = '0000000', nick = 'StreamPilot', httpPort = 8080 }) {
  if (!accountId) throw new Error('PS5 account-id is required (from npso webfront, see README).');
  const script = path.join(__dirname, 'scripts', 'ps5.sh');
  if (!existsSync(script)) throw new Error('PS5 helper missing — ensure scripts/ps5.sh is present.');

  const proc = spawn('bash', [script, 'start', String(accountId).toUpperCase()], {
    env: { ...process.env, PS5_PIN: String(pin || '0000000'), PS5_NICK: String(nick || 'StreamPilot'), PS5_HLS_PORT: String(httpPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => (out += d.toString()));
  proc.stderr.on('data', (d) => (out += d.toString()));
  proc.on('close', (code) => emit('liveclip', { type: 'ps5', state: code === 0 ? 'stopped' : 'exited', log: out.slice(-2000) }));

  await new Promise((r) => setTimeout(r, 8000));
  const hlsUrl = `http://localhost:${httpPort}/ps5/index.m3u8`;
  emit('liveclip', { type: 'ps5', state: 'relay-ready', hlsUrl });
  return hlsUrl;
}
