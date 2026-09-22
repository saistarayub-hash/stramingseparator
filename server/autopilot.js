// Live autopilot: watches YouTube Live + TikTok + Twitch + Kick chat, runs
// the reply brain, and sends replies. One instance at a time (single creator).

import { getSettings } from './store.js';
import * as yt from './youtube.js';
import * as tt from './tiktok.js';
import * as twitch from './twitch.js';
import * as kick from './kick.js';
import { decide } from './brain.js';
import { emit } from './pubsub.js';
import * as liveclip from './liveclip.js';

let youtubeTimer = null;
let youtubeState = null; // { liveChatId, pageToken, videoId, pollingIntervalMs }
let tiktokActive = false;
let twitchActive = false;
let kickActive = false;
let lastInfo = { replies: [] };

const DOWNTIME_MS = 90_000; // wait before re-asking YouTube for liveChatId

export function status() {
  return {
    running: !!(youtubeTimer || tiktokActive || twitchActive || kickActive),
    youtube: youtubeTimer ? { connected: true, videoId: youtubeState?.videoId, liveChatId: youtubeState?.liveChatId } : null,
    tiktok: tiktokActive ? { connected: tt.isConnected(), user: tt.currentUser() } : null,
    twitch: twitchActive ? { connected: twitch.isConnected(), channel: twitch.currentChannel() } : null,
    kick: kickActive ? { connected: kick.isConnected(), channel: kick.currentChannel() } : null,
    lastInfo,
  };
}

export async function start({ youtubeVideoId, tiktokUser, twitchChannel, kickChannel }) {
  stop();
  lastInfo = { replies: [], startedAt: Date.now() };
  const s = await getSettings().catch(() => ({}));

  // Env fallbacks so a container/headless deploy can autostart chat watchers.
  twitchChannel = twitchChannel || (s.twitch?.channel) || process.env.TWITCH_CHANNEL || null;
  kickChannel = kickChannel || (s.kick?.channel) || process.env.KICK_CHANNEL || null;
  tiktokUser = tiktokUser || s.tiktokChannel || null;

  if (youtubeVideoId) {
    youtubeState = { videoId: youtubeVideoId, liveChatId: null, pageToken: null, pollingIntervalMs: 5000 };
    await ensureYoutubeChat();
    scheduleYoutubePoll();
  }

  if (tiktokUser) {
    tiktokActive = true;
    emit('log', { level: 'info', msg: `Connecting TikTok Live @${tiktokUser} …` });
    tt.bus.on('message', onOtherChat);
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

  if (twitchChannel) {
    twitchActive = true;
    emit('log', { level: 'info', msg: `Connecting Twitch #${twitchChannel} …` });
    twitch.bus.on('message', onOtherChat);
    twitch.connect(twitchChannel).catch((err) => {
      twitchActive = false;
      emit('log', { level: 'error', msg: 'Twitch connect failed: ' + err.message });
    });
  }

  if (kickChannel) {
    kickActive = true;
    emit('log', { level: 'info', msg: `Connecting Kick @${kickChannel} …` });
    kick.bus.on('message', onOtherChat);
    kick.connect(kickChannel).catch((err) => {
      kickActive = false;
      emit('log', { level: 'error', msg: 'Kick connect failed: ' + err.message });
    });
  }
}

export function stop() {
  if (youtubeTimer) { clearTimeout(youtubeTimer); youtubeTimer = null; }
  youtubeState = null;
  if (tiktokActive) { tt.bus.off('message', onOtherChat); tt.disconnect(); tiktokActive = false; }
  if (twitchActive) { twitch.bus.off('message', onOtherChat); twitch.disconnect(); twitchActive = false; }
  if (kickActive) { kick.bus.off('message', onOtherChat); kick.disconnect(); kickActive = false; }
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

async function onOtherChat(msg) {
  if (!msg || msg.kind !== 'chat') return;
  await handleInbound(msg);
}

async function handleInbound(msg) {
  // Twitch/TikTok/Kick already emit 'chat' via the central bus wiring; YouTube
  // has no bus, so publish it here to keep the UI live feed uniform.
  if (msg.platform === 'youtube') emit('chat', msg);

  // Auto-clip trigger: !clip anywhere in chat → cut from live buffer.
  const s0 = await getSettings().catch(() => ({}));
  if (s0.autoClipEnabled !== false) {
    const handled = liveclip.handleAutoClipChat(msg);
    if (handled.clipped) {
      emit('log', { level: 'info', msg: `✂️ Auto-clip requested by @${msg.author} — cutting now…` });
      // still send the confirmation reply from the brain
      const decision = await decide(msg).catch(() => null);
      if (decision?.reply) {
        try {
          if (msg.platform === 'youtube') {
            if (youtubeState?.liveChatId) await yt.postLiveChat(youtubeState.liveChatId, decision.reply);
          } else if (msg.platform === 'tiktok') await tt.sendReply(decision.reply);
          else if (msg.platform === 'twitch') await twitch.sendReply(decision.reply);
          else if (msg.platform === 'kick') await kick.sendReply(decision.reply);
        } catch (e) {
          emit('log', { level: 'warn', msg: `Clip confirmation failed (${msg.platform}): ${e.message}` });
        }
      }
      return;
    }
  }

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
    } else if (msg.platform === 'twitch') {
      entry.sent = await twitch.sendReply(decision.reply);
    } else if (msg.platform === 'kick') {
      entry.sent = await kick.sendReply(decision.reply);
    }
  } catch (e) {
    entry.error = e.message;
    emit('log', { level: 'error', msg: `Reply failed (${msg.platform}): ${e.message}` });
  }

  lastInfo.replies = [entry, ...lastInfo.replies].slice(0, 200);
  emit('reply', entry);
  emit('log', { level: 'info', msg: `Autopilot → ${msg.platform}@${msg.author}: ${decision.reply}${entry.sent ? '' : ' (not delivered)'}` });
}
