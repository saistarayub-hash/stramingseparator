// Kick connector — live chat via Kick's Pusher websocket endpoint.
// Dependency-free (public chat read only; sending needs a logged-in browser
// session so we mark it as read-only for now).
//
// Flow:  GET https://kick.com/api/v2/channels/<slug> → chatroom.id
//        GET https://kick.com/api/v2/chat?... maybe not public →
//        POST https://kick.com/api/v2/channels/<slug>/chat  (returns pusher creds)
//        connect to wss://ws-us2.pusher.com/app/<key>?protocol=7&client=js&version=7.6.0&flash=false
//        subscribe to channel: chatrooms.<id>.v2, bind event App\Events\ChatMessageEvent

import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);

export const bus = new EventEmitter();

let ws = null;
let currentSlug = null;
let heartbeat = null;

export function isConnected() {
  return !!(ws && ws.readyState === 1);
}
export function currentChannel() {
  return currentSlug;
}

async function getChatroomId(slug) {
  const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Kick channel not found (http ${res.status}).`);
  const data = await res.json();
  const id = data?.chatroom?.id || data?.chatroom?.chatable_id;
  if (!id) throw new Error('Could not resolve the Kick chatroom id.');
  return String(id);
}

async function getPusherCreds(slug) {
  let res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}/chat`, {
    method: 'POST',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' },
    body: JSON.stringify({ hide_broadcast: false, is_hidden: false, is_mod: false }),
  });
  if (!res.ok) {
    // fallback endpoint used by some clients
    res = await fetch(`https://kick.com/api/v2/chat/config?slug=${encodeURIComponent(slug)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
  }
  if (!res.ok) throw new Error(`Could not get Kick chat config (http ${res.status}).`);
  const data = await res.json();
  const key = data?.key || data?.app_key || data?.pusher?.key || data?.pusher_key;
  const cluster = data?.cluster || data?.pusher?.cluster || 'us2';
  if (!key) throw new Error('Kick chat config missing pusher key.');
  return { key, cluster };
}

export async function connect(slug) {
  const clean = String(slug || '').trim().toLowerCase().replace(/^@/, '');
  if (!clean) throw new Error('No Kick channel given.');
  disconnect();

  const chatroomId = await getChatroomId(clean);
  const { key, cluster } = await getPusherCreds(clean);
  currentSlug = clean;

  const wsHost = `wss://ws-${cluster}.pusher.com/app/${encodeURIComponent(key)}?protocol=7&client=js&version=7.6.0&flash=false`;

  return new Promise((resolve, reject) => {
    let settled = false;
    ws = new WebSocket(wsHost);

    ws.onopen = () => {
      ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `chatrooms.${chatroomId}.v2` } }));
    };
    ws.onmessage = (ev) => {
      let payload;
      try { payload = JSON.parse(ev.data); } catch { return; }
      if (payload.event === 'pusher:connection_established') {
        // heartbeats to keep the socket alive
        heartbeat = setInterval(() => {
          try { ws.send(JSON.stringify({ event: 'pusher:ping', data: {} })); } catch {}
        }, 30000);
      }
      if (payload.event === 'pusher_internal:subscription_succeeded') {
        if (!settled) { settled = true; resolve({ channel: clean, chatroomId }); }
        bus.emit('connected', { channel: clean });
      }
      if (payload.event === 'App\\Events\\ChatMessageEvent' || payload.event === 'App\\Events\\ChatMessageSentEvent') {
        const raw = (typeof payload.data === 'string') ? safeParse(payload.data) : payload.data;
        if (!raw) return;
        bus.emit('message', {
          platform: 'kick',
          kind: 'chat',
          author: raw.sender?.username || raw.sender?.slug || 'Viewer',
          userId: raw.sender?.id || raw.sender?.user_id || null,
          text: raw.content || raw.message || '',
          at: Date.now(),
          raw,
        });
      }
    };
    ws.onerror = () => {
      if (!settled) { settled = true; reject(new Error('Kick websocket error.')); }
    };
    ws.onclose = () => {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      bus.emit('disconnected', {});
    };
    setTimeout(() => { if (!settled) { settled = true; reject(new Error('Kick connect timed out.')); } }, 30000);
  });
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

export function disconnect() {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  if (ws) { try { ws.close(); } catch {} ws = null; }
  currentSlug = null;
}

export async function sendReply(text) {
  // Kick chat sending needs an authenticated session — read-only for now.
  bus.emit('message', { platform: 'kick', kind: 'self', text, at: Date.now() });
  return false;
}
