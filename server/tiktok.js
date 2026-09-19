// TikTok Live connector. TikTok has no public API for this; we read the
// public live-chat stream via the community "tiktok-live-connector" library.
// It listens by @username and emits chat/like/gift/viewer events + lets us
// send chat messages back (in-AI, within the platform's own limits).

import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { TikTokLiveConnection } = require('tiktok-live-connector');

export const bus = new EventEmitter();

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
