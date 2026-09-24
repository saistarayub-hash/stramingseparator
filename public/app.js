// StreamPilot front-end controller.
// Talks to the Express API + SSE stream. No build step, no framework.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  videos: [],
  activeVideoId: null,
  settings: {},
  autopilot: { running: false },
  chatMessages: [],
  logs: [],
  publishResults: [],
  youtubeChannel: null,
};

const fmt = {
  bytes(b) {
    if (!b && b !== 0) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let n = b;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 10 ? 1 : 2)} ${u[i]}`;
  },
  time(s) {
    if (s == null) return '—';
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (x) => String(x).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  },
  when(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString();
  },
  clock(ms) {
    return new Date(ms).toLocaleTimeString();
  },
};

const api = {
  async json(url, opts = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status}`);
    return data;
  },
  get: (u) => api.json(u),
  post: (u, body) => api.json(u, { method: 'POST', body: body || {} }),
  del: (u) => api.json(u, { method: 'DELETE' }),
};

/* ------------------------------------------------------------------ views */
const views = ['library', 'liveclips', 'autopilot', 'connections', 'publish', 'settings'];
function showView(name) {
  views.forEach((v) => {
    $('#view-' + v)?.classList.toggle('active', v === name);
    $(`.nav-item[data-view="${v}"]`)?.classList.toggle('active', v === name);
  });
  if (name === 'library') refreshVideos();
  if (name === 'liveclips') refreshLiveClip();
  if (name === 'autopilot') refreshAutopilot();
  if (name === 'connections') refreshConnections();
  if (name === 'publish') refreshPublish();
  if (name === 'settings') { refreshSettings(); refreshCloud(); }
}

$$('.nav-item').forEach((el) => el.addEventListener('click', () => showView(el.dataset.view)));

/* -------------------------------------------------------------- toasts */
function toast(msg, kind = 'info') {
  const wrap = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3800);
}

function setBusy(btn, busy, label) {
  if (!btn) return;
  if (busy) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Working…'; btn.disabled = true; }
  else { btn.textContent = btn.dataset.label || 'Done'; btn.disabled = false; }
}

/* -------------------------------------------------------------- library */
async function refreshVideos() {
  try {
    state.videos = await api.get('/api/videos');
    renderLibrary();
  } catch (e) {
    toast('Could not load library: ' + e.message, 'error');
  }
}

function stageLabel(stage) {
  return ({
    uploaded: 'Uploaded', analyzing: 'Analyzing…', analyzed: 'Analyzed',
    fixing: 'Fixing & mastering…', fixed: 'Ready to publish',
    clipping: 'Cutting clips…', clipped: 'Clips ready', error: 'Error',
  })[stage] || stage;
}

function renderLibrary() {
  const grid = $('#library-grid');
  const empty = $('#library-empty');
  if (!state.videos.length) {
    grid.innerHTML = '';
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';
  grid.innerHTML = state.videos.map((v) => {
    const active = v.id === state.activeVideoId;
    const info = v.info || {};
    const clips = v.clips || [];
    return `
    <div class="card video-card ${active ? 'active' : ''}" data-id="${v.id}">
      <div class="thumb" style="background-image:url('/api/videos/${v.id}/thumb')">
        <span class="badge badge-${v.stage === 'error' ? 'error' : (v.stage === 'fixed' || v.stage === 'clipped' ? 'ok' : 'info')}">${stageLabel(v.stage)}</span>
      </div>
      <div class="card-body">
        <div class="video-name" title="${esc(v.name)}">${esc(v.name)}</div>
        <div class="video-meta">${fmt.time(info.duration)} · ${info.width ? info.width + '×' + info.height : fmt.bytes(v.originalSize)}</div>
        <div class="video-actions">
          <button class="btn btn-sm" data-act="select">Open</button>
          ${(v.stage === 'analyzed' || v.stage === 'error') ? `<button class="btn btn-sm btn-primary" data-act="fix">Fix it</button>` : ''}
          ${v.stage === 'fixed' || v.stage === 'clipped' ? `<button class="btn btn-sm btn-primary" data-act="publish">Publish</button>` : ''}
          <button class="btn btn-sm btn-ghost" data-act="del">✕</button>
        </div>
      </div>
      ${clips.length ? `<div class="clip-row">${clips.map((c, i) => `
        <a class="clip-chip" href="/api/videos/${v.id}/clips/${i}/file" download>📎 clip ${i + 1} <span>${fmt.time(c.duration)}</span></a>`).join('')}</div>` : ''}
    </div>`;
  }).join('');

  $$('.video-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      const id = card.dataset.id;
      if (act === 'del') { deleteVideo(id); return; }
      if (act === 'fix') { openDetail(id); runFix(id); return; }
      if (act === 'publish') { openDetail(id); showView('publish'); return; }
      else openDetail(id);
    });
  });
}

/** Open the detail panel for a video (accepts an id or a video object). */
async function openDetail(idOrVideo) {
  const id = typeof idOrVideo === 'string' ? idOrVideo : idOrVideo?.id;
  if (!id) return;
  let v = (typeof idOrVideo === 'object' && idOrVideo) || state.videos.find((x) => x.id === id) || null;
  try {
    v = (await api.get('/api/videos/' + id)) || v;
  } catch { /* offline / deleted — show whatever we have */ }
  if (v) renderDetail(v);
}

