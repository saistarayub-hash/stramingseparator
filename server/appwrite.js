// Appwrite integration — plug-and-play.
//
// Live demo endpoint: https://nyc.cloud.appwrite.io/v1
// You must supply a Project ID + API key (server key with databases.write,
// storage.write, files.read). Easiest: console.appwrite.io → your project →
// Overview → API Keys → "Create API key" with all scopes.
//
// The app auto-uses Appwrite when configured; otherwise it falls back to the
// local JSON store so you can still try everything with zero setup.
//
// Auto-bootstrap creates (idempotently):
//   Database  streampilot          (created from console or via create-db)
//   Collection videos / publishes
//   Bucket    videos               (gameplay + clips)
// and holds settings in collection 'settings'.

import { Client, Storage, Databases, ID, Permission, Role, Query } from 'node-appwrite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ENDPOINT = 'https://nyc.cloud.appwrite.io/v1';

const DB_ID = process.env.APPWRITE_DB_ID || 'streampilot';
const VIDEOS_COLLECTION = 'videos';
const PUBLISHES_COLLECTION = 'publishes';
const SETTINGS_COLLECTION = 'settings';
export const VIDEOS_BUCKET = 'videos';

let client = null;
let sdk = null;

// Creds file lives next to the local store (data/appwrite.json).
const CREDS_PATH = process.env.DATA_DIR
  ? path.join(path.resolve(process.env.DATA_DIR), 'appwrite.json')
  : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'appwrite.json');

