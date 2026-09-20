import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  probe, fixVideo, measureLoudness, detectHighlights, cutClip, ffmpegPath, ffprobePath,
} from './ffmpeg.js';
import {
  videos, jobs, publishes, getSettings, saveSettings, uid,
  initStore, reinitStore, usingCloud, mirrorToCloud, getCloudError, selfHealCloud,
  saveAppwriteCreds, readAppwriteCredsFile,
} from './store.js';
import { isConfigured, appwriteConfig, DEFAULT_ENDPOINT } from './appwrite.js';
import * as yt from './youtube.js';
import * as autopilot from './autopilot.js';
import * as liveclip from './liveclip.js';
import * as twitch from './twitch.js';
import * as kick from './kick.js';
import * as connections from './connections.js';
import { emit } from './pubsub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const OUTPUT_DIR = path.join(DATA_DIR, 'outputs');

for (const d of [DATA_DIR, UPLOADS_DIR, OUTPUT_DIR, PUBLIC_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 * 1024 }, // up to 20GB (disk permitting)
});

// ------------------------------------------------------------------- helpers
const sc = (res, fn) =>
  fn.then((d) => res.json(d)).catch((e) => {
    console.error(e);
    res.status(400).json({ error: e.message });
  });

function safeVid(v) {
  if (!v) return null;
  // Strip local-only fields for the client; keep cloud URLs when present.
  const { diskPath, fixedPath, ...rest } = v;
  return rest;
}

// ------------------------------------------------------------------- status
app.get('/api/status', (_req, res) => res.json({
  ok: true,
  cloud: usingCloud() ? 'appwrite' : 'local',
  appwriteConfigured: isConfigured(),
}));

// ------------------------------------------------------------------- videos
app.get('/api/videos', (_req, res) => sc(res, videos.list().then((l) => l.map(safeVid))));