function renderDetail(v) {
  if (!v) return;
  state.activeVideoId = v.id;
  $('#detail').style.display = 'block';
  $('#detail-thumb').style.backgroundImage = `url('/api/videos/${v.id}/thumb')`;
  $('#detail-name').textContent = v.name;
  $('#detail-stage').textContent = stageLabel(v.stage);
  $('#detail-stage').className = 'badge badge-' + (v.stage === 'error' ? 'error' : 'info');

  $('#video-preview').src = `/api/videos/${v.id}/file`;
  $('#video-preview').load();

  // info grid
  const info = v.info || {};
  const rows = [
    ['Duration', fmt.time(info.duration)],
    ['Resolution', info.width ? `${info.width}×${info.height}` : '—'],
    ['Frame rate', info.fps ? `${info.fps} fps` : '—'],
    ['Video codec', info.videoCodec || '—'],
    ['Audio', info.hasAudio ? (info.audioCodec || 'AAC') + (info.audioChannels ? ` (${info.audioChannels}ch)` : '') : 'none'],
    ['Loudness', info.loudness?.integratedLufs != null ? `${info.loudness.integratedLufs.toFixed(1)} LUFS` : '—'],
    ['File size', fmt.bytes(info.sizeBytes || v.originalSize)],
  ];
  $('#detail-info').innerHTML = rows.map(([k, val]) => `<div class="kv"><span>${k}</span><b>${val}</b></div>`).join('');

  // issues
  const issues = v.issues || [];
  $('#detail-issues').innerHTML = issues.map((i) => `<div class="issue issue-${i.type}">${esc(i.text)}</div>`).join('') || '<div class="issue issue-ok">No issues flagged.</div>';

  // action buttons
  const actBox = $('#detail-actions');
  const canFix = ['uploaded', 'analyzed', 'error'].includes(v.stage);
  const canClip = v.stage === 'fixed' || v.stage === 'clipped' || v.stage === 'analyzed';
  const h = v.highlights || [];
  actBox.innerHTML = `
    ${canFix ? `<button class="btn btn-primary" id="btn-fix">🎛 Fix & master for broadcast</button>` : ''}
    ${canClip ? `<button class="btn" id="btn-clips" ${h.length ? '' : 'style="opacity:.6"'}>✂️ Auto-clip best moments (${h.length || 0} found)</button>` : ''}
    ${canClip ? `<button class="btn" id="btn-transcribe">🎙️ Auto-captions</button>` : ''}
    <button class="btn" id="btn-copy">📝 Write title + tags</button>
    <a class="btn btn-ghost" href="/api/videos/${v.id}/file" download>⬇ Download video</a>
  `;
  $('#btn-fix')?.addEventListener('click', () => runFix(v.id));
  $('#btn-clips')?.addEventListener('click', () => runClips(v.id));
  $('#btn-transcribe')?.addEventListener('click', () => runTranscribe(v.id));
  $('#btn-copy')?.addEventListener('click', () => runCopy(v.id));

  // highlights
  const hlWrap = $('#highlights');
  if (h.length) {
    hlWrap.innerHTML = '<div class="h3">🎯 Detected action moments</div><div class="hl-grid">' + h.slice(0, 12).map((m, i) => `
      <div class="hl-item" data-at="${m.at}">
        <span class="hl-time">${fmt.time(m.at)}</span>
        <span class="hl-score">${(Math.min(1, m.score) * 100).toFixed(0)}% action</span>
      </div>`).join('') + '</div>';
    $$('.hl-item').forEach((el) => el.addEventListener('click', () => {
      $('#video-preview').currentTime = parseFloat(el.dataset.at);
      $('#video-preview').play();
    }));
  } else {
    hlWrap.innerHTML = '<div class="h3">🎯 Action moments appear here after analysis.</div>';
  }

  // captions
  const capBox = $('#captions-box');
  if (capBox) {
    const caps = v.captions || [];
    capBox.style.display = caps.length ? 'block' : 'none';
    if (caps.length) {
      capBox.innerHTML = '<div class="h3">💬 Burned-in captions (' + caps.length + ')</div>' + caps.slice(0, 10).map((c) =>
        `<div class="issue issue-info" style="cursor:pointer" data-t="${c.start}"><b>${fmt.time(c.start)}–${fmt.time(c.end)}</b> · ${esc(c.text)}</div>`).join('')
        + (caps.length > 10 ? `<div class="hint">…and ${caps.length - 10} more</div>` : '');
      capBox.querySelectorAll('[data-t]').forEach((el) => el.addEventListener('click', () => {
        $('#video-preview').currentTime = parseFloat(el.dataset.t);
        $('#video-preview').play();
      }));
    }
  }

  // auto-generated copy
  const copyBox = $('#copy-box');
  if (copyBox) {
    const c = v.copy || {};
    copyBox.style.display = c.title || c.description ? 'block' : 'none';
    if (c.title || c.description) {
      copyBox.innerHTML = '<div class="h3">📝 Auto-written copy</div>'
        + (c.title ? `<div class="issue issue-ok"><b>Title:</b> ${esc(c.title)}</div>` : '')
        + (c.description ? `<div class="issue issue-info" style="white-space:pre-wrap"><b>Description:</b><br/>${esc(c.description)}</div>` : '')
        + (c.hashtags ? `<div class="issue issue-warn"><b>Hashtags:</b> ${esc(c.hashtags)}</div>` : '');
    }
  }

  // clips made
  const clipsBox = $('#clips-made');
  const clips = v.clips || [];
  clipsBox.style.display = clips.length ? 'block' : 'none';
  if (clips.length) {
    clipsBox.innerHTML = '<div class="h3">📎 Your vertical clips (ready for TikTok/Shorts)</div><div class="clip-cards">' + clips.map((c, i) => `
      <div class="clip-card">
        <video src="/api/videos/${v.id}/clips/${i}/file" controls muted></video>
        <div class="clip-meta">${fmt.time(c.duration)} · ${c.width}×${c.height}</div>
        <a class="btn btn-sm" href="/api/videos/${v.id}/clips/${i}/file" download>⬇ Save</a>
      </div>`).join('') + '</div>';
  }

  // progress bar
  $('#progress-wrap').style.display = v.stage.includes('ing') ? 'block' : 'none';
}

async function deleteVideo(id) {
  await api.del('/api/videos/' + id);
  if (state.activeVideoId === id) closeDetail();
  refreshVideos();
  toast('Removed.');
}

/** Re-render the open detail panel from the latest list (after background jobs). */
function reopenActive() {
  if (!state.activeVideoId) return;
  const v = state.videos.find((x) => x.id === state.activeVideoId);
  if (v) renderDetail(v);
}

function closeDetail() {
  state.activeVideoId = null;
  $('#detail').style.display = 'none';
}
$('#detail-close')?.addEventListener('click', closeDetail);

