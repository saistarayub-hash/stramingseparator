// Connections hub — one place that knows about every platform.
// Used by the Autopilot (listen to N chats at once) and the Connections UI.
//
// Status shape per platform: { id, name, connected, channel/user, canReply }

import { getSettings } from './store.js';
import { emit } from './pubsub.js';
import * as yt from './youtube.js';
import * as tt from './tiktok.js';
import * as twitch from './twitch.js';
import * as kick from './kick.js';

const PLATFORMS = [
  { id: 'youtube', name: 'YouTube', keyHint: 'Google OAuth (upload + live chat)' },
  { id: 'tiktok', name: 'TikTok', keyHint: 'Phone live / live chat (@username)' },
  { id: 'twitch', name: 'Twitch', keyHint: 'Channel chat (optional bot token)' },
  { id: 'kick', name: 'Kick', keyHint: 'Channel chat (read-only)' },
];

export const known = PLATFORMS;

export async function youtubeAccount() {
  try {
    if (!(await yt.getToken())) return null;
    return await yt.whoami().catch(() => null);
  } catch { return null; }
}

export async function snapshot(liveState = {}) {
  const s = await getSettings();
  const tw = s.twitch || {};
  return {
    platforms: PLATFORMS.map((p) => ({ ...p })).map((p) => {
      if (p.id === 'youtube') return { ...p, connected: !!s.youtubeToken, account: null };
      if (p.id === 'tiktok') return { ...p, connected: !!s.tiktokChannel, account: s.tiktokChannel || null };
      if (p.id === 'twitch') {
        return {
          ...p,
          connected: !!(tw.channel || tw.botUser),
          account: tw.channel || tw.botUser || null,
          twitch: { channel: tw.channel || null, botUser: tw.botUser || null, hasBotOauth: !!tw.botOauth, hasAppToken: !!tw.appToken },
        };
      }
      if (p.id === 'kick') return { ...p, connected: !!s.kick?.channel, account: s.kick?.channel || null };
      return p;
    }),
    live: {
      youtube: (liveState.youtube && liveState.youtube.liveChatId) ? liveState.youtube.liveChatId : (liveState.youtube?.connected ? true : null),
      tiktok: tt.isConnected() ? tt.currentUser() : null,
      twitch: twitch.isConnected() ? twitch.currentChannel() : null,
      kick: kick.isConnected() ? kick.currentChannel() : null,
    },
  };
}

/* Wire each platform's chat buses into the central emit() stream. */
let wired = false;
export function wireChatBuses() {
  if (wired) return;
  wired = true;
  for (const [name, mod] of Object.entries({ twitch, kick, tiktok: tt })) {
    mod.bus.on('message', (msg) => {
      // only surface real chat/self messages in the UI feed (skip roomUser etc.)
      if (msg && (msg.kind === 'chat' || msg.kind === 'self')) emit('chat', msg);
    });
    mod.bus.on('connected', (state) => emit('log', { level: 'info', msg: `${name} chat connected (${state?.channel || state?.user || ''})` }));
    mod.bus.on('disconnected', () => emit('log', { level: 'warn', msg: `${name} chat disconnected.` }));
  }
}
