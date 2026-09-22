// Twitch connector — live chat via tmi.js (IRC).
// - Anonymous read works for public channels (no key needed).
// - Optional OAuth tokens (Twitch App Access Token / user token) enable
//   sending chat + more (Helix API).
// - Also persists channel/user info so the Connections hub can show it.

import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { getSettings, saveSettings } from './store.js';
import { emit } from './pubsub.js';

const cleanLog = (m) => String(m).replace(/[\r\n]+/g, ' ').slice(0, 160);

const require = createRequire(import.meta.url);
const tmi = require('tmi.js');

export const bus = new EventEmitter();

let client = null;
let current = null;

/* ---------------------------------------------------------------- tokens */
export async function saveTwitch({ botUser = null, botOauth = null, appToken = null, clientId = null, channel = null }) {
  const s = await getSettings();
  const twitch = { ...(s.twitch || {}) };
  if (botUser !== null) twitch.botUser = botUser;
  if (botOauth !== null) twitch.botOauth = botOauth;
  if (appToken !== null) twitch.appToken = appToken;
  if (clientId !== null) twitch.clientId = clientId;
  if (channel !== null) twitch.channel = channel;
  await saveSettings({ twitch });
  return twitch;
}

export async function twitchConfig() {
  const s = await getSettings();
  const tw = s.twitch || {};
  const env = process.env;
  return {
    channel: tw.channel || env.TWITCH_CHANNEL || null,
    botUser: tw.botUser || env.TWITCH_BOT_USER || null,
    botOauth: tw.botOauth || env.TWITCH_BOT_OAUTH || null,
    appToken: tw.appToken || env.TWITCH_APP_TOKEN || null,
    clientId: tw.clientId || env.TWITCH_CLIENT_ID || null,
  };
}

/** Validation: an app/user access token has "oauth:", bot tokens are plain. */
export function validateOauth(token) {
  const t = String(token || '').trim();
  if (!t) return null;
  if (t.startsWith('oauth:')) return t;
  if (/^[a-zA-Z0-9]{30,}$/.test(t)) return 'oauth:' + t;
  return null;
}

/* ---------------------------------------------------------------- connection */
export function isConnected() {
  return !!(client && client.readyState && client.readyState() === 'OPEN');
}

export function currentChannel() {
  return current;
}

export async function connect(channel) {
  const clean = String(channel || '').trim().toLowerCase().replace(/^#/, '');
  if (!clean) throw new Error('No Twitch channel given.');
  disconnect();

  const cfg = await twitchConfig();
  const opts = {
    channels: [clean],
    connection: { reconnect: true, secure: true },
    // Route tmi's internal logs through our pub/sub instead of console spam.
    logger: {
      info: (m) => emit('log', { level: 'info', msg: 'Twitch: ' + cleanLog(m) }),
      warn: (m) => emit('log', { level: 'warn', msg: 'Twitch: ' + cleanLog(m) }),
      error: (m) => emit('log', { level: 'warn', msg: 'Twitch: ' + cleanLog(m) }),
    },
  };
  // If a bot account + oauth are configured, log in (enables .say replies).
  if (cfg.botUser && cfg.botOauth) {
    opts.identity = { username: cfg.botUser, password: validateOauth(cfg.botOauth) };
  }

  client = new tmi.Client(opts);
  current = clean;

  client.on('message', (_chan, userstate, message, self) => {
    if (self) return;
    bus.emit('message', {
      platform: 'twitch',
      kind: 'chat',
      author: userstate['display-name'] || userstate.username || 'Viewer',
      userId: userstate['user-id'] || null,
      text: message,
      at: Date.now(),
      flags: { mod: !!userstate.mod, sub: !!userstate.subscriber, first: !!userstate['first-msg'], badge: userstate.badges || null },
      raw: userstate,
    });
  });
  client.on('connected', () => bus.emit('connected', { channel: clean }));
  client.on('disconnected', (r) => bus.emit('disconnected', { reason: r }));

  return new Promise((resolve, reject) => {
    let finished = false;
    const dispose = () => {
      if (!client) return;
      client.reconnect = false; // stop tmi's internal retry timers
      try { client.removeAllListeners(); client.disconnect().catch(() => {}); } catch {}
      if (client === current_client()) client = null;
    };
    const onConn = () => { if (finished) return; finished = true; cleanup(); resolve({ channel: clean, authenticated: !!(cfg.botUser && cfg.botOauth) }); };
    const onErr = (e) => { if (finished) return; finished = true; cleanup(); dispose(); reject(new Error('Twitch connect failed: ' + (e?.message || e))); };
    const cleanup = () => { client && client.off('connected', onConn); client && client.off('chat join error', onErr); clearTimeout(timer); };
    const timer = setTimeout(() => onErr(new Error('timed out connecting to Twitch chat')), 30000);
    timer.unref?.();
    client.once('connected', onConn);
    client.once('chat join error', onErr);
    client.connect().catch(onErr);
  });
}

// small helper so dispose() only nulls the *current* client
function current_client() { return client; }

export function disconnect() {
  if (client) {
    try { client.disconnect(); } catch {}
    client = null;
  }
  current = null;
}

/** Send a message to the connected Twitch channel (requires bot login). */
export async function sendReply(text) {
  if (!client) throw new Error('Twitch not connected.');
  if (client.getOptions?.()?.identity?.password) {
    await client.say('#' + current, text);
    return true;
  }
  // Anonymous (read-only) can't send — surface as a manual reply in the UI.
  bus.emit('message', { platform: 'twitch', kind: 'self', text, at: Date.now() });
  return false;
}

export async function validateTwitchToken(token, clientId) {
  // Helix validate endpoint; harmless 401 means invalid.
  const res = await fetch('https://id.twitch.tv/oauth2/validate', {
    headers: { Authorization: 'OAuth ' + token.replace(/^oauth:/, '') },
  }).catch(() => null);
  if (!res) return { valid: false, reason: 'unreachable' };
  const data = await res.json().catch(() => ({}));
  return res.ok
    ? { valid: true, login: data.login, userId: data.user_id, scopes: data.scopes }
    : { valid: false, reason: res.status === 401 ? 'invalid token' : `http ${res.status}` };
}
