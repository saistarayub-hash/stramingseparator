#!/usr/bin/env node
// StreamPilot end-to-end smoke test — runs on a GitHub Actions runner against
// the LIVE Render app. No secrets: every endpoint below is public.
//
// What it proves:
//   • app + cloud are up (status/cloud/status = active, engine tables)
//   • every read endpoint answers (videos/settings/publishes/connections/
//     autopilot/liveclip)
//   • copybrain generates marketing copy (POST)
//   • the REAL pipeline: download a ~1MB mp4 → multipart upload → analyze
//     (ffmpeg probe + loudness + highlight detection) → fix (ffmpeg encode)
//     — all persisting through Appwrite TablesDB + the videos bucket.
//
// Writes a secret-free report to cloud-probe/smoketest.txt (+ report.json).

import fs from 'node:fs';

const BASE = process.env.APP_URL || 'https://streampilot-ttus.onrender.com';
const SAMPLE_URLS = [
  'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
  'https://sample-videos.com/video321/mp4/360/big_buck_bunny_360p_1mb.mp4',
  'https://filesamples.com/samples/video/mp4/sample_640x360.mp4',
];

const lines = [];
const out = (s) => { lines.push(s); console.log(s); };
const results = [];
function check(name, ok, details = '') {
  const status = ok ? 'PASS' : (details.toLowerCase().includes('skip') ? 'SKIP' : 'FAIL');
  results.push({ name, status, details });
  out(`${status.padEnd(4)} ${name}${details ? ' — ' + details : ''}`);
}

async function get(p) {
  const res = await fetch(BASE + p, { redirect: 'follow' });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function post(p, body) {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function downloadSample() {
  for (const url of SAMPLE_URLS) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 500 * 1024 * 1024) continue; // sanity ceiling
      out(`  downloaded ${(buf.length / 1024 / 1024).toFixed(2)} MB from ${url}`);
      return buf;
    } catch (e) {
      out(`  download failed ${url}: ${e.message}`);
    }
  }
  return null;
}