function readCredsFile() {
  try { return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8')); }
  catch { return {}; }
}

export function appwriteConfig() {
  const file = readCredsFile();
  return {
    endpoint: process.env.APPWRITE_ENDPOINT || file.endpoint || DEFAULT_ENDPOINT,
    projectId: process.env.APPWRITE_PROJECT_ID || file.projectId || '',
    apiKey: process.env.APPWRITE_API_KEY || file.apiKey || '',
    databaseId: DB_ID,
  };
}

export function isConfigured() {
  const c = appwriteConfig();
  return !!(c.projectId && c.apiKey);
}

/** Drop cached SDK so the next appwrite() re-reads freshly saved creds. */
export function reloadCreds() {
  sdk = null;
  client = null;
}

/** Instantiate (lazily) or throw a friendly error. */
export function appwrite() {
  if (sdk) return sdk;
  const c = appwriteConfig();
  if (!c.projectId || !c.apiKey) {
    throw new Error('Appwrite is not configured yet. Add your Project ID + API key in Settings → Cloud, or via APPWRITE_PROJECT_ID / APPWRITE_API_KEY in .env.');
  }
  client = new Client().setEndpoint(c.endpoint).setProject(c.projectId).setKey(c.apiKey);
  sdk = {
    client,
    storage: new Storage(client),
    databases: new Databases(client),
    dbId: c.databaseId,
    endpoint: c.endpoint,
  };
  return sdk;
}

/** Public-any read permissions so fetched clips/VODs are shareable. */
export const publicRead = (...extra) => [Permission.read(Role.any()), ...extra];

/* ------------------------------------------------------------------ helpers */
async function ensureCollection(name, createDocument) {
  const d = appwrite().databases;
  const dbId = appwrite().dbId;
  try {
    await d.getCollection(dbId, name);
    return false;
  } catch {
    await d.createCollection(dbId, ID.custom(name), name, publicRead());
    await createDocument(d, dbId, name);
    return true;
  }
}

async function ensureBucket() {
  const st = appwrite().storage;
  try {
    await st.getBucket(VIDEOS_BUCKET);
    return false;
  } catch {
    await st.createBucket(
      VIDEOS_BUCKET,
      VIDEOS_BUCKET,
      publicRead(),
      false,                // fileSecurity
      true,                 // enabled
      20 * 1024 * 1024 * 1024, // 20GB max file
      [],                   // allowed extensions (all)
      'none',               // compression
      'none',               // encryption
      false,                // antivirus
      '{}',                 // transformations
    );
    return true;
  }
}

async function attrStrings(db, dbId, coll, defs) {
  for (const [key, size] of defs) {
    try { await db.createStringAttribute(dbId, coll, key, size, false); } catch { /* exists */ }
  }
}
async function attrInts(db, dbId, coll, keys) {
  for (const key of keys) {
    try { await db.createIntegerAttribute(dbId, coll, key, false); } catch { /* exists */ }
  }
}

/**
 * Create the schema if missing (idempotent). Safe to call on every boot.
 * @returns {{created:string[]}} names of things created
 */
export async function bootstrap() {
  const created = [];
  const db = appwrite().databases;
  const dbId = appwrite().dbId;

  if (await ensureCollection(VIDEOS_COLLECTION, async (d, id, c) => {
    await attrStrings(d, id, c, [
      ['name', 512], ['stage', 64], ['source', 32], ['appwriteFileId', 128],
      ['fixedAppwriteFileId', 128], ['issues', 8192], ['info', 4096],
      ['highlights', 4096], ['clips', 4096], ['error', 1024],
    ]);
    await attrInts(d, id, c, ['originalSize', 'liveOffset']);
  })) created.push(VIDEOS_COLLECTION);

  if (await ensureCollection(PUBLISHES_COLLECTION, async (d, id, c) => {
    await attrStrings(d, id, c, [['status', 32], ['results', 8192], ['videoId', 128]]);
  })) created.push(PUBLISHES_COLLECTION);

  if (await ensureCollection(SETTINGS_COLLECTION, async (d, id, c) => {
    await attrStrings(d, id, c, [['value', 65536]]);
  })) created.push(SETTINGS_COLLECTION);

  if (await ensureBucket()) created.push('bucket:' + VIDEOS_BUCKET);

  return { created, databaseId: dbId, endpoint: appwrite().endpoint };
}

/* ------------------------------------------------------------------ video records (Appwrite) */
export const appVideos = {
  async list() {
    const d = appwrite().databases;
    const res = await d.listDocuments(appwrite().dbId, VIDEOS_COLLECTION, [Query.orderDesc('createdAt')]);
    return res.documents;
  },
  async get(id) {
    try {
      return await appwrite().databases.getDocument(appwrite().dbId, VIDEOS_COLLECTION, id);
    } catch { return null; }
  },
  async set(id, data) {
    const d = appwrite().databases;
    const existing = await this.get(id).catch(() => null);
    const merged = existing ? { ...existing, ...data } : data;
    if (existing) return await d.updateDocument(appwrite().dbId, VIDEOS_COLLECTION, id, sanitize(merged));
    return await d.createDocument(appwrite().dbId, VIDEOS_COLLECTION, id, sanitize(merged), publicRead());
  },
  async remove(id) {
    try { await appwrite().databases.deleteDocument(appwrite().dbId, VIDEOS_COLLECTION, id); } catch {}
  },
};

export const appPublishes = {
  async list() {
    const res = await appwrite().databases.listDocuments(appwrite().dbId, PUBLISHES_COLLECTION, [Query.orderDesc('at')]);
    return res.documents;
  },
  async set(id, data) {
    const d = appwrite().databases;
    const existing = await d.getDocument(appwrite().dbId, PUBLISHES_COLLECTION, id).catch(() => null);
    const clean = sanitize(data);
    if (existing) return await d.updateDocument(appwrite().dbId, PUBLISHES_COLLECTION, id, clean);
    return await d.createDocument(appwrite().dbId, PUBLISHES_COLLECTION, id, clean, publicRead());
  },
};

/* ------------------------------------------------------------------ settings */
export const appSettings = {
  async get() {
    try {
      const res = await appwrite().databases.listDocuments(appwrite().dbId, SETTINGS_COLLECTION, [Query.limit(1)]);
      const doc = res.documents[0];
      if (!doc) return {};
      try { return typeof doc.value === 'string' ? JSON.parse(doc.value) : (doc.value || {}); } catch { return {}; }
    } catch { return {}; }
  },
  async set(patch) {
    const d = appwrite().databases;
    const dbId = appwrite().dbId;
    const merged = { ...(await this.get()), ...patch };
    const res = await d.listDocuments(dbId, SETTINGS_COLLECTION, [Query.limit(1)]);
    const doc = res.documents[0];
    if (doc) return await d.updateDocument(dbId, SETTINGS_COLLECTION, doc.$id, { value: JSON.stringify(merged) });
    return await d.createDocument(dbId, SETTINGS_COLLECTION, ID.unique(), { value: JSON.stringify(merged) }, publicRead([Permission.write(Role.any())]));
  },
};

/* ------------------------------------------------------------------ files */
export const appFiles = {
  async upload(localPath, { bucket = VIDEOS_BUCKET, name, type = 'video/mp4', fileId } = {}) {
    const storage = appwrite().storage;
    const fs = await import('node:fs');
    const buf = fs.readFileSync(localPath);
    const blob = new File([buf], name || 'clip.mp4', { type });
    const fid = fileId || ID.unique();
    await storage.createFile(bucket, fid, blob, publicRead());
    return { fileId: fid, bucket };
  },
  /** Public download URL for a file id, valid for the bucket's public read. */
  viewUrl(fileId, bucket = VIDEOS_BUCKET) {
    return `${appwrite().endpoint}/storage/buckets/${bucket}/files/${fileId}/download?project=${process.env.APPWRITE_PROJECT_ID || appwriteConfig().projectId}`;
  },
};

/** Appwrite returns string/typed values — flatten nested objects we stored as JSON. */
function sanitize(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (v === undefined) continue;
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && k !== '$permissions' && k !== '$createdAt' && k !== '$updatedAt') {
      out[k] = JSON.stringify(v);
    } else if (Array.isArray(v)) {
      out[k] = JSON.stringify(v);
    } else if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') {
      out[k] = v;
    } else {
      out[k] = String(v);
    }
  }
  return out;
}
