// TikTok Live connector. TikTok has no public API for this; we read the
// public live-chat stream via the community "tiktok-live-connector" library.
// It listens by @username and emits chat/like/gift/viewer events + lets us
// send chat messages back (in-AI, within the platform's own limits).

import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { TikTokLiveConnection } = require('tiktok-live-connector');

export const bus = new EventEmitter();

function normalizeId(input) {
  let s = String(input || '').trim().replace(/^@/, '');
  // accept profile URLs: https://www.tiktok.com/@user or /@user/live
  const m = s.match(/tiktok\.com\/(@)?([^/?#]+)/i);
  if (m) s = m[2];
  return s;
}

/**
 * Resolve a TikTok profile/@username to its LIVE stream URLs (no login).
 * Used by the Live Clips "phone TikTok" source. Returns null-ish fields when
 * the account isn't live. Prefers HLS (.m3u8), falls back to FLV SD/HD.
 */
export async function fetchLiveInfo(uniqueIdOrUrl) {
  const clean = normalizeId(uniqueIdOrUrl);
  if (!clean) throw new Error('Please provide a TikTok @username or profile URL.');

  const conn = new TikTokLiveConnection(clean, {
    processInitialData: false,
    fetchRoomInfoOnConnect: false,
  });

  try {
    const info = await conn.fetchRoomInfo();
    // Pull the stream URLs from whatever shape the connector returns.
    // Docs shape:            info.stream_url.hls_pull_url (+ _map variants)
    // SDK live-route shape:  info.stream_url.{hls_pull_url,flv_pull_url:{HD1,SD1,SD2},rtmp_pull_url}
    const su = (info && (info.stream_url || info.streamUrl)) || {};
    const hlsMap = su.hls_pull_url_map || {};
    const flvMap = (su.flv_pull_url || {});
    const rawHls = typeof su.hls_pull_url === 'string' ? su.hls_pull_url : null;
    const rawLd = typeof su.hls_pull_url_ld === 'string' ? su.hls_pull_url_ld : null;
    const urls = [
      rawHls, rawLd,
      hlsMap.HD1, hlsMap.HD2, hlsMap.SD1, hlsMap.SD2,
      flvMap.HD1, flvMap.SD1, flvMap.SD2,
      su.rtmp_pull_url,
    ].filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));

    // status: 2 === live, 4 === ended; also accept is_live / nested room.status
    const status = info?.status ?? info?.room?.status;
    const ended = status === 4;
    // A capturable HLS/flv URL is itself proof of a live stream (some shapes
    // omit the status flag) — as long as it isn't marked ended.
    const isLive =
      status === 2 ||
      info?.is_live === true ||
      info?.user?.status === 2 ||
      (!ended && urls.length > 0);

    const viewers = info?.user_count ?? info?.stats?.user_count ?? info?.stats?.total_user ?? info?.room?.user_count ?? null;

    return {
      uniqueId: clean,
      isLive,
      title: info?.title || info?.room?.title || null,
      viewerCount: viewers != null ? Number(viewers) : null,
      streamUrls: urls,
      streamSize: su.stream_size_width && su.stream_size_height
        ? { width: su.stream_size_width, height: su.stream_size_height }
        : null,
      ended,
    };
  } catch (e) {
    // UserOfflineError (or a similar offline detail) = not live, not a failure.
    const name = (e && (e.name || e.constructor?.name || '')) + ' ' + (e && (e.message || ''));
    if (/offline|not.?live|live.*ended/i.test(name)) {
      return { uniqueId: clean, isLive: false, ended: /ended/i.test(name), title: null, viewerCount: null, streamUrls: [] };
    }
    throw e;
  } finally {
    try { conn.disconnect(); } catch { /* noop */ }
  }
}

let connection = null;
let currentUniqueId = null;

export function isConnected() {
  return !!(connection && connection.isConnected);
}

export function currentUser() {
  return currentUniqueId;
}

/**
 * Start listening to a TikTok Live room by @username (optional URL).
 * Resolves once the room is entered; rejects on failure.
 */
export function connect(uniqueIdOrUrl, { onEvent } = {}) {
  if (connection) {
    try { connection.disconnect(); } catch { /* noop */ }
    connection = null;
  }

  const clean = String(uniqueIdOrUrl || '').trim().replace(/^@/, '');
  if (!clean) return Promise.reject(new Error('No TikTok username provided.'));
  currentUniqueId = clean;

  connection = new TikTokLiveConnection(clean, { processInitialData: true });

  const wire = (event, map) => {
    connection.on(event, (data) => {
      const msg = map(data);
      if (msg) {
        bus.emit('message', msg);
        if (typeof onEvent === 'function') onEvent('message', msg);
      }
    });
  };

  wire('chat', (d) => ({
    platform: 'tiktok',
    kind: 'chat',
    author: d?.user?.nickname || d?.user?.uniqueId || 'Viewer',
    userId: d?.user?.uniqueId || null,
    text: d?.content || d?.comment || '',
    at: Date.now(),
    raw: d,
  }));
  wire('like', (d) => ({
    platform: 'tiktok',
    kind: 'like',
    author: d?.user?.nickname || 'Viewer',
    count: d?.likeCount || 0,
    total: d?.totalLikes || 0,
    at: Date.now(),
  }));
  wire('gift', (d) => ({
    platform: 'tiktok',
    kind: 'gift',
    author: d?.user?.nickname || 'Viewer',
    gift: d?.gift?.name || d?.gift?.description || 'gift',
    count: d?.repeatCount || 1,
    at: Date.now(),
  }));
  wire('social', (d) => ({
    platform: 'tiktok',
    kind: 'social',
    author: d?.user?.nickname || 'Viewer',
    text: d?.displayType || '',
    at: Date.now(),
  }));

  connection.on('connected', (state) => {
    bus.emit('connected', state);
    if (typeof onEvent === 'function') onEvent('connected', state);
  });
  connection.on('disconnected', () => {
    bus.emit('disconnected');
    if (typeof onEvent === 'function') onEvent('disconnected');
  });
  connection.on('roomUser', (d) => {
    const m = { platform: 'tiktok', kind: 'roomUser', viewerCount: d?.viewerCount || 0, at: Date.now() };
    bus.emit('message', m);
    if (typeof onEvent === 'function') onEvent('message', m);
  });
  connection.on('streamEnd', () => {
    bus.emit('streamEnd');
    if (typeof onEvent === 'function') onEvent('streamEnd');
  });

  return new Promise((resolve, reject) => {
    let done = false;
    const ok = (state) => {
      if (done) return;
      done = true;
      resolve(state || {});
    };
    const fail = (err) => {
      if (done) return;
      done = true;
      reject(err instanceof Error ? err : new Error(String(err?.exception || err)) );
    };
    connection.once('connected', ok);
    connection.once('error', fail);
    connection.connect().catch(fail);
    setTimeout(() => fail(new Error('Timed out connecting to TikTok Live.')), 45000).unref?.();
  });
}

export function disconnect() {
  if (connection) {
    try { connection.disconnect(); } catch { /* noop */ }
    connection = null;
  }
  currentUniqueId = null;
}

/**
 * Best-effort reply into the TikTok chat. Requires the connector to expose a
 * send path; if unavailable this fails gracefully so autopilot can fall back
 * to an on-screen overlay reply.
 */
export async function sendReply(text) {
  if (!connection) throw new Error('Not connected to TikTok Live.');
  if (typeof connection.sendMessage === 'function') {
    await connection.sendMessage(text);
    return true;
  }
  const fake = { platform: 'tiktok', kind: 'self', text, at: Date.now() };
  bus.emit('message', fake);
  return false; // true only if actually delivered
}
