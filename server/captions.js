// Caption engine — powered by local, free Whisper (faster-whisper).
// `generateCaptions` shells out to scripts/transcribe.py.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emit } from './pubsub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', 'scripts', 'transcribe.py');

export const whisperAvailable = () => existsSync(SCRIPT);

/** Close gaps between caption segments (max 0.8s) so words don't flash. */
export function closeGaps(captions) {
  const out = [];
  for (const c of captions || []) {
    const prev = out[out.length - 1];
    if (prev && c.start - prev.end < 0.8 && c.start > prev.end) {
      prev.end = c.start;
    }
    out.push({ ...c });
  }
  return out;
}

/** Pick the caption segments that fall inside a clip window.
 *  windowStart/End are timeline positions; offset's the value rendered.
 */
export function captionsForWindow(captions, windowStart, windowEnd) {
  return closeGaps((captions || []).filter((c) => c.end > windowStart && c.start < windowEnd))
    .map((c) => ({
      start: Math.max(0, +(c.start - windowStart).toFixed(2)),
      end: Math.max(0.4, +(c.end - windowStart).toFixed(2)),
      text: c.text,
    }));
}

/**
 * Transcribe a media file → timed captions.
 * Returns { captions, language, error }
 * Aborts after `timeoutMs` (default 2 min, SP_WHISPER_TIMEOUT_MS) so a slow
 * model download or a tiny box can never hang a live clip forever.
 */
export function generateCaptions(mediaPath, { model = null, language = null, timeoutMs = null } = {}) {
  return new Promise((resolve) => {
    if (!existsSync(mediaPath)) {
      resolve({ captions: [], error: 'media not found' });
      return;
    }
    const args = [SCRIPT, mediaPath];
    if (model) args.push('--model', model);
    if (language) args.push('--language', language);
    const python = process.env.PYTHON || 'python3';
    const limit = Number(timeoutMs) || Number(process.env.SP_WHISPER_TIMEOUT_MS) || 120000;

    const child = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, limit);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ captions: [], error: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ captions: [], error: `transcription timed out after ${Math.round(limit / 1000)}s` });
        return;
      }
      try {
        const parsed = JSON.parse(out.trim() || '{}');
        resolve({ captions: closeGaps(parsed.captions || []), language: parsed.language, error: parsed.error || null });
      } catch {
        resolve({ captions: [], error: `transcriber exited (${code}): ${(err || out).slice(-300)}` });
      }
    });
  });
}

/** Async fire-and-forget captions job with SSE progress. */
export async function runCaptionJob(jobId, mediaPath, opts = {}, onDone) {
  emit('job', { jobId, status: 'running', kind: 'captions' });
  try {
    if (!whisperAvailable()) {
      const e = new Error('Whisper transcriber missing (scripts/transcribe.py).');
      emit('job', { jobId, status: 'error', error: e.message });
      onDone && onDone({ error: e.message });
      return;
    }
    const result = await generateCaptions(mediaPath, opts);
    if (result.error) throw new Error(result.error);
    emit('job', { jobId, status: 'done', captions: result.captions.length });
    onDone && onDone(result);
  } catch (e) {
    emit('job', { jobId, status: 'error', error: e.message });
    onDone && onDone({ error: e.message });
  }
}
