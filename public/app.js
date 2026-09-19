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
const views = ['library', 'liveclips', 'autopilot', 'publish', 'settings'];
function showView(name) {
  views.forEach((v) => {
    $('#view-' + v)?.classList.toggle('active', v === name);
    $(`.nav-item[data-view="${v}"]`)?.classList.toggle('active', v === name);
  });
  if (name === 'library') refreshVideos();
  if (name === 'liveclips') refreshLiveClip();
  if (name === 'autopilot') refreshAutopilot();
  if (name === 'publish') refreshPublish();
  if (name === 'settings') refreshSettings();
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
    <a class="btn btn-ghost" href="/api/videos/${v.id}/file" download>⬇ Download video</a>
  `;
  $('#btn-fix')?.addEventListener('click', () => runFix(v.id));
  $('#btn-clips')?.addEventListener('click', () => runClips(v.id));

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
        if (d.stage === 'fixed' || d.stage === 'clipped') {
          refreshVideos().then(() => {
            const v = state.videos.find((x) => x.id === d.id);
            if (v && state.activeVideoId === d.id) renderDetail(v);
          });
        }
      }
      refreshVideos();
    }
    if (msg.type === 'job') {
      if (d.status === 'done') toast('✅ Job finished.');
      if (d.status === 'error') toast('❌ ' + (d.error || 'Job failed'), 'error');
      if (d.progress === 'end' || d.status === 'done' || d.status === 'error') {
        setBar(1);
      } else if (d.out_time_ms && d.durationTarget) {
        setBar(parseInt(d.out_time_ms, 10) / 1000 / d.durationTarget);
      }
    }
    if (msg.type === 'chat') pushChat(d);
    if (msg.type === 'reply') pushReply(d);
    if (msg.type === 'log') pushLog(d);
    if (msg.type === 'publish') renderPublishProgress(d);
    if (msg.type === 'liveclip') onLiveClipEvent(d);
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
    $('#live-hint').textContent = `● Recording (${st.source || 'live'}) — buffer keeps the last ~30s. Clips made: ${st.processed || 0}`;
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
    $('#live-ps5-field').style.display = r.value === 'ps5' ? 'flex' : 'none';
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

$('#live-cut-btn')?.addEventListener('click', async () => {
  setBusy($('#live-cut-btn'), true, 'Cutting…');
  try {
    const offset = liveClipState.offset;
    const duration = parseInt($('#live-clip-dur').value, 10);
    const title = $('#live-clip-title').value.trim();
    const vertical = $('#live-clip-vertical').checked;
    const r = await api.post('/api/liveclip/cut', { offset, duration, title: title || null, vertical });
    liveClipState.cuts.unshift({ at: Date.now(), offset, duration, name: r.video?.name });
    liveClipState.cuts = liveClipState.cuts.slice(0, 20);
    liveLog(`✅ Clip cut (${offset}s back, ${duration}s) → "${r.video?.name}". It's in your Library!`, 'feed-info');
    renderCutHistory();
    toast('Clip saved to Library 🎬');
    refreshVideos();
  } catch (e) {
    liveLog('⚠️ ' + e.message, 'feed-error');
    toast('Cut failed: ' + e.message, 'error');
  } finally {
    setBusy($('#live-cut-btn'), false);
  }
});

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
    liveLog(`🎬 Live clip → "${d.name}" (${d.duration?.toFixed(1)}s)`, 'feed-info');
    refreshVideos();
  }
  if (d.type === 'ps5') liveLog('PS5: ' + esc(d.state || JSON.stringify(d)), 'feed-info');
  if (d.type === 'render') {
    if (d.progress === 'end') liveLog('Render done ✓', 'feed-info');
  }
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
    ? '🟢 Autopilot live — watching chats and replying'
    : '⏸ Autopilot off';
  $('#ap-youtube-state').textContent = st.youtube?.connected ? `YouTube chat attached (${st.youtube.liveChatId ? '✓' : 'waiting for live…'})` : 'Not connected';
  $('#ap-tiktok-state').textContent = st.tiktok?.connected ? `TikTok Live @${st.tiktok.user}` : 'Not connected';
}

$('#ap-run')?.addEventListener('click', async () => {
  if (state.autopilot.running) {
    await api.post('/api/autopilot/stop');
    toast('Autopilot stopped.');
  } else {
    const youtubeVideoId = $('#ap-yt-id').value.trim();
    const tiktokUser = $('#ap-tt-user').value.trim();
    if (!youtubeVideoId && !tiktokUser) { toast('Enter a YouTube video/live ID or a TikTok username.', 'error'); return; }
    setBusy($('#ap-run'), true, 'Starting…');
    try {
      await api.post('/api/autopilot/start', { youtubeVideoId, tiktokUser });
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
  state.chatMessages.unshift(m);
  state.chatMessages = state.chatMessages.slice(0, 100);
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
  const items = [...state.logs].slice(0, 60);
  feed.innerHTML = items.length ? items.map((l) => `
    <div class="feed-line feed-${l.level || 'info'}">
      <span class="feed-time">${fmt.clock(l.at)}</span> ${esc(l.msg)}
    </div>`).join('') : '<div class="feed-empty">Autopilot activity will appear here. Start it up! 🚀</div>';
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
      const { url } = await api.get('/api/youtube/auth-url');
      window.location.href = url;
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
    $('#set-supabase-url').value = s.supabaseUrl || '';
    $('#set-supabase-key').value = s.supabaseKey || '';
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
    supabaseUrl: $('#set-supabase-url').value.trim(),
    supabaseKey: $('#set-supabase-key').value.trim(),
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
