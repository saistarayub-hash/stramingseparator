import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
export const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
export const ffprobePath = require('@ffprobe-installer/ffprobe').path;

/**
 * Run an FFmpeg/FFprobe command and resolve with stdout.
 * @param {string} bin path to binary
 * @param {string[]} args
 * @param {object} opts { onLog } optional progress callback
 * @returns {Promise<string>}
 */
export function runBin(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => {
      err += d.toString();
      if (opts.onLog) opts.onLog(d.toString());
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(opts.mergeStderr ? out + '\n' + err : out);
      else {
        const tail = (err || out).split('\n').slice(-20).join('\n');
        reject(new Error(`Process exited ${code}: ${tail}`));
      }
    });
  });
}

/**
 * Probe a media file and return the key facts (streams, duration, sizes).
 */
export async function probe(inputPath) {
  const raw = await runBin(ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    inputPath,
  ]);
  const data = JSON.parse(raw);
  const video = data.streams.find((s) => s.codec_type === 'video');
  const audio = data.streams.find((s) => s.codec_type === 'audio');
  const format = data.format || {};
  return {
    duration: parseFloat(format.duration) || (video && parseFloat(video.duration)) || 0,
    sizeBytes: parseInt(format.size, 10) || 0,
    bitrate: parseInt(format.bit_rate, 10) || 0,
    container: format.format_name || 'unknown',
    hasVideo: !!video,
    hasAudio: !!audio,
    width: video ? video.width : 0,
    height: video ? video.height : 0,
    fps: video ? evalFps(video) : 0,
    videoCodec: video ? video.codec_name : null,
    audioCodec: audio ? audio.codec_name : null,
    audioChannels: audio ? audio.channels : 0,
    durationRaw: format.duration || video?.duration || '0',
  };
}

function evalFps(stream) {
  if (stream.avg_frame_rate && stream.avg_frame_rate !== '0/0') {
    const [n, d] = stream.avg_frame_rate.split('/').map(Number);
    if (d) return +(n / d).toFixed(3);
  }
  return stream.r_frame_rate ? Number(stream.r_frame_rate.split('/')[0]) : 0;
}

/** Parse FFmpeg `-progress pipe:1` output into { frame, fps, time, speed, bitrate }. */
function parseProgress(str) {
  const m = {};
  for (const line of str.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) m[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return m;
}

/**
 * Run a "fix" FFmpeg pass. Fixes stream for broadcast/web playback.
 *  - re-encode video to H.264 (yuv420p, faststart)
 *  - scale to even dimensions, cap at maxHeight
 *  - loudness-normalize audio to -14 LUFS and mono-downmix if stereo-only
 *  - AAC 192k audio
 */
export function fixVideo(inputPath, outputPath, { maxHeight = 2160, maxDuration = null } = {}, onLog) {
  // Cap the HEIGHT at maxHeight, never upscale, and force even dimensions.
  const vf = [`scale=-2:'min(${maxHeight},ih)'`, 'format=yuv420p'];
  const args = [
    '-y',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-vf', vf.join(','),
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ar', '48000',
    '-ac', '2',
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11',
  ];
  if (maxDuration) args.push('-t', String(maxDuration), );
  args.push('-progress', 'pipe:1', '-nostats', outputPath);

  let last = {};
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let err = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) {
          const p = parseProgress(line + '\n');
          last = { ...last, ...p };
          if (onLog) onLog({ stage: 'fix', ...last });
        }
      }
    });
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(last);
      else reject(new Error(err.split('\n').slice(-20).join('\n')));
    });
  });
}

/**
 * Analyse "spikes" to find candidate clip moments.
 * Sample loudness/blackframe across the video so the UI can show hotspots.
 * We use scene detection (select=gt(scene,0.4)) and include timestamp + score.
 */