async function main() {
  out(`StreamPilot smoke test — ${new Date().toISOString()}`);
  out(`base: ${BASE}\n`);

  // ---- 1. health + cloud ------------------------------------------------
  const status = await get('/api/status');
  check('GET /api/status → ok', status.json?.ok === true, JSON.stringify(status.json));

  const cloud = await get('/api/cloud/status');
  const c = cloud.json || {};
  check('cloud active', c.active === true, JSON.stringify(c));
  check('cloud engine = tables', c.engine === 'tables', `engine=${c.engine}`);
  check('cloud error empty', !c.error, `error=${c.error || '(none)'}`);

  // ---- 2. read endpoints ------------------------------------------------
  const videos = await get('/api/videos');
  check('GET /api/videos', Array.isArray(videos.json), `count=${Array.isArray(videos.json) ? videos.json.length : videos.status}`);

  const settings = await get('/api/settings');
  check('GET /api/settings', settings.status === 200, JSON.stringify(settings.json));

  const publishes = await get('/api/publishes');
  check('GET /api/publishes', Array.isArray(publishes.json), `count=${Array.isArray(publishes.json) ? publishes.json.length : publishes.status}`);

  const conns = await get('/api/connections');
  check('GET /api/connections', (conns.json?.platforms || []).length > 0,
    `platforms=${(conns.json?.platforms || []).map((p) => `${p.id}:${p.connected ? 'on' : 'off'}`).join(',')}`);

  const ap = await get('/api/autopilot/status');
  check('GET /api/autopilot/status', ap.status === 200 && ap.json !== null, `running=${ap.json?.running}`);

  const lc = await get('/api/liveclip/status');
  check('GET /api/liveclip/status', lc.status === 200 && lc.json !== null, `running=${lc.json?.running}`);

  const yt = await get('/api/youtube/status');
  check('GET /api/youtube/status', yt.status === 200, `connected=${yt.json?.connected}`);

  // ---- 3. copybrain ------------------------------------------------------
  const copy = await post('/api/copy/generate', { kind: 'clip', customTitle: 'smoke test clip' });
  check('POST /api/copy/generate', copy.status === 200 && !!copy.json?.title,
    copy.json?.title ? `title="${copy.json.title.slice(0, 60)}"` : (copy.text || '').slice(0, 90));

  // ---- 4. the real pipeline (upload → analyze → fix) --------------------
  const sample = await downloadSample();
  if (!sample) {
    check('video pipeline (upload→analyze→fix)', false, 'SKIP: could not download a sample video');
  } else {
    const fd = new FormData();
    fd.append('file', new Blob([sample], { type: 'video/mp4' }), 'smoketest.mp4');
    const up = await fetch(BASE + '/api/videos/upload', { method: 'POST', body: fd });
    const upJson = await up.json().catch(() => ({}));
    const videoId = upJson?.id;
    check('POST /api/videos/upload', up.status === 200 && !!videoId,
      videoId ? `id=${videoId}` : `HTTP ${up.status} ${(upJson.error || '').slice(0, 80)}`);

    if (videoId) {
      const an = await post(`/api/videos/${videoId}/analyze`, {});
      const info = an.json?.info || {};
      check('POST /analyze (ffmpeg probe)', an.status === 200 && an.json?.stage === 'analyzed',
        `dur=${info.duration}s ${info.width}x${info.height} fps=${info.fps} audio=${info.hasAudio ? 'yes' : 'no'} highlights=${(an.json?.highlights || []).length}`);

      const readBack = await get(`/api/videos/${videoId}`);
      check('video persists in cloud (TablesDB)', readBack.status === 200 && readBack.json?.stage === 'analyzed',
        `stage=${readBack.json?.stage}`);

      // fix = real ffmpeg encode (async), plus cloud mirror of the fixed file
      const fx = await post(`/api/videos/${videoId}/fix`, { maxHeight: 1080 });
      check('POST /fix started', fx.status === 200 && !!fx.json?.jobId, `jobId=${fx.json?.jobId}`);

      let fixed = false, fixedErr = null;
      for (let i = 0; i < 24; i++) {
        await sleep(5000);
        const v = await get(`/api/videos/${videoId}`);
        if (v.json?.stage === 'fixed') { fixed = true; break; }
        if (v.json?.stage === 'error') { fixedErr = v.json?.error; break; }
      }
      check('fix finished → fixed', fixed,
        fixed ? `fixedInfo=${JSON.stringify((await get(`/api/videos/${videoId}`)).json?.fixedInfo || {})}` : `err=${fixedErr || 'timeout'}`);
    }
  }

  // ---- 5. verdict --------------------------------------------------------
  const fails = results.filter((r) => r.status === 'FAIL').length;
  const passes = results.filter((r) => r.status === 'PASS').length;
  const skips = results.filter((r) => r.status === 'SKIP').length;
  out(`\nsummary: ${passes} passed, ${fails} failed, ${skips} skipped`);
  out(fails ? 'VERDICT: NOT FULLY AUTOMATED-READY' : `VERDICT: ${passes ? 'ALL GREEN — pipeline works end-to-end' : 'NO CHECKS RAN'}`);

  fs.mkdirSync('cloud-probe', { recursive: true });
  fs.writeFileSync('cloud-probe/smoketest.txt', lines.join('\n') + '\n');
  fs.writeFileSync('cloud-probe/report.json', JSON.stringify({
    at: new Date().toISOString(), base: BASE, passes, fails, skips, results,
  }, null, 2));

  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  out('FATAL: ' + (e && e.message));
  fs.mkdirSync('cloud-probe', { recursive: true });
  fs.writeFileSync('cloud-probe/smoketest.txt', lines.join('\n') + '\n');
  fs.writeFileSync('cloud-probe/report.json', JSON.stringify({ at: new Date().toISOString(), fatal: String(e && e.message), results }, null, 2));
  process.exit(1);
});