/* ------------------------------------------------------------------ upload */
$('#dropzone').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (e) => e.target.files[0] && uploadFile(e.target.files[0]));
['dragover', 'dragenter'].forEach((ev) => $('#dropzone').addEventListener(ev, (e) => { e.preventDefault(); $('#dropzone').classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => $('#dropzone').addEventListener(ev, (e) => { e.preventDefault(); $('#dropzone').classList.remove('drag'); }));
$('#dropzone').addEventListener('drop', (e) => {
  const f = e.dataTransfer.files?.[0];
  if (f) uploadFile(f);
});

async function uploadFile(file) {
  if (!/video\//.test(file.type) && !/\.(mp4|mkv|mov|webm|m4v|avi)$/i.test(file.name)) {
    toast('Please choose a video file.', 'error');
    return;
  }
  const fd = new FormData();
  fd.append('file', file);
  const status = $('#upload-status');
  status.style.display = 'block';
  status.textContent = `Uploading ${file.name} (${fmt.bytes(file.size)})…`;
  try {
    const res = await fetch('/api/videos/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    status.textContent = '✅ Uploaded! Analyzing…';
    openDetail(data);
    await analyze(data.id);
    status.style.display = 'none';
  } catch (e) {
    status.style.display = 'none';
    toast('Upload failed: ' + e.message, 'error');
  }
}

/* ------------------------------------------------------------------ actions */
async function analyze(id) {
  try {
    const v = await api.post(`/api/videos/${id}/analyze`, {});
    renderDetail(v);
    refreshVideos();
  } catch (e) {
    toast('Analysis failed: ' + e.message, 'error');
  }
}

async function runFix(id) {
  setBusy($('#btn-fix'), true, 'Fixing…');
  try {
    await api.post(`/api/videos/${id}/fix`, { maxHeight: 1080 });
    toast('Fix started — watch the progress bar.');
  } catch (e) {
    toast('Fix failed to start: ' + e.message, 'error');
  } finally {
    setBusy($('#btn-fix'), false);
  }
}

async function runClips(id) {
  setBusy($('#btn-clips'), true, 'Cutting…');
  try {
    const motifs = Array.from($$('.hl-item')).map((el) => ({ at: parseFloat(el.dataset.at), duration: 30 }));
    await api.post(`/api/videos/${id}/clips`, { moments: motifs.slice(0, 3) });
    toast('Clipping started — building vertical clips.');
  } catch (e) {
    toast('Clip failed to start: ' + e.message, 'error');
  } finally {
    setBusy($('#btn-clips'), false);
  }
}

async function runTranscribe(id) {
  setBusy($('#btn-transcribe'), true, 'Transcribing…');
  toast('Whisper is listening… (first run downloads a model)');
  try {
    await api.post(`/api/videos/${id}/transcribe`, { model: 'small' });
    // result arrives via SSE 'job' + 'video' events
  } catch (e) {
    toast('Transcription failed: ' + e.message, 'error');
  } finally {
    setBusy($('#btn-transcribe'), false);
  }
}

async function runCopy(id) {
  setBusy($('#btn-copy'), true, 'Writing…');
  try {
    const c = await api.post('/api/copy/generate', { kind: 'clip' });
    toast('Copy generated: ' + c.title);
    const v = state.videos.find((x) => x.id === id);
    if (v) { v.copy = c; renderDetail(v); }
  } catch (e) {
    toast('Copy generation failed: ' + e.message, 'error');
  } finally {
    setBusy($('#btn-copy'), false);
  }
}

/* ------------------------------------------------------------------ SSE progress */
function connectEvents() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (!msg.type) return;
    const d = msg.data;
    if (msg.type === 'video') {
      if (state.activeVideoId === d.id) {
        if (d.stage) $('#detail-stage').textContent = stageLabel(d.stage);
        if (d.stage === 'fixed' || d.stage === 'clipped' || d.captions != null) {
          refreshVideos().then(() => {
            const v = state.videos.find((x) => x.id === d.id);
            if (v && state.activeVideoId === d.id) renderDetail(v);
          });
        }
      }
      refreshVideos();
    }
    if (msg.type === 'job') {
      if (d.kind === 'captions') {
        if (d.status === 'done') { toast(`🎙️ ${d.captions || 0} captions ready`); refreshVideos().then(reopenActive); }
        if (d.status === 'error') toast('❌ Captions failed: ' + (d.error || ''), 'error');
      } else {
        if (d.status === 'done') toast('✅ Job finished.');
        if (d.status === 'error') toast('❌ ' + (d.error || 'Job failed'), 'error');
        if (d.progress === 'end' || d.status === 'done' || d.status === 'error') {
          setBar(1);
        } else if (d.out_time_ms && d.durationTarget) {
          setBar(parseInt(d.out_time_ms, 10) / 1000 / d.durationTarget);
        }
      }
    }
    if (msg.type === 'chat') pushChat(d);
    if (msg.type === 'reply') pushReply(d);
    if (msg.type === 'log') pushLog(d);
    if (msg.type === 'publish') renderPublishProgress(d);
    if (msg.type === 'liveclip') onLiveClipEvent(d);
    if (msg.type === 'autoclip') onAutoClip(d);
  };
  es.onerror = () => { /* browser auto-reconnects */ };
}

function setBar(frac) {
  const bar = $('#progress-bar');
  const wrap = $('#progress-wrap');
  if (frac >= 1) { bar.style.width = '100%'; setTimeout(() => { wrap.style.display = 'none'; bar.style.width = '0%'; }, 800); }
  else { wrap.style.display = 'block'; bar.style.width = Math.round(frac * 100) + '%'; }
}

/* ------------------------------------------------------------------ live clips */
const liveClipState = { status: null, source: 'url', offset: 25, cuts: [] };

function liveLog(msg, cls = '') {
  const c = $('#live-console');
  if (!c) return;
  const line = document.createElement('div');
  line.className = cls;
  line.innerHTML = `<span class="feed-time">${fmt.clock(Date.now())}</span> ${esc(msg)}`;
  c.appendChild(line);
  c.scrollTop = c.scrollHeight;
}

async function refreshLiveClip() {
  try {
    liveClipState.status = await api.get('/api/liveclip/status');
    if (liveClipState.status && !liveClipState.status.running) liveClipState.status = null;
  } catch { liveClipState.status = null; }
  renderLiveClip();
}

function renderLiveClip() {
  const st = liveClipState.status;
  const btn = $('#live-record-btn');
  if (st && st.running) {
    btn.textContent = '■ Stop recording';
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-danger');
    $('#live-hint').style.display = 'block';
    $('#live-hint').textContent = `● Recording (${st.source || 'live'}) — buffer keeps the last ~2 min. Clips made: ${st.processed || 0}`;
  } else {
    btn.textContent = '● Start recording';
    btn.classList.add('btn-primary');
    btn.classList.remove('btn-danger');
    $('#live-hint').style.display = 'none';
  }
  // source switch UI
  $$('input[name="livesrc"]').forEach((r) => r.addEventListener('change', () => {
    liveClipState.source = r.value;
    $('#live-url-field').style.display = r.value === 'url' ? 'flex' : 'none';
    $('#live-tiktok-field').style.display = r.value === 'tiktok' ? 'flex' : 'none';
    $('#live-ps5-field').style.display = r.value === 'ps5' ? 'flex' : 'none';
    $('#live-check-btn').style.display = r.value === 'tiktok' ? 'inline-flex' : 'none';
  }));
}

$('#live-record-btn')?.addEventListener('click', async () => {
  const st = liveClipState.status;
  if (st && st.running) {
    await api.post('/api/liveclip/stop');
    liveClipState.status = null;
    liveLog('Recording stopped.');
    renderLiveClip();
    return;
  }
  setBusy($('#live-record-btn'), true, 'Connecting…');
  try {
    if (liveClipState.source === 'ps5') {
      const acc = $('#live-ps5-acc').value.trim();
      if (!acc) { toast('Enter your PS5 Account-ID.', 'error'); return; }
      liveLog('Launching PS5 remote play relay…');
      const r = await api.post('/api/liveclip/record/ps5', { accountId: acc });
      liveClipState.status = r.status;
      liveLog('PS5 relay ready at ' + r.hls + ' — recording.');
    } else if (liveClipState.source === 'tiktok') {
      const user = $('#live-tiktok-user').value.trim();
      if (!user) { toast('Enter your TikTok @username.', 'error'); return; }
      liveLog(`Resolving TikTok live for @${user.replace(/^@/, '')} …`);
      const r = await api.post('/api/liveclip/record/tiktok', { username: user });
      liveClipState.status = r.status;
      const v = r.live?.viewerCount;
      liveLog(`📱 TikTok LIVE captured (title: ${r.live?.title || 'n/a'}${v ? ` · ${v} viewers` : ''}).`);
    } else {
      const url = $('#live-url').value.trim();
      if (!url) { toast('Enter a stream URL or YouTube id.', 'error'); return; }
      liveLog('Connecting to source…');
      const r = await api.post('/api/liveclip/record', { url });
      liveClipState.status = r.status;
      liveLog('Recording live.');
    }
    toast('Recording started ✅');
    renderLiveClip();
  } catch (e) {
    liveLog('⚠️ ' + e.message, 'feed-error');
    toast('Could not start: ' + e.message, 'error');
  } finally {
    setBusy($('#live-record-btn'), false);
  }
});

$('#live-check-btn')?.addEventListener('click', async () => {
  if (liveClipState.source !== 'tiktok') return;
  const user = $('#live-tiktok-user').value.trim();
  if (!user) { toast('Enter your TikTok @username first.', 'error'); return; }
  setBusy($('#live-check-btn'), true, 'Checking…');
  try {
    const r = await api.post('/api/liveclip/inspect', { url: user });
    const d = r.detail || {};
    if (d.isLive) liveLog(`🟢 @${user.replace(/^@/, '')} is LIVE — ${d.title || ''} (${d.viewers ?? '?'} viewers)`, 'feed-ok');
    else liveLog(`⚪ @${user.replace(/^@/, '')} is not live right now.`, 'feed-warn');
  } catch (e) {
    liveLog('⚠️ ' + e.message, 'feed-error');
    toast('Check failed: ' + e.message, 'error');
  } finally {
    setBusy($('#live-check-btn'), false);
  }
});

$('#live-cut-btn')?.addEventListener('click', async () => {
  setBusy($('#live-cut-btn'), true, 'Cutting…');
  try {
    const offset = liveClipState.offset;
    const duration = parseInt($('#live-clip-dur').value, 10);
    const title = $('#live-clip-title').value.trim();
    const vertical = $('#live-clip-vertical').checked;
    await api.post('/api/liveclip/cut', { offset, duration, title: title || null, vertical });
    liveClipState.cuts.unshift({ at: Date.now(), offset, duration, name: title || 'Live clip' });
    liveClipState.cuts = liveClipState.cuts.slice(0, 20);
    renderCutHistory();
    liveLog(`✂️ Cutting ${duration}s from ${offset}s back… (runs in the background — watch the feed)`, 'feed-info');
    toast('Cutting — the clip lands in your Library when done ✂️');
  } catch (e) {
    liveLog('⚠️ ' + e.message, 'feed-error');
    toast('Cut failed: ' + e.message, 'error');
  } finally {
    setBusy($('#live-cut-btn'), false);
  }
});

// Auto-edit: cut + auto-captions + title + description + hashtags
// Runs as a background job (transcribe + render is slow) — progress and the
// finished clip arrive over SSE (onLiveClipEvent → type 'auto').
let autoBusy = false;
$('#live-auto-btn')?.addEventListener('click', async () => {
  if (autoBusy) return;
  try {
    const offset = liveClipState.offset;
    const duration = parseInt($('#live-clip-dur').value, 10);
    const title = $('#live-clip-title').value.trim();
    const vertical = $('#live-clip-vertical').checked;
    const captions = $('#live-clip-caption').checked;
    autoBusy = true;
    setBusy($('#live-auto-btn'), true, 'Auto-editing…');
    await api.post('/api/liveclip/auto', { offset, duration, title: title || null, vertical, captions });
    liveLog(`✨ Auto-edit started (${offset}s back, ${duration}s)… watch the steps here`, 'feed-info');
    toast('Auto-edit running — watch the feed ✨');
  } catch (e) {
    autoBusy = false;
    setBusy($('#live-auto-btn'), false);
    liveLog('⚠️ ' + e.message, 'feed-error');
    toast('Auto-edit failed: ' + e.message, 'error');
  }
});

function autoEditFinished() {
  autoBusy = false;
  setBusy($('#live-auto-btn'), false);
}

function renderCutHistory() {
  const box = $('#live-cut-history');
  if (!box) return;
  if (!liveClipState.cuts.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="h3">🗂️ This session\'s clips</div>' + liveClipState.cuts.slice(0, 12).map((c) => `
    <span class="live-marker"><span class="t">${c.offset}s</span> ${fmt.clock(c.at)} · ${esc(c.name)}</span>`).join('');
}

// offset chips
function bindOffsetChips() {
  $$('#live-timeline .map-chip[data-offset]').forEach((chip) => chip.addEventListener('click', () => {
    $$('#live-timeline .map-chip').forEach((c) => c.classList.remove('hot'));
    chip.classList.add('hot');
    liveClipState.offset = parseInt(chip.dataset.offset, 10);
  }));
}
bindOffsetChips();

/* SSE: liveclip events */
function onLiveClipEvent(d) {
  if (!d) return;
  if (d.type === 'status') {
    if (d.running) {
      liveClipState.status = d;
      renderLiveClip();
    } else if (liveClipState.status) {
      liveClipState.status = null;
      renderLiveClip();
      liveLog('Recording idle.');
    }
  }
  if (d.type === 'cut') {
    liveLog(`🎬 Clip cut → "${d.name}" (${Number(d.duration || 0).toFixed(1)}s) — saved to your Library!`, 'feed-info');
    toast('Clip saved to Library 🎬');
    refreshVideos().then(() => d.videoId && openDetail(d.videoId));
  }
  if (d.type === 'cuterror') {
    liveLog('⚠️ Cut failed: ' + esc(d.error || 'unknown error'), 'feed-error');
    toast('Cut failed: ' + (d.error || 'unknown error'), 'error');
  }
  if (d.type === 'ps5') liveLog('PS5: ' + esc(d.state || JSON.stringify(d)), 'feed-info');
  if (d.type === 'auto') {
    const steps = { start: '✨ Auto-edit running…', cut: '✂️ Cutting moment…', transcribe: '🎙️ Transcribing audio (local Whisper)…', captions: '💬 Applying captions…', render: '🎬 Rendering clip…', done: '✅ Auto-edit done', error: '⚠️ Auto-edit failed' };
    liveLog(steps[d.step] || esc(d.step), d.step === 'error' ? 'feed-error' : 'feed-info');
    if (d.step === 'done') {
      liveLog(`✨ "${d.name}"${d.captions ? ` with ${d.captions} captions` : ''}`, 'feed-info');
      liveLog(`📝 ${d.copy?.title || ''}`, 'feed-info');
      liveLog(`🏷️ ${d.copy?.hashtags || ''}`, 'feed-info');
      if (d.warn) liveLog('⚠️ ' + esc(d.warn), 'feed-warn');
      liveClipState.cuts.unshift({ at: Date.now(), offset: d.offset ?? liveClipState.offset, duration: d.duration || 0, name: d.name || 'Auto clip' });
      liveClipState.cuts = liveClipState.cuts.slice(0, 20);
      renderCutHistory();
      toast('Auto-edit saved to Library ✨');
      refreshVideos().then(() => d.videoId && openDetail(d.videoId));
      autoEditFinished();
    }
    if (d.step === 'error') {
      toast('Auto-edit failed: ' + (d.error || 'unknown error'), 'error');
      autoEditFinished();
    }
  }
  if (d.type === 'render') {
    if (d.progress === 'end') liveLog('Render done ✓', 'feed-info');
  }
}

// chat-triggered auto clip completion (SSE autoclip)
function onAutoClip(d) {
  if (!d) return;
  if (d.error) { liveLog('⚠️ Auto-clip failed: ' + esc(d.error), 'feed-error'); toast('Auto-clip failed: ' + d.error, 'error'); }
  else { liveLog(`🎬 Auto-clip (requested by @${esc(d.from || 'chat')}) → "${esc(d.name)}"`, 'feed-info'); toast('Auto-clip ready! 🎬'); refreshVideos(); }
}

/* ------------------------------------------------------------------ autopilot */
async function refreshAutopilot() {
  try {
    const st = await api.get('/api/autopilot/status');
    state.autopilot = st;
    renderAutopilot();
  } catch (e) { /* */ }
  renderSettingsSummary();
}

function renderAutopilot() {
  const st = state.autopilot || {};
  const runBtn = $('#ap-run');
  runBtn.textContent = st.running ? '■ Stop autopilot' : '▶ Start autopilot';
  $('#ap-status').textContent = st.running
    ? '🟢 Autopilot live — watching all chats and replying'
    : '⏸ Autopilot off';
  $('#ap-youtube-state').textContent = st.youtube?.connected ? `YouTube: ✓ (${st.youtube.liveChatId ? 'chat attached' : 'waiting for live…'})` : 'YouTube: not connected';
  $('#ap-tiktok-state').textContent = st.tiktok?.connected ? `TikTok: ✓ @${st.tiktok.user}` : 'TikTok: not connected';
  $('#ap-twitch-state').textContent = st.twitch?.connected ? `Twitch: ✓ #${st.twitch.channel}` : 'Twitch: not connected';
  $('#ap-kick-state').textContent = st.kick?.connected ? `Kick: ✓ @${st.kick.channel}` : 'Kick: not connected';
}

$('#ap-run')?.addEventListener('click', async () => {
  if (state.autopilot.running) {
    await api.post('/api/autopilot/stop');
    toast('Autopilot stopped.');
  } else {
    const youtubeVideoId = $('#ap-yt-id').value.trim();
    const tiktokUser = $('#ap-tt-user').value.trim();
    const twitchChannel = $('#ap-twitch-ch').value.trim();
    const kickChannel = $('#ap-kick-ch').value.trim();
    if (!youtubeVideoId && !tiktokUser && !twitchChannel && !kickChannel) {
      toast('Enter at least one: YouTube video ID, TikTok @username, Twitch channel, or Kick channel.', 'error');
      return;
    }
    setBusy($('#ap-run'), true, 'Starting…');
    try {
      await api.post('/api/autopilot/start', { youtubeVideoId, tiktokUser, twitchChannel, kickChannel });
      toast('Autopilot started!');
    } catch (e) {
      toast('Could not start: ' + e.message, 'error');
    } finally {
      setBusy($('#ap-run'), false);
    }
  }
  refreshAutopilot();
});

function pushChat(m) {
  if (!m) return;
  state.chatMessages.unshift(m);
  state.chatMessages = state.chatMessages.slice(0, 200);
  renderChatFeed();
}

function pushReply(m) {
  pushLog({ level: 'info', msg: `↩️ @${m.user} (${m.platform}): ${m.out}${m.error ? ' — ERROR: ' + m.error : ''}` });
}

function pushLog(l) {
  state.logs.unshift({ ...l, at: l.at || Date.now() });
  state.logs = state.logs.slice(0, 200);
  renderChatFeed();
}

function renderChatFeed() {
  const feed = $('#ap-feed');
  if (!feed) return;
  // Merge chat messages + logs into one timeline (chat is what fans actually said).
  const entries = [
    ...state.chatMessages.map((m) => ({ at: m.at, kind: 'chat', m })),
    ...state.logs.map((l) => ({ at: l.at || Date.now(), kind: 'log', l })),
  ].sort((a, b) => b.at - a.at).slice(0, 80);
  feed.innerHTML = entries.length ? entries.map((e) => {
    if (e.kind === 'chat') {
      const m = e.m;
      const platIcon = { youtube: '▶️', tiktok: '🎵', twitch: '👾', kick: '🥋' }[m.platform] || '💬';
      const who = m.kind === 'self' ? '🤖 you (draft)' : esc(m.author || m.userId || 'Viewer');
      return `<div class="feed-line feed-chat"><span class="feed-time">${fmt.clock(e.at)}</span> ${platIcon} <b>${who}</b>: ${esc(m.text)}</div>`;
    }
    const l = e.l;
    return `<div class="feed-line feed-${l.level || 'info'}"><span class="feed-time">${fmt.clock(e.at)}</span> ${esc(l.msg)}</div>`;
  }).join('') : '<div class="feed-empty">Autopilot activity will appear here. Start it up! 🚀</div>';
  feed.scrollTop = 0;
}

/* quick manual reply */
$('#ap-say-btn')?.addEventListener('click', async () => {
  const text = $('#ap-say').value.trim();
  if (!text) return;
  const platform = $('#ap-say-platform').value;
  try {
    await api.post('/api/autopilot/say', { platform, text });
    $('#ap-say').value = '';
  } catch (e) {
    toast('Send failed: ' + e.message, 'error');
  }
});

/* ------------------------------------------------------------------ connections hub */
const stateConn = { platforms: [], live: {}, selected: null };

async function refreshConnections() {
  try {
    const d = await api.get('/api/connections');
    stateConn.platforms = d.platforms || [];
    stateConn.live = d.live || {};
    renderConnections();
  } catch (e) {
    toast('Could not load connections: ' + e.message, 'error');
  }
}

const PLATFORM_META = {
  youtube: { logo: '▶️', cls: 'yt', name: 'YouTube' },
  tiktok: { logo: '🎵', cls: 'tt', name: 'TikTok' },
  twitch: { logo: '👾', cls: 'tw', name: 'Twitch' },
  kick: { logo: '🥋', cls: 'kick', name: 'Kick' },
};

function renderConnections() {
  const grid = $('#conn-grid');
  if (!grid) return;
  grid.innerHTML = stateConn.platforms.map((p) => {
    const meta = PLATFORM_META[p.id] || { logo: '🔌', cls: '', name: p.name };
    const live = stateConn.live[p.id];
    const liveLabel = live
      ? (typeof live === 'string' ? `· chatting in ${live}` : '· chat live')
      : '';
    return `
    <div class="conn-card ${p.connected ? 'connected' : ''} ${stateConn.selected === p.id ? 'selected' : ''}" data-platform="${p.id}">
      <div class="conn-logo ${meta.cls}">${meta.logo}</div>
      <h4>${meta.name}</h4>
      <div class="conn-desc">${esc(p.name + ' · ' + p.keyHint || '')}</div>
      <div class="conn-status">
        <span class="dot ${p.connected ? '' : 'off'}"></span>
        ${p.connected
          ? `<span class="conn-account">${p.account ? esc(String(p.account)) : 'Linked'} ${liveLabel}</span>`
          : '<span style="color:var(--dim)">Not linked</span>'}
      </div>
    </div>`;
  }).join('');
  $$('.conn-card').forEach((c) => c.addEventListener('click', () => {
    stateConn.selected = c.dataset.platform;
    renderConnections();
    renderConnDetail();
  }));
  if (stateConn.selected) renderConnDetail();
}

function fieldRow(label, inputHtml) {
  return `<div class="field"><label>${label}</label>${inputHtml}</div>`;
}

function renderConnDetail() {
  const box = $('#conn-detail');
  if (!box) return;
  const id = stateConn.selected;
  const p = stateConn.platforms.find((x) => x.id === id);
  if (!p) { box.classList.remove('open'); box.innerHTML = ''; return; }
  box.classList.add('open');

  if (id === 'youtube') {
    box.innerHTML = `
      <h3>▶️ YouTube</h3>
      ${p.connected
        ? `<div class="yt-connected"><span class="dot"></span> Connected as <b>${esc(p.account?.title || 'your channel')}</b> (${p.account?.subs != null ? Number(p.account.subs).toLocaleString() + ' subs' : ''})</div>`
        : ''}
      <div class="conn-field-row">
        <button class="btn btn-primary" id="conn-yt-btn">🔴 ${p.connected ? 'Re-connect YouTube channel' : 'Connect with Google'}</button>
        <a class="btn btn-ghost" href="https://console.cloud.google.com/apis/credentials" target="_blank">Get YouTube API key ↗</a>
      </div>
      <div class="hint">Uploads + live-chat replying. Uses your own Google OAuth so there are no API fees.</div>`;
    $('#conn-yt-btn')?.addEventListener('click', async () => {
      try {
        const { url } = await api.get('/api/youtube/auth-url');
        window.location.href = url;
      } catch (e) {
        toast(e.message, 'error');
      }
    });
    return;
  }

  if (id === 'tiktok') {
    box.innerHTML = `
      <h3>🎵 TikTok</h3>
      <div class="hint" style="margin:0 0 6px">TikTok live capture + chat works without OAuth — just your @username. Auto-posting clips comes next via phone pairing.</div>
      <div class="conn-mini-form">
        <div class="field"><label>TikTok @username</label><input class="input" id="conn-tt-user" placeholder="yourchannel" value="${esc(p.account || '')}" /></div>
        <div class="conn-field-row">
          <button class="btn btn-primary" id="conn-tt-save">💾 Save</button>
          <button class="btn" id="conn-tt-test">👀 Test live chat</button>
        </div>
      </div>`;
    $('#conn-tt-save')?.addEventListener('click', async () => {
      const v = $('#conn-tt-user').value.trim();
      await api.post('/api/settings', { tiktokChannel: v.replace(/^@/, '') });
      toast('TikTok channel saved ✅');
      refreshConnections();
    });
    $('#conn-tt-test')?.addEventListener('click', async () => {
      const v = $('#conn-tt-user').value.trim();
      if (!v) { toast('Enter a @username first.', 'error'); return; }
      try { await api.post('/api/connections/chat/test', { platform: 'tiktok', channel: v }); toast('✅ TikTok chat connected!'); }
      catch (e) { toast('TikTok test failed: ' + e.message, 'error'); }
    });
    return;
  }

  if (id === 'twitch') {
    box.innerHTML = `
      <h3>👾 Twitch</h3>
      <div class="hint" style="margin:0 0 12px">Read chat from any public channel with <b>zero keys</b>. Add a bot account + OAuth to let the autopilot reply, and an App token to enable Helix-looking-up.</div>
      <div class="conn-mini-form">
        ${fieldRow('Channel to watch', `<input class="input" id="conn-tw-channel" placeholder="yourtwitch" />`)}
        ${fieldRow('Bot username (optional, for replies)', `<input class="input" id="conn-tw-botuser" placeholder="my_bot_account" />`)}
        ${fieldRow('Bot OAuth token (oauth:…)', `<input class="input" id="conn-tw-botoauth" type="password" placeholder="oauth:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" />`)}
        ${fieldRow('Client ID (optional)', `<input class="input" id="conn-tw-clientid" placeholder="your twitch app client id" />`)}
        ${fieldRow('App access token (optional)', `<input class="input" id="conn-tw-apptoken" type="password" placeholder="app access token" />`)}
        <div class="conn-field-row">
          <button class="btn btn-primary" id="conn-tw-save">💾 Save Twitch</button>
          <button class="btn" id="conn-tw-test">👀 Test read (watches chat)</button>
        </div>
        <div class="ghost-note">
          Get your bot OAuth at <a href="https://twitchtokengenerator.com" target="_blank">twitchtokengenerator.com</a> (scope <b>chat:read chat:edit</b>).
          Leave bot fields blank to start read-only in seconds.
        </div>
      </div>`;
    // prefill from current settings
    const tw = p.twitch || {};
    if (tw.channel) $('#conn-tw-channel').value = tw.channel;
    if (tw.botUser) $('#conn-tw-botuser').value = tw.botUser;
    $('#conn-tw-save')?.addEventListener('click', async () => {
      const body = {
        channel: $('#conn-tw-channel').value.trim(),
        botUser: $('#conn-tw-botuser').value.trim() || null,
        botOauth: $('#conn-tw-botoauth').value.trim() || null,
        clientId: $('#conn-tw-clientid').value.trim() || null,
        appToken: $('#conn-tw-apptoken').value.trim() || null,
      };
      if (!body.channel) { toast('Enter a channel name.', 'error'); return; }
      try {
        await api.post('/api/connections/twitch', body);
        $('#conn-tw-botoauth').value = ''; $('#conn-tw-apptoken').value = '';
        toast('Twitch saved ✅');
        refreshConnections();
      } catch (e) { toast('Save failed: ' + e.message, 'error'); }
    });
    $('#conn-tw-test')?.addEventListener('click', async () => {
      const ch = $('#conn-tw-channel').value.trim();
      if (!ch) { toast('Enter a channel to watch.', 'error'); return; }
      try { await api.post('/api/connections/chat/test', { platform: 'twitch', channel: ch }); toast(`✅ Watching Twitch #${ch} — messages appear in the Live Autopilot feed.`); }
      catch (e) { toast('Twitch test failed: ' + e.message, 'error'); }
    });
    return;
  }

  if (id === 'kick') {
    box.innerHTML = `
      <h3>🥋 Kick</h3>
      <div class="hint" style="margin:0 0 12px">Read any Kick channel's chat in real time (Pusher websocket). Sending replies needs a logged-in session, so it's read-only for now — the autopilot drafts replies you can hit.</div>
      <div class="conn-mini-form">
        <div class="field"><label>Kick channel</label><input class="input" id="conn-kick-user" placeholder="yourkick" value="${esc(p.account || '')}" /></div>
        <div class="conn-field-row">
          <button class="btn btn-primary" id="conn-kick-save">💾 Save</button>
          <button class="btn" id="conn-kick-test">👀 Test read</button>
        </div>
      </div>`;
    $('#conn-kick-save')?.addEventListener('click', async () => {
      const v = $('#conn-kick-user').value.trim();
      if (!v) { toast('Enter a channel name.', 'error'); return; }
      try { await api.post('/api/connections/kick', { channel: v }); toast('Kick channel saved ✅'); refreshConnections(); }
      catch (e) { toast('Save failed: ' + e.message, 'error'); }
    });
    $('#conn-kick-test')?.addEventListener('click', async () => {
      const v = $('#conn-kick-user').value.trim();
      if (!v) { toast('Enter a channel name.', 'error'); return; }
      try { await api.post('/api/connections/chat/test', { platform: 'kick', channel: v }); toast(`✅ Reading Kick @${v} — messages appear in the Live Autopilot feed.`); }
      catch (e) { toast('Kick test failed: ' + e.message, 'error'); }
    });
    return;
  }
}

/* ------------------------------------------------------------------ publish */
async function refreshPublish() {
  refreshVideos();
  try {
    const pubs = await api.get('/api/publishes');
    state.publishResults = pubs;
    renderPublishHistory();
  } catch { /* */ }
  const status = await api.get('/api/youtube/status');
  state.youtubeChannel = status;
  renderYoutubeConnect();
}

function renderYoutubeConnect() {
  const box = $('#yt-connect');
  if (!box) return;
  if (state.youtubeChannel?.connected) {
    const ch = state.youtubeChannel.channel || {};
    box.innerHTML = `<div class="yt-connected"><span class="dot"></span> YouTube connected as <b>${esc(ch.title || 'channel')}</b> (${ch.subs ? Number(ch.subs).toLocaleString() : '?'} subs)</div>`;
  } else {
    box.innerHTML = `<button class="btn btn-primary" id="yt-link-btn">🔴 Connect YouTube channel</button>
      <div class="hint">OAuth login via Google — grant upload privileges to your channel.</div>`;
    $('#yt-link-btn')?.addEventListener('click', async () => {
      try {
        const { url } = await api.get('/api/youtube/auth-url');
        window.location.href = url;
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }
}

function renderPublishHistory() {
  const box = $('#publish-history');
  if (!box) return;
  if (!state.publishResults.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="h3">📤 Recent publishes</div>' + state.publishResults.slice(0, 10).map((p) => `
    <div class="pub-row">
      <span class="pub-time">${fmt.when(p.at || p.createdAt)}</span>
      <span class="pub-status pub-${p.status}">${p.status}</span>
      ${(p.results || []).map((r) => `<span class="pub-chip pub-${r.status}">${r.platform} ${r.url ? `↗ ${r.url}` : ''}</span>`).join(' ')}
    </div>`).join('');
}

function renderPublishProgress(d) {
  if (d.platform) {
    const box = $('#publish-progress');
    if (box) box.innerHTML = `<div class="pub-progress">${d.platform}: ${d.status}${d.url ? ` → <a href="${d.url}" target="_blank">${d.url}</a>` : ''}${d.error ? ` <span class="err">${esc(d.error)}</span>` : ''}</div>`;
  }
}

$('#publish-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const videoId = $('#pub-video').value;
  const title = $('#pub-title').value.trim();
  const sendYoutube = $('#pub-to-youtube').checked;
  const sendTiktok = $('#pub-to-tiktok').checked;
  const privacy = $('#pub-privacy').value;
  const tags = $('#pub-tags').value;
  const clips = state.videos.find((v) => v.id === videoId)?.clips || [];
  if (!videoId) { toast('Pick a video first.', 'error'); return; }
  setBusy($('#pub-submit'), true, 'Publishing…');
  try {
    const r = await api.post('/api/publish', {
      videoId, title,
      youtube: sendYoutube,
      tiktok: sendTiktok,
      clips: clips.map((c, i) => `${videoId}-clip-${i}`),
      privacy, tags,
    });
    toast('Publish run complete — check results below.');
    refreshPublish();
  } catch (e2) {
    toast('Publish failed: ' + e2.message, 'error');
  } finally {
    setBusy($('#pub-submit'), false);
  }
});

// Populate publish dropdown from videos
function refreshPublishDropdown() {
  const sel = $('#pub-video');
  if (!sel) return;
  const ready = state.videos.filter((v) => v.stage === 'fixed' || v.stage === 'clipped' || v.stage === 'analyzed');
  sel.innerHTML = '<option value="">— choose a video —</option>' + ready.map((v) => `<option value="${v.id}">${esc(v.name)} (${fmt.time(v.info?.duration)})</option>`).join('');
  sel.onchange = () => {
    const v = state.videos.find((x) => x.id === sel.value);
    if (v) {
      if (!$('#pub-title').value) $('#pub-title').value = v.name.replace(/\.[^.]+$/, '');
    }
  };
}

/* ------------------------------------------------------------------ cloud (Appwrite) */
async function refreshCloud() {
  try {
    const st = await api.get('/api/cloud/status');
    renderCloud(st);
  } catch { /* */ }
}

function renderCloud(st) {
  if (!st) return;
  // sidebar pill
  const pill = $('#cloud-pill');
  const pillText = $('#cloud-pill-text');
  if (pill && pillText) {
    pill.classList.toggle('on', st.active);
    pillText.textContent = st.active ? 'Cloud: Appwrite' : 'Cloud: local mode';
  }
  // settings card
  const card = $('#cloud-status-card');
  const text = $('#cloud-status-text');
  const sub = $('#cloud-status-sub');
  if (card && text) {
    card.querySelector('.big').classList.toggle('on', st.active);
    if (st.active) {
      text.textContent = 'Connected to Appwrite ✓';
      sub.innerHTML = `Endpoint <b>${esc(st.endpoint)}</b> · tracked db <b>${esc(st.databaseId)}</b> — videos and clips are mirrored to the cloud automatically.`;
    } else if (st.configured && st.error) {
      if (st.errorKind === 'auth') {
        text.textContent = '❌ API key has no permission — fix this in Appwrite';
        sub.innerHTML = 'This key can\'t write to the database. StreamPilot auto-tries all three Appwrite engines (TablesDB → DocumentsDB → Legacy) and needs a key that can create a database + table/collection + storage bucket. In Appwrite → <b>Integrations → API keys</b>, create a <b>new</b> key with <b>"Select all"</b> ticked, then paste it into <b>Settings → Cloud</b> below and hit <b>Connect</b>. (Editing an old key can silently drop scopes — always make a fresh one.)';
      } else {
        text.textContent = 'Configured, but not connected yet';
        sub.innerHTML = `Keys are set (project <b>${esc(st.projectId)}</b>) but the cloud didn't connect. Tap <b>Retry</b> — usually a one-off at this host.`;
      }
      const errBox = $('#cloud-status-err');
      if (errBox) { errBox.style.display = 'block'; errBox.textContent = '⚠ ' + (st.error || 'unknown error'); }
      refreshCloudScopes();
    } else if (st.configured) {
      text.textContent = 'Configured, but not active';
      sub.textContent = 'Credentials found but the schema wasn\'t initialised — re-connect to fix.';
    } else {
      text.textContent = 'No cloud connected';
      sub.textContent = 'Add your Appwrite Project ID + API key below to go live on the cloud. Until then everything runs locally.';
    }
  }

  // Retry button (only when keys are set but cloud is down)
  let retry = $('#cloud-retry');
  if (st.configured && !st.active && st.retry) {
    if (!retry) {
      retry = document.createElement('button');
      retry.id = 'cloud-retry';
      retry.type = 'button';
      retry.className = 'btn btn-success';
      retry.textContent = '🔄 Retry connection';
      retry.addEventListener('click', retryCloud);
      $('#cloud-status-card')?.appendChild(retry);
    }
    retry.style.display = 'inline-flex';
  } else if (retry) {
    retry.style.display = 'none';
  }

  // prefill endpoint if blank
  const ep = $('#cloud-endpoint');
  if (ep && !ep.value && st.endpoint) ep.value = st.endpoint;
}

async function retryCloud() {
  setBusy($('#cloud-retry'), true, 'Retrying…');
  try {
    const r = await api.post('/api/cloud/retry', {});
    toast('☁️ Cloud connected! ' + ((r.created || []).length ? `Created: ${r.created.join(', ')}` : ''), 'ok');
    await refreshCloud();
  } catch (e2) {
    toast('Still failing: ' + e2.message, 'error');
    await refreshCloud(); // re-render the error + keep the button
  } finally {
    setBusy($('#cloud-retry'), false);
  }
}

$('#cloud-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const endpoint = $('#cloud-endpoint').value.trim() || 'https://nyc.cloud.appwrite.io/v1';
  const projectId = $('#cloud-project').value.trim();
  const apiKey = $('#cloud-key').value.trim();
  if (!projectId || !apiKey) { toast('Project ID and API key are both required.', 'error'); return; }
  setBusy($('#cloud-connect'), true, 'Connecting…');
  try {
    const r = await api.post('/api/cloud/connect', { endpoint, projectId, apiKey });
    toast('☁️ Appwrite connected! ' + ((r.created || []).length ? `Created: ${r.created.join(', ')}` : ''), 'ok');
    $('#cloud-key').value = '';
    await refreshCloud();
  } catch (e2) {
    toast('Connection failed: ' + e2.message, 'error');
  } finally {
    setBusy($('#cloud-connect'), false);
  }
});

$('#cloud-disconnect')?.addEventListener('click', async () => {
  await api.post('/api/cloud/disconnect');
  toast('Disconnected from Appwrite — back to local mode.');
  await refreshCloud();
});

// Granular scope checklist — shows every permission the key is missing.
async function refreshCloudScopes() {
  const box = $('#cloud-scopes');
  if (!box) return;
  try {
    const r = await api.get('/api/cloud/scopes');
    if (!r.configured || !r.checks || !r.checks.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="hint" style="margin:4px 0 6px"><b>Key permission check</b> (' + r.okCount + '/' + r.total + ' OK):</div>'
      + r.checks.map((c) => `<div class="scope-line ${c.ok ? 'ok' : 'bad'}">${c.ok ? '✅' : '❌'} ${esc(c.name)}${c.missing?.length ? ` <span class="dim">— add <b>${esc(c.missing[0])}</b></span>` : ''}${c.error ? ` <span class="dim">— ${esc(c.error)}</span>` : ``}</div>`).join('');
  } catch (e) {
    box.innerHTML = '';
  }
}

/* ------------------------------------------------------------------ settings */
async function refreshSettings() {
  try {
    const s = await api.get('/api/settings');
    state.settings = s;
    $('#set-game').value = s.game || '';
    $('#set-schedule').value = s.schedule || '';
    $('#set-socials').value = s.socials || '';
    $('#set-donation').value = s.donation || '';
    $('#set-autopilot').checked = !!s.autopilotEnabled;
    $('#set-faqs').value = (s.brain?.faqs || []).map((f) => `${f.question} :: ${f.answer}`).join('\n');
  } catch { /* */ }
}

function renderSettingsSummary() {
  // small stats on autopilot page top
  const el = $('#ap-autopilot-toggle');
  if (el) el.textContent = state.settings.autopilotEnabled ? 'Autopilot replies: ON' : 'Autopilot replies: OFF';
}

$('#settings-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    game: $('#set-game').value.trim(),
    schedule: $('#set-schedule').value.trim(),
    socials: $('#set-socials').value.trim(),
    donation: $('#set-donation').value.trim(),
    autopilotEnabled: $('#set-autopilot').checked,
    brain: {
      faqs: $('#set-faqs').value.split('\n').map((l) => {
        const [q, a] = l.split('::');
        return q && a ? { question: q.trim(), answer: a.trim() } : null;
      }).filter(Boolean),
    },
  };
  try {
    await api.post('/api/settings', body);
    toast('Settings saved ✅');
  } catch (e2) {
    toast('Save failed: ' + e2.message, 'error');
  }
});

/* ------------------------------------------------------------------ init */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Handle OAuth callback query params on load
function handleOauthParams() {
  const q = new URLSearchParams(location.search);
  if (q.get('youtube') === 'connected') { toast('YouTube connected! 🎉', 'ok'); history.replaceState({}, '', '/'); refreshPublish(); }
  if (q.get('youtube') === 'denied') toast('YouTube connection was cancelled.', 'error');
  if (q.get('youtube') === 'error') toast('YouTube error: ' + (q.get('reason') || 'unknown'), 'error');
}

async function init() {
  connectEvents();
  await refreshCloud();
  await refreshVideos();
  await refreshAutopilot();
  handleOauthParams();
  showView('library');
}
init();

// re-render publish dropdown whenever videos refresh
const _origRefresh = refreshVideos;
refreshVideos = async function () {
  await _origRefresh();
  refreshPublishDropdown();
};
