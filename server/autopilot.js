// Live autopilot: watches YouTube Live chat + TikTok Live chat, runs the
// reply brain, and sends replies. One instance at a time (single streamer).

import { getSettings, saveSettings } from './store.js';
import * as yt from './youtube.js';
import * as tt from './tiktok.js';
import { decide } from './brain.js';
import { emit, hub } from './pubsub.js';

let youtubeTimer = null;
let youtubeState = null; // { liveChatId, pageToken, videoId, pollingIntervalMs }
let tiktokActive = false;
let lastInfo = { replies: [] };

const DOWNTIME_MS = 90_000; // wait before re-asking YouTube for liveChatId

export function status() {
  return {
    running: !!(youtubeTimer || tiktokActive),
    youtube: youtubeTimer ? { connected: true, videoId: youtubeState?.videoId, liveChatId: youtubeState?.liveChatId } : null,
    tiktok: tiktokActive ? { connected: true, user: tt.currentUser() } : null,
    lastInfo,
  };
}

export async function start({ youtubeVideoId, tiktokUser }) {
  stop();
  lastInfo = { replies: [], startedAt: Date.now() };
  const s = await getSettings();

  if (youtubeVideoId) {
    youtubeState = { videoId: youtubeVideoId, liveChatId: null, pageToken: null, pollingIntervalMs: 5000 };
    await ensureYoutubeChat();
    scheduleYoutubePoll();
  }

  if (tiktokUser) {
    tiktokActive = true;
    emit('log', { level: 'info', msg: `Connecting TikTok Live @${tiktokUser} …` });
    tt.bus.on('message', onTikTokMessage);
    tt.connect(tiktokUser, { onEvent: (type, payload) => {
      if (type === 'connected') emit('log', { level: 'info', msg: 'TikTok Live connected ✅' });
      if (type === 'disconnected') emit('log', { level: 'warn', msg: 'TikTok Live disconnected.' });
      if (type === 'streamEnd') emit('log', { level: 'warn', msg: 'TikTok stream ended.' });
      if (type === 'message' && payload.kind === 'roomUser') emit('viewers', { platform: 'tiktok', count: payload.viewerCount });
    } }).catch((err) => {
      tiktokActive = false;
      emit('log', { level: 'error', msg: 'TikTok connect failed: ' + err.message });
    });
  }
}

export function stop() {
  if (youtubeTimer) { clearTimeout(youtubeTimer); youtubeTimer = null; }
  youtubeState = null;
  if (tiktokActive) {
    tt.bus.off('message', onTikTokMessage);
    tt.disconnect();
    tiktokActive = false;
  }
  lastInfo = { ...lastInfo, startedAt: null };
}

function scheduleYoutubePoll() {
  if (!youtubeState) return;
  const ms = youtubeState.pollingIntervalMs || 5000;
  youtubeTimer = setTimeout(async () => {
    youtubeTimer = null;
    try { await ensureYoutubeChat(); } catch (e) { emit('log', { level: 'warn', msg: 'YouTube autopilot: ' + e.message }); }
    scheduleYoutubePoll(); // reschedule with the (possibly updated) interval
  }, ms);
}

async function captureSelfChannel() {
  try {
    const ch = await yt.whoami();
    if (ch) {
      youtubeState = youtubeState || {};
      youtubeState.selfChannelId = ch.id;
    }
  } catch { /* fine */ }
}

async function ensureYoutubeChat() {
  if (!youtubeState) return;
  try {
    if (!youtubeState.selfChannelId) await captureSelfChannel();
    if (!youtubeState.liveChatId) {
      const chatId = await yt.getLiveChatId(youtubeState.videoId);
      if (!chatId) return; // not live yet / no chat; try again next tick
      youtubeState.liveChatId = chatId;
      emit('log', { level: 'info', msg: 'YouTube live chat attached ✅' });
    }
    const res = await yt.pollLiveChat(youtubeState.liveChatId, youtubeState.pageToken);
    youtubeState.pageToken = res.nextPageToken;
    youtubeState.pollingIntervalMs = res.pollingIntervalMs || 5000;
    // YouTube returns newest-first: iterate oldest→newest for sane ordering.
    for (const m of res.messages.slice().reverse()) {
      // Ignore our own channel's messages
      if (m.channelId && youtubeState.selfChannelId && m.channelId === youtubeState.selfChannelId) continue;
      await handleInbound(m);
    }
  } catch (e) {
    // Silent back-off when not connected yet (we log once).
    if (/not connected|re-connect/i.test(e.message)) {
      youtubeState.pollingIntervalMs = DOWNTIME_MS;
      if (!youtubeState.warnedNotConnected) {
        youtubeState.warnedNotConnected = true;
        emit('log', { level: 'warn', msg: 'Connect YouTube in Settings for live-chat autopilot.' });
      }
      return;
    }
    // Polling errors are usually transient quota hiccups — log, keep going.
    emit('log', { level: 'warn', msg: 'YouTube chat poll: ' + e.message });
  }
}

async function onTikTokMessage(msg) {
  if (!msg || !msg.text || msg.kind !== 'chat') return;
  await handleInbound({ platform: 'tiktok', author: msg.author, text: msg.text, at: Date.now() });
}

async function handleInbound(msg) {
  emit('chat', msg);

  let decision = null;
  try {
    decision = await decide(msg);
  } catch (e) {
    emit('log', { level: 'error', msg: 'Brain error: ' + e.message });
  }
  if (!decision || !decision.reply) return;

  const entry = { at: Date.now(), platform: msg.platform, user: msg.author, in: msg.text, out: decision.reply, intent: decision.matchedIntent, sent: false, error: null };

  try {
    if (msg.platform === 'youtube') {
      if (youtubeState?.liveChatId) {
        await yt.postLiveChat(youtubeState.liveChatId, decision.reply);
        entry.sent = true;
      }
    } else if (msg.platform === 'tiktok') {
      entry.sent = await tt.sendReply(decision.reply);
    }
  } catch (e) {
    entry.error = e.message;
    emit('log', { level: 'error', msg: `Reply failed (${msg.platform}): ${e.message}` });
  }

  lastInfo.replies = [entry, ...lastInfo.replies].slice(0, 200);
  emit('reply', entry);
  emit('log', { level: 'info', msg: `Autopilot → ${msg.platform}@${msg.author}: ${decision.reply}${entry.sent ? '' : ' (not delivered)'}` });
}