app.post('/api/videos/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const filePath = req.file.path;
    const id = uid();
    const v = await videos.set(id, {
      name: req.file.originalname,
      diskPath: filePath,
      originalSize: req.file.size,
      stage: 'uploaded',
      createdAt: new Date().toISOString(),
    });
    emit('video', { id, name: v.name, stage: 'uploaded' });
    // In cloud mode, mirror the raw file to Appwrite now (background).
    if (usingCloud()) {
      runAsync(async () => {
        try { await mirrorToCloud({ videoId: id, filePath, name: req.file.originalname }); } catch (e) { console.error('mirror failed:', e.message); }
      });
    }
    res.json(safeVid(v));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/videos/:id', (req, res) => sc(res, videos.get(req.params.id).then(safeVid)));
app.delete('/api/videos/:id', async (req, res) => {
  const v = await videos.get(req.params.id);
  if (v?.diskPath) try { fs.unlinkSync(v.diskPath); } catch {}
  await videos.remove(req.params.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------- analysis / fix
app.post('/api/videos/:id/analyze', async (req, res) => {
  const v = await videos.get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Video not found' });
  try {
    await videos.set(v.id, { stage: 'analyzing' });
    emit('video', { id: v.id, stage: 'analyzing' });
    const p = await probe(v.diskPath);
    const loud = v.hasAudio === false ? null : await measureLoudness(v.diskPath).catch(() => null);
    const shots = await detectHighlights(v.diskPath).catch(() => []);
    const analyzed = {
      stage: 'analyzed',
      info: {
        duration: p.duration,
        width: p.width,
        height: p.height,
        fps: p.fps,
        videoCodec: p.videoCodec,
        audioCodec: p.audioCodec,
        audioChannels: p.audioChannels,
        hasAudio: p.hasAudio,
        bitrate: p.bitrate,
        sizeBytes: p.sizeBytes,
        loudness: loud,
        normalizes: loud && Math.abs((loud.integratedLufs ?? -14) + 14) > 1.5,
      },
      highlights: shots.slice(0, 50),
      issues: buildIssues(p, loud),
    };
    await videos.set(v.id, analyzed);
    emit('video', { id: v.id, stage: 'analyzed' });
    res.json(safeVid(await videos.get(v.id)));
  } catch (e) {
    await videos.set(v.id, { stage: 'error', error: e.message });
    emit('video', { id: v.id, stage: 'error', error: e.message });
    res.status(400).json({ error: e.message });
  }
});

function buildIssues(p, loud) {
  const issues = [];
  if (!p.hasVideo) issues.push({ type: 'error', text: 'No video stream detected.' });
  if (!p.hasAudio) issues.push({ type: 'warn', text: 'No audio stream — the clip will be silent.' });
  if (p.height < 360) issues.push({ type: 'warn', text: `Very low resolution (${p.width}×${p.height}).` });
  if (loud && loud.integratedLufs != null && Math.abs(loud.integratedLufs + 14) > 3) {
    issues.push({ type: 'info', text: `Audio is ${loud.integratedLufs.toFixed(1)} LUFS — will be normalized to -14 LUFS.` });
  }
  if (!issues.length) issues.push({ type: 'ok', text: 'Looks good! Ready to fix & tidy.' });
  return issues;
}

// ------------------------------------------------------------------- processing jobs
app.post('/api/videos/:id/fix', async (req, res) => {
  const v = await videos.get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Video not found' });
  const opts = { maxHeight: Number(req.body?.maxHeight) || 1080, maxDuration: req.body?.maxDuration || null };
  const jobId = uid();
  const outPath = path.join(OUTPUT_DIR, `${v.id}-fixed.mp4`);

  await jobs.set(jobId, { id: jobId, kind: 'fix', videoId: v.id, status: 'running', createdAt: new Date().toISOString() });
  await videos.set(v.id, { stage: 'fixing', fixJobId: jobId });
  emit('video', { id: v.id, stage: 'fixing' });
  res.json({ jobId });

  runAsync(async () => {
    try {
      const result = await fixVideo(v.diskPath, outPath, opts, (prog) => emit('job', { jobId, ...prog }));
      const p = await probe(outPath);
      await videos.set(v.id, {
        stage: 'fixed',
        fixedPath: outPath,
        fixedInfo: { duration: p.duration, width: p.width, height: p.height, sizeBytes: p.sizeBytes },
      });
      if (usingCloud()) {
        try { await mirrorToCloud({ videoId: v.id, filePath: outPath, name: (v.name || 'video').replace(/\.[^.]+$/, '') + '-fixed.mp4' }); } catch (e) { console.error('mirror fixed failed:', e.message); }
      }
      await jobs.set(jobId, { status: 'done' });
      emit('job', { jobId, status: 'done' });
      emit('video', { id: v.id, stage: 'fixed' });
    } catch (e) {
      await jobs.set(jobId, { status: 'error', error: e.message });
      await videos.set(v.id, { stage: 'error', error: e.message });
      emit('job', { jobId, status: 'error', error: e.message });
      emit('video', { id: v.id, stage: 'error', error: e.message });
    }
  });
});

app.post('/api/videos/:id/clips', async (req, res) => {
  const v = await videos.get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Video not found' });
  const src = v.fixedPath || v.diskPath;
  const moments = Array.isArray(req.body?.moments) && req.body.moments.length
    ? req.body.moments
    : (v.highlights || []).slice(0, 3).map((h) => ({ at: h.at, duration: 30 }));

  const jobId = uid();
  await jobs.set(jobId, { id: jobId, kind: 'clips', videoId: v.id, status: 'running', createdAt: new Date().toISOString() });
  await videos.set(v.id, { stage: 'clipping', clipJobId: jobId });
  emit('video', { id: v.id, stage: 'clipping' });
  res.json({ jobId, count: moments.length });

  runAsync(async () => {
    try {
      const clips = [];
      for (let i = 0; i < moments.length; i++) {
        const m = moments[i];
        const clipId = `${v.id}-clip-${i}`;
        const clipPath = path.join(OUTPUT_DIR, `${clipId}.mp4`);
        const start = Math.max(0, Number(m.at || 0) - 0.5);
        const duration = Math.min(60, Number(m.duration) || 30);
        await cutClip(src, clipPath, { start, duration, vertical: m.vertical !== false }, (prog) =>
          emit('job', { jobId, clip: i, ...prog }));
        const p = await probe(clipPath);
        let clipViewUrl = null;
        if (usingCloud()) {
          try {
            const { fileId, viewUrl } = await mirrorToCloud({ videoId: v.id, filePath: clipPath, name: `${clipId}.mp4` });
            clipViewUrl = viewUrl;
          } catch (e) { console.error('mirror clip failed:', e.message); }
        }
        clips.push({ id: clipId, start, duration, width: p.width, height: p.height, sizeBytes: p.sizeBytes, viewUrl: clipViewUrl || undefined });
      }
      await videos.set(v.id, { stage: 'clipped', clips });
      await jobs.set(jobId, { status: 'done', clips });
      emit('job', { jobId, status: 'done' });
      emit('video', { id: v.id, stage: 'clipped', count: clips.length });
    } catch (e) {
      await jobs.set(jobId, { status: 'error', error: e.message });
      await videos.set(v.id, { stage: 'error', error: e.message });
      emit('job', { jobId, status: 'error', error: e.message });
      emit('video', { id: v.id, stage: 'error', error: e.message });
    }
  });
});

// ------------------------------------------------------------------- files (download / serve)
app.get('/api/videos/:id/file', async (req, res) => {
  const v = await videos.get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Video not found' });
  const filePath = req.query.kind === 'original' ? v.diskPath : (v.fixedPath || v.diskPath);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found. Run Fix first.' });
  sendFileWithName(res, filePath);
});

app.get('/api/videos/:id/clips/:clipIdx/file', async (req, res) => {
  const v = await videos.get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Video not found' });
  const clipPath = path.join(OUTPUT_DIR, `${v.id}-clip-${req.params.clipIdx}.mp4`);
  if (!fs.existsSync(clipPath)) return res.status(404).json({ error: 'Clip not found' });
  sendFileWithName(res, clipPath);
});

function sendFileWithName(res, filePath) {
  const ext = path.extname(filePath);
  const mt = {
    '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime',
    '.webm': 'video/webm', '.jpg': 'image/jpeg', '.png': 'image/png',
  }[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', mt);
  res.sendFile(filePath);
}

// Thumbnail: first frame of the (original/fixed) video as JPEG, cached.
app.get('/api/videos/:id/thumb', async (req, res) => {
  try {
    const v = await videos.get(req.params.id);
    if (!v) return res.status(404).json({ error: 'Video not found' });
    const src = v.fixedPath || v.diskPath;
    const thumb = path.join(OUTPUT_DIR, `${v.id}.jpg`);
    if (!fs.existsSync(thumb)) {
      const { runBin } = await import('./ffmpeg.js');
      const { ffmpegPath: ffp } = await import('./ffmpeg.js');
      await runBin(ffp, ['-y', '-ss', '2', '-i', src, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '3', thumb]);
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.sendFile(thumb);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// ------------------------------------------------------------------- publishing
app.post('/api/publish', async (req, res) => {
  try {
    const { videoId, title, description, tags, privacy, clips, tiktokTitle } = req.body;
    const v = await videos.get(videoId);
    if (!v) return res.status(404).json({ error: 'Video not found' });

    // Auto-fill marketing copy when the user didn't write any.
    const { generateCopy } = await import('./copybrain.js');
    const auto = await generateCopy({ kind: v.source === 'live' || v.source === 'auto' ? 'clip' : 'vod', customTitle: title || v.copy?.title || undefined });
    const finalTitle = title || v.copy?.title || auto.title;
    const finalDesc = description || v.copy?.description || auto.description;
    const finalTags = (tags || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 20);

    const results = [];
    const pubId = uid();
    await publishes.set(pubId, { status: 'running', videoId, at: new Date().toISOString(), results: [] });

    // YouTube long-form
    if (req.body.youtube) {
      const filePath = v.fixedPath || v.diskPath;
      if (!fs.existsSync(filePath)) throw new Error('Processed file missing — run Fix first.');
      results.push({ platform: 'youtube', kind: 'long', status: 'uploading' });
      emit('publish', { pubId, platform: 'youtube', status: 'uploading' });
      try {
        const up = await yt.uploadVideo({
          filePath,
          title: finalTitle,
          description: finalDesc,
          tags: finalTags.length ? finalTags : (v.copy?.tags || []),
          privacy: privacy || 'private',
        });
        results[results.length - 1] = { platform: 'youtube', kind: 'long', status: 'done', url: up.url, id: up.id };
        emit('publish', { pubId, platform: 'youtube', status: 'done', url: up.url });
      } catch (e) {
        results[results.length - 1] = { platform: 'youtube', kind: 'long', status: 'error', error: e.message };
        emit('publish', { pubId, platform: 'youtube', status: 'error', error: e.message });
      }
    }

    // TikTok clips
    if (req.body.tiktok && Array.isArray(clips) && clips.length) {
      for (const clipId of clips) {
        results.push({ platform: 'tiktok', kind: 'clip', clipId, status: 'queued' });
      }
      results.push({
        platform: 'tiktok', kind: 'clip', clipId: clips.join(','), status: 'error',
        error: 'TikTok upload needs the official TikTok API (Content Posting API is by-application). Use the TikTok app for now — clips are ready in your Files tab. (Coming: auto-post via your phone pairing.)',
      });
    }

    await publishes.set(pubId, { status: 'done', results });
    emit('publish', { pubId, status: 'done', results });
    res.json({ pubId, results, autoCopy: { title: finalTitle, description: finalDesc, tags: finalTags.length ? finalTags : v.copy?.tags || [] } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/publishes', (_req, res) => sc(res, publishes.list()));

// ------------------------------------------------------------------- live clip
app.get('/api/liveclip/status', (_req, res) => res.json(liveclip.status()));

app.post('/api/liveclip/record', async (req, res) => {
  try {
    const st = await liveclip.startRecorder(req.body?.url);
    res.json({ ok: true, status: st });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/liveclip/inspect', async (req, res) => {
  try {
    const info = await liveclip.inspectSource(req.body?.url);
    res.json({ ok: true, ...info });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// TikTok phone live: resolve @username → record the live stream
app.post('/api/liveclip/record/tiktok', async (req, res) => {
  try {
    const { fetchLiveInfo } = await import('./tiktok.js');
    const user = req.body?.username || req.body?.url;
    const info = await fetchLiveInfo(user);
    if (!info.isLive) throw new Error(info.ended
      ? `@${info.uniqueId}'s live already ended. Wait for the next stream.`
      : `@${info.uniqueId} is not live right now. Start a TikTok live from your phone first.`);
    if (!info.streamUrls[0]) throw new Error('Could not find a capturable stream URL. TikTok may be restricting it.');
    const st = await liveclip.startRecorder(info.streamUrls[0]);
    res.json({ ok: true, live: info, status: st });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/liveclip/record/ps5', async (req, res) => {
  try {
    const hls = await liveclip.startPs5(req.body || {});
    const st = await liveclip.startRecorder(hls);
    res.json({ ok: true, hls, status: st });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/liveclip/stop', (_req, res) => {
  liveclip.stopRecorder();
  res.json({ ok: true });
});

app.post('/api/liveclip/cut', async (req, res) => {
  try {
    const vod = await liveclip.cutLiveClip(req.body || {});
    res.json({ ok: true, video: vod });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Auto-edit: cut + transcribe + captions + title + copy — one call.
app.post('/api/liveclip/auto', async (req, res) => {
  try {
    const vod = await liveclip.autoBuildClip(req.body || {});
    res.json({ ok: true, video: vod });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Generate copy for any video (titles/descriptions/hashtags).
app.post('/api/copy/generate', async (req, res) => {
  try {
    const { generateCopy } = await import('./copybrain.js');
    const out = await generateCopy(req.body || {});
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Transcribe an existing video (background job).
app.post('/api/videos/:id/transcribe', async (req, res) => {
  const v = await videos.get(req.params.id);
  if (!v) return res.status(404).json({ error: 'Video not found' });
  const src = v.fixedPath || v.diskPath;
  const jobId = uid();
  await jobs.set(jobId, { id: jobId, kind: 'captions', videoId: v.id, status: 'running', createdAt: new Date().toISOString() });
  emit('job', { jobId, status: 'running', kind: 'captions' });
  res.json({ jobId });
  runAsync(async () => {
    try {
      const { generateCaptions } = await import('./captions.js');
      const result = await generateCaptions(src, { model: req.body?.model || 'small', language: req.body?.language || null });
      if (result.error) throw new Error(result.error);
      await videos.set(v.id, { captions: result.captions, language: result.language });
      await jobs.set(jobId, { status: 'done', captions: result.captions.length });
      emit('job', { jobId, status: 'done', captions: result.captions.length });
      emit('video', { id: v.id, stage: v.stage, captions: result.captions.length });
    } catch (e) {
      await jobs.set(jobId, { status: 'error', error: e.message });
      emit('job', { jobId, status: 'error', error: e.message });
    }
  });
});

app.get('/api/liveclip/segments', (_req, res) => {
  // quick debug view of the current buffer
  res.json({ status: liveclip.status() });
});

app.use('/data/clips', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
}, express.static(liveclip.CLIP_DIR));

// ------------------------------------------------------------------- Appwrite cloud
app.get('/api/cloud/status', (_req, res) => {
  const creds = readAppwriteCredsFile();
  const endpoint = creds.endpoint || process.env.APPWRITE_ENDPOINT || DEFAULT_ENDPOINT;
  const configured = isConfigured();
  res.json({
    configured,
    active: usingCloud(),
    endpoint,
    projectId: creds.projectId || process.env.APPWRITE_PROJECT_ID || '',
    apiKey: !!(creds.apiKey || process.env.APPWRITE_API_KEY),
    databaseId: appwriteConfig().databaseId,
    error: getCloudError() || null,
    retry: configured && !usingCloud() ? '/api/cloud/retry' : null,
  });
});

/** Re-attempt the Appwrite bootstrap without re-entering the keys. */
app.post('/api/cloud/retry', async (_req, res) => {
  try {
    if (!isConfigured()) return res.status(400).json({ ok: false, error: 'No Appwrite credentials are set. Add your Project ID + API key first.' });
    const info = await reinitStore();
    if (info.error) return res.status(400).json({ ok: false, error: info.error });
    res.json({ ok: true, cloud: true, created: info.created || [] });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/cloud/connect', async (req, res) => {
  try {
    const { endpoint, projectId, apiKey } = req.body || {};
    if (!projectId || !apiKey) {
      return res.status(400).json({ error: 'Project ID and API key are both required.' });
    }
    const credsPath = path.join(DATA_DIR, 'appwrite.json');
    const prior = (() => { try { return fs.readFileSync(credsPath, 'utf8'); } catch { return null; } })();

    // Stage creds in-memory FIRST, pass them via env override, and only
    // persist to disk after a successful schema bootstrap (transactional).
    if (endpoint) saveAppwriteCreds({ endpoint });
    saveAppwriteCreds({ projectId, apiKey });

    const info = await reinitStore();
    if (info.error) {
      // Roll back to prior creds (or none).
      if (prior === null) fs.rmSync(credsPath, { force: true });
      else fs.writeFileSync(credsPath, prior);
      await reinitStore(); // revert in-memory SDK to prior config
      return res.status(400).json({ error: 'Could not reach/configure Appwrite: ' + info.error + '. Check your Project ID and API key, and that the endpoint is reachable.' });
    }

    res.json({ ok: true, cloud: true, endpoint: appwriteConfig().endpoint, created: info.created || [] });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/cloud/disconnect', (_req, res) => {
  fs.rmSync(path.join(DATA_DIR, 'appwrite.json'), { force: true });
  delete process.env.APPWRITE_PROJECT_ID;
  delete process.env.APPWRITE_API_KEY;
  delete process.env.APPWRITE_ENDPOINT;
  reinitStore().then(() => res.json({ ok: true, cloud: usingCloud() ? 'appwrite' : 'local' }));
});

// ------------------------------------------------------------------- settings
app.get('/api/settings', (_req, res) => sc(res, getSettings().then((s) => {
  const { youtubeToken, ...safe } = s;
  // Never send Twitch secrets to the browser.
  if (safe.twitch) {
    const { botOauth, appToken, clientId, ...twPublic } = safe.twitch;
    safe.twitch = { ...twPublic, hasBotOauth: !!botOauth, hasAppToken: !!appToken, hasClientId: !!clientId };
  }
  return { ...safe, youtubeToken: !!youtubeToken };
})));
app.post('/api/settings', async (req, res) => {
  const { youtubeToken, ...rest } = req.body || {};
  await saveSettings(rest);
  res.json({ ok: true });
});

// ------------------------------------------------------------------- YouTube auth
app.get('/api/youtube/status', async (_req, res) => {
  try {
    const hasToken = !!(await yt.getToken());
    let channel = null;
    if (hasToken) channel = await yt.whoami().catch(() => null);
    res.json({ connected: hasToken && !!channel, channel });
  } catch (e) {
    res.json({ connected: false, error: e.message });
  }
});

app.get('/api/youtube/auth-url', (_req, res) => res.json({ url: yt.authUrl() }));

app.get('/auth/youtube/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?youtube=denied&reason=' + encodeURIComponent(error));
  try {
    await yt.exchangeCode(code);
    res.redirect('/?youtube=connected');
  } catch (e) {
    res.redirect('/?youtube=error&reason=' + encodeURIComponent(e.message));
  }
});

// ------------------------------------------------------------------- autopilot (live)
app.get('/api/autopilot/status', (_req, res) => res.json(autopilot.status()));
app.post('/api/autopilot/start', async (req, res) => {
  try {
    await autopilot.start({
      youtubeVideoId: req.body.youtubeVideoId,
      tiktokUser: req.body.tiktokUser,
      twitchChannel: req.body.twitchChannel,
      kickChannel: req.body.kickChannel,
    });
    res.json({ ok: true, status: autopilot.status() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post('/api/autopilot/stop', (_req, res) => {
  autopilot.stop();
  res.json({ ok: true, status: autopilot.status() });
});
// Manual reply (you speak as the bot)
app.post('/api/autopilot/say', async (req, res) => {
  const { platform, text } = req.body;
  try {
    if (platform === 'youtube') {
      const st = autopilot.status();
      if (!st.youtube?.liveChatId) throw new Error('YouTube chat not connected.');
      await yt.postLiveChat(st.youtube.liveChatId, text);
      emit('reply', { at: Date.now(), platform, user: 'You', in: '(manual)', out: text, sent: true, manual: true });
      return res.json({ ok: true, delivered: true });
    }
    // Everything non-YouTube goes through its platform's sendReply
    const mod = { tiktok: await import('./tiktok.js'), twitch, kick }[platform];
    if (!mod) throw new Error('Unknown platform');
    const sent = await mod.sendReply(text);
    emit('reply', { at: Date.now(), platform, user: 'You', in: '(manual)', out: text, sent, manual: true });
    return res.json({ ok: true, delivered: sent, note: sent ? undefined : 'Read-only connection — reply shown locally.' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ------------------------------------------------------------------- connections hub
app.get('/api/connections', async (_req, res) => {
  try {
    const ytAccount = await connections.youtubeAccount();
    const snap = await connections.snapshot(autopilot.status());
    const platforms = await Promise.all(snap.platforms.map(async (p) => {
      if (p.id === 'youtube') return { ...p, account: ytAccount ? { id: ytAccount.id, title: ytAccount.title, subs: ytAccount.subs } : null };
      return p;
    }));
    res.json({ platforms, live: snap.live, running: autopilot.status().running });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Twitch
app.post('/api/connections/twitch', async (req, res) => {
  try {
    const saved = await twitch.saveTwitch(req.body || {});
    res.json({ ok: true, twitch: { channel: saved.channel, botUser: saved.botUser, hasBotOauth: !!saved.botOauth, hasAppToken: !!saved.appToken } });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post('/api/connections/twitch/validate', async (req, res) => {
  try {
    const token = req.body?.token || '';
    const out = await twitch.validateTwitchToken(token, req.body?.clientId);
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Kick
app.post('/api/connections/kick', async (req, res) => {
  try {
    const s0 = await getSettings();
    await saveSettings({ kick: { ...(s0.kick || {}), channel: String(req.body?.channel || '').trim().replace(/^@/, '') } });
    res.json({ ok: true, kick: (await getSettings()).kick });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Quick chat test (connect-only) for twitch/kick from the Connections tab
app.post('/api/connections/chat/test', async (req, res) => {
  try {
    const { platform, channel } = req.body || {};
    if (platform === 'twitch') await twitch.connect(channel);
    else if (platform === 'kick') await kick.connect(channel);
    else if (platform === 'tiktok') { await (await import('./tiktok.js')).connect(channel); }
    else throw new Error('Unsupported platform for chat test.');
    res.json({ ok: true, connected: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ------------------------------------------------------------------- SSE
import { hub } from './pubsub.js';

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);

  const events = ['video', 'job', 'chat', 'reply', 'log', 'publish', 'viewers', 'liveclip', 'autoclip'];
  const handlers = {};
  for (const ev of events) {
    handlers[ev] = (payload) => {
      try { res.write(`data: ${JSON.stringify({ type: ev, data: JSON.parse(payload) })}\n\n`); } catch {}
    };
  }
  for (const [ev, h] of Object.entries(handlers)) hub.on(ev, h);

  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    for (const [ev, h] of Object.entries(handlers)) hub.off(ev, h);
  });
});

// ------------------------------------------------------------------- async runner
function runAsync(fn) {
  fn().catch((e) => console.error('async job failed:', e));
}

// ------------------------------------------------------------------- boot
const PORT = Number(process.env.PORT) || 8787;

async function boot() {
  connections.wireChatBuses();
  const cloudInfo = await initStore();
  if (!cloudInfo.cloud) selfHealCloud(); // retry later if creds existed but boot failed
  app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  ┌──────────────────────────────────────────────────────┐');
    console.log('  │   🎮 StreamPilot — your cross-platform autopilot      │');
    console.log('  └──────────────────────────────────────────────────────┘');
    console.log(`  Dashboard:  http://localhost:${PORT}`);
    console.log(`  FFmpeg:     ${ffmpegPath}`);
    console.log(`  FFprobe:    ${ffprobePath}`);
    if (cloudInfo?.cloud) {
      console.log(`  ☁️  Appwrite:   ${appwriteConfig().endpoint} ✅`);
    } else if (isConfigured()) {
      console.log('  ⚠️  Appwrite:   configured but NOT connected — check /api/cloud/status for the error. Falling back to local data/.');
    } else {
      console.log('  ☁️  Appwrite:   not configured (local data/) — add keys in Settings → Cloud');
    }
    console.log('');
  });
}
boot();