export async function detectHighlights(inputPath, onLog) {
  const args = [
    '-v', 'error',
    '-i', inputPath,
    '-vf',
    "select='gt(scene,0.4)',metadata=print:file=-",
    '-f', 'null', '-',
  ];
  const raw = await runBin(ffmpegPath, args, { onLog: (l) => onLog && onLog({ stage: 'scan', log: l }) });
  const markers = [];
  for (const line of raw.split('\n')) {
    const t = line.match(/pts_time:([0-9.]+)/);
    const score = line.match(/lavfi\.scene_score=([0-9.]+)/);
    if (t) markers.push({ at: parseFloat(t[1]), score: score ? parseFloat(score[1]) : 0 });
  }
  // Deduplicate markers that are within 1.5s of each other, keep highest score.
  const dedup = [];
  for (const mk of markers) {
    if (dedup.some((d) => Math.abs(d.at - mk.at) < 1.5)) continue;
    dedup.push(mk);
  }
  return dedup;
}

/**
 * Cut a single clip from a (long) video. Output vertical if vertical=true.
 * Aims to respect short-form max length (60s).
 */
export function cutClip(inputPath, outputPath, { start = 0, duration = 30, vertical = true }, onLog) {
  const filter = vertical
    ? "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p"
    : "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,format=yuv420p";
  const args = [
    '-y',
    '-ss', String(start),
    '-t', String(duration),
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', filter,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    outputPath,
  ];
  let last = {};
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let err = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) {
          last = { ...last, ...parseProgress(line + '\n') };
          if (onLog) onLog({ stage: 'clip', ...last });
        }
      }
    });
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(last);
      else reject(new Error(err.split('\n').slice(-20).join('\n')));
    });
  });
}

/** Simple loudness readout via loudnorm print_format=summary. */
export async function measureLoudness(inputPath) {
  const raw = await runBin(ffmpegPath, [
    '-v', 'info',
    '-i', inputPath,
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=summary',
    '-f', 'null', '-',
  ], { mergeStderr: true });
  const integrated = raw.match(/Input Integrated:\s+([-0-9.]+)\s+LUFS/);
  const peak = raw.match(/Input True Peak:\s+([-0-9.]+)\s+dBTP/);
  return {
    integratedLufs: integrated ? parseFloat(integrated[1]) : null,
    truePeak: peak ? parseFloat(peak[1]) : null,
  };
}

/** Locate a bold TTF for drawtext overlays across common OSes. */
export function findFont() {
  const candidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    'C:\\Windows\\Fonts\\arialbd.ttf',
    'C:\\Windows\\Fonts\\arial.ttf',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null; // ffmpeg will use its default fontconfig font
}

/** Escape text for ffmpeg drawtext (single-quoted). */
export function drawtextEscape(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/%/g, '\\%')
    .slice(0, 200);
}

/**
 * Render a clip to a platform-ready MP4, optionally with a burned title
 * lower-third and/or timed captions (for Shorts/TikTok).
 * @param {object} o { start, duration, vertical, title, captions:[{start,end,text}] }
 */
export function renderClip(inputPath, outputPath, o = {}, onLog) {
  const { start = 0, duration = 30, vertical = true, title = null, captions = [] } = o;
  const font = findFont();
  const fontArg = font ? `:fontfile='${font}'` : '';

  const base = vertical
    ? 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920'
    : 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080';

  const filters = [base];

  if (title) {
    const t = drawtextEscape(title);
    filters.push(
      `drawtext=text='${t}':fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=14:fontsize=52:x=(w-text_w)/2:y=h-180${fontArg}:enable='between(t,0,${Math.min(5, duration).toFixed(2)})'`
    );
  }
  for (const c of captions || []) {
    if (!c || !c.text) continue;
    const txt = drawtextEscape(c.text);
    const s = Math.max(0, Number(c.start) || 0);
    const e = Math.max(s + 0.4, Number(c.end) || s + 1.2);
    filters.push(
      `drawtext=text='${txt}':fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=16:fontsize=58:x=(w-text_w)/2:y=h-240${fontArg}:enable='between(t,${s.toFixed(2)},${e.toFixed(2)})'`
    );
  }

  const vf = filters.join(',') + ',format=yuv420p';
  const args = [
    '-y',
    '-ss', String(start),
    '-t', String(duration),
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11',
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    outputPath,
  ];

  let last = {};
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let err = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) {
          last = { ...last, ...parseProgress(line + '\n') };
          if (onLog) onLog({ stage: 'render', ...last });
        }
      }
    });
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(last);
      else reject(new Error(err.split('\n').slice(-20).join('\n')));
    });
  });
}
