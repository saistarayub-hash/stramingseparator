// Storage facade: Appwrite (cloud) when configured, else local JSON.
// The rest of the app talks to this module only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import * as aw from './appwrite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR can be overridden (Docker/cloud volumes keep state somewhere durable).
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'store.json');
const APPWRITE_CREDS_PATH = path.join(DATA_DIR, 'appwrite.json');

export const uid = () => crypto.randomUUID();

// ---------------------------------------------------------------- cloud flag
let cloudReady = false;
let lastCloudError = null;

export function usingCloud() {
  return cloudReady && aw.isConfigured();
}
/** The most recent bootstrap error message (empty when cloud is up). */
export function getCloudError() {
  return lastCloudError;
}

function describeError(e) {
  if (!e) return 'Unknown error';

  // Appwrite scope rejection — decode it into a plain, actionable message
  // instead of the raw "missing scopes ([...])" JSON.
  const hay = `${e.message || ''} ${e.response || ''}`;
  const scopeRe = /missing scopes \(\[([^\]]*)\]/g;
  const scopes = [];
  let mm;
  while ((mm = scopeRe.exec(hay))) {
    scopes.push(...mm[1].replace(/\\?"/g, '').split(','));
  }
  const uniq = [...new Set(scopes.map((s) => s.trim()).filter(Boolean))];
  if (uniq.length || e.type === 'general_unauthorized_scope') {
    return (
      `API key needs more permissions — missing: ${uniq.join(', ') || 'a required scope'}. ` +
      'Fix: Appwrite console → your project → Overview → Integrations → API keys → create a key ' +
      'with "Select all" ticked (or every Database + Storage scope), then paste it into ' +
      'APPWRITE_API_KEY on Render and tap Retry.'
    );
  }

  const parts = [];
  if (e.code && (e.type || e.name)) parts.push(`${e.type || e.name} ${e.code}`);
  if (e.message) parts.push(e.message);
  // AppwriteException carries the raw server response body — surface a slice of it.
  if (e.response && typeof e.response === 'string' && e.response.length) {
    try {
      const j = JSON.parse(e.response);
      parts.push(j.message || j.status || JSON.stringify(j).slice(0, 160));
    } catch {
      parts.push(e.response.slice(0, 160));
    }
  }
  return parts.filter(Boolean).join(' — ') || String(e);
}

/**
 * Boot-time: if Appwrite is configured, bootstrap the schema once.
 * Retries a few times (self-heals transient failures on serverless/cold starts).
 */
export async function initStore() {
  if (!aw.isConfigured()) return { cloud: false, reason: 'not-configured' };
  const attempts = 3;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await aw.bootstrap();
      cloudReady = true;
      lastCloudError = null;
      console.log(`  ☁️  Appwrite connected: ${aw.appwriteConfig().endpoint} (db: ${res.databaseId})`);
      return { cloud: true, ...res };
    } catch (e) {
      lastCloudError = describeError(e);
      console.error(`  ⚠️  Appwrite bootstrap attempt ${i}/${attempts} failed:`, lastCloudError);
      if (i < attempts) await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  cloudReady = false;
  return { cloud: false, error: lastCloudError };
}

/** Re-initialise after the user saves new Appwrite credentials. */
export async function reinitStore() {
  cloudReady = false;
  await aw.reloadCreds();
  return initStore();
}

/**
 * If boot-time bootstrap failed but credentials exist, quietly retry in the
 * background — cloud providers' cold starts sometimes fail the first request.
 * Fires only once per failed boot; safe to call repeatedly.
 */
let selfHealFactory = null;
export function selfHealCloud() {
  if (selfHealFactory || !aw.isConfigured()) return;
  selfHealFactory = true;
  for (const delay of [8000, 30000, 90000]) {
    setTimeout(async () => {
      if (usingCloud()) return; // already up
      const r = await reinitStore();
      if (r.cloud) console.log('  ☁️  Appwrite self-healed — connected after a transient failure.');
    }, delay);
  }
}

// ---------------------------------------------------------------- local store
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readDb() {
  ensureDir();
  if (!fs.existsSync(DB_PATH)) {
    const empty = { videos: {}, jobs: {}, publishes: {}, settings: {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(empty, null, 2));
    return empty;
  }
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return { videos: {}, jobs: {}, publishes: {}, settings: {} }; }
}

function writeDb(db) {
  ensureDir();
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

function localCollection(name) {
  return {
    async list() {
      const db = readDb();
      const rows = Object.values(db[name] || {});
      return rows.sort((a, b) => (b.createdAt || b.at || '').localeCompare(a.createdAt || a.at || ''));
    },
    async get(id) {
      const db = readDb();
      return (db[name] || {})[id] || null;
    },
    async set(id, patch) {
      const db = readDb();
      const existing = (db[name] || {})[id] || {};
      db[name] = db[name] || {};
      db[name][id] = { ...existing, ...patch, id, updatedAt: new Date().toISOString() };
      writeDb(db);
      return db[name][id];
    },
    async remove(id) {
      const db = readDb();
      delete (db[name] || {})[id];
      writeDb(db);
    },
  };
}

// Inflate JSON-stringified fields returned by Appwrite.
function inflate(doc) {
  const out = { ...doc };
  for (const k of ['info', 'highlights', 'clips', 'issues', 'results']) {
    if (typeof out[k] === 'string') {
      try { out[k] = JSON.parse(out[k]); } catch { /* leave as-is */ }
    }
  }
  return out;
}

function inflateSettings(doc) {
  if (doc && typeof doc.value === 'string') {
    try { return JSON.parse(doc.value); } catch { return {}; }
  }
  return (doc && doc.value) || {};
}

// ---------------------------------------------------------------- collections
export const videos = {
  async list() {
    if (usingCloud()) return (await aw.appVideos.list()).map(inflate);
    return localCollection('videos').list();
  },
  async get(id) {
    if (usingCloud()) { const d = await aw.appVideos.get(id); return d ? inflate(d) : null; }
    return localCollection('videos').get(id);
  },
  async set(id, patch) {
    if (usingCloud()) return inflate(await aw.appVideos.set(id, patch));
    return localCollection('videos').set(id, patch);
  },
  async remove(id) {
    if (usingCloud()) return aw.appVideos.remove(id);
    return localCollection('videos').remove(id);
  },
};

export const jobs = localCollection('jobs');

export const publishes = {
  async list() {
    if (usingCloud()) return (await aw.appPublishes.list()).map(inflate);
    return localCollection('publishes').list();
  },
  async set(id, patch) {
    if (usingCloud()) return inflate(await aw.appPublishes.set(id, patch));
    return localCollection('publishes').set(id, patch);
  },
  async get(id) {
    return localCollection('publishes').get(id);
  },
  async remove(id) {
    return localCollection('publishes').remove(id);
  },
};

// ---------------------------------------------------------------- settings
export async function getSettings() {
  if (usingCloud()) return inflateSettings(await aw.appSettings.get());
  const db = readDb();
  return db.settings || {};
}

export async function saveSettings(patch) {
  if (usingCloud()) {
    const merged = { ...(await getSettings()), ...patch };
    await aw.appSettings.set(merged);
    return merged;
  }
  const db = readDb();
  db.settings = { ...(db.settings || {}), ...patch };
  writeDb(db);
  return db.settings;
}

/** Persist Appwrite credentials (endpoint/project/api) to a local creds file.
 *  These are NEVER stored in the cloud settings collection (chicken-and-egg). */
export function saveAppwriteCreds({ endpoint, projectId, apiKey }) {
  ensureDir();
  const cur = readAppwriteCredsFile();
  const next = { ...cur, ...(endpoint ? { endpoint } : {}), ...(projectId ? { projectId } : {}), ...(apiKey ? { apiKey } : {}) };
  fs.writeFileSync(APPWRITE_CREDS_PATH, JSON.stringify(next, null, 2));
  return next;
}

export function readAppwriteCredsFile() {
  try { return JSON.parse(fs.readFileSync(APPWRITE_CREDS_PATH, 'utf8')); }
  catch { return {}; }
}

// ---------------------------------------------------------------- mirror files
/**
 * After FFmpeg produces a file, mirror it to Appwrite so cloud records have a
 * public URL. Only called when cloud mode is on. Returns { fileId, viewUrl }.
 */
export async function mirrorToCloud({ videoId, filePath, name }) {
  if (!usingCloud()) return null;
  const { fileId } = await aw.appFiles.upload(filePath, { name });
  const viewUrl = aw.appFiles.viewUrl(fileId);
  await videos.set(videoId, { appwriteFileId: fileId, viewUrl, cloud: true });
  return { fileId, viewUrl };
}
