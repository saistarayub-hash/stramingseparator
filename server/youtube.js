// YouTube Data API v3 — OAuth login + uploads + live chat.
// Uses no SDK; plain fetch against https://www.googleapis.com.
// Storing tokens in the local store is fine for a personal single-user tool.

import fs from 'node:fs';
import path from 'node:path';
import { saveSettings, getSettings } from './store.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const API = 'https://www.googleapis.com';

export function youtubeConfigFrom(env = process.env) {
  return {
    clientId: env.YOUTUBE_CLIENT_ID,
    clientSecret: env.YOUTUBE_CLIENT_SECRET,
    redirectUri: env.YOUTUBE_REDIRECT_URI || 'http://localhost:8787/auth/youtube/callback',
  };
}

export async function getToken() {
  const s = await getSettings();
  return s.youtubeToken || null;
}

function scopes() {
  return [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly',
    'https://www.googleapis.com/auth/youtube.force-ssl',
  ].join(' ');
}

export function authUrl(env = process.env) {
  const cfg = youtubeConfigFrom(env);
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: scopes(),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return `${AUTH_URL}?${params}`;
}

export async function exchangeCode(code, env = process.env) {
  const cfg = youtubeConfigFrom(env);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  const token = {
    access: data.access_token,
    refresh: data.refresh_token || (await getToken())?.refresh || null,
    expiry: Date.now() + (data.expires_in || 3600) * 1000,
    scope: data.scope,
  };
  await saveSettings({ youtubeToken: token });
  return token;
}

async function freshAccess() {
  const token = await getToken();
  if (!token) throw new Error('Not connected to YouTube yet.');
  if (token.expiry && token.expiry > Date.now() + 60_000) return token.access;
  if (!token.refresh) throw new Error('No refresh token; re-connect your channel.');
  const cfg = youtubeConfigFrom();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: token.refresh,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Refresh failed (${res.status}). Re-connect your channel.`);
  const data = await res.json();
  token.access = data.access_token;
  token.expiry = Date.now() + (data.expires_in || 3600) * 1000;
  await saveSettings({ youtubeToken: token });
  return token.access;
}

async function apiFetch(pathname, { method = 'GET', json, query = {}, headers = {} } = {}, retry = true) {
  const access = await freshAccess();
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${access}`,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: json ? JSON.stringify(json) : undefined,
  });
  if (res.status === 401 && retry) {
    // Token may be stale — force a refresh next call by expiring it.
    const token = await getToken();
    if (token) {
      token.expiry = 0;
      await saveSettings({ youtubeToken: token });
    }
    return apiFetch(pathname, { method, json, query, headers }, false);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `${res.status}`;
    throw new Error(`YouTube API error: ${msg}`);
  }
  return data;
}

export async function whoami() {
  const data = await apiFetch('/youtube/v3/channels', {
    query: { part: 'snippet,statistics', mine: 'true' },
  });
  const c = data.items?.[0];
  return c
    ? {
        id: c.id,
        title: c.snippet?.title,
        thumb: c.snippet?.thumbnails?.default?.url,
        subs: c.statistics?.subscriberCount,
      }
    : null;
}

/**
 * Upload a video to the requester's channel via resumable upload.
 * Returns the YouTube video id.
 */
export async function uploadVideo({ filePath, title, description, tags = [], madeForKids = false, categoryId = '20', privacy = 'private' }) {
  const access = await freshAccess();
  const stat = fs.statSync(filePath);

  // 1. Start resumable session
  const meta = {
    snippet: {
      title,
      description,
      tags,
      categoryId,
      defaultLanguage: 'en',
      defaultAudioLanguage: 'en',
    },
    status: {
      privacyStatus: privacy, // private | unlisted | public
      selfDeclaredMadeForKids: madeForKids,
    },
  };

  const url = new URL('https://www.googleapis.com/upload/youtube/v3/videos');
  url.searchParams.set('uploadType', 'resumable');
  url.searchParams.set('part', 'snippet,status');

  const init = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${access}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(stat.size),
      'X-Upload-Content-Type': 'video/*',
    },
    body: JSON.stringify(meta),
  });

  if (!init.ok) {
    const text = await init.text();
    throw new Error(`Upload init failed (${init.status}): ${text.slice(0, 300)}`);
  }
  const location = init.headers.get('location');
  if (!location) throw new Error('No resumable upload URL returned.');

  // 2. Upload bytes
  const fileBuffer = fs.readFileSync(filePath);
  const up = await fetch(location, {
    method: 'PUT',
    headers: {
      'Content-Length': String(stat.size),
      'Content-Type': 'video/*',
      Authorization: `Bearer ${access}`,
    },
    body: fileBuffer,
  });
  const result = await up.json().catch(() => ({}));
  if (!up.ok) {
    throw new Error(`Upload failed (${up.status}): ${JSON.stringify(result).slice(0, 300)}`);
  }
  return { id: result.id, url: `https://youtu.be/${result.id}` };
}

/**
 * Live chat polling. Fetches the liveChatId for a video and pings for messages.
 * Designed to be called in a loop with an increasing nextPageToken.
 */
export async function getLiveChatId(videoId) {
  const data = await apiFetch('/youtube/v3/videos', {
    query: { part: 'liveStreamingDetails', id: videoId },
  });
  return data.items?.[0]?.liveStreamingDetails?.activeLiveChatId || null;
}

export async function pollLiveChat(liveChatId, pageToken = null) {
  const query = {
    part: 'snippet,authorDetails',
    liveChatId,
    maxResults: 200,
  };
  if (pageToken) query.pageToken = pageToken;
  const data = await apiFetch('/youtube/v3/liveChat/messages', { query });
  const messages = (data.items || []).map((m) => ({
    id: m.id,
    author: m.authorDetails?.displayName || 'Unknown',
    channelId: m.authorDetails?.channelId,
    text: m.snippet?.displayMessage || '',
    at: Date.parse(m.snippet?.publishedAt) || Date.now(),
    platform: 'youtube',
  }));
  return { messages, nextPageToken: data.nextPageToken, pollingIntervalMs: data.pollingIntervalMillis || 5000 };
}

/** Post a message into your own live chat. */
export async function postLiveChat(liveChatId, text) {
  await apiFetch('/youtube/v3/liveChat/messages', {
    method: 'POST',
    query: { part: 'snippet' },
    json: { snippet: { liveChatId, type: 'textMessageEvent', textMessageDetails: { messageText: text } } },
  });
}
